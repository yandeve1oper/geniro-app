import type { ChildProcess, execFile, spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

import { FakeChild, fakeSpawn } from '../../__tests__/fake-child';
import { tempDir } from '../../__tests__/temp-dir';
import { AgentAdapterRegistry } from '../../services/agent-adapter.registry';
import type { AgentVersionService } from '../../services/agent-version.service';
import { ModelVocabularyStore } from '../../services/model-vocabulary.store';
import { GENIRO_UI_PREAMBLE } from '../../utils/agent-instructions';
import type { ModelPrice } from '../../utils/model-prices';
import type { SpawnFn } from '../../utils/spawn-cli';
import { fakeGroupChild, spawnAnswering } from '../__tests__/fake-group-child';
import { freshVocabularyStore } from '../__tests__/fresh-vocabulary-store';
import type {
  AdapterConfig,
  AgentEvent,
  AgentTurnHandle,
  AgentTurnInput,
} from '../adapter.types';
import type { AgentSkillsInput } from '../adapter.types';
import { ClaudeAdapter } from './claude.adapter';
import {
  CLAUDE_APPEND_SYSTEM_PROMPT_FILE_FLAG,
  CLAUDE_APPEND_SYSTEM_PROMPT_FLAG,
  CLAUDE_ARTIFACT_ENV,
  CLAUDE_BASE_ARGS,
  CLAUDE_BROWSER_TOOLS_ENV,
  CLAUDE_BROWSER_TOOLS_OPTION,
  CLAUDE_COMMANDS_CHANGED_SUBTYPE,
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_DISABLE_AUTO_MEMORY_ENV,
  CLAUDE_EMPTY_MCP_CONFIG,
  CLAUDE_FAST_MODE_PARAMETER_ID,
  CLAUDE_MCP_CONFIG_FLAG,
  CLAUDE_MODEL_FLAG,
  CLAUDE_MODEL_RESOLUTION_ARGS,
  CLAUDE_MODEL_RESOLUTION_REQUEST_ID,
  CLAUDE_RELOAD_COMMANDS_REQUEST_ID,
  CLAUDE_RELOAD_COMMANDS_SUBTYPE,
  CLAUDE_RESUME_FLAG,
  CLAUDE_SETTINGS_FLAG,
  CLAUDE_STRICT_MCP_CONFIG_FLAG,
  CLAUDE_SYSTEM_PROMPT_INLINE_MAX_BYTES,
  CLAUDE_TODO_TOOLS_ENV,
  GENIRO_MCP_TOOL_TIMEOUT_MS,
} from './claude.const';
import type { ClaudeModeProbe, ClaudeModesVerdict } from './claude.types';
import {
  BACKGROUND_AGENT,
  BACKGROUND_CALL,
  backgroundDelegateLines,
  taskNotification,
} from './utils/__tests__/claude-subagent-stream';

/**
 * A child that DIES when signalled, the way a real CLI does: `close` follows
 * the SIGTERM. The command probe cancels its own turn and then awaits `done`,
 * so a fake that swallowed the kill would hang the read instead of testing it.
 *
 * The one behavioural variant of the shared double, and it stays local because
 * this is the only spec that needs it: `FakeChild` RECORDS what it was told and
 * decides nothing, which is what keeps one double serviceable for six specs.
 */
class KillableChild extends FakeChild {
  override kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    super.kill(signal);
    // A real child's `close` lands after the signal, never within it.
    setTimeout(() => this.emit('close', null, signal), 0);
    return true;
  }
}

/** What every user-facing claude turn leads with: the preamble, then its note. */
const HOST_BLOCK = `${GENIRO_UI_PREAMBLE}\n\n${new ClaudeAdapter().getConfig().backgroundWork.agentNote}`;

/**
 * Answers a utility command (`runCommand`, not `start`) with canned stdout,
 * capturing its argv. The two paths take different seams: a turn is spawned
 * through `spawn`, everything else runs through `execFileFn`.
 */
function fakeListing(stdout: string): {
  groupSpawnFn: typeof spawn;
  captured: { args?: readonly string[]; options?: Record<string, unknown> };
} {
  const captured: {
    args?: readonly string[];
    options?: Record<string, unknown>;
  } = {};
  const groupSpawnFn = spawnAnswering(stdout, 4242, (args, options) => {
    captured.args = args;
    captured.options = options;
  });
  return { groupSpawnFn, captured };
}

