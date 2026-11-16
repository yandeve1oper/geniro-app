import type { ChildProcess, execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import { simulateSleep } from '../../../../__tests__/simulate-sleep';
import { FakeChild, fakeSpawn } from '../../__tests__/fake-child';
import { AgentAdapterRegistry } from '../../services/agent-adapter.registry';
import { AgentVersionService } from '../../services/agent-version.service';
import { GENIRO_UI_PREAMBLE } from '../../utils/agent-instructions';
import { isHostToolCall } from '../../utils/host-tool';
import type { SpawnedProcess, SpawnFn } from '../../utils/spawn-cli';
import { fakeGroupChild } from '../__tests__/fake-group-child';
import { freshVocabularyStore } from '../__tests__/fresh-vocabulary-store';
import {
  DELEGATE_HOLD_IDLE_MS,
  HOST_CONTEXT_NOTE,
  HOST_CONTEXT_TAG,
  QUEUED_FOR_SUBAGENTS_NOTICE,
  REFUSED_TOOL_RESULT,
} from '../acp/acp-driver';
import {
  ACCOUNT_SIGNED_OUT,
  type AccountSpendQuery,
  type AdapterConfig,
  type AgentEvent,
  type AgentTurnHandle,
  type AgentTurnInput,
  NO_PLAN_LIMITS,
} from '../adapter.types';
import { ClaudeAdapter } from '../claude/claude.adapter';
import { CursorAcpAdapter, cursorAutoDecision } from './cursor-acp.adapter';
import {
  CURSOR_ACP_SESSIONS_DIR_NAME,
  CURSOR_API_HOST,
  CURSOR_HOME_DIR_NAME,
  CURSOR_MAX_MODE_OPTION,
  CURSOR_PERIOD_USAGE_METHOD,
  CURSOR_PLAN_INFO_METHOD,
  CURSOR_PLAN_LIMITS_MIN_INTERVAL_MS,
  CURSOR_PLUGIN_NOTE,
  CURSOR_PLUGIN_SCAN_TTL_MS,
  CURSOR_SESSION_MISSING_MESSAGE,
  CURSOR_SILENTLY_DECLINED_METHODS,
  CURSOR_TRANSIENT_RESUME_DELAYS_MS,
  CURSOR_TRANSIENT_RESUME_PROMPT,
  CURSOR_USAGE_MAX_PAGES,
} from './cursor-acp.const';

/** The frames the adapter wrote to the child's stdin, parsed. */
function framesOn(child: FakeChild): Record<string, unknown>[] {
  return child.stdin.written
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** One NDJSON line of the agent's stdout. */
function stdoutLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Accept every model and parameter frame as it goes out. The driver sends
 * them one at a time, each after the reply to the one before, so a spec that
 * wants the whole selection on the wire has to answer them in turn.
 */
function acceptConfigFrames(child: FakeChild): void {
  const answered = new Set<unknown>();
  for (;;) {
    const next = framesOn(child).find(
      (frame) =>
        (frame.method === 'session/set_config_option' ||
          frame.method === 'session/set_model') &&
        !answered.has(frame.id),
    );
    if (next === undefined) {
      return;
    }
    answered.add(next.id);
    child.stdout.emitData(stdoutLine({ id: next.id, result: {} }));
  }
}

/** A `session/update` notification wrapping one update payload. */
function sessionUpdate(payload: Record<string, unknown>): string {
  return stdoutLine({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 's', update: payload },
  });
}

/** What every user-facing cursor turn leads with: the preamble, then its note. */
const HOST_BLOCK = `${GENIRO_UI_PREAMBLE}\n\n${new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore() }).getConfig().backgroundWork.agentNote}`;

/** The two `*_once` options every ACP permission request must offer. */
const ONCE_OPTIONS = [
  { optionId: 'o-allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'o-reject', name: 'Reject', kind: 'reject_once' },
];

/** Drive the handshake so the child is inside a live prompt (request id 3). */
function handshake(child: FakeChild): void {
  child.stdout.emitData(
    stdoutLine({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }),
  );
  child.stdout.emitData(
    stdoutLine({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } }),
  );
}

const BASE: AgentTurnInput = { prompt: 'ship it', cwd: '/repo' };

/** Per-turn profile dirs this spec created, removed after each case. */
const dirs: string[] = [];

/** The turn's instructions as the prompt actually carries them. */
function hostBlock(instructions: string): string {
  return `<${HOST_CONTEXT_TAG}>\n\n${HOST_CONTEXT_NOTE}\n\n${instructions}\n\n</${HOST_CONTEXT_TAG}>`;
}

/**
 * What these cases assert about the child env. A cursor-agent session exports
 * `CURSOR_DATA_DIR` into the shell that then runs the suite, and the turn
 * inherits whatever this process already holds — so an assertion that the
 * child has none fails before the test has said anything. Cleared here, and
 * put back after, rather than deleted for the rest of the worker.
 */
const ISOLATED_ENV = [
  'CURSOR_DATA_DIR',
  'CURSOR_CONFIG_DIR',
  'CURSOR_API_KEY',
  'GENIRO_CURSOR_API_KEY',
  'GENIRO_CLI_PATHS',
  'CURSOR_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
] as const;

beforeEach(() => {
  for (const name of ISOLATED_ENV) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  // Restores what `beforeEach` stubbed, including a key a case set for itself
  // (`CURSOR_API_KEY` and the rest), so it cannot leak into the next one.
  vi.unstubAllEnvs();
});

/**
 * Answers a utility command (`runCommand`, not `start`) with canned stdout,
 * capturing its argv and options. A turn is spawned through `spawn`;
 * everything else runs through `execFileFn`. A null stdout is the
 * command-failed signal — `runCommand` swallows the error and returns null.
 */
function fakeListing(stdout: string | null): {
  groupSpawnFn: typeof spawn;
  captured: {
    args?: readonly string[];
    opts?: { cwd?: string; detached?: boolean; env?: NodeJS.ProcessEnv };
  };
} {
  const captured: {
    args?: readonly string[];
    opts?: { cwd?: string; detached?: boolean; env?: NodeJS.ProcessEnv };
  } = {};
  const groupSpawnFn = ((
    _command: string,
    args: readonly string[],
    opts: { cwd?: string; detached?: boolean; env?: NodeJS.ProcessEnv },
  ) => {
    captured.args = args;
    captured.opts = opts;
    const fake = fakeGroupChild(4242);
    queueMicrotask(() => {
      // A null stdout is the could-not-be-run signal: the CLI is missing, or
      // it exited non-zero. `spawn` reports that as the exit status rather
      // than as an error argument, so the double has to as well.
      if (stdout === null) {
        fake.close(1);
        return;
      }
      fake.writeStdout(stdout);
      fake.close(0);
    });
    return fake.child;
  }) as unknown as typeof spawn;
  return { groupSpawnFn, captured };
}

describe('CursorAcpAdapter spawn', () => {
  it('runs the ACP server and keeps every turn parameter out of argv', () => {
    const { spawn, captured } = fakeSpawn();
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start(
      {
        ...BASE,
        model: 'sonnet',
        resumeSessionId: 'prior',
        approvalMode: 'plan',
        mcpEndpoint: {
          url: 'http://127.0.0.1:9/mcp',
          token: 'secret-token',
          serverName: 'geniro-run-1',
        },
      },
      () => {},
    );
    expect(captured.command).toBe('cursor-agent');
    expect(captured.args).toEqual(['acp']);
    // The whole point of keeping the call token in-protocol: argv is readable
    // by every local account through `ps`.
    expect(JSON.stringify(captured.args)).not.toContain('secret-token');
    expect(JSON.stringify(captured.args)).not.toContain('ship it');
  });

  it('honours the Settings cliPaths override per turn', () => {
    const { spawn, captured } = fakeSpawn();
    process.env.GENIRO_CLI_PATHS = JSON.stringify({
      'cursor-agent': '/opt/cursor-agent',
    });
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start(BASE, () => {});
    expect(captured.command).toBe('/opt/cursor-agent');
  });

  it('does not re-introduce the Keychain hop it replaced', () => {
    const { spawn, captured } = fakeSpawn();
    // The variable geniro used to mint from the Keychain. Nothing sources it
    // now, so setting it must have no effect on the child.
    process.env.GENIRO_CURSOR_API_KEY = 'ck-from-geniro';
    delete process.env.CURSOR_API_KEY;
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start(BASE, () => {});
    expect(captured.env?.CURSOR_API_KEY).toBeUndefined();
    expect(captured.env?.GENIRO_CURSOR_API_KEY).toBeUndefined();
  });

  it("re-injects the USER's own inherited key for its own child", () => {
    // `buildChildEnv` strips CURSOR_API_KEY from every child so it can never
    // reach the claude agent; this override is what keeps env-var auth working
    // for the one child entitled to it. Delete the override and this fails.
    const { spawn, captured } = fakeSpawn();
    process.env.CURSOR_API_KEY = 'ck-user-own';
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start(BASE, () => {});
    expect(captured.env?.CURSOR_API_KEY).toBe('ck-user-own');
  });

  it('re-injects an inherited CURSOR_AUTH_TOKEN for its own child — and no claude credential', () => {
    // cursor-agent authenticates from CURSOR_AUTH_TOKEN as readily as from its
    // key (2026.09.10, `1422.index.js`). Now that `buildChildEnv` strips it
    // from every child, this entitlement is what keeps that route working; and
    // the claude Foundry key set beside it proves the entitlement is cursor's
    // own list rather than "everything the daemon inherited".
    // Registered as the daemon's registry registers every adapter before
    // anything spawns: that is what puts claude's names on the strip, so this
    // spec must not lean on a sibling test having done it first.
    new AgentAdapterRegistry([new ClaudeAdapter()]);
    const { spawn, captured } = fakeSpawn();
    process.env.CURSOR_AUTH_TOKEN = 'cursor-auth-token';
    process.env.ANTHROPIC_FOUNDRY_API_KEY = 'foundry-key';
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start(BASE, () => {});
    expect(captured.env?.CURSOR_AUTH_TOKEN).toBe('cursor-auth-token');
    expect(captured.env?.ANTHROPIC_FOUNDRY_API_KEY).toBeUndefined();
  });

  it('lets a per-call env override win over the inherited key', () => {
    const { spawn, captured } = fakeSpawn();
    process.env.CURSOR_API_KEY = 'ck-user-own';
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start({ ...BASE, env: { CURSOR_API_KEY: 'ck-explicit' } }, () => {});
    expect(captured.env?.CURSOR_API_KEY).toBe('ck-explicit');
  });

  it('offers sign-in on the failure a signed-out turn actually produces', () => {
    // OBSERVED 2026-08-12 on 2026.08.04-aaa8809 with the account logged out:
    // session/new answers -32000 'Authentication required', which the ACP
    // driver renders as `acp session failed: <message>`. Empty the adapter's
    // expiredMarkers and this returns null — no Sign-in control on the row.
    const adapter = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn: fakeSpawn().spawn,
    });
    expect(
      adapter.errorRecovery('acp session failed: Authentication required'),
    ).toBe('cli-login');
    expect(adapter.errorRecovery('acp prompt failed: rate limited')).toBeNull();
  });

  it('does not offer sign-in for someone else’s "Authentication required"', () => {
    // The marker is matched against the WHOLE failure message, and a non-zero
    // exit carries the child's stderr tail — where `cursor-agent acp`'s own MCP
    // health-checks log. An HTTP server answering 401 must not send the user to
    // re-authenticate an account that was never the problem, which is why the
    // marker is anchored to the driver's own rendering. Widen it back to the
    // bare phrase and this fails.
    const adapter = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn: fakeSpawn().spawn,
    });
    expect(
      adapter.errorRecovery(
        'cursor-agent exited with code 1: mcp server foo: Authentication required',
      ),
    ).toBeNull();
  });

  it('opens the handshake on stdin and holds stdin open for the dialogue', () => {
    const { spawn, child } = fakeSpawn();
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
      clientVersion: '9.9.9',
    }).start(BASE, () => {});
    const [first] = framesOn(child);
    expect(first).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientInfo: { name: 'geniro', version: '9.9.9' },
      },
    });
    // ACP is full-duplex: closing stdin after the opening frame would strand
    // every reply the agent is waiting on.
    expect(child.stdin.ended).toBe(false);
  });

  it('drives a turn end to end through the ACP handshake', async () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start(BASE, (event) => events.push(event));

    child.stdout.emitData(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'sess-9' } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-9',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'done' },
          },
        },
      })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })}\n`,
    );
    child.emit('close', 0, null);
    await handle.done;

    expect(events).toEqual([
      { type: 'session', sessionId: 'sess-9' },
      // The chunk streams as an ephemeral delta; the durable row arrives once,
      // when the block closes at the end of the turn.
      { type: 'text_delta', text: 'done' },
      { type: 'text', text: 'done' },
      {
        type: 'turn_complete',
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          thinkingTokens: null,
          contextTokens: null,
          contextWindowTokens: null,
          contextModel: null,
          costUsd: null,
          durationMs: null,
          apiMs: null,
          ttftMs: null,
          timeToRequestMs: null,
          numTurns: null,
        },
        stopReason: 'end_turn',
        finalText: 'done',
      },
    ]);
    // The prompt reached the agent in-protocol.
    expect(
      framesOn(child).find((frame) => frame.method === 'session/prompt')
        ?.params,
    ).toEqual({
      sessionId: 'sess-9',
      // ACP carries no system-prompt field, so the host preamble rides the
      // prompt text itself — ahead of the user's message, on every turn.
      prompt: [{ type: 'text', text: `ship it\n\n${hostBlock(HOST_BLOCK)}` }],
    });
  });
});

/**
 * A child whose `kill` actually ends it. The reported-commands probe cancels
 * its own turn the moment the report lands, so without this the turn never
 * settles and the probe waits out its deadline.
 */
class KillableAcpChild extends FakeChild {
  override kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    super.kill(signal);
    // A real child's `close` lands after the signal, never within it.
    setTimeout(() => this.emit('close', null, signal), 0);
    return true;
  }
}

describe('CursorAcpAdapter self-reported commands', () => {
  /**
   * The probe settings the adapter ACTUALLY SHIPS, read off its config rather
   * than off a literal next door: config is what `listReportedCommands` reads,
   * so a value that stopped being wired into it fails here instead of passing
   * against a name nothing uses.
   */
  function shippedProbe(): NonNullable<AdapterConfig['reportedCommands']> {
    const probe = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    }).getConfig().reportedCommands;
    if (!probe) {
      throw new Error(
        'cursor-agent must ship a reportedCommands probe — without it a folder ' +
          'no turn has run in lists nothing the CLI reports about itself',
      );
    }
    return probe;
  }

  it('asks the CLI what it offers, off the handshake and before any prompt', async () => {
    // The defect this closes, measured 2026-08-19 on 2026.08.11-e8db854: the
    // adapter declared `reportedCommands: null` and deferred to the mid-turn
    // harvest, which only exists once a turn has run in that folder — so a
    // fresh chat listed the disk scan alone. The CLI offered 27 commands and
    // the composer showed 21.
    shippedProbe();
    const child = new KillableAcpChild(4242);
    const { spawn } = fakeSpawn(child);
    const reported = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
      probeRootDir: mkdtempSync(join(tmpdir(), 'cursor-probe-root-')),
    }).listReportedCommands();

    handshake(child);
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'review-agent', description: 'Read-only defect review' },
          { name: 'worktree', description: null },
        ],
      }),
    );

    await expect(reported).resolves.toEqual([
      { name: 'review-agent', description: 'Read-only defect review' },
      { name: 'worktree', description: null },
    ]);
    // Resolved without the turn ever ending: no `stopReason` reply was emitted,
    // so this cannot have waited the turn out. The report rides the handshake
    // rather than the answer, and the turn is cancelled the moment it lands.
    expect(
      framesOn(child).some((frame) => frame.method === 'session/prompt'),
    ).toBe(true);
    expect(child.kills).toBeGreaterThan(0);
  });

  it('keeps every name the CLI reports — this one has no internals to strip', async () => {
    // claude reports `__remote-workflow`-style internals and declares a prefix
    // for them. Across both readings of cursor-agent (27 entries in a git repo,
    // 22 in an empty directory) every entry was user-invokable, so the null is
    // a measurement and this is what fails if a filter is added on a hunch.
    expect(shippedProbe().internalPrefix).toBeNull();

    const child = new KillableAcpChild(4243);
    const { spawn } = fakeSpawn(child);
    const reported = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
      probeRootDir: mkdtempSync(join(tmpdir(), 'cursor-probe-root-')),
    }).listReportedCommands();

    handshake(child);
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: '_internal-looking', description: null },
          { name: 'share', description: null },
        ],
      }),
    );

    await expect(reported).resolves.toEqual([
      { name: '_internal-looking', description: null },
      { name: 'share', description: null },
    ]);
  });
});

describe('CursorAcpAdapter keeps ONE process for the whole conversation', () => {
  it('serves a second turn on the same process once the first has settled', () => {
    // The flip this adapter's `canHostSession` note asked for, and what it
    // actually buys: with one process per turn, `TURN_END_EXIT_GRACE_MS`
    // terminated the group ~2s after the turn's terminal event, taking every
    // sub-agent the turn had backgrounded with it.
    //
    // A real pin, not a readability one — deleting the override sends
    // `startSession` down the `turn` lifetime, where the second `startTurn`
    // answers null. And it is asserted after the first turn SETTLES, which is
    // the only state where "can this process serve another turn" has an
    // answer: a turn still in flight is refused by either arm.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const session = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).startSession(BASE, { runScoped: true });

    expect(
      session.startTurn(BASE, (event) => events.push(event)),
    ).not.toBeNull();
    child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 2, result: { sessionId: 'sess-1' } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 3, result: { stopReason: 'end_turn' } })}\n`,
    );
    expect(events.some((event) => event.type === 'turn_complete')).toBe(true);
    expect(session.idle).toBe(true);

    expect(
      session.startTurn({ ...BASE, prompt: 'and the next thing' }, () => {}),
    ).not.toBeNull();
    // The SECOND prompt went into the conversation the first opened — one
    // handshake, one session, two prompts.
    const frames = framesOn(child);
    expect(
      frames.filter((frame) => frame.method === 'session/new'),
    ).toHaveLength(1);
    const prompts = frames.filter((frame) => frame.method === 'session/prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.params).toMatchObject({ sessionId: 'sess-1' });
  });

  it('refuses an ask turn on a process spawned for auto, which may not ask', () => {
    // The profile — and the approval mode the CLI reads from it — is fixed when
    // the process spawns, and an auto turn's profile keeps the user's own mode.
    // Served by that process, an ask turn under a user's "run everything"
    // would run tools with no card, so it is refused and its owner respawns.
    const { spawn, child } = fakeSpawn();
    const session = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).startSession({ ...BASE, approvalMode: 'auto' }, { runScoped: true });

    session.startTurn({ ...BASE, approvalMode: 'auto' }, () => {});
    child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 2, result: { sessionId: 'sess-1' } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 3, result: { stopReason: 'end_turn' } })}\n`,
    );

    expect(
      session.startTurn({ ...BASE, approvalMode: 'ask' }, () => {}),
    ).toBeNull();
    expect(
      session.startTurn({ ...BASE, approvalMode: 'plan' }, () => {}),
    ).toBeNull();
    expect(
      session.startTurn({ ...BASE, approvalMode: 'auto' }, () => {}),
    ).not.toBeNull();
  });

  it('keeps an asking process for a plan turn, and respawns it for auto', () => {
    // Only whether a turn asks is spawn-time; the mode itself is re-applied per
    // turn, so ask and plan share a process. Crossing into auto respawns: it
    // is keyed, and a key can only say "equal".
    for (const [next, kept] of [
      ['plan', true],
      ['auto', false],
    ] as const) {
      const { spawn, child } = fakeSpawn();
      const session = new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
      }).startSession({ ...BASE, approvalMode: 'ask' }, { runScoped: true });

      session.startTurn({ ...BASE, approvalMode: 'ask' }, () => {});
      child.stdout.emitData(
        `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
      );
      child.stdout.emitData(
        `${JSON.stringify({ id: 2, result: { sessionId: 'sess-1' } })}\n`,
      );
      child.stdout.emitData(
        `${JSON.stringify({ id: 3, result: { stopReason: 'end_turn' } })}\n`,
      );

      expect(
        session.startTurn({ ...BASE, approvalMode: next }, () => {}) !== null,
        next,
      ).toBe(kept);
    }
  });

  it('refuses a second turn on a process whose handshake FAILED, so its owner spawns afresh', async () => {
    // The process lives on after a refused `initialize`, and the registry
    // reused it: the next turn's model frame and prompt both return early on a
    // null session id, so it wrote nothing and sat silent for 30 minutes.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const session = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).startSession(BASE, { runScoped: true });

    const first = session.startTurn(BASE, (event) => events.push(event));
    child.stdout.emitData(
      stdoutLine({ id: 1, error: { code: -32603, message: 'boom' } }),
    );
    // The failed turn still reaches the user at once, on its own error.
    await first?.done;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: 'acp initialize failed: boom',
      }),
    );

    const written = child.stdin.written;
    expect(
      session.startTurn({ ...BASE, prompt: 'try again' }, () => {}),
    ).toBeNull();
    expect(child.stdin.written).toBe(written);
    // …and reads as unusable, so the registry's eviction drops it on sight
    // rather than keeping a slot for a process nothing can talk to.
    expect(session.retired).toBe(true);
  });

  it('ends a turn stopped while its prompt waits on a config reply — no cancel, no prompt', () => {
    // The prompt waits behind the model frame's reply. A `session/cancel` in
    // that window would cancel no prompt (so the agent says nothing), and the
    // model reply would then release the prompt into the stopped turn — which
    // the agent answers, or the fallback kills the group.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const session = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).startSession(
      { ...BASE, model: 'claude-opus-5', effort: 'xhigh' },
      { runScoped: true },
    );
    const handle = session.startTurn(
      { ...BASE, model: 'claude-opus-5', effort: 'xhigh' },
      (event) => events.push(event),
    );
    child.stdout.emitData(
      stdoutLine({ id: 1, result: { protocolVersion: 1 } }),
    );
    child.stdout.emitData(
      stdoutLine({
        id: 2,
        result: {
          sessionId: 's',
          configOptions: [
            {
              id: 'model',
              category: 'model',
              currentValue: 'auto-smart',
              options: [{ value: 'claude-opus-5' }, { value: 'auto-smart' }],
            },
          ],
        },
      }),
    );
    const modelFrame = framesOn(child).find(
      (frame) => frame.method === 'session/set_config_option',
    );
    expect(modelFrame).toBeDefined();
    expect(
      framesOn(child).some((frame) => frame.method === 'session/prompt'),
    ).toBe(false);

    handle?.cancel();

    expect(events.filter((event) => event.type === 'turn_cancelled')).toEqual([
      { type: 'turn_cancelled' },
    ]);
    child.stdout.emitData(stdoutLine({ id: modelFrame?.id, result: {} }));
    const methods = framesOn(child).map((frame) => frame.method);
    expect(methods).not.toContain('session/cancel');
    expect(methods).not.toContain('session/prompt');
    expect(child.kills).toBe(0);
  });

  it('reports a follow-up waiting behind an unanswered cancel dropped when Stop falls back to killing the process', () => {
    vi.useFakeTimers();
    try {
      const { spawn, child } = fakeSpawn();
      const events: AgentEvent[] = [];
      const session = new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
      }).startSession(BASE, { runScoped: true });
      const handle = session.startTurn(BASE, (event) => events.push(event));
      child.stdout.emitData(
        stdoutLine({ id: 1, result: { protocolVersion: 1 } }),
      );
      child.stdout.emitData(stdoutLine({ id: 2, result: { sessionId: 's' } }));
      expect(
        handle?.sendUserMessage({
          text: 'do X instead',
          deliveryId: 'delivery-1',
        }),
      ).toBe(true);

      handle?.cancel();
      vi.advanceTimersByTime(5_000);
      expect(child.kills).toBeGreaterThan(0);
      child.emit('close', null, 'SIGTERM');

      const types = events.map((event) => event.type);
      expect(events).toContainEqual({
        type: 'follow_up_dropped',
        deliveryIds: ['delivery-1'],
      });
      expect(types.indexOf('follow_up_dropped')).toBeLessThan(
        types.indexOf('turn_cancelled'),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CursorAcpAdapter turn shaping', () => {
  it('carries a team member’s instructions in the prompt, ACP having no system-prompt field', () => {
    const { spawn, child } = fakeSpawn();
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start({ ...BASE, systemPrompt: 'You are a reviewer.' }, () => {});
    child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 2, result: { sessionId: 's' } })}\n`,
    );

    const prompt = framesOn(child).find(
      (frame) => frame.method === 'session/prompt',
    )?.params as { prompt: { text: string }[] };
    // The member's instructions still lead the user's message; the host preamble sits
    // ahead of both, per turnInstructionParts' general → specific order.
    expect(prompt.prompt[0]?.text).toBe(
      `ship it\n\n${hostBlock(`${HOST_BLOCK}\n\nYou are a reviewer.`)}`,
    );
  });

  it('carries the user’s custom instructions into the prompt text', () => {
    // The sibling of the claude argv case. ACP has no system-prompt field at
    // all, so the SAME composed block reaches this CLI as leading prompt text
    // — one seam, both transports, which is what stops the two drifting into
    // separate delivery rules.
    const { spawn, child } = fakeSpawn();
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start(
      { ...BASE, customInstructions: 'Always answer in British English.' },
      () => {},
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 2, result: { sessionId: 's' } })}\n`,
    );

    const prompt = framesOn(child).find(
      (frame) => frame.method === 'session/prompt',
    )?.params as { prompt: { text: string }[] };
    expect(prompt.prompt[0]?.text).toBe(
      `ship it\n\n${hostBlock(`${HOST_BLOCK}\n\nAlways answer in British English.`)}`,
    );
  });

  it('carries a team member’s instruction blocks into the prompt text', () => {
    // The ACP half of the claude argv case: one seam composes the block, so a
    // field that reaches one transport and not the other is the drift both
    // these tests exist to catch.
    const { spawn, child } = fakeSpawn();
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start(
      {
        ...BASE,
        customInstructions: 'Always answer in British English.',
        instructionBlocks: 'Prefer short sentences.',
        systemPrompt: 'You are a reviewer.',
      },
      () => {},
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 2, result: { sessionId: 's' } })}\n`,
    );

    const prompt = framesOn(child).find(
      (frame) => frame.method === 'session/prompt',
    )?.params as { prompt: { text: string }[] };
    expect(prompt.prompt[0]?.text).toBe(
      `ship it\n\n${hostBlock(`${HOST_BLOCK}\n\nAlways answer in British English.\n\nPrefer short sentences.\n\nYou are a reviewer.`)}`,
    );
  });

  it('applies a requested model the agent offers, before prompting', () => {
    // The turn used to announce up front that the model had been dropped —
    // ACP does carry one (`session/set_model`, probe-verified on
    // 2026.08.04-aaa8809), so the frame is sent and no such notice fires.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start({ ...BASE, model: 'claude-opus-5' }, (event) =>
      events.push(event),
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({
        id: 2,
        result: {
          sessionId: 's',
          models: {
            currentModelId: 'composer-2.5',
            availableModels: [{ modelId: 'claude-opus-5', name: 'Opus 5' }],
          },
        },
      })}\n`,
    );
    acceptConfigFrames(child);

    const methods = framesOn(child).map((frame) => frame.method);
    expect(
      framesOn(child).find((frame) => frame.method === 'session/set_model')
        ?.params,
    ).toEqual({ sessionId: 's', modelId: 'claude-opus-5' });
    // Order is the whole mechanism: the frames share one ordered stream, so a
    // set_model AFTER the prompt would apply to the next turn, not this one.
    expect(methods.indexOf('session/set_model')).toBeLessThan(
      methods.indexOf('session/prompt'),
    );
    expect(events.filter((event) => event.type === 'notice')).toEqual([]);
  });

  it('applies the model before its parameters', () => {
    // ORDER is load-bearing and not cosmetic: a parameter's existence depends
    // on the current model, so `effort` before `model` is "Unknown model
    // config option".
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start(
      {
        ...BASE,
        model: 'claude-opus-5',
        effort: 'xhigh',
      },
      (event) => events.push(event),
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({
        id: 2,
        result: {
          sessionId: 's',
          // The parameterized shape: a model config option carrying BARE names.
          configOptions: [
            {
              id: 'model',
              category: 'model',
              currentValue: 'auto-smart',
              options: [{ value: 'claude-opus-5' }, { value: 'auto-smart' }],
            },
          ],
        },
      })}\n`,
    );
    acceptConfigFrames(child);

    const settings = framesOn(child)
      .filter((frame) => frame.method === 'session/set_config_option')
      .map((frame) => frame.params as { configId: string; value: string })
      .map((params) => [params.configId, params.value]);
    expect(settings).toEqual([
      ['model', 'claude-opus-5'],
      ['effort', 'xhigh'],
    ]);
    const methods = framesOn(child).map((frame) => frame.method);
    expect(methods.lastIndexOf('session/set_config_option')).toBeLessThan(
      methods.indexOf('session/prompt'),
    );
    expect(events.filter((event) => event.type === 'notice')).toEqual([]);
  });

  it('sets the effort even when the run keeps the agent’s own model', () => {
    // The ordinary case for a chat left on "default model": there is no model to
    // apply, and the effort must still go out. An early return on "no model"
    // makes the picker inert for exactly those runs.
    const { spawn, child } = fakeSpawn();
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start({ ...BASE, effort: 'max' }, () => {});
    child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 2, result: { sessionId: 's' } })}\n`,
    );

    expect(
      framesOn(child)
        .filter((frame) => frame.method === 'session/set_config_option')
        .map((frame) => (frame.params as { configId: string }).configId),
    ).toEqual(['effort']);
  });

  describe('the prompt waits for the LAST setting to be answered', () => {
    // REPORTED from billing: a card run on `gpt-5.6-sol` with effort `high` was
    // billed as `gpt-5.6-sol-medium` — that model's own default (probed on
    // 2026.10.01-e373342: `thought_level/reasoning current=medium`, and a
    // `reasoning=high` frame on its own is answered `current=high`). A card
    // names no context window, so its effort was the LAST frame, and the
    // prompt followed it down the pipe before cursor had applied it — the
    // timing `context` was already measured to need. A chat that also sends a
    // context window never showed it, because that frame held the prompt.
    //
    // Measured since by billing on the same build: a pipelined `reasoning=high`,
    // `fast=false` AND a model switch were each lost on that turn, every reply
    // confirming the new value. So the wait belongs to the CLI, not to a
    // parameter, and it covers the model frame too.
    const SESSION_ON_DEFAULT_MODEL = {
      sessionId: 's',
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'auto-smart',
          options: [
            { value: 'gpt-5.6-sol' },
            { value: 'grok-4.7' },
            { value: 'auto-smart' },
          ],
        },
      ],
    };

    /** A `session/set_config_option` reply listing a model's own options. */
    function modelOptions(
      options: {
        id: string;
        category: string;
        current: string;
        values: string[];
      }[],
    ): Record<string, unknown> {
      return {
        configOptions: options.map(({ id, category, current, values }) => ({
          id,
          category,
          currentValue: current,
          options: values.map((value) => ({ value, name: value })),
        })),
      };
    }

    const methodsOn = (child: FakeChild): unknown[] =>
      framesOn(child).map((frame) => frame.method);

    const settingsOn = (child: FakeChild): [string, string][] =>
      framesOn(child)
        .filter((frame) => frame.method === 'session/set_config_option')
        .map((frame) => frame.params as { configId: string; value: string })
        .map(({ configId, value }) => [configId, value]);

    /** The id of the newest `set_config_option` frame on the wire. */
    const lastSettingId = (child: FakeChild): unknown =>
      framesOn(child)
        .filter((frame) => frame.method === 'session/set_config_option')
        .at(-1)?.id;

    it('sends a resumed prompt at once when the load reply already reports the requested effort', () => {
      const { spawn, child } = fakeSpawn();
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
      }).start(
        { ...BASE, resumeSessionId: 's', model: 'gpt-5.6-sol', effort: 'high' },
        () => {},
      );
      child.stdout.emitData(
        stdoutLine({
          id: 1,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
          },
        }),
      );
      expect(methodsOn(child)).toContain('session/load');
      child.stdout.emitData(
        stdoutLine({
          id: 2,
          result: modelOptions([
            {
              id: 'model',
              category: 'model',
              current: 'gpt-5.6-sol',
              values: ['gpt-5.6-sol'],
            },
            {
              id: 'reasoning',
              category: 'thought_level',
              current: 'high',
              values: ['medium', 'high'],
            },
          ]),
        }),
      );

      expect(settingsOn(child)).toEqual([]);
      expect(methodsOn(child)).toContain('session/prompt');
    });

    it('holds a card’s prompt until its effort frame is answered', () => {
      const { spawn, child } = fakeSpawn();
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
      }).start({ ...BASE, model: 'gpt-5.6-sol', effort: 'high' }, () => {});
      child.stdout.emitData(
        stdoutLine({ id: 1, result: { protocolVersion: 1 } }),
      );
      child.stdout.emitData(
        stdoutLine({ id: 2, result: SESSION_ON_DEFAULT_MODEL }),
      );

      // The model frame's reply is the Sol option list as cursor sends it.
      child.stdout.emitData(
        stdoutLine({
          id: lastSettingId(child),
          result: modelOptions([
            {
              id: 'context',
              category: 'model_config',
              current: '272k',
              values: ['272k', '1m'],
            },
            {
              id: 'reasoning',
              category: 'thought_level',
              current: 'medium',
              values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
            },
            {
              id: 'fast',
              category: 'model_config',
              current: 'false',
              values: ['false', 'true'],
            },
          ]),
        }),
      );

      expect(settingsOn(child)).toEqual([
        ['model', 'gpt-5.6-sol'],
        ['reasoning', 'high'],
      ]);
      // The effort is on the wire and unanswered: the prompt must not be.
      expect(methodsOn(child)).not.toContain('session/prompt');

      child.stdout.emitData(
        stdoutLine({ id: lastSettingId(child), result: {} }),
      );
      expect(methodsOn(child)).toContain('session/prompt');
    });

    it('holds the prompt behind a model setting too, when that is the last frame', () => {
      // Grok runs as Fast unless told otherwise (`fast current=true`, probed),
      // and a card asking `fast=false` is that setting's whole point — so it
      // must land before the turn starts, for the same reason the effort must.
      const { spawn, child } = fakeSpawn();
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
      }).start(
        { ...BASE, model: 'grok-4.7', modelParameters: { fast: 'false' } },
        () => {},
      );
      child.stdout.emitData(
        stdoutLine({ id: 1, result: { protocolVersion: 1 } }),
      );
      child.stdout.emitData(
        stdoutLine({ id: 2, result: SESSION_ON_DEFAULT_MODEL }),
      );
      child.stdout.emitData(
        stdoutLine({
          id: lastSettingId(child),
          result: modelOptions([
            {
              id: 'reasoning_effort',
              category: 'thought_level',
              current: 'high',
              values: ['low', 'medium', 'high', 'xhigh'],
            },
            {
              id: 'fast',
              category: 'model_config',
              current: 'true',
              values: ['false', 'true'],
            },
          ]),
        }),
      );

      expect(settingsOn(child)).toEqual([
        ['model', 'grok-4.7'],
        ['fast', 'false'],
      ]);
      expect(methodsOn(child)).not.toContain('session/prompt');

      child.stdout.emitData(
        stdoutLine({ id: lastSettingId(child), result: {} }),
      );
      expect(methodsOn(child)).toContain('session/prompt');
    });

    it('holds the prompt behind a model switch that sets nothing else', () => {
      // Measured by billing: a pipelined switch to `gpt-5.5` with no parameter
      // ran on the session's old `gpt-5.6-sol`, though the reply confirmed the
      // switch. The model frame is the LAST frame here, so it is the one the
      // prompt waits on — the case a per-parameter flag could never reach.
      const { spawn, child } = fakeSpawn();
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
      }).start({ ...BASE, model: 'gpt-5.5' }, () => {});
      child.stdout.emitData(
        stdoutLine({ id: 1, result: { protocolVersion: 1 } }),
      );
      child.stdout.emitData(
        stdoutLine({
          id: 2,
          result: {
            sessionId: 's',
            configOptions: [
              {
                id: 'model',
                category: 'model',
                currentValue: 'gpt-5.6-sol',
                options: [{ value: 'gpt-5.6-sol' }, { value: 'gpt-5.5' }],
              },
            ],
          },
        }),
      );

      expect(settingsOn(child)).toEqual([['model', 'gpt-5.5']]);
      expect(methodsOn(child)).not.toContain('session/prompt');

      child.stdout.emitData(
        stdoutLine({ id: lastSettingId(child), result: {} }),
      );
      expect(methodsOn(child)).toContain('session/prompt');
    });
  });

  it('points the child at its OWN config dir, never the user’s ~/.cursor', () => {
    // THE leak fix. Applying a model or an effort over ACP persists into the
    // config directory — measured: one `set_config_option` changed `model`,
    // `selectedModel` and `modelSelectionHistory` in the real
    // `~/.cursor/cli-config.json`. So a chat's model choice used to change what
    // the user's own `cursor-agent` opens with. Drop this and it does again.
    const { spawn, captured } = fakeSpawn();
    const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
    dirs.push(profileDir);

    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
      profileDir,
    }).start(BASE, () => {});

    const dir = captured.env?.CURSOR_CONFIG_DIR;
    expect(dir).toBeDefined();
    expect(dir!.startsWith(profileDir)).toBe(true);
    // And it is NOT the user's own, which is the whole point.
    expect(dir).not.toContain('/.cursor');
  });

  it('opens the turn’s profile ON the run’s own model', () => {
    // What makes every later check possible: a `session/new` reply describes
    // the CURRENT model, so a session opened on the user's default says nothing
    // about the model this turn will run on — its effort vocabulary included.
    // Seeded, the first reply describes the right model, and the model frame is
    // not needed at all.
    const { spawn, captured } = fakeSpawn();
    const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
    dirs.push(profileDir);

    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
      profileDir,
    }).start({ ...BASE, model: 'grok-4.6' }, () => {});

    const config = JSON.parse(
      readFileSync(
        join(captured.env!.CURSOR_CONFIG_DIR!, 'cli-config.json'),
        'utf8',
      ),
    ) as { model?: { modelId?: string } };
    expect(config.model?.modelId).toBe('grok-4.6');
  });

  it('writes the turn’s OWN Max Mode choice, ON or OFF', () => {
    // The option reaches the turn in `agentOptions`, and OFF has to be
    // written as explicitly as ON: the profile is a copy of the user's own
    // config, so leaving the key alone does not mean off — it means however
    // their terminal was last left. Cursor bills Max Mode at the API rate plus
    // 20% on legacy plans, which is the whole reason a user can decline it.
    for (const choice of [true, false]) {
      const { spawn, captured } = fakeSpawn();
      const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
      dirs.push(profileDir);

      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
        profileDir,
      }).start(
        {
          ...BASE,
          model: 'kimi-k3',
          agentOptions: { [CURSOR_MAX_MODE_OPTION]: choice },
        },
        () => {},
      );

      const config = JSON.parse(
        readFileSync(
          join(captured.env!.CURSOR_CONFIG_DIR!, 'cli-config.json'),
          'utf8',
        ),
      ) as { maxMode?: unknown };
      expect(config.maxMode).toBe(choice);
    }
  });

  it('makes an ask or plan turn ask, whatever approval mode the user runs', () => {
    // Measured on 2026.10.01-e373342: under the user's own `unrestricted` the
    // CLI ran a shell command with no `session/request_permission`, so no card.
    // An auto turn keeps the user's mode — the driver approves everything there.
    const home = mkdtempSync(join(tmpdir(), 'cursor-home-spec-'));
    dirs.push(home);
    mkdirSync(join(home, '.cursor'));
    writeFileSync(
      join(home, '.cursor', 'cli-config.json'),
      '{"approvalMode":"unrestricted"}',
    );
    const cases = [
      ['ask', 'allowlist'],
      ['plan', 'allowlist'],
      ['auto', 'unrestricted'],
    ] as const;
    for (const [approvalMode, expected] of cases) {
      const { spawn, captured } = fakeSpawn();
      const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
      dirs.push(profileDir);

      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
        profileDir,
        homeDir: home,
      }).start({ ...BASE, approvalMode }, () => {});

      const config = JSON.parse(
        readFileSync(
          join(captured.env!.CURSOR_CONFIG_DIR!, 'cli-config.json'),
          'utf8',
        ),
      ) as { approvalMode?: unknown };
      expect(config.approvalMode, approvalMode).toBe(expected);
    }
  });

  it('turns Max Mode ON for a turn that says nothing about it', () => {
    // The default, and what every run created before the setting existed gets:
    // an absent choice is the adapter's own answer, never OFF. The window of
    // every cursor model that has no `context` parameter of its own — measured on 2026.08.11-e8db854 with this flag as the only
    // difference: kimi-k3 reports 200,000 off and 1,048,576 on, while a model
    // that HAS the parameter obeys the parameter and ignores this. So it is
    // unconditional, and it is written EXPLICITLY rather than inherited: the
    // profile is a copy of the user's own config, so an untouched key means
    // "however their terminal was last left".
    const { spawn, captured } = fakeSpawn();
    const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
    dirs.push(profileDir);

    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
      profileDir,
    }).start({ ...BASE, model: 'kimi-k3' }, () => {});

    const config = JSON.parse(
      readFileSync(
        join(captured.env!.CURSOR_CONFIG_DIR!, 'cli-config.json'),
        'utf8',
      ),
    ) as { maxMode?: unknown };
    expect(config.maxMode).toBe(true);
  });

  it('links that config dir’s conversation store at one the turn cannot delete', () => {
    // The other half of the leak fix, and the half that was missing: the CLI
    // keeps each ACP conversation at `<configDir>/acp-sessions/<id>/`, so the
    // throwaway directory took the thread with it and a cursor chat's SECOND
    // message died at `session/load` ("Session … not found"). Drop the store and
    // the leak test above still passes while every chat becomes single-turn.
    const { spawn, captured } = fakeSpawn();
    const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
    const storeParent = mkdtempSync(join(tmpdir(), 'cursor-store-spec-'));
    const sessionStoreDir = join(storeParent, 'cursor-sessions');
    dirs.push(profileDir, storeParent);

    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
      profileDir,
      sessionStoreDir,
    }).start(BASE, () => {});

    const dir = captured.env?.CURSOR_CONFIG_DIR;
    const link = join(dir!, 'acp-sessions');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(sessionStoreDir));
    // OUTSIDE the profile base, which the boot sweep removes wholesale.
    expect(realpathSync(sessionStoreDir).startsWith(profileDir)).toBe(false);
  });

  it('lets a caller’s explicit config dir win over the throwaway one', () => {
    // A member pointed at a profile must not be silently overridden by the
    // per-turn directory — that would disable the feature from underneath it.
    const { spawn, captured } = fakeSpawn();
    const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
    dirs.push(profileDir);

    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
      profileDir,
    }).start(
      { ...BASE, env: { CURSOR_CONFIG_DIR: '/explicit/profile' } },
      () => {},
    );

    expect(captured.env?.CURSOR_CONFIG_DIR).toBe('/explicit/profile');
  });

  describe('a named configuration', () => {
    function cursorHome(authInfo: Record<string, unknown>): string {
      const home = mkdtempSync(join(tmpdir(), 'cursor-home-spec-'));
      dirs.push(home);
      mkdirSync(join(home, '.cursor'));
      writeFileSync(
        join(home, '.cursor', 'cli-config.json'),
        JSON.stringify({ approvalMode: 'allowlist', authInfo }),
      );
      return home;
    }

    function seededConfig(env: NodeJS.ProcessEnv | undefined): {
      authInfo?: unknown;
      approvalMode?: unknown;
    } {
      return JSON.parse(
        readFileSync(join(env!.CURSOR_CONFIG_DIR!, 'cli-config.json'), 'utf8'),
      ) as { authInfo?: unknown; approvalMode?: unknown };
    }

    it('is accepted', () => {
      expect(
        new CursorAcpAdapter({
          vocabularyStore: freshVocabularyStore(),
        }).getConfig().configDir.unavailableReason,
      ).toBeNull();
    });

    it('runs its turn on its own account, held in memory, and never the user’s exported key', () => {
      vi.stubEnv('CURSOR_API_KEY', 'user-exported-key-0000');
      const home = cursorHome({ email: 'default@example.com' });
      const configDir = cursorHome({ email: 'work@example.com' });
      writeFileSync(
        join(configDir, '.cursor', 'auth.json'),
        JSON.stringify({
          accessToken: 'work-access-token-0000',
          refreshToken: 'work-refresh-token-0000',
        }),
      );
      const { spawn, captured } = fakeSpawn();
      const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
      dirs.push(profileDir);
      const adapter = new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
        profileDir,
        homeDir: home,
      });
      new AgentAdapterRegistry([adapter]);

      adapter.start({ ...BASE, configDir }, () => {});

      expect(captured.env?.AGENT_CLI_CREDENTIAL_STORE).toBe('memory');
      expect(captured.env?.CURSOR_AUTH_TOKEN).toBe('work-access-token-0000');
      expect(captured.env?.CURSOR_API_KEY).toBe('');
      expect(captured.env?.HOME).toBe(process.env.HOME);
      const seeded = seededConfig(captured.env);
      expect(seeded.authInfo).toEqual({ email: 'work@example.com' });
      expect(seeded.approvalMode).toBe('allowlist');
    });

    it('leaves a signed-out configuration signed out instead of borrowing the default login', () => {
      const home = cursorHome({ email: 'default@example.com' });
      const configDir = mkdtempSync(join(tmpdir(), 'cursor-work-spec-'));
      dirs.push(configDir);
      const { spawn, captured } = fakeSpawn();
      const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
      dirs.push(profileDir);

      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
        profileDir,
        homeDir: home,
      }).start({ ...BASE, configDir }, () => {});

      expect(captured.env?.AGENT_CLI_CREDENTIAL_STORE).toBe('memory');
      expect(captured.env?.CURSOR_AUTH_TOKEN).toBeUndefined();
      expect(seededConfig(captured.env).authInfo).toBeUndefined();
    });

    it('leaves a turn with none on the CLI’s own login', () => {
      vi.stubEnv('CURSOR_API_KEY', 'user-exported-key-0000');
      const { spawn, captured } = fakeSpawn();
      const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
      dirs.push(profileDir);

      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
        profileDir,
      }).start(BASE, () => {});

      expect(captured.env?.AGENT_CLI_CREDENTIAL_STORE).toBeUndefined();
      expect(captured.env?.CURSOR_API_KEY).toBe('user-exported-key-0000');
    });

    function recordingGroupSpawn(
      record: (args: readonly string[], env: NodeJS.ProcessEnv) => void,
    ): typeof spawn {
      return ((
        _command: string,
        args: readonly string[],
        options: { env?: NodeJS.ProcessEnv },
      ) => {
        record(args, options.env ?? {});
        const fake = fakeGroupChild(4242);
        queueMicrotask(() => fake.close(0));
        return fake.child;
      }) as unknown as typeof spawn;
    }

    it('signs in and out under its own home and the file store', async () => {
      const spawned: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
      const adapter = new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        homeDir: '/Users/me',
        groupSpawnFn: recordingGroupSpawn((args, env) =>
          spawned.push({ args: [...args], env }),
        ),
        execFileFn: ((
          _command: string,
          args: readonly string[],
          options: { env?: NodeJS.ProcessEnv },
          done: (err: null, stdout: string, stderr: string) => void,
        ) => {
          spawned.push({ args: [...args], env: options.env ?? {} });
          queueMicrotask(() => done(null, '', ''));
          return new FakeChild() as unknown as ChildProcess;
        }) as unknown as typeof execFile,
      });

      await adapter.runLogin({
        configDir: '/profiles/work',
        timeoutMs: 1_000,
        onSpawn: () => undefined,
      });
      await adapter.runLogout({
        configDir: '/profiles/work',
        timeoutMs: 1_000,
      });

      expect(spawned.map((row) => row.args)).toEqual([['login'], ['logout']]);
      for (const row of spawned) {
        expect(row.env.HOME).toBe('/profiles/work');
        expect(row.env.AGENT_CLI_CREDENTIAL_STORE).toBe('file');
        expect(row.env.NODE_COMPILE_CACHE).toBe(
          '/Users/me/Library/Caches/cursor-compile-cache',
        );
      }
    });

    it('signs in to an MCP server under the real home, whatever profile asked', async () => {
      const spawned: NodeJS.ProcessEnv[] = [];
      const adapter = new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn: recordingGroupSpawn((_args, env) => spawned.push(env)),
      });

      await adapter.runMcpLogin({
        server: 'linear',
        cwd: process.cwd(),
        configDir: '/profiles/work',
        timeoutMs: 1_000,
        onSpawn: () => undefined,
      });

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.AGENT_CLI_CREDENTIAL_STORE).toBeUndefined();
      expect(spawned[0]?.HOME).toBe(process.env.HOME);
    });
  });

  it('runs a member’s switched-off MCP servers under a data dir whose disabled list adds them, and drops it with the session', async () => {
    const { spawn, captured, child } = fakeSpawn();
    const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
    const home = mkdtempSync(join(tmpdir(), 'cursor-home-spec-'));
    const cwd = mkdtempSync(join(tmpdir(), 'cursor-cwd-spec-'));
    dirs.push(profileDir, home, cwd);

    const handle = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
      profileDir,
      homeDir: home,
    }).start(
      {
        ...BASE,
        cwd,
        mcpDisabled: ['codegraph', 'geniro-run'],
        mcpEndpoint: {
          url: 'http://127.0.0.1:1/v1/mcp/r/n',
          token: 't',
          serverName: 'geniro-run',
        },
      },
      () => {},
    );

    const dataDir = captured.env?.CURSOR_DATA_DIR;
    expect(dataDir?.startsWith(profileDir)).toBe(true);
    const [key] = readdirSync(join(dataDir!, 'projects'));
    expect(
      JSON.parse(
        readFileSync(
          join(dataDir!, 'projects', key!, 'mcp-disabled.json'),
          'utf8',
        ),
      ),
    ).toEqual(['codegraph']);

    handle.cancel();
    child.emit('close', null, 'SIGTERM');
    await handle.done;
    await new Promise((resolve) => setImmediate(resolve));
    expect(existsSync(dataDir!)).toBe(false);
  });

  it('leaves the user’s own data dir alone on a turn that switches nothing off', () => {
    const { spawn, captured } = fakeSpawn();
    const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
    dirs.push(profileDir);
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
      profileDir,
    }).start(BASE, () => {});
    expect(captured.env?.CURSOR_DATA_DIR).toBeUndefined();
  });

  it('declares the client flag that makes a separate effort exist at all', () => {
    // Without `_meta.parameterizedModelPicker` the agent composes one opaque id
    // per model family and rejects every recomposed effort — which is what made
    // "I cannot change the effort of a Cursor model" true. Drop this and the
    // effort picker silently stops working while every test above still passes,
    // because the frames would look identical.
    const { spawn, child } = fakeSpawn();
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start(BASE, () => {});

    const init = framesOn(child).find((frame) => frame.method === 'initialize')
      ?.params as { clientCapabilities?: { _meta?: unknown } } | undefined;
    expect(init?.clientCapabilities?._meta).toEqual({
      parameterizedModelPicker: true,
      // Its neighbour in the same bag — see `CURSOR_ACP_CLIENT_META`.
      subagents: {},
    });
  });

  it('says so when the agent does not offer the requested model', () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start({ ...BASE, model: 'gpt-5' }, (event) => events.push(event));
    child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({
        id: 2,
        result: {
          sessionId: 's',
          models: {
            currentModelId: 'composer-2.5[fast=true]',
            availableModels: [{ modelId: 'composer-2.5[fast=true]' }],
          },
        },
      })}\n`,
    );

    expect(events).toContainEqual({
      type: 'notice',
      message:
        "agent does not offer the model 'gpt-5' — this turn runs on the agent's current model instead",
    });
    // Not merely announced — the frame must not go out either, or the agent
    // answers with an error the turn would then have to explain twice.
    expect(framesOn(child).map((frame) => frame.method)).not.toContain(
      'session/set_model',
    );
  });

  it('stays silent when every turn parameter has an ACP home', () => {
    const { spawn } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start(BASE, (event) => events.push(event));
    expect(events).toEqual([]);
  });

  it('asks for cursor plan mode only in the plan approval mode', () => {
    for (const [mode, expected] of [
      ['plan', 'plan'],
      ['ask', undefined],
      ['auto', undefined],
    ] as const) {
      const { spawn, child } = fakeSpawn();
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
      }).start({ ...BASE, approvalMode: mode }, () => {});
      child.stdout.emitData(
        `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
      );
      child.stdout.emitData(
        `${JSON.stringify({
          id: 2,
          result: {
            sessionId: 's',
            modes: {
              currentModeId: 'agent',
              availableModes: [{ id: 'agent' }, { id: 'plan' }],
            },
          },
        })}\n`,
      );
      const setMode = framesOn(child).find(
        (frame) => frame.method === 'session/set_mode',
      )?.params as { modeId: string } | undefined;
      expect(setMode?.modeId).toBe(expected);
    }
  });
});

