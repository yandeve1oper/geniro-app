import { describe, expect, it, vi } from 'vitest';

import { freshVocabularyStore } from '../../agents/adapters/__tests__/fresh-vocabulary-store';
import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import type { ClaudeModeProbe } from '../../agents/adapters/claude/claude.types';
import { CodexAdapter } from '../../agents/adapters/codex/codex.adapter';
import { CursorAcpAdapter } from '../../agents/adapters/cursor-acp/cursor-acp.adapter';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { GENIRO_UI_PREAMBLE } from '../../agents/utils/agent-instructions';
import { MAX_PARALLEL_AGENTS } from '../utils/parallelism';
import { CapabilitiesService } from './capabilities.service';

const CLAUDE_MODES = {
  acceptEdits: 'pass' as const,
  plan: 'fail' as const,
  version: 'claude 2',
  probedAt: 2,
  reason: 'installed claude does not support --permission-mode plan',
};

function registry(
  claudeWire: () => typeof CLAUDE_MODES = () => CLAUDE_MODES,
): AgentAdapterRegistry {
  const modeProbe: ClaudeModeProbe = {
    capability: () => CLAUDE_MODES,
    wireCapability: claudeWire,
    ensureVerdict: () => Promise.resolve(CLAUDE_MODES),
  };
  return new AgentAdapterRegistry([
    new ClaudeAdapter({ modeProbe }),
    new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    }),
    new CodexAdapter(),
  ]);
}

function service(claudeWire = vi.fn(() => CLAUDE_MODES)): {
  service: CapabilitiesService;
  claudeWire: typeof claudeWire;
} {
  return {
    service: new CapabilitiesService(registry(claudeWire)),
    claudeWire,
  };
}

describe('CapabilitiesService', () => {
  it('puts each CLI’s own probe verdict on that CLI’s approval row', () => {
    const { service: subject, claudeWire } = service();

    const probes = new Map(
      subject.capabilitiesWire().approvals.map((a) => [a.agent, a.probe]),
    );
    expect(probes.get('claude')).toEqual({
      modes: [
        { mode: 'acceptEdits', status: 'pass', requiresPass: false },
        { mode: 'plan', status: 'fail', requiresPass: true },
      ],
      version: 'claude 2',
      probedAt: 2,
      reason: 'installed claude does not support --permission-mode plan',
    });
    // A CLI that probes nothing says so, rather than borrowing claude's.
    expect(probes.get('cursor-agent')).toBeNull();
    // Read through the pre-warming path, exactly once per composition.
    expect(claudeWire).toHaveBeenCalledTimes(1);
  });

  it('serves the host preamble verbatim', () => {
    // The Settings screen previews this as "what is already being said on your
    // behalf", so it has to be the real text.
    //
    // Deliberately NOT titled "not a copy": `toBe` on strings is value
    // equality, so inlining a duplicate literal in the service would still
    // pass. What this does catch is the field going missing, empty, or wrong.
    // The independent excerpt below is the half that survives a copy — it is
    // hand-written here rather than derived from the constant, so a preamble
    // rewritten to drop its correction fails even if both sides agree.
    const { service: subject } = service();

    expect(subject.capabilitiesWire().hostPreamble).toBe(GENIRO_UI_PREAMBLE);
    expect(subject.capabilitiesWire().hostPreamble).toContain(
      'they are not printed to a terminal',
    );
  });

  it('serves the machine ceiling on active callee turns the executor runs at', () => {
    expect(service().service.capabilitiesWire().maxActiveTurnsCeiling).toBe(
      MAX_PARALLEL_AGENTS,
    );
  });

  it('serves each CLI’s own background-work note, the text its turns are composed with', () => {
    const notes = new Map(
      service()
        .service.capabilitiesWire()
        .backgroundWorkNotes.map((entry) => [entry.agent, entry.note]),
    );

    expect([...notes.keys()]).toEqual([...registry().all().keys()]);
    for (const [agent, adapter] of registry().all()) {
      expect(notes.get(agent)).toBe(
        adapter.getConfig().backgroundWork.agentNote,
      );
    }
    // Per CLI, not one shared text: the two transports disagree on whether a
    // turn is held for its sub-agents.
    expect(notes.get('codex')).not.toBe(notes.get('claude'));
  });

  it('answers for EVERY registered CLI, not a hand-written list', () => {
    // Why the composition iterates the registry: a new adapter must appear
    // here the moment it is registered. A literal naming the shipped CLIs
    // would leave the renderer with no answer for the next one, and it would
    // fall back to allowlisting one agent by name — the exact shape this wire
    // field exists to replace.
    expect(
      service()
        .service.capabilitiesWire()
        .configDirs.map((p) => p.agent),
    ).toEqual([...registry().all().keys()]);
  });

  it('carries each adapter’s OWN config-directory reason, verbatim', () => {
    // Not a boolean, and not a sentence composed here: the renderer SHOWS this
    // string, and a reason invented at the wire layer is one the adapter
    // cannot keep true. Reading it off the config is what lets a CLI that
    // gains config-directory support need no change in this file at all.
    const byAgent = new Map(
      service()
        .service.capabilitiesWire()
        .configDirs.map((p) => [p.agent, p.unavailableReason]),
    );

    expect(byAgent.get('claude')).toBe(
      new ClaudeAdapter().getConfig().configDir.unavailableReason,
    );
    expect(byAgent.get('cursor-agent')).toBe(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
      }).getConfig().configDir.unavailableReason,
    );
  });

  it('states claude’s and cursor’s support as null', () => {
    // `null` is the affirmative answer: the renderer draws a CLI's named
    // configurations only for a null here.
    const byAgent = new Map(
      service()
        .service.capabilitiesWire()
        .configDirs.map((p) => [p.agent, p.unavailableReason]),
    );

    expect(byAgent.get('claude')).toBeNull();
    expect(byAgent.get('cursor-agent')).toBeNull();
  });
});