describe('ClaudeAdapter', () => {
  it('spawns with stream-json flags, streams a turn, and sends the prompt on stdin', async () => {
    const { spawn, child, captured } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'say hi', cwd: '/proj', model: 'opus' },
      (e) => events.push(e),
    );

    // stdout arrives in arbitrary chunks — the assistant line is split.
    child.stdout.emitData(
      '{"type":"system","subtype":"init","session_id":"s1"}\n{"type":"assist',
    );
    child.stdout.emitData(
      'ant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}\n',
    );
    child.stdout.emitData(
      '{"type":"result","is_error":false,"result":"hi","stop_reason":"end_turn","session_id":"sess-adapter","usage":{"input_tokens":1,"output_tokens":1,"iterations":[{"input_tokens":1,"output_tokens":1}]},"total_cost_usd":0.01}\n',
    );
    child.emit('close', 0, null);
    await handle.done;

    expect(events).toEqual([
      { type: 'session', sessionId: 's1' },
      { type: 'text', text: 'hi' },
      {
        type: 'turn_complete',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          thinkingTokens: null,
          contextTokens: 1,
          contextWindowTokens: null,
          contextModel: null,
          costUsd: 0.01,
          durationMs: null,
          apiMs: null,
          ttftMs: null,
          timeToRequestMs: null,
          numTurns: null,
          promptCacheTtlMs: null,
          promptCacheTtlReason: null,
          modelCosts: null,
        },
        stopReason: 'end_turn',
        finalText: 'hi',
      },
    ]);
    expect(captured.command).toBe('claude');
    expect(captured.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
      ]),
    );
    expect(captured.args).toEqual(expect.arrayContaining(['--model', 'opus']));
    expect(captured.cwd).toBe('/proj');
    expect(JSON.parse(child.stdin.written.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'say hi' }] },
    });
  });

  it('passes --effort only when the turn names a level', () => {
    const withEffort = fakeSpawn();
    new ClaudeAdapter({
      spawn: withEffort.spawn,
      waitForMcpServers: false,
    }).start({ prompt: 'go', cwd: '/proj', effort: 'ultracode' }, () => {});
    expect(withEffort.captured.args).toEqual(
      expect.arrayContaining(['--effort', 'ultracode']),
    );

    const without = fakeSpawn();
    new ClaudeAdapter({ spawn: without.spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    expect(without.captured.args).not.toContain('--effort');
  });

  it('asks the CLI to compact itself at the turn’s threshold, buffer included', () => {
    // The flag names the WINDOW, and this CLI compacts a fixed 33k short of it
    // (`/context` calls that reserve the "Autocompact buffer"; measured 33k at
    // every window on 2.1.276). So 80% of a 1M window is asked for as 833,000,
    // which puts the compaction at 800,000 — the figure the user chose. Asking
    // for 800,000 flat would compact at 767k, a whole 3.3% early on every turn.
    const due = fakeSpawn();
    new ClaudeAdapter({ spawn: due.spawn, waitForMcpServers: false }).start(
      {
        prompt: 'go',
        cwd: '/proj',
        autoCompact: { percent: 80, windowTokens: 1_000_000 },
      },
      () => {},
    );
    expect(due.captured.args).toEqual(
      expect.arrayContaining(['--autocompact', '833000']),
    );

    const without = fakeSpawn();
    new ClaudeAdapter({ spawn: without.spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    expect(without.captured.args).not.toContain('--autocompact');
  });

  it('never asks for a window this CLI would refuse', () => {
    // Both bounds are the CLI's own, and it EXITS on argv outside them
    // ("between 100k and 1M") — so a threshold it cannot express must cost the
    // flag, never the turn.
    //
    // Above: 95% of a 200k window plus the buffer is 223k, past the model's own
    // window, so the highest expressible threshold is one buffer short of it.
    const high = fakeSpawn();
    new ClaudeAdapter({ spawn: high.spawn, waitForMcpServers: false }).start(
      {
        prompt: 'go',
        cwd: '/proj',
        autoCompact: { percent: 95, windowTokens: 200_000 },
      },
      () => {},
    );
    expect(high.captured.args).toEqual(
      expect.arrayContaining(['--autocompact', '200000']),
    );

    // Below: a window smaller than the smallest figure the CLI accepts. There
    // is no argv that expresses a threshold here, and passing the floor anyway
    // would be a window LARGER than the model's — so the flag is dropped and
    // geniro's between-turn rule stays this conversation's only threshold.
    const tiny = fakeSpawn();
    new ClaudeAdapter({ spawn: tiny.spawn, waitForMcpServers: false }).start(
      {
        prompt: 'go',
        cwd: '/proj',
        autoCompact: { percent: 80, windowTokens: 64_000 },
      },
      () => {},
    );
    expect(tiny.captured.args).not.toContain('--autocompact');
  });

  it('runs a turn under the run’s OWN config directory, via env', () => {
    // ENV, not argv: claude has no `--config-dir`, and this directory is what
    // decides which ACCOUNT the turn runs as. A spec asserting argv here would
    // pass against a flag the CLI ignores.
    const withConfig = fakeSpawn();
    new ClaudeAdapter({
      spawn: withConfig.spawn,
      waitForMcpServers: false,
    }).start(
      { prompt: 'go', cwd: '/proj', configDir: '/profiles/work' },
      () => {},
    );
    expect(withConfig.captured.env?.[CLAUDE_CONFIG_DIR_ENV]).toBe(
      '/profiles/work',
    );

    // The shell's own profile would inherit into this spawn: this adapter is built
    // outside the registry that strips it. Taken away for the one spawn that
    // asserts absence, and put back afterwards, so the test holds in any shell.
    const outerProfile = process.env[CLAUDE_CONFIG_DIR_ENV];
    delete process.env[CLAUDE_CONFIG_DIR_ENV];
    try {
      const without = fakeSpawn();
      new ClaudeAdapter({
        spawn: without.spawn,
        waitForMcpServers: false,
      }).start({ prompt: 'go', cwd: '/proj' }, () => {});
      // ABSENT, never empty: an empty value would point claude at the process
      // cwd's idea of "" rather than at its own default profile.
      expect(without.captured.env).not.toHaveProperty(CLAUDE_CONFIG_DIR_ENV);
    } finally {
      if (outerProfile === undefined) {
        delete process.env[CLAUDE_CONFIG_DIR_ENV];
      } else {
        process.env[CLAUDE_CONFIG_DIR_ENV] = outerProfile;
      }
    }
  });

  it('gives the turn this CLI’s own artifact tool back', () => {
    // Probe-verified on 2.1.234 against `system/init`'s own tool list: a
    // headless turn reports 74 tools and no `Artifact`; the same argv with this
    // variable set reports 99, `Artifact` among them. The account these chats
    // run as already HOLDS published artifacts, made from that CLI's
    // interactive sessions — so this restores parity rather than switching on
    // something new, and without it an agent asked for one answers that the
    // session cannot publish.
    const turn = fakeSpawn();
    new ClaudeAdapter({ spawn: turn.spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    expect(turn.captured.env?.[CLAUDE_ARTIFACT_ENV]).toBe('1');

    // …and a caller that says otherwise still wins, like every other value
    // this builder sets.
    const overridden = fakeSpawn();
    new ClaudeAdapter({
      spawn: overridden.spawn,
      waitForMcpServers: false,
    }).start(
      { prompt: 'go', cwd: '/proj', env: { [CLAUDE_ARTIFACT_ENV]: '' } },
      () => {},
    );
    expect(overridden.captured.env?.[CLAUDE_ARTIFACT_ENV]).toBe('');
  });

  it('gives the turn this CLI’s own TASK tools back', () => {
    // Probe-verified on 2.1.234, same method as the artifact one: the tool list
    // gains exactly `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` with this
    // set. geniro already RENDERS that list (`claude-tasks.utils.ts` reads it
    // off those very calls), so without them a shipped feature could not fire.
    const turn = fakeSpawn();
    new ClaudeAdapter({ spawn: turn.spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    expect(turn.captured.env?.[CLAUDE_TODO_TOOLS_ENV]).toBe('1');
  });

  it('switches the CLI’s own auto memory off only for a run that switches native memory off', () => {
    vi.stubEnv(CLAUDE_DISABLE_AUTO_MEMORY_ENV, undefined);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const off = fakeSpawn();
    new ClaudeAdapter({ spawn: off.spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    const on = fakeSpawn();
    new ClaudeAdapter({ spawn: on.spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj', nativeMemoryOff: true },
      () => {},
    );

    expect(off.captured.env).not.toHaveProperty(CLAUDE_DISABLE_AUTO_MEMORY_ENV);
    expect(on.captured.env?.[CLAUDE_DISABLE_AUTO_MEMORY_ENV]).toBe('1');
  });

  it('hands over the browser tools only when the run’s option asks for them', () => {
    // 22 tool schemas in every prompt, and useless without the Chrome
    // extension — so this is one of the adapter's options, off by default, and
    // the CLI's own variable is set from it alone.
    //
    // The AMBIENT value is set to `1` on purpose: Claude Code exports it in its
    // own terminal, so a daemon launched from one inherits it, and the "off"
    // half passing is what proves the isolation strip keeps that inheritance
    // from deciding for the user.
    const previousInherited = process.env[CLAUDE_BROWSER_TOOLS_ENV];
    process.env[CLAUDE_BROWSER_TOOLS_ENV] = '1';
    // Registered as the daemon registers every adapter — what arms the strip.
    new AgentAdapterRegistry([new ClaudeAdapter()]);
    try {
      const off = fakeSpawn();
      new ClaudeAdapter({ spawn: off.spawn, waitForMcpServers: false }).start(
        { prompt: 'go', cwd: '/proj' },
        () => {},
      );
      expect(off.captured.env).not.toHaveProperty(CLAUDE_BROWSER_TOOLS_ENV);

      const on = fakeSpawn();
      new ClaudeAdapter({ spawn: on.spawn, waitForMcpServers: false }).start(
        {
          prompt: 'go',
          cwd: '/proj',
          agentOptions: { [CLAUDE_BROWSER_TOOLS_OPTION]: true },
        },
        () => {},
      );
      expect(on.captured.env?.[CLAUDE_BROWSER_TOOLS_ENV]).toBe('1');
    } finally {
      if (previousInherited === undefined) {
        delete process.env[CLAUDE_BROWSER_TOOLS_ENV];
      } else {
        process.env[CLAUDE_BROWSER_TOOLS_ENV] = previousInherited;
      }
    }
  });

  it('keeps the launching shell’s own session and profile out of every turn', () => {
    // Both are set when the app was launched from inside a Claude Code
    // session. Inherited, the first binds a spawned conversation to that OUTER
    // session and the second runs a chat that named no profile under whatever
    // account the shell chose for itself.
    expect(new ClaudeAdapter().getConfig().auth.isolatedEnvKeys).toEqual(
      expect.arrayContaining(['CLAUDE_CODE_SESSION_ID', CLAUDE_CONFIG_DIR_ENV]),
    );
    const previousSession = process.env.CLAUDE_CODE_SESSION_ID;
    const previousProfile = process.env[CLAUDE_CONFIG_DIR_ENV];
    process.env.CLAUDE_CODE_SESSION_ID = 'outer-session';
    process.env[CLAUDE_CONFIG_DIR_ENV] = '/Users/me/.claude-shell';
    // Registered as the daemon registers every adapter — what arms the strip.
    new AgentAdapterRegistry([new ClaudeAdapter()]);
    try {
      const turn = fakeSpawn();
      new ClaudeAdapter({ spawn: turn.spawn, waitForMcpServers: false }).start(
        { prompt: 'go', cwd: '/proj' },
        () => {},
      );
      expect(turn.captured.env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID');
      expect(turn.captured.env).not.toHaveProperty(CLAUDE_CONFIG_DIR_ENV);
    } finally {
      if (previousSession === undefined) {
        delete process.env.CLAUDE_CODE_SESSION_ID;
      } else {
        process.env.CLAUDE_CODE_SESSION_ID = previousSession;
      }
      if (previousProfile === undefined) {
        delete process.env[CLAUDE_CONFIG_DIR_ENV];
      } else {
        process.env[CLAUDE_CONFIG_DIR_ENV] = previousProfile;
      }
    }
  });

  it('reads `mcp list` under that same config directory', async () => {
    // The listing describes the servers a TURN will load, and those are
    // configured per profile — so a listing taken under the default profile
    // would name servers this run never starts.
    const { groupSpawnFn, captured } = fakeListing(
      'No MCP servers configured\n',
    );
    await new ClaudeAdapter({ groupSpawnFn }).listMcpServers({
      cwd: '/proj',
      configDir: '/profiles/work',
    });

    expect(captured.args).toEqual(['mcp', 'list']);
    expect(
      (captured.options?.env as Record<string, string> | undefined)?.[
        CLAUDE_CONFIG_DIR_ENV
      ],
    ).toBe('/profiles/work');
  });

  it('leaves the config-dir env off a listing that names none', async () => {
    const { groupSpawnFn, captured } = fakeListing(
      'No MCP servers configured\n',
    );
    await new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/proj' });
    expect(captured.args).toEqual(['mcp', 'list']);
    expect(captured.options?.env).not.toHaveProperty(CLAUDE_CONFIG_DIR_ENV);
  });

  it('lists exactly the probe-verified effort vocabulary, ultracode included', () => {
    const levels = new ClaudeAdapter().listEfforts().map((e) => e.id);
    // `--help` names only the first five; ultracode is accepted but
    // undocumented, so a list scraped from help output would be missing it.
    expect(levels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ]);
    // A rejected value the CLI warns about must never be offered.
    expect(levels).not.toContain('ultrathink');
  });

  it('passes --resume when a prior session id is supplied', () => {
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj', resumeSessionId: 'prev-1' },
      () => {},
    );
    expect(captured.args).toEqual(
      expect.arrayContaining(['--resume', 'prev-1']),
    );
  });

  it('emits turn_cancelled when the process is killed', async () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj' },
      (e) => events.push(e),
    );
    handle.cancel();
    child.emit('close', null, 'SIGTERM');
    await handle.done;

    expect(child.killSignal).toBe('SIGTERM');
    expect(events).toEqual([{ type: 'turn_cancelled' }]);
  });

  it('emits an error event on a non-zero exit with the stderr tail', async () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj' },
      (e) => events.push(e),
    );
    child.stderr.emitData('not authenticated');
    child.emit('close', 1, null);
    await handle.done;

    expect(events).toEqual([
      {
        type: 'error',
        message: 'claude exited with code 1: not authenticated',
        detail: { exitCode: 1 },
      },
    ]);
  });

  it('marks an expired-session failure as curable by signing in', async () => {
    // The reported failure, verbatim. Without this it reaches the user as a
    // stack-trace row with nothing to do about it.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj' },
      (e) => events.push(e),
    );
    child.stderr.emitData(
      'Failed to authenticate: OAuth session expired and could not be refreshed',
    );
    child.emit('close', 1, null);
    await handle.done;

    expect(events).toEqual([
      {
        type: 'error',
        message: expect.stringContaining('OAuth session expired'),
        recovery: 'cli-login',
        detail: { exitCode: 1 },
      },
    ]);
  });

  it('marks an expired OAuth token, in the wording a headless turn gets, as curable by signing in', async () => {
    // REPORTED: every message in a chat failed with this while Settings read
    // "signed in", and only signing out and back in fixed it — because the row
    // offered Retry alone. A `-p` turn never carries the `/login` wording.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj' },
      (e) => events.push(e),
    );
    child.stdout.emitData(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result:
          'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
      })}\n`,
    );
    child.emit('close', 1, null);
    await handle.done;

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', recovery: 'cli-login' }),
    );
  });

  it('does not offer the account sign-in for an MCP server that failed to authenticate', () => {
    // The bare `Failed to authenticate` is also how a SERVER's failure reads,
    // and `claude auth login` does not cure that one.
    const { spawn } = fakeSpawn();
    const adapter = new ClaudeAdapter({ spawn, waitForMcpServers: false });

    expect(
      adapter.errorRecovery(
        'Failed to authenticate: linear needs authentication — run claude mcp login linear',
      ),
    ).toBeNull();
  });

  it('marks a never-signed-in profile as curable by signing in too', async () => {
    // The commoner half, and the one the marker list missed: a profile with no
    // session at all rather than a lapsed one. Captured verbatim from a live
    // run pointed at an empty configDir — the run settled `failed` correctly
    // and the row offered nothing, which is precisely the case a Sign-in
    // control exists for.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj' },
      (e) => events.push(e),
    );
    child.stdout.emitData(
      `${JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: 'Not logged in · Please run /login',
      })}\n`,
    );
    child.emit('close', 1, null);
    await handle.done;

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        recovery: 'cli-login',
      }),
    );
  });

  it.each([
    ['an unrelated failure', 'ENOSPC: no space left on device'],
    // The sharp one. The CLI uses this same prefix for an MCP SERVER it could
    // not authenticate, so a marker of `'Failed to authenticate'` would offer
    // `claude auth login` for a failure only `claude mcp login <server>` fixes
    // — a wrong cure, which is worse than none. Delete the narrowing and this
    // case goes green-to-red.
    [
      'an MCP server auth failure',
      'Failed to authenticate with MCP server "linear"',
    ],
  ])('leaves %s with no cure to offer', async (_label, stderr) => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj' },
      (e) => events.push(e),
    );
    child.stderr.emitData(stderr);
    child.emit('close', 1, null);
    await handle.done;

    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { recovery?: string }).recovery).toBeUndefined();
  });
});

describe('ClaudeAdapter approval seam (ask mode)', () => {
  const CONTROL_REQUEST =
    '{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"a.txt"}}}\n';

  it('logs the unmodelled subtype from the base class and keeps it off the turn', () => {
    // The mapper hands it back; `AgentAdapter.start` is the one caller that
    // logs it. It must NOT reach the consumer — a diagnostic is not an event.
    const warnings: string[] = [];
    const fake = fakeSpawn();
    const seen: AgentEvent[] = [];
    new ClaudeAdapter({
      spawn: fake.spawn,
      logger: { warn: (m) => warnings.push(m) },
    }).start({ prompt: 'p', cwd: '/proj' }, (event) => seen.push(event));
    fake.child.stdout.emitData(
      '{"type":"control_request","request_id":"r","request":{"subtype":"initialize"}}\n',
    );
    expect(seen).toEqual([]);
    expect(warnings).toEqual([
      "claude: unmodelled control_request subtype 'initialize' — dropped",
    ]);
  });

  it('adds the stdio permission flags in ask mode and none in plain chat', () => {
    const ask = fakeSpawn();
    new ClaudeAdapter({ spawn: ask.spawn }).start(
      { prompt: 'p', cwd: '/proj', approvalMode: 'ask' },
      () => {},
    );
    expect(ask.captured.args).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'default',
        '--permission-prompt-tool',
        'stdio',
      ]),
    );

    // A turn with NO mode is a geniro-internal probe (`ChatService` resolves a
    // user's null approval to `ask` before it ever reaches an adapter), so it
    // keeps the lean argv: no dialogue, no bypass, nothing to answer.
    const plain = fakeSpawn();
    new ClaudeAdapter({ spawn: plain.spawn }).start(
      { prompt: 'p', cwd: '/proj' },
      () => {},
    );
    expect(plain.captured.args).not.toEqual(
      expect.arrayContaining(['--permission-prompt-tool']),
    );
    expect(plain.captured.args).not.toEqual(
      expect.arrayContaining(['--dangerously-skip-permissions']),
    );
  });

  it('maps acceptEdits and plan to their permission modes with the stdio prompt tool', () => {
    for (const mode of ['acceptEdits', 'plan'] as const) {
      const { spawn, captured } = fakeSpawn();
      new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
        { prompt: 'p', cwd: '/proj', approvalMode: mode },
        () => {},
      );
      expect(captured.args).toEqual(
        expect.arrayContaining([
          '--permission-mode',
          mode,
          '--permission-prompt-tool',
          'stdio',
        ]),
      );
      expect(captured.args).not.toEqual(
        expect.arrayContaining(['--dangerously-skip-permissions']),
      );
    }
  });

  it('keeps stdin open for the acceptEdits and plan stdio-dialogue modes', () => {
    for (const mode of ['acceptEdits', 'plan'] as const) {
      const { spawn, child } = fakeSpawn();
      const endSpy = vi.spyOn(child.stdin, 'end');
      new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
        { prompt: 'p', cwd: '/proj', approvalMode: mode },
        () => {},
      );
      expect(child.stdin.written).toContain('"type":"user"');
      expect(endSpy).not.toHaveBeenCalled();
    }
  });

  it('bypasses permissions in auto mode and appends the system prompt', () => {
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      {
        prompt: 'p',
        cwd: '/proj',
        approvalMode: 'auto',
        systemPrompt: 'You are the reviewer.',
      },
      () => {},
    );
    expect(captured.args).toEqual(
      expect.arrayContaining(['--dangerously-skip-permissions']),
    );
    // The role now rides BEHIND the host preamble every user-facing turn
    // carries. Spelled out rather than rebuilt with turnInstructionParts,
    // which is the function under test one layer down — asserting against it
    // here would pass whatever that function did.
    expect(captured.args).toEqual(
      expect.arrayContaining([
        '--append-system-prompt',
        `${HOST_BLOCK}\n\nYou are the reviewer.`,
      ]),
    );
  });

  it('carries the user’s custom instructions into argv, after the host preamble', () => {
    // The chat path's whole delivery: the user types prose in Settings, it is
    // snapshotted onto the run, and it has to reach the CLI. Order matters as
    // much as presence — the preamble states facts about the host, and the
    // user's text comes after so it can qualify them.
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      {
        prompt: 'p',
        cwd: '/proj',
        customInstructions: 'Always answer in British English.',
      },
      () => {},
    );

    const idx = captured.args!.indexOf('--append-system-prompt');
    expect(captured.args![idx + 1]).toBe(
      `${HOST_BLOCK}\n\nAlways answer in British English.`,
    );
  });

  it('carries a team member’s instruction blocks into argv, between the user’s text and the role', () => {
    // The ONE line that delivers an instruction block to a CLI is
    // `instructionBlocks: input.instructionBlocks` inside composeSystemPrompt.
    // Every other test of the feature observes the AgentTurnInput object or
    // the pure joiner, one layer below it — delete that line and they all stay
    // green while no agent ever receives a block. This is the assertion that
    // fails, and the order it pins is the precedence: a block is written once
    // for several agents, so the member's own instructions still outrank it.
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      {
        prompt: 'p',
        cwd: '/proj',
        customInstructions: 'Always answer in British English.',
        instructionBlocks: 'Prefer short sentences.',
        systemPrompt: 'You are the reviewer.',
      },
      () => {},
    );

    const idx = captured.args!.indexOf('--append-system-prompt');
    expect(captured.args![idx + 1]).toBe(
      `${HOST_BLOCK}\n\nAlways answer in British English.\n\nPrefer short sentences.\n\nYou are the reviewer.`,
    );
  });

  it('carries a card’s task instructions into argv, right after the user’s own text', () => {
    // `taskInstructions: input.taskInstructions` inside composeSystemPrompt is
    // the one line delivering a card's label block and report ask to a CLI;
    // the specs above it observe only the turn input or the pure joiner. The
    // order pinned is user's own → the card's → the member's blocks.
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      {
        prompt: 'p',
        cwd: '/proj',
        customInstructions: 'Always answer in British English.',
        taskInstructions: 'LABEL BLOCK\n\nREPORT ASK',
        instructionBlocks: 'Prefer short sentences.',
      },
      () => {},
    );

    const idx = captured.args!.indexOf('--append-system-prompt');
    expect(captured.args![idx + 1]).toBe(
      `${HOST_BLOCK}\n\nAlways answer in British English.\n\nLABEL BLOCK\n\nREPORT ASK\n\nPrefer short sentences.`,
    );
  });

  it('sends the preamble alone when the user has typed no instructions', () => {
    // The default state for every existing chat, and the reason the preamble is
    // built in rather than seeded into the settings box: an empty box must
    // still leave the agent knowing where its words land.
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'p', cwd: '/proj' },
      () => {},
    );

    const idx = captured.args!.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(captured.args![idx + 1]).toBe(HOST_BLOCK);
  });

  it('withholds the preamble from geniro’s OWN probe, leaving its argv bare', () => {
    // An `internalProbe` turn is parsed, never rendered — the capability reads
    // behind `listReportedCommands` and the permission-mode probe — so there is
    // no transcript for the preamble to describe. Two costs if it rides along:
    // ~1.1KB of argv on every cold probe, and, on the mode probe specifically,
    // a flag under test that is not the flag under test — a probe asking
    // whether `--permission-mode X` is accepted must not be able to fail for
    // an unrelated argument.
    //
    // The control below is what makes this a pin rather than a claim: the two
    // turns differ ONLY in the flag, so an implementation that stopped reading
    // it fails here instead of quietly re-adding the block.
    const probe = fakeSpawn();
    new ClaudeAdapter({ spawn: probe.spawn, waitForMcpServers: false }).start(
      { prompt: 'p', cwd: '/proj', approvalMode: 'auto', internalProbe: true },
      () => {},
    );
    const user = fakeSpawn();
    new ClaudeAdapter({ spawn: user.spawn, waitForMcpServers: false }).start(
      { prompt: 'p', cwd: '/proj', approvalMode: 'auto' },
      () => {},
    );

    expect(probe.captured.args).not.toContain('--append-system-prompt');
    expect(user.captured.args).toContain('--append-system-prompt');
  });

  it('still withholds it from a probe that carries the user’s instructions', () => {
    // The composition is `includePreamble: internalProbe !== true`, so a
    // probe reaching `composeSystemPrompt` with a non-empty neighbour is the
    // one input that distinguishes "the preamble is withheld" from "the whole
    // block happens to be empty". Without it, an implementation that dropped
    // the probe arm and relied on probes carrying nothing else would pass the
    // test above — and then ship the user's standing prose into every
    // capability read.
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      {
        prompt: 'p',
        cwd: '/proj',
        internalProbe: true,
        customInstructions: 'Always answer in British English.',
      },
      () => {},
    );

    const idx = captured.args!.indexOf('--append-system-prompt');
    expect(captured.args![idx + 1]).toBe('Always answer in British English.');
    expect(captured.args![idx + 1]).not.toContain(GENIRO_UI_PREAMBLE);
  });

  it('gives an auto turn the stdio dialogue when it must be able to ask the user', () => {
    // --dangerously-skip-permissions STRIPS AskUserQuestion (probe-verified),
    // so an auto turn that wants the question channel spawns on the dialogue
    // instead. The daemon then stands in for the bypass at its approval seam.
    const { spawn, captured, child } = fakeSpawn();
    const endSpy = vi.spyOn(child.stdin, 'end');
    new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      {
        prompt: 'p',
        cwd: '/proj',
        approvalMode: 'auto',
        allowUserQuestions: true,
      },
      () => {},
    );

    expect(captured.args).not.toContain('--dangerously-skip-permissions');
    expect(captured.args).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'default',
        '--permission-prompt-tool',
        'stdio',
      ]),
    );
    // The verdict needs a way back in, so stdin must NOT close after the prompt.
    expect(endSpy).not.toHaveBeenCalled();
  });

  it('still bypasses permissions for an auto turn that will not ask', () => {
    // The reversion pin for the branch above — and the stdin half the older
    // auto-mode argv test never asserted.
    const { spawn, captured, child } = fakeSpawn();
    const endSpy = vi.spyOn(child.stdin, 'end');
    new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'p', cwd: '/proj', approvalMode: 'auto' },
      () => {},
    );

    expect(captured.args).toContain('--dangerously-skip-permissions');
    expect(captured.args).not.toContain('--permission-prompt-tool');
    expect(endSpy).toHaveBeenCalled();
  });

  it('leaves a turn with no approval mode byte-identical when asking is allowed', () => {
    // A turn carrying no mode (a geniro-internal turn) must keep the CLI's own
    // defaults and no permission flags, even though every chat now asks for
    // the question channel.
    const plain = fakeSpawn();
    new ClaudeAdapter({ spawn: plain.spawn }).start(
      { prompt: 'p', cwd: '/proj' },
      () => {},
    );
    const asking = fakeSpawn();
    const endSpy = vi.spyOn(asking.child.stdin, 'end');
    new ClaudeAdapter({ spawn: asking.spawn }).start(
      { prompt: 'p', cwd: '/proj', allowUserQuestions: true },
      () => {},
    );

    expect(asking.captured.args).toEqual(plain.captured.args);
    expect(asking.captured.args).not.toContain('--permission-mode');
    expect(endSpy).toHaveBeenCalled();
  });

  it('sends a probe’s prompt straight out instead of holding it for MCP', () => {
    // The gate exists because a first prompt written before the CLI's servers
    // finish dialling loses their tools for the whole conversation. A probe
    // has no such stake: it reads one `system/init` line and is cancelled, so
    // it never reaches a tool and there is nothing for a tool surface to be
    // missing from — while the wait itself costs up to the full deadline on
    // every cold capability read.
    //
    // Observed through WHEN the prompt lands, which is what the gate actually
    // changes: held, the user message goes out on a later tick, so by the time
    // `start()` returns the held turn's stdin carries only the gate's own
    // `mcp_status` poll. Matched on the user-message envelope rather than on
    // the prompt text, because that poll is stdin traffic too and a loose
    // substring finds itself in it. The mode probe names a mode and isolates
    // nothing, so the two pre-existing exemptions both miss it — this passes
    // ONLY on the `internalProbe` arm, and the control is the same turn
    // without it.
    const probe = fakeSpawn();
    new ClaudeAdapter({ spawn: probe.spawn }).start(
      { prompt: 'p', cwd: '/proj', approvalMode: 'plan', internalProbe: true },
      () => {},
    );
    const user = fakeSpawn();
    new ClaudeAdapter({ spawn: user.spawn }).start(
      { prompt: 'p', cwd: '/proj', approvalMode: 'plan' },
      () => {},
    );

    expect(probe.child.stdin.written).toContain('"type":"user"');
    expect(user.child.stdin.written).not.toContain('"type":"user"');
  });

  it('reports the tool it asks the user with, so no service spells the name', () => {
    expect(new ClaudeAdapter().getConfig().questionToolName).toBe(
      'AskUserQuestion',
    );
  });

  it('declares that it reports its background sub-agents, steps included', () => {
    // Claude reports delegates via `parent_tool_use_id` on the stream, and that
    // id carries their WORK as well as their existence — so both reasons are
    // null and the block opens onto a real thread. The steps field is the half
    // that now gates rendering: non-null makes the card say why it is empty, so
    // a null here is the claim "this CLI's delegates speak for themselves".
    expect(new ClaudeAdapter().getConfig().subagents).toEqual({
      reports: true,
      unavailableReason: null,
      stepsUnavailableReason: null,
      launchToolNames: ['Task', 'Agent'],
    });
  });

  it('names its artifact tool, which the run state lists publishes by', () => {
    expect(new ClaudeAdapter().getConfig().artifactToolNames).toEqual([
      'Artifact',
    ]);
  });

  it('degrades a PROVEN-unsupported acceptEdits to ask, and says so', () => {
    const resolved = new ClaudeAdapter().resolveApprovalMode('acceptEdits', {
      supported: { acceptEdits: false },
    });
    expect(resolved.mode).toBe('ask');
    expect(resolved.degradeReason).toContain('does not support acceptEdits');
  });

  it('keeps an UNPROBED acceptEdits, so a real rejection comes from the CLI', () => {
    // Absent ≠ false: nobody asked this binary, so degrading here would
    // pre-empt the CLI's own answer on a guess.
    const resolved = new ClaudeAdapter().resolveApprovalMode('acceptEdits', {
      supported: {},
    });
    expect(resolved).toEqual({ mode: 'acceptEdits', degradeReason: null });
  });

  it('never degrades plan — an executing fallback would invert what it promises', () => {
    // `plan` is probed exactly like acceptEdits, and a FAIL still must not turn
    // a no-execute mode into an executing 'ask'.
    const resolved = new ClaudeAdapter().resolveApprovalMode('plan', {
      supported: { plan: false },
    });
    expect(resolved).toEqual({ mode: 'plan', degradeReason: null });
  });

  it('declares the modes it honours, which of them are empirical, and how calls reach it', () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.getConfig().approval.modes).toEqual([
      'auto',
      'ask',
      'acceptEdits',
      'plan',
    ]);
    // Only these two cost a run a probe turn — the pair this adapter's own
    // probe verdict answers for.
    expect(adapter.getConfig().approval.probedModes).toEqual([
      'acceptEdits',
      'plan',
    ]);
    // The endpoint rides --mcp-config per turn: no machine trust to establish,
    // and nothing written into the user's cwd.
    expect(adapter.getConfig().mcp.callToolsRequireTrustProbe).toBe(false);
    expect(adapter.getConfig().mcp.endpointRequiresCwdConfig).toBe(false);
  });

  it('asks for token-level output only when the turn wants it', () => {
    const off = fakeSpawn();
    new ClaudeAdapter({ spawn: off.spawn }).start(
      { prompt: 'p', cwd: '/proj' },
      () => {},
    );
    const on = fakeSpawn();
    new ClaudeAdapter({ spawn: on.spawn }).start(
      { prompt: 'p', cwd: '/proj', streamPartials: true },
      () => {},
    );

    expect(off.captured.args).not.toContain('--include-partial-messages');
    expect(on.captured.args).toContain('--include-partial-messages');
  });

  it('turns a stream_event into a live text increment, never a message', () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'p', cwd: '/proj', streamPartials: true },
      (e) => events.push(e),
    );

    child.stdout.emitData(
      `${JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'The sea' },
        },
      })}\n`,
    );

    expect(events).toEqual([{ type: 'text_delta', text: 'The sea' }]);
  });

  it('keeps stdin open in ask mode, answers via control_response, closes on the terminal event', async () => {
    const { spawn, child } = fakeSpawn();
    const endSpy = vi.spyOn(child.stdin, 'end');
    const events: AgentEvent[] = [];
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'p', cwd: '/proj', approvalMode: 'ask' },
      (e) => events.push(e),
    );

    // Prompt written, stdin still open for the control dialogue.
    expect(child.stdin.written).toContain('"type":"user"');
    expect(endSpy).not.toHaveBeenCalled();

    child.stdout.emitData(CONTROL_REQUEST);
    expect(events.at(-1)).toMatchObject({
      type: 'approval_request',
      id: 'req-1',
    });

    handle.respondApproval('req-1', true, { file_path: 'a.txt' });
    const responseLine = child.stdin.written
      .split('\n')
      .filter(Boolean)
      .at(-1)!;
    expect(JSON.parse(responseLine)).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: { behavior: 'allow', updatedInput: { file_path: 'a.txt' } },
      },
    });

    // Terminal result closes the kept-open stdin so the CLI can exit.
    child.stdout.emitData(
      '{"type":"result","is_error":false,"stop_reason":"end_turn"}\n',
    );
    expect(endSpy).toHaveBeenCalledOnce();
    child.emit('close', 0, null);
    await handle.done;
  });

  it('encodes a denial with behavior deny', async () => {
    const { spawn, child } = fakeSpawn();
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'p', cwd: '/proj', approvalMode: 'ask' },
      () => {},
    );
    child.stdout.emitData(CONTROL_REQUEST);
    handle.respondApproval('req-1', false);
    const responseLine = child.stdin.written
      .split('\n')
      .filter(Boolean)
      .at(-1)!;
    expect(JSON.parse(responseLine).response.response.behavior).toBe('deny');
    child.emit('close', 0, null);
    await handle.done;
  });

  it("sends a picked option's permission updates with the allow, and none without one", async () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'p', cwd: '/proj', approvalMode: 'ask' },
      (e) => events.push(e),
    );
    const request = (id: string): string =>
      `${JSON.stringify({
        type: 'control_request',
        request_id: id,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'touch a' },
          permission_suggestions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'touch a' }],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ],
        },
      })}\n`;
    const lastResponse = (): Record<string, unknown> =>
      JSON.parse(child.stdin.written.split('\n').filter(Boolean).at(-1)!)
        .response.response;

    child.stdout.emitData(request('req-s'));
    const card = events.at(-1);
    const session =
      card?.type === 'approval_request'
        ? card.options?.find((option) => option.scope === 'session')
        : undefined;
    expect(session).toBeDefined();
    handle.respondApproval('req-s', true, { command: 'touch a' }, session);
    expect(lastResponse()).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'touch a' },
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'touch a' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    });

    // A one-time allow — which is all an auto-approval ever sends — teaches
    // the CLI nothing.
    child.stdout.emitData(request('req-o'));
    handle.respondApproval('req-o', true, { command: 'touch a' });
    expect(lastResponse()).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'touch a' },
    });
    child.emit('close', 0, null);
    await handle.done;
  });
});

describe('ClaudeAdapter binary override', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('spawns the cliPaths override instead of the bare binary', () => {
    vi.stubEnv(
      'GENIRO_CLI_PATHS',
      JSON.stringify({ claude: '/opt/tools/claude' }),
    );
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'p', cwd: '/proj' },
      () => {},
    );
    expect(captured.command).toBe('/opt/tools/claude');
  });
});

describe('ClaudeAdapter instruction file delivery', () => {
  const LONG_PROMPT = 'x'.repeat(CLAUDE_SYSTEM_PROMPT_INLINE_MAX_BYTES + 1);
  const INPUT: AgentTurnInput = {
    prompt: 'p',
    cwd: '/proj',
    internalProbe: true,
    systemPrompt: LONG_PROMPT,
  };

  it.each([
    CLAUDE_SYSTEM_PROMPT_INLINE_MAX_BYTES - 1,
    CLAUDE_SYSTEM_PROMPT_INLINE_MAX_BYTES,
  ])('keeps a %i-byte instruction block inline', async (bytes) => {
    const { spawn, child, captured } = fakeSpawn();
    const dir = tempDir('claude-instructions-');
    const prompt = 'x'.repeat(bytes);
    const handle = new ClaudeAdapter({ spawn, mcpConfigDir: dir }).start(
      { ...INPUT, systemPrompt: prompt },
      () => {},
    );

    const index = captured.args!.indexOf(CLAUDE_APPEND_SYSTEM_PROMPT_FLAG);
    expect(index).toBeGreaterThan(-1);
    expect(captured.args![index + 1]).toBe(prompt);
    expect(captured.args).not.toContain(CLAUDE_APPEND_SYSTEM_PROMPT_FILE_FLAG);
    expect(readdirSync(dir)).toEqual([]);
    child.emit('close', 0, null);
    await handle.done;
  });

  it.each(['exit', 'cancel'])(
    'uses a 0600 file above the UTF-8 byte threshold and removes it on %s',
    async (ending) => {
      const { spawn, child, captured } = fakeSpawn();
      const prompt = 'é'.repeat(CLAUDE_SYSTEM_PROMPT_INLINE_MAX_BYTES / 2 + 1);
      const handle = new ClaudeAdapter({
        spawn,
        mcpConfigDir: tempDir('claude-instructions-'),
      }).start({ ...INPUT, systemPrompt: prompt }, () => {});

      const index = captured.args!.indexOf(
        CLAUDE_APPEND_SYSTEM_PROMPT_FILE_FLAG,
      );
      expect(index).toBeGreaterThan(-1);
      const path = captured.args![index + 1]!;
      expect(captured.args).not.toContain(CLAUDE_APPEND_SYSTEM_PROMPT_FLAG);
      expect(captured.args).not.toContain(prompt);
      expect(readFileSync(path, 'utf8')).toBe(prompt);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      if (ending === 'cancel') {
        handle.cancel();
      }
      child.emit(
        'close',
        ending === 'exit' ? 0 : null,
        ending === 'exit' ? null : 'SIGTERM',
      );
      await handle.done;
      await new Promise((resolve) => setImmediate(resolve));
      expect(existsSync(path)).toBe(false);
    },
  );

  it('writes the composed instructions including the host preamble', async () => {
    const { spawn, child, captured } = fakeSpawn();
    const handle = new ClaudeAdapter({
      spawn,
      mcpConfigDir: tempDir('claude-instructions-'),
    }).start(
      { ...INPUT, internalProbe: false, customInstructions: 'custom' },
      () => {},
    );

    const index = captured.args!.indexOf(CLAUDE_APPEND_SYSTEM_PROMPT_FILE_FLAG);
    const content = readFileSync(captured.args![index + 1]!, 'utf8');
    expect(content).toBe(`${HOST_BLOCK}\n\ncustom\n\n${LONG_PROMPT}`);
    child.emit('close', 0, null);
    await handle.done;
  });

  it('keeps the file through turns, reuses content despite different file names, and refuses changed instructions', async () => {
    class PreparedAdapter extends ClaudeAdapter {
      prepare(input: AgentTurnInput): (() => void) | undefined {
        return this.prepareTurn(input);
      }
    }
    const fake = fakeSpawn();
    const spawn = vi.fn(fake.spawn);
    const dir = tempDir('claude-instructions-');
    const adapter = new PreparedAdapter({
      spawn,
      mcpConfigDir: dir,
      waitForMcpServers: false,
    });
    const input = { ...INPUT, approvalMode: 'ask' as const };
    const session = adapter.startSession(input, { runScoped: true });
    const path =
      fake.captured.args![
        fake.captured.args!.indexOf(CLAUDE_APPEND_SYSTEM_PROMPT_FILE_FLAG) + 1
      ]!;
    const first = session.startTurn(input, () => {});
    fake.child.stdout.emitData(
      '{"type":"result","is_error":false,"result":"ok","stop_reason":"end_turn"}\n',
    );
    await first?.done;
    expect(existsSync(path)).toBe(true);

    const next = { ...input, prompt: 'next' };
    const discardUnused = adapter.prepare(next);
    const files = readdirSync(dir);
    expect(files).toHaveLength(2);
    const second = session.startTurn(next, () => {});
    expect(second).not.toBeNull();
    expect(spawn).toHaveBeenCalledOnce();
    fake.child.stdout.emitData(
      '{"type":"result","is_error":false,"result":"ok","stop_reason":"end_turn"}\n',
    );
    await second?.done;
    expect(
      session.startTurn(
        { ...next, systemPrompt: `${LONG_PROMPT} changed` },
        () => {},
      ),
    ).toBeNull();
    discardUnused?.();
    fake.child.emit('close', 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes the prompt file on a spawn failure', async () => {
    const dir = tempDir('claude-instructions-');
    const spawn: SpawnFn = () => {
      throw new Error('EACCES');
    };
    const handle = new ClaudeAdapter({ spawn, mcpConfigDir: dir }).start(
      INPUT,
      () => {},
    );
    expect(readdirSync(dir)).toHaveLength(1);
    await handle.done;
    await new Promise((resolve) => setImmediate(resolve));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes the prompt file on a synchronous failure before spawning', () => {
    class ThrowingArgsAdapter extends ClaudeAdapter {
      protected override buildArgs(): string[] {
        throw new Error('bad argv');
      }
    }
    const dir = tempDir('claude-instructions-');
    expect(() =>
      new ThrowingArgsAdapter({ mcpConfigDir: dir }).start(INPUT, () => {}),
    ).toThrow('bad argv');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('cleans the MCP file if later instruction preparation fails', () => {
    class ThrowingCompositionAdapter extends ClaudeAdapter {
      protected override composeSystemPrompt(): string {
        throw new Error('instructions failed');
      }
    }
    const dir = tempDir('claude-instructions-');
    expect(() =>
      new ThrowingCompositionAdapter({ mcpConfigDir: dir }).start(
        {
          ...INPUT,
          mcpEndpoint: {
            url: 'http://127.0.0.1/mcp',
            token: 'secret',
            serverName: 'geniro-test',
          },
        },
        () => {},
      ),
    ).toThrow('instructions failed');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('sweeps prompt and MCP files from a crashed daemon at boot', () => {
    const dir = tempDir('claude-instructions-');
    for (const name of ['system-prompt-old.txt', 'mcp-old.json', 'notes.txt']) {
      writeFileSync(join(dir, name), 'old');
    }
    new ClaudeAdapter({ mcpConfigDir: dir }).sweepStaleState();
    expect(readdirSync(dir)).toEqual(['notes.txt']);
  });
});

describe('ClaudeAdapter MCP config delivery (caller turns)', () => {
  const ENDPOINT = {
    url: 'http://127.0.0.1:4870/v1/mcp/run-1/orch',
    token: 'call-token-1',
    serverName: 'geniro-run-1',
  };
  const dirs: string[] = [];

  function mcpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'geniro-mcp-spec-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Wraps the real prepareTurn disposer so a spec can observe it ran exactly once. */
  class DisposerCountingAdapter extends ClaudeAdapter {
    disposeCalls = 0;
    protected override prepareTurn(
      input: AgentTurnInput,
    ): (() => void) | undefined {
      const dispose = super.prepareTurn(input);
      return dispose
        ? () => {
            this.disposeCalls += 1;
            dispose();
          }
        : undefined;
    }
  }

  /** Throws between prepareTurn and the spawn — the base start()'s "bad argv" catch path. */
  class ThrowingArgsAdapter extends DisposerCountingAdapter {
    protected override buildArgs(): string[] {
      throw new Error('bad argv');
    }
  }

  it('writes a per-turn 0600 config file, points argv at it, and injects MCP_TOOL_TIMEOUT', async () => {
    const { spawn, child, captured } = fakeSpawn();
    const dir = mcpDir();
    const handle = new ClaudeAdapter({ spawn, mcpConfigDir: dir }).start(
      { prompt: 'p', cwd: '/proj', mcpEndpoint: ENDPOINT },
      () => {},
    );
    const idx = captured.args!.indexOf('--mcp-config');
    expect(idx).toBeGreaterThan(-1);
    const configPath = captured.args![idx + 1]!;
    // NOT strict: an agent must see the same MCP servers a fresh claude
    // session in that folder sees, PLUS geniro's call surface. Restricting the
    // turn to our own config would also leave a caller member with no project
    // servers to switch off, making the MCP toggle meaningless there.
    expect(captured.args).not.toContain(CLAUDE_STRICT_MCP_CONFIG_FLAG);
    expect(configPath.startsWith(dir)).toBe(true);
    // The token travels IN the file (0600), never in argv.
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      mcpServers: {
        // The endpoint's own per-run name, not a shared key: the servers above
        // load beside this one, so a shared name could shadow one of theirs.
        [ENDPOINT.serverName]: {
          type: 'http',
          url: ENDPOINT.url,
          headers: { Authorization: 'Bearer call-token-1' },
          // Overrides the env var above for THIS server alone: a host tool
          // parks on a person, and half an hour is not long enough to step
          // away from one. The user's own servers keep the 30-minute default.
          timeout: GENIRO_MCP_TOOL_TIMEOUT_MS,
        },
      },
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(captured.args!.join(' ')).not.toContain('call-token-1');
    expect(captured.env?.MCP_TOOL_TIMEOUT).toBe(String(30 * 60_000));
    // The file dies with the turn.
    child.emit('close', 0, null);
    await handle.done;
    await new Promise((resolve) => setImmediate(resolve));
    expect(existsSync(configPath)).toBe(false);
  });

  it('disposes the config file when the turn settles via cancel, not just clean exit', async () => {
    const { spawn, child, captured } = fakeSpawn();
    const handle = new ClaudeAdapter({ spawn, mcpConfigDir: mcpDir() }).start(
      { prompt: 'p', cwd: '/proj', mcpEndpoint: ENDPOINT },
      () => {},
    );
    const idx = captured.args!.indexOf('--mcp-config');
    const configPath = captured.args![idx + 1]!;
    expect(existsSync(configPath)).toBe(true);
    // Cancel is a distinct settle path from a clean exit — the disposer must
    // run here too, or a live-token 0600 file leaks to tmp.
    handle.cancel();
    child.emit('close', null, 'SIGTERM');
    await handle.done;
    await new Promise((resolve) => setImmediate(resolve));
    expect(existsSync(configPath)).toBe(false);
  });

  it('disposes the config exactly once when the spawn throws (settled-handle path)', async () => {
    // runHeadlessCli absorbs a throwing SpawnFn into the handle contract: the
    // failure surfaces as an error event and `done` is already resolved — the
    // disposer must still ride that settled handle, or a spawn failure (bad
    // binary path, EACCES) leaks the live-token 0600 file to tmp.
    const dir = mcpDir();
    const events: AgentEvent[] = [];
    let spawnArgs: string[] | undefined;
    const spawn: SpawnFn = (_command, args) => {
      spawnArgs = args;
      throw new Error('EACCES');
    };
    const adapter = new DisposerCountingAdapter({ spawn, mcpConfigDir: dir });

    const handle = adapter.start(
      { prompt: 'p', cwd: '/proj', mcpEndpoint: ENDPOINT },
      (e) => events.push(e),
    );

    expect(events).toEqual([
      { type: 'error', message: expect.stringContaining('failed to spawn') },
    ]);
    const idx = spawnArgs!.indexOf('--mcp-config');
    expect(idx).toBeGreaterThan(-1);
    const configPath = spawnArgs![idx + 1]!;
    // The disposer rides `done` as a microtask — still present synchronously,
    // gone once the settled handle's callback has run.
    expect(existsSync(configPath)).toBe(true);
    await handle.done;
    await new Promise((resolve) => setImmediate(resolve));
    expect(existsSync(configPath)).toBe(false);
    expect(adapter.disposeCalls).toBe(1);
  });

  it('a synchronous throw between prepareTurn and the handle disposes then rethrows', () => {
    // The base start()'s catch branch (agent-adapter.ts): no handle ever
    // exists, so without the catch's dispose the written config file would
    // leak with a green suite. buildArgs throwing is the documented "bad
    // argv" entry into that branch.
    const dir = mcpDir();
    const adapter = new ThrowingArgsAdapter({
      spawn: fakeSpawn().spawn,
      mcpConfigDir: dir,
    });

    expect(() =>
      adapter.start(
        { prompt: 'p', cwd: '/proj', mcpEndpoint: ENDPOINT },
        () => {},
      ),
    ).toThrow('bad argv');

    // prepareTurn wrote the file before the throw; the catch removed it.
    expect(readdirSync(dir)).toEqual([]);
    expect(adapter.disposeCalls).toBe(1);
  });

  /** A disposer that itself throws AFTER real cleanup — the rmSync-EACCES shape. */
  class ThrowingDisposerAdapter extends ClaudeAdapter {
    protected override prepareTurn(
      input: AgentTurnInput,
    ): (() => void) | undefined {
      const dispose = super.prepareTurn(input);
      return () => {
        dispose?.();
        throw new Error('EACCES: rm failed');
      };
    }
  }

  it('a throwing disposer on settle is logged as a warning, never an unhandled rejection', async () => {
    const warn = vi.fn();
    const { spawn, child } = fakeSpawn();
    const handle = new ThrowingDisposerAdapter({
      spawn,
      mcpConfigDir: mcpDir(),
      logger: { warn },
    }).start({ prompt: 'p', cwd: '/proj', mcpEndpoint: ENDPOINT }, () => {});

    child.emit('close', 0, null);
    await handle.done;
    await new Promise((resolve) => setImmediate(resolve));

    // The guard exists so cleanup failure cannot reject the settle chain —
    // deleting the catch would make this an unhandled rejection instead.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('disposer failed'),
    );
  });

  it('a throwing disposer in the sync-throw catch never masks the original error', () => {
    class ThrowingBothAdapter extends ThrowingDisposerAdapter {
      protected override buildArgs(): string[] {
        throw new Error('bad argv');
      }
    }
    const warn = vi.fn();
    const adapter = new ThrowingBothAdapter({
      spawn: fakeSpawn().spawn,
      mcpConfigDir: mcpDir(),
      logger: { warn },
    });

    // The ORIGINAL error propagates; the cleanup failure is only logged.
    expect(() =>
      adapter.start(
        { prompt: 'p', cwd: '/proj', mcpEndpoint: ENDPOINT },
        () => {},
      ),
    ).toThrow('bad argv');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('disposer failed'),
    );
  });

  it('honors a toolTimeoutMs override', () => {
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn, mcpConfigDir: mcpDir() }).start(
      {
        prompt: 'p',
        cwd: '/proj',
        mcpEndpoint: { ...ENDPOINT, toolTimeoutMs: 5000 },
      },
      () => {},
    );
    expect(captured.env?.MCP_TOOL_TIMEOUT).toBe('5000');
  });

  it('withholds the "May call" block from a turn that got no MCP endpoint', () => {
    // `callSurfacePrompt` is only true while the call tools are registered,
    // and the tools ride `mcpEndpoint`. The executor hands out no endpoint
    // when the run's per-member call token is already revoked or the server has
    // no bound port yet — a turn carrying the block but no `--mcp-config` is
    // instructed to route work through `call_agent` tools it does not have,
    // so its callees never run while the member still reports success.
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn, mcpConfigDir: mcpDir() }).start(
      {
        prompt: 'p',
        cwd: '/proj',
        systemPrompt: 'You are the router.',
        callSurfacePrompt:
          'May call (via the call_agent tool; await_agent collects async results):\n- worker',
        mcpEndpoint: null,
      },
      () => {},
    );
    expect(captured.args!.join(' ')).not.toContain('--mcp-config');
    const idx = captured.args!.indexOf('--append-system-prompt');
    expect(captured.args![idx + 1]).toBe(
      `${HOST_BLOCK}\n\nYou are the router.`,
    );
  });

  it('appends the "May call" block after the role when the endpoint IS delivered', () => {
    // The producer half of the split: before `callSurfacePrompt` existed the
    // executor pre-joined both into `systemPrompt`, so dropping the block from
    // this join would leave every caller silently unaware of its callees while
    // the whole suite stayed green.
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn, mcpConfigDir: mcpDir() }).start(
      {
        prompt: 'p',
        cwd: '/proj',
        systemPrompt: 'You are the router.',
        callSurfacePrompt: 'May call (via the call_agent tool):\n- worker',
        mcpEndpoint: ENDPOINT,
      },
      () => {},
    );
    const idx = captured.args!.indexOf('--append-system-prompt');
    expect(captured.args![idx + 1]).toBe(
      `${HOST_BLOCK}\n\nYou are the router.\n\nMay call (via the call_agent tool):\n- worker`,
    );
  });

  it("sends the run's stage map between the member's blocks and its instructions, and withholds it without an endpoint", () => {
    const turn = (mcpEndpoint: typeof ENDPOINT | null): string => {
      const { spawn, captured } = fakeSpawn();
      new ClaudeAdapter({ spawn, mcpConfigDir: mcpDir() }).start(
        {
          prompt: 'p',
          cwd: '/proj',
          instructionBlocks: 'TEAM SETTINGS',
          stageMapPrompt: 'This team has stages every run walks',
          systemPrompt: 'You are the router.',
          mcpEndpoint,
        },
        () => {},
      );
      const idx = captured.args!.indexOf('--append-system-prompt');
      return captured.args![idx + 1]!;
    };
    expect(turn(ENDPOINT)).toBe(
      `${HOST_BLOCK}\n\nTEAM SETTINGS\n\nThis team has stages every run walks\n\nYou are the router.`,
    );
    expect(turn(null)).toBe(
      `${HOST_BLOCK}\n\nTEAM SETTINGS\n\nYou are the router.`,
    );
  });

  it('sends the call block alone when a caller member has no instructions of its own', () => {
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn, mcpConfigDir: mcpDir() }).start(
      {
        prompt: 'p',
        cwd: '/proj',
        systemPrompt: null,
        callSurfacePrompt: 'May call (via the call_agent tool):\n- worker',
        mcpEndpoint: ENDPOINT,
      },
      () => {},
    );
    const idx = captured.args!.indexOf('--append-system-prompt');
    expect(captured.args![idx + 1]).toBe(
      `${HOST_BLOCK}\n\nMay call (via the call_agent tool):\n- worker`,
    );
  });

  it('a turn without mcpEndpoint keeps argv and env untouched', () => {
    // "Untouched" means the ADAPTER adds nothing: the daemon's own process
    // env may legitimately carry MCP_TOOL_TIMEOUT (it does under some dev
    // harnesses), and runHeadlessCli passes the parent env through — so the
    // variable is scrubbed for this test or the assertion measures the
    // environment, not the adapter.
    const hadTimeout = Object.prototype.hasOwnProperty.call(
      process.env,
      'MCP_TOOL_TIMEOUT',
    );
    const previousTimeout = process.env.MCP_TOOL_TIMEOUT;
    delete process.env.MCP_TOOL_TIMEOUT;
    try {
      const { spawn, captured } = fakeSpawn();
      new ClaudeAdapter({ spawn, mcpConfigDir: mcpDir() }).start(
        { prompt: 'p', cwd: '/proj', env: { FOO: 'bar' } },
        () => {},
      );
      expect(captured.args!.join(' ')).not.toContain('--mcp-config');
      expect(captured.env?.MCP_TOOL_TIMEOUT).toBeUndefined();
      expect(captured.env?.FOO).toBe('bar');
    } finally {
      if (hadTimeout) {
        process.env.MCP_TOOL_TIMEOUT = previousTimeout;
      }
    }
  });
});

describe('ClaudeAdapter image attachments', () => {
  it('sends attached images as base64 content blocks, ahead of the text', () => {
    // The CLI's stream-json input takes Messages-API content blocks, so an
    // image reaches the model directly — probe-verified against claude 2.1.220
    // in July 2026 (it described a magenta probe image without a tool call).
    // Handing over a path instead would cost a Read round-trip and put the
    // image behind the permission gate.
    const dir = mkdtempSync(join(tmpdir(), 'claude-images-'));
    const path = join(dir, 'shot.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(path, bytes);
    const { spawn, child } = fakeSpawn();
    const adapter = new ClaudeAdapter({ spawn, waitForMcpServers: false });

    try {
      adapter.start(
        {
          prompt: 'what is wrong here?',
          cwd: dir,
          images: [{ path, mediaType: 'image/png' }],
        },
        () => {},
      );

      const payload = JSON.parse(child.stdin.written) as {
        message: { content: { type: string; source?: { data: string } }[] };
      };
      expect(payload.message.content.map((block) => block.type)).toEqual([
        'image',
        'text',
      ]);
      expect(payload.message.content[0]?.source?.data).toBe(
        bytes.toString('base64'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends a text-only turn as a lone text block', () => {
    const { spawn, child } = fakeSpawn();
    const adapter = new ClaudeAdapter({ spawn, waitForMcpServers: false });

    adapter.start({ prompt: 'hello', cwd: tmpdir() }, () => {});

    const payload = JSON.parse(child.stdin.written) as {
      message: { content: { type: string }[] };
    };
    expect(payload.message.content).toEqual([{ type: 'text', text: 'hello' }]);
  });
});

describe('ClaudeAdapter — installed approval support', () => {
  function verdict(
    overrides: Partial<ClaudeModesVerdict> = {},
  ): ClaudeModesVerdict {
    return {
      acceptEdits: 'unknown',
      plan: 'unknown',
      version: null,
      probedAt: null,
      reason: null,
      ...overrides,
    };
  }

  /** An adapter whose probe answers `current` now and `settled` once awaited. */
  function withProbe(
    current: ClaudeModesVerdict,
    settled: () => Promise<ClaudeModesVerdict> = () => Promise.resolve(current),
  ): ClaudeAdapter {
    const modeProbe: ClaudeModeProbe = {
      capability: () => current,
      wireCapability: () => current,
      ensureVerdict: settled,
    };
    return new ClaudeAdapter({ modeProbe });
  }

  it('maps an unprobed mode to ABSENT, never to false', () => {
    // The distinction the whole degrade rests on: `false` means "proved
    // rejected" and degrades the turn, while absent means "nobody asked" and
    // must leave the requested mode alone. Collapsing `unknown` into `false`
    // would silently downgrade every turn on a machine that has not probed yet.
    const support = withProbe(verdict()).currentApprovalSupport();
    expect(support.supported).toEqual({});
    expect('acceptEdits' in support.supported).toBe(false);
  });

  it('maps a pass to true and a fail to false, per mode', () => {
    expect(
      withProbe(
        verdict({ acceptEdits: 'fail', plan: 'pass' }),
      ).currentApprovalSupport().supported,
    ).toEqual({ acceptEdits: false, plan: true });
  });

  it('carries only the probed modes — nothing is invented for the rest', () => {
    const support = withProbe(
      verdict({ acceptEdits: 'pass', plan: 'fail' }),
    ).currentApprovalSupport();
    expect(Object.keys(support.supported).sort()).toEqual([
      'acceptEdits',
      'plan',
    ]);
  });

  it('waits for the probe to settle when a turn needs a verdict', async () => {
    const settled = vi.fn(() =>
      Promise.resolve(verdict({ acceptEdits: 'fail', plan: 'pass' })),
    );
    const support = await withProbe(
      verdict(),
      settled,
    ).settledApprovalSupport();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(support.supported).toEqual({ acceptEdits: false, plan: true });
  });

  it('degrades a probe INFRASTRUCTURE failure to the current verdict instead of rejecting', async () => {
    // A probe temp-dir cleanup throw bubbling up must never fail the send it
    // was asked to inform: the unknown verdict keeps the requested mode.
    const support = await withProbe(verdict(), () =>
      Promise.reject(new Error('probe cleanup EBUSY')),
    ).settledApprovalSupport();
    expect(support).toEqual({ supported: {} });
  });

  it('publishes its own verdict as one row per probed mode', () => {
    expect(
      withProbe(
        verdict({
          acceptEdits: 'pass',
          plan: 'fail',
          version: '2.1.280 (Claude Code)',
          probedAt: 7,
          reason: 'installed claude does not support --permission-mode plan',
        }),
      ).approvalProbe(),
    ).toEqual({
      modes: [
        { mode: 'acceptEdits', status: 'pass', requiresPass: false },
        { mode: 'plan', status: 'fail', requiresPass: true },
      ],
      version: '2.1.280 (Claude Code)',
      probedAt: 7,
      reason: 'installed claude does not support --permission-mode plan',
    });
  });

  it('reads every probed mode as unknown when built without probe services', () => {
    // Standalone and spec construction: nothing can be proved, so nothing
    // degrades — the requested mode rides through to the CLI.
    const adapter = new ClaudeAdapter();
    expect(adapter.currentApprovalSupport()).toEqual({ supported: {} });
    expect(adapter.approvalProbe().modes).toEqual([
      { mode: 'acceptEdits', status: 'unknown', requiresPass: false },
      { mode: 'plan', status: 'unknown', requiresPass: true },
    ]);
  });
});

describe('ClaudeAdapter — the AskUserQuestion channel', () => {
  const QUESTION_INPUT = {
    questions: [
      {
        question: 'Which color?',
        header: 'Color',
        options: [{ label: 'Red' }, { label: 'Blue' }],
      },
    ],
  };

  it('projects the tool input into the CLI-agnostic question shape', () => {
    // The consumers (the team executor's Q&A bridge) hold this projection,
    // never claude's payload — so the header qualification and the FLAT option
    // list are the adapter's promise, not the executor's.
    expect(new ClaudeAdapter().questionFrom(QUESTION_INPUT)).toEqual({
      text: '[Color] Which color?',
      options: ['Red', 'Blue'],
    });
  });

  it('folds a lone question’s answer into AskUserQuestion `answers`', () => {
    // The answer must ride INSIDE the tool input claude gets back, with the
    // questions left intact — and on `answers`, keyed by the question's own
    // text. That is the channel the CLI renders as
    // `Your questions have been answered: "…"="Blue"`; `response` is the other
    // one and means the user replied INSTEAD of answering (probed on 2.1.226).
    expect(new ClaudeAdapter().withAnswer(QUESTION_INPUT, 'Blue')).toEqual({
      ...QUESTION_INPUT,
      answers: { [QUESTION_INPUT.questions[0]!.question]: 'Blue' },
    });
  });
});

describe('ClaudeAdapter — skills and commands on disk', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function writeSkill(root: string, name: string, frontmatter: string): void {
    const dir = join(root, '.claude', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\nBody.\n`);
  }

  function writeCommand(root: string, relPath: string, content: string): void {
    const path = join(root, '.claude', 'commands', relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function build(): AgentSkillsInput {
    return {
      cwd: tempDir('claude-cwd-'),
      homeDir: tempDir('claude-home-'),
      configDir: null,
    };
  }

  /** A skill/command inside a PROFILE, where they sit one level shallower. */
  function writeProfileSkill(
    profile: string,
    name: string,
    desc: string,
  ): void {
    const dir = join(profile, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + '/SKILL.md', `---\ndescription: ${desc}\n---\nBody.\n`);
  }

  it("scans the RUN's profile instead of the home dir, not beside it", async () => {
    // A config directory REPLACES the CLI's home configuration — it does not
    // add to it — so a chat on a profile must be offered that account's skills
    // and not the default account's. Measured on the reporter's machine,
    // `~/.claude` held 10 plugins and 2 skills while each of their profiles
    // held 7 plugins and a command of its own, none of which the `/` menu could
    // offer. Revert `listSkills` to the home dir and this fails twice over.
    const { cwd, homeDir } = build();
    const profile = tempDir('claude-profile-');
    writeSkill(homeDir, 'home-only', 'description: The default account');
    writeProfileSkill(profile, 'profile-only', 'This account');

    const found = await new ClaudeAdapter().listSkills({
      cwd,
      homeDir,
      configDir: profile,
    });

    expect(found.map((entry) => entry.name)).toEqual(['profile-only']);
  });

  it('keeps the home dir when the run names no profile', async () => {
    const { cwd, homeDir } = build();
    writeSkill(homeDir, 'home-only', 'description: The default account');

    const found = await new ClaudeAdapter().listSkills({
      cwd,
      homeDir,
      configDir: null,
    });

    expect(found.map((entry) => entry.name)).toEqual(['home-only']);
  });

  it('scans skills and commands from the project folder and from ~', async () => {
    const { cwd, homeDir } = build();
    writeSkill(cwd, 'deploy', 'name: deploy\ndescription: Ship it');
    writeCommand(cwd, 'review.md', '---\ndescription: Review\n---\n');
    writeSkill(homeDir, 'zsh-help', 'description: Home skill');
    writeCommand(homeDir, 'auth.md', 'Check auth flows.');

    expect(
      await new ClaudeAdapter().listSkills({ cwd, homeDir, configDir: null }),
    ).toEqual([
      {
        name: 'deploy',
        description: 'Ship it',
        kind: 'skill',
        source: 'project',
      },
      {
        name: 'review',
        description: 'Review',
        kind: 'command',
        source: 'project',
      },
      {
        name: 'zsh-help',
        description: 'Home skill',
        kind: 'skill',
        source: 'user',
      },
      {
        name: 'auth',
        description: 'Check auth flows.',
        kind: 'command',
        source: 'user',
      },
    ]);
  });

  it('returns project before user, and a skill before a same-named command', async () => {
    // The ORDER is the contract: the caller de-dupes first-occurrence-wins, so
    // this is what makes it keep the entry claude would actually run. The base
    // reproduces it by iterating roots outer, skills-then-commands inner.
    const { cwd, homeDir } = build();
    writeSkill(cwd, 'deploy', 'name: deploy\ndescription: Project skill');
    writeCommand(cwd, 'deploy.md', '---\ndescription: Project command\n---\n');
    writeSkill(homeDir, 'deploy', 'name: deploy\ndescription: User skill');

    const found = await new ClaudeAdapter().listSkills({
      cwd,
      homeDir,
      configDir: null,
    });
    expect(found.map((entry) => entry.description)).toEqual([
      'Project skill',
      'Project command',
      'User skill',
    ]);
  });

  it('returns [] when no skill/command directories exist at all', async () => {
    const { cwd, homeDir } = build();
    await expect(
      new ClaudeAdapter().listSkills({ cwd, homeDir, configDir: null }),
    ).resolves.toEqual([]);
  });

  it('never reads cursor-agent roots', async () => {
    const { cwd, homeDir } = build();
    mkdirSync(join(cwd, '.cursor', 'commands'), { recursive: true });
    writeFileSync(join(cwd, '.cursor', 'commands', 'fix.md'), 'Fix it.');

    await expect(
      new ClaudeAdapter().listSkills({ cwd, homeDir, configDir: null }),
    ).resolves.toEqual([]);
  });
});