describe('cursorAutoDecision', () => {
  it('auto-approves everything in auto mode, preserving unattended semantics', () => {
    expect(cursorAutoDecision('auto')).toBe('allow');
  });

  it('auto-approves a turn that carries no mode at all', () => {
    expect(cursorAutoDecision(undefined)).toBe('allow');
  });

  it('offers no acceptEdits mode, which would be ask under another name', () => {
    // cursor makes an ordinary in-folder write without asking, so an
    // edits-only mode would have nothing of its own to approve.
    expect(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
      }).getConfig().approval.modes,
    ).toEqual(['auto', 'ask']);
  });

  it('asks about everything that reaches it in ask, plan and a stored acceptEdits', () => {
    // cursor makes an ordinary in-folder write without asking; what it DOES
    // send is a write outside the folder, a delete, or one of its protected
    // config files — so acceptEdits has nothing here it may wave through.
    expect(cursorAutoDecision('ask')).toBeNull();
    expect(cursorAutoDecision('plan')).toBeNull();
    expect(cursorAutoDecision('acceptEdits')).toBeNull();
  });
});

describe('CursorAcpAdapter permission round-trip', () => {
  /**
   * One write `session/request_permission` exactly as cursor-agent 2026.09.10's
   * `formatOperation` builds it (`7214.index.js`): `kind: "edit"` with a `diff`
   * content block.
   */
  function cursorPermission(id: number): string {
    return stdoutLine({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 's',
        toolCall: {
          toolCallId: 't-1',
          title: 'Edit `src/a.ts`',
          kind: 'edit',
          status: 'pending',
          content: [
            {
              type: 'diff',
              path: 'src/a.ts',
              oldText: 'old',
              newText: 'new',
            },
          ],
        },
        options: ONCE_OPTIONS,
      },
    });
  }

  it('asks the user about a WRITE under a stored acceptEdits — cursor sends only the ones it escalated', () => {
    // A write that reaches the client is one cursor would not make on its own:
    // outside the folder, or a protected config file such as `.git/config` — a
    // change that can run code on the next command. It must reach a person.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start({ ...BASE, approvalMode: 'acceptEdits' }, (event) =>
      events.push(event),
    );
    handshake(child);
    child.stdout.emitData(cursorPermission(7));

    expect(framesOn(child).find((frame) => frame.id === 7)).toBeUndefined();
    expect(events.filter((event) => event.type === 'approval_request')).toEqual(
      [expect.objectContaining({ type: 'approval_request' })],
    );
  });

  it('approves a request itself in auto mode, with no card', () => {
    // An unattended member runs in `auto`; a request parked on a card there would
    // wait for a person who is not coming.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start({ ...BASE, approvalMode: 'auto' }, (event) => events.push(event));
    handshake(child);
    child.stdout.emitData(cursorPermission(7));

    expect(framesOn(child).find((frame) => frame.id === 7)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'o-allow' },
    });
    expect(events.filter((event) => event.type === 'approval_request')).toEqual(
      [],
    );
  });

  it('shows the name and arguments cached from the tool_call update on a stub request’s card', () => {
    // Protocol-legal (every field but the id is optional) and not what this
    // CLI sends: the card still names the call and shows what it would do.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start({ ...BASE, approvalMode: 'acceptEdits' }, (event) =>
      events.push(event),
    );
    handshake(child);
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't-1',
        name: 'write_file',
        kind: 'edit',
        rawInput: { path: 'a.ts' },
      }),
    );
    child.stdout.emitData(
      stdoutLine({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          toolCall: { toolCallId: 't-1' },
          options: ONCE_OPTIONS,
        },
      }),
    );

    expect(framesOn(child).find((frame) => frame.id === 7)).toBeUndefined();
    expect(events.filter((event) => event.type === 'approval_request')).toEqual(
      [
        expect.objectContaining({
          toolName: 'write_file',
          input: { path: 'a.ts' },
        }),
      ],
    );
  });

  it('delivers an ask-mode verdict to the running agent as a selected option', () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start({ ...BASE, approvalMode: 'ask' }, (event) => events.push(event));
    handshake(child);
    child.stdout.emitData(
      stdoutLine({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          toolCall: {
            toolCallId: 't-1',
            name: 'write_file',
            kind: 'edit',
            rawInput: { path: 'a.ts' },
          },
          options: ONCE_OPTIONS,
        },
      }),
    );
    expect(events).toContainEqual({
      type: 'approval_request',
      id: 'n:7',
      toolName: 'write_file',
      input: { path: 'a.ts' },
    });

    // The verdict has to travel adapter → per-turn driver → child stdin. A
    // driver assembled without an approval encoder would silently drop it and
    // park every ask-mode cursor turn until it timed out.
    expect(handle.respondApproval('n:7', true)).toBe(true);
    expect(framesOn(child).find((frame) => frame.id === 7)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'o-allow' },
    });
  });

  it('offers "Allow always" as the session-long answer it is under geniro, and answers it with that option', () => {
    // The options cursor-agent 2026.10.19 puts on every request it raises. Its
    // "always" lands in the per-conversation profile geniro seeds, so the card
    // must not promise more than one session.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start({ ...BASE, approvalMode: 'ask' }, (event) => events.push(event));
    handshake(child);
    child.stdout.emitData(
      stdoutLine({
        jsonrpc: '2.0',
        id: 8,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          toolCall: { toolCallId: 't-2', title: '`touch a`', kind: 'execute' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            {
              optionId: 'allow-always',
              name: 'Allow always',
              kind: 'allow_always',
            },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      }),
    );
    const card = events.find((event) => event.type === 'approval_request');
    const options = card?.type === 'approval_request' ? card.options : [];
    expect(options).toEqual([
      {
        id: 'allow-always',
        label: 'Allow for this session',
        allow: true,
        scope: 'session',
      },
    ]);

    expect(handle.respondApproval('n:8', true, undefined, options?.[0])).toBe(
      true,
    );
    expect(framesOn(child).find((frame) => frame.id === 8)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-always' },
    });
  });
});

