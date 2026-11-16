import type { ChildProcess, execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearSecrets, redactSecrets } from '../../diagnostics/utils/redact';
import { fakeSpawn } from '../__tests__/fake-child';
import { AgentAdapterRegistry } from '../services/agent-adapter.registry';
import type { ProcessRegistry } from '../services/process-registry';
import { GROUP_KILL_GRACE_MS } from '../utils/kill-tree';
import type {
  ModelPrice,
  ModelPriceLookup,
  ModelPriceProvider,
} from '../utils/model-prices';
import type { SpawnedProcess, SpawnFn } from '../utils/spawn-cli';
import { fakeGroupChild, spawnAnswering } from './__tests__/fake-group-child';
import { freshVocabularyStore } from './__tests__/fresh-vocabulary-store';
import type {
  AdapterConfig,
  AgentApprovalMode,
  AgentCommandOptions,
  AgentEvent,
  AgentModel,
  AgentTurnInput,
  FollowUpMessage,
  TurnDriver,
} from './adapter.types';
import { AgentAdapter } from './agent-adapter';
import { ClaudeAdapter } from './claude/claude.adapter';
import { CodexAdapter } from './codex/codex.adapter';
import { CursorAcpAdapter } from './cursor-acp/cursor-acp.adapter';

/**
 * The config-driven members the base answers for EVERY adapter, driven through
 * every shipped one — the only way to prove a value-driven base did not
 * quietly change what an adapter used to decide for itself.
 */
const ADAPTERS: { name: string; adapter: AgentAdapter }[] = [
  { name: 'claude', adapter: new ClaudeAdapter() },
  {
    name: 'cursor-agent',
    adapter: new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    }),
  },
  { name: 'codex', adapter: new CodexAdapter({ clientVersion: '1.0.0' }) },
];

/**
 * A CLI that honours ONE mode and ALSO carries a probe-table entry for the
 * mode being asked for — the collision the two shipped adapters never have, and
 * the only shape that can tell the two orderings apart.
 */
class SoleModeWithProbeTableAdapter extends CursorAcpAdapter {
  // The store is a REQUIRED dependency of the real adapter, and a spec
  // subclass has to satisfy it like any other caller — see
  // `freshVocabularyStore`.
  constructor() {
    super({ vocabularyStore: freshVocabularyStore() });
  }

  override getConfig(): AdapterConfig {
    const base = super.getConfig();
    return {
      ...base,
      approval: {
        ...base.approval,
        // Declared, not inherited: every shipped adapter now honours several
        // modes, so the sole-mode collapse this pins has to be stated here or
        // the fixture stops exercising it.
        modes: ['auto'],
        soleModeDegradeReason: (requested) =>
          `test CLI has no approval callback — approval '${requested}' degrades to auto-approve for this turn`,
        degradeOnProbeFail: {
          acceptEdits: { to: 'ask', reason: 'probe table won' },
        },
      },
    };
  }
}

/**
 * The shipped claude report config, or a loud failure — the fixture below is
 * only meaningful over a CLI that DOES report its commands, so a claude that
 * stopped must break this spec rather than silently degrade it.
 */
function reportedCommandsOf(
  config: AdapterConfig,
): NonNullable<AdapterConfig['reportedCommands']> {
  if (!config.reportedCommands) {
    throw new Error(`${config.kind} declares no reportedCommands`);
  }
  return config.reportedCommands;
}

/**
 * A CLI that DOES report its own commands but declares no internal-name prefix
 * — the arm neither shipped adapter exercises through THIS spec (claude
 * declares `_`; cursor declares null and pins it in its own adapter spec).
 */
class NoInternalPrefixAdapter extends ClaudeAdapter {
  override getConfig(): AdapterConfig {
    const base = super.getConfig();
    return {
      ...base,
      reportedCommands: {
        // Track the SHIPPED config and override the one field under test —
        // hand-retyping the other values here is how a fixture starts
        // asserting against a claude that no longer exists.
        ...reportedCommandsOf(base),
        internalPrefix: null,
      },
    };
  }
}

/**
 * The slice of a child the turn plumbing touches, on real streams so a scripted
 * stdout line reaches the mapper — and DYING on the signal, because the probe
 * cancels its own turn and then awaits `done`.
 */
class ProbeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    setTimeout(() => this.emit('close', null, signal), 0);
    return true;
  }
}

const spawning = (child: ProbeChild): SpawnFn => {
  return () => child as unknown as SpawnedProcess;
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The signals a `process.kill` spy saw for ONE process group. The spy is
 * process-wide, so it also catches a stray from another spec's real-time
 * escalation timer landing in this one's window (seen on a slow CI runner) —
 * counting only this group's pins what the test claims.
 */
function signalsTo(
  killSpy: { mock: { calls: unknown[][] } },
  pgid: number,
): unknown[] {
  return killSpy.mock.calls
    .filter(([pid]) => pid === -pgid)
    .map(([, signal]) => signal);
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-probe-root-'));
  dirs.push(dir);
  return dir;
}

describe('AgentAdapter.resolveApprovalMode', () => {
  it('collapses a sole-mode CLI BEFORE consulting the probe table', () => {
    // Order is the behaviour: a single-mode CLI has nothing to probe, so a
    // probe-table entry must not route its turn to `ask` — a mode it does not
    // honour at all. Reversing the two steps yields { mode: 'ask' } here.
    const resolved = new SoleModeWithProbeTableAdapter().resolveApprovalMode(
      'acceptEdits',
      { supported: { acceptEdits: false } },
    );

    expect(resolved.mode).toBe('auto');
    expect(resolved.degradeReason).toContain(
      "approval 'acceptEdits' degrades to auto-approve",
    );
  });

  it('keeps the sole mode itself untouched, with nothing to report', () => {
    expect(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
      }).resolveApprovalMode('auto', {
        supported: { acceptEdits: false },
      }),
    ).toEqual({ mode: 'auto', degradeReason: null });
  });

  it("never degrades claude's plan — an executing fallback inverts what it promises", () => {
    // `plan` is probed exactly like acceptEdits and its FAIL is proved here,
    // yet it is deliberately ABSENT from claude's degradeOnProbeFail table:
    // turning a no-execute mode into an executing one would invert the intent
    // the user selected it for. Adding it "for completeness" fails this.
    expect(
      new ClaudeAdapter().resolveApprovalMode('plan', {
        supported: { plan: false },
      }),
    ).toEqual({ mode: 'plan', degradeReason: null });
  });

  it('degrades acceptEdits ONLY on a PROVED false, never on an absent verdict', () => {
    const adapter = new ClaudeAdapter();

    const proved = adapter.resolveApprovalMode('acceptEdits', {
      supported: { acceptEdits: false },
    });
    expect(proved.mode).toBe('ask');
    expect(proved.degradeReason).toContain('does not support acceptEdits');

    // Absent ≠ false: nobody asked this binary, so degrading here would
    // pre-empt the CLI's own answer on a guess.
    expect(
      adapter.resolveApprovalMode('acceptEdits', { supported: {} }),
    ).toEqual({ mode: 'acceptEdits', degradeReason: null });
    // And a PASS is not a reason to degrade either.
    expect(
      adapter.resolveApprovalMode('acceptEdits', {
        supported: { acceptEdits: true },
      }),
    ).toEqual({ mode: 'acceptEdits', degradeReason: null });
  });
});

describe('AgentAdapter approval probes', () => {
  for (const { name, adapter } of ADAPTERS) {
    it(`${name}'s published probe names exactly the modes it declares as probed`, () => {
      // The config says WHICH modes a turn must wait on a verdict for; the
      // probe is what supplies the verdict. The two disagreeing is how a CLI
      // either degrades a mode nobody tested or waits on one nothing answers.
      const probed: readonly AgentApprovalMode[] =
        adapter.getConfig().approval.probedModes;
      const probe = adapter.approvalProbe();
      if (probed.length === 0) {
        // Nothing declared, nothing published — and nothing proved either.
        expect(probe).toBeNull();
        expect(adapter.currentApprovalSupport()).toEqual({ supported: {} });
        return;
      }
      expect(probe?.modes.map(({ mode }) => mode).sort()).toEqual(
        [...probed].sort(),
      );
      // Unprobed (no probe services here) reads as unknown, never as a fail.
      expect(probe?.modes.every(({ status }) => status === 'unknown')).toBe(
        true,
      );
      expect(adapter.currentApprovalSupport()).toEqual({ supported: {} });
    });
  }
});

describe('AgentAdapter.listEfforts', () => {
  for (const { name, adapter } of ADAPTERS) {
    it(`hands back ${name}'s declared effort vocabulary, as a copy`, () => {
      expect(adapter.listEfforts()).toEqual([...adapter.getConfig().efforts]);
      // A caller must not be able to mutate the shared config through it.
      expect(adapter.listEfforts()).not.toBe(adapter.getConfig().efforts);
    });
  }
});

describe('AgentAdapter.mcp.interactiveOnlyNote', () => {
  it('claude names the built-ins its headless turns do NOT load', () => {
    // Probe evidence behind this, on 2.1.226: the CLI's own `/mcp` panel shows
    // a "Built-in MCPs (always available)" group holding claude-in-chrome and
    // computer-use, while a headless `system/init` advertises 210 tools (177
    // of them `mcp__`) with neither name among them. The panel is therefore
    // CORRECT to omit the rows — this sentence is what stops the user reading
    // that correctness as lost data.
    const note = new ClaudeAdapter().getConfig().mcp.interactiveOnlyNote;

    expect(note).toContain('claude-in-chrome');
    expect(note).toContain('computer-use');
    // It must say the servers are not loaded, not merely not listed: "not
    // shown" would read as a geniro limitation the user should report.
    expect(note).toContain('not loaded');
  });

  it('cursor claims no such split, because none was verified', () => {
    expect(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
      }).getConfig().mcp.interactiveOnlyNote,
    ).toBeNull();
  });
});