describe('ClaudeAdapter — a delegate’s end on the live channel', () => {
  it('states a finished background delegate’s figures as final while its turn still runs', async () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      {
        prompt: 'go',
        cwd: '/proj',
        model: 'opus',
        configDir: '/profiles/work',
      },
      (e) => events.push(e),
    );

    child.stdout.emitData(
      [
        ...backgroundDelegateLines,
        taskNotification(BACKGROUND_AGENT, BACKGROUND_CALL, 'completed'),
      ]
        .map((line) => `${JSON.stringify(line)}\n`)
        .join(''),
    );

    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'delegate_progress',
          delegateId: BACKGROUND_CALL,
          final: true,
          figures: expect.objectContaining({ requests: 2 }),
        }),
      );
    });
    child.emit('close', 0, null);
    await handle.done;
  });
});

describe('ClaudeAdapter — live (token-level) stream support', () => {
  /** Answers the utility command with canned stdout, capturing its argv. */
  function fakeHelp(stdout: string | null): {
    execFileFn: typeof execFile;
    captured: { args?: readonly string[]; calls: number };
  } {
    const captured: { args?: readonly string[]; calls: number } = { calls: 0 };
    const execFileFn = ((
      _cmd: string,
      args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, out: string) => void,
    ) => {
      captured.args = args;
      captured.calls += 1;
      cb(stdout === null ? new Error('spawn failed') : null, stdout ?? '');
      return {} as ChildProcess;
    }) as unknown as typeof execFile;
    return { execFileFn, captured };
  }

  it('reads support off the binary that would reject the flag', async () => {
    // `--help` is the cheapest honest source: same binary, no account, no turn.
    const { execFileFn, captured } = fakeHelp(
      '  --verbose\n  --include-partial-messages   Include partial message chunks\n',
    );

    await expect(
      new ClaudeAdapter({ execFileFn }).supportsLiveStream(),
    ).resolves.toBe(true);
    expect(captured.args).toEqual(['--help']);
  });

  it('answers NO for an older CLI, so turns degrade to block streaming', async () => {
    // The whole point of asking: passing the flag to a CLI that does not know
    // it fails every turn on argv, which is far worse than not streaming.
    const { execFileFn } = fakeHelp('  --verbose\n  --model\n');

    await expect(
      new ClaudeAdapter({ execFileFn }).supportsLiveStream(),
    ).resolves.toBe(false);
  });

  it('answers NO when the binary could not be asked at all, and asks once', async () => {
    const { execFileFn, captured } = fakeHelp(null);
    const adapter = new ClaudeAdapter({ execFileFn });

    await expect(adapter.supportsLiveStream()).resolves.toBe(false);
    // Memoized per adapter instance: a second turn must not re-spawn --help.
    await expect(adapter.supportsLiveStream()).resolves.toBe(false);
    expect(captured.calls).toBe(1);
  });
});