describe('CursorAcpAdapter — no mid-turn user message', () => {
  it('refuses one rather than writing a frame the protocol has no place for', () => {
    // ACP's `session/prompt` is ONE request per turn, and the protocol gives a
    // client no way to add to a prompt already accepted. Reporting false is
    // what keeps the caller's queue correct: the message waits for the next
    // turn instead of being dropped as delivered. Claude's stdin answers true
    // here, and the two must stay tellable apart by the ANSWER, not by the
    // caller checking which CLI it is talking to.
    const child = new FakeChild();
    const spawn: SpawnFn = () => child as unknown as SpawnedProcess;
    const handle = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start({ ...BASE, prompt: 'go' }, () => {});

    expect(handle.sendUserMessage({ text: 'and also this' })).toBe(false);
  });
});

describe('CursorAcpAdapter — cannot reopen a conversation', () => {
  it('refuses, and NAMES THE MECHANISM rather than merely declining', () => {
    // Re-verified 2026-08-12 against 2026.08.11-e8db854 + Cursor 3.15.6: the
    // ACP store (`~/.cursor/acp-sessions/<uuid>/`) and the store `--resume`
    // reads (`~/.cursor/chats/<md5(cwd)>/`) are two hardcoded paths in the
    // shipped bundle with nothing joining them, and the only `cursor://` route
    // in the whole binary targets no thread.
    //
    // The sentence is what the panel renders on the inert control, so it has to
    // say something the user can act on — this asserts the mechanism is in it,
    // not just that some string exists. A generic "no interactive terminal
    // session" (which the capability route used to compose) would pass a
    // non-empty check and fail this one.
    const reason = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    }).handoffUnavailableReason();

    expect(reason).toEqual(expect.any(String));
    // The mechanism in the user's terms: the two sets of conversations are
    // kept apart. A generic "no interactive terminal session" carries no such
    // word, which is what this pin is for.
    expect(reason).toContain('separately');
    // And the refusal itself still holds for a real-looking session id — the
    // danger being that `--resume` ACCEPTS an unknown one and silently opens an
    // EMPTY chat, so a wired button would look like it worked.
    expect(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
      }).handoffTarget({
        sessionId: 'fa6e9302-6ae4-4ea7-ba35-536fc8cc1e29',
        model: null,
      }),
    ).toEqual({ ok: false, reason: 'unsupported' });
  });
});