describe('CapabilitiesService — a message into a running turn', () => {
  const followUps = (): Map<string, string | null> =>
    new Map(
      service()
        .service.capabilitiesWire()
        .followUps.map((f) => [f.agent, f.unavailableReason]),
    );

  it('answers for EVERY registered CLI, so the queue never allowlists one', () => {
    expect([...followUps().keys()]).toEqual([...registry().all().keys()]);
  });

  it('carries each adapter’s OWN reason, verbatim', () => {
    // Same rule as the config-dir row: the composer prints this string on the
    // disabled "send now", so a sentence composed at the wire layer is one the
    // adapter cannot keep true.
    expect(followUps().get('claude')).toBe(
      new ClaudeAdapter().getConfig().followUp.unavailableReason,
    );
    expect(followUps().get('cursor-agent')).toBe(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
      }).getConfig().followUp.unavailableReason,
    );
  });

  it('states BOTH shipped channels as available', () => {
    // The two live values, and both are null now. Cursor's used to be a
    // sentence, on the strength of the ACP spec's one-prompt-per-turn shape —
    // its BINARY accepts a second `session/prompt` against a live session, so
    // the control was inert over a channel that worked. What differs is what
    // the press does, which is the row below.
    expect(followUps().get('claude')).toBeNull();
    expect(followUps().get('cursor-agent')).toBeNull();
  });

  it('says which CLI a mid-turn message INTERRUPTS', () => {
    // The renderer cannot describe the control without this: on claude the
    // message joins the running turn, on cursor it cancels whatever is in
    // flight and answers instead. One sentence for both would be false about
    // one of them.
    const interrupts = new Map(
      service()
        .service.capabilitiesWire()
        .followUps.map((f) => [f.agent, f.interrupts]),
    );

    expect(interrupts.get('claude')).toBe(false);
    expect(interrupts.get('cursor-agent')).toBe(true);
  });
});