describe('ClaudeAdapter — commands the CLI reports about itself', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  /** The `system/init` line the CLI reports its invokable set on. */
  function initLine(commands: string[]): string {
    return `${JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'probe-1',
      slash_commands: commands,
    })}\n`;
  }

  /**
   * The probe settings the adapter ACTUALLY SHIPS, read off its config rather
   * than off a const next door: config is what `listReportedCommands` reads, so
   * a value that stopped being wired into it fails here instead of passing
   * against a name nothing uses.
   */
  function shippedReportedCommands(): NonNullable<
    AdapterConfig['reportedCommands']
  > {
    const reportedCommands = new ClaudeAdapter().getConfig().reportedCommands;
    if (!reportedCommands) {
      throw new Error('claude must ship a reportedCommands probe config');
    }
    return reportedCommands;
  }

  /** A killable child plus what the probe turn was spawned with. */
  function probeSpawn(): {
    spawn: SpawnFn;
    child: KillableChild;
    captured: { command?: string; args?: string[]; cwd?: string };
    cwdExistedDuringTurn: () => boolean;
  } {
    const inner = fakeSpawn(new KillableChild());
    let existed = false;
    const spawn: SpawnFn = (command, args, options) => {
      existed = existsSync(options.cwd);
      return inner.spawn(command, args, options);
    };
    return {
      spawn,
      child: inner.child,
      captured: inner.captured,
      cwdExistedDuringTurn: () => existed,
    };
  }

  it('returns the commands the CLI reported about itself', async () => {
    const { spawn, child } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.stdout.emitData(initLine(['clear', 'compact', 'geniro:review']));

    await expect(reported).resolves.toEqual([
      { name: 'clear', description: null },
      { name: 'compact', description: null },
      { name: 'geniro:review', description: null },
    ]);
  });

  it("starts no MCP server of the user's to answer a question about the CLI itself", async () => {
    // The probe turn is cancelled before the model runs, so a server it
    // launched could never have contributed to the answer — but launching one
    // costs a real process, and the cancel then reaps a group holding the
    // user's OWN running servers. Restricting the turn to an empty config is
    // what makes there be nothing to kill.
    const { spawn, child, captured } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.stdout.emitData(initLine(['clear']));
    await reported;

    const args = captured.args ?? [];
    expect(args).toContain(CLAUDE_STRICT_MCP_CONFIG_FLAG);
    // The strict flag needs an explicit empty set to restrict to.
    expect(args[args.indexOf(CLAUDE_MCP_CONFIG_FLAG) + 1]).toBe(
      CLAUDE_EMPTY_MCP_CONFIG,
    );
  });

  it("drops claude's internal `_`-prefixed commands", async () => {
    // `__remote-workflow` is reported but is not something a user invokes —
    // offering it in the autocomplete would be a dead row.
    const { spawn, child } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.stdout.emitData(
      initLine(['clear', '__remote-workflow', '_hidden', 'compact']),
    );

    await expect(reported).resolves.toEqual([
      { name: 'clear', description: null },
      { name: 'compact', description: null },
    ]);
  });

  it('caps the reported list at 500, however much the CLI claims', async () => {
    // A defensive bound: init reports ~60 entries today, and an autocomplete
    // is not the place to discover that a plugin registered thousands.
    //
    // The 500 is asserted as a LITERAL, not derived from the config: a test
    // whose expectation comes from the same number the code reads passes for
    // any value and would pin nothing if the bound were quietly widened.
    const { maxCommands } = shippedReportedCommands();
    expect(maxCommands).toBe(500);

    const { spawn, child } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.stdout.emitData(
      initLine(Array.from({ length: 600 }, (_, i) => `cmd-${i}`)),
    );

    await expect(reported).resolves.toHaveLength(500);
  });

  it('cancels the turn the moment the list lands, before the model runs', async () => {
    // The whole point of probing this way: init carries the list, so paying
    // for the rest of the turn buys nothing.
    const { spawn, child } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.stdout.emitData(initLine(['clear']));
    await reported;

    expect(child.kills).toBe(1);
    expect(child.killSignal).toBe('SIGTERM');
  });

  it('runs in a throwaway workspace under the given root, and removes it', async () => {
    const probeRootDir = tempDir('probe-root-');
    const { spawn, child, captured, cwdExistedDuringTurn } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir,
    }).listReportedCommands();

    child.stdout.emitData(initLine(['clear']));
    await reported;

    const cwd = captured.cwd ?? '';
    expect(cwd.startsWith(probeRootDir)).toBe(true);
    expect(cwdExistedDuringTurn()).toBe(true);
    expect(existsSync(cwd)).toBe(false);
    expect(readdirSync(probeRootDir)).toEqual([]);
  });

  it("runs the least-privileged turn — no permission bypass, no server of the user's", async () => {
    // The probe never reaches a tool, so it asks for nothing that would let it:
    // the argv is the plain stream-json head plus the MCP isolation, and the
    // prompt is the config's.
    const { spawn, child, captured } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.stdout.emitData(initLine(['clear']));
    await reported;

    expect(captured.args).toEqual([
      ...CLAUDE_BASE_ARGS,
      CLAUDE_SETTINGS_FLAG,
      '{"crossSessionInbound":"refuse"}',
      '--disallowedTools',
      'Monitor',
      'ListAgents',
      CLAUDE_MCP_CONFIG_FLAG,
      CLAUDE_EMPTY_MCP_CONFIG,
      CLAUDE_STRICT_MCP_CONFIG_FLAG,
    ]);
    expect(captured.args).not.toContain('--dangerously-skip-permissions');
    expect(captured.args).not.toContain('--permission-mode');

    // TWO lines, and the second is the whole of what this probe asks for. The
    // CLI names its commands on `init` and describes NONE of them; the
    // sentences come back only when it is asked to reload, so the probe writes
    // that request and reads the announcement. Nothing else was granted for it
    // — the argv above is unchanged, since this CLI already speaks stream-json
    // on stdin.
    const lines = child.stdin.written
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
    expect(lines[0]).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: shippedReportedCommands().probePrompt },
        ],
      },
    });
    expect(lines[1]).toEqual({
      type: 'control_request',
      request_id: CLAUDE_RELOAD_COMMANDS_REQUEST_ID,
      request: { subtype: CLAUDE_RELOAD_COMMANDS_SUBTYPE },
    });
    expect(lines).toHaveLength(2);
  });

  it('takes the DESCRIBED list the reload announces, over the bare names on init', async () => {
    // The reported "Autocomplete doesn't show tool descriptions", at its source.
    // `system/init` names every command and describes none — measured against
    // this daemon's own endpoint on a real profile, 64 of 67 rows had no
    // sentence at all, `/compact` and `/autocompact` among them. The reload's
    // announcement carries the same names WITH each entry's own description
    // (68 of 68 in the live probe), and it arrives before `init`.
    const { spawn, child } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.stdout.emitData(
      `${JSON.stringify({
        type: 'system',
        subtype: CLAUDE_COMMANDS_CHANGED_SUBTYPE,
        commands: [
          {
            name: 'compact',
            description:
              'Free up context by summarizing the conversation so far',
            argumentHint: '',
          },
          // No sentence for this one: the CLI spells that as an empty string,
          // and it must arrive as null — a blank would render as an invisible
          // description AND outrank a real one from the disk scan.
          { name: 'clear', description: '' },
        ],
      })}\n`,
    );

    expect(await reported).toEqual([
      {
        name: 'compact',
        description: 'Free up context by summarizing the conversation so far',
      },
      { name: 'clear', description: null },
    ]);
  });

  it('still answers from init alone when the reload announces nothing', async () => {
    // The degrade, and it is the whole safety of asking: a CLI that stops
    // answering the reload falls back to the bare names it already reported,
    // which is exactly what the autocomplete shows today — never to nothing.
    const { spawn, child } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.stdout.emitData(initLine(['clear']));

    expect(await reported).toEqual([{ name: 'clear', description: null }]);
  });

  it('reports nothing when the CLI exits before its init line', async () => {
    // A missing binary or a failed sign-in ends the turn with no report; the
    // caller falls back to the disk scan rather than surfacing an error.
    const { spawn, child } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.emit('close', 0, null);

    await expect(reported).resolves.toEqual([]);
  });

  it('reports nothing when the CLI cannot be spawned at all', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('spawn ENOENT');
    };

    await expect(
      new ClaudeAdapter({
        spawn,
        probeRootDir: tempDir('probe-root-'),
      }).listReportedCommands(),
    ).resolves.toEqual([]);
  });

  it('reports nothing when the probe workspace cannot even be created', async () => {
    // Enters the probe's own catch: a probeRootDir that is a FILE makes the
    // mkdir throw before any turn exists. Without a test that reaches it, a
    // later "dead code" sweep deletes the guard and the read starts throwing
    // at the composer instead of degrading to the disk scan.
    const root = join(tempDir('probe-root-'), 'not-a-dir');
    writeFileSync(root, 'file, not a directory');
    const { spawn } = probeSpawn();

    await expect(
      new ClaudeAdapter({ spawn, probeRootDir: root }).listReportedCommands(),
    ).resolves.toEqual([]);
  });

  it('gives up on a turn that never reports, rather than hanging forever', async () => {
    // A CLI that dropped into an interactive login holds the turn open; the
    // timeout must cancel it so the autocomplete read still completes.
    const { spawn, child } = probeSpawn();

    await expect(
      new ClaudeAdapter({
        spawn,
        probeRootDir: tempDir('probe-root-'),
      }).listReportedCommands({ timeoutMs: 10 }),
    ).resolves.toEqual([]);
    expect(child.kills).toBe(1);
  });

  it('hands the turn to onTurn so it can be reaped on shutdown', async () => {
    // Every child the daemon spawns must be registered — a probe turn is no
    // exception, and start() hands back a handle rather than a child.
    const { spawn, child } = probeSpawn();
    const registered: AgentTurnHandle[] = [];
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands({ onTurn: (handle) => registered.push(handle) });

    child.stdout.emitData(initLine(['clear']));
    await reported;

    expect(registered.length).toBe(1);
  });
});