describe('CursorAcpAdapter — background sub-agents', () => {
  /**
   * Every frame below is transcribed from the wire, cursor-agent
   * 2026.08.11-e8db854, 2026-08-13 — see the `Background sub-agents` block in
   * `cursor-acp.const.ts`. That matters here more than usual: the declaration
   * this replaces said cursor reports no delegates, and it was written from
   * geniro's own types rather than from frames like these.
   */
  const LAUNCH = sessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_018bc',
    title: 'Task: Subagent task',
    kind: 'other',
    status: 'pending',
    rawInput: { _toolName: 'task' },
  });

  function taskAnnouncement(params: Record<string, unknown>, id = 7): string {
    return stdoutLine({ jsonrpc: '2.0', id, method: 'cursor/task', params });
  }

  function driveTurn(): { child: FakeChild; events: AgentEvent[] } {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start({ ...BASE }, (event) => events.push(event));
    handshake(child);
    return { child, events };
  }

  it('declares that it reports delegates, but not the work inside them', () => {
    const config = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    }).getConfig();
    expect(config.subagents.reports).toBe(true);
    expect(config.subagents.unavailableReason).toBeNull();
    // The one asymmetry with claude, and the reason a second field exists: the
    // delegation is announced, its steps never are. A null here would promise a
    // conversation the card can never fill.
    expect(config.subagents.stepsUnavailableReason).toContain(
      'not the work inside it',
    );
  });

  it('announces a delegate as soon as the launch frame arrives, before its brief', () => {
    // What makes the block open — and the run read as busy — while the delegate
    // is still working. The launch frame names no description at all (its title
    // is the CLI's placeholder), so the anchor is all this row can carry.
    const { child, events } = driveTurn();
    child.stdout.emitData(LAUNCH);

    const info = events.filter((event) => event.type === 'subagent_info');
    expect(info).toEqual([
      {
        type: 'subagent_info',
        id: 'toolu_018bc',
        label: null,
        kind: null,
        prompt: null,
        model: null,
        durationMs: null,
        tokens: null,
        toolUses: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
        stepsUnavailableReason: expect.stringContaining(
          'not the work inside it',
        ),
        backgroundOpen: null,
        backgroundOutcome: null,
        recovery: expect.objectContaining({
          agentKind: 'cursor-agent',
          sessionId: 's',
          toolCallId: 'toolu_018bc',
          launchedAtMs: expect.any(Number),
        }),
      },
    ]);
    // AFTER the tool call it anchors to, so a consumer replaying in seq order
    // has the row before anything references it.
    const kinds = events.map((event) => event.type);
    expect(kinds.indexOf('tool_call')).toBeLessThan(
      kinds.indexOf('subagent_info'),
    );
  });

  it('leaves an ordinary tool call alone — the marker is what makes it a delegation', () => {
    const { child, events } = driveTurn();
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't-1',
        title: 'Read a file',
        rawInput: { _toolName: 'read', path: '/repo/a.ts' },
      }),
    );
    // And one that disclosed no arguments at all, which is routine on this
    // transport (`rawInput: {}` normalizes to null) — reading the marker off it
    // must not throw or invent a delegate.
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't-2',
        title: 'Search',
        rawInput: {},
      }),
    );

    expect(events.some((event) => event.type === 'subagent_info')).toBe(false);
  });

  it('ANSWERS the announcement and records the delegate it describes', () => {
    const { child, events } = driveTurn();
    child.stdout.emitData(LAUNCH);
    child.stdout.emitData(
      taskAnnouncement({
        toolCallId: 'toolu_018bc',
        description: 'List files in directory',
        prompt: 'Your task is simple and self-contained: …',
        subagentType: { custom: { unspecified: {} } },
        model: 'claude-opus-5-thinking-high',
        agentId: 'bce43ebb-cf88-4adf-bb10-33f0b5458f45',
        durationMs: 13075,
      }),
    );

    expect(
      events.filter((event) => event.type === 'subagent_info').at(-1),
    ).toEqual({
      type: 'subagent_info',
      id: 'toolu_018bc',
      label: 'List files in directory',
      // `{custom:{unspecified:{}}}` names no type — the row says nothing rather
      // than labelling the delegate `unspecified`.
      kind: null,
      prompt: 'Your task is simple and self-contained: …',
      model: 'claude-opus-5-thinking-high',
      durationMs: 13075,
      tokens: null,
      toolUses: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costUsd: null,
      stepsUnavailableReason: expect.stringContaining('not the work inside it'),
      backgroundOpen: null,
      backgroundOutcome: null,
      recovery: expect.objectContaining({
        agentKind: 'cursor-agent',
        sessionId: 's',
        toolCallId: 'toolu_018bc',
      }),
    });
    // Answered, not declined. The refusal is what this whole feature was lost
    // behind: the agent discards the outcome either way, so a `-32601` cost the
    // turn nothing and silently threw the brief away.
    const reply = framesOn(child).find((frame) => frame.id === 7);
    expect(reply).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    // …and it does NOT burn the turn's one "declined" notice, which is what
    // being on the silent list used to buy.
    expect(events.some((event) => event.type === 'notice')).toBe(false);
  });

  it('declines an announcement it cannot read, rather than writing a blank delegate', () => {
    const { child, events } = driveTurn();
    // No `toolCallId`: nothing to anchor a block to, so there is no row worth
    // writing and the request falls through to the ordinary decline.
    child.stdout.emitData(taskAnnouncement({ description: 'orphan' }, 9));

    expect(events.some((event) => event.type === 'subagent_info')).toBe(false);
    const reply = framesOn(child).find((frame) => frame.id === 9);
    expect(reply?.error).toMatchObject({ code: -32601 });
  });

  it('drops the launching tool’s accounting instead of framing it as the delegate’s answer', () => {
    // Measured: the `task` call completes with `{durationMs, isBackground}` and
    // the findings appear only in the main agent's next message. Rendered as
    // `Result from <delegate>`, that object printed where the reader looks for
    // what the delegate found.
    const { child, events } = driveTurn();
    child.stdout.emitData(LAUNCH);
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_018bc',
        status: 'completed',
        rawOutput: { durationMs: 15430, isBackground: false },
      }),
    );

    const result = events.find((event) => event.type === 'tool_result');
    // The pair still CLOSES — the block reads `completed` off the result's
    // existence, so suppressing the row itself would leave a finished delegate
    // spinning forever.
    expect(result).toMatchObject({ id: 'toolu_018bc', result: null });
  });

  it('marks a BACKGROUND launch as still out, and drops its launch duration', () => {
    // MEASURED on 2026.08.11-e8db854 by asking for a background delegate: the
    // launching call completes in 203ms with `isBackground: true`, the turn
    // ends four seconds later, and the delegate is still asking this client for
    // shell permissions seventy seconds after that. Everything about the frame
    // is otherwise identical to a delegate the call waited for — this boolean
    // is the whole of the difference.
    //
    // REPORTED as ten reviewers each reading `took 0s` under a green check
    // while every one of them was working.
    const { child, events } = driveTurn();
    child.stdout.emitData(LAUNCH);
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_018bc',
        status: 'completed',
        rawOutput: { durationMs: 203, isBackground: true },
      }),
    );
    // The announcement that follows carries the LAUNCH's milliseconds.
    child.stdout.emitData(
      taskAnnouncement({
        toolCallId: 'toolu_018bc',
        description: 'Bugs-dimension review',
        durationMs: 203,
      }),
    );

    const info = events.filter((event) => event.type === 'subagent_info');
    // The row that says the work outlives its launching call.
    expect(info.some((event) => event.backgroundOpen === true)).toBe(true);
    // Never FALSE off the wire: it announces no ending for a background
    // delegate — that is read off the delegate's own transcript, below.
    expect(info.some((event) => event.backgroundOpen === false)).toBe(false);
    // And no announcement may publish 203ms as what the delegate took.
    expect(info.every((event) => event.durationMs === null)).toBe(true);
  });

  it('leaves a delegate the call WAITED for exactly as it was', () => {
    // The other half: `isBackground: false` is the case every earlier
    // measurement saw, and its duration is the delegate's own work.
    const { child, events } = driveTurn();
    child.stdout.emitData(LAUNCH);
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_018bc',
        status: 'completed',
        rawOutput: { durationMs: 15430, isBackground: false },
      }),
    );
    child.stdout.emitData(
      taskAnnouncement({
        toolCallId: 'toolu_018bc',
        description: 'List files in directory',
        durationMs: 15430,
      }),
    );

    const info = events.filter((event) => event.type === 'subagent_info');
    expect(info.every((event) => event.backgroundOpen === null)).toBe(true);
    expect(info.some((event) => event.durationMs === 15430)).toBe(true);
  });

  describe('a background delegate’s ending, read off its own transcript', () => {
    /**
     * REPORTED: nine reviewers a QA member launched in the background rendered
     * as nine green checks the moment its turn ended — the turn closed them,
     * with no outcome claimed, which the transcript draws as finished — while
     * every one was still working; the Manager then had to send the QA back to
     * wait for them. Measured on that run: the finished reviewers' transcripts
     * end on `{"type":"turn_ended","status":"success"}`, the working ones' do
     * not. And measured through this daemon: `cursor/task`'s `agentId` is not
     * the transcript's name, so a transcript is found by the brief it opens
     * with.
     */
    let home: string;
    let current: FakeChild | undefined;

    afterEach(() => {
      // Ended, so this test's session stops watching: a watch left running
      // would go on polling under the NEXT test's fake clock.
      current?.emit('close', 0, null);
      current = undefined;
      vi.useRealTimers();
      rmSync(home, { recursive: true, force: true });
    });

    function transcriptPath(agentId: string): string {
      return join(
        home,
        CURSOR_HOME_DIR_NAME,
        'projects',
        'repo',
        'agent-transcripts',
        agentId,
        `${agentId}.jsonl`,
      );
    }

    const BRIEF = 'You are sub-agent 1. Run sleep 75, then reply done 1.';
    const OPENING = {
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: `<timestamp>now</timestamp>\n<user_query>\n${BRIEF}\n</user_query>`,
          },
        ],
      },
    };

    function writeTranscript(agentId: string, lines: unknown[]): void {
      const path = transcriptPath(agentId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
      );
    }

    const WORKING = {
      role: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] },
    };

    function launchInBackground(prompt: string | null = BRIEF): {
      child: FakeChild;
      events: AgentEvent[];
      warn: ReturnType<typeof vi.fn<(message: string) => void>>;
      handle: AgentTurnHandle | null;
      session: ReturnType<CursorAcpAdapter['startSession']>;
    } {
      const warn = vi.fn<(message: string) => void>();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      home = mkdtempSync(join(tmpdir(), 'cursor-delegate-home-'));
      const { spawn, child } = fakeSpawn();
      current = child;
      const events: AgentEvent[] = [];
      // Run-scoped, as every chat and team turn is: the process outlives
      // the turn, which is what lets a turn be HELD for its delegates.
      const session = new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
        homeDir: home,
        logger: { warn },
      }).startSession({ ...BASE }, { runScoped: true });
      const handle = session.startTurn({ ...BASE }, (event) =>
        events.push(event),
      );
      handshake(child);
      child.stdout.emitData(LAUNCH);
      child.stdout.emitData(
        sessionUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'toolu_018bc',
          status: 'completed',
          rawOutput: { durationMs: 203, isBackground: true },
        }),
      );
      child.stdout.emitData(
        taskAnnouncement({
          toolCallId: 'toolu_018bc',
          description: 'Bugs-dimension review',
          // As measured on the wire: an `agentId` that is NOT the name of the
          // delegate's transcript. Following it is what found nothing.
          agentId: '05df2846-2f02-475b-a298-32f5e165c78a',
          ...(prompt === null ? {} : { prompt }),
          durationMs: 203,
        }),
      );
      return { child, events, warn, handle, session };
    }

    /** A second background delegate, launched the way the first one was. */
    function launchAnother(
      child: FakeChild,
      toolCallId: string,
      prompt: string,
      requestId: number,
    ): void {
      child.stdout.emitData(
        sessionUpdate({
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'Task: Subagent task',
          kind: 'other',
          status: 'pending',
          rawInput: { _toolName: 'task' },
        }),
      );
      child.stdout.emitData(
        sessionUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          rawOutput: { durationMs: 210, isBackground: true },
        }),
      );
      child.stdout.emitData(
        taskAnnouncement(
          {
            toolCallId,
            description: 'Finish bugs review',
            prompt,
            durationMs: 210,
          },
          requestId,
        ),
      );
    }

    /** The wake prompts the driver sent after the turn's own prompt (id 3). */
    const wakes = (child: FakeChild): Record<string, unknown>[] =>
      framesOn(child).filter(
        (frame) => frame.method === 'session/prompt' && frame.id !== 3,
      );

    const wakeText = (frame: Record<string, unknown> | undefined): string => {
      const params = frame?.params as
        { prompt?: { text?: string }[] } | undefined;
      return params?.prompt?.map((block) => block.text ?? '').join('') ?? '';
    };

    const REPORTING = {
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Bugs review: REPORT-7731, 2 findings.' },
        ],
      },
    };

    const closes = (events: AgentEvent[]): AgentEvent[] =>
      events.filter(
        (event) =>
          event.type === 'subagent_info' && event.backgroundOpen === false,
      );

    function endTurn(child: FakeChild): void {
      child.stdout.emitData(
        stdoutLine({
          jsonrpc: '2.0',
          id: 3,
          result: { stopReason: 'end_turn' },
        }),
      );
    }

    it('keeps it open while its transcript says it is working, and HOLDS the turn past its `end_turn`', async () => {
      const { child, events } = launchInBackground();
      writeTranscript('agent-bugs', [OPENING, WORKING]);

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      endTurn(child);

      // The prompt ending is not the delegate ending — nor, any longer, the
      // turn's: a callee that settled here handed its caller "they are
      // finishing now" as its review (run `bd1e43ae`, call-143).
      expect(closes(events)).toEqual([]);
      expect(events.some((event) => event.type === 'turn_complete')).toBe(
        false,
      );
      expect(events.at(-2)).toMatchObject({
        type: 'notice',
        message: expect.stringContaining('Waiting for 1 background sub-agent'),
      });
      // Announced as a hold, so the composer sends a message straight in.
      expect(events.at(-1)).toEqual({ type: 'turn_held', open: 1 });
      expect(wakes(child)).toEqual([]);
    });

    it('wakes the agent with the delegate’s report once it ends, and settles the turn on that answer', async () => {
      const { child, events } = launchInBackground();
      writeTranscript('agent-bugs', [OPENING, WORKING]);
      await vi.advanceTimersByTimeAsync(5_000);
      endTurn(child);

      writeTranscript('agent-bugs', [
        OPENING,
        WORKING,
        REPORTING,
        { type: 'turn_ended', status: 'success' },
      ]);
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(wakes(child)).toHaveLength(1);
      });

      expect(events).toContainEqual({ type: 'turn_held', open: 0 });
      const text = wakeText(wakes(child)[0]);
      // What the delegate said, under its own description — the parent has no
      // other way to receive it — and where the rest of it can be read.
      expect(text).toContain('REPORT-7731');
      expect(text).toContain('Bugs-dimension review — finished');
      expect(text).toContain(transcriptPath('agent-bugs'));
      expect(closes(events)).toEqual([
        expect.objectContaining({ backgroundOutcome: 'completed' }),
      ]);
      expect(events.some((event) => event.type === 'turn_complete')).toBe(
        false,
      );

      child.stdout.emitData(
        sessionUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Final review: 2 findings.' },
        }),
      );
      child.stdout.emitData(
        stdoutLine({
          jsonrpc: '2.0',
          id: wakes(child)[0]?.id,
          result: { stopReason: 'end_turn' },
        }),
      );
      // The answer the agent gave once told — not the "launched" it held,
      // glued in front of it, which is what a caller was handed before.
      expect(events.at(-1)).toMatchObject({
        type: 'turn_complete',
        finalText: 'Final review: 2 findings.',
      });
    });

    it('does not hold a LATER turn for a delegate an earlier turn stopped waiting on', async () => {
      const { child, events, handle, session } = launchInBackground();
      writeTranscript('agent-bugs', [OPENING, WORKING]);
      await vi.advanceTimersByTimeAsync(5_000);
      endTurn(child);
      handle?.cancel();
      expect(events.at(-1)?.type).toBe('turn_cancelled');

      const next: AgentEvent[] = [];
      session.startTurn({ ...BASE, prompt: 'hi' }, (event) => next.push(event));
      const prompt = framesOn(child)
        .filter((frame) => frame.method === 'session/prompt')
        .at(-1);
      expect(prompt?.id).not.toBe(3);
      child.stdout.emitData(
        stdoutLine({
          jsonrpc: '2.0',
          id: prompt?.id,
          result: { stopReason: 'end_turn' },
        }),
      );

      // The delegate is still out and still watched — it just is not this
      // turn's to wait for.
      expect(next.at(-1)?.type).toBe('turn_complete');
      expect(
        next.some(
          (event) =>
            event.type === 'notice' && event.message.includes('Waiting for'),
        ),
      ).toBe(false);
    });

    it('hands a transcript to the delegate RESUMING it, and closes the cut-off one as stopped with recovery off', async () => {
      // Run `bd1e43ae`: a reviewer cut off by a dropped stream never wrote
      // `turn_ended`, and its relaunch appended a new brief to its transcript.
      const { child, events } = launchInBackground();
      writeTranscript('agent-bugs', [OPENING, WORKING]);
      await vi.advanceTimersByTimeAsync(5_000);
      // The original holds the transcript now; let the file age past the
      // window in which a NEW transcript could still be it.
      await vi.advanceTimersByTimeAsync(20_000);

      const RESUMED = 'Your turn was cut off. Finish the bugs review.';
      launchAnother(child, 'toolu_resume', RESUMED, 8);
      writeTranscript('agent-bugs', [
        OPENING,
        WORKING,
        {
          role: 'user',
          message: {
            content: [
              {
                type: 'text',
                text: `<user_query>
${RESUMED}
</user_query>`,
              },
            ],
          },
        },
        WORKING,
      ]);
      const touched = new Date(Date.now());
      utimesSync(transcriptPath('agent-bugs'), touched, touched);

      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(closes(events)).toHaveLength(1);
      });
      expect(closes(events)[0]).toMatchObject({
        id: 'toolu_018bc',
        backgroundOutcome: 'stopped',
        recovery: null,
      });

      // And the transcript's ending is now the continuation's.
      writeTranscript('agent-bugs', [
        OPENING,
        REPORTING,
        { type: 'turn_ended', status: 'success' },
      ]);
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(closes(events)).toHaveLength(2);
      });
      expect(closes(events)[1]).toMatchObject({
        id: 'toolu_resume',
        backgroundOutcome: 'completed',
      });
    });

    it('ends the hold on Stop without sending anything — no wake, no cancel', async () => {
      const { child, events, handle } = launchInBackground();
      writeTranscript('agent-bugs', [OPENING, WORKING]);
      await vi.advanceTimersByTimeAsync(5_000);
      endTurn(child);

      handle?.cancel();

      expect(events.filter((event) => event.type === 'turn_cancelled')).toEqual(
        [{ type: 'turn_cancelled' }],
      );
      const methods = framesOn(child).map((frame) => frame.method);
      expect(methods).not.toContain('session/cancel');
      expect(child.kills).toBe(0);

      // The delegate ending afterwards wakes nobody: the user stopped the turn.
      // (Its close goes to the session's off-turn sink — the stopped turn is
      // over — so the watch's sweeps are what is advanced through here.)
      writeTranscript('agent-bugs', [
        OPENING,
        REPORTING,
        { type: 'turn_ended', status: 'success' },
      ]);
      for (let sweep = 0; sweep < 6; sweep += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(wakes(child)).toEqual([]);
    });

    it('lets a message carry a held turn on, instead of the wake', async () => {
      const { child, events, handle } = launchInBackground();
      writeTranscript('agent-bugs', [OPENING, WORKING]);
      await vi.advanceTimersByTimeAsync(5_000);
      endTurn(child);

      expect(events.at(-1)).toEqual({ type: 'turn_held', open: 1 });
      expect(handle?.sendUserMessage({ text: 'status?' })).toBe(true);
      // The hold is over the moment the message is written.
      expect(events).toContainEqual({ type: 'turn_held', open: 0 });
      const sent = wakes(child);
      expect(sent).toHaveLength(1);
      expect(wakeText(sent[0])).toBe('status?');
      // Nothing was running, so nothing was cancelled.
      expect(framesOn(child).map((frame) => frame.method)).not.toContain(
        'session/cancel',
      );
      expect(events.some((event) => event.type === 'turn_complete')).toBe(
        false,
      );

      // The message ended the hold: the delegate ending now must not send a
      // wake on top of the prompt the user's message is running.
      writeTranscript('agent-bugs', [
        OPENING,
        REPORTING,
        { type: 'turn_ended', status: 'success' },
      ]);
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(closes(events)).toHaveLength(1);
      });
      expect(wakes(child)).toHaveLength(1);
    });

    it('settles a held turn that nothing has moved for, on the answer it had', async () => {
      const { child, events, warn } = launchInBackground();
      writeTranscript('agent-bugs', [OPENING, WORKING]);
      await vi.advanceTimersByTimeAsync(5_000);
      endTurn(child);

      await vi.advanceTimersByTimeAsync(DELEGATE_HOLD_IDLE_MS);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('settling a turn held for 1 background'),
      );
      expect(events.at(-1)?.type).toBe('turn_complete');
      // Still watched, not closed: nothing says it is over.
      expect(closes(events)).toEqual([]);
      expect(wakes(child)).toEqual([]);
    });

    it('does not settle a held turn because the machine slept through the window', async () => {
      // member's timers count through a macOS sleep: the hold ran out at the
      // wake and the turn ended on its partial answer, over delegates that had
      // been asleep with the machine, not idle.
      const { child, events, warn } = launchInBackground();
      writeTranscript('agent-bugs', [OPENING, WORKING]);
      await vi.advanceTimersByTimeAsync(5_000);
      endTurn(child);
      await vi.advanceTimersByTimeAsync(45_000);

      await simulateSleep(4 * 60 * 60_000);
      expect(events.some((event) => event.type === 'turn_complete')).toBe(
        false,
      );

      // The window starts again, whole, from the wake.
      await vi.advanceTimersByTimeAsync(DELEGATE_HOLD_IDLE_MS - 1);
      expect(events.some((event) => event.type === 'turn_complete')).toBe(
        false,
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('settling a turn held for 1 background'),
      );
      expect(events.at(-1)?.type).toBe('turn_complete');
    });

    it('closes it with the outcome its transcript states, and the time it really took', async () => {
      const { events } = launchInBackground();
      writeTranscript('agent-bugs', [OPENING, WORKING]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(closes(events)).toEqual([]);

      writeTranscript('agent-bugs', [
        OPENING,
        WORKING,
        { type: 'turn_ended', status: 'success' },
      ]);
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(closes(events)).toHaveLength(1);
      });

      expect(closes(events)[0]).toMatchObject({
        id: 'toolu_018bc',
        backgroundOpen: false,
        backgroundOutcome: 'completed',
      });
      // Measured from the launch, where the announcement carried only the
      // launch's 203ms.
      const [close] = closes(events);
      expect(
        close?.type === 'subagent_info' ? close.durationMs : null,
      ).toBeGreaterThanOrEqual(10_000);
    });

    it('marks a delegate with nothing to find it by untracked when its turn ends', () => {
      // No id and no brief: nothing can watch it, so the turn completing is the
      // last moment anything can be said — the behaviour every delegate had
      // before the reader.
      const { child, events } = launchInBackground(null);
      endTurn(child);

      expect(closes(events)).toEqual([
        expect.objectContaining({
          id: 'toolu_018bc',
          backgroundOutcome: 'untracked',
        }),
      ]);
      const kinds = events.map((event) => event.type);
      expect(kinds.lastIndexOf('subagent_info')).toBeLessThan(
        kinds.indexOf('turn_complete'),
      );
    });

    it('gives up on a transcript that never turns up, and closes it with the turn', async () => {
      const { child, events, warn } = launchInBackground();
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('record never turned up'),
        );
      });
      // Not while the turn is running — nothing says the delegate is over.
      expect(closes(events)).toEqual([]);

      endTurn(child);
      expect(closes(events)).toEqual([
        expect.objectContaining({ backgroundOutcome: 'untracked' }),
      ]);
    });

    describe('a request that fails while the agent waits on its sub-agents', () => {
      /**
       * Run `a8f5fb5f`: a QA agent waited on seven verifiers when cursor's
       * stream closed (`[canceled] http/2 … CANCEL (0x8)`). Five had finished,
       * two were still running — and went on to finish `success` seven minutes
       * later, with nowhere to send their results. Told every unreturned call
       * "was stopped", the agent relaunched all seven, while the two blocks it
       * had been waiting on spun forever.
       */
      const DROP =
        '\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)';

      /** A delegation the agent WAITS on, as cursor writes its call. */
      function launchWaitedOn(
        child: FakeChild,
        toolCallId: string,
        description: string,
      ): void {
        child.stdout.emitData(
          sessionUpdate({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: `Task: ${description}`,
            kind: 'other',
            status: 'pending',
            // Measured on 2026.10.01-e373342: the call's own input carries the
            // brief; the `cursor/task` announcement arrives only as it returns.
            rawInput: {
              _toolName: 'task',
              prompt: BRIEF,
              description,
              subagentType: { unspecified: {} },
            },
          }),
        );
      }

      function startWaiting(): {
        child: FakeChild;
        events: AgentEvent[];
      } {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        home = mkdtempSync(join(tmpdir(), 'cursor-delegate-home-'));
        const { spawn, child } = fakeSpawn();
        current = child;
        const events: AgentEvent[] = [];
        new CursorAcpAdapter({
          vocabularyStore: freshVocabularyStore(),
          spawn,
          homeDir: home,
        })
          .startSession({ ...BASE }, { runScoped: true })
          .startTurn({ ...BASE }, (event) => events.push(event));
        handshake(child);
        return { child, events };
      }

      function dropStream(child: FakeChild): void {
        child.stdout.emitData(
          sessionUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: DROP },
          }),
        );
        endTurn(child);
      }

      /** The continuation prompt, sent once the first resume pause has run. */
      async function resumePrompt(child: FakeChild): Promise<string> {
        await vi.advanceTimersByTimeAsync(
          CURSOR_TRANSIENT_RESUME_DELAYS_MS[0]!,
        );
        await vi.waitFor(() => expect(wakes(child)).toHaveLength(1));
        return wakeText(wakes(child)[0]);
      }

      it('watches a sub-agent the failure cut off, instead of having it relaunched', async () => {
        const { child, events } = startWaiting();
        launchWaitedOn(child, 'toolu_wrap', 'Verify header pill wrap');
        writeTranscript('agent-wrap', [OPENING, WORKING]);
        dropStream(child);

        // Its call is answered and its block left OPEN — the request died, the
        // sub-agent did not — never closed as a step that was cut off.
        expect(events).toContainEqual({
          type: 'tool_result',
          id: 'toolu_wrap',
          name: 'Task: Verify header pill wrap',
          result: null,
          isError: false,
        });
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'subagent_info',
            id: 'toolu_wrap',
            label: 'Verify header pill wrap',
            backgroundOpen: true,
          }),
        );

        const text = await resumePrompt(child);
        expect(text).toContain('STILL RUNNING');
        expect(text).toContain('- Verify header pill wrap');
        expect(text).toContain('Do NOT launch these again');

        // The resumed request ends with the sub-agent still out: the turn
        // HOLDS for it rather than settling on a promise of results.
        child.stdout.emitData(
          stdoutLine({
            jsonrpc: '2.0',
            id: wakes(child)[0]?.id,
            result: { stopReason: 'end_turn' },
          }),
        );
        expect(events.some((event) => event.type === 'turn_complete')).toBe(
          false,
        );
        expect(events.at(-2)).toMatchObject({
          type: 'notice',
          message: expect.stringContaining(
            'Waiting for 1 background sub-agent',
          ),
        });
        expect(events.at(-1)).toEqual({ type: 'turn_held', open: 1 });

        // …and its report reaches the agent once its own record says it ended.
        writeTranscript('agent-wrap', [
          OPENING,
          WORKING,
          REPORTING,
          { type: 'turn_ended', status: 'success' },
        ]);
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
          expect(wakes(child)).toHaveLength(2);
        });
        expect(wakeText(wakes(child)[1])).toContain('REPORT-7731');
        expect(closes(events)).toEqual([
          expect.objectContaining({
            id: 'toolu_wrap',
            backgroundOutcome: 'completed',
          }),
        ]);
      });

      it('hands over the reports of sub-agents that finished after the agent’s last step', async () => {
        const { child, events } = startWaiting();
        launchWaitedOn(child, 'toolu_crumb', 'Verify parent crumb');
        writeTranscript('agent-crumb', [
          OPENING,
          REPORTING,
          { type: 'turn_ended', status: 'success' },
        ]);
        child.stdout.emitData(
          sessionUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'toolu_crumb',
            status: 'completed',
            rawOutput: { durationMs: 9_000, isBackground: false },
          }),
        );
        child.stdout.emitData(
          taskAnnouncement({
            toolCallId: 'toolu_crumb',
            description: 'Verify parent crumb',
            prompt: BRIEF,
            durationMs: 9_000,
          }),
        );
        dropStream(child);

        // A finished sub-agent is not adopted: its call returned.
        expect(
          events.some(
            (event) =>
              event.type === 'subagent_info' && event.backgroundOpen === true,
          ),
        ).toBe(false);
        // The server's checkpoint predates its result, so the resumed agent
        // would not know it ran — the report rides the continuation instead.
        const text = await resumePrompt(child);
        expect(text).toContain('finished during the interrupted request');
        expect(text).toContain('## Verify parent crumb — finished');
        expect(text).toContain('REPORT-7731');
        expect(text).toContain(transcriptPath('agent-crumb'));
        expect(text).not.toContain('STILL RUNNING');
      });

      it('does not hand over a result the agent already went on from', async () => {
        const { child } = startWaiting();
        launchWaitedOn(child, 'toolu_crumb', 'Verify parent crumb');
        writeTranscript('agent-crumb', [
          OPENING,
          REPORTING,
          { type: 'turn_ended', status: 'success' },
        ]);
        child.stdout.emitData(
          sessionUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'toolu_crumb',
            status: 'completed',
            rawOutput: { durationMs: 9_000, isBackground: false },
          }),
        );
        // A step generated FROM that result: it is in the conversation now.
        child.stdout.emitData(
          sessionUpdate({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'The crumb finding holds.' },
          }),
        );
        dropStream(child);

        const text = await resumePrompt(child);
        expect(text).not.toContain('REPORT-7731');
        expect(text).toBe(CURSOR_TRANSIENT_RESUME_PROMPT);
      });
    });
  });

  it('keeps an ordinary tool call’s output, which IS its answer', () => {
    // The other half of the rule: only a recognised delegation's result is
    // accounting. A blanket drop would empty every shell and search row.
    const { child, events } = driveTurn();
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't-1',
        title: 'Shell',
        rawInput: { _toolName: 'shell', command: 'ls' },
      }),
    );
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't-1',
        status: 'completed',
        rawOutput: { stdout: 'alpha.txt\n' },
      }),
    );

    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      result: { stdout: 'alpha.txt\n' },
    });
  });

  it('keeps `cursor/task` OFF the silently-declined list, so a refusal cannot go unnoticed', () => {
    // The list is what hid this for two milestones. A future entry for it would
    // restore exactly that: declined in protocol, no notice, no row.
    expect(CURSOR_SILENTLY_DECLINED_METHODS).not.toContain('cursor/task');
  });
});