describe('CapabilitiesService — background sub-agents', () => {
  const subagents = (): Map<string, string | null> =>
    new Map(
      service()
        .service.capabilitiesWire()
        .subagents.map((s) => [s.agent, s.unavailableReason]),
    );

  it('answers for EVERY registered CLI, so the renderer never allowlists one', () => {
    expect([...subagents().keys()]).toEqual([...registry().all().keys()]);
  });

  it('carries each adapter’s OWN reason, verbatim', () => {
    expect(subagents().get('claude')).toBe(
      new ClaudeAdapter().getConfig().subagents.unavailableReason,
    );
    expect(subagents().get('cursor-agent')).toBe(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
      }).getConfig().subagents.unavailableReason,
    );
  });

  it('states BOTH shipped CLIs as reporting delegates, so neither row carries an excuse', () => {
    // Cursor's used to be a sentence here, on a measurement that never reached
    // the wire (see `CursorAcpAdapter`'s `subagents` field). Both CLIs now report
    // their delegates, so a null is the honest answer for both — and the row
    // stays, because it is what a THIRD CLI that reports none would speak
    // through. Why a cursor delegate's card shows no conversation is a different
    // question, answered on the delegate's own row rather than here.
    expect(subagents().get('claude')).toBeNull();
    expect(subagents().get('cursor-agent')).toBeNull();
  });
});

describe('CapabilitiesService — token and cost usage', () => {
  const usage = (): Map<string, string | null> =>
    new Map(
      service()
        .service.capabilitiesWire()
        .usage.map((u) => [u.agent, u.unavailableReason]),
    );

  it('answers for EVERY registered CLI, so the meter never allowlists one', () => {
    expect([...usage().keys()]).toEqual([...registry().all().keys()]);
  });

  it('carries each adapter’s OWN reason, verbatim', () => {
    expect(usage().get('claude')).toBe(
      new ClaudeAdapter().getConfig().usage.unavailableReason,
    );
    expect(usage().get('cursor-agent')).toBe(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
      }).getConfig().usage.unavailableReason,
    );
  });

  it('states claude’s reporting as null and cursor’s absence as a real sentence', () => {
    // This is the whole point of the row: an empty context meter looks exactly
    // like a turn that has not finished, and the two mean opposite things. The
    // sentence is what a user pointing at the empty spot gets — which is how
    // this was reported ("why don't I see context here?").
    expect(usage().get('claude')).toBeNull();
    expect(usage().get('cursor-agent')).toEqual(expect.any(String));
    expect(usage().get('cursor-agent')).not.toBe('');
    // What the sentence has to name is what the user came looking for — the
    // COST. The wire-level measurement behind it belongs in the adapter's own
    // doc block, not in a string the user reads.
    expect(usage().get('cursor-agent')).toContain('cost');
  });
});

describe('CapabilitiesService — the reasoning-effort picker', () => {
  const efforts = (): Map<string, string | null> =>
    new Map(
      service()
        .service.capabilitiesWire()
        .modelEfforts.map((e) => [e.agent, e.unavailableReason]),
    );

  it('answers for EVERY registered CLI, so the chip never allowlists one', () => {
    expect([...efforts().keys()]).toEqual([...registry().all().keys()]);
  });

  it('carries each adapter’s OWN reason, verbatim', () => {
    expect(efforts().get('claude')).toBe(
      new ClaudeAdapter().getConfig().effortsUnavailableReason,
    );
    expect(efforts().get('cursor-agent')).toBe(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
      }).getConfig().effortsUnavailableReason,
    );
  });

  it('reports BOTH shipped CLIs as having a picker', () => {
    // Null for both is the current truth, not a placeholder: claude has
    // `--effort`, and cursor's `effort` config option became reachable once the
    // handshake declared `parameterizedModelPicker`. The row stays because it is
    // the only thing that can explain an ABSENT picker to the user, and a third
    // CLI without one is exactly what it is for.
    expect(efforts().get('claude')).toBeNull();
    expect(efforts().get('cursor-agent')).toBeNull();
  });
});