describe('ClaudeAdapter — handing the conversation to the user', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resumes the stored claude session', () => {
    expect(
      new ClaudeAdapter().handoffTarget({
        sessionId: 'sess-42',
        model: null,
      }),
    ).toEqual({
      ok: true,
      kind: 'command',
      command: 'claude',
      args: [CLAUDE_RESUME_FLAG, 'sess-42'],
      env: {},
    });
  });

  it('resumes a session geniro still holds — claude opens one another process has open', () => {
    expect(
      new ClaudeAdapter().handoffTarget({
        sessionId: 'sess-42',
        model: null,
        held: true,
      }),
    ).toMatchObject({ ok: true, args: [CLAUDE_RESUME_FLAG, 'sess-42'] });
  });

  it('opens on the run’s OWN model, not the CLI default', () => {
    // A mirror that resumed under claude's default was a different model with
    // a different window sitting beside the chat it mirrors — which is what
    // put a 200k context readout next to a 1M-window conversation.
    expect(
      new ClaudeAdapter().handoffTarget({
        sessionId: 'sess-42',
        model: 'claude-opus-5[1m]',
      }),
    ).toEqual({
      ok: true,
      kind: 'command',
      command: 'claude',
      args: [
        CLAUDE_MODEL_FLAG,
        'claude-opus-5[1m]',
        CLAUDE_RESUME_FLAG,
        'sess-42',
      ],
      env: {},
    });
  });

  it('resumes INSIDE the run’s own config directory, via env', () => {
    // The session being resumed lives in that profile's own store. Without the
    // var the CLI opens the DEFAULT profile, where the id does not exist — and
    // it does not say so, it shows an unrelated conversation.
    expect(
      new ClaudeAdapter().handoffTarget({
        sessionId: 'sess-42',
        model: null,
        configDir: '/profiles/work',
      }),
    ).toEqual({
      ok: true,
      kind: 'command',
      command: 'claude',
      args: [CLAUDE_RESUME_FLAG, 'sess-42'],
      env: { [CLAUDE_CONFIG_DIR_ENV]: '/profiles/work' },
    });
  });

  it('signs the CLI in to THAT profile, not the default one', async () => {
    // The failure this closes: a chat on a second subscription whose session
    // expired: signing in under the default directory leaves that chat exactly
    // as expired, with no error to explain it. Read off the CHILD the adapter
    // would spawn, since the daemon runs this itself — there is no invocation
    // handed to a terminal to inspect any more.
    const { adapter, spawned } = recordingClaude();
    await adapter.runLogin({
      configDir: '/profiles/work',
      timeoutMs: 1_000,
      onSpawn: () => undefined,
    });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toEqual(['auth', 'login']);
    expect(spawned[0]?.env[CLAUDE_CONFIG_DIR_ENV]).toBe('/profiles/work');
  });

  it('signs the CLI OUT with its own command, in THAT profile', async () => {
    // `claude auth logout`, from `claude auth --help` on 2.1.227. The config
    // directory matters more here than on the sign-in path, not less: a logout
    // that dropped it would clear the DEFAULT account's credentials while the
    // user was acting on a card for a different profile.
    const { adapter, spawned } = recordingClaude();
    await adapter.runLogout({ configDir: '/profiles/work', timeoutMs: 1_000 });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toEqual(['auth', 'logout']);
    expect(spawned[0]?.env[CLAUDE_CONFIG_DIR_ENV]).toBe('/profiles/work');
  });

  it('omits the model flag for a run on the CLI’s default', () => {
    // `--model ''` is not the same request as no flag at all.
    expect(
      new ClaudeAdapter().handoffTarget({ sessionId: 'sess-42', model: '  ' })
        .ok,
    ).toBe(true);
    expect(
      new ClaudeAdapter().handoffTarget({
        sessionId: 'sess-42',
        model: '  ',
      }),
    ).toEqual({
      ok: true,
      kind: 'command',
      command: 'claude',
      args: [CLAUDE_RESUME_FLAG, 'sess-42'],
      env: {},
    });
  });

  it('refuses with no-session until a resumable session id is stored', () => {
    // Not a mirror target: launching the TUI without a resume id would open an
    // unrelated fresh conversation while claiming to show the run's own.
    expect(
      new ClaudeAdapter().handoffTarget({ sessionId: null, model: null }),
    ).toEqual({
      ok: false,
      reason: 'no-session',
    });
  });

  it('refuses a whitespace-only session id instead of building a broken resume argv', () => {
    expect(
      new ClaudeAdapter().handoffTarget({ sessionId: ' \t\n ', model: null }),
    ).toEqual({
      ok: false,
      reason: 'no-session',
    });
  });

  it('refuses a zero-width-only session id instead of an invisible resume target', () => {
    // U+200B is not trimmed as whitespace, so only the id PATTERN rejects it.
    expect(
      new ClaudeAdapter().handoffTarget({ sessionId: '\u200b', model: null }),
    ).toEqual({
      ok: false,
      reason: 'no-session',
    });
  });

  it('reports NO permanent reason, so a session-less run is not read as unsupported', () => {
    // The two refusals mean different things and only `handoffUnavailableReason`
    // answers the permanent one. Were it to conflate them — returning a
    // sentence whenever `handoffTarget` refused — a claude chat that had not
    // sent its first message yet would render the control inert and permanently
    // explained away, on a CLI that resumes perfectly well.
    expect(
      new ClaudeAdapter().handoffTarget({ sessionId: null, model: null }),
    ).toEqual({ ok: false, reason: 'no-session' });
    expect(new ClaudeAdapter().handoffUnavailableReason()).toBeNull();
  });

  it('opens through the cliPaths override path', () => {
    // The mirror spawns the same binary a turn would — resolved per access, so
    // a Settings cliPaths override reaches the TUI too.
    vi.stubEnv(
      'GENIRO_CLI_PATHS',
      JSON.stringify({ claude: '/opt/tools/claude' }),
    );
    expect(
      new ClaudeAdapter().handoffTarget({
        sessionId: 'sess-42',
        model: null,
      }),
    ).toEqual({
      ok: true,
      kind: 'command',
      command: '/opt/tools/claude',
      args: [CLAUDE_RESUME_FLAG, 'sess-42'],
      env: {},
    });
  });
});

describe('ClaudeAdapter — models', () => {
  const dirs: string[] = [];
  const unavailableSpawn = (() => {
    throw new Error('CLI unavailable');
  }) as typeof spawn;

  afterEach(() => {});

  function emptyHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'claude-no-cache-'));
    dirs.push(dir);
    return dir;
  }

  it('floors the picker with the set its CONFIG declares, not the shipped const', async () => {
    // `config.builtinModels` is documented as THE fallback contract — "what a
    // CLI that cannot be asked answers with so the picker is never empty" — so
    // it must be what listModels actually reads. An adapter whose config
    // carries a different floor answers with THAT floor; hardcoding the alias
    // list in listModels instead would leave the field write-only, and this
    // test is the thing that fails when someone does.
    class ConfiguredClaudeAdapter extends ClaudeAdapter {
      override getConfig(): AdapterConfig {
        return {
          ...super.getConfig(),
          builtinModels: [
            {
              id: 'pinned-floor-model',
              label: 'Pinned floor',
              source: 'builtin',
            },
          ],
        };
      }
    }

    const models = await new ConfiguredClaudeAdapter({
      homeDir: emptyHome(),
      groupSpawnFn: unavailableSpawn,
    }).listModels({ configDir: null });

    expect(models).toEqual([
      {
        id: 'pinned-floor-model',
        label: 'Pinned floor',
        source: 'builtin',
      },
    ]);
  });

  it("reads the account models out of the RUN's profile, not the home dir", async () => {
    // The extra models an account offers are cached by the CLI inside the
    // config directory's own `.claude.json`, so reading the home copy answered
    // with the DEFAULT profile's account for every chat whatever subscription
    // it ran on. Measured on the reporter's machine, one login's two profiles
    // report different subscriptions (`max` against `team`) from the same
    // binary — so no version check could have caught it, and their cached lists
    // happening to coincide is why it had to be found by reading.
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-home-'));
    const profile = mkdtempSync(join(tmpdir(), 'claude-profile-'));
    dirs.push(homeDir, profile);
    writeFileSync(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        additionalModelOptionsCache: [
          { value: 'default-account-model', label: 'Default account' },
        ],
      }),
    );
    writeFileSync(
      join(profile, '.claude.json'),
      JSON.stringify({
        additionalModelOptionsCache: [
          { value: 'this-account-model', label: 'This account' },
        ],
      }),
    );

    const models = await new ClaudeAdapter({
      homeDir,
      groupSpawnFn: unavailableSpawn,
    }).listModels({
      configDir: profile,
    });

    expect(models.map((model) => model.id)).toContain('this-account-model');
    expect(models.map((model) => model.id)).not.toContain(
      'default-account-model',
    );
  });

  it('offers the shipped aliases as the floor of a stock adapter', async () => {
    // The other half: the config the adapter actually ships must carry the
    // documented tier aliases, so a real install's picker is never empty.
    const models = await new ClaudeAdapter({
      homeDir: emptyHome(),
      groupSpawnFn: unavailableSpawn,
    }).listModels({ configDir: null });

    expect(models.map((model) => model.id)).toEqual([
      'opus',
      'sonnet',
      'haiku',
    ]);
  });
});