describe('CursorAcpAdapter — sub-agent sessions', () => {
  /**
   * Every frame below is transcribed from cursor-agent 2026.10.01-e373342 with
   * `clientCapabilities._meta.subagents` declared (2026-10-05): a
   * `subagent_spawned` on the parent naming the `task` call in
   * `_meta.cursor.toolCallId`, the sub-agent's own steps under its own session
   * id, and `subagent_state_update` the moment it ends.
   */
  let home: string;
  let current: FakeChild | undefined;

  afterEach(() => {
    current?.emit('close', 0, null);
    current = undefined;
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  function start(input: Partial<AgentTurnInput> = {}): {
    child: FakeChild;
    events: AgentEvent[];
    handle: AgentTurnHandle | null;
  } {
    home = mkdtempSync(join(tmpdir(), 'cursor-subagent-home-'));
    const { spawn, child } = fakeSpawn();
    current = child;
    const events: AgentEvent[] = [];
    const handle = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
      homeDir: home,
    })
      .startSession({ ...BASE, ...input }, { runScoped: true })
      .startTurn({ ...BASE, ...input }, (event) => events.push(event));
    child.stdout.emitData(
      stdoutLine({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { subagents: {} } },
        },
      }),
    );
    child.stdout.emitData(
      stdoutLine({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } }),
    );
    return { child, events, handle };
  }

  const META = {
    cursor: { toolCallId: 'tool_A', agentId: 'agent-1', model: 'composer-2.5' },
  };

  function launch(child: FakeChild, background: boolean): void {
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: 'agent-1',
        name: 'generalPurpose',
        task: 'Run the shell command',
        capabilities: {},
        _meta: META,
      }),
    );
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool_A',
        title: 'Task: Probe sub-agent',
        kind: 'other',
        status: 'pending',
        rawInput: {
          _toolName: 'task',
          prompt: 'Run the shell command `sleep 6 && echo SUBDONE-41`.',
          description: 'Probe sub-agent',
        },
      }),
    );
    if (background) {
      child.stdout.emitData(
        sessionUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool_A',
          status: 'completed',
          rawOutput: { durationMs: 202, isBackground: true },
        }),
      );
    }
  }

  /** One update a sub-agent sent under its OWN session id. */
  function fromChild(child: FakeChild, update: Record<string, unknown>): void {
    child.stdout.emitData(
      stdoutLine({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'agent-1', update },
      }),
    );
  }

  function childWorks(child: FakeChild, report: string): void {
    fromChild(child, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Running the sleep command.' },
    });
    fromChild(child, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool_shell',
      title: '`sleep 6 && echo SUBDONE-41`',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'sleep 6 && echo SUBDONE-41' },
    });
    fromChild(child, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool_shell',
      status: 'completed',
      rawOutput: { exitCode: 0, stdout: 'SUBDONE-41\n', stderr: '' },
    });
    fromChild(child, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: report },
    });
  }

  function ends(child: FakeChild, state: string): void {
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'subagent_state_update',
        subagentSessionId: 'agent-1',
        state,
        _meta: META,
      }),
    );
  }

  function parentSays(child: FakeChild, text: string): void {
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      }),
    );
  }

  function endTurn(child: FakeChild): void {
    child.stdout.emitData(
      stdoutLine({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } }),
    );
  }

  const prompts = (child: FakeChild): Record<string, unknown>[] =>
    framesOn(child).filter((frame) => frame.method === 'session/prompt');

  it('declares sub-agent sessions under `_meta`, the only place its ACP SDK keeps', () => {
    // The bundled SDK (0.14.1) drops unknown top-level capability keys, so a
    // top-level `subagents` was measured to change nothing on the wire.
    const { child } = start();
    const init = framesOn(child).find((frame) => frame.method === 'initialize');
    const caps = (
      init?.params as { clientCapabilities: Record<string, unknown> }
    ).clientCapabilities;
    expect(caps._meta).toMatchObject({ subagents: {} });
    expect(caps).not.toHaveProperty('subagents');
  });

  it('draws a sub-agent’s own steps inside its block, never as the parent’s', () => {
    const { child, events } = start();
    launch(child, false);
    childWorks(child, 'SUBDONE-41');
    ends(child, 'completed');

    const ofChild = events.filter(
      (event) => event.parentToolUseId === 'tool_A',
    );
    expect(ofChild).toEqual([
      {
        type: 'reasoning',
        text: 'Running the sleep command.',
        parentToolUseId: 'tool_A',
      },
      expect.objectContaining({
        type: 'tool_call',
        id: 'tool_shell',
        parentToolUseId: 'tool_A',
      }),
      expect.objectContaining({
        type: 'tool_result',
        id: 'tool_shell',
        result: { exitCode: 0, stdout: 'SUBDONE-41\n', stderr: '' },
        parentToolUseId: 'tool_A',
      }),
      { type: 'text', text: 'SUBDONE-41', parentToolUseId: 'tool_A' },
    ]);
    // Nothing of the sub-agent's reaches the parent's live plane or its words.
    expect(
      events.some(
        (event) =>
          (event.type === 'text_delta' || event.type === 'reasoning_delta') &&
          event.text.includes('SUBDONE'),
      ),
    ).toBe(false);
    // And its block no longer says its steps are unavailable.
    const info = events.filter((event) => event.type === 'subagent_info');
    expect(info.length).toBeGreaterThan(0);
    expect(info.every((event) => event.stepsUnavailableReason === null)).toBe(
      true,
    );
  });

  it('closes a sub-agent’s step whose permission the user refused as an error', () => {
    const { child, events, handle } = start({ approvalMode: 'ask' });
    launch(child, false);
    fromChild(child, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool_shell',
      title: '`rm -rf build`',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'rm -rf build' },
    });
    child.stdout.emitData(
      stdoutLine({
        jsonrpc: '2.0',
        id: 9,
        method: 'session/request_permission',
        params: {
          sessionId: 'agent-1',
          toolCall: { toolCallId: 'tool_shell' },
          options: ONCE_OPTIONS,
        },
      }),
    );
    expect(handle?.respondApproval('n:9', false)).toBe(true);
    fromChild(child, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool_shell',
      status: 'completed',
    });

    expect(
      events.filter(
        (event) => event.type === 'tool_result' && event.id === 'tool_shell',
      ),
    ).toEqual([
      expect.objectContaining({
        result: REFUSED_TOOL_RESULT,
        isError: true,
        parentToolUseId: 'tool_A',
      }),
    ]);
  });

  it('names the native child session on the recovery reference of its delegate', () => {
    const { child, events } = start();
    launch(child, false);

    const info = events.filter(
      (event) => event.type === 'subagent_info' && event.id === 'tool_A',
    );
    expect(info.length).toBeGreaterThan(0);
    for (const event of info) {
      expect(event).toMatchObject({
        recovery: {
          agentKind: 'cursor-agent',
          sessionId: 's',
          toolCallId: 'tool_A',
          childSessionId: 'agent-1',
        },
      });
    }
  });

  it('drops the steps of a sub-agent it cannot place, rather than reading them as the parent’s', () => {
    const { child, events } = start();
    // Announced, but with no launching call to draw its steps under.
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: 'agent-x',
        name: 'generalPurpose',
        task: 'something',
        capabilities: {},
        _meta: {},
      }),
    );
    child.stdout.emitData(
      stdoutLine({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'agent-x',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'NOT-THE-PARENT' },
          },
        },
      }),
    );
    endTurn(child);
    expect(JSON.stringify(events)).not.toContain('NOT-THE-PARENT');
  });

  it('still reads an update under an id nothing announced as the parent’s', () => {
    // This driver has never matched an update's session id; only an
    // ANNOUNCED sub-agent is routed away, as the RFD has the announcement
    // precede the child's traffic.
    const { child, events } = start();
    child.stdout.emitData(
      stdoutLine({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'another-name',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'PARENT-WORDS' },
          },
        },
      }),
    );
    endTurn(child);
    expect(events).toContainEqual({ type: 'text', text: 'PARENT-WORDS' });
  });

  it('closes a background sub-agent the moment the agent says it ended, and lets the agent carry on itself', () => {
    const { child, events } = start();
    launch(child, true);
    parentSays(child, 'LAUNCHED-77');
    childWorks(child, 'BGDONE-77');
    ends(child, 'completed');
    // The agent's own continuation, inside the same held prompt.
    parentSays(child, 'The probe finished with BGDONE-77.');
    endTurn(child);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'tool_A',
        backgroundOpen: false,
        backgroundOutcome: 'completed',
      }),
    );
    // The agent was not prompted by geniro: it already continued on its own.
    expect(prompts(child)).toHaveLength(1);
    // Two paragraphs, not one glued at the seam.
    const parentRows = events.filter(
      (event) => event.type === 'text' && event.parentToolUseId === undefined,
    );
    expect(
      parentRows.map((event) => (event.type === 'text' ? event.text : '')),
    ).toEqual(['LAUNCHED-77', 'The probe finished with BGDONE-77.']);
    expect(events.at(-1)).toMatchObject({
      type: 'turn_complete',
      finalText: 'LAUNCHED-77\n\nThe probe finished with BGDONE-77.',
    });
  });

  it('queues a message while a background sub-agent runs, instead of cancelling it', () => {
    // Measured: a prompt sent while the turn was held for a background
    // sub-agent cancelled that sub-agent within 3ms.
    const { child, events, handle } = start();
    launch(child, true);
    childWorks(child, 'BGDONE-77');

    expect(handle?.sendUserMessage({ text: 'status?' })).toBe(false);
    expect(handle?.sendUserMessage({ text: 'and now?' })).toBe(false);
    expect(framesOn(child).map((frame) => frame.method)).not.toContain(
      'session/cancel',
    );
    // Said once, not per press.
    expect(
      events.filter(
        (event) =>
          event.type === 'notice' &&
          event.message === QUEUED_FOR_SUBAGENTS_NOTICE,
      ),
    ).toHaveLength(1);

    // Once it has ended, a message interrupts as it always did.
    ends(child, 'completed');
    expect(handle?.sendUserMessage({ text: 'status?' })).toBe(true);
    expect(framesOn(child).map((frame) => frame.method)).toContain(
      'session/cancel',
    );
  });

  describe('when the CLI goes quiet', () => {
    const QUIET_MS = 45_000;
    const thought = (child: FakeChild): void => {
      child.stdout.emitData(
        sessionUpdate({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'I will wait.' },
        }),
      );
    };

    it('writes what the agent has said, so no thinking row stands over the silence', async () => {
      vi.useFakeTimers();
      const { child, events } = start();
      thought(child);

      await vi.advanceTimersByTimeAsync(QUIET_MS);

      expect(events).toContainEqual({
        type: 'reasoning',
        text: 'I will wait.',
      });
    });

    it('leaves it open while a background sub-agent explains the silence', async () => {
      vi.useFakeTimers();
      const { child, events } = start();
      launch(child, true);
      childWorks(child, 'BGDONE-77');
      thought(child);

      await vi.advanceTimersByTimeAsync(QUIET_MS);

      expect(events).not.toContainEqual({
        type: 'reasoning',
        text: 'I will wait.',
      });
    });
  });

  it('counts the sub-agents a message would cancel, and cancels them only when told to', () => {
    const { child, events, handle } = start();
    expect(handle?.subagentsAFollowUpCancels?.()).toBe(0);
    launch(child, true);
    childWorks(child, 'BGDONE-77');
    expect(handle?.subagentsAFollowUpCancels?.()).toBe(1);

    expect(
      handle?.sendUserMessage({ text: 'now', cancelBackgroundWork: true }),
    ).toBe(true);

    expect(framesOn(child).map((frame) => frame.method)).toContain(
      'session/cancel',
    );
    expect(
      events.some(
        (event) =>
          event.type === 'notice' &&
          event.message === QUEUED_FOR_SUBAGENTS_NOTICE,
      ),
    ).toBe(false);
    // A cancel already out: nothing further is at stake.
    expect(handle?.subagentsAFollowUpCancels?.()).toBe(0);
  });

  it('accepts a late foreground ending when disconnection preceded a parent failure', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { child, events } = start();
    launch(child, false);
    ends(child, 'disconnected');
    parentSays(
      child,
      '\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)',
    );
    endTurn(child);
    const closes = () =>
      events.filter(
        (event) =>
          event.type === 'subagent_info' && event.backgroundOpen === false,
      );
    expect(closes().at(-1)).toMatchObject({
      id: 'tool_A',
      backgroundOutcome: 'untracked',
    });
    ends(child, 'completed');
    expect(
      closes().map((event) =>
        event.type === 'subagent_info' ? event.backgroundOutcome : null,
      ),
    ).toEqual(['untracked', 'completed']);
  });

  it('accepts a late foreground child ending after its parent was interrupted', () => {
    const { child, events, handle } = start();
    launch(child, false);
    expect(handle?.sendUserMessage({ text: 'work on the other task' })).toBe(
      true,
    );
    child.stdout.emitData(
      stdoutLine({
        jsonrpc: '2.0',
        id: 3,
        result: { stopReason: 'cancelled' },
      }),
    );
    const closes = () =>
      events.filter(
        (event) =>
          event.type === 'subagent_info' && event.backgroundOpen === false,
      );
    expect(closes().at(-1)).toMatchObject({
      id: 'tool_A',
      backgroundOutcome: 'untracked',
    });
    ends(child, 'completed');
    expect(
      closes().map((event) =>
        event.type === 'subagent_info' ? event.backgroundOutcome : null,
      ),
    ).toEqual(['untracked', 'completed']);
  });

  it('reports disconnection as untracked and replaces it when a completion arrives later', () => {
    const { child, events } = start();
    launch(child, true);
    ends(child, 'disconnected');
    const closes = () =>
      events.filter(
        (event) =>
          event.type === 'subagent_info' && event.backgroundOpen === false,
      );
    expect(closes().at(-1)).toMatchObject({
      id: 'tool_A',
      backgroundOutcome: 'untracked',
    });
    ends(child, 'completed');
    expect(closes().at(-1)).toMatchObject({
      id: 'tool_A',
      backgroundOutcome: 'completed',
    });
  });

  it('closes a sub-agent’s open steps when the agent says it was cancelled', () => {
    const { child, events } = start();
    launch(child, true);
    fromChild(child, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool_shell',
      title: '`sleep 40`',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'sleep 40' },
    });
    ends(child, 'cancelled');

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        id: 'tool_shell',
        isError: true,
        parentToolUseId: 'tool_A',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'tool_A',
        backgroundOutcome: 'stopped',
      }),
    );
  });

  it('hands a resume the result of a sub-agent the failed request was waiting on', async () => {
    // The agent holds a failed prompt open until its sub-agents end, so a
    // verifier cut off by a dropped stream has reported by the time the
    // failure is read — and that result is in no checkpoint the resumed
    // agent will see.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { child, events } = start();
    launch(child, false);
    childWorks(child, 'validation: refuted');
    ends(child, 'completed');
    parentSays(
      child,
      '\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)',
    );
    endTurn(child);

    expect(events).toContainEqual({
      type: 'tool_result',
      id: 'tool_A',
      name: 'Task: Probe sub-agent',
      result: null,
      isError: false,
    });
    await vi.advanceTimersByTimeAsync(CURSOR_TRANSIENT_RESUME_DELAYS_MS[0]!);
    await vi.waitFor(() => expect(prompts(child)).toHaveLength(2));
    const params = prompts(child)[1]?.params as {
      prompt: { text: string }[];
    };
    const text = params.prompt.map((block) => block.text).join('');
    expect(text).toContain('finished during the interrupted request');
    expect(text).toContain('validation: refuted');
    expect(text).not.toContain('STILL RUNNING');
  });
});