describe('CapabilitiesService — how each CLI is named', () => {
  const agents = () => service().service.capabilitiesWire().agents;

  it('answers for EVERY registered CLI, in registration order', () => {
    expect(agents().map((row) => row.agent)).toEqual([
      ...registry().all().keys(),
    ]);
  });

  it('carries each adapter’s OWN identity, verbatim', () => {
    // Each row against the adapter that owns it: the renderer draws every
    // agent's name and glyph from these rows, and one served another CLI's
    // identity still names an agent — the wrong one.
    const rows = new Map(agents().map((row) => [row.agent, row]));
    for (const [kind, adapter] of registry().all()) {
      const { details, ...identity } = adapter.getConfig().identity;
      expect(rows.get(kind), `the ${kind} row`).toMatchObject({
        ...identity,
        details: [...details],
      });
    }
  });

  it('says a caller escalates a question only through a question tool of its own', () => {
    // claude's model has AskUserQuestion; cursor's has none, and geniro's own
    // question tool reaches chats alone — so a cursor caller in a team
    // cannot put a callee's question to the user.
    const byAgent = new Map(
      agents().map((row) => [row.agent, row.callerEscalatesQuestions]),
    );
    expect(byAgent.get('claude')).toBe(true);
    expect(byAgent.get('cursor-agent')).toBe(false);
  });
});

describe('CapabilitiesService — the light model', () => {
  const lightModels = () =>
    new Map(
      service()
        .service.capabilitiesWire()
        .agents.map((row) => [row.agent, row.lightModel]),
    );

  it('serves claude’s haiku, codex’s luna and no light model for cursor', () => {
    expect(lightModels().get('claude')).toBe('haiku');
    expect(lightModels().get('codex')).toBe('gpt-6-luna');
    expect(lightModels().get('cursor-agent')).toBeNull();
  });

  it('reads the light model off the adapter config, never from a list of its own', () => {
    const claude = new ClaudeAdapter();
    const config = claude.getConfig();
    vi.spyOn(claude, 'getConfig').mockReturnValue({
      ...config,
      lightModel: 'a-model-only-this-test-names',
    });
    const cursor = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    });
    const cursorConfig = cursor.getConfig();
    vi.spyOn(cursor, 'getConfig').mockReturnValue({
      ...cursorConfig,
      lightModel: null,
    });

    const rows = new Map(
      new CapabilitiesService(new AgentAdapterRegistry([claude, cursor]))
        .capabilitiesWire()
        .agents.map((row) => [row.agent, row.lightModel]),
    );

    expect(rows.get('claude')).toBe('a-model-only-this-test-names');
    expect(rows.get('cursor-agent')).toBeNull();
  });
});

describe('CapabilitiesService — each CLI’s own switches', () => {
  const options = () =>
    new Map(
      service()
        .service.capabilitiesWire()
        .options.map((row) => [row.agent, row.options]),
    );

  it('answers for EVERY registered CLI, so Settings never allowlists one', () => {
    expect([...options().keys()]).toEqual([...registry().all().keys()]);
  });

  it('publishes each adapter’s OWN option list, verbatim and in order', () => {
    // The Settings card draws these rows as they come, so the label, the
    // sentence under it and the default are the adapter's words, not a copy
    // the renderer keeps.
    expect(options().get('claude')).toEqual(
      new ClaudeAdapter().getConfig().options,
    );
    expect(options().get('cursor-agent')).toEqual(
      new CursorAcpAdapter({
        vocabularyStore: freshVocabularyStore(),
      }).getConfig().options,
    );
  });

  it('states the two shipped switches with the defaults their runs have always had', () => {
    expect(
      options()
        .get('claude')
        ?.map((option) => [option.id, option.defaultValue]),
    ).toEqual([['browserTools', false]]);
    expect(
      options()
        .get('cursor-agent')
        ?.map((option) => [option.id, option.defaultValue]),
    ).toEqual([['maxMode', true]]);
  });
});