describe('ClaudeAdapter — fast mode', () => {
  it('offers the row only for an Opus model', async () => {
    const adapter = new ClaudeAdapter();

    const opus = await adapter.listModelParameters('claude-opus-5-5');
    expect(opus.parameters).toEqual([
      expect.objectContaining({ id: CLAUDE_FAST_MODE_PARAMETER_ID }),
    ]);
    expect(opus.unavailableReason).toBeNull();

    const sonnet = await adapter.listModelParameters('claude-sonnet-5');
    expect(sonnet.parameters).toEqual([]);
    // The real observable: WHICH model was refused and WHY, not merely that
    // the list came back empty — an assertion on emptiness alone would still
    // pass if this fell through to "pick a model" for every named model.
    expect(sonnet.unavailableReason).toContain('claude-sonnet-5');
    expect(sonnet.unavailableReason).toContain('Opus');

    const none = await adapter.listModelParameters(null);
    expect(none.parameters).toEqual([]);
    expect(none.unavailableReason).toBe(
      'pick a model to see the settings it offers',
    );
  });

  it('sets fast mode only when the turn asked for it, and refuses other sessions on every turn', () => {
    const on = fakeSpawn();
    new ClaudeAdapter({ spawn: on.spawn, waitForMcpServers: false }).start(
      {
        prompt: 'go',
        cwd: '/proj',
        model: 'claude-opus-5-5',
        modelParameters: { [CLAUDE_FAST_MODE_PARAMETER_ID]: 'true' },
      },
      () => {},
    );
    const settingsOf = (args: string[]): unknown =>
      JSON.parse(args[args.indexOf(CLAUDE_SETTINGS_FLAG) + 1]!);
    expect(settingsOf(on.captured.args!)).toEqual({
      crossSessionInbound: 'refuse',
      fastMode: true,
    });

    const off = fakeSpawn();
    new ClaudeAdapter({ spawn: off.spawn, waitForMcpServers: false }).start(
      {
        prompt: 'go',
        cwd: '/proj',
        model: 'claude-opus-5-5',
        modelParameters: { [CLAUDE_FAST_MODE_PARAMETER_ID]: 'false' },
      },
      () => {},
    );
    expect(settingsOf(off.captured.args!)).toEqual({
      crossSessionInbound: 'refuse',
    });

    const unset = fakeSpawn();
    new ClaudeAdapter({ spawn: unset.spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj', model: 'claude-opus-5-5' },
      () => {},
    );
    expect(settingsOf(unset.captured.args!)).toEqual({
      crossSessionInbound: 'refuse',
    });
  });

  it('hands the CLI the run’s reply language in the same one --settings as fast mode', () => {
    const both = fakeSpawn();
    new ClaudeAdapter({ spawn: both.spawn, waitForMcpServers: false }).start(
      {
        prompt: 'go',
        cwd: '/proj',
        model: 'claude-opus-5-5',
        modelParameters: { [CLAUDE_FAST_MODE_PARAMETER_ID]: 'true' },
        replyLanguage: 'Russian',
      },
      () => {},
    );
    const args = both.captured.args!;
    expect(args.filter((arg) => arg === CLAUDE_SETTINGS_FLAG)).toHaveLength(1);
    expect(JSON.parse(args[args.indexOf(CLAUDE_SETTINGS_FLAG) + 1]!)).toEqual({
      crossSessionInbound: 'refuse',
      fastMode: true,
      language: 'Russian',
    });
  });

  it('respawns the kept process when fast mode flips, and reuses it when it does not', async () => {
    // Mirrors the base class's own "sessions separate on…" pattern
    // (`agent-adapter.spec.ts`): a session refuses a turn whose key differs
    // and serves one whose key matches — settled first, so a still-busy
    // session (which refuses EVERY second turn) cannot be mistaken for this.
    const { spawn, child } = fakeSpawn();
    const input: AgentTurnInput = {
      prompt: 'first',
      cwd: '/proj',
      model: 'claude-opus-5-5',
      approvalMode: 'ask',
      allowUserQuestions: true,
      modelParameters: { [CLAUDE_FAST_MODE_PARAMETER_ID]: 'true' },
    };
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession(input, { runScoped: true });
    const turn = session.startTurn(input, () => {});
    child.stdout.emitData(
      '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"sess-1"}\n',
    );
    await turn?.done;

    expect(
      session.startTurn(
        {
          ...input,
          modelParameters: { [CLAUDE_FAST_MODE_PARAMETER_ID]: 'false' },
        },
        () => {},
      ),
    ).toBeNull();

    expect(session.startTurn({ ...input }, () => {})).not.toBeNull();
  });

  it('withholds claude’s own Monitor and a member’s switched-off MCP servers with one --disallowedTools, never geniro’s own', () => {
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      {
        prompt: 'go',
        cwd: '/proj',
        mcpDisabled: ['codegraph', 'claude.ai Gmail', 'geniro-run-1'],
        mcpEndpoint: {
          url: 'http://127.0.0.1:1/v1/mcp/r/n',
          token: 't',
          serverName: 'geniro-run-1',
        },
      },
      () => {},
    );
    const args = captured.args!;
    const at = args.indexOf('--disallowedTools');
    expect(at).toBeGreaterThan(-1);
    expect(args.slice(at + 1, at + 5)).toEqual([
      'Monitor',
      'ListAgents',
      'mcp__codegraph',
      'mcp__claude_ai_Gmail',
    ]);
    expect(args.filter((arg) => arg === '--disallowedTools')).toHaveLength(1);
    expect(args).not.toContain('mcp__geniro-run-1');

    const none = fakeSpawn();
    new ClaudeAdapter({ spawn: none.spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    const bare = none.captured.args!;
    expect(bare.slice(bare.indexOf('--disallowedTools') + 1)[0]).toBe(
      'Monitor',
    );
  });

  it('respawns the kept process when the switched-off servers change, not when only their order does', async () => {
    const { spawn, child } = fakeSpawn();
    const input: AgentTurnInput = {
      prompt: 'first',
      cwd: '/proj',
      approvalMode: 'ask',
      allowUserQuestions: true,
      mcpDisabled: ['codegraph', 'playwright'],
    };
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession(input, { runScoped: true });
    const turn = session.startTurn(input, () => {});
    child.stdout.emitData(
      '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"sess-1"}\n',
    );
    await turn?.done;

    expect(
      session.startTurn({ ...input, mcpDisabled: ['codegraph'] }, () => {}),
    ).toBeNull();
    expect(
      session.startTurn(
        { ...input, mcpDisabled: ['playwright', 'codegraph'] },
        () => {},
      ),
    ).not.toBeNull();
  });
});

describe('ClaudeAdapter MCP toggle (the CLI’s own disable list)', () => {
  /** A home dir holding a `.claude.json` with the given contents. */
  function home(config: unknown): string {
    const dir = tempDir('claude-toggle-');
    writeFileSync(join(dir, '.claude.json'), JSON.stringify(config), 'utf8');
    return dir;
  }

  const read = (dir: string): Record<string, never> =>
    JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as Record<
      string,
      never
    >;

  it('writes the folder’s disabled list in the CLI’s own config', async () => {
    // `projects[<cwd>].disabledMcpServers` — probe-verified on 2.1.222 as the
    // one list that takes a server of ANY scope out of a turn. Writing the
    // CLI's list rather than a private one is also why the switch shows up in
    // the user's own `/mcp` panel.
    const dir = home({ projects: { '/proj': { allowedTools: ['Bash'] } } });

    await new ClaudeAdapter({ homeDir: dir }).setMcpServerEnabled(
      '/proj',
      'sentry',
      false,
    );

    expect(read(dir)).toEqual({
      projects: {
        '/proj': { allowedTools: ['Bash'], disabledMcpServers: ['sentry'] },
      },
    });
  });

  it('writes the PROFILE’s config when one is named, and leaves home untouched', async () => {
    // The READ half resolves this file through the profile's own root
    // (`modelCacheDir`, shared with `readMcpFolderFacts`), so a write that
    // ignored `configDir` edited a different account's config than the one the
    // panel had listed: the switch moved on screen, the profile it was pressed
    // on was unchanged, and the DEFAULT profile's disabled list was rewritten
    // instead. Both assertions are load-bearing — landing in the profile is
    // only half the fix if home is edited as well.
    const homeDir = home({ projects: { '/proj': { history: ['home'] } } });
    const profile = home({ projects: { '/proj': { history: ['profile'] } } });

    await new ClaudeAdapter({ homeDir }).setMcpServerEnabled(
      '/proj',
      'sentry',
      false,
      { configDir: profile },
    );

    expect(read(profile)).toEqual({
      projects: {
        '/proj': { history: ['profile'], disabledMcpServers: ['sentry'] },
      },
    });
    expect(read(homeDir)).toEqual({
      projects: { '/proj': { history: ['home'] } },
    });
  });

  it('preserves every other key of the config and of the project entry', async () => {
    // This file holds the user's whole CLI state. A rewrite that dropped a key
    // would be silent data loss in a file they never asked us to touch.
    const dir = home({
      firstStartTime: '2026-01-01',
      projects: {
        '/proj': { history: ['a'], mcpServers: { sentry: { type: 'stdio' } } },
        '/other': { history: ['b'] },
      },
    });

    await new ClaudeAdapter({ homeDir: dir }).setMcpServerEnabled(
      '/proj',
      'sentry',
      false,
    );

    const after = read(dir) as unknown as {
      firstStartTime: string;
      projects: Record<string, Record<string, unknown>>;
    };
    expect(after.firstStartTime).toBe('2026-01-01');
    expect(after.projects['/other']).toEqual({ history: ['b'] });
    expect(after.projects['/proj']?.history).toEqual(['a']);
    expect(after.projects['/proj']?.mcpServers).toEqual({
      sentry: { type: 'stdio' },
    });
  });

  it('re-enabling removes the name rather than emptying the list', async () => {
    const dir = home({
      projects: { '/proj': { disabledMcpServers: ['sentry', 'docs'] } },
    });

    await new ClaudeAdapter({ homeDir: dir }).setMcpServerEnabled(
      '/proj',
      'sentry',
      true,
    );

    expect(read(dir)).toEqual({
      projects: { '/proj': { disabledMcpServers: ['docs'] } },
    });
  });

  it('creates the project entry for a folder the CLI has never opened', async () => {
    // Otherwise a server could only be switched off in folders the user had
    // already used interactively — which is not where a fresh chat starts.
    const dir = home({ projects: {} });

    await new ClaudeAdapter({ homeDir: dir }).setMcpServerEnabled(
      '/fresh',
      'sentry',
      false,
    );

    expect(read(dir)).toEqual({
      projects: { '/fresh': { disabledMcpServers: ['sentry'] } },
    });
  });

  it('does not rewrite the file when the server is already in that state', async () => {
    const dir = home({
      projects: { '/proj': { disabledMcpServers: ['sentry'] } },
    });
    const before = statSync(join(dir, '.claude.json')).mtimeMs;

    await new ClaudeAdapter({ homeDir: dir }).setMcpServerEnabled(
      '/proj',
      'sentry',
      false,
    );

    expect(statSync(join(dir, '.claude.json')).mtimeMs).toBe(before);
  });

  it('REFUSES on an unparseable config instead of replacing it', async () => {
    // Treating a corrupt config as empty would rewrite it as `{projects:{…}}`
    // and take the user's history, account record and every project's settings
    // with it. Losing a toggle is recoverable; that is not.
    const dir = tempDir('claude-toggle-');
    writeFileSync(join(dir, '.claude.json'), '{ this is not json', 'utf8');

    await expect(
      new ClaudeAdapter({ homeDir: dir }).setMcpServerEnabled(
        '/proj',
        'sentry',
        false,
      ),
    ).rejects.toThrow();
    expect(readFileSync(join(dir, '.claude.json'), 'utf8')).toBe(
      '{ this is not json',
    );
  });

  it('reads back what it wrote, as the folder’s disabled set', async () => {
    // The read and the write are two halves of one mechanism; a spec that only
    // pinned the write would let the panel keep listing a stale state.
    const dir = home({ projects: {} });
    const adapter = new ClaudeAdapter({ homeDir: dir });

    await adapter.setMcpServerEnabled('/proj', 'sentry', false);

    expect((await adapter.readMcpFolderFacts('/proj', null)).disabled).toEqual([
      'sentry',
    ]);
  });

  describe('the key the CLI actually reads', () => {
    /** A repository with a `.git` directory and a subfolder, canonicalized. */
    function repoWithSub(): { repo: string; sub: string } {
      const repo = realpathSync(tempDir('claude-toggle-repo-'));
      mkdirSync(join(repo, '.git'));
      const sub = join(repo, 'packages', 'app');
      mkdirSync(sub, { recursive: true });
      return { repo, sub };
    }

    /** A linked worktree of `repo`, laid out as `git worktree add` writes it. */
    function worktreeOf(repo: string): string {
      const tree = realpathSync(tempDir('claude-toggle-wt-'));
      const gitdir = join(repo, '.git', 'worktrees', 'wt');
      mkdirSync(gitdir, { recursive: true });
      writeFileSync(join(tree, '.git'), `gitdir: ${gitdir}\n`);
      writeFileSync(join(gitdir, 'commondir'), '../..\n');
      writeFileSync(join(gitdir, 'gitdir'), `${join(tree, '.git')}\n`);
      return tree;
    }

    it('files a SUBFOLDER’s switch under the repository, which is what the CLI reads', async () => {
      // Probe-verified on 2.1.280 under an isolated CLAUDE_CONFIG_DIR: from
      // `repo/sub`, `projects[repo/sub].disabledMcpServers` left the server
      // dialled and `projects[repo]` switched it off. Keyed by the cwd, the
      // switch moved on screen and changed nothing.
      const { repo, sub } = repoWithSub();
      const dir = home({ projects: {} });

      await new ClaudeAdapter({ homeDir: dir }).setMcpServerEnabled(
        sub,
        'sentry',
        false,
      );

      expect(read(dir)).toEqual({
        projects: { [repo]: { disabledMcpServers: ['sentry'] } },
      });
    });

    it('files a WORKTREE’s switch under the main repository', async () => {
      // Every task card runs in a worktree. From one, `projects[<worktree>]`
      // did nothing on the probe and `projects[<main repo>]` did the job.
      const { repo } = repoWithSub();
      const tree = worktreeOf(repo);
      const dir = home({ projects: {} });

      await new ClaudeAdapter({ homeDir: dir }).setMcpServerEnabled(
        tree,
        'sentry',
        false,
      );

      expect(read(dir)).toEqual({
        projects: { [repo]: { disabledMcpServers: ['sentry'] } },
      });
    });

    it('reads a subfolder’s switched-off servers from the repository’s entry', async () => {
      // The READ half of the same key: the panel reported whatever sat under
      // the cwd, which is not the list the turn consults.
      const { repo, sub } = repoWithSub();
      const dir = home({
        mcpServers: { sentry: { type: 'stdio' } },
        projects: {
          [repo]: {
            disabledMcpServers: ['sentry'],
            disabledMcpjsonServers: ['docs'],
            mcpServers: { local: { type: 'stdio' } },
          },
        },
      });

      const facts = await new ClaudeAdapter({
        homeDir: dir,
      }).readMcpFolderFacts(sub, null);

      expect(facts.disabled).toEqual(['sentry']);
      expect(facts.lockedOff).toEqual(['docs']);
      expect(facts.configured).toEqual(
        expect.arrayContaining(['sentry', 'local']),
      );
    });
  });

  describe('writing the file the way the CLI writes it', () => {
    it('keeps a 0600 config 0600', async () => {
      // The CLI keeps this file private — it holds the account record and
      // every project's history. A plain tmp+rename handed it back at the
      // umask (0644), world-readable, on every toggle.
      const dir = home({ projects: {} });
      chmodSync(join(dir, '.claude.json'), 0o600);

      await new ClaudeAdapter({ homeDir: dir }).setMcpServerEnabled(
        '/proj',
        'sentry',
        false,
      );

      expect(statSync(join(dir, '.claude.json')).mode & 0o777).toBe(0o600);
    });

    it('writes THROUGH a symlinked config and keeps the link', async () => {
      const dir = tempDir('claude-toggle-');
      const real = join(tempDir('claude-toggle-dotfiles-'), 'claude.json');
      writeFileSync(real, JSON.stringify({ projects: {} }), { mode: 0o600 });
      symlinkSync(real, join(dir, '.claude.json'));

      await new ClaudeAdapter({ homeDir: dir }).setMcpServerEnabled(
        '/proj',
        'sentry',
        false,
      );

      expect(lstatSync(join(dir, '.claude.json')).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({
        projects: { '/proj': { disabledMcpServers: ['sentry'] } },
      });
    });

    it('creates a profile’s config that does not exist yet, privately', async () => {
      // A profile the CLI has never run in has no `.claude.json`. The lock's
      // default `realpath: true` rejected with ENOENT before anything else
      // happened, so switching a project server off there always failed.
      const dir = tempDir('claude-toggle-empty-profile-');

      await new ClaudeAdapter({
        homeDir: tempDir('home-'),
      }).setMcpServerEnabled('/proj', 'sentry', false, { configDir: dir });

      expect(read(dir)).toEqual({
        projects: { '/proj': { disabledMcpServers: ['sentry'] } },
      });
      expect(statSync(join(dir, '.claude.json')).mode & 0o777).toBe(0o600);
    });
  });
});

/**
 * A ClaudeAdapter whose children are recorded rather than run — both seams,
 * because the three auth commands do not take the same one: `runLogin` and
 * `runMcpLogin` force the process-group path (a sign-in has a browser opener
 * under it, and the pty wrapper has `script` under that), while `runLogout` is
 * an ordinary `execFile`.
 *
 * It exists because these invocations stopped being VALUES the daemon hands to
 * a terminal and became children it spawns: the only place left to read the
 * argv and the profile env off is the spawn itself.
 */
function recordingClaude(): {
  adapter: ClaudeAdapter;
  spawned: { args: string[]; env: NodeJS.ProcessEnv }[];
} {
  const spawned: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const record = (
    args: readonly string[],
    options: Record<string, unknown>,
  ): void => {
    spawned.push({
      args: [...args],
      env: (options.env ?? {}) as NodeJS.ProcessEnv,
    });
  };
  const adapter = new ClaudeAdapter({
    groupSpawnFn: spawnAnswering('', 4242, record),
    execFileFn: ((
      _command: string,
      args: readonly string[],
      options: Record<string, unknown>,
      done: (err: null, stdout: string, stderr: string) => void,
    ) => {
      record(args, options);
      queueMicrotask(() => done(null, '', ''));
      return new FakeChild() as unknown as ChildProcess;
    }) as unknown as typeof execFile,
  });
  return { adapter, spawned };
}

describe('ClaudeAdapter — signing in to an MCP server', () => {
  it('composes the CLI’s real sign-in argv, ending in the server name', async () => {
    // The literal subcommand, from `claude mcp --help` on 2.1.223:
    //   login [options] <name>  Authenticate with an MCP server
    // The server's name is the last ARGUMENT, and that is the half a config pin
    // cannot state: an argv composed without it runs `claude mcp login` with no
    // target, and one composed with it in the wrong place authenticates
    // nothing while looking exactly as correct.
    const { adapter, spawned } = recordingClaude();
    await adapter.runMcpLogin({
      server: 'probe-linear',
      cwd: process.cwd(),
      timeoutMs: 1_000,
      onSpawn: () => undefined,
    });

    // The TAIL, because a pty command is spawned through `script` and the
    // wrapper's own argv leads. No profile was asked for, so none is set —
    // never the CLI's default path, which would be this app inventing a
    // profile the caller never chose.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args.slice(-3)).toEqual([
      'mcp',
      'login',
      'probe-linear',
    ]);
    expect(spawned[0]?.env[CLAUDE_CONFIG_DIR_ENV]).toBeUndefined();
  });
});

describe('ClaudeAdapter — geniro’s own MCP server name', () => {
  const ENDPOINT = {
    url: 'http://127.0.0.1:4870/v1/mcp/run-1/orch',
    token: 'call-token-1',
    serverName: 'geniro-run-1',
  };
  let cwd: string;
  /**
   * An EMPTY home for every case here, so these specs never consult the
   * `~/.claude.json` the developer running them owns.
   */
  let homeDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'claude-collision-'));
    homeDir = mkdtempSync(join(tmpdir(), 'claude-collision-home-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  /** Write `~/.claude.json` — the user- and local-scope source. */
  function writeHomeConfig(config: Record<string, unknown>): void {
    writeFileSync(
      join(homeDir, '.claude.json'),
      JSON.stringify(config),
      'utf8',
    );
  }

  it('publishes the call surface under the run’s OWN server name', () => {
    // The name carries the run id, so a server the user has already named
    // cannot be it. That is what replaced the collision refusal that used to
    // stand here: `--strict-mcp-config` is still not passed, so the user's own
    // servers load beside this one — they simply cannot be shadowed by it now.
    const { spawn, captured } = fakeSpawn();
    writeHomeConfig({ mcpServers: { geniro: { command: 'node' } } });

    new ClaudeAdapter({ spawn, mcpConfigDir: cwd, homeDir }).start(
      { prompt: 'p', cwd, mcpEndpoint: ENDPOINT },
      () => {},
    );

    const at = captured.args!.indexOf('--mcp-config');
    expect(at).toBeGreaterThan(-1);
    const written: unknown = JSON.parse(
      readFileSync(captured.args![at + 1]!, 'utf8'),
    );
    expect(
      Object.keys(
        (written as { mcpServers: Record<string, unknown> }).mcpServers,
      ),
    ).toEqual([ENDPOINT.serverName]);
  });
});

describe('ClaudeAdapter — a message sent into a turn already running', () => {
  it('writes the same user line the turn opened with, onto the open stdin', () => {
    // Probe-verified on 2.1.222: a second `{"type":"user"}` on a still-open
    // stream-json stdin is acted on at the next tool boundary of the turn in
    // flight. Holding it until the process exits — which is what a queue
    // draining on settle does — turns "as soon as possible" into "after
    // everything finishes".
    const { spawn, child } = fakeSpawn();
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      // A REAL chat turn. `approvalMode` is not decoration: `keepStdinOpen`
      // answers false the moment it is undefined, so a fixture without one
      // spawns with stdin ALREADY ENDED — and this test still passed, because
      // the writer reported success for a write into a closed pipe. Since
      // `ChatService.initialApproval` gives every chat run a mode, the mode is
      // what makes the fixture match production and this assertion a real pin.
      {
        prompt: 'first',
        cwd: '/proj',
        approvalMode: 'ask',
        allowUserQuestions: true,
      },
      () => {},
    );
    const openingBytes = child.stdin.written.length;

    expect(handle.sendUserMessage({ text: 'actually, do this' })).toBe(true);

    const follow = child.stdin.written.slice(openingBytes);
    expect(JSON.parse(follow)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'actually, do this' }],
      },
    });
    // One JSON line, newline-terminated — the CLI reads NDJSON.
    expect(follow.endsWith('\n')).toBe(true);
    expect(follow.trimEnd().includes('\n')).toBe(false);
  });

  it('reports false once the turn has settled, rather than dropping it silently', () => {
    // The caller keeps the message queued on false. A true here would have it
    // discarded while the agent never saw it.
    //
    // `approvalMode` for the same reason as the test above: without it stdin is
    // closed from the start, so this would answer false whether or not the
    // settle guard existed. With stdin genuinely open, the settle is the ONLY
    // thing making it false.
    const { spawn, child } = fakeSpawn();
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      {
        prompt: 'first',
        cwd: '/proj',
        approvalMode: 'ask',
        allowUserQuestions: true,
      },
      () => {},
    );
    child.emit('close', 0, null);

    expect(handle.sendUserMessage({ text: 'too late' })).toBe(false);
  });

  it('reports false for a turn whose stdin was never kept open', () => {
    // The turn shape with no permission dialogue: `keepStdinOpen` is false, so
    // the pipe is ended right after the opening prompt and there is nowhere for
    // a follow-up to go. Reporting true here — which is what a writer that only
    // checked the turn's own settle flags did — has the caller drop a message
    // the agent will never receive.
    const { spawn } = fakeSpawn();
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'first', cwd: '/proj' },
      () => {},
    );

    expect(handle.sendUserMessage({ text: 'nowhere to go' })).toBe(false);
  });

  it('keeps the turn open past a result the queued message was not answered in', async () => {
    // The reported bug, end to end through the real mapper: messages sent from
    // the queue just before the agent finished were taken — and answered — only
    // AFTER its `result`, so settling on that line read the run `completed`
    // while the agent went on working. The echo of the message is what says it
    // has been taken; the turn ends on the result that follows it.
    const { spawn, child } = fakeSpawn();
    const input = {
      prompt: 'first',
      cwd: '/proj',
      approvalMode: 'ask' as const,
      allowUserQuestions: true,
    };
    // Run-scoped, as every chat and team session is: a process kept for the
    // conversation is the only lifetime with a "next stretch" to wait for.
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession(input, { runScoped: true });
    const events: AgentEvent[] = [];
    const handle = session.startTurn(input, (e) => events.push(e));
    let settled = false;
    void handle?.done.then(() => {
      settled = true;
    });
    const emit = (obj: unknown): void =>
      child.stdout.emitData(`${JSON.stringify(obj)}\n`);
    const result = (text: string) => ({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      session_id: 'sess-1',
    });

    expect(handle?.sendUserMessage({ text: 'one by one, please' })).toBe(true);
    emit(result('answer to the prompt'));
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(events.filter((e) => e.type === 'turn_complete')).toEqual([]);

    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'one by one, please' }],
      },
      isReplay: true,
      session_id: 'sess-1',
    });
    emit(result('answer to the follow-up'));
    await handle?.done;

    expect(events.filter((e) => e.type === 'turn_complete')).toEqual([
      expect.objectContaining({ finalText: 'answer to the follow-up' }),
    ]);
    session.close();
  });
});