describe('CursorAcpAdapter misuse', () => {
  it('fails loudly if the stateless mapper path is ever reached', () => {
    // ACP state cannot live on the adapter (one instance serves N concurrent
    // turns), so a future refactor that drops createTurnDriver must not
    // silently fall back to a mapper that cannot work.
    class Exposed extends CursorAcpAdapter {
      // The store is a REQUIRED dependency of the real adapter, and a spec
      // subclass has to satisfy it like any other caller — see
      // `freshVocabularyStore`.
      constructor() {
        super({ vocabularyStore: freshVocabularyStore() });
      }

      callMapMessage(): unknown {
        return this['mapMessage']();
      }
    }
    expect(() => new Exposed().callMapMessage()).toThrow(
      /drives ACP through its per-turn driver/,
    );
  });

  it('keeps two interleaved turns of ONE adapter instance on separate protocol state', () => {
    // Production has exactly one CursorAcpAdapter — a default-scope Nest
    // provider, held as a single `cursor` by the team executor — serving
    // every member of a fanned-out team. State that must not cross-wire
    // (session id, the request-id counter, the stdin writer) is only
    // exercised when both turns come from the SAME instance.
    const childA = new FakeChild();
    const childB = new FakeChild();
    const queued = [childA, childB];
    const spawn: SpawnFn = () => queued.shift() as unknown as SpawnedProcess;
    const adapter = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    });
    const eventsA: AgentEvent[] = [];
    const eventsB: AgentEvent[] = [];
    adapter.start({ ...BASE, prompt: 'turn A' }, (e) => eventsA.push(e));
    adapter.start({ ...BASE, prompt: 'turn B' }, (e) => eventsB.push(e));

    // Interleaved and out of order: both turns number their requests from 1,
    // so a shared counter or a shared pending map would route B's reply into
    // A's state machine.
    childA.stdout.emitData(
      stdoutLine({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }),
    );
    childB.stdout.emitData(
      stdoutLine({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }),
    );
    childB.stdout.emitData(
      stdoutLine({ jsonrpc: '2.0', id: 2, result: { sessionId: 'sess-b' } }),
    );
    childA.stdout.emitData(
      stdoutLine({ jsonrpc: '2.0', id: 2, result: { sessionId: 'sess-a' } }),
    );

    expect(eventsA).toEqual([{ type: 'session', sessionId: 'sess-a' }]);
    expect(eventsB).toEqual([{ type: 'session', sessionId: 'sess-b' }]);
    // Each child was prompted on its OWN session with its OWN prompt — a
    // hoisted session id or stdin writer sends one turn's prompt down the
    // other turn's pipe, or names the wrong session on it.
    expect(
      framesOn(childA).find((frame) => frame.method === 'session/prompt')
        ?.params,
    ).toEqual({
      sessionId: 'sess-a',
      prompt: [{ type: 'text', text: `turn A\n\n${hostBlock(HOST_BLOCK)}` }],
    });
    expect(
      framesOn(childB).find((frame) => frame.method === 'session/prompt')
        ?.params,
    ).toEqual({
      sessionId: 'sess-b',
      prompt: [{ type: 'text', text: `turn B\n\n${hostBlock(HOST_BLOCK)}` }],
    });
  });
  describe('listModels', () => {
    /**
     * A double for the model handshake. Deliberately NEVER closes: probed on
     * cursor-agent 2026.08.04-aaa8809, `cursor-agent acp` does not exit when
     * its stdin closes, so a double that exits would settle the read through
     * the `close` path and never exercise the early settle the real CLI needs.
     */
    function fakeAcpProbe(stdout: string): {
      groupSpawnFn: typeof spawn;
      captured: { args?: readonly string[]; stdin: () => string[] };
    } {
      let child = fakeGroupChild(4242);
      const captured = {
        args: undefined as readonly string[] | undefined,
        stdin: () => child.stdinChunks,
      };
      const groupSpawnFn = ((_command: string, args: readonly string[]) => {
        captured.args = args;
        child = fakeGroupChild(4242);
        queueMicrotask(() => child.writeStdout(stdout));
        return child.child;
      }) as unknown as typeof spawn;
      return { groupSpawnFn, captured };
    }

    const SESSION_REPLY = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        sessionId: 's1',
        models: {
          currentModelId: 'composer-2.5[fast=true]',
          // BARE ids, verbatim from a 2026.08.11-e8db854 `session/new` reply
          // under the PARAMETERIZED handshake — the one the probe now sends, so
          // this is the shape it really reads. Under the old handshake the same
          // models come back as composed ids (`claude-opus-5[thinking=true,…]`),
          // and a picker built from those has every choice refused.
          availableModels: [
            { modelId: 'composer-2.5', name: 'Composer 2.5' },
            { modelId: 'claude-opus-5', name: 'Opus 5' },
            { modelId: 'gpt-5.5', name: 'GPT-5.5' },
          ],
        },
      },
    })}\n`;

    it('asks the ACP server, not the `models` subcommand', async () => {
      // Load-bearing, not stylistic: the subcommand prints a DIFFERENT id
      // namespace (`claude-opus-5-thinking-high`) and `session/set_model`
      // answers those with `-32602 Invalid model value`, so a picker built
      // from it would refuse every choice the user made.
      const { groupSpawnFn, captured } = fakeAcpProbe(SESSION_REPLY);

      await new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn,
      }).listModels({ configDir: null });

      expect(captured.args).toEqual(['acp']);
    });

    it('asks a named configuration’s account for its models', async () => {
      vi.stubEnv('CURSOR_API_KEY', 'user-exported-key-0000');
      const configDir = mkdtempSync(join(tmpdir(), 'cursor-work-spec-'));
      dirs.push(configDir);
      mkdirSync(join(configDir, '.cursor'));
      writeFileSync(
        join(configDir, '.cursor', 'auth.json'),
        JSON.stringify({ accessToken: 'work-access-token-0000' }),
      );
      const { groupSpawnFn, captured } = fakeListing(SESSION_REPLY);

      await new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn,
      }).listModels({ configDir });

      expect(captured.opts?.env?.AGENT_CLI_CREDENTIAL_STORE).toBe('memory');
      expect(captured.opts?.env?.CURSOR_AUTH_TOKEN).toBe(
        'work-access-token-0000',
      );
      expect(captured.opts?.env?.CURSOR_API_KEY).toBe('');
    });

    it('writes the handshake frames the answer depends on', async () => {
      const { groupSpawnFn, captured } = fakeAcpProbe(SESSION_REPLY);

      await new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn,
      }).listModels({ configDir: null });

      const methods = captured
        .stdin()
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { method: string }).method);
      expect(methods).toEqual(['initialize', 'session/new']);
    });

    it('reports the models the handshake offered, marked as live', async () => {
      const { groupSpawnFn } = fakeAcpProbe(SESSION_REPLY);

      await expect(
        new CursorAcpAdapter({
          vocabularyStore: freshVocabularyStore(),
          groupSpawnFn,
        }).listModels({ configDir: null }),
      ).resolves.toEqual([
        { id: 'composer-2.5', label: 'Composer 2.5', source: 'cli' },
        { id: 'claude-opus-5', label: 'Opus 5', source: 'cli' },
        { id: 'gpt-5.5', label: 'GPT-5.5', source: 'cli' },
      ]);
    });

    it('reports nothing when the CLI could not be run at all', async () => {
      const groupSpawnFn = ((_command: string, _args: readonly string[]) => {
        const child = fakeGroupChild(4242);
        queueMicrotask(() => child.close(1));
        return child.child;
      }) as unknown as typeof spawn;

      await expect(
        new CursorAcpAdapter({
          vocabularyStore: freshVocabularyStore(),
          groupSpawnFn,
        }).listModels({ configDir: null }),
      ).resolves.toEqual([]);
    });

    it('logs why the probe failed before reporting nothing', async () => {
      const groupSpawnFn = ((_command: string, _args: readonly string[]) => {
        const child = fakeGroupChild(4242);
        queueMicrotask(() => child.close(1));
        return child.child;
      }) as unknown as typeof spawn;
      const warn = vi.fn();

      await new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn,
        logger: { warn },
      }).listModels({ configDir: null });

      expect(warn).toHaveBeenCalledWith(
        'cursor-agent model probe got no answer: the CLI exited, could not start or ran past 15000 ms',
      );
    });

    it('logs a reply that listed no models', async () => {
      const { groupSpawnFn } = fakeAcpProbe(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { sessionId: 's1', models: { availableModels: [] } },
        })}\n`,
      );
      const warn = vi.fn();

      await expect(
        new CursorAcpAdapter({
          vocabularyStore: freshVocabularyStore(),
          groupSpawnFn,
          logger: { warn },
        }).listModels({ configDir: null }),
      ).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        'cursor-agent model probe: the reply listed no models',
      );
    });
  });

  describe('listModelEfforts + listModelContextWindows share one handshake', () => {
    /**
     * A `session/new` reply carrying BOTH an `effort` and a `context` config
     * option, so a listing that reads a NON-fallback answer for its own axis
     * from the SAME stdout is evidence the raw reply was actually shared —
     * not merely that two independent probes happened to agree.
     */
    const CONFIG_REPLY = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        sessionId: 's1',
        configOptions: [
          {
            id: 'effort',
            category: 'model_config',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'low' },
              { value: 'medium', name: 'medium' },
            ],
          },
          {
            id: 'context',
            category: 'model_config',
            currentValue: '300k',
            options: [
              { value: '300k', name: '300k' },
              { value: '1m', name: '1m' },
            ],
          },
        ],
      },
    })}\n`;

    /**
     * A double for the `session/new` handshake, counted through
     * `groupSpawnFn` itself — the seam `probeModelConfigOptions` actually
     * spawns through, so the count below is of REAL process-group spawns
     * rather than a proxy this spec invented. Deliberately NEVER closes, like
     * `fakeAcpProbe` above: `cursor-agent acp` does not exit on its own, so
     * `settleWhen` (not `close`) is what ends a real read.
     *
     * Each successive spawn gets the next `reply`, sticking on the last one —
     * a single-reply call therefore answers every spawn with that one reply.
     */
    function fakeAcpConfigProbe(
      firstReply: string,
      ...laterReplies: string[]
    ): {
      groupSpawnFn: typeof spawn;
      calls: () => number;
    } {
      const replies = [firstReply, ...laterReplies];
      let calls = 0;
      const groupSpawnFn = ((_command: string, _args: readonly string[]) => {
        const reply =
          replies[Math.min(calls, replies.length - 1)] ?? firstReply;
        calls += 1;
        const fake = fakeGroupChild(4242 + calls);
        queueMicrotask(() => fake.writeStdout(reply));
        return fake.child;
      }) as unknown as typeof spawn;
      return { groupSpawnFn, calls: () => calls };
    }

    /** Answers `<binary> --version` with a fixed line, through the seam `resolveBinaryVersion` reads. */
    function fakeVersion(version: () => string): typeof execFile {
      return ((
        _command: string,
        _args: readonly string[] | undefined,
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, `${version()}\n`, '');
        return {} as ChildProcess;
      }) as unknown as typeof execFile;
    }

    it('files nothing from a handshake that was running when the account changed', async () => {
      // The durable write sits INSIDE the probe, so forgetting the store before
      // the reply landed was not enough: the probe filed the previous account's
      // settings straight back afterwards, for a week. And the memory copy is
      // this adapter's own, reachable only through `forgetAccountCaches`.
      const store = freshVocabularyStore();
      const children: ReturnType<typeof fakeGroupChild>[] = [];
      const groupSpawnFn = (() => {
        // Pids past the kernel's range, so the group reap on settle signals
        // nothing real on the machine running the suite.
        const fake = fakeGroupChild(9_100_000 + children.length);
        children.push(fake);
        return fake.child;
      }) as unknown as typeof spawn;
      const VERSION = '2026.08.11-e8db854';
      const adapter = new CursorAcpAdapter({
        vocabularyStore: store,
        groupSpawnFn,
        execFileFn: fakeVersion(() => VERSION),
      });
      const spawned = async (count: number): Promise<void> => {
        while (children.length < count) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      };
      const isReply = (value: unknown): value is string =>
        typeof value === 'string';

      const before = adapter.listModelEfforts('claude-opus-5');
      await spawned(1);
      store.forget('cursor-agent');
      adapter.forgetAccountCaches();
      children[0]?.writeStdout(CONFIG_REPLY);
      await before;

      expect(
        store.read('cursor-agent', 'claude-opus-5', null, VERSION, isReply),
      ).toBeNull();
      // Nor was the memory copy kept: the next listing asks the CLI again.
      const after = adapter.listModelEfforts('claude-opus-5');
      await spawned(2);
      children[1]?.writeStdout(CONFIG_REPLY);
      await after;
      expect(children).toHaveLength(2);
    });

    it('lists every OTHER config option, minus the ones geniro already drives', async () => {
      // The subtraction, which is the whole of this listing. The reply below
      // carries the four axes this app has controls for — the session `mode`,
      // the `model` picker itself, `effort` and `context` — beside the two it
      // does not. Only the second pair may come back: a chip beside the effort
      // chip that ALSO sets the effort is two controls for one setting.
      const REPLY = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          sessionId: 's1',
          configOptions: [
            {
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              currentValue: 'agent',
              options: [
                { value: 'agent', name: 'agent' },
                { value: 'plan', name: 'plan' },
              ],
            },
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'auto-smart',
              options: [{ value: 'auto-smart', name: 'Auto' }],
            },
            {
              id: 'effort',
              name: 'Effort',
              category: 'model_config',
              currentValue: 'high',
              options: [{ value: 'high', name: 'high' }],
            },
            {
              id: 'context',
              name: 'Context',
              category: 'model_config',
              currentValue: '300k',
              options: [{ value: '300k', name: '300k' }],
            },
            {
              id: 'optimize_for',
              name: 'Optimize For',
              category: 'model_config',
              currentValue: 'balanced',
              options: [
                { value: 'intelligence', name: 'Intelligence' },
                { value: 'balanced', name: 'Balance' },
                { value: 'cost', name: 'Cost' },
              ],
            },
            // Named with NO values: an axis the agent mentioned and did not
            // enumerate, which is a picker with nothing to pick.
            { id: 'thinking', name: 'Thinking', category: 'thought_level' },
          ],
        },
      })}\n`;
      const { groupSpawnFn } = fakeAcpConfigProbe(REPLY);
      const adapter = new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn,
        execFileFn: fakeVersion(() => '2026.08.11-e8db854'),
      });

      expect(await adapter.listModelParameters('auto-smart')).toEqual({
        parameters: [
          {
            id: 'optimize_for',
            // The AGENT's own name, never a prettified id.
            label: 'Optimize For',
            values: [
              { id: 'intelligence', label: 'Intelligence' },
              { id: 'balanced', label: 'Balance' },
              { id: 'cost', label: 'Cost' },
            ],
            current: 'balanced',
          },
        ],
        unavailableReason: null,
        exact: true,
      });
    });

    it('reads the --version ONCE across several listings, through the daemon memo', async () => {
      // The version is the key every vocabulary cache is checked against, so it
      // is read BEFORE any of them can answer — which meant a cache HIT still
      // paid for a process fork. Measured at 0.54s each, three times over as
      // the settings panel asks for its three listings.
      const REPLY = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          sessionId: 's1',
          configOptions: [
            {
              id: 'optimize_for',
              name: 'Optimize For',
              category: 'model_config',
              currentValue: 'balanced',
              options: [{ value: 'balanced', name: 'Balance' }],
            },
          ],
        },
      })}\n`;
      let forks = 0;
      const { groupSpawnFn } = fakeAcpConfigProbe(REPLY, REPLY, REPLY);
      const adapter = new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn,
        execFileFn: fakeVersion(() => {
          forks += 1;
          return '2026.08.11-e8db854';
        }),
        versions: new AgentVersionService(),
      });

      // Three DIFFERENT models, so each listing genuinely re-probes and the
      // count cannot be explained by the handshake cache answering instead.
      await adapter.listModelParameters('auto-smart');
      await adapter.listModelParameters('claude-opus-5');
      await adapter.listModelParameters('gpt-5.6-sol');

      expect(forks).toBe(1);
    });

    it('still forks directly when no version service is supplied', async () => {
      // The collaborator is optional so a standalone construction works, and
      // this is the arm that keeps that honest: without it the fallback could
      // rot into a null-reference and nothing here would notice.
      const REPLY = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: { sessionId: 's1', configOptions: [] },
      })}\n`;
      let forks = 0;
      const { groupSpawnFn } = fakeAcpConfigProbe(REPLY, REPLY);
      const adapter = new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn,
        execFileFn: fakeVersion(() => {
          forks += 1;
          return '2026.08.11-e8db854';
        }),
      });

      await adapter.listModelParameters('auto-smart');
      await adapter.listModelParameters('claude-opus-5');

      expect(forks).toBe(2);
    });

    it('says a model offers nothing further, distinctly from not being asked', async () => {
      // Two empties that must not read alike: a reply that ENUMERATED options
      // and had none left after the subtraction is an answer about the model
      // (`exact`), while a probe that never settled is this CLI failing to be
      // asked. A caller that cannot tell them apart cannot decide whether to
      // re-ask.
      const ONLY_OWNED = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          sessionId: 's1',
          configOptions: [
            {
              id: 'effort',
              name: 'Effort',
              category: 'model_config',
              currentValue: 'high',
              options: [{ value: 'high', name: 'high' }],
            },
          ],
        },
      })}\n`;
      const adapter = new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn: fakeAcpConfigProbe(ONLY_OWNED).groupSpawnFn,
        execFileFn: fakeVersion(() => '2026.08.11-e8db854'),
      });

      const answered = await adapter.listModelParameters('claude-opus-5');
      expect(answered.parameters).toEqual([]);
      expect(answered.exact).toBe(true);

      // …and with NO model named there is nothing to ask about at all.
      const unasked = await adapter.listModelParameters(null);
      expect(unasked.parameters).toEqual([]);
      expect(unasked.exact).toBe(false);
      expect(unasked.unavailableReason).toContain('pick a model');
    });

    it('offers a renamed effort axis ONCE — as the effort, never also as a chip', async () => {
      // REPORTED with a screenshot of `grok-4.7`'s own settings: `Effort max`
      // (geniro's CLI-wide superset, standing in because no known spelling
      // matched) directly above `Effort High` — the model's own axis arriving
      // as a generic chip, since the CLI labels `reasoning_effort` "Effort"
      // too. The reply below is that model's, verbatim from cursor-agent
      // 2026.09.10-fd3934a on 2026-09-22.
      const GROK = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          sessionId: 's1',
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'grok-4.7',
              options: [{ value: 'grok-4.7', name: 'Grok 4.7' }],
            },
            {
              id: 'context',
              name: 'Context',
              category: 'model_config',
              currentValue: '256k',
              options: [
                { value: '256k', name: '256K' },
                { value: '500k', name: '500K' },
              ],
            },
            {
              id: 'reasoning_effort',
              name: 'Effort',
              category: 'thought_level',
              currentValue: 'high',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
                { value: 'xhigh', name: 'Extra High' },
              ],
            },
            {
              id: 'fast',
              name: 'Fast',
              category: 'model_config',
              currentValue: 'true',
              options: [
                { value: 'false', name: 'Off' },
                { value: 'true', name: 'Fast' },
              ],
            },
          ],
        },
      })}\n`;
      const adapter = new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn: fakeAcpConfigProbe(GROK).groupSpawnFn,
        execFileFn: fakeVersion(() => '2026.09.10-fd3934a'),
      });

      // The EFFORT picker gets the model's own levels, exactly — not the
      // CLI-wide superset, whose `max` this model has never had.
      const efforts = await adapter.listModelEfforts('grok-4.7');
      expect(efforts).toEqual({
        efforts: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
          { id: 'xhigh', label: 'Extra High' },
        ],
        unavailableReason: null,
        exact: true,
      });

      // …and the same option is subtracted from the generic chips, which is
      // the duplicate row itself.
      const parameters = await adapter.listModelParameters('grok-4.7');
      expect(parameters.parameters.map((p) => p.id)).toEqual(['fast']);
    });

    it('performs exactly ONE handshake probe for a cold model asked both ways', async () => {
      const { groupSpawnFn, calls } = fakeAcpConfigProbe(CONFIG_REPLY);
      const adapter = new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn,
        execFileFn: fakeVersion(() => '2026.08.11-e8db854'),
      });

      const efforts = await adapter.listModelEfforts('claude-opus-5');
      const windows = await adapter.listModelContextWindows('claude-opus-5');

      // Each listing reads its OWN axis out of the one reply above — proof
      // the second call answered from the cache rather than from a fallback
      // that would also look plausible on its own.
      expect(efforts).toEqual({
        efforts: [
          { id: 'low', label: 'low' },
          { id: 'medium', label: 'medium' },
        ],
        unavailableReason: null,
        exact: true,
      });
      expect(windows).toEqual({
        windows: [
          { id: '300k', label: '300k' },
          { id: '1m', label: '1m' },
        ],
        unavailableReason: null,
        unavailableKind: null,
        exact: true,
      });
      // The assertion that fails the moment the shared cache is reverted: two
      // listings for the same cold model used to spawn their own `cursor-agent
      // acp` process group each.
      expect(calls()).toBe(1);
    });

    it('re-probes once the CLI binary version changes under the cache', async () => {
      const secondReply = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          sessionId: 's2',
          configOptions: [
            {
              id: 'effort',
              category: 'model_config',
              currentValue: 'high',
              options: [{ value: 'high', name: 'high' }],
            },
          ],
        },
      })}\n`;
      // The FIRST spawn gets the cold reply; every spawn after it (there
      // should be exactly one more) gets the post-upgrade reply.
      const { groupSpawnFn, calls } = fakeAcpConfigProbe(
        CONFIG_REPLY,
        secondReply,
      );
      let version = '2026.08.11-e8db854';
      const adapter = new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn,
        execFileFn: fakeVersion(() => version),
      });

      const before = await adapter.listModelEfforts('claude-opus-5');
      expect(before.efforts.map((e) => e.id)).toEqual(['low', 'medium']);
      expect(calls()).toBe(1);

      // The CLI itself upgraded under the running daemon — the exact case the
      // version check exists for. Reusing the version-1 entry here is the
      // failure this pins: a chat left open across an upgrade would otherwise
      // go on being told the OLD binary's vocabulary for the rest of the
      // 10-minute TTL.
      version = '2026.08.19-ffaa123';
      const after = await adapter.listModelEfforts('claude-opus-5');

      expect(after.efforts.map((e) => e.id)).toEqual(['high']);
      expect(calls()).toBe(2);
    });
  });

  describe('setMcpServerEnabled', () => {
    /**
     * Answers the toggle subcommand, capturing its argv and cwd.
     *
     * `execFileFn`, not `groupSpawnFn`: neither `mcp enable` nor `mcp disable`
     * dials anything, so this one deliberately does NOT take the process-group
     * path the listing beside it needs.
     */
    function fakeToggle(ok: boolean): {
      execFileFn: typeof execFile;
      captured: { args?: readonly string[]; cwd?: string };
    } {
      const captured: { args?: readonly string[]; cwd?: string } = {};
      const execFileFn = ((
        _cmd: string,
        args: readonly string[],
        opts: { cwd?: string },
        cb: (err: Error | null, out: string) => void,
      ) => {
        captured.args = args;
        captured.cwd = opts.cwd;
        // A non-zero exit reaches `execFile` as an error argument, which
        // `runCommand` turns into the null stdout this adapter reads as refusal.
        cb(ok ? null : new Error('exit 1'), ok ? 'done\n' : '');
        return {} as ChildProcess;
      }) as unknown as typeof execFile;
      return { execFileFn, captured };
    }

    it('switches a server OFF in the folder it was given', async () => {
      // The cwd IS the scoping mechanism: the CLI resolves its own per-project
      // state from `process.cwd()` (git root, else the folder), so passing it is
      // the whole reason one folder's switch is not another's. Drop the cwd and
      // every toggle would land on whatever directory the daemon was started in.
      const { execFileFn, captured } = fakeToggle(true);

      await new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        execFileFn,
      }).setMcpServerEnabled('/proj', 'figma', false);

      expect(captured.args).toEqual(['mcp', 'disable', 'figma']);
      expect(captured.cwd).toBe('/proj');
    });

    it('switches a server ON through `mcp enable`, which also approves it', async () => {
      // Not merely un-disabling: the CLI's own toggle is `addApproval` then
      // `removeDisabledServer` (its TUI handler, `6260.index.js`), and a server
      // that is un-disabled but unapproved is still prompted for. `enable` is
      // what makes the switch mean the same thing here as in the user's Cursor.
      const { execFileFn, captured } = fakeToggle(true);

      await new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        execFileFn,
      }).setMcpServerEnabled('/proj', 'figma', true);

      expect(captured.args).toEqual(['mcp', 'enable', 'figma']);
    });

    it('REJECTS when the CLI refused, instead of reporting a switch that never moved', async () => {
      // `mcp enable` exits 1 for a server no config defines (measured). Resolving
      // there would move the switch in the panel over a CLI that changed nothing
      // — the silent no-op this whole feature is written to avoid.
      const { execFileFn } = fakeToggle(false);

      await expect(
        new CursorAcpAdapter({
          vocabularyStore: freshVocabularyStore(),
          execFileFn,
        }).setMcpServerEnabled('/proj', 'nope', true),
      ).rejects.toThrow(/refused to switch/);
    });

    it('hands its child to onSpawn, so the daemon can reap it', async () => {
      // Every child the daemon starts must be registerable; this adapter's
      // toggle is the one that spawns a process where claude's edits a file.
      let handed = 0;
      const { execFileFn } = fakeToggle(true);

      await new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        execFileFn,
      }).setMcpServerEnabled('/proj', 'figma', false, {
        onSpawn: () => (handed += 1),
      });

      expect(handed).toBe(1);
    });
  });

  describe('listMcpServers', () => {
    it('asks the CLI in the folder it was given, in its own process group', async () => {
      const { groupSpawnFn, captured } = fakeListing('probe: ready\n');

      await new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn,
      }).listMcpServers({
        cwd: '/proj',
      });

      expect(captured.args).toEqual(['mcp', 'list']);
      // The folder IS the question: `.cursor/mcp.json` is visible only from
      // its own directory, so a listing taken elsewhere is confidently wrong.
      expect(captured.opts?.cwd).toBe('/proj');
      // The command health-checks, which launches the user's own stdio
      // servers as children — killing only the CLI would strand them.
      expect(captured.opts?.detached).toBe(true);
    });

    it("carries the user's inherited key, so the listing is not signed out", async () => {
      // `buildEnv` is reached from start() alone, so utility reads used to run
      // unauthenticated while turns worked: an env-var-only account saw an empty
      // MCP panel, which reads as "this folder has no servers" rather than "we
      // could not ask". `utilityEnv` is what closes that. Delete the override
      // and this fails.
      process.env.CURSOR_API_KEY = 'ck-user-own';
      const { groupSpawnFn, captured } = fakeListing('probe: ready\n');

      await new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn,
      }).listMcpServers({
        cwd: '/proj',
      });

      expect(captured.opts?.env?.CURSOR_API_KEY).toBe('ck-user-own');
    });

    it('reports the servers the CLI listed', async () => {
      const { groupSpawnFn } = fakeListing(
        'probe-good: ready\nprobe-broken: Error: Connection failed\n',
      );

      await expect(
        new CursorAcpAdapter({
          vocabularyStore: freshVocabularyStore(),
          groupSpawnFn,
        }).listMcpServers({ cwd: '/proj' }),
      ).resolves.toEqual({
        ok: true,
        servers: [
          {
            name: 'probe-good',
            target: null,
            transport: null,
            status: 'connected',
            detail: null,
          },
          {
            name: 'probe-broken',
            target: null,
            transport: null,
            status: 'failed',
            detail: 'Connection failed',
          },
        ],
      });
    });

    it('reports an empty folder as an EMPTY listing, not a failure', async () => {
      const { groupSpawnFn } = fakeListing(
        'No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)\n',
      );

      await expect(
        new CursorAcpAdapter({
          vocabularyStore: freshVocabularyStore(),
          groupSpawnFn,
        }).listMcpServers({ cwd: '/proj' }),
      ).resolves.toEqual({ ok: true, servers: [] });
    });

    it('reports a command that could not be run as a FAILURE, never as empty', async () => {
      // null stdout is the missing binary / non-zero exit / deadline signal.
      // An `ok: true, servers: []` here would be cached and shown as "no
      // servers" — a lie about the user's configuration for as long as the
      // entry lives.
      //
      // `process.kill` is mocked because the error path reaps the group: with
      // the fake's invented pid 4242 this spec would otherwise SIGKILL
      // whatever process group owns that pid on the machine running it.
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((): true => true);
      try {
        const { groupSpawnFn } = fakeListing(null);

        await expect(
          new CursorAcpAdapter({
            vocabularyStore: freshVocabularyStore(),
            groupSpawnFn,
          }).listMcpServers({
            cwd: '/proj',
          }),
        ).resolves.toEqual({
          ok: false,
          reason: expect.stringContaining('did not answer'),
        });
      } finally {
        killSpy.mockRestore();
      }
    });

    it('reports output with no rows in it at all as a FAILURE, not an empty folder', async () => {
      // Reached when NOTHING in the output is shaped like a row and the CLI
      // did not print its empty-folder sentence either. Without this branch
      // that is indistinguishable from an empty folder and the panel would
      // confidently say "No servers".
      const { groupSpawnFn } = fakeListing('something went sideways\n');

      await expect(
        new CursorAcpAdapter({
          vocabularyStore: freshVocabularyStore(),
          groupSpawnFn,
        }).listMcpServers({ cwd: '/proj' }),
      ).resolves.toEqual({
        ok: false,
        reason: expect.stringContaining('format may have changed'),
      });
    });

    it('does not read the empty-folder sentence out of the MIDDLE of a row', async () => {
      // The sentence is ordinary English. Searched across the whole buffer, a
      // server whose status wording merely contains it would satisfy the empty
      // check — turning "we could not read this" into the one claim the output
      // does not support: that the folder has no servers.
      const { groupSpawnFn } = fakeListing(
        'weird-srv: No MCP servers configured are approved yet\n',
      );

      const result = await new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn,
      }).listMcpServers({
        cwd: '/proj',
      });

      expect(result.ok && result.servers.map((s) => s.name)).toEqual([
        'weird-srv',
      ]);
    });

    it('asks for the process-group reap when the command answers', async () => {
      // The health check launches the user's own MCP servers as children; one
      // that ignores stdin EOF outlives the CLI, and once the CLI exits the
      // registry has dropped the only handle that could reach it.
      //
      // The reap now genuinely lands: the group path spawns `detached`, so
      // the negative pid names a group that exists. See the twin case in
      // `agent-adapter.spec.ts`, which pins the spawn options themselves.
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((): true => true);
      try {
        const { groupSpawnFn } = fakeListing('probe: ready\n');

        await new CursorAcpAdapter({
          vocabularyStore: freshVocabularyStore(),
          groupSpawnFn,
        }).listMcpServers({
          cwd: '/proj',
        });

        expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
      } finally {
        killSpy.mockRestore();
      }
    });

    it('never answers with a confident listing that omits a row it could not read', async () => {
      // The unreadable answer above only fires when EVERY row drops, and a
      // PARTLY reworded listing is the likelier release: one server carries a
      // wording this vocabulary does not have while the rest still read. If
      // the unreadable row is dropped, the result is no longer empty, the
      // three-way split never reaches its third arm, and the listing goes out
      // as `ok: true` — so the panel states, as fact, that `linear` is the
      // only server in a folder that has two. `AgentMcpService` caches only
      // `ok` results, so that answer then stands for the whole TTL.
      const { groupSpawnFn } = fakeListing(
        'linear: ready\nsentry: awaiting-auth\n',
      );

      const result = await new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        groupSpawnFn,
      }).listMcpServers({
        cwd: '/proj',
      });
      const answer = result.ok
        ? result.servers.map((server) => server.name)
        : result.reason;

      // Either honest answer passes: reporting the output as unreadable, or
      // keeping `sentry` with its health unstated the way the claude parser
      // does. Naming `linear` alone is the one answer that denies a server
      // the CLI printed.
      expect(answer).not.toEqual(['linear']);
    });
  });

  describe('bringing a conversation across into geniro’s own store', () => {
    /** A user profile holding one session dir, plus geniro's empty store. */
    function stores(): { home: string; store: string; source: string } {
      const home = mkdtempSync(join(tmpdir(), 'cursor-home-'));
      const store = mkdtempSync(join(tmpdir(), 'cursor-store-'));
      dirs.push(home, store);
      const source = join(
        home,
        CURSOR_HOME_DIR_NAME,
        CURSOR_ACP_SESSIONS_DIR_NAME,
        'sess-1',
      );
      mkdirSync(source, { recursive: true });
      return { home, store, source };
    }

    function importSession(home: string, store: string): Promise<void> {
      return new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        homeDir: home,
        sessionStoreDir: store,
      }).prepareSessionImport({
        sessionId: 'sess-1',
        configDir: null,
        cwd: home,
      });
    }

    it('leaves NOTHING at the destination when the copy dies partway', async () => {
      // The defect this pins. The destination is guarded by an `existsSync`
      // early return, so a copy that failed halfway used to leave a populated
      // directory every LATER import short-circuits onto — `session/load` then
      // replays a truncated store and that conversation's history is gone for
      // good, with a notice as the only trace.
      const { home, store, source } = stores();
      writeFileSync(join(source, 'store.db'), 'the whole conversation');
      // An entry `cp` REFUSES to copy, so it throws mid-walk. Which entry it
      // reaches first does not matter — either way the copy is incomplete when
      // it fails.
      //
      // A unix socket rather than an unreadable directory, and the difference
      // is the whole reason this reads oddly: a permission bit does not
      // restrict uid 0, so a `chmod 0o000` version of this passes SILENTLY
      // whenever the suite runs as root — the copy succeeds and the rejection
      // this asserts never happens. `ERR_FS_CP_SOCKET` is refused for every
      // user, so the failure is one the test can actually rely on.
      const blobs = join(source, 'blobs');
      mkdirSync(blobs);
      writeFileSync(join(blobs, 'blob-1'), 'x');
      // BOUND on a short path, then MOVED into place. macOS caps a unix
      // socket path at 104 bytes (`sun_path`) and `os.tmpdir()` is
      // `/var/folders/…` there, which puts `…/blobs/live.sock` at 111 —
      // measured, not estimated. `listen` then never calls its callback, so
      // this case TIMED OUT rather than failing: red on every Mac, green on
      // Linux CI, where `/tmp` leaves the same path at 67.
      //
      // Renaming is sound because what `fs.cp` refuses is the inode's TYPE —
      // `ERR_FS_CP_SOCKET` is decided by `isSocket()`, not by whether anything
      // is still listening on the path it was bound at.
      const socketDir = mkdtempSync(join(tmpdir(), 'sock-'));
      dirs.push(socketDir);
      const bound = join(socketDir, 's');
      const uncopyable = createServer();
      await new Promise<void>((resolve) => {
        uncopyable.listen(bound, resolve);
      });
      renameSync(bound, join(blobs, 'live.sock'));

      try {
        await expect(importSession(home, store)).rejects.toThrow();

        expect(existsSync(join(store, 'sess-1'))).toBe(false);
        // And no staging litter either — a `.sess-1.<pid>.<n>.tmp` left behind
        // would accumulate one directory per failed import.
        expect(readdirSync(store)).toEqual([]);
      } finally {
        await new Promise<void>((resolve) => {
          uncopyable.close(() => resolve());
        });
        // `close` does not unlink the socket file, and the retry below has to
        // find a source it can copy whole.
        rmSync(join(blobs, 'live.sock'), { force: true });
      }

      // Now that the source can be read, the SAME id imports whole — which the
      // early return would have refused had the partial copy survived.
      await importSession(home, store);
      expect(readFileSync(join(store, 'sess-1', 'store.db'), 'utf8')).toBe(
        'the whole conversation',
      );
      expect(existsSync(join(store, 'sess-1', 'blobs', 'blob-1'))).toBe(true);
    });

    it('leaves a session already in the store alone', async () => {
      // The same id can be imported twice, and the second must not put a stale
      // copy over the turns this app has since added to it.
      const { home, store, source } = stores();
      writeFileSync(join(source, 'store.db'), 'as it was in the user profile');
      const destination = join(store, 'sess-1');
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, 'store.db'), 'with geniro’s turns in it');

      await importSession(home, store);

      expect(readFileSync(join(destination, 'store.db'), 'utf8')).toBe(
        'with geniro’s turns in it',
      );
    });

    it('refuses a session the user profile does not hold', async () => {
      const { home, store } = stores();
      rmSync(join(home, CURSOR_HOME_DIR_NAME, CURSOR_ACP_SESSIONS_DIR_NAME), {
        recursive: true,
        force: true,
      });

      await expect(importSession(home, store)).rejects.toThrow(
        CURSOR_SESSION_MISSING_MESSAGE,
      );
      expect(existsSync(join(store, 'sess-1'))).toBe(false);
    });

    it('keeps a session id carrying a separator inside the store it names', async () => {
      // The id is JOINED into two paths here, and it arrives over HTTP:
      // `POST /v1/chats` validates `resumeSessionId` as `z.string().min(1)`
      // and nothing else. The claude half of this same feature refuses a
      // separator outright — `findSessionFile` compares the assembled name
      // against its own `basename` — so an id that reaches a path is a case
      // this feature has already decided about once.
      //
      // A `..` walks BOTH ends of the copy out of the directories they name:
      // the source out of the CLI's `acp-sessions`, and the destination out of
      // geniro's session store, into whatever sits beside it.
      const home = mkdtempSync(join(tmpdir(), 'cursor-home-'));
      const beside = mkdtempSync(join(tmpdir(), 'cursor-beside-'));
      dirs.push(home, beside);
      const store = join(beside, 'cursor-sessions');
      // Something of the user's under `~/.cursor` that is NOT one of the CLI's
      // ACP conversations, and so is not this app's to move anywhere.
      const stray = join(home, CURSOR_HOME_DIR_NAME, 'not-a-session');
      mkdirSync(stray, { recursive: true });
      writeFileSync(join(stray, 'private'), 'never asked to be copied');

      await new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        homeDir: home,
        sessionStoreDir: store,
      })
        .prepareSessionImport({
          sessionId: '../not-a-session',
          configDir: null,
          cwd: home,
        })
        // Refusing and doing nothing are both correct answers; landing the
        // copy outside the store is the one that is not.
        .catch(() => undefined);

      expect(existsSync(join(beside, 'not-a-session', 'private'))).toBe(false);
      expect(existsSync(join(beside, 'not-a-session'))).toBe(false);

      // And the ordinary id still imports, so the guard above is a guard and
      // not the method having stopped working.
      const source = join(
        home,
        CURSOR_HOME_DIR_NAME,
        CURSOR_ACP_SESSIONS_DIR_NAME,
        'sess-1',
      );
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, 'store.db'), 'the whole conversation');
      await importSession(home, store);
      expect(readFileSync(join(store, 'sess-1', 'store.db'), 'utf8')).toBe(
        'the whole conversation',
      );
    });
  });
});

describe('CursorAcpAdapter session title', () => {
  /** A session directory in the store, optionally carrying a meta header. */
  function seedSession(meta: string | null): {
    sessionStoreDir: string;
    sessionId: string;
  } {
    const sessionStoreDir = mkdtempSync(join(tmpdir(), 'cursor-title-spec-'));
    dirs.push(sessionStoreDir);
    const sessionId = 'a1b2c3d4-0000-4000-8000-000000000001';
    mkdirSync(join(sessionStoreDir, sessionId), { recursive: true });
    if (meta !== null) {
      writeFileSync(join(sessionStoreDir, sessionId, 'meta.json'), meta);
    }
    return { sessionStoreDir, sessionId };
  }

  it('answers with the agent’s own title, and spawns nothing to get it', async () => {
    const { spawn, captured } = fakeSpawn();
    const { sessionStoreDir, sessionId } = seedSession(
      '{"schemaVersion":1,"title":"Markdown Display Info"}',
    );

    const title = await new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
      sessionStoreDir,
    }).readSessionTitle(sessionId);

    // Both halves, or the name overstates what is asserted: the title really
    // came back, AND no `cursor-agent acp` process was started to fetch a
    // string the app's own turns already wrote.
    expect(title).toBe('Markdown Display Info');
    expect(captured.args).toBeUndefined();
  });

  it('answers null before the agent has titled the conversation', async () => {
    const { sessionStoreDir, sessionId } = seedSession(
      '{"schemaVersion":1,"cwd":"/w"}',
    );

    await expect(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        sessionStoreDir,
      }).readSessionTitle(sessionId),
    ).resolves.toBeNull();
  });

  it('answers null for a session with no store on disk yet', async () => {
    const { sessionStoreDir } = seedSession(null);

    await expect(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        sessionStoreDir,
      }).readSessionTitle('a1b2c3d4-0000-4000-8000-00000000dead'),
    ).resolves.toBeNull();
  });

  it('refuses a bare .. rather than reading one directory up', async () => {
    // `basename('..') === '..'`, so the separator check alone admits it — and
    // this sink joins the id as a DIRECTORY component, which is what turns that
    // into a real escape. The header is planted exactly where the traversal
    // lands, so the guard's absence returns it instead of null.
    const parent = mkdtempSync(join(tmpdir(), 'cursor-title-dotdot-'));
    dirs.push(parent);
    const sessionStoreDir = join(parent, 'store');
    mkdirSync(sessionStoreDir, { recursive: true });
    writeFileSync(
      join(parent, 'meta.json'),
      '{"schemaVersion":1,"title":"One Directory Up"}',
    );

    await expect(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        sessionStoreDir,
      }).readSessionTitle('..'),
    ).resolves.toBeNull();
  });

  it('refuses a session id carrying a separator rather than joining it', async () => {
    // The id reaches a PATH here, and it arrives over HTTP — the same guard
    // `prepareSessionImport` applies for the same reason. The header is planted
    // where the traversal WOULD land, so dropping the guard makes this case
    // return that title instead of null: without it the assertion is satisfied
    // by the file merely being absent, which proves nothing.
    const parent = mkdtempSync(join(tmpdir(), 'cursor-title-escape-'));
    dirs.push(parent);
    const sessionStoreDir = join(parent, 'store');
    mkdirSync(sessionStoreDir, { recursive: true });
    mkdirSync(join(parent, 'outside'), { recursive: true });
    writeFileSync(
      join(parent, 'outside', 'meta.json'),
      '{"schemaVersion":1,"title":"Reached By Traversal"}',
    );

    await expect(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        sessionStoreDir,
      }).readSessionTitle(join('..', 'outside')),
    ).resolves.toBeNull();
  });
});

describe('CursorAcpAdapter — plugin servers the app loads and a turn does not', () => {
  /** One cached plugin under `~/.cursor/plugins`, with the manifest shape given. */
  function plugin(
    home: string,
    name: string,
    manifest: readonly string[],
    servers: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): string {
    const dir = join(
      home,
      CURSOR_HOME_DIR_NAME,
      'plugins',
      'cache',
      'publisher',
      name,
      'v1',
    );
    const manifestPath = join(dir, ...manifest);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({ name, mcpServers: './mcp.json', ...extra }),
    );
    // The pointer is written relative to the PLUGIN, not to the manifest — so
    // this sits at the plugin root whichever shape the manifest took.
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({ mcpServers: servers }),
    );
    writeFileSync(join(dir, '.cache-complete'), '');
    return dir;
  }

  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-plugins-'));
    dirs.push(dir);
    return dir;
  }

  const adapterAt = (homeDir: string): CursorAcpAdapter =>
    new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore(), homeDir });

  /** The datadog plugin as it ships, its required domain declared. */
  function datadog(homeDir: string): string {
    return plugin(
      homeDir,
      'datadog',
      ['.cursor-plugin', 'plugin.json'],
      {
        datadog: {
          url: 'https://${DD_MCP_DOMAIN:-not-setup}/v1/mcp',
          headers: {
            DD_API_KEY: '${DD_API_KEY}',
            'X-Referrer': 'cursor-plugin',
          },
        },
      },
      {
        variables: {
          properties: {
            DD_MCP_DOMAIN: { enum: ['mcp.datadoghq.com', 'mcp.datadoghq.eu'] },
            DD_API_KEY: {},
          },
          required: ['DD_MCP_DOMAIN'],
        },
      },
    );
  }

  const userConfig = (homeDir: string): string =>
    join(homeDir, CURSOR_HOME_DIR_NAME, 'mcp.json');

  it('lists a plugin whatever manifest shape it ships', async () => {
    // The skills walk accepts three manifest shapes, so a reader accepting one
    // would let a plugin contribute skills while its servers went unlisted.
    const dir = home();
    plugin(dir, 'cursor-shaped', ['.cursor-plugin', 'plugin.json'], {
      alpha: { url: 'https://a' },
    });
    plugin(dir, 'claude-shaped', ['.claude-plugin', 'plugin.json'], {
      beta: { url: 'https://b' },
    });
    plugin(dir, 'bare-shaped', ['plugin.json'], {
      gamma: { url: 'https://c' },
    });

    const facts = await adapterAt(dir).readMcpFolderFacts(dir);

    expect(
      facts.plugins.flatMap((p) => p.servers.map((s) => s.id)).sort(),
    ).toEqual([
      'plugin-bare-shaped-gamma',
      'plugin-claude-shaped-beta',
      'plugin-cursor-shaped-alpha',
    ]);
    expect(facts.interactiveOnlyNote).toBe(CURSOR_PLUGIN_NOTE);
  });

  it('never offers a credential as a variable to fill in', async () => {
    const dir = home();
    datadog(dir);

    const [listed] = (await adapterAt(dir).readMcpFolderFacts(dir)).plugins;

    expect(listed?.variables.map((v) => v.name)).toEqual(['DD_MCP_DOMAIN']);
  });

  it('says nothing at all when no plugin declares a server', async () => {
    const dir = home();

    const facts = await adapterAt(dir).readMcpFolderFacts(dir);

    expect(facts.interactiveOnlyNote).toBeNull();
    expect(facts.plugins).toEqual([]);
  });

  it('copies a server into ~/.cursor/mcp.json beside the user’s own, ready to sign in to', async () => {
    const dir = home();
    datadog(dir);
    mkdirSync(join(dir, CURSOR_HOME_DIR_NAME), { recursive: true });
    writeFileSync(
      userConfig(dir),
      JSON.stringify({
        other: 1,
        mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } },
      }),
    );
    const adapter = adapterAt(dir);

    await expect(
      adapter.copyPluginMcpServer({
        cwd: dir,
        configDir: null,
        plugin: 'datadog',
        server: 'datadog',
        variables: { DD_MCP_DOMAIN: 'mcp.datadoghq.eu' },
      }),
    ).resolves.toEqual({ ok: true, name: 'datadog', changed: true });

    expect(JSON.parse(readFileSync(userConfig(dir), 'utf8'))).toEqual({
      other: 1,
      mcpServers: {
        linear: { url: 'https://mcp.linear.app/mcp' },
        // The key header is dropped, so the server asks for a sign-in rather
        // than receiving an empty key.
        datadog: {
          url: 'https://mcp.datadoghq.eu/v1/mcp',
          headers: { 'X-Referrer': 'cursor-plugin' },
        },
      },
    });
    // The listing now names the entry carrying it.
    const [listed] = (await adapter.readMcpFolderFacts(dir)).plugins;
    expect(listed?.servers.at(0)?.copiedAs).toBe('datadog');
  });

  it('reads a folder’s plugins once per window, and again once the cache is cleared', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const dir = home();
      datadog(dir);
      const adapter = adapterAt(dir);
      const names = async (): Promise<string[]> =>
        (await adapter.readMcpFolderFacts(dir)).plugins.map((p) => p.name);
      expect(await names()).toEqual(['datadog']);

      plugin(dir, 'linear', ['plugin.json'], {
        linear: { url: 'https://mcp.linear.app/mcp' },
      });
      // A listing inside the window is answered from the scan already taken;
      // a copy reads the plugins fresh, since it acts on what is there now.
      expect(await names()).toEqual(['datadog']);
      await expect(
        adapter.copyPluginMcpServer({
          cwd: dir,
          configDir: null,
          plugin: 'linear',
          server: 'linear',
          variables: {},
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(adapter.clearCaches()).toBeGreaterThan(0);
      expect((await names()).sort()).toEqual(['datadog', 'linear']);

      plugin(dir, 'github', ['plugin.json'], {
        github: { url: 'https://api.githubcopilot.com/mcp' },
      });
      vi.advanceTimersByTime(CURSOR_PLUGIN_SCAN_TTL_MS);
      expect((await names()).sort()).toEqual(['datadog', 'github', 'linear']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates the file owner-only when there was none, and a repeat is a no-op', async () => {
    const dir = home();
    datadog(dir);
    const adapter = adapterAt(dir);
    const input = {
      cwd: dir,
      configDir: null,
      plugin: 'datadog',
      server: 'datadog',
      variables: { DD_MCP_DOMAIN: 'mcp.datadoghq.com' },
    };

    await expect(adapter.copyPluginMcpServer(input)).resolves.toMatchObject({
      changed: true,
    });
    expect(lstatSync(userConfig(dir)).mode & 0o777).toBe(0o600);
    await expect(adapter.copyPluginMcpServer(input)).resolves.toEqual({
      ok: true,
      name: 'datadog',
      changed: false,
    });
  });

  it('refuses a name the user already uses for something else, leaving the file alone', async () => {
    const dir = home();
    datadog(dir);
    mkdirSync(join(dir, CURSOR_HOME_DIR_NAME), { recursive: true });
    const before = JSON.stringify({
      mcpServers: { datadog: { url: 'https://mine' } },
    });
    writeFileSync(userConfig(dir), before);

    const result = await adapterAt(dir).copyPluginMcpServer({
      cwd: dir,
      configDir: null,
      plugin: 'datadog',
      server: 'datadog',
      variables: { DD_MCP_DOMAIN: 'mcp.datadoghq.com' },
    });

    expect(result).toMatchObject({ ok: false });
    expect(readFileSync(userConfig(dir), 'utf8')).toBe(before);
  });

  it('fills the plugin’s own directory into a command that names it', async () => {
    const dir = home();
    plugin(dir, 'rooted', ['plugin.json'], {
      rooted: { command: '${CLAUDE_PLUGIN_ROOT}/bin/run' },
    });

    const result = await adapterAt(dir).copyPluginMcpServer({
      cwd: dir,
      configDir: null,
      plugin: 'rooted',
      server: 'rooted',
      variables: {},
    });

    expect(result).toMatchObject({ ok: true });
    const written = JSON.parse(readFileSync(userConfig(dir), 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(written.mcpServers.rooted?.command).toMatch(
      new RegExp(
        `${['publisher', 'rooted', 'v1', 'bin', 'run'].join('[\\\\/]')}$`,
      ),
    );
  });

  it('copies a server whose name an object inherits', async () => {
    const dir = home();
    plugin(dir, 'odd', ['plugin.json'], {
      constructor: { url: 'https://odd' },
    });

    await expect(
      adapterAt(dir).copyPluginMcpServer({
        cwd: dir,
        configDir: null,
        plugin: 'odd',
        server: 'constructor',
        variables: {},
      }),
    ).resolves.toEqual({ ok: true, name: 'constructor', changed: true });
  });

  it('refuses to rewrite a config it cannot parse', async () => {
    const dir = home();
    datadog(dir);
    mkdirSync(join(dir, CURSOR_HOME_DIR_NAME), { recursive: true });
    writeFileSync(userConfig(dir), '{ "mcpServers": { broken');

    const result = await adapterAt(dir).copyPluginMcpServer({
      cwd: dir,
      configDir: null,
      plugin: 'datadog',
      server: 'datadog',
      variables: { DD_MCP_DOMAIN: 'mcp.datadoghq.com' },
    });

    expect(result).toMatchObject({ ok: false });
    expect(readFileSync(userConfig(dir), 'utf8')).toBe(
      '{ "mcpServers": { broken',
    );
  });

  it('keeps both servers when two copies land at the same moment', async () => {
    // Two windows (or the desktop and a paired phone) pressing Add together:
    // each reads the file before the other has written it.
    const dir = home();
    plugin(dir, 'alpha', ['plugin.json'], { alpha: { url: 'https://a' } });
    plugin(dir, 'beta', ['plugin.json'], { beta: { url: 'https://b' } });
    const adapter = adapterAt(dir);
    const copy = (name: string) =>
      adapter.copyPluginMcpServer({
        cwd: dir,
        configDir: null,
        plugin: name,
        server: name,
        variables: {},
      });

    await Promise.all([copy('alpha'), copy('beta')]);

    expect(
      Object.keys(
        (
          JSON.parse(readFileSync(userConfig(dir), 'utf8')) as {
            mcpServers: Record<string, unknown>;
          }
        ).mcpServers,
      ).sort(),
    ).toEqual(['alpha', 'beta']);
  });

  it('refuses a config of the wrong shape, and a server no plugin declares, leaving the file as it was', async () => {
    const dir = home();
    datadog(dir);
    mkdirSync(join(dir, CURSOR_HOME_DIR_NAME), { recursive: true });
    const copy = (plugin = 'datadog') =>
      adapterAt(dir).copyPluginMcpServer({
        cwd: dir,
        configDir: null,
        plugin,
        server: 'datadog',
        variables: { DD_MCP_DOMAIN: 'mcp.datadoghq.com' },
      });

    for (const [content, reason] of [
      ['[]', 'is not a JSON object'],
      ['{"mcpServers":[1]}', 'has an mcpServers that is not an object'],
    ] as const) {
      writeFileSync(userConfig(dir), content);
      const result = await copy();
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.reason).toContain(reason);
      expect(readFileSync(userConfig(dir), 'utf8')).toBe(content);
    }
    writeFileSync(userConfig(dir), '{}');
    await expect(copy('nope')).resolves.toEqual({
      ok: false,
      reason: 'no installed plugin nope declares a server named datadog',
    });
    expect(readFileSync(userConfig(dir), 'utf8')).toBe('{}');
  });

  it('refuses a config it cannot read rather than writing over it', async () => {
    // Read as empty, an unreadable file would be renamed over — taking every
    // server the user has with it.
    const dir = home();
    datadog(dir);
    mkdirSync(join(dir, CURSOR_HOME_DIR_NAME), { recursive: true });
    const before = JSON.stringify({
      mcpServers: { linear: { url: 'https://l' } },
    });
    writeFileSync(userConfig(dir), before);
    chmodSync(userConfig(dir), 0);
    try {
      const result = await adapterAt(dir).copyPluginMcpServer({
        cwd: dir,
        configDir: null,
        plugin: 'datadog',
        server: 'datadog',
        variables: { DD_MCP_DOMAIN: 'mcp.datadoghq.com' },
      });
      expect(result.ok ? null : result.reason).toContain('could not be read');
    } finally {
      chmodSync(userConfig(dir), 0o600);
    }
    expect(readFileSync(userConfig(dir), 'utf8')).toBe(before);
  });

  it('takes the next copy after one whose write failed', async () => {
    const dir = home();
    datadog(dir);
    const cursorDir = join(dir, CURSOR_HOME_DIR_NAME);
    mkdirSync(cursorDir, { recursive: true });
    const adapter = adapterAt(dir);
    const copy = () =>
      adapter.copyPluginMcpServer({
        cwd: dir,
        configDir: null,
        plugin: 'datadog',
        server: 'datadog',
        variables: { DD_MCP_DOMAIN: 'mcp.datadoghq.com' },
      });
    chmodSync(cursorDir, 0o500);
    try {
      await expect(copy()).rejects.toThrow();
    } finally {
      chmodSync(cursorDir, 0o700);
    }

    await expect(copy()).resolves.toMatchObject({ ok: true, changed: true });
  });

  it('refuses a secret, a value outside the list, and a missing required variable', async () => {
    const dir = home();
    datadog(dir);
    const copy = (variables: Record<string, string>) =>
      adapterAt(dir).copyPluginMcpServer({
        cwd: dir,
        configDir: null,
        plugin: 'datadog',
        server: 'datadog',
        variables,
      });

    await expect(
      copy({ DD_MCP_DOMAIN: 'mcp.datadoghq.com', DD_API_KEY: 'k' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'DD_API_KEY is not a variable this plugin asks for',
    });
    await expect(
      copy({ DD_MCP_DOMAIN: 'evil.example' }),
    ).resolves.toMatchObject({
      ok: false,
    });
    await expect(copy({})).resolves.toEqual({
      ok: false,
      reason: 'DD_MCP_DOMAIN is required',
    });
    expect(existsSync(userConfig(dir))).toBe(false);
  });

  describe('editing ~/.cursor/mcp.json', () => {
    const SPEC = {
      name: 'acme',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@acme/mcp'],
      env: { ACME_TOKEN: 't' },
      url: null,
      headers: {},
    };

    it('adds a server — creating ~/.cursor on a fresh home — owner-only', async () => {
      // This CLI has no `mcp add`, so the entry is written in the shape its
      // `mcp.json` reads. A home that never ran its MCP commands has no
      // `~/.cursor` at all: measured, the write failed ENOENT before mkdir.
      const dir = home();
      await expect(
        adapterAt(dir).addMcpServer({ configDir: null, server: SPEC }),
      ).resolves.toEqual({ ok: true, changed: true });
      expect(JSON.parse(readFileSync(userConfig(dir), 'utf8'))).toEqual({
        mcpServers: {
          acme: {
            command: 'npx',
            args: ['-y', '@acme/mcp'],
            env: { ACME_TOKEN: 't' },
          },
        },
      });
      expect(statSync(userConfig(dir)).mode & 0o777).toBe(0o600);
    });

    it('writes an http server as url and headers', async () => {
      const dir = home();
      await adapterAt(dir).addMcpServer({
        configDir: null,
        server: {
          ...SPEC,
          transport: 'http',
          command: null,
          args: [],
          env: {},
          url: 'https://acme/mcp',
          headers: { 'X-Api-Key': 'k' },
        },
      });
      expect(JSON.parse(readFileSync(userConfig(dir), 'utf8'))).toEqual({
        mcpServers: {
          acme: { url: 'https://acme/mcp', headers: { 'X-Api-Key': 'k' } },
        },
      });
    });

    it('refuses a name already in the file, and leaves it as it was', async () => {
      const dir = home();
      mkdirSync(join(dir, CURSOR_HOME_DIR_NAME), { recursive: true });
      const before = JSON.stringify({
        mcpServers: { acme: { url: 'https://mine' } },
      });
      writeFileSync(userConfig(dir), before);
      await expect(
        adapterAt(dir).addMcpServer({ configDir: null, server: SPEC }),
      ).resolves.toMatchObject({
        ok: false,
        reason: expect.stringMatching(/already exists/),
      });
      expect(readFileSync(userConfig(dir), 'utf8')).toBe(before);
    });

    it('replaces mcpServers and keeps every other key and the file’s mode', async () => {
      const dir = home();
      mkdirSync(join(dir, CURSOR_HOME_DIR_NAME), { recursive: true });
      writeFileSync(
        userConfig(dir),
        JSON.stringify({ other: 1, mcpServers: { old: { command: 'x' } } }),
      );
      chmodSync(userConfig(dir), 0o640);
      const adapter = adapterAt(dir);
      const doc = await adapter.readMcpConfigDocument();
      expect(doc.servers).toEqual({ old: { command: 'x' } });
      await expect(
        adapter.writeMcpConfigDocument({
          configDir: null,
          servers: { fresh: { url: 'https://f' } },
          expectedVersion: doc.version,
        }),
      ).resolves.toEqual({ ok: true, changed: true });
      expect(JSON.parse(readFileSync(userConfig(dir), 'utf8'))).toEqual({
        other: 1,
        mcpServers: { fresh: { url: 'https://f' } },
      });
      expect(statSync(userConfig(dir)).mode & 0o777).toBe(0o640);
    });

    it('refuses a save against a file that moved since it was opened', async () => {
      const dir = home();
      const adapter = adapterAt(dir);
      const doc = await adapter.readMcpConfigDocument();
      await adapter.addMcpServer({ configDir: null, server: SPEC });
      await expect(
        adapter.writeMcpConfigDocument({
          configDir: null,
          servers: {},
          expectedVersion: doc.version,
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason: expect.stringMatching(/changed since/),
      });
      expect(
        JSON.parse(readFileSync(userConfig(dir), 'utf8')).mcpServers,
      ).toHaveProperty('acme');
    });

    it('refuses an unparseable file rather than replacing every server in it', async () => {
      const dir = home();
      mkdirSync(join(dir, CURSOR_HOME_DIR_NAME), { recursive: true });
      writeFileSync(userConfig(dir), '{ broken');
      const adapter = adapterAt(dir);
      await expect(adapter.readMcpConfigDocument()).resolves.toMatchObject({
        servers: null,
        unavailableReason: expect.stringMatching(/not valid JSON/),
      });
      await expect(
        adapter.addMcpServer({ configDir: null, server: SPEC }),
      ).resolves.toMatchObject({
        ok: false,
        reason: expect.stringMatching(/not valid JSON/),
      });
      expect(readFileSync(userConfig(dir), 'utf8')).toBe('{ broken');
    });
  });
});

describe('CursorAcpAdapter questionFrom', () => {
  const adapter = (): CursorAcpAdapter =>
    new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore() });

  it('offers a calling agent exactly the question card', () => {
    expect(
      adapter().questionFrom({
        toolCallId: 'tool_1',
        questions: [
          {
            id: 'q1',
            prompt: 'Which color?',
            options: [
              { id: 'red', label: 'Red' },
              { id: 'blue', label: 'Blue' },
            ],
          },
        ],
      }),
    ).toEqual({ text: 'Which color?', options: ['Red', 'Blue'] });
  });

  it('leads with the request title and still names every question', () => {
    // The title names the whole ask, but a caller answering two questions has
    // to be able to read both.
    expect(
      adapter().questionFrom({
        title: 'Set up the review',
        questions: [
          {
            id: 'q1',
            prompt: 'Which color?',
            options: [{ id: 'red', label: 'Red' }],
          },
          {
            id: 'q2',
            prompt: 'Which size?',
            options: [{ id: 'big', label: 'Big' }],
          },
        ],
      }),
    ).toEqual({
      text: 'Set up the review\nWhich color?\nWhich size?',
      options: ['Red', 'Big'],
    });
  });

  it('answers null for a payload carrying no readable question', () => {
    expect(adapter().questionFrom({ questions: [] })).toBeNull();
  });
});

describe('CursorAcpAdapter fetchAccountSpend — the page walk', () => {
  /**
   * The real adapter with this MACHINE stood in for. The CLI's identity block
   * and its Keychain item are the only two things a poll reads from the
   * computer it runs on, and a spec that reached the real ones would read the
   * author's own login on macOS and decline on CI.
   */
  class MachineCursorAdapter extends CursorAcpAdapter {
    constructor() {
      super({ vocabularyStore: freshVocabularyStore() });
    }

    protected override readAccountIdentity(): Promise<{
      teamId: number;
      userId: number;
    } | null> {
      return Promise.resolve({ teamId: 1, userId: 2 });
    }

    protected override readSpendLogin(): Promise<string> {
      return Promise.resolve('spec-token');
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** One billable event, in the shape the account's reply carries it. */
  function usageEvent(
    conversationId: string,
    chargedCents: number,
    atMs: number,
  ): Record<string, unknown> {
    return {
      conversationId,
      chargedCents,
      isChargeable: true,
      timestamp: String(atMs),
    };
  }

  /** One page of the reply, naming the account's `total` when it reports one. */
  function usagePage(
    events: readonly Record<string, unknown>[],
    total?: number,
  ): Response {
    return new Response(
      JSON.stringify({
        usageEventsDisplay: events,
        ...(total === undefined ? {} : { totalUsageEventsCount: total }),
      }),
    );
  }

  function pageRequested(init: RequestInit | undefined): number {
    return (JSON.parse(String(init?.body)) as { page: number }).page;
  }

  /** `fetch`, answering the request for page N with `reply(N)`. */
  function serve(reply: (page: number) => Response): Mock<typeof fetch> {
    const fetchMock = vi.fn<typeof fetch>((_input, init) =>
      Promise.resolve(reply(pageRequested(init))),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  /** The page numbers the walk asked for, in order. */
  function pagesAsked(fetchMock: Mock<typeof fetch>): number[] {
    return fetchMock.mock.calls.map(([, init]) => pageRequested(init));
  }

  /** The window and the conversations a poll asks about. */
  function query(
    conversations: readonly string[] = ['a', 'b'],
  ): AccountSpendQuery {
    return {
      startMs: 1_000,
      endMs: 2_000,
      conversations: new Set(conversations),
      configDir: null,
    };
  }

  /** An event as the walk reports it — keyed by its own date and model. */
  function read(conversationId: string, cents: number, atMs: number) {
    return { conversationId, key: `${atMs}|`, atMs, model: null, cents };
  }

  it('reads every page and stops once the account’s own total is reached', async () => {
    const fetchMock = serve((page) => {
      switch (page) {
        case 1:
          return usagePage(
            [usageEvent('a', 100, 1_100), usageEvent('b', 40, 1_200)],
            3,
          );
        case 2:
          return usagePage([usageEvent('a', 10, 1_900)], 3);
        default:
          return usagePage([], 3);
      }
    });

    const spend = await new MachineCursorAdapter().fetchAccountSpend(query());

    // The two pages that hold the three events the account reports, and no
    // third request: past the total the walk has nothing left to ask for.
    expect(pagesAsked(fetchMock)).toEqual([1, 2]);
    expect(spend).toEqual({
      complete: true,
      events: [
        read('a', 100, 1_100),
        read('b', 40, 1_200),
        read('a', 10, 1_900),
      ],
    });
  });

  it('reports a walk cut short by the page cap as INCOMPLETE', async () => {
    // Every page brings one event and the account claims far more, so the cap
    // is the only thing that can end the walk — and what it did not reach must
    // not be taken for absent.
    const fetchMock = serve((page) =>
      usagePage([usageEvent('a', 10, 1_000 + page)], 100_000),
    );

    const spend = await new MachineCursorAdapter().fetchAccountSpend(query());

    expect(pagesAsked(fetchMock)).toEqual(
      Array.from({ length: CURSOR_USAGE_MAX_PAGES }, (_, index) => index + 1),
    );
    expect(spend).toMatchObject({ complete: false });
    expect(spend).toHaveProperty('events.length', CURSOR_USAGE_MAX_PAGES);
  });

  it('answers null, and asks for nothing further, when the first page is refused', async () => {
    // A signed-out account: "no cost reported", never an empty spend.
    const fetchMock = serve(() => new Response('', { status: 401 }));

    const spend = await new MachineCursorAdapter().fetchAccountSpend(query());

    expect(spend).toBeNull();
    expect(pagesAsked(fetchMock)).toEqual([1]);
  });

  it('answers null rather than what the earlier pages read when a later page is refused', async () => {
    // Half a bill reads as the whole bill, so a walk that lost a page reports
    // nothing instead of a total that is short by exactly that page.
    const fetchMock = serve((page) =>
      page === 1
        ? usagePage([usageEvent('a', 100, 1_100)], 5)
        : new Response('', { status: 500 }),
    );

    const spend = await new MachineCursorAdapter().fetchAccountSpend(query());

    expect(spend).toBeNull();
    expect(pagesAsked(fetchMock)).toEqual([1, 2]);
  });

  it('reaches the total by the events a page carried, not by the ones it kept', async () => {
    // `c` is nobody geniro asked about, so the reader drops it — and the page
    // still holds the account's whole total of two.
    const fetchMock = serve((page) =>
      page === 1
        ? usagePage([usageEvent('c', 5, 1_000), usageEvent('a', 7, 1_800)], 2)
        : usagePage([], 2),
    );

    const spend = await new MachineCursorAdapter().fetchAccountSpend(query());

    expect(pagesAsked(fetchMock)).toEqual([1]);
    expect(spend).toEqual({ complete: true, events: [read('a', 7, 1_800)] });
  });

  it('stops on a page carrying no events, whatever total the account reports', async () => {
    const fetchMock = serve(() => usagePage([], 10));

    const spend = await new MachineCursorAdapter().fetchAccountSpend(query());

    expect(pagesAsked(fetchMock)).toEqual([1]);
    expect(spend).toEqual({ complete: true, events: [] });
  });

  it('stops after the first page when the account reports no total', async () => {
    const fetchMock = serve((page) =>
      usagePage([usageEvent('a', 5, 1_000 + page)]),
    );

    const spend = await new MachineCursorAdapter().fetchAccountSpend(query());

    expect(pagesAsked(fetchMock)).toEqual([1]);
    expect(spend).toEqual({ complete: true, events: [read('a', 5, 1_001)] });
  });
});

describe('CursorAcpAdapter fetchAccountSpend — whose account it asks', () => {
  const dirs: string[] = [];

  /** How the stood-in `security` read of the default login ends. */
  type KeychainAnswer =
    { token: string } | { exitCode: number } | { killed: true };

  /**
   * The real adapter with `security` stood in for: every file read is real,
   * and the Keychain answers as `keychain` says — a token, a failing exit, or
   * a read killed by its timeout.
   */
  function keychainCursor(
    homeDir: string,
    keychain: KeychainAnswer = { token: 'default-token' },
  ): CursorAcpAdapter {
    const execFileFn = ((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      if ('token' in keychain) {
        callback(null, `${keychain.token}\n`);
      } else {
        callback(
          Object.assign(new Error('security failed'), {
            code: 'exitCode' in keychain ? keychain.exitCode : null,
            killed: 'killed' in keychain,
          }),
          '',
        );
      }
    }) as unknown as typeof execFile;
    return new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      homeDir,
      execFileFn,
    });
  }

  const realPlatform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  /** A `.cursor` home holding this identity and, when given, this login. */
  function cursorHome(userId: number, accessToken?: string): string {
    const home = mkdtempSync(join(tmpdir(), 'cursor-spend-home-'));
    dirs.push(home);
    mkdirSync(join(home, '.cursor'));
    writeFileSync(
      join(home, '.cursor', 'cli-config.json'),
      JSON.stringify({ authInfo: { userId, teamId: userId + 1 } }),
    );
    if (accessToken !== undefined) {
      writeFileSync(
        join(home, '.cursor', 'auth.json'),
        JSON.stringify({ accessToken }),
      );
    }
    return home;
  }

  /** Each request's login and the account its body names. */
  function serve(): {
    asked: { auth: string; userId: number; teamId: number }[];
  } {
    const asked: { auth: string; userId: number; teamId: number }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          userId: number;
          teamId: number;
        };
        asked.push({
          auth: new Headers(init?.headers).get('authorization') ?? '',
          userId: body.userId,
          teamId: body.teamId,
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              usageEventsDisplay: [],
              totalUsageEventsCount: 0,
            }),
          ),
        );
      }),
    );
    return { asked };
  }

  const ask = (adapter: CursorAcpAdapter, configDir: string | null) =>
    adapter.fetchAccountSpend({
      startMs: 1_000,
      endMs: 2_000,
      conversations: new Set(['a']),
      configDir,
    });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    vi.unstubAllGlobals();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('asks a named configuration’s OWN account, with its own login and identity', async () => {
    const adapter = keychainCursor(cursorHome(10));
    const profile = cursorHome(20, 'profile-token');
    const { asked } = serve();

    expect(await ask(adapter, profile)).toEqual({ complete: true, events: [] });
    expect(asked).toEqual([
      { auth: 'Bearer profile-token', userId: 20, teamId: 21 },
    ]);
  });

  it('asks the default account under the Keychain login when no profile is named', async () => {
    const adapter = keychainCursor(cursorHome(10));
    const { asked } = serve();

    await ask(adapter, null);
    await ask(adapter, '   ');

    expect(asked).toEqual([
      { auth: 'Bearer default-token', userId: 10, teamId: 11 },
      { auth: 'Bearer default-token', userId: 10, teamId: 11 },
    ]);
  });

  it('answers signed out, asking nothing, for a profile with no login — never the default account in its place', async () => {
    const adapter = keychainCursor(cursorHome(10));
    const signedOut = cursorHome(20);
    const unknown = join(tmpdir(), 'cursor-spend-no-such-profile');
    const { asked } = serve();

    expect(await ask(adapter, signedOut)).toBe(ACCOUNT_SIGNED_OUT);
    expect(await ask(adapter, unknown)).toBe(ACCOUNT_SIGNED_OUT);
    expect(asked).toEqual([]);
  });

  it('answers signed out for the default account only when the Keychain holds no login item', async () => {
    const { asked } = serve();

    expect(
      await ask(keychainCursor(cursorHome(10), { exitCode: 44 }), null),
    ).toBe(ACCOUNT_SIGNED_OUT);
    expect(asked).toEqual([]);
  });

  it('answers null — a failed ask, never signed out — when the Keychain read is denied, fails or times out', async () => {
    const { asked } = serve();

    for (const keychain of [
      { exitCode: 51 },
      { exitCode: 2 },
      { killed: true },
    ] as const) {
      expect(await ask(keychainCursor(cursorHome(10), keychain), null)).toBe(
        null,
      );
    }
    expect(asked).toEqual([]);
  });
});

describe('CursorAcpAdapter.readPlanLimits — the account ask', () => {
  /** The default login stood in for, like the spend walk's machine above. */
  class LoggedInCursor extends CursorAcpAdapter {
    constructor() {
      super({ vocabularyStore: freshVocabularyStore() });
    }

    protected override readAccessToken(): Promise<string | null> {
      return Promise.resolve('default-token');
    }
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Transcribed from a real Grok-unified Premium account on 2026-10-29. */
  const PERIOD = {
    billingCycleStart: '1793121329683',
    billingCycleEnd: '1793726129683',
    planUsage: {
      autoPercentUsed: 6.218851570964247,
      apiPercentUsed: 0,
      totalPercentUsed: 6.218851570964247,
    },
    displayThreshold: 200,
    enabled: true,
  };
  const PLAN = {
    planInfo: {
      planName: 'Premium',
      billingCycleEnd: '1793491200000',
      includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY',
    },
    isMerged: true,
  };

  /** `fetch`, answering each method with what `replies` maps it to. */
  function serve(replies: Record<string, () => Response>): Mock<typeof fetch> {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const method = String(input).slice(CURSOR_API_HOST.length);
      const reply = replies[method];
      return Promise.resolve(
        reply ? reply() : new Response('', { status: 404 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const json = (body: unknown) => () => new Response(JSON.stringify(body));

  function authOf(fetchMock: Mock<typeof fetch>): string[] {
    return fetchMock.mock.calls.map(
      ([, init]) => new Headers(init?.headers).get('authorization') ?? '',
    );
  }

  const ask = (adapter: CursorAcpAdapter, configDir: string | null = null) =>
    adapter.readPlanLimits({ live: null, sessionId: null, configDir });

  it('reads the included, auto and API windows under the default login', async () => {
    const fetchMock = serve({
      [CURSOR_PERIOD_USAGE_METHOD]: json(PERIOD),
      [CURSOR_PLAN_INFO_METHOD]: json(PLAN),
    });

    const resetsAt = new Date(1793726129683).toISOString();
    expect(await ask(new LoggedInCursor())).toEqual({
      plan: 'Premium',
      estimated: false,
      windows: [
        {
          key: 'included',
          label: 'Included',
          percent: 6.218851570964247,
          resetsAt,
        },
        {
          key: 'auto',
          label: 'Auto',
          percent: 6.218851570964247,
          resetsAt,
        },
        { key: 'api', label: 'API', percent: 0, resetsAt },
      ],
    });
    expect(authOf(fetchMock)).toEqual([
      'Bearer default-token',
      'Bearer default-token',
    ]);
  });

  it('asks under a named configuration’s own login, not the default one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-plan-'));
    mkdirSync(join(dir, CURSOR_HOME_DIR_NAME));
    writeFileSync(
      join(dir, CURSOR_HOME_DIR_NAME, 'auth.json'),
      JSON.stringify({ accessToken: 'profile-token' }),
    );
    const fetchMock = serve({
      [CURSOR_PERIOD_USAGE_METHOD]: json(PERIOD),
      [CURSOR_PLAN_INFO_METHOD]: json(PLAN),
    });

    const limits = await ask(new LoggedInCursor(), dir);

    expect(limits).not.toBeNull();
    expect(authOf(fetchMock)).toEqual([
      'Bearer profile-token',
      'Bearer profile-token',
    ]);
  });

  it('says the account has no limits when its period carries no plan usage', async () => {
    serve({
      [CURSOR_PERIOD_USAGE_METHOD]: json({
        billingCycleStart: '1793264620061',
        billingCycleEnd: '1793264620061',
        displayThreshold: 100,
      }),
      [CURSOR_PLAN_INFO_METHOD]: json({
        planInfo: { planName: 'Enterprise', price: 'Custom' },
      }),
    });

    expect(await ask(new LoggedInCursor())).toBe(NO_PLAN_LIMITS);
  });

  it('keeps the windows with no plan name when the plan request fails', async () => {
    serve({ [CURSOR_PERIOD_USAGE_METHOD]: json(PERIOD) });

    const limits = await ask(new LoggedInCursor());

    expect(limits).toMatchObject({ plan: null });
    expect(limits === NO_PLAN_LIMITS ? [] : limits?.windows).toHaveLength(3);
  });

  it('serves one answer per account for the interval, then asks again', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const fetchMock = serve({
      [CURSOR_PERIOD_USAGE_METHOD]: json(PERIOD),
      [CURSOR_PLAN_INFO_METHOD]: json(PLAN),
    });
    const adapter = new LoggedInCursor();

    await ask(adapter);
    await ask(adapter);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(1_000_000 + CURSOR_PLAN_LIMITS_MIN_INTERVAL_MS);
    await ask(adapter);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('answers null for a refused reply and does not hold on to it', async () => {
    const fetchMock = serve({
      [CURSOR_PERIOD_USAGE_METHOD]: () => new Response('', { status: 401 }),
    });
    const adapter = new LoggedInCursor();

    expect(await ask(adapter)).toBeNull();
    await Promise.resolve();
    expect(await ask(adapter)).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith(CURSOR_PERIOD_USAGE_METHOD),
      ),
    ).toHaveLength(2);
  });

  it('answers null with no login, and asks nothing', async () => {
    class SignedOut extends CursorAcpAdapter {
      protected override readAccessToken(): Promise<string | null> {
        return Promise.resolve(null);
      }
    }
    const fetchMock = serve({});

    expect(
      await ask(new SignedOut({ vocabularyStore: freshVocabularyStore() })),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CursorAcpAdapter.spawnedConversations', () => {
  const PARENT = '11111111-1111-4111-8111-111111111111';
  const CHILD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const CHILD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  /** A `task` result as the CLI writes it into the parent's store. */
  function taskResult(child: string): string {
    return `{"text":"…report…\\n\\nAgent ID: ${child} (can be used with the \`resume\` parameter to continue)"}`;
  }

  function storeWith(files: Record<string, string>): {
    adapter: CursorAcpAdapter;
    dir: string;
  } {
    const sessionStoreDir = mkdtempSync(join(tmpdir(), 'cursor-spawn-'));
    const dir = join(sessionStoreDir, PARENT);
    mkdirSync(dir);
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text);
    }
    return {
      adapter: new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        sessionStoreDir,
      }),
      dir,
    };
  }

  it('names every delegate the parent’s store and its WAL record, once each', async () => {
    const { adapter } = storeWith({
      'store.db': `${taskResult(CHILD_A)} … ${taskResult(CHILD_A)}`,
      'store.db-wal': taskResult(CHILD_B),
    });

    expect(await adapter.spawnedConversations([PARENT])).toEqual(
      new Map([[PARENT, [CHILD_A, CHILD_B]]]),
    );
  });

  it('takes nothing for prose that mentions an agent id without one', async () => {
    const { adapter } = storeWith({
      'store.db': 'Agent ID: unknown — the delegate never started',
    });

    expect(await adapter.spawnedConversations([PARENT])).toEqual(new Map());
  });

  it('re-reads a store only once its files have changed', async () => {
    const { adapter, dir } = storeWith({ 'store.db': taskResult(CHILD_A) });
    await adapter.spawnedConversations([PARENT]);
    // Same bytes, same size, but the cache must not be what answers once the
    // file moved: rewrite with a second delegate and a later mtime.
    writeFileSync(
      join(dir, 'store.db'),
      `${taskResult(CHILD_A)}${taskResult(CHILD_B)}`,
    );
    utimesSync(join(dir, 'store.db'), new Date(), new Date(Date.now() + 5_000));

    expect(await adapter.spawnedConversations([PARENT])).toEqual(
      new Map([[PARENT, [CHILD_A, CHILD_B]]]),
    );
  });

  it('skips a store untouched for longer than the account keeps', async () => {
    const { adapter, dir } = storeWith({ 'store.db': taskResult(CHILD_A) });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    utimesSync(join(dir, 'store.db'), old, old);

    expect(await adapter.spawnedConversations([PARENT])).toEqual(new Map());
  });

  it('never reads a path built from an id that is not a plain session id', async () => {
    const { adapter } = storeWith({ 'store.db': taskResult(CHILD_A) });

    expect(await adapter.spawnedConversations([`../${PARENT}`])).toEqual(
      new Map(),
    );
  });
});

describe('CursorAcpAdapter.deleteSessionTranscript', () => {
  /** geniro's store holding one conversation, and the user's own beside it. */
  function stores(): { home: string; store: string; userCopy: string } {
    const home = mkdtempSync(join(tmpdir(), 'cursor-home-'));
    const store = mkdtempSync(join(tmpdir(), 'cursor-store-'));
    dirs.push(home, store);
    mkdirSync(join(store, 'sess-1'), { recursive: true });
    writeFileSync(join(store, 'sess-1', 'store.db'), 'geniro’s copy');
    const userCopy = join(
      home,
      CURSOR_HOME_DIR_NAME,
      CURSOR_ACP_SESSIONS_DIR_NAME,
      'sess-1',
    );
    mkdirSync(userCopy, { recursive: true });
    writeFileSync(join(userCopy, 'store.db'), 'the user’s original');
    return { home, store, userCopy };
  }
  const adapter = (home: string, store: string): CursorAcpAdapter =>
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      homeDir: home,
      sessionStoreDir: store,
    });

  it('deletes geniro’s copy and leaves the user’s own profile alone', async () => {
    const { home, store, userCopy } = stores();

    const result = await adapter(home, store).deleteSessionTranscript({
      sessionId: 'sess-1',
      configDir: null,
      // Long after the conversation began: geniro's store is its own, so an
      // imported conversation's COPY goes and the original stays.
      runCreatedAt: new Date(),
    });

    expect(result).toEqual({ deleted: true });
    expect(existsSync(join(store, 'sess-1'))).toBe(false);
    expect(existsSync(join(userCopy, 'store.db'))).toBe(true);
  });

  it('refuses an id carrying a path separator, deleting nothing', async () => {
    const { home, store } = stores();
    const beside = join(store, '..', 'not-a-session');
    mkdirSync(beside, { recursive: true });
    dirs.push(beside);

    const result = await adapter(home, store).deleteSessionTranscript({
      sessionId: '../not-a-session',
      configDir: null,
      runCreatedAt: new Date(),
    });

    expect(result.deleted).toBe(false);
    expect(existsSync(beside)).toBe(true);
  });

  it('answers a refusal for a conversation the store does not hold', async () => {
    const { home, store } = stores();

    await expect(
      adapter(home, store).deleteSessionTranscript({
        sessionId: 'sess-other',
        configDir: null,
        runCreatedAt: new Date(),
      }),
    ).resolves.toMatchObject({ deleted: false });
  });
});

describe('CursorAcpAdapter — reading a server sign-in’s verdict', () => {
  // Captured verbatim from 2026.10.01-e373342 under a pty (ANSI stripped).
  const FAILED = [
    'MCP Login',
    'Preparing login...',
    "Loading MCP server 'probedead' from .cursor/mcp.json or ~/.cursor/mcp.json...",
    '✗ MCP login failed',
    'Unexpected error during MCP login: fetch failed',
  ].join('\n');

  it('reads the CLI’s own failure line as a sign-in that did not complete', () => {
    expect(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
      }).mcpLoginFailed(FAILED),
    ).toBe(true);
  });

  it('does not read the CLI’s progress lines alone as a failure', () => {
    expect(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
      }).mcpLoginFailed('MCP Login\nPreparing login...\nChecking status...'),
    ).toBe(false);
  });
});

describe('CursorAcpAdapter — MCP tool calls', () => {
  /**
   * Transcribed from stored rows of a cursor-agent run (gemini-4-carbon,
   * 2026-11-14) and from 2026.11.13-eacade1's own `summarizeToolCall`
   * (`${providerIdentifier}: ${toolName}`) and `extractToolCallInput`
   * (`{providerIdentifier, toolName, args}`).
   */
  function driveTurn(input: Partial<AgentTurnInput> = {}): {
    child: FakeChild;
    events: AgentEvent[];
  } {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start({ ...BASE, ...input }, (event) => events.push(event));
    handshake(child);
    return { child, events };
  }

  const wrapped = (id: string, tool: string, args: Record<string, unknown>) =>
    sessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      title: `geniro-83139c58: ${tool}`,
      rawInput: { providerIdentifier: 'geniro-83139c58', toolName: tool, args },
    });

  it('writes an MCP call under its server and tool, with the arguments it was given', () => {
    const { child, events } = driveTurn();
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: '1_tool_1ea1',
        title: 'MCP: tool',
        kind: 'other',
        status: 'pending',
        rawInput: {},
      }),
    );
    child.stdout.emitData(
      wrapped('1_tool_1ea1', 'memory_search', {
        limit: 5,
        query: 'mosaic OR select',
      }),
    );
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: '1_tool_1ea1',
        status: 'in_progress',
      }),
    );
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: '1_tool_1ea1',
        status: 'completed',
        rawOutput: { success: true },
      }),
    );

    expect(events.filter((event) => event.type === 'tool_call')).toEqual([
      {
        type: 'tool_call',
        id: '1_tool_1ea1',
        name: 'mcp__geniro-83139c58__memory_search',
        input: { limit: 5, query: 'mosaic OR select' },
        kind: 'other',
      },
    ]);
    expect(events.filter((event) => event.type === 'tool_result')).toEqual([
      expect.objectContaining({
        id: '1_tool_1ea1',
        name: 'mcp__geniro-83139c58__memory_search',
      }),
    ]);
  });

  it('writes an MCP call made with no arguments with no input', () => {
    const { child, events } = driveTurn();
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: '0_tool_ab93',
        title: 'geniro-83139c58: team_notes',
        kind: 'other',
        status: 'pending',
        rawInput: {
          providerIdentifier: 'geniro-83139c58',
          toolName: 'team_notes',
          args: {},
        },
      }),
    );
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: '0_tool_ab93',
        status: 'in_progress',
      }),
    );

    expect(events.filter((event) => event.type === 'tool_call')).toEqual([
      {
        type: 'tool_call',
        id: '0_tool_ab93',
        name: 'mcp__geniro-83139c58__team_notes',
        input: null,
        kind: 'other',
      },
    ]);
  });

  it('asks about an MCP call under its server and tool, with its bare arguments', () => {
    const { child, events } = driveTurn({ approvalMode: 'ask' });
    child.stdout.emitData(
      stdoutLine({
        jsonrpc: '2.0',
        id: 9,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          toolCall: {
            toolCallId: '2_tool_c5ec',
            title: 'linear-get_issue: get_issue',
            kind: 'other',
            rawInput: {
              providerIdentifier: 'linear',
              toolName: 'get_issue',
              args: { id: 'CI-992' },
            },
          },
          options: ONCE_OPTIONS,
        },
      }),
    );

    expect(events.filter((event) => event.type === 'approval_request')).toEqual(
      [
        expect.objectContaining({
          toolName: 'mcp__linear__get_issue',
          input: { id: 'CI-992' },
        }),
      ],
    );
  });

  it('asks about one of geniro’s own tools under a name its host-tool checks recognise', () => {
    const { child, events } = driveTurn({ approvalMode: 'ask' });
    child.stdout.emitData(
      stdoutLine({
        jsonrpc: '2.0',
        id: 10,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          toolCall: {
            toolCallId: '3_tool_9a1f',
            title: 'geniro-83139c58-notify_user: notify_user',
            kind: 'other',
            rawInput: {
              providerIdentifier: 'geniro-83139c58',
              toolName: 'notify_user',
              args: { title: 'Stand is up' },
            },
          },
          options: ONCE_OPTIONS,
        },
      }),
    );

    const [card] = events.filter(
      (event) => event.type === 'approval_request',
    ) as { toolName: string; input: unknown }[];
    expect(card?.input).toEqual({ title: 'Stand is up' });
    expect(
      isHostToolCall('geniro-83139c58', card?.toolName ?? '', 'notify_user'),
    ).toBe(true);
  });

  it('leaves a call whose title is not the MCP template as the agent named it', () => {
    const { child, events } = driveTurn();
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'sh-1',
        title: '`echo geniro-83139c58: team_notes`',
        kind: 'execute',
        status: 'pending',
        rawInput: {
          providerIdentifier: 'geniro-83139c58',
          toolName: 'team_notes',
          args: {},
        },
      }),
    );

    expect(events.filter((event) => event.type === 'tool_call')).toEqual([
      expect.objectContaining({
        name: '`echo geniro-83139c58: team_notes`',
        input: {
          providerIdentifier: 'geniro-83139c58',
          toolName: 'team_notes',
          args: {},
        },
      }),
    ]);
  });
});