describe('CapabilitiesService — the interactive terminal', () => {
  it('answers for EVERY registered CLI, so the renderer never allowlists one', () => {
    expect(
      service()
        .service.capabilitiesWire()
        .interactiveTerminals.map((t) => t.agent),
    ).toEqual([...registry().all().keys()]);
  });

  it('reports claude as available and cursor-agent as not', () => {
    // The two live values, read through each adapter's own handoff config
    // rather than restated here: cursor-acp's `handoff: { kind: 'unavailable' }`
    // IS the fact, and a CLI that gains a mirror must need no change here.
    const byAgent = new Map(
      service()
        .service.capabilitiesWire()
        .interactiveTerminals.map((t) => [t.agent, t.unavailableReason]),
    );

    expect(byAgent.get('claude')).toBeNull();
    expect(byAgent.get('cursor-agent')).toEqual(expect.any(String));
    expect(byAgent.get('cursor-agent')).not.toBe('');
  });

  it("passes the ADAPTER'S OWN sentence through, never one composed here", () => {
    // This service used to build `"<agent> has no interactive terminal
    // session"` of its own while `GET /v1/handoff` returned the adapter's real
    // reason — two different answers to one question, and the invented one was
    // the only one the panel ever showed. The renderer now renders this string
    // on an inert control, so it has to be the CLI's own words: "no interactive
    // terminal session" tells a user nothing they can act on, where "it keeps
    // those separately from its own chats" does.
    //
    // Compared against the adapter, not against a literal — a reworded config
    // must not need this file edited, but a service that stops reading the
    // config must fail here.
    const reason = new Map(
      service()
        .service.capabilitiesWire()
        .interactiveTerminals.map((t) => [t.agent, t.unavailableReason]),
    ).get('cursor-agent');
    const config = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    }).getConfig().handoff;

    expect(config.kind).toBe('unavailable');
    expect(reason).toBe(
      config.kind === 'unavailable' ? config.reason : undefined,
    );
    // And it is genuinely a sentence about THIS CLI's mechanism, not the old
    // template. Kept as a substring so a rewording stays free.
    expect(reason).toContain('separately');
  });

  it('does not mistake "no session yet" for "no terminal support"', () => {
    // `handoffTarget` refuses for two different reasons and only one is
    // permanent. The capability answers the permanent question directly
    // (`handoffUnavailableReason`), which is what keeps a claude member that has
    // simply not run yet from being reported as having no interactive mirror at
    // all — that would hide the control forever. It used to fabricate a session
    // id to reach the same verdict through `handoffTarget`.
    expect(
      new ClaudeAdapter().handoffTarget({ sessionId: null, model: null }),
    ).toEqual({ ok: false, reason: 'no-session' });
    expect(new ClaudeAdapter().handoffUnavailableReason()).toBeNull();

    const byAgent = new Map(
      service()
        .service.capabilitiesWire()
        .interactiveTerminals.map((t) => [t.agent, t.unavailableReason]),
    );
    expect(byAgent.get('claude')).toBeNull();
  });

  describe('approval modes', () => {
    it('answers for EVERY registered CLI, so the chip never decides by name', () => {
      expect(
        service()
          .service.capabilitiesWire()
          .approvals.map((a) => a.agent),
      ).toEqual([...registry().all().keys()]);
    });

    it('reports cursor’s real ACP modes, not an empty set', () => {
      // The composer used to render no approval chip for cursor at all, on the
      // grounds that the CLI had no per-turn approval channel. ACP gave it one,
      // and this is the fact that lets the renderer notice.
      const byAgent = new Map(
        service()
          .service.capabilitiesWire()
          .approvals.map((a) => [a.agent, a.modes]),
      );
      expect(byAgent.get('cursor-agent')).toEqual(
        new CursorAcpAdapter({
          vocabularyStore: freshVocabularyStore(),
        }).getConfig().approval.modes,
      );
      expect(byAgent.get('cursor-agent')).toContain('ask');
      expect(byAgent.get('claude')).toEqual(
        new ClaudeAdapter().getConfig().approval.modes,
      );
    });
  });
});