describe('ClaudeAdapter — re-moding a turn already running', () => {
  /** Everything written to stdin after the opening prompt line. */
  function afterOpening(
    input: Parameters<ClaudeAdapter['start']>[0],
    act: (handle: ReturnType<ClaudeAdapter['start']>) => void,
  ): string {
    const { spawn, child } = fakeSpawn();
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      input,
      () => {},
    );
    const openingBytes = child.stdin.written.length;
    act(handle);
    return child.stdin.written.slice(openingBytes);
  }

  it('writes a set_permission_mode control_request on the open dialogue', () => {
    // Probe-verified on 2.1.222: acknowledged in ~2ms, with the CLI re-emitting
    // `system/init` under the new mode ~350ms later. This is what makes the
    // change land on the turn in flight rather than the next one.
    let delivered = false;
    const written = afterOpening(
      { prompt: 'go', cwd: '/proj', approvalMode: 'ask' },
      (handle) => {
        delivered = handle.setApprovalMode('acceptEdits');
      },
    );

    expect(delivered).toBe(true);
    expect(JSON.parse(written)).toEqual({
      type: 'control_request',
      // Namespaced away from the ids the CLI mints for its own can_use_tool
      // requests — both id spaces share this one dialogue.
      request_id: expect.stringMatching(/^geniro-/),
      request: { subtype: 'set_permission_mode', mode: 'acceptEdits' },
    });
    expect(written.endsWith('\n')).toBe(true);
    expect(written.trimEnd().includes('\n')).toBe(false);
  });

  it('sends `default` for auto, because the CLI has no mode by that name', () => {
    // `auto` is the DAEMON auto-approving at its own seam, so the CLI must keep
    // prompting — which is `default`, exactly what buildArgs spawns an auto
    // question-capable turn with. Sending the literal 'auto' would earn a
    // rejected control request and silently leave the turn on its old mode.
    const written = afterOpening(
      { prompt: 'go', cwd: '/proj', approvalMode: 'ask' },
      (handle) => handle.setApprovalMode('auto'),
    );

    expect(JSON.parse(written).request.mode).toBe('default');
  });

  it('REFUSES a turn spawned without a permission gate, writing nothing', () => {
    // `auto` with no question channel spawns under
    // `--dangerously-skip-permissions`, which wires no prompt tool at all — so
    // no message can reintroduce a gate the process was started without, and a
    // true here would state a safety posture the user does not have.
    let delivered = true;
    const written = afterOpening(
      {
        prompt: 'go',
        cwd: '/proj',
        approvalMode: 'auto',
        allowUserQuestions: false,
      },
      (handle) => {
        delivered = handle.setApprovalMode('ask');
      },
    );

    expect(delivered).toBe(false);
    expect(written).toBe('');
  });

  it('reports false once the turn has settled', () => {
    const { spawn, child } = fakeSpawn();
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      { prompt: 'go', cwd: '/proj', approvalMode: 'ask' },
      () => {},
    );
    child.emit('close', 0, null);

    expect(handle.setApprovalMode('plan')).toBe(false);
  });
});