describe('AgentAdapter.followUp declares what the adapter can actually do', () => {
  /**
   * The delivery mechanism is protected and per-turn, so the renderer can only
   * learn about it through `config.followUp`. That makes the two a promise and
   * its implementation, in different files, with nothing in the type system
   * tying them together — so this is the tie.
   *
   * A config claiming a channel the adapter never implements is the failure
   * that matters: the composer would offer "send now", the daemon would answer
   * RUN_BUSY, and the message would silently sit in the queue the button said
   * it was skipping.
   *
   * There are TWO mechanisms and either satisfies the promise — a CLI whose
   * channel is one stdin LINE overrides `buildFollowUpPayload`, while one whose
   * channel is a request in a stateful protocol puts `sendFollowUp` on its
   * per-turn driver, since the frame needs session state to build. Asking about
   * the payload builder alone is what this pin used to do, and it fails the
   * ACP adapter for having the channel in the other place.
   */
  const payloadFor = (adapter: AgentAdapter): string | undefined =>
    (
      adapter as unknown as {
        buildFollowUpPayload(message: FollowUpMessage): string | undefined;
      }
    ).buildFollowUpPayload({ text: 'a follow-up', images: undefined });

  /** Does this adapter's per-turn driver own the channel instead? */
  const driverSends = (adapter: AgentAdapter): boolean =>
    typeof (
      adapter as unknown as {
        createTurnDriver(input: AgentTurnInput): TurnDriver;
      }
    ).createTurnDriver({ prompt: 'a turn', cwd: '/proj' }).sendFollowUp ===
    'function';

  for (const { name, adapter } of ADAPTERS) {
    it(`${name} says the same thing in its config and in its code`, () => {
      const configSaysItCan =
        adapter.getConfig().followUp.unavailableReason === null;

      expect(payloadFor(adapter) !== undefined || driverSends(adapter)).toBe(
        configSaysItCan,
      );
    });
  }

  it('is not vacuous — the shipped pair covers BOTH answers about INTERRUPTING', () => {
    // The `unavailableReason` half stopped covering both the moment cursor's
    // channel was found (it had been declared absent on the strength of the ACP
    // spec, and the binary accepts a second `session/prompt`). What genuinely
    // differs between the two CLIs now is what a press DOES — claude adds to
    // the turn, cursor cancels it — so that is what a careless copy-paste onto
    // a third adapter would flatten, and what this guards.
    const answers = ADAPTERS.map(
      ({ adapter }) => adapter.getConfig().followUp.interrupts,
    );

    expect(new Set(answers)).toEqual(new Set([true, false]));
  });

  for (const { name, adapter } of ADAPTERS) {
    it(`${name} reports consumption only over a stdin line it writes itself`, () => {
      // `runCliSession` tracks a follow-up until it is taken ONLY on the
      // stdin-line path; a driver that sends its own follow-ups decides its
      // own turn's end. So a config claiming acknowledgements with no line to
      // acknowledge would hold every result for a message nobody tracks — and
      // one with the line but no claim leaves the reported bug in place.
      if (adapter.getConfig().followUp.consumptionReported) {
        expect(payloadFor(adapter)).toBeDefined();
        expect(driverSends(adapter)).toBe(false);
      }
    });
  }

  it('gives a REASON, never a bare cannot', () => {
    for (const { adapter } of ADAPTERS) {
      const reason = adapter.getConfig().followUp.unavailableReason;
      // The renderer prints this on the disabled control. An empty string
      // would render as a control that refuses without saying why — the
      // silent refusal every capability field here exists to replace.
      if (reason !== null) {
        expect(reason.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe('AgentAdapter effort vocabulary and its reason agree', () => {
  /**
   * `efforts: []` hides the picker; `effortsUnavailableReason` is the only thing
   * that then explains what replaced it. The pair is what makes an inert effort
   * chip legible, and the combination this pins out is the one that shipped:
   * an empty vocabulary with no reason, which rendered a value the user could
   * not change and nothing anywhere saying where it comes from.
   */
  for (const { name, adapter } of ADAPTERS) {
    it(`${name} declares a reason exactly when it offers no efforts`, () => {
      const config = adapter.getConfig();

      expect(config.effortsUnavailableReason === null).toBe(
        config.efforts.length > 0,
      );
    });
  }

  it('gives a REASON, never a bare cannot', () => {
    // Deliberately NOT a "covers both answers" pin: BOTH shipped adapters now
    // declare a vocabulary, so such a test could only pass by inventing an
    // adapter with none. What matters is the agreement above, plus this — a
    // reason, when there is one, says something.
    for (const { adapter } of ADAPTERS) {
      const reason = adapter.getConfig().effortsUnavailableReason;
      if (reason !== null) {
        expect(reason.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('cursor offers the five levels its own agent enumerated', () => {
    // The item was "I cannot change the effort of a Cursor model". It was true
    // while this list was empty, and the cause was the HANDSHAKE, not the CLI:
    // `parameterizedModelPicker` turns one composed model id into a bare name
    // plus a real `effort` option. Every value here was accepted by the agent
    // (`xhigh` and `max` on claude-opus-5, both recorded as rejected before),
    // and `bogus` refused. Empty this list again and the item comes back.
    const config = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    }).getConfig();

    expect(config.efforts.map((effort) => effort.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(config.effortsUnavailableReason).toBeNull();
  });
});

describe('AgentAdapter context breakdown — the seam is per adapter', () => {
  /**
   * The readout has two halves that must agree: whether this adapter can
   * ANSWER "what is in the window", and the sentence shown when it cannot. A
   * declared channel with a reason beside it renders a panel that contradicts
   * itself; a silent adapter with no reason is the blank space the whole
   * `unavailableReason` family exists to replace.
   */
  const BREAKDOWN_ADAPTERS: {
    name: string;
    build: (spawn: SpawnFn) => AgentAdapter;
  }[] = [
    { name: 'claude', build: (spawn) => new ClaudeAdapter({ spawn }) },
    {
      name: 'cursor-agent',
      build: (spawn) =>
        new CursorAcpAdapter({
          vocabularyStore: freshVocabularyStore(),
          spawn,
        }),
    },
  ];

  for (const { name, build } of BREAKDOWN_ADAPTERS) {
    it(`${name} declares a reason exactly when it cannot answer`, () => {
      const { spawn } = fakeSpawn();

      expect(build(spawn).getConfig().usage.breakdown.kind).toBe('reads');
    });
  }

  it('names the CHANNEL each reading comes from, not merely that it has one', () => {
    // What the readout needs before it can explain an absent reading: claude
    // asks a running process, cursor reads a file the process left behind. A
    // caller that could not tell them apart said "the agent did not answer in
    // time" about a reaped claude chat it had asked nothing.
    const { spawn } = fakeSpawn();

    expect(new ClaudeAdapter({ spawn }).getConfig().usage.breakdown).toEqual({
      kind: 'reads',
      channel: 'live-process',
    });
    expect(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
      }).getConfig().usage.breakdown,
    ).toEqual({ kind: 'reads', channel: 'session-store' });
  });

  it('claude asks its LIVE process, and answers null when there is none', async () => {
    // Its whole channel is a question on the running stdin dialogue, so a
    // session id buys it nothing: the conversation lives in the CLI's own
    // store, which publishes no reading of itself.
    const { spawn, child } = fakeSpawn();
    const claude = new ClaudeAdapter({ spawn });
    const session = claude.startSession({ prompt: 'p', cwd: '/proj' });

    expect(
      await claude.readContextUsage({
        live: null,
        sessionId: 'sess-1',
        configDir: null,
      }),
    ).toBeNull();
    expect(child.stdin.written).not.toContain('get_context_usage');

    void claude.readContextUsage({
      live: session,
      sessionId: null,
      configDir: null,
    });
    expect(child.stdin.written).toContain('get_context_usage');

    session.close();
  });

  it('claude names no session of its own, so its title is always derived', async () => {
    // The measured half of the title feature (see `ClaudeAdapter`'s class doc):
    // this CLI's TUI writes an `ai-title` record, and a headless `-p` turn —
    // the only kind geniro runs — writes none, so the base's null is the
    // adapter's real answer rather than a missing override. An implementation
    // appearing here without that probe being re-run is what this pins.
    const { spawn } = fakeSpawn();

    await expect(
      new ClaudeAdapter({ spawn }).readSessionTitle('sess-1'),
    ).resolves.toBeNull();
  });

  it('claude reads plan limits from its process or a one-shot one, and cursor from the account', () => {
    const { spawn } = fakeSpawn();

    expect(new ClaudeAdapter({ spawn }).getConfig().usage.planLimits).toEqual({
      kind: 'reads',
      channel: 'live-process',
      oneShot: true,
    });
    expect(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        spawn,
      }).getConfig().usage.planLimits,
    ).toEqual({ kind: 'reads', channel: 'account' });
  });

  it('claude asks its LIVE process for plan limits, and answers null with none', async () => {
    // Same constraint as the breakdown: the account is not a property of the
    // conversation, but the only channel to ask about it is the conversation's
    // own process — so no process means no reading, and nothing written.
    const { spawn, child } = fakeSpawn();
    const claude = new ClaudeAdapter({ spawn });
    const session = claude.startSession({ prompt: 'p', cwd: '/proj' });

    expect(
      await claude.readPlanLimits({
        live: null,
        sessionId: 'sess-1',
        configDir: null,
      }),
    ).toBeNull();
    expect(child.stdin.written).not.toContain('get_usage');

    void claude.readPlanLimits({
      live: session,
      sessionId: null,
      configDir: null,
    });
    expect(child.stdin.written).toContain('get_usage');
    // Without it the CLI scans seven days of the profile's transcripts before
    // answering, and the reading timed out behind that scan on busy runs.
    expect(child.stdin.written).toContain('"skip_behaviors":true');

    session.close();
  });

  it('cursor answers plan limits without writing to its process', async () => {
    // An ACP process asked a claude control question would answer an error
    // frame mid-session; cursor's limits come from the account instead.
    class SignedOutCursor extends CursorAcpAdapter {
      protected override readAccessToken(): Promise<string | null> {
        return Promise.resolve(null);
      }
    }
    const { spawn, child } = fakeSpawn();
    const cursor = new SignedOutCursor({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    });
    const session = cursor.startSession({ prompt: 'p', cwd: '/proj' });
    const before = child.stdin.written;

    expect(
      await cursor.readPlanLimits({
        live: session,
        sessionId: 'sess-1',
        configDir: null,
      }),
    ).toBeNull();
    expect(child.stdin.written).toBe(before);

    session.close();
  });

  it('cursor reads its own store, and never writes to a process', async () => {
    // The case that forced the input to carry both channels: a cursor process
    // does not outlive its turn, so by the time a readout is opened there is
    // nothing running to ask — and its figures are on disk regardless.
    const { spawn, child } = fakeSpawn();
    const cursor = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
      sessionStoreDir: mkdtempSync(join(tmpdir(), 'cursor-store-')),
    });
    const session = cursor.startSession({ prompt: 'p', cwd: '/proj' });
    const before = child.stdin.written;

    // No session id: nothing to look up, and nothing asked of the process.
    expect(
      await cursor.readContextUsage({
        live: session,
        sessionId: null,
        configDir: null,
      }),
    ).toBeNull();
    // A session id with no store behind it: the same null, still no write.
    expect(
      await cursor.readContextUsage({
        live: session,
        sessionId: 'missing',
        configDir: null,
      }),
    ).toBeNull();
    expect(child.stdin.written).toBe(before);

    session.close();
  });
});

describe('AgentAdapter — the sign-in and sign-out argv each CLI declares', () => {
  // The LITERAL argv of each command, probe-read from the binaries' own help
  // (claude 2.1.227 `claude auth --help`; cursor-agent 2026.08.04-aaa8809
  // `--help` and `logout --help`; codex-cli 0.157.1 `login --help`,
  // `logout --help` and `mcp --help`). Spelled here ON PURPOSE: these values are
  // the whole of what the daemon knows about how to sign a CLI in, and a spec
  // that read them back out of `getConfig()` would catch only a wrong FIELD —
  // a wrong probe-derived VALUE, which is what actually runs a subcommand the
  // binary does not have, would ship green.
  const EXPECTED: Record<
    string,
    { login: string[]; logout: string[]; mcpLogin: string[] }
  > = {
    claude: {
      login: ['auth', 'login'],
      logout: ['auth', 'logout'],
      mcpLogin: ['mcp', 'login'],
    },
    'cursor-agent': {
      login: ['login'],
      logout: ['logout'],
      mcpLogin: ['mcp', 'login'],
    },
    codex: {
      login: ['login'],
      logout: ['logout'],
      mcpLogin: ['mcp', 'login'],
    },
  };

  /**
   * Throws rather than falling back, so an adapter added without a probe record
   * fails loudly here instead of being asserted against `undefined` — which
   * `toEqual` would accept from a config field that had gone missing too.
   */
  const expectedFor = (
    name: string,
  ): { login: string[]; logout: string[]; mcpLogin: string[] } => {
    const found = EXPECTED[name];
    if (!found) {
      throw new Error(`no probe-read argv recorded for ${name}`);
    }
    return found;
  };

  for (const { name, adapter } of ADAPTERS) {
    it(`carries ${name}'s probe-read account argv`, () => {
      const { auth, mcp } = adapter.getConfig();
      const expected = expectedFor(name);
      expect(auth.loginArgs).toEqual(expected.login);
      expect(auth.logoutArgs).toEqual(expected.logout);
      expect(mcp.loginArgs).toEqual(expected.mcpLogin);
    });

    it(`keeps ${name}'s three sign-in commands apart`, () => {
      // They are reached by three different failures and are one config field
      // apart. An `auth.loginArgs` that aliased the MCP one sends a user whose
      // ACCOUNT session expired to a command that cannot fix it; a
      // `logoutArgs` copied from `loginArgs` signs them back IN under a button
      // that says the opposite.
      const { auth, mcp } = adapter.getConfig();
      expect(auth.loginArgs).not.toEqual(auth.logoutArgs);
      expect(auth.loginArgs).not.toEqual(mcp.loginArgs);
    });
  }

  it('runs nothing for a CLI that declares no account sign-in', async () => {
    // The defensive arm, entered deliberately. Neither shipped CLI reaches it,
    // and a `loginArgs: null` that spread an empty argv instead would spawn a
    // bare `claude` — an ordinary interactive session, held open by a service
    // that believes it is watching a sign-in.
    class NoAuthAdapter extends ClaudeAdapter {
      override getConfig(): AdapterConfig {
        const base = super.getConfig();
        return { ...base, auth: { ...base.auth, loginArgs: null } };
      }
    }
    const onSpawn = vi.fn();
    await expect(
      new NoAuthAdapter().runLogin({ timeoutMs: 1_000, onSpawn }),
    ).resolves.toBeNull();
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('runs nothing for a CLI that declares no account sign-out', async () => {
    // Same arm on the destructive half, and it is the one that matters more: a
    // bare `claude` here would leave the user signed IN while the card reported
    // the sign-out done.
    class NoLogoutAdapter extends ClaudeAdapter {
      override getConfig(): AdapterConfig {
        const base = super.getConfig();
        return { ...base, auth: { ...base.auth, logoutArgs: null } };
      }
    }
    const onSpawn = vi.fn();
    await expect(
      new NoLogoutAdapter().runLogout({ timeoutMs: 1_000, onSpawn }),
    ).resolves.toBe(false);
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('runs nothing for a CLI that declares no MCP sign-in', async () => {
    // And on the server half, where an empty argv would compose `claude
    // <server-name>` — the server's name run as a PROMPT.
    class NoMcpLoginAdapter extends ClaudeAdapter {
      override getConfig(): AdapterConfig {
        const base = super.getConfig();
        return { ...base, mcp: { ...base.mcp, loginArgs: null } };
      }
    }
    const onSpawn = vi.fn();
    await expect(
      new NoMcpLoginAdapter().runMcpLogin({
        server: 'probe-linear',
        cwd: process.cwd(),
        timeoutMs: 1_000,
        onSpawn,
      }),
    ).resolves.toBeNull();
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('reads each CLI’s OWN code-prompt answer, which is not the same answer', () => {
    // The measured split this exists for: claude prints `Paste code here if
    // prompted >` and cursor polls to completion needing nothing. Both directions
    // are asserted, because a shared default of either value would look correct
    // for one CLI and put a dead input field (or none at all) in front of the
    // other.
    const claude = new ClaudeAdapter();
    const cursor = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    });

    expect(claude.loginWantsCode('Paste code here if prompted > ')).toBe(true);
    // Case- and punctuation-insensitive, since the words are the stable part.
    expect(claude.loginWantsCode('PASTE CODE HERE >')).toBe(true);
    expect(claude.loginWantsCode('Waiting for browser authentication...')).toBe(
      false,
    );
    // cursor's real output, verbatim — it must never ask for a code.
    expect(
      cursor.loginWantsCode(
        'Starting login process...\nWaiting for browser authentication...\nOpen a browser and navigate to this link: https://cursor.com/login\n',
      ),
    ).toBe(false);
    expect(cursor.loginWantsCode('Paste code here if prompted > ')).toBe(false);
  });
});

describe('AgentAdapter question channel', () => {
  /**
   * One question payload per CLI — each in ITS OWN wire shape, because the
   * whole point of the seam is that no layer above the adapter knows them
   * apart. Claude's is an AskUserQuestion tool input; cursor's is the params
   * of its `cursor/ask_question` JSON-RPC request; codex's is the params of
   * its `item/tool/requestUserInput` server request.
   *
   * A CLI with no channel gets claude's, arbitrarily: the assertion for it is
   * that the base default ignores whatever it is handed.
   */
  const QUESTION_INPUTS: Record<string, unknown> = {
    claude: {
      questions: [
        {
          question: 'Which color?',
          options: [{ label: 'Red' }, { label: 'Blue' }],
        },
      ],
    },
    'cursor-agent': {
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
    },
    codex: {
      threadId: 't',
      turnId: 'u',
      itemId: 'call_q',
      questions: [
        {
          id: 'q1',
          question: 'Which color?',
          options: [{ label: 'Red' }, { label: 'Blue' }],
        },
      ],
    },
  };
  const NO_CHANNEL_INPUT = QUESTION_INPUTS.claude;

  for (const { name, adapter } of ADAPTERS) {
    it(`projects a question exactly when ${name} declares a question tool`, () => {
      // The two halves of the seam must agree with the ONE declared fact: a
      // CLI with `questionToolName: null` has no channel, so the base default
      // answers null and echoes the input BY REFERENCE (nothing to fold into);
      // a CLI that declares one must override both, or a callee's question
      // reaches its caller blank and the answer never reaches the CLI.
      const hasChannel = adapter.getConfig().questionToolName !== null;
      const input = QUESTION_INPUTS[name] ?? NO_CHANNEL_INPUT;

      expect(adapter.questionFrom(input) !== null).toBe(hasChannel);
      expect(adapter.withAnswer(input, 'Red') === input).toBe(!hasChannel);
    });
  }

  it('carries every CLI’s question through the shared projection', () => {
    // What the caller envelope and the renderer card are built from. Both
    // adapters must land on the same shape out of payloads that share no
    // field name — which is the property that lets `AdapterQuestion` be the
    // only thing either consumer knows.
    for (const { name, adapter } of ADAPTERS) {
      if (adapter.getConfig().questionToolName === null) {
        continue;
      }
      expect(adapter.questionFrom(QUESTION_INPUTS[name])).toEqual({
        text: 'Which color?',
        options: ['Red', 'Blue'],
      });
    }
  });
});

/**
 * A CLI that makes NO self-report. Declared here rather than borrowed from a
 * shipped adapter: cursor-agent used to be the example and stopped being one
 * the moment it gained a probe, which silently turned the "never spawns" test
 * into a test of nothing. A fixture that says what it is cannot be outgrown.
 */
class NoReportAdapter extends ClaudeAdapter {
  override getConfig(): AdapterConfig {
    return { ...super.getConfig(), reportedCommands: null };
  }
}

describe('AgentAdapter.listReportedCommands', () => {
  it('answers [] without spawning when the CLI makes no such report', async () => {
    // `reportedCommands: null` is a declared fact — this CLI has nothing to be
    // asked. The base must honour it by never starting a turn: a probe spawn
    // per autocomplete read, for a CLI that can only answer nothing, is pure
    // cost. Asserted against a fixture rather than a shipped adapter, because
    // the shipped one that used to declare null (cursor-agent) now declares a
    // probe, and this test would have gone on passing while measuring nothing.
    let spawned = 0;
    const spawn: SpawnFn = () => {
      spawned += 1;
      throw new Error('the probe must not spawn for a CLI with no report');
    };
    // A usable probe root on purpose: the ONLY thing that may keep this from
    // spawning is the config gate, never a workspace that could not be made.
    const adapter = new NoReportAdapter({ spawn, probeRootDir: tempDir() });

    await expect(adapter.listReportedCommands()).resolves.toEqual([]);
    expect(spawned).toBe(0);
  });

  it('keeps every reported name when the CLI declares no internal prefix', async () => {
    // `internalPrefix` is per-CLI DATA, and null means "this CLI has no
    // internal names" — dropping a `_`-prefixed command for such a CLI would
    // hide a command the user can genuinely invoke.
    const child = new ProbeChild();
    const adapter = new NoInternalPrefixAdapter({
      spawn: spawning(child),
      probeRootDir: tempDir(),
    });

    const reported = adapter.listReportedCommands();
    child.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'probe-1',
        slash_commands: ['clear', '_hidden'],
      })}\n`,
    );

    await expect(reported).resolves.toEqual([
      { name: 'clear', description: null },
      { name: '_hidden', description: null },
    ]);
  });

  it('runs the probe under the caller’s PROFILE, where its plugins live', async () => {
    // A profile carries its own installed plugins, whose commands are what
    // this probe exists to find. It ran under the DEFAULT profile whatever the
    // caller asked, so a chat on a profile listed another account's commands.
    // Observed on the spawn itself — the env the CLI actually starts under.
    const child = new ProbeChild();
    let env: NodeJS.ProcessEnv | undefined;
    const spawn: SpawnFn = (_command, _args, options) => {
      env = options.env;
      return child as unknown as SpawnedProcess;
    };
    const profile = tempDir();
    const adapter = new NoInternalPrefixAdapter({
      spawn,
      probeRootDir: tempDir(),
    });

    const reported = adapter.listReportedCommands({ configDir: profile });
    child.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'probe-1',
        slash_commands: ['clear'],
      })}\n`,
    );
    await reported;

    expect(env?.CLAUDE_CONFIG_DIR).toBe(profile);
  });
});

describe('AgentAdapter.supportsLiveStream', () => {
  it('answers false without spawning when the CLI has no such mode', async () => {
    // cursor-agent's `liveStream: null` is the declared fact; the base must
    // honour it by never reaching for the binary at all.
    let spawned = 0;
    const execFileFn = ((
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, out: string) => void,
    ) => {
      spawned += 1;
      cb(null, '  --include-partial-messages\n');
      return {} as ChildProcess;
    }) as unknown as typeof execFile;
    const adapter = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      execFileFn,
    });

    await expect(adapter.supportsLiveStream()).resolves.toBe(false);
    expect(spawned).toBe(0);
  });
});

/**
 * The bare minimum an adapter author must supply, and NOTHING else.
 *
 * Built on `AgentAdapter` itself rather than on a shipped adapter because both
 * shipped ones now override `listMcpServers` — subclassing either would inherit
 * that override and never reach the base fallback these cases exist to pin.
 * (Milestone 4: cursor gained a real listing, and this fixture used to extend
 * it.)
 */
class BareAdapter extends AgentAdapter {
  constructor(private readonly listingReason: string | null) {
    super({});
  }

  protected get command(): string {
    // Never spawned: neither base path this fixture exercises reaches a child.
    return 'no-such-binary';
  }

  getConfig(): AdapterConfig {
    const base = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    }).getConfig();
    return {
      ...base,
      mcp: { ...base.mcp, listingUnavailableReason: this.listingReason },
    };
  }

  protected buildArgs(): string[] {
    return [];
  }

  protected mapMessage(): AgentEvent[] {
    throw new Error('not exercised');
  }

  override listModels(): Promise<AgentModel[]> {
    return Promise.resolve([]);
  }
}

/**
 * A CLI that CAN keep a process between turns and holds the stdin dialogue,
 * but has no message for changing its approval mode — the case the base's
 * re-mode refusal exists for beyond a process spawned without the dialogue.
 */
class SessionWithoutModeChangeAdapter extends AgentAdapter {
  constructor(spawn: SpawnFn) {
    super({ spawn });
  }

  protected override keepStdinOpen(): boolean {
    return true;
  }

  protected get command(): string {
    return 'sessionful-cli';
  }

  getConfig(): AdapterConfig {
    return new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    }).getConfig();
  }

  protected buildArgs(): string[] {
    return [];
  }

  /** `{"done":true}` is this fake CLI's whole result-line vocabulary. */
  protected mapMessage(obj: unknown): AgentEvent[] {
    return (obj as { done?: boolean }).done === true
      ? [
          {
            type: 'turn_complete',
            usage: null,
            stopReason: null,
            finalText: null,
          },
        ]
      : [];
  }

  override listModels(): Promise<AgentModel[]> {
    return Promise.resolve([]);
  }

  protected override canHostSession(): boolean {
    return true;
  }

  protected override buildNextTurnPayload(): string {
    return 'next\n';
  }

  // Left at the base default (undefined) on purpose: this CLI has no such
  // message, which is exactly what the refusal below is about.
}