describe("ClaudeAdapter.listSessions — the picker's search", () => {
  const profiles: string[] = [];

  afterEach(() => {
    while (profiles.length > 0) {
      rmSync(profiles.pop() as string, { recursive: true, force: true });
    }
  });

  /** A profile whose two conversations open identically and diverge after. */
  function profileWithTwoTalks(): string {
    const root = mkdtempSync(join(tmpdir(), 'claude-adapter-sessions-'));
    profiles.push(root);
    const write = (id: string, said: string): void => {
      const dir = join(root, 'projects', 'proj');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${id}.jsonl`),
        [
          JSON.stringify({
            type: 'user',
            cwd: '/w',
            message: { role: 'user', content: 'help me with the updater' },
          }),
          JSON.stringify({
            type: 'assistant',
            cwd: '/w',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: said }],
            },
          }),
        ].join('\n'),
      );
    };
    write('found', 'The app.asar archive is never deleted.');
    write('other', 'The release feed is fine.');
    return root;
  }

  it('narrows the answer by what was SAID, not by the row it would show', async () => {
    // The wiring, end to end through the adapter — the reader below it has its
    // own cases, and a query the adapter forgot to pass on would leave every
    // one of them green while the picker searched nothing.
    const listing = await new ClaudeAdapter({}).listSessions({
      cwd: null,
      configDir: profileWithTwoTalks(),
      limit: 10,
      query: 'asar',
    });

    // Both open with the same prompt, so the titles cannot tell them apart.
    expect(listing.sessions.map((session) => session.id)).toEqual(['found']);
    expect(listing.sessions[0]?.snippet).toContain('app.asar archive');
  });

  it('leaves an unsearched listing whole', async () => {
    const listing = await new ClaudeAdapter({}).listSessions({
      cwd: null,
      configDir: profileWithTwoTalks(),
      limit: 10,
      query: null,
    });

    expect(listing.sessions).toHaveLength(2);
    expect(listing.partialReason).toBeNull();
  });
});

describe('ClaudeAdapter questionFrom', () => {
  it('projects no question from a payload it cannot read, as every CLI does', () => {
    // Null has the executor deny the request and the callee carry on; a blank
    // question parked for a caller is one nobody could answer.
    expect(new ClaudeAdapter().questionFrom({ questions: 'nope' })).toBeNull();
    expect(
      new ClaudeAdapter().questionFrom({
        questions: [{ question: 'Deploy now?', options: [{ label: 'Yes' }] }],
      }),
    ).toEqual({ text: 'Deploy now?', options: ['Yes'] });
  });
});

describe('ClaudeAdapter — a resumed process’s first cost', () => {
  class ArgsAdapter extends ClaudeAdapter {
    args(input: AgentTurnInput): string[] {
      return this.buildArgs(input);
    }

    line(obj: unknown): AgentEvent[] {
      return this.mapMessage(obj);
    }
  }

  it('starts the session’s running total where its transcript’s last cost-state left it', () => {
    // Without the seed, a daemon that never watched the previous process took
    // the restored total whole — a $653.74 turn its session files price at $1.80.
    const profile = mkdtempSync(join(tmpdir(), 'claude-resume-cost-'));
    const sessionId = '95eb2ed0-f2c6-4d0e-a62a-d20905a58d10';
    mkdirSync(join(profile, 'projects', '-Users-x'), { recursive: true });
    writeFileSync(
      join(profile, 'projects', '-Users-x', `${sessionId}.jsonl`),
      `${JSON.stringify({ type: 'cost-state', sessionId, totalCostUSD: 650 })}\n`,
    );
    const adapter = new ArgsAdapter();

    adapter.args({
      prompt: 'carry on',
      cwd: profile,
      configDir: profile,
      resumeSessionId: sessionId,
    } as AgentTurnInput);
    adapter.line({ type: 'system', subtype: 'init', session_id: sessionId });
    const events = adapter.line({
      type: 'result',
      subtype: 'success',
      session_id: sessionId,
      total_cost_usd: 651.8,
      usage: { input_tokens: 0, output_tokens: 0 },
      result: '',
    });

    const done = events.find((event) => event.type === 'turn_complete');
    expect(
      done?.type === 'turn_complete' ? done.usage?.costUsd : null,
    ).toBeCloseTo(1.8, 6);
  });

  it('reads the cost-state a replaced process writes after the spawn, at the new process’s init', () => {
    // The replaced process writes its $40 line as it exits, after argv is
    // built: a spawn-time read finds only the older $13, and the next result
    // re-bills the $27 between them.
    const profile = mkdtempSync(join(tmpdir(), 'claude-resume-cost-'));
    const sessionId = '5c1d1e0a-6f3b-4c55-9d7e-2b0a3f4e5d61';
    const transcript = join(
      profile,
      'projects',
      '-Users-x',
      `${sessionId}.jsonl`,
    );
    const costState = (total: number): string =>
      `${JSON.stringify({ type: 'cost-state', sessionId, totalCostUSD: total })}\n`;
    mkdirSync(join(profile, 'projects', '-Users-x'), { recursive: true });
    writeFileSync(transcript, costState(13));
    const adapter = new ArgsAdapter();
    const result = (total: number): AgentEvent[] =>
      adapter.line({
        type: 'result',
        subtype: 'success',
        session_id: sessionId,
        total_cost_usd: total,
        duration_ms: 5_000,
        usage: { input_tokens: 0, output_tokens: 0 },
        result: '',
      });
    result(40);

    adapter.args({
      prompt: 'carry on',
      cwd: profile,
      configDir: profile,
      resumeSessionId: sessionId,
    } as AgentTurnInput);
    appendFileSync(transcript, costState(40));
    adapter.line({ type: 'system', subtype: 'init', session_id: sessionId });
    const done = result(41).find((event) => event.type === 'turn_complete');

    expect(
      done?.type === 'turn_complete' ? done.usage?.costUsd : null,
    ).toBeCloseTo(1, 6);
  });
});

describe('ClaudeAdapter — editing the profile’s MCP servers', () => {
  /** A profile directory holding `.claude.json` with `config`. */
  function profile(config: Record<string, unknown>, mode = 0o644): string {
    const dir = tempDir('claude-mcp-config-');
    writeFileSync(join(dir, '.claude.json'), JSON.stringify(config, null, 2), {
      mode,
    });
    chmodSync(join(dir, '.claude.json'), mode);
    return dir;
  }
  const readFile = (dir: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as Record<
      string,
      unknown
    >;

  /** The user's whole CLI state — everything an MCP edit must leave alone. */
  const STATE = {
    userID: 'u-1',
    oauthAccount: { emailAddress: 'a@b.c' },
    projects: { '/proj': { disabledMcpServers: ['x'], history: [1, 2] } },
    mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
  };

  it('opens only the top-level `mcpServers`, with a version to save against', async () => {
    const dir = profile(STATE);
    const doc = await new ClaudeAdapter({}).readMcpConfigDocument({
      configDir: dir,
    });
    expect(doc).toMatchObject({
      servers: STATE.mcpServers,
      path: join(dir, '.claude.json'),
      unavailableReason: null,
    });
    expect(doc.version).toMatch(/^sha256:/);
  });

  it('rewrites `mcpServers` and keeps every other key, and the file’s own mode', async () => {
    const dir = profile(STATE, 0o640);
    const adapter = new ClaudeAdapter({});
    const doc = await adapter.readMcpConfigDocument({ configDir: dir });
    const next = { other: { command: 'npx', args: ['-y', 'x'] } };
    await expect(
      adapter.writeMcpConfigDocument({
        configDir: dir,
        servers: next,
        expectedVersion: doc.version,
      }),
    ).resolves.toEqual({ ok: true, changed: true });
    expect(readFile(dir)).toEqual({ ...STATE, mcpServers: next });
    expect(statSync(join(dir, '.claude.json')).mode & 0o777).toBe(0o640);
  });

  it('refuses a save against a document that moved since it was opened', async () => {
    const dir = profile(STATE);
    const adapter = new ClaudeAdapter({});
    const doc = await adapter.readMcpConfigDocument({ configDir: dir });
    // The user ran `claude mcp add` in their terminal meanwhile.
    writeFileSync(
      join(dir, '.claude.json'),
      JSON.stringify({ ...STATE, mcpServers: { added: { command: 'y' } } }),
    );
    await expect(
      adapter.writeMcpConfigDocument({
        configDir: dir,
        servers: {},
        expectedVersion: doc.version,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/changed since/),
    });
    expect(readFile(dir).mcpServers).toEqual({ added: { command: 'y' } });
  });

  it('refuses an unparseable config rather than replacing the user’s whole CLI state', async () => {
    const dir = tempDir('claude-mcp-config-');
    writeFileSync(join(dir, '.claude.json'), '{ not json');
    const adapter = new ClaudeAdapter({});
    await expect(
      adapter.readMcpConfigDocument({ configDir: dir }),
    ).resolves.toMatchObject({
      servers: null,
      unavailableReason: expect.stringMatching(/not valid JSON/),
    });
    await expect(
      adapter.writeMcpConfigDocument({
        configDir: dir,
        servers: {},
        expectedVersion: null,
      }),
    ).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(join(dir, '.claude.json'), 'utf8')).toBe('{ not json');
  });

  /** An `execFile` double that runs `claude mcp add` by writing what it would. */
  function fakeAdd(
    dir: string,
    entry: Record<string, unknown> | null,
    output: string,
  ): {
    execFileFn: typeof execFile;
    calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[];
  } {
    const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const execFileFn = ((
      _command: string,
      args: readonly string[],
      options: { env?: NodeJS.ProcessEnv },
      callback: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push({ args, env: options.env ?? {} });
      if (entry !== null) {
        const config = readFile(dir);
        writeFileSync(
          join(dir, '.claude.json'),
          JSON.stringify({
            ...config,
            mcpServers: {
              ...(config.mcpServers as object),
              [args[args.indexOf('--') + 1]!]: entry,
            },
          }),
        );
      }
      queueMicrotask(() =>
        callback(entry === null ? new Error('exit 1') : null, output, ''),
      );
      return new FakeChild() as unknown as ChildProcess;
    }) as unknown as typeof execFile;
    return { execFileFn, calls };
  }

  it('adds through `claude mcp add -s user` under the profile, options before `--`', async () => {
    const dir = profile(STATE);
    const exec = fakeAdd(
      dir,
      { type: 'http', url: 'https://acme/mcp' },
      'Added',
    );
    await expect(
      new ClaudeAdapter({ execFileFn: exec.execFileFn }).addMcpServer({
        configDir: dir,
        server: {
          name: 'acme',
          transport: 'http',
          command: null,
          args: [],
          env: {},
          url: 'https://acme/mcp',
          headers: { 'X-Api-Key': 'k-123' },
        },
      }),
    ).resolves.toEqual({ ok: true, changed: true });
    expect(exec.calls[0]?.args).toEqual([
      'mcp',
      'add',
      '-s',
      'user',
      '-t',
      'http',
      '-H',
      'X-Api-Key: k-123',
      '--',
      'acme',
      'https://acme/mcp',
    ]);
    expect(exec.calls[0]?.env.CLAUDE_CONFIG_DIR).toBe(dir);
  });

  it('passes a stdio server’s env as `-e KEY=VALUE` and its args after the command', async () => {
    const dir = profile(STATE);
    const exec = fakeAdd(dir, { type: 'stdio', command: 'npx' }, 'Added');
    await new ClaudeAdapter({ execFileFn: exec.execFileFn }).addMcpServer({
      configDir: dir,
      server: {
        name: 'probe',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@acme/mcp'],
        env: { A: '1', B: 'two' },
        url: null,
        headers: {},
      },
    });
    expect(exec.calls[0]?.args).toEqual([
      'mcp',
      'add',
      '-s',
      'user',
      '-e',
      'A=1',
      '-e',
      'B=two',
      '--',
      'probe',
      'npx',
      '-y',
      '@acme/mcp',
    ]);
  });

  it('reads success off the file, and reports the CLI’s words when the entry never landed', async () => {
    const dir = profile(STATE);
    const exec = fakeAdd(dir, null, 'Invalid transport type: weird');
    await expect(
      new ClaudeAdapter({ execFileFn: exec.execFileFn }).addMcpServer({
        configDir: dir,
        server: {
          name: 'probe',
          transport: 'stdio',
          command: 'x',
          args: [],
          env: {},
          url: null,
          headers: {},
        },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'claude did not add the server: Invalid transport type: weird',
    });
  });

  it('refuses a name the profile already defines, without running the CLI', async () => {
    const dir = profile(STATE);
    const exec = fakeAdd(dir, { command: 'x' }, 'Added');
    await expect(
      new ClaudeAdapter({ execFileFn: exec.execFileFn }).addMcpServer({
        configDir: dir,
        server: {
          name: 'linear',
          transport: 'stdio',
          command: 'x',
          args: [],
          env: {},
          url: null,
          headers: {},
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already exists/),
    });
    expect(exec.calls).toHaveLength(0);
  });
});

describe('ClaudeAdapter — forgetting a server’s needs-auth record', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop() as string, { recursive: true, force: true });
    }
  });
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-needs-auth-'));
    dirs.push(dir);
    return dir;
  };

  it('reads the default profile’s record from ~/.claude when no config directory is named', async () => {
    const home = tempDir();
    mkdirSync(join(home, '.claude'));
    const file = join(home, '.claude', 'mcp-needs-auth-cache.json');
    writeFileSync(
      file,
      JSON.stringify({
        'claude.ai Figma': { timestamp: 1 },
        other: { timestamp: 2 },
      }),
    );

    const forgot = await new ClaudeAdapter({
      homeDir: home,
    }).forgetMcpNeedsAuth({
      servers: ['claude.ai Figma', 'never listed'],
      configDir: null,
    });

    expect(forgot).toEqual(['claude.ai Figma']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      other: { timestamp: 2 },
    });
  });

  it('answers none and writes nothing when the server has no entry', async () => {
    const profile = tempDir();
    const file = join(profile, 'mcp-needs-auth-cache.json');
    const before = JSON.stringify({ other: { timestamp: 2 } }, null, 2);
    writeFileSync(file, before);

    const forgot = await new ClaudeAdapter().forgetMcpNeedsAuth({
      servers: ['claude.ai Figma'],
      configDir: profile,
    });

    expect(forgot).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('answers none when the profile has no record at all, creating none', async () => {
    const profile = tempDir();

    const forgot = await new ClaudeAdapter().forgetMcpNeedsAuth({
      servers: ['claude.ai Figma'],
      configDir: profile,
    });

    expect(forgot).toEqual([]);
    expect(existsSync(join(profile, 'mcp-needs-auth-cache.json'))).toBe(false);
  });

  it('keeps both removals when two clears of one record overlap', async () => {
    const profile = tempDir();
    const file = join(profile, 'mcp-needs-auth-cache.json');
    writeFileSync(
      file,
      JSON.stringify({
        a: { timestamp: 1 },
        b: { timestamp: 2 },
        c: { timestamp: 3 },
      }),
    );
    const adapter = new ClaudeAdapter();

    const [first, second] = await Promise.all([
      adapter.forgetMcpNeedsAuth({ servers: ['a'], configDir: profile }),
      adapter.forgetMcpNeedsAuth({ servers: ['b'], configDir: profile }),
    ]);

    expect(first).toEqual(['a']);
    expect(second).toEqual(['b']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      c: { timestamp: 3 },
    });
  });

  it('leaves a record it cannot parse untouched rather than replacing it', async () => {
    const profile = tempDir();
    const file = join(profile, 'mcp-needs-auth-cache.json');
    writeFileSync(file, '{"claude.ai Figma": {');

    const forgot = await new ClaudeAdapter().forgetMcpNeedsAuth({
      servers: ['claude.ai Figma'],
      configDir: profile,
    });

    expect(forgot).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('{"claude.ai Figma": {');
  });
});

describe('ClaudeAdapter — what a model name resolves to', () => {
  /** The `initialize` reply as 2.1.295 printed it, trimmed to what is read. */
  const INITIALIZE_REPLY = `${JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: CLAUDE_MODEL_RESOLUTION_REQUEST_ID,
      response: {
        models: [
          { value: 'default', resolvedModel: 'claude-opus-5-5' },
          {
            value: 'haiku',
            resolvedModel: 'claude-haiku-5-5',
            displayName: 'Haiku 5.5',
          },
          { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5' },
        ],
      },
    },
  })}\n`;
  const versionOf = (version: string): AgentVersionService =>
    ({
      resolve: () => Promise.resolve(version),
    }) as unknown as AgentVersionService;
  const VERSION = versionOf('2.1.295 (Claude Code)');

  interface ProbeSpawn {
    args: readonly string[];
    options: Record<string, unknown>;
    /** What the adapter wrote to the probe's stdin. */
    stdin: string[];
    /** Answer `stdout` and end the process — already done unless held. */
    answer: () => void;
  }

  /**
   * An adapter whose probe answers `stdout`, recording each process spawned.
   * A `held` probe answers only when the case calls its `answer`.
   */
  const probing = (
    stdout: string,
    vocabularyStore: ModelVocabularyStore = freshVocabularyStore(),
    options: { held?: boolean; versions?: AgentVersionService } = {},
  ): { adapter: ClaudeAdapter; spawns: ProbeSpawn[] } => {
    const spawns: ProbeSpawn[] = [];
    const groupSpawnFn = ((
      _command: string,
      args: readonly string[],
      spawnOptions: Record<string, unknown>,
    ) => {
      const fake = fakeGroupChild();
      const answer = (): void => {
        if (stdout) {
          fake.writeStdout(stdout);
        }
        fake.close(0);
      };
      spawns.push({
        args,
        options: spawnOptions,
        stdin: fake.stdinChunks,
        answer,
      });
      if (!options.held) {
        queueMicrotask(answer);
      }
      return fake.child;
    }) as unknown as typeof spawn;
    return {
      adapter: new ClaudeAdapter({
        groupSpawnFn,
        versions: options.versions ?? VERSION,
        vocabularyStore,
      }),
      spawns,
    };
  };
  /** Let a background probe spawn, or a held one take its answer. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  it('lists the CLI display names and resolved identities, also after a daemon restart', async () => {
    const store = freshVocabularyStore();
    const first = probing(INITIALIZE_REPLY, store);
    expect(await first.adapter.listModels({ configDir: null })).toContainEqual({
      id: 'haiku',
      label: 'Haiku 5.5',
      resolvedModel: 'claude-haiku-5-5',
      source: 'cli',
    });
    const restarted = probing('', store);
    expect(
      await restarted.adapter.modelDetails(
        { id: 'haiku', label: 'haiku', source: 'builtin' },
        null,
      ),
    ).toEqual({
      id: 'haiku',
      label: 'Haiku 5.5',
      resolvedModel: 'claude-haiku-5-5',
      source: 'cli',
    });
    expect(restarted.spawns).toHaveLength(0);
  });

  it('answers an alias and the default with what the CLI’s own initialize names, asked under the profile', async () => {
    const { adapter, spawns } = probing(INITIALIZE_REPLY);

    expect(await adapter.resolveModel('haiku', '/profiles/work')).toBe(
      'claude-haiku-5-5',
    );
    expect(await adapter.resolveModel(null, '/profiles/work')).toBe(
      'claude-opus-5-5',
    );
    expect(spawns[0]!.args).toEqual([...CLAUDE_MODEL_RESOLUTION_ARGS]);
    expect(
      (spawns[0]!.options.env as Record<string, string> | undefined)?.[
        CLAUDE_CONFIG_DIR_ENV
      ],
    ).toBe('/profiles/work');
    // The question itself: one `initialize` request, under the id the reader
    // waits for.
    expect(
      spawns[0]!.stdin
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([
      {
        type: 'control_request',
        request_id: CLAUDE_MODEL_RESOLUTION_REQUEST_ID,
        request: { subtype: 'initialize' },
      },
    ]);
  });

  it('answers the name itself when the CLI refuses the question', async () => {
    const { adapter } = probing(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: CLAUDE_MODEL_RESOLUTION_REQUEST_ID,
          error: 'unsupported',
        },
      })}\n`,
    );

    expect(await adapter.resolveModel('haiku', null)).toBe('haiku');
  });

  it('answers a name the reply does not list with the name itself', async () => {
    const { adapter } = probing(INITIALIZE_REPLY);

    expect(await adapter.resolveModel('claude-opus-5[1m]', null)).toBe(
      'claude-opus-5[1m]',
    );
  });

  it('asks once per profile and version, and serves the next launch from the store', async () => {
    const store = freshVocabularyStore();
    const first = probing(INITIALIZE_REPLY, store);
    await first.adapter.resolveModel('haiku', null);
    await first.adapter.resolveModel('sonnet', null);
    expect(first.spawns).toHaveLength(1);
    // Another profile is another answer.
    await first.adapter.resolveModel('haiku', '/profiles/work');
    expect(first.spawns).toHaveLength(2);

    const relaunched = probing(INITIALIZE_REPLY, store);
    expect(await relaunched.adapter.resolveModel('haiku', null)).toBe(
      'claude-haiku-5-5',
    );
    expect(relaunched.spawns).toHaveLength(0);

    // An upgraded CLI may resolve its aliases differently: asked again.
    const upgraded = probing(INITIALIZE_REPLY, store, {
      versions: versionOf('2.1.296 (Claude Code)'),
    });
    await upgraded.adapter.resolveModel('haiku', null);
    expect(upgraded.spawns).toHaveLength(1);
  });

  it('serves an aged answer at once and refreshes it behind the turn', async () => {
    const file = join(tempDir('claude-resolutions-'), 'vocabularies.json');
    let now = 1_000_000;
    const store = (): ModelVocabularyStore =>
      new ModelVocabularyStore({ file, now: () => now });
    await probing(INITIALIZE_REPLY, store()).adapter.resolveModel(
      'haiku',
      null,
    );

    now += 2 * 60 * 60_000;
    const later = probing(INITIALIZE_REPLY, store(), { held: true });
    expect(await later.adapter.resolveModel('haiku', null)).toBe(
      'claude-haiku-5-5',
    );
    await settle();
    expect(later.spawns).toHaveLength(1);
    later.spawns[0]!.answer();
    await settle();
  });

  it('keeps no answer whose probe straddled a sign-in', async () => {
    const store = freshVocabularyStore();
    const straddling = probing(INITIALIZE_REPLY, store, { held: true });
    const pending = straddling.adapter.resolveModel('haiku', null);
    await settle();
    // The account changed while the CLI was being asked.
    store.forget('claude');
    straddling.spawns[0]!.answer();
    await pending;

    const relaunched = probing(INITIALIZE_REPLY, store);
    await relaunched.adapter.resolveModel('haiku', null);
    expect(relaunched.spawns).toHaveLength(1);
  });

  it('keeps nothing from a probe that could not be read, and does not make every turn wait on it again', async () => {
    const { adapter, spawns } = probing('not json\n');

    expect(await adapter.resolveModel('haiku', null)).toBe('haiku');
    // A turn waits on this probe: a CLI that cannot answer is not re-asked
    // before every first turn.
    expect(await adapter.resolveModel('haiku', null)).toBe('haiku');
    expect(spawns).toHaveLength(1);
    // Clear Agent Cache asks again at once.
    adapter.clearCaches();
    await adapter.resolveModel('haiku', null);
    expect(spawns).toHaveLength(2);
  });

  it('asks again after a sign-in and after Clear Agent Cache, as the reset service makes them', async () => {
    const store = freshVocabularyStore();
    const { adapter, spawns } = probing(INITIALIZE_REPLY, store);
    await adapter.resolveModel('haiku', null);
    expect(spawns).toHaveLength(1);

    // A sign-in: `CacheResetService.forgetAgent` forgets the store's half and
    // asks the adapter to forget its own.
    store.forget('claude');
    expect(adapter.forgetAccountCaches()).toBe(1);
    await adapter.resolveModel('haiku', null);
    expect(spawns).toHaveLength(2);

    // Clear Agent Cache: `clearCaches` on both halves.
    store.clear();
    expect(adapter.clearCaches()).toBe(1);
    await adapter.resolveModel('haiku', null);
    expect(spawns).toHaveLength(3);
  });

  it('answers a window from the catalog for a bare id, never for a variant', () => {
    const price: ModelPrice = {
      input: 1,
      output: 5,
      cacheRead: null,
      cacheWrite: null,
      tiers: [],
      contextTokens: 1_000_000,
    };
    // The catalog's own lookup, by exact id under claude's provider.
    const catalog: Record<string, ModelPrice> = {
      'claude-haiku-5-5': price,
      'claude-opus-5': price,
    };
    const adapter = new ClaudeAdapter({
      prices: {
        priceOf: (provider, model) =>
          provider === 'anthropic' ? (catalog[model] ?? null) : null,
      },
    });

    expect(adapter.catalogWindow('claude-haiku-5-5')).toBe(1_000_000);
    // `[1m]` selects a window tier the catalog's id does not name, so the
    // variant is looked up as itself and misses.
    expect(adapter.catalogWindow('claude-opus-5[1m]')).toBeNull();
  });
});

describe('ClaudeAdapter.askOnce', () => {
  it('asks a throwaway `-p` turn on the cheap model outside any project, and answers its result', async () => {
    const { groupSpawnFn, captured } = fakeListing(
      JSON.stringify({ subtype: 'success', result: '[{"id":"n1"}]' }),
    );
    const answer = await new ClaudeAdapter({ groupSpawnFn }).askOnce({
      prompt: 'Sort these',
      model: null,
      configDir: '/Users/x/.claude-work',
    });
    expect(answer).toBe('[{"id":"n1"}]');
    expect(captured.args).toEqual(
      expect.arrayContaining(['-p', '--strict-mcp-config', 'Sort these']),
    );
    expect(captured.args![captured.args!.indexOf('--model') + 1]).toBe('haiku');
    expect(String(captured.options?.cwd)).toContain('geniro-ask-');
    expect(captured.options?.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/Users/x/.claude-work',
    });
  });

  it('asks at the chosen model, effort and fast mode, as a chat turn would', async () => {
    const { groupSpawnFn, captured } = fakeListing(
      JSON.stringify({ subtype: 'success', result: '[]' }),
    );
    await new ClaudeAdapter({ groupSpawnFn }).askOnce({
      prompt: 'Sort these',
      model: 'opus',
      configDir: null,
      effort: 'high',
      modelParameters: { [CLAUDE_FAST_MODE_PARAMETER_ID]: 'true' },
    });
    const args = captured.args!;
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({
      crossSessionInbound: 'refuse',
      [CLAUDE_FAST_MODE_PARAMETER_ID]: true,
    });
    expect(args.at(-1)).toBe('Sort these');
  });

  it('answers null for a failed turn', async () => {
    const { groupSpawnFn } = fakeListing(
      JSON.stringify({ is_error: true, result: 'Not logged in' }),
    );
    await expect(
      new ClaudeAdapter({ groupSpawnFn }).askOnce({
        prompt: 'Sort these',
        model: null,
        configDir: null,
      }),
    ).resolves.toBeNull();
  });
});