/** The same fake CLI, plus the in-protocol stop a real one answers. */
class InterruptibleSessionAdapter extends SessionWithoutModeChangeAdapter {
  protected override buildInterruptPayload(): string {
    return 'INTERRUPT\n';
  }
}

/**
 * The same fake CLI, with a vocabulary for a delegate that runs a command of
 * its own: a launch, the delegate's tool call, and the command's start and
 * end — the lines that make the underlying session hold a delegate's command.
 */
class DelegateCommandAdapter extends SessionWithoutModeChangeAdapter {
  protected override mapMessage(obj: unknown): AgentEvent[] {
    const row = obj as {
      launch?: string;
      run?: string;
      parent?: string;
      command?: string;
      settle?: string;
    };
    if (typeof row.launch === 'string') {
      return [
        {
          type: 'background_work',
          id: 'delegate-work',
          phase: 'started',
          unit: 'agent',
          toolCallId: row.launch,
        },
      ];
    }
    if (typeof row.run === 'string') {
      return [
        {
          type: 'tool_call',
          id: row.run,
          name: 'Bash',
          input: {},
          parentToolUseId: row.parent,
        },
      ];
    }
    if (typeof row.command === 'string') {
      return [
        {
          type: 'background_work',
          id: row.command,
          phase: 'started',
          unit: 'other',
          toolCallId: `toolu_${row.command}`,
          ownedByDelegate: true,
        },
      ];
    }
    if (typeof row.settle === 'string') {
      return [
        {
          type: 'background_work',
          id: row.settle,
          phase: 'settled',
          unit: 'other',
          toolCallId: null,
        },
      ];
    }
    return super.mapMessage(obj);
  }
}

describe('AgentAdapter session — the delegate-command hold reaches the registry', () => {
  // The subagent recovery service writes a terminal row for a delegate unless
  // the registry's session says the delegate's command is still running, and
  // the registry can only ask the object the adapter handed it.
  it('answers subagentRecoveryBlocked with what the underlying CLI session says', () => {
    const { spawn, child } = fakeSpawn();
    const input: AgentTurnInput = { prompt: 'first', cwd: '/proj' };
    const session = new DelegateCommandAdapter(spawn).startSession(input, {
      runScoped: true,
    });
    session.startTurn(input, () => {});

    child.stdout.emitData('{"launch":"toolu_launch"}\n');
    child.stdout.emitData(
      '{"run":"toolu_build","parent":"toolu_launch"}\n{"command":"build"}\n',
    );

    // The delegate named by the launching call is blocked; another is not.
    expect(session.subagentRecoveryBlocked?.('toolu_launch')).toBe(true);
    expect(session.subagentRecoveryBlocked?.('toolu_unrelated')).toBe(false);

    child.stdout.emitData('{"settle":"build"}\n');

    expect(session.subagentRecoveryBlocked?.('toolu_launch')).toBe(false);
  });
});

describe('AgentAdapter keeps a stopped session serving turns', () => {
  it('does not retire a session whose stopped turn the CLI ended itself', async () => {
    // Stop leaves the process RUNNING — pressing it must not take the user's
    // MCP servers down with the turn — and, once the CLI has ended the stopped
    // turn on its own line, able to serve the next one: nothing of the stopped
    // turn trails that line (measured on claude 2.1.266). Retiring it had the
    // registry replace the process on the next message, which is what closed a
    // Playwright browser the agent had open.
    const { spawn, child } = fakeSpawn();
    const input: AgentTurnInput = { prompt: 'first', cwd: '/proj' };
    const session = new InterruptibleSessionAdapter(spawn).startSession(input, {
      runScoped: true,
    });

    const turn = session.startTurn(input, () => {});
    turn?.cancel();
    // The CLI acknowledges the interrupt and ends the turn on it, rather than
    // being killed — which is the whole state under test.
    child.stdout.emitData('{"done":true}\n');
    await turn?.done;

    expect(session.alive).toBe(true);
    // Read off the declared session contract, deliberately: this is the answer
    // `AgentSessionRegistry.evictIfFull` acts on, through the wrapper.
    expect(session.retired).toBe(false);
    expect(session.startTurn(input, () => {})).not.toBeNull();
  });
});

describe('AgentAdapter sessions separate on the custom instructions', () => {
  /**
   * Open a session, run its first turn, and SETTLE that turn.
   *
   * Settling is load-bearing rather than tidiness: a session with a turn still
   * in flight refuses the next one for being busy, which looks identical to
   * refusing it for a mismatched key — so a "refuses on changed instructions"
   * assertion written against a live turn passes with `sessionKey` reverted.
   */
  async function sessionAfterFirstTurn(
    customInstructions: string,
  ): Promise<ReturnType<AgentAdapter['startSession']>> {
    const { spawn, child } = fakeSpawn();
    const input: AgentTurnInput = {
      prompt: 'first',
      cwd: '/proj',
      customInstructions,
    };
    const session = new SessionWithoutModeChangeAdapter(spawn).startSession(
      input,
      { runScoped: true },
    );
    const turn = session.startTurn(input, () => {});
    child.stdout.emitData('{"done":true}\n');
    await turn?.done;
    return session;
  }

  it('refuses to serve a turn whose custom instructions differ from the spawn’s', async () => {
    // The instructions are baked into the composed block that becomes argv for
    // claude and the leading prompt text for ACP — so they belong to the
    // SPAWN, exactly like the role beside them. Without them in `sessionKey`
    // the kept process takes the second turn silently, and that turn runs
    // under the first run's instructions while the settings screen and the run
    // row both read the new ones.
    const session = await sessionAfterFirstTurn('BE TERSE');

    expect(
      session.startTurn(
        { prompt: 'second', cwd: '/proj', customInstructions: 'BE VERBOSE' },
        () => {},
      ),
    ).toBeNull();
  });

  it('still reuses the process when the instructions are unchanged', async () => {
    // The control the refusal above needs to mean anything: without it, an
    // implementation that refused EVERY second turn would pass that test while
    // costing every chat its kept process — and its MCP servers — per message.
    const session = await sessionAfterFirstTurn('BE TERSE');

    expect(
      session.startTurn(
        { prompt: 'second', cwd: '/proj', customInstructions: 'BE TERSE' },
        () => {},
      ),
    ).not.toBeNull();
  });

  it('refuses to serve a turn whose reply language differs from the spawn’s', async () => {
    const session = await sessionAfterFirstTurn('BE TERSE');

    expect(
      session.startTurn(
        {
          prompt: 'second',
          cwd: '/proj',
          customInstructions: 'BE TERSE',
          replyLanguage: 'Russian',
        },
        () => {},
      ),
    ).toBeNull();
  });
});

describe('AgentAdapter sessions and the project instructions', () => {
  async function sessionAfterFirstTurn(): Promise<
    ReturnType<AgentAdapter['startSession']>
  > {
    const { spawn, child } = fakeSpawn();
    const first: AgentTurnInput = {
      prompt: 'first',
      cwd: '/proj',
      projectInstructions: 'Project: Billing\n\nUse pnpm.',
    };
    const session = new SessionWithoutModeChangeAdapter(spawn).startSession(
      first,
      { runScoped: true },
    );
    const turn = session.startTurn(first, () => {});
    child.stdout.emitData('{"done":true}\n');
    await turn?.done;
    return session;
  }

  it('refuses a turn whose project instructions differ from the spawn’s', async () => {
    const session = await sessionAfterFirstTurn();

    expect(
      session.startTurn(
        {
          prompt: 'second',
          cwd: '/proj',
          projectInstructions: 'Project: Billing\n\nEdited.',
        },
        () => {},
      ),
    ).toBeNull();
    expect(
      session.startTurn({ prompt: 'second', cwd: '/proj' }, () => {}),
    ).toBeNull();
  });

  it('reuses the process for a turn carrying the same project instructions', async () => {
    const session = await sessionAfterFirstTurn();

    expect(
      session.startTurn(
        {
          prompt: 'second',
          cwd: '/proj',
          projectInstructions: 'Project: Billing\n\nUse pnpm.',
        },
        () => {},
      ),
    ).not.toBeNull();
  });

  it('composes them whether or not the turn’s MCP tools were delivered, since they name none', () => {
    const adapter = new SessionWithoutModeChangeAdapter(fakeSpawn().spawn);
    const input: AgentTurnInput = {
      prompt: 'p',
      cwd: '/proj',
      projectInstructions: 'Project: Billing',
    };

    for (const granted of [true, false]) {
      expect(
        adapter.turnInstructionParts(input, granted).map((part) => part.source),
      ).toContain('projectInstructions');
    }
  });
});

describe('AgentAdapter sessions and the shared memory', () => {
  const FIRST: AgentTurnInput = {
    prompt: 'first',
    cwd: '/proj',
    memoryIndex: 'Memory index …\n- m1 [user] Terse (global)',
    knowledgeIndex:
      'Knowledge index …\n- release — Release. When: now. (global, 1.0 KB)',
    nativeMemoryOff: true,
  };

  async function sessionAfterFirstTurn(): Promise<
    ReturnType<AgentAdapter['startSession']>
  > {
    const { spawn, child } = fakeSpawn();
    const session = new SessionWithoutModeChangeAdapter(spawn).startSession(
      FIRST,
      { runScoped: true },
    );
    const turn = session.startTurn(FIRST, () => {});
    child.stdout.emitData('{"done":true}\n');
    await turn?.done;
    return session;
  }

  it('reuses the process for a turn carrying the same snapshot', async () => {
    const session = await sessionAfterFirstTurn();

    expect(
      session.startTurn({ ...FIRST, prompt: 'second' }, () => {}),
    ).not.toBeNull();
  });

  it('reuses the process across an absent and a null index, the two ways a run says it has none', async () => {
    const { spawn, child } = fakeSpawn();
    const first: AgentTurnInput = { prompt: 'first', cwd: '/proj' };
    const session = new SessionWithoutModeChangeAdapter(spawn).startSession(
      first,
      { runScoped: true },
    );
    const turn = session.startTurn(first, () => {});
    child.stdout.emitData('{"done":true}\n');
    await turn?.done;

    expect(
      session.startTurn(
        { prompt: 'second', cwd: '/proj', memoryIndex: null },
        () => {},
      ),
    ).not.toBeNull();
  });

  it('moves the session key with the index', async () => {
    const session = await sessionAfterFirstTurn();

    expect(
      session.startTurn(
        { ...FIRST, prompt: 'second', knowledgeIndex: null },
        () => {},
      ),
    ).toBeNull();
  });

  it('refuses a turn whose memory index differs from the spawn’s', async () => {
    const session = await sessionAfterFirstTurn();

    expect(
      session.startTurn(
        { ...FIRST, prompt: 'second', memoryIndex: null },
        () => {},
      ),
    ).toBeNull();
  });

  it('refuses a turn whose native-memory switch differs from the spawn’s', async () => {
    const session = await sessionAfterFirstTurn();

    expect(
      session.startTurn(
        { ...FIRST, prompt: 'second', nativeMemoryOff: false },
        () => {},
      ),
    ).toBeNull();
  });

  it('composes the index only where the turn’s MCP tools were delivered', () => {
    const adapter = new SessionWithoutModeChangeAdapter(fakeSpawn().spawn);

    const granted = adapter.turnInstructionParts(FIRST, true);
    const withheld = adapter.turnInstructionParts(FIRST, false);

    expect(granted.map((part) => part.source)).toContain('memoryIndex');
    expect(withheld.map((part) => part.source)).not.toContain('memoryIndex');
    expect(granted.map((part) => part.source)).toContain('knowledgeIndex');
    expect(withheld.map((part) => part.source)).not.toContain('knowledgeIndex');
  });
});

describe('AgentAdapter sessions separate on a working directory made again', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A session spawned in a real directory, its first turn settled. */
  async function sessionIn(
    cwd: string,
  ): Promise<ReturnType<AgentAdapter['startSession']>> {
    const { spawn, child } = fakeSpawn();
    const input: AgentTurnInput = { prompt: 'first', cwd };
    const session = new SessionWithoutModeChangeAdapter(spawn).startSession(
      input,
      { runScoped: true },
    );
    const turn = session.startTurn(input, () => {});
    child.stdout.emitData('{"done":true}\n');
    await turn?.done;
    return session;
  }

  it('refuses a turn once the directory it was spawned in was replaced at the same path', async () => {
    // A task's worktree is collected when its card is Done and cut again at
    // the SAME path when the chat is continued. The kept process is still in
    // the deleted directory, and codex's app-server refused the turn there
    // (`invalid cwd: No such file or directory`). The path never changed, so
    // only the directory's identity can tell the two apart.
    const cwd = mkdtempSync(join(tmpdir(), 'geniro-cwd-'));
    made.push(cwd);
    const session = await sessionIn(cwd);

    // A real child holds its old cwd's inode alive. The fake child does not,
    // so Linux can reuse the inode immediately after removal. Retain the old
    // directory to model that reference and guarantee a different identity.
    const retired = `${cwd}-retired`;
    renameSync(cwd, retired);
    made.push(retired);
    mkdirSync(cwd);

    expect(session.startTurn({ prompt: 'second', cwd }, () => {})).toBeNull();
  });

  it('still reuses the process while its directory stands', async () => {
    // The control: an implementation refusing every second turn would pass the
    // test above while respawning every chat — and its MCP servers — per
    // message.
    const cwd = mkdtempSync(join(tmpdir(), 'geniro-cwd-'));
    made.push(cwd);
    const session = await sessionIn(cwd);

    expect(
      session.startTurn({ prompt: 'second', cwd }, () => {}),
    ).not.toBeNull();
  });
});

describe('AgentAdapter sessions separate on a card’s task instructions', () => {
  /** Open a session on one set of task instructions and settle its first turn. */
  async function sessionAfterFirstTurn(
    taskInstructions: string,
  ): Promise<ReturnType<AgentAdapter['startSession']>> {
    const { spawn, child } = fakeSpawn();
    const input: AgentTurnInput = {
      prompt: 'first',
      cwd: '/proj',
      taskInstructions,
    };
    const session = new SessionWithoutModeChangeAdapter(spawn).startSession(
      input,
      { runScoped: true },
    );
    const turn = session.startTurn(input, () => {});
    child.stdout.emitData('{"done":true}\n');
    await turn?.done;
    return session;
  }

  it('refuses to serve a turn whose task instructions differ from the spawn’s', async () => {
    // A continued card rewrites its task instructions onto the run; the kept
    // process was spawned with the old block baked in, so serving the next
    // turn from it would silently run on the label instructions the user
    // just changed.
    const session = await sessionAfterFirstTurn('LABEL A');

    expect(
      session.startTurn(
        { prompt: 'second', cwd: '/proj', taskInstructions: 'LABEL B' },
        () => {},
      ),
    ).toBeNull();
  });

  it('still reuses the process when the task instructions are unchanged', async () => {
    const session = await sessionAfterFirstTurn('LABEL A');

    expect(
      session.startTurn(
        { prompt: 'second', cwd: '/proj', taskInstructions: 'LABEL A' },
        () => {},
      ),
    ).not.toBeNull();
  });
});

describe('AgentAdapter separates geniro’s own probes from a user’s turns', () => {
  /**
   * Open a session on one `internalProbe` posture and settle its first turn.
   *
   * Settled for the same reason the instructions helper above settles: a busy
   * session refuses the next turn whatever its key says, so an unsettled one
   * would pass this describe block with `sessionKey` reverted.
   */
  async function sessionAfterProbeTurn(
    internalProbe: boolean,
  ): Promise<ReturnType<AgentAdapter['startSession']>> {
    const { spawn, child } = fakeSpawn();
    const input: AgentTurnInput = { prompt: 'first', cwd: '/proj' };
    const session = new SessionWithoutModeChangeAdapter(spawn).startSession(
      { ...input, internalProbe },
      { runScoped: true },
    );
    const turn = session.startTurn({ ...input, internalProbe }, () => {});
    child.stdout.emitData('{"done":true}\n');
    await turn?.done;
    return session;
  }

  it('refuses to serve a user’s turn on a process spawned for a probe', async () => {
    // The flag decides whether the host preamble is composed, so it is argv
    // exactly like the instructions beside it. No internal probe uses a kept
    // session TODAY — they all call `start()` — which is what makes this a
    // guard rather than a live path, and why it is pinned now rather than
    // after the first one does: a user's turn served by a probe's process
    // would silently run without the preamble the flag exists to withhold,
    // and nothing in the transcript would show it.
    const session = await sessionAfterProbeTurn(true);

    expect(
      session.startTurn({ prompt: 'second', cwd: '/proj' }, () => {}),
    ).toBeNull();
  });

  it('still reuses the process for a second turn of the same posture', async () => {
    // The control. Without it an implementation that refused every second turn
    // would pass the refusal above while making the flag look load-bearing
    // when it was not.
    const session = await sessionAfterProbeTurn(true);

    expect(
      session.startTurn(
        { prompt: 'second', cwd: '/proj', internalProbe: true },
        () => {},
      ),
    ).not.toBeNull();
  });
});

describe('AgentAdapter re-modes a session it can, and refuses one it cannot', () => {
  it('refuses a turn whose mode the running process cannot be told about', async () => {
    // Silently accepting would run the turn under the mode the PREVIOUS one
    // was spawned with, while the chip and the persisted run row read the new
    // one. Null is what the registry already handles: it closes the session
    // and respawns, putting the mode back in argv where it started.
    const { spawn, child } = fakeSpawn();
    const input: AgentTurnInput = {
      prompt: 'first',
      cwd: '/proj',
      approvalMode: 'acceptEdits',
    };
    const session = new SessionWithoutModeChangeAdapter(spawn).startSession(
      input,
      { runScoped: true },
    );

    const first = session.startTurn(input, () => {});
    expect(first).not.toBeNull();
    child.stdout.emitData('{"done":true}\n');
    await first?.done;

    expect(
      session.startTurn({ ...input, approvalMode: 'ask' }, () => {}),
    ).toBeNull();
    // …while the SAME mode is still served on that process, so the refusal is
    // about the mode change and not about the session being spent.
    expect(session.startTurn(input, () => {})).not.toBeNull();
  });
});

describe('AgentAdapter.listMcpServers', () => {
  it('refuses rather than claiming an empty folder when an adapter forgot to override', async () => {
    // The safety net: answering `{ ok: true, servers: [] }` here would let the
    // service cache it and the panel state, as fact, that the user has no MCP
    // servers — on a CLI nobody ever asked.
    await expect(
      new BareAdapter(null).listMcpServers({ cwd: '/tmp' }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('does not implement MCP listing'),
    });
  });

  it('reports a failure when the CLI answered but nothing parsed as a row', async () => {
    // Version drift: a release that rewords the row format drops every row.
    // Reporting that as an empty listing is the confident lie the ok/err split
    // exists to prevent — and it would be cached for the whole TTL.
    const groupSpawnFn = spawnAnswering(
      'Checking MCP server health…\n\nsentry => node s.js [ok]\n',
      4246,
    );

    await expect(
      new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('output format may have changed'),
    });
  });

  it('reports a genuinely empty folder as an empty SUCCESS, not a failure', async () => {
    // The other side of that check — the CLI's own empty-folder sentence is
    // the one thing that makes `[]` a fact about the user's configuration.
    const groupSpawnFn = spawnAnswering(
      'No MCP servers configured. Use `claude mcp add` to add a server.\n',
      4247,
    );

    await expect(
      new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' }),
    ).resolves.toEqual({ ok: true, servers: [] });
  });
  it('an adapter that declares an absence refuses with its own reason, writing no code to do it', async () => {
    // A CLI with no listing states that in config alone and the base does the
    // rest, so there is no override that could drift from the sentence the
    // panel shows. Both SHIPPED adapters can now be asked for real (milestone
    // 4 verified cursor's `mcp list`), which is exactly why this is pinned on a
    // fixture: the guarantee is about the base class, not about who currently
    // needs it.
    const adapter = new BareAdapter('this CLI has no listing');

    await expect(adapter.listMcpServers({ cwd: '/tmp' })).resolves.toEqual({
      ok: false,
      reason: 'this CLI has no listing',
    });
  });

  it('claude turns the CLI’s own output into rows', async () => {
    const groupSpawnFn = spawnAnswering(
      'Checking MCP server health…\n\nsentry: node s.js - √ Connected\n',
      321,
    );

    await expect(
      new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' }),
    ).resolves.toEqual({
      ok: true,
      servers: [
        {
          name: 'sentry',
          target: 'node s.js',
          transport: 'stdio',
          status: 'connected',
          detail: null,
        },
      ],
    });
  });

  it('claude reports a FAILURE, not an empty folder, when it cannot be run', async () => {
    // Missing binary / not signed in / timeout all arrive as a null stdout.
    // Reporting that as `ok: true, servers: []` would let the service cache it
    // and the panel state, untruthfully, that the folder has no MCP servers.
    const groupSpawnFn = (() => {
      throw new Error('spawn claude ENOENT');
    }) as unknown as typeof spawn;

    const result = await new ClaudeAdapter({ groupSpawnFn }).listMcpServers({
      cwd: '/tmp',
    });

    expect(result.ok).toBe(false);
  });

  it('asks the CLI for the listing in the folder it was given', async () => {
    // The whole reason cwd exists on the utility contract: the answer is
    // folder-scoped, so the wrong folder yields a confidently wrong list.
    const calls: { args: readonly string[]; cwd: unknown }[] = [];
    const groupSpawnFn = spawnAnswering('', 322, (args, opts) =>
      calls.push({ args, cwd: opts.cwd }),
    );

    await new ClaudeAdapter({ groupSpawnFn }).listMcpServers({
      cwd: '/home/me/project-a',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['mcp', 'list']);
    expect(calls[0]?.cwd).toBe('/home/me/project-a');
  });
});

/**
 * Runs a REAL child (this node binary) through `runCommand`, so the one thing
 * no double can show — whether the OS actually put the child in its own
 * process group — is observable.
 */
class RealSpawnAdapter extends BareAdapter {
  constructor() {
    super(null);
  }

  protected override get command(): string {
    return process.execPath;
  }

  run(args: string[], options: AgentCommandOptions): Promise<string | null> {
    // The suite runs under Electron, and `buildChildEnv` no longer passes the
    // daemon's `ELECTRON_RUN_AS_NODE` down, so the child asks for it itself.
    return this.runCommand(args, {
      ...options,
      env: { ELECTRON_RUN_AS_NODE: '1', ...options.env },
    });
  }
}

describe('AgentAdapter.runCommand process groups (real children)', () => {
  it('puts a group command in its OWN group, and an ordinary one in ours', async () => {
    // THE assertion that would have caught the defect this rewrite fixes.
    // Every other spec in this file pins that we ASK for a group; only the
    // child's real pgid proves one exists. `execFile` accepted `detached` in
    // its options bag and silently dropped it before reaching `spawn`, so the
    // call-level assertions stayed green while no group was ever created and
    // every `kill(-pid)` addressed nobody.
    //
    // Probed inside `onSpawn`, the only moment the child is guaranteed alive.
    // `kill(-pid, 0)` sends no signal — it asks the kernel whether a process
    // GROUP with that id exists, which is exactly the question `kill(-pid,
    // 'SIGKILL')` silently got wrong before.
    const groupExists = (pid: number | undefined): boolean => {
      if (pid === undefined) {
        // `kill(-0)` signals the CALLER's group and would answer "yes" for a
        // child that never spawned — a silent pass on the one assertion here
        // that is load-bearing.
        throw new Error('child had no pid');
      }
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const adapter = new RealSpawnAdapter();
    const script = 'process.stdout.write("grouped")';

    let groupPid: number | undefined;
    let leadsOwnGroup = false;
    const grouped = await adapter.run(['-e', script], {
      processGroup: true,
      onSpawn: (child) => {
        groupPid = child.pid;
        leadsOwnGroup = groupExists(child.pid);
      },
    });

    expect(grouped).toBe('grouped');
    expect(groupPid).toBeGreaterThan(0);
    expect(leadsOwnGroup).toBe(true);

    let plainLeadsOwnGroup = true;
    await adapter.run(['-e', script], {
      onSpawn: (child) => {
        plainLeadsOwnGroup = groupExists(child.pid);
      },
    });

    // The other half: an ordinary utility command must NOT be detached, or
    // the daemon stops being able to signal it as part of its own group.
    //
    // Reads "no group with that id exists". Strictly this could answer wrongly
    // if the child's pid happened to equal a live pgid after wraparound — a
    // collision, not a behaviour — so the sibling assertion above (which pins
    // that `detached` is absent from the plain path's options) is what carries
    // the guarantee if this one ever flakes.
    expect(plainLeadsOwnGroup).toBe(false);
  });

  it('reads a command that writes more to stderr than the pipe can hold', async () => {
    // `stdio: ['pipe', 'pipe', 'pipe']` opens a stderr pipe nothing consumes.
    // A child that writes past the OS pipe buffer (64 KiB on Linux) then never
    // drains it never exits, so `close` never fires and the read reports the
    // folder unreadable after the full deadline — for a command that printed
    // its whole answer. `execFile` drained stderr itself (it buffers it for
    // the error object), so this is reachable only on the group path.
    //
    // `mcp list` is the group-path command, and it HEALTH-CHECKS: it launches
    // the user's own MCP servers, whose startup noise lands on the CLI's
    // stderr, which is this pipe.
    const adapter = new RealSpawnAdapter();
    const script =
      'process.stderr.write("e".repeat(512 * 1024)); process.stdout.write("done");';

    const out = await adapter.run(['-e', script], {
      processGroup: true,
      timeoutMs: 3_000,
    });

    expect(out).toBe('done');
  }, 15_000);

  it('closes stdin for a command that reads it to EOF, and only when asked', async () => {
    // `codex exec` waits on an open stdin even with its prompt in argv; this
    // child does the same, answering only once its stdin ends.
    const adapter = new RealSpawnAdapter();
    const script =
      'process.stdin.on("end", () => process.stdout.write("eof")); process.stdin.resume();';

    await expect(
      adapter.run(['-e', script], { endStdin: true, timeoutMs: 5_000 }),
    ).resolves.toBe('eof');
    await expect(
      adapter.run(['-e', script], { processGroup: true, timeoutMs: 1_000 }),
    ).resolves.toBeNull();
  }, 15_000);
});

/**
 * A shipped adapter with `runCommand` exposed, so a spec can read the RAW
 * stdout the collector produced instead of whatever survived a parser.
 */
class RawCommandAdapter extends ClaudeAdapter {
  run(args: string[], options: AgentCommandOptions): Promise<string | null> {
    return this.runCommand(args, options);
  }
}

describe('AgentAdapter.runCommand converse / maxOutputChars', () => {
  it('writes the frames a reply calls for, then settles on the answer they asked', async () => {
    // A dialogue the up-front `stdinWrites` cannot express: the second
    // question names something only the first answer carries.
    let fake: ReturnType<typeof fakeGroupChild> | null = null;
    const groupSpawnFn = ((): ChildProcess => {
      fake = fakeGroupChild(9_300_001);
      fake.child.stdin?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.includes('"first"')) {
          queueMicrotask(() => fake!.writeStdout('{"answer":"T-9"}\n'));
        }
        if (text.includes('"second":"T-9"')) {
          queueMicrotask(() => fake!.writeStdout('{"done":true}\n'));
        }
      });
      return fake.child;
    }) as unknown as typeof spawn;
    let asked = false;
    const out = await new RawCommandAdapter({ groupSpawnFn }).run(['x'], {
      stdinWrites: ['{"first":1}\n'],
      converse: (stdout) => {
        if (!asked && stdout.includes('T-9')) {
          asked = true;
          return ['{"second":"T-9"}\n'];
        }
        return [];
      },
      settleWhen: (stdout) => stdout.includes('"done"'),
      timeoutMs: 2_000,
    });
    expect(out).toContain('"done":true');
    expect(fake!.stdinChunks.join('')).toContain('{"second":"T-9"}');
  });

  it('gives up past the caller’s own output cap rather than the default', async () => {
    const big = `${'x'.repeat(2_000)}\n`;
    const groupSpawnFn = ((): ChildProcess => {
      const fake = fakeGroupChild(9_300_002);
      queueMicrotask(() => {
        fake.writeStdout(big);
        fake.close(0);
      });
      return fake.child;
    }) as unknown as typeof spawn;
    const adapter = new RawCommandAdapter({ groupSpawnFn });
    await expect(
      adapter.run(['x'], { processGroup: true, maxOutputChars: 1_000 }),
    ).resolves.toBeNull();
    await expect(
      adapter.run(['x'], { processGroup: true, maxOutputChars: 10_000 }),
    ).resolves.toBe(big);
  });
});

describe('AgentAdapter.runCommand captureDiagnosis', () => {
  // The option exists because some CLIs put the only reading that matters on the
  // FAILURE path and on STDERR: `cursor-agent mcp list-tools figma` exits 1 and
  // writes `MCP 'figma' requires authentication.` to stderr (measured on
  // 2026.08.11-e8db854). Without it that answer is a bare null, and "needs
  // signing in" is indistinguishable from "broken".

  it('group path: keeps stderr and the output of a non-zero exit', async () => {
    const groupSpawnFn = ((): ChildProcess => {
      const fake = fakeGroupChild(4242);
      queueMicrotask(() => {
        fake.writeStderr("MCP 'figma' requires authentication.\n");
        fake.close(1);
      });
      return fake.child;
    }) as unknown as typeof spawn;

    await expect(
      new RawCommandAdapter({ groupSpawnFn }).run(
        ['mcp', 'list-tools', 'figma'],
        {
          processGroup: true,
          captureDiagnosis: true,
        },
      ),
    ).resolves.toContain('requires authentication');
  });

  it('group path: WITHOUT the flag, the same exit is still a plain null', async () => {
    // The default has to be untouched — every other utility command relies on a
    // non-zero exit meaning "no answer", and widening that silently would let a
    // failed `mcp list` be parsed as a listing.
    const groupSpawnFn = ((): ChildProcess => {
      const fake = fakeGroupChild(4242);
      queueMicrotask(() => {
        fake.writeStderr('some failure\n');
        fake.close(1);
      });
      return fake.child;
    }) as unknown as typeof spawn;

    await expect(
      new RawCommandAdapter({ groupSpawnFn }).run(['mcp', 'list'], {
        processGroup: true,
      }),
    ).resolves.toBeNull();
  });

  it('execFile path: keeps stdout AND stderr when the command exits non-zero', async () => {
    const execFileFn = ((
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, out: string, errOut: string) => void,
    ) => {
      cb(new Error('exit 1'), 'partial stdout\n', 'the real reason\n');
      return {} as ChildProcess;
    }) as unknown as typeof execFile;

    const out = await new RawCommandAdapter({ execFileFn }).run(['whatever'], {
      captureDiagnosis: true,
    });

    expect(out).toContain('partial stdout');
    expect(out).toContain('the real reason');
  });
});

describe('AgentAdapter.runCommand shutdown registration', () => {
  /** A group spawn that answers at once, so the command settles. */
  const answersAtOnce = ((): ChildProcess => {
    const fake = fakeGroupChild(4242);
    queueMicrotask(() => {
      fake.writeStdout('ok\n');
      fake.close(0);
    });
    return fake.child;
  }) as unknown as typeof spawn;

  function registry(): { processes: ProcessRegistry; keys: string[] } {
    const keys: string[] = [];
    const processes = {
      register: (key: string) => void keys.push(key),
    } as unknown as ProcessRegistry;
    return { processes, keys };
  }

  it('registers a child its caller handed no onSpawn for', async () => {
    // A title or a transcript read is started on the adapter's own account,
    // and a caller that passes nothing must not leave it out of shutdown's
    // reach — cursor's `acp` ignores EOF and would outlive the daemon.
    const { processes, keys } = registry();

    await new RawCommandAdapter({ groupSpawnFn: answersAtOnce, processes }).run(
      ['exec'],
      { processGroup: true },
    );

    expect(keys).toEqual([expect.stringMatching(/-exec:/)]);
  });

  it('leaves the registering to a caller that brought its own onSpawn', async () => {
    const { processes, keys } = registry();
    const onSpawn = vi.fn();

    await new RawCommandAdapter({ groupSpawnFn: answersAtOnce, processes }).run(
      ['exec'],
      { processGroup: true, onSpawn },
    );

    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(keys).toEqual([]);
  });

  it('gives every child its own key — the registry replaces one it already holds', async () => {
    const { processes, keys } = registry();
    const adapter = new RawCommandAdapter({
      groupSpawnFn: answersAtOnce,
      processes,
    });

    await adapter.run(['exec'], { processGroup: true });
    await adapter.run(['exec'], { processGroup: true });

    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

/** A CLI declaring one switch that defaults ON and one that defaults OFF. */
class OptionReadingAdapter extends ClaudeAdapter {
  override getConfig(): AdapterConfig {
    return {
      ...super.getConfig(),
      options: [
        { id: 'onByDefault', label: 'On', description: '', defaultValue: true },
        {
          id: 'offByDefault',
          label: 'Off',
          description: '',
          defaultValue: false,
        },
      ],
    };
  }

  read(input: AgentTurnInput, id: string): boolean {
    return this.agentOption(input, id);
  }
}

describe('AgentAdapter.agentOption', () => {
  const input: AgentTurnInput = { prompt: 'go', cwd: '/proj' };

  it('answers each option’s declared default for a turn that says nothing', () => {
    const adapter = new OptionReadingAdapter();

    expect(adapter.read(input, 'onByDefault')).toBe(true);
    expect(adapter.read(input, 'offByDefault')).toBe(false);
  });

  it('answers the run’s snapshot over the default, in both directions', () => {
    // OFF is the direction that matters: for an option that defaults on, an
    // explicit `false` is the only way a user's decline reaches the turn.
    const adapter = new OptionReadingAdapter();
    const snapshot = {
      ...input,
      agentOptions: { onByDefault: false, offByDefault: true },
    };

    expect(adapter.read(snapshot, 'onByDefault')).toBe(false);
    expect(adapter.read(snapshot, 'offByDefault')).toBe(true);
  });

  it('throws on an id the CLI does not declare instead of answering false', () => {
    expect(() => new OptionReadingAdapter().read(input, 'maxMode')).toThrow(
      /claude declares no option 'maxMode'/,
    );
  });

  it.each(ADAPTERS)('$name declares each option id once', ({ adapter }) => {
    const ids = adapter.getConfig().options.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * A CLI with env names of its own, spelled so no real shell exports them — the
 * isolation contract has to be observable whatever the machine running the
 * suite happens to carry in its environment.
 */
class IsolatingAdapter extends ClaudeAdapter {
  override getConfig(): AdapterConfig {
    const base = super.getConfig();
    return {
      ...base,
      auth: {
        ...base.auth,
        isolatedEnvKeys: ['SPEC_OWN_SETTING', 'SPEC_OWN_CREDENTIAL'],
        inheritedEnvKeys: ['SPEC_OWN_CREDENTIAL'],
      },
    };
  }

  run(args: string[]): Promise<string | null> {
    return this.runCommand(args);
  }
}

/** A second CLI, known to the process only because it was registered. */
class NeighbourAdapter extends ClaudeAdapter {
  override getConfig(): AdapterConfig {
    const base = super.getConfig();
    return {
      ...base,
      auth: {
        ...base.auth,
        isolatedEnvKeys: ['SPEC_NEIGHBOUR_CREDENTIAL'],
        inheritedEnvKeys: ['SPEC_NEIGHBOUR_CREDENTIAL'],
      },
    };
  }
}

describe('AgentAdapter env isolation', () => {
  const TOUCHED = [
    'SPEC_OWN_SETTING',
    'SPEC_OWN_CREDENTIAL',
    'SPEC_NEIGHBOUR_CREDENTIAL',
  ] as const;

  afterEach(() => {
    for (const key of TOUCHED) {
      delete process.env[key];
    }
    clearSecrets();
  });

  function capturingExecFile(): {
    execFileFn: typeof execFile;
    env: () => NodeJS.ProcessEnv;
  } {
    let env: NodeJS.ProcessEnv = {};
    const execFileFn = ((
      _cmd: string,
      _args: readonly string[],
      opts: { env?: NodeJS.ProcessEnv },
      cb: (err: Error | null, out: string, errOut: string) => void,
    ) => {
      env = opts.env ?? {};
      cb(null, '', '');
      return {} as ChildProcess;
    }) as unknown as typeof execFile;
    return { execFileFn, env: () => env };
  }

  it.each(ADAPTERS)(
    '$name isolates every credential it inherits',
    ({ adapter }) => {
      // A name handed back but never stripped reaches every child anyway, so
      // the entitlement would protect nothing.
      const { isolatedEnvKeys, inheritedEnvKeys } = adapter.getConfig().auth;
      for (const key of inheritedEnvKeys) {
        expect(isolatedEnvKeys).toContain(key);
      }
    },
  );

  it('strips an adapter’s own names from its children and hands its credentials back', async () => {
    process.env.SPEC_OWN_SETTING = 'from-the-launching-shell';
    process.env.SPEC_OWN_CREDENTIAL = 'own-credential-value';
    const { execFileFn, env } = capturingExecFile();
    const adapter = new IsolatingAdapter({ execFileFn });
    new AgentAdapterRegistry([adapter]);

    await adapter.run(['status']);

    expect('SPEC_OWN_SETTING' in env()).toBe(false);
    expect(env().SPEC_OWN_CREDENTIAL).toBe('own-credential-value');
  });

  it('never hands a child the credential of another adapter the process registered', async () => {
    // The union no adapter can spell alone: registering the neighbour is what
    // adds its name, exactly as the daemon's registry does for every adapter
    // before anything spawns.
    new AgentAdapterRegistry([new NeighbourAdapter()]);
    process.env.SPEC_NEIGHBOUR_CREDENTIAL = 'neighbour-credential-value';
    const { execFileFn, env } = capturingExecFile();

    await new IsolatingAdapter({ execFileFn }).run(['status']);

    expect('SPEC_NEIGHBOUR_CREDENTIAL' in env()).toBe(false);
  });

  it('registers an inherited credential with the debug log’s redaction', () => {
    process.env.SPEC_OWN_CREDENTIAL = 'own-credential-value';

    new AgentAdapterRegistry([new IsolatingAdapter()]);

    expect(redactSecrets('sent own-credential-value to a child')).not.toContain(
      'own-credential-value',
    );
  });

  it('changes nothing process-wide merely by being built', () => {
    // Building an adapter — as every spec here does — must not edit global
    // state; only the registry, which the daemon builds once, registers.
    process.env.SPEC_OWN_CREDENTIAL = 'own-credential-value';

    new IsolatingAdapter();

    expect(redactSecrets('sent own-credential-value to a child')).toContain(
      'own-credential-value',
    );
  });

  it('can be built by a subclass whose config reads its own fields', () => {
    // A subclass field is initialized only after the base constructor returns,
    // so a base constructor that asked for the config read it unset.
    class FieldConfigAdapter extends ClaudeAdapter {
      private readonly extraKeys = ['SPEC_OWN_SETTING'];
      override getConfig(): AdapterConfig {
        const base = super.getConfig();
        return {
          ...base,
          auth: {
            ...base.auth,
            isolatedEnvKeys: [...base.auth.isolatedEnvKeys, ...this.extraKeys],
          },
        };
      }
    }

    expect(() => new FieldConfigAdapter()).not.toThrow();
  });
});

describe('AgentAdapter.runCommand spawn options', () => {
  it('a process-group command goes through spawn, detached, with piped stdio', async () => {
    // The whole finding this replaced: `detached` was being handed to
    // `execFile`, which forwards only cwd/env/uid/gid/shell/windows* down to
    // `spawn` and silently drops the rest. The child therefore never led a
    // group and every `kill(-pid)` addressed nobody. This pins the CALL; the
    // real-children describe above pins the OUTCOME.
    let opts: Record<string, unknown> = {};
    const groupSpawnFn = spawnAnswering('', 999, (_args, options) => {
      opts = options;
    });

    await new ClaudeAdapter({ groupSpawnFn }).listMcpServers({
      cwd: '/tmp/some-project',
    });

    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(opts.cwd).toBe('/tmp/some-project');
    // execFile's own deadline would be a single-PID kill; the group path owns
    // its deadline instead, so no `timeout` may ride along.
    expect(opts.timeout).toBeUndefined();
  });

  it('collects the child’s stdout off the pipe rather than a callback', async () => {
    // `spawn` hands back no buffered stdout, so the collector is ours. If it
    // regressed to returning '' the parser above would report every folder as
    // unreadable, so this is the assertion holding the rewrite together.
    const groupSpawnFn = spawnAnswering(
      'Checking MCP server health…\n\nsentry: node s.js - √ Connected\n',
      777,
    );

    await expect(
      new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' }),
    ).resolves.toMatchObject({ ok: true, servers: [{ name: 'sentry' }] });
  });

  it('joins a multi-byte character that arrived split across two stdout chunks', async () => {
    // A pipe read boundary falls wherever the kernel put it, so a UTF-8
    // sequence routinely straddles two `data` events. Decoding each chunk on
    // its own turns the halves into replacement characters — the CLI's own
    // output already carries non-ASCII (`√ Connected`, `health…`), and a
    // mangled row is a server name the user never configured.
    // `execFile`'s `encoding: 'utf8'` decoded the STREAM, not the chunk.
    const payload = Buffer.from('café', 'utf8');
    const chunks = [
      payload.subarray(0, payload.length - 1),
      payload.subarray(payload.length - 1),
    ];
    const groupSpawnFn = ((): unknown => {
      const fake = fakeGroupChild(4251);
      queueMicrotask(() => {
        for (const chunk of chunks) {
          fake.writeStdout(chunk);
        }
        fake.close(0);
      });
      return fake.child;
    }) as unknown as typeof spawn;

    const out = await new RawCommandAdapter({ groupSpawnFn }).run(
      ['mcp', 'list'],
      { processGroup: true },
    );

    expect(out).toBe('café');
  });

  it('kills the whole group when the deadline passes, and settles the read', async () => {
    // Owning the deadline is only safe because this timer does BOTH things:
    // reap the group (a grandchild that survives holds the inherited stdout
    // pipe open, so `close` never fires) and settle the promise, or the
    // service's in-flight slot for that folder is wedged for the daemon's life.
    vi.useFakeTimers();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      // Never emits — the wedged-grandchild case.
      const groupSpawnFn = (() =>
        fakeGroupChild(4242).child) as unknown as typeof spawn;

      const pending = new ClaudeAdapter({ groupSpawnFn }).listMcpServers(
        { cwd: '/tmp' },
        { timeoutMs: 50 },
      );
      await vi.advanceTimersByTimeAsync(50);

      // The group is ASKED to stop first — it may hold the user's own MCP
      // servers, which a straight SIGKILL would give no chance to shut down.
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(-4242, 'SIGKILL');

      // And this is the case the force-kill is FOR: no `exit` ever arrived, so
      // a grandchild is still holding the inherited stdout pipe open. Nothing
      // has waitpid'd the leader, so its pid cannot have been reissued.
      await vi.advanceTimersByTimeAsync(GROUP_KILL_GRACE_MS);
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');

      await expect(pending).resolves.toEqual({
        ok: false,
        reason: expect.stringContaining('could not read'),
      });
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('still frees a grandchild that ignores SIGTERM, so a completed read is not thrown away', async () => {
    // The case reaping-at-`exit` exists for, spelled out at that listener: the
    // CLI is gone and has printed its whole answer, but a health-check
    // grandchild it forked still holds the inherited stdout pipe, so `close`
    // does not arrive. A grandchild that ignores SIGTERM — a browser server
    // mid-shutdown, an indexer — then keeps holding it, and with no escalation
    // the read sits until the 45s deadline and is discarded, reporting a
    // failure for a folder whose servers were read successfully.
    vi.useFakeTimers();
    const fake = fakeGroupChild(4260);
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((pid: number, signal?: string | number): true => {
        // Only a force-kill takes this grandchild down; the SIGTERM is ignored.
        if (pid === -4260 && signal === 'SIGKILL') {
          fake.child.emit('close', 0, null);
        }
        return true;
      });
    try {
      const groupSpawnFn = ((): unknown => {
        queueMicrotask(() => {
          fake.writeStdout('the whole listing\n');
          // `exit` alone: the leader is gone, the pipe is not.
          fake.child.emit('exit', 0, null);
        });
        return fake.child;
      }) as unknown as typeof spawn;

      const pending = new RawCommandAdapter({ groupSpawnFn }).run(
        ['mcp', 'list'],
        { processGroup: true, timeoutMs: 45_000 },
      );
      // Past the grace the escalation should have landed on, and on past the
      // whole deadline so the read settles either way rather than hanging.
      await vi.advanceTimersByTimeAsync(GROUP_KILL_GRACE_MS + 1);
      await vi.advanceTimersByTimeAsync(45_000);

      await expect(pending).resolves.toBe('the whole listing\n');
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reaps the group ONCE when the command answers, and never again after', async () => {
    // Two guarantees in one, because they pull against each other.
    //
    // The reap must HAPPEN on the success path: a listing command health-checks
    // the user's own MCP servers, and one that ignores stdin EOF outlives the
    // CLI (probe-verified on cursor-agent 2026.07.23-e383d2b — `mcp list`
    // exited 0 and left a child running). Once the CLI exits, `ProcessRegistry`
    // drops the handle, so this is the last moment anything can reach that
    // group.
    //
    // And it must happen exactly ONCE. `exit`, `close` and the deadline all
    // reap, and the timer is armed BEFORE the spawn (an injected spawn that
    // emits synchronously would otherwise leave one nothing can clear), so
    // settle has to clear it — else it fires later and signals whatever
    // process group owns that pid by then.
    vi.useFakeTimers();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      const groupSpawnFn = spawnAnswering('', 4243);

      await new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' });

      // ONE reap, which is ONE escalation: SIGTERM now…
      expect(signalsTo(killSpy, 4243)).toEqual(['SIGTERM']);

      await vi.advanceTimersByTimeAsync(60_000);

      // …and its single SIGKILL after the grace, and nothing further. Two
      // signals from one reap, not two reaps: the deadline was cleared rather
      // than merely outrun, and `exit`/`close` did not each arm their own
      // escalation.
      expect(signalsTo(killSpy, 4243)).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('falls back to a direct kill when the group is already gone', async () => {
    // The ESRCH branch of `killProcessGroup`, and the only kill that lands
    // once the leader has exited. Every spec above stubs `process.kill` to
    // SUCCEED, so none of them enters it — a stub that throws is the only way
    // in, and without this the fallback ships unpinned and a later "this looks
    // like dead code" cleanup would silently drop the last reap.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((): never => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    try {
      const fake = fakeGroupChild(4249);
      const groupSpawnFn = ((): unknown => {
        queueMicrotask(() => fake.close(0));
        return fake.child;
      }) as unknown as typeof spawn;

      await new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' });

      expect(killSpy).toHaveBeenCalledWith(-4249, 'SIGTERM');
      expect(fake.directKills).toEqual(['SIGTERM']);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('reaps the group when the child fails instead of answering', async () => {
    // A spawn error (ENOENT surfaced asynchronously) settles the read, and the
    // group has to go with it — otherwise the grandchildren survive with the
    // timer already cleared and nothing left to reap them.
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      const fake = fakeGroupChild(4244);
      const groupSpawnFn = ((): unknown => {
        queueMicrotask(() => fake.fail());
        return fake.child;
      }) as unknown as typeof spawn;

      await new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' });

      expect(killSpy).toHaveBeenCalledWith(-4244, 'SIGTERM');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('reports a non-zero exit as unreadable rather than as empty output', async () => {
    // `execFile` gave us this for free via its `err` argument; the spawn path
    // has to read the exit code itself. Getting it wrong turns every failed
    // listing into a confident "this folder has no MCP servers".
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      const fake = fakeGroupChild(4250);
      const groupSpawnFn = ((): unknown => {
        queueMicrotask(() => {
          // A PARSEABLE payload, then a non-zero exit. With empty stdout this
          // assertion could not tell "we returned null" from "we returned ''",
          // and '' already parses to { ok: false } — so it passed with the
          // exit code ignored entirely, which is exactly the regression it
          // names. Returning the collected stdout here yields ok: true.
          fake.writeStdout('sentry: node s.js - √ Connected\n');
          fake.close(1);
        });
        return fake.child;
      }) as unknown as typeof spawn;

      await expect(
        new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' }),
      ).resolves.toMatchObject({ ok: false });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('reaps the group ONCE, even when the child exits after the deadline', async () => {
    // The deadline reaps and settles; the child's own `close` then arrives and
    // runs its own reap. By then node has waitpid'd the child, so a second
    // `kill(-pid)` can land on whatever now owns that pid.
    vi.useFakeTimers();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      const fake = fakeGroupChild(4248);
      const groupSpawnFn = (() => fake.child) as unknown as typeof spawn;

      // An EXPLICIT deadline, not the shipped constant: a bare literal that
      // has to match `CLAUDE_MCP_LIST_TIMEOUT_MS` goes vacuous the moment that
      // constant is retuned — the timer never fires and this stops testing the
      // ordering it names, silently.
      const pending = new ClaudeAdapter({ groupSpawnFn }).listMcpServers(
        { cwd: '/tmp' },
        { timeoutMs: 50 },
      );
      await vi.advanceTimersByTimeAsync(50); // deadline reaps + settles
      fake.close(0); // the child's own exit lands afterwards
      await pending;

      expect(signalsTo(killSpy, 4248)).toEqual(['SIGTERM']);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('hands the registration site what it actually spawned', async () => {
    // The pairing invariant: `childProcessHandle(child, spawnInfo)` is correct
    // by construction only because spawnInfo comes from the spawn. A caller
    // writing `{ processGroup: true }` by hand could disagree with it.
    const seen: { processGroup: boolean }[] = [];
    const execFileFn = ((
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, out: string) => void,
    ) => {
      cb(null, '');
      return { pid: 4245, kill: () => true } as unknown as ChildProcess;
    }) as unknown as typeof execFile;
    const adapter = new ClaudeAdapter({
      execFileFn,
      groupSpawnFn: spawnAnswering('', 4245),
    });

    await adapter.listMcpServers(
      { cwd: '/tmp' },
      { onSpawn: (_child, spawnInfo) => seen.push(spawnInfo) },
    );
    await adapter.supportsLiveStream({
      onSpawn: (_child, spawnInfo) => seen.push(spawnInfo),
    });

    expect(seen).toEqual([{ processGroup: true }, { processGroup: false }]);
  });

  it('leaves an ordinary utility command on execFile, undetached', async () => {
    // The default path is unchanged — every pre-existing caller (--version,
    // --help probes) must keep spawning exactly as it did, through execFile
    // with node's own deadline.
    let opts: Record<string, unknown> = {};
    const execFileFn = ((
      _cmd: string,
      _args: readonly string[],
      options: Record<string, unknown>,
      cb: (err: Error | null, out: string) => void,
    ) => {
      opts = options;
      cb(null, '');
      return { pid: 999, kill: () => true } as unknown as ChildProcess;
    }) as unknown as typeof execFile;

    await new ClaudeAdapter({ execFileFn }).supportsLiveStream();

    expect(opts.detached).toBeUndefined();
    expect(opts.timeout).toBe(10_000);
    expect(opts.cwd).toBeUndefined();
  });
});

describe('AgentAdapter pty wrapper', () => {
  it('spawns the pty wrapper by its absolute path, never a bare name a shadowed PATH could substitute', async () => {
    // The real observable is what `runAsProcessGroup` actually hands its
    // spawn function under `pty: true` — the FIRST argument the group path
    // resolves the CLI under `script` with — not a re-statement of the
    // constant the production code itself declares.
    let spawnedCommand: string | undefined;
    const groupSpawnFn = ((command: string): ChildProcess => {
      spawnedCommand = command;
      const fake = fakeGroupChild(4300);
      queueMicrotask(() => fake.close(0));
      return fake.child;
    }) as unknown as typeof spawn;

    await new RawCommandAdapter({ groupSpawnFn }).run(['some', 'args'], {
      pty: true,
      cwd: '/proj',
    });

    expect(spawnedCommand).toBe('/usr/bin/script');
  });

  describe('reaping the CLI under the pty', () => {
    // Pids past the kernel's range, so nothing real is ever signalled even if
    // a spy were bypassed. `script` is SCRIPT_PID; the CLI it put in a session
    // of its own is CLI_PID — measured on a live `script`: pgid 56120 for the
    // wrapper, 56123 for the child, and a child ignoring SIGHUP outlived the
    // wrapper's group kill, reparented to launchd.
    const SCRIPT_PID = 9_300_000;
    const CLI_PID = 9_300_003;
    const CLI_ROW = {
      pid: CLI_PID,
      ppid: SCRIPT_PID,
      args: 'claude mcp login linear',
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** A `script` that exits at once, as a finished or cancelled sign-in does. */
    function exitingScript(): typeof spawn {
      return ((): ChildProcess => {
        const fake = fakeGroupChild(SCRIPT_PID);
        queueMicrotask(() => fake.close(0));
        return fake.child;
      }) as unknown as typeof spawn;
    }

    /** Wait for the async half of the reap to have signalled, or not. */
    async function settled(): Promise<void> {
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    it('terminates the CLI’s OWN process group, not only the wrapper’s', async () => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      // Found as `script`'s child at spawn; by the reap the CLI has been
      // reparented, but it is the same process running the same command.
      const readings = [[CLI_ROW], [{ ...CLI_ROW, ppid: 1 }]];
      const listProcessesFn = vi.fn(() =>
        Promise.resolve(readings.shift() ?? []),
      );

      await new RawCommandAdapter({
        groupSpawnFn: exitingScript(),
        listProcessesFn,
      }).run(['mcp', 'login', 'linear'], { pty: true });
      await settled();

      expect(kill).toHaveBeenCalledWith(-SCRIPT_PID, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(-CLI_PID, 'SIGTERM');
    });

    it('does not signal a recorded pid that now runs something else', async () => {
      // The defensive half: the pid was recorded minutes ago and is no longer
      // this process's child, so a reissued pid must not be signalled.
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const readings = [
        [CLI_ROW],
        [{ pid: CLI_PID, ppid: 1, args: 'some unrelated process' }],
      ];
      const listProcessesFn = vi.fn(() =>
        Promise.resolve(readings.shift() ?? []),
      );

      await new RawCommandAdapter({
        groupSpawnFn: exitingScript(),
        listProcessesFn,
      }).run(['mcp', 'login', 'linear'], { pty: true });
      await settled();

      expect(kill).toHaveBeenCalledWith(-SCRIPT_PID, 'SIGTERM');
      expect(kill).not.toHaveBeenCalledWith(-CLI_PID, expect.anything());
    });

    it('reads no process table for a command that is not under a pty', async () => {
      const listProcessesFn = vi.fn(() => Promise.resolve([CLI_ROW]));
      vi.spyOn(process, 'kill').mockImplementation(() => true);

      await new RawCommandAdapter({
        groupSpawnFn: exitingScript(),
        listProcessesFn,
      }).run(['mcp', 'list'], { processGroup: true });
      await settled();

      expect(listProcessesFn).not.toHaveBeenCalled();
    });
  });
});

describe('geniroCommandFor', () => {
  // The REAL adapters, because "does this CLI have `/compact`, and what does it
  // send" is exactly the declaration under test.
  const claude = new ClaudeAdapter();
  const cursor = new CursorAcpAdapter({
    vocabularyStore: freshVocabularyStore(),
  });

  it('matches only the whole bare command', () => {
    expect(claude.geniroCommandFor('/compact')?.name).toBe('compact');
    expect(claude.geniroCommandFor('  /compact  ')?.name).toBe('compact');
    // These commands take no arguments, so a sentence after one is the user
    // talking — and a partial match would silently discard what they wrote.
    expect(claude.geniroCommandFor('/compact do it thoroughly')).toBeNull();
    expect(claude.geniroCommandFor('please /compact')).toBeNull();
    expect(claude.geniroCommandFor('/compaction')).toBeNull();
    expect(claude.geniroCommandFor('compact')).toBeNull();
  });

  it('sends each CLI what THAT CLI needs, and only replaces a session where it must', () => {
    // claude has a compaction of its own and keeps its session; cursor has
    // none over ACP, so geniro asks for a summary and drops the session.
    const own = claude.geniroCommandFor('/compact');
    expect(own?.prompt).toBe('/compact');
    expect(own?.replacesSession).toBe(false);

    const ours = cursor.geniroCommandFor('/compact');
    expect(ours?.prompt).not.toBe('/compact');
    expect(ours?.prompt).toMatch(/summar/i);
    expect(ours?.replacesSession).toBe(true);
  });

  it('answers null for a CLI that declares no geniro commands', () => {
    class BareAdapter extends ClaudeAdapter {
      override getConfig(): AdapterConfig {
        return { ...super.getConfig(), geniroCommands: [] };
      }
    }
    expect(new BareAdapter().geniroCommandFor('/compact')).toBeNull();
    expect(new BareAdapter().listGeniroCommands()).toEqual([]);
  });
});

describe('AgentAdapter sessions separate on the instruction blocks', () => {
  /** {@link sessionAfterFirstTurn}'s twin for the team member instruction text. */
  async function sessionAfterBlocks(
    instructionBlocks: string,
  ): Promise<ReturnType<AgentAdapter['startSession']>> {
    const { spawn, child } = fakeSpawn();
    const input: AgentTurnInput = {
      prompt: 'first',
      cwd: '/proj',
      instructionBlocks,
    };
    const session = new SessionWithoutModeChangeAdapter(spawn).startSession(
      input,
      { runScoped: true },
    );
    const turn = session.startTurn(input, () => {});
    child.stdout.emitData('{"done":true}\n');
    await turn?.done;
    return session;
  }

  it('refuses to serve a turn whose instruction blocks differ from the spawn’s', async () => {
    // The blocks ride the same composed block as the member's instructions and
    // the user's own, so they belong to the SPAWN. No team path uses a kept
    // session today — the executor calls `start()` — which is what makes this
    // a guard rather than a live path, and why it is pinned now: the moment
    // one does, two members given different blocks would share a process and
    // the second would run on the first's instructions.
    const session = await sessionAfterBlocks('BLOCK A');

    expect(
      session.startTurn(
        { prompt: 'second', cwd: '/proj', instructionBlocks: 'BLOCK B' },
        () => {},
      ),
    ).toBeNull();
  });

  it('still reuses the process when the blocks are unchanged', async () => {
    // The control: an implementation refusing every second turn would pass the
    // test above while costing every kept process its reuse.
    const session = await sessionAfterBlocks('BLOCK A');

    expect(
      session.startTurn(
        { prompt: 'second', cwd: '/proj', instructionBlocks: 'BLOCK A' },
        () => {},
      ),
    ).not.toBeNull();
  });
});

describe('AgentAdapter sessions separate on the answering-a-call sentence', () => {
  async function sessionAfterCallee(
    answeringACallPrompt: string,
  ): Promise<ReturnType<AgentAdapter['startSession']>> {
    const { spawn, child } = fakeSpawn();
    const input: AgentTurnInput = {
      prompt: 'first',
      cwd: '/proj',
      answeringACallPrompt,
    };
    const session = new SessionWithoutModeChangeAdapter(spawn).startSession(
      input,
      { runScoped: true },
    );
    const turn = session.startTurn(input, () => {});
    child.stdout.emitData('{"done":true}\n');
    await turn?.done;
    return session;
  }

  it('refuses a turn that does not answer a call on a process spawned to answer one', async () => {
    // For a callee with no callees of its own this sentence is the only part
    // of the composed block that differs between answering a call and not.
    const session = await sessionAfterCallee('ANSWERING');

    expect(
      session.startTurn(
        { prompt: 'second', cwd: '/proj', answeringACallPrompt: null },
        () => {},
      ),
    ).toBeNull();
  });

  it('still reuses the process for the next turn of the same call', async () => {
    const session = await sessionAfterCallee('ANSWERING');

    expect(
      session.startTurn(
        { prompt: 'second', cwd: '/proj', answeringACallPrompt: 'ANSWERING' },
        () => {},
      ),
    ).not.toBeNull();
  });
});

describe('AgentAdapter — how a failed turn is classified for a CALLER', () => {
  it.each(ADAPTERS)(
    '$name declares no rate-limit pattern carrying the `g` flag',
    ({ adapter }) => {
      // `failureFrom` reads these literals on EVERY failure, and `RegExp.test`
      // advances `lastIndex` on a global one — so the second matching failure of
      // a run would silently not match, and the caller would be told `crashed`
      // about a limit it should be waiting out. Nothing else can catch that: one
      // failure per test is the shape every other case here takes.
      const { rateLimitPatterns, resetsAtPatterns } = adapter.getConfig().auth;
      for (const pattern of [...rateLimitPatterns, ...resetsAtPatterns]) {
        expect(pattern.global).toBe(false);
      }
    },
  );

  it.each(ADAPTERS)(
    '$name declares no sign-in link pattern carrying the `g` flag',
    ({ adapter }) => {
      // Same hazard, another reader: `firstUrlIn` tests this literal against
      // every link on every read of a sign-in's output, so a global one would
      // skip the authorization URL on alternate reads.
      expect(adapter.getConfig().auth.loginUrlPattern?.global ?? false).toBe(
        false,
      );
    },
  );

  it.each(ADAPTERS)(
    '$name classifies an unrecognised failure as `crashed`, never null',
    ({ adapter }) => {
      // The floor: every failed turn carries a class, so no caller has to branch
      // on its absence.
      expect(adapter.failureFrom('Error: ENOENT no such file')).toEqual({
        class: 'crashed',
        resetsAt: null,
      });
    },
  );

  it('reads claude’s own session-limit sentence, with the reset it named', () => {
    // VERBATIM out of run `09d69570`'s transcript — the message the caller was
    // denied. The reset is repeated back unparsed: the CLI states it in the
    // user's words and timezone, and guessing a date off `7:30pm` would be
    // worse than the sentence it replaced.
    expect(
      new ClaudeAdapter().failureFrom(
        "You've hit your session limit · resets 7:30pm (Asia/Almaty)",
      ),
    ).toEqual({ class: 'rate_limited', resetsAt: '7:30pm (Asia/Almaty)' });
  });

  it('reads claude’s 5-hour window sentence, with the reset it named', () => {
    // VERBATIM out of a team run's `error` row (claude 2.1.312, HTTP 429),
    // which was handed to the next pool member as "failed before doing any
    // work" and never filed as a spent account.
    expect(
      new ClaudeAdapter().failureFrom(
        "You've hit your 5-hour limit · resets 8pm (Asia/Dubai)",
      ),
    ).toEqual({ class: 'rate_limited', resetsAt: '8pm (Asia/Dubai)' });
  });

  it('reads the other nouns that CLI puts in the same sentence', () => {
    // Measured in the 2.1.276 string table: `hit your limit`, `hit your usage
    // limit`, `hit your monthly limit`, `hit your monthly spend limit` and `hit
    // your fast limit` — none of them `session`. A list of nouns would have
    // been one release behind on each of these.
    const adapter = new ClaudeAdapter();
    for (const message of [
      "You've hit your limit",
      "You've hit your usage limit",
      "You've hit your monthly limit",
      "You've hit your monthly spend limit",
      "You've hit your fast limit",
      "You've hit your weekly limit",
      "You've hit your channel's monthly spend limit",
      'Usage limit reached · continuing automatically',
    ]) {
      expect(adapter.failureFrom(message).class).toBe('rate_limited');
    }
  });

  it('does not read an ordinary sentence about limits as one', () => {
    // The control. `crashed` for anything the frames do not match, so a callee
    // merely TALKING about limits cannot park its caller in a wait.
    const adapter = new ClaudeAdapter();
    for (const message of [
      'the rate limits should be reset by now',
      'waiting for rate limits to reset',
      'exceeded the file descriptor limit',
    ]) {
      expect(adapter.failureFrom(message).class).toBe('crashed');
    }
  });

  it('reads a lapsed ACCOUNT session as `auth_expired` on both CLIs', () => {
    // The same markers `errorRecovery` already offers the USER a Sign in for,
    // read here as the instruction a CALLER acts on: only the user can cure it,
    // so stop and ask rather than retry.
    expect(new ClaudeAdapter().failureFrom('OAuth session expired').class).toBe(
      'auth_expired',
    );
    expect(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
      }).failureFrom('acp session failed: Authentication required').class,
    ).toBe('auth_expired');
  });

  it('reads cursor’s action-required sentence as its service refusing the request', () => {
    // VERBATIM out of run `2fc7014e`: Cursor's backend refused every new request
    // for ~37 minutes and the CLI replaced the refusal with this sentence. The
    // caller, handed only the sentence, blamed its own `message_agent` and
    // recorded that as a pitfall for the whole run.
    const adapter = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    });
    expect(adapter.failureFrom('Check your settings to continue')).toEqual({
      class: 'crashed',
      resetsAt: null,
      refusedByService: true,
    });
    expect(
      adapter.failureFrom('Error: RetriableError: Connection stalled'),
    ).toEqual({ class: 'crashed', resetsAt: null });
  });

  it('ranks a spent usage window ABOVE an auth marker', () => {
    // A CLI is free to mention signing in inside a limit message, and waiting is
    // the only move that helps there — so the order in `failureFrom` is load
    // bearing rather than incidental.
    expect(
      new ClaudeAdapter().failureFrom(
        "You've hit your usage limit · OAuth session expired on the other account",
      ).class,
    ).toBe('rate_limited');
  });
});

describe('AgentAdapter.listPriceOf — the catalog provider is the ADAPTER’s fact', () => {
  /** A lookup that records what it was asked and prices everything at $1/$2. */
  function recordingPrices(cacheWrite: number | null = null): {
    prices: ModelPriceLookup;
    asked: [ModelPriceProvider, string][];
  } {
    const asked: [ModelPriceProvider, string][] = [];
    return {
      asked,
      prices: {
        priceOf: (provider, model) => {
          asked.push([provider, model]);
          return {
            input: 1,
            output: 2,
            cacheRead: null,
            cacheWrite,
            tiers: [],
            contextTokens: null,
          };
        },
      },
    };
  }

  const listPriceOf = (adapter: AgentAdapter, model: string | null) =>
    (
      adapter as unknown as {
        listPriceOf(model: string | null): ModelPrice | null;
      }
    ).listPriceOf(model);

  it('claude asks the catalog under anthropic', () => {
    const { prices, asked } = recordingPrices();
    expect(
      listPriceOf(new ClaudeAdapter({ prices }), 'claude-opus-5')?.input,
    ).toBe(1);
    expect(asked).toEqual([['anthropic', 'claude-opus-5']]);
  });

  it('codex asks the catalog under openai', () => {
    const { prices, asked } = recordingPrices();
    expect(
      listPriceOf(
        new CodexAdapter({ clientVersion: '1.0.0', prices }),
        'gpt-6-astra',
      )?.input,
    ).toBe(1);
    expect(asked).toEqual([['openai', 'gpt-6-astra']]);
  });

  it('cursor declares no list price, so the catalog is never asked', () => {
    const { prices, asked } = recordingPrices();
    const cursor = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      prices,
    });
    expect(cursor.getConfig().usage.listPrice).toMatchObject({
      kind: 'unavailable',
      reason: expect.any(String),
    });
    expect(listPriceOf(cursor, 'claude-opus-5')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('answers null for no model, and for an adapter handed no catalog', () => {
    const { prices, asked } = recordingPrices();
    expect(listPriceOf(new CodexAdapter({ prices }), null)).toBeNull();
    expect(asked).toEqual([]);
    expect(listPriceOf(new CodexAdapter(), 'gpt-6-astra')).toBeNull();
  });

  it('bills claude’s cache writes at twice its input rate, the multiple its CLI writes its cache at', () => {
    const { prices } = recordingPrices(0.5);
    expect(
      new ClaudeAdapter({ prices }).billingRatesOf('claude-opus-5'),
    ).toMatchObject({ input: 1, output: 2, cacheWrite: 2 });
  });

  it('keeps the catalog’s cache-write rate for codex, which declares no multiple', () => {
    const { prices } = recordingPrices(0.5);
    expect(
      new CodexAdapter({ clientVersion: '1.0.0', prices }).billingRatesOf(
        'gpt-6-astra',
      ),
    ).toMatchObject({ input: 1, output: 2, cacheWrite: 0.5 });
  });

  it('answers no billing rates for cursor, which declares no list price, or for no model', () => {
    const { prices, asked } = recordingPrices();
    expect(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
        prices,
      }).billingRatesOf('claude-opus-5'),
    ).toBeNull();
    expect(new CodexAdapter({ prices }).billingRatesOf(null)).toBeNull();
    expect(asked).toEqual([]);
  });
});
