import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { AgentKind } from '../../runs/runs.types';
import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CodexAdapter } from '../adapters/codex/codex.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import type { AgentModelWire } from '../chat.types';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVersionService } from './agent-version.service';
import { ContextWindowStore } from './context-window.store';
import { ModelVocabularyStore } from './model-vocabulary.store';
import { ModelsService, type ModelsServiceOptions } from './models.service';
import { OllamaService } from './ollama.service';
import { ProcessRegistry } from './process-registry';

function service(
  options: ModelsServiceOptions = {},
  store: ModelVocabularyStore = freshVocabularyStore(),
): {
  models: ModelsService;
  claude: ClaudeAdapter;
  cursor: CursorAcpAdapter;
  store: ModelVocabularyStore;
} {
  const claude = new ClaudeAdapter();
  vi.spyOn(claude, 'modelDetails').mockImplementation(async (model) => model);
  const cursor = new CursorAcpAdapter({ vocabularyStore: store });
  // The version is PINNED, and that is what makes the durable path reachable
  // at all: the binary is absent here, so a real `--version` resolves to null,
  // and the store refuses to serve OR store under a null version — every
  // assertion about it would be vacuously true.
  const versions = new AgentVersionService();
  vi.spyOn(versions, 'resolve').mockResolvedValue('2026.08.11-e8db854');
  return {
    claude,
    cursor,
    store,
    models: new ModelsService(
      new AgentAdapterRegistry([claude, cursor]),
      new ProcessRegistry(),
      versions,
      store,
      options,
    ),
  };
}

const LISTED: AgentModelWire[] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', source: 'cli' },
];

describe('ModelsService — the memory mirror over the durable store', () => {
  it('uses current alias metadata and measurements after reading the cached vocabulary', async () => {
    const windows = new ContextWindowStore({
      file: join(
        mkdtempSync(join(tmpdir(), 'picker-windows-')),
        'windows.json',
      ),
    });
    const { models, claude } = service({ windows });
    const ask = vi
      .spyOn(claude, 'listModels')
      .mockResolvedValue([{ id: 'haiku', label: 'haiku', source: 'builtin' }]);
    vi.mocked(claude.modelDetails).mockResolvedValue({
      id: 'haiku',
      label: 'Haiku 5.5',
      resolvedModel: 'claude-haiku-5-5',
      source: 'cli',
    });
    vi.spyOn(claude, 'catalogWindow').mockReturnValue(1_000_000);
    expect(await models.list(AgentKind.Claude)).toEqual([
      expect.objectContaining({
        resolvedModel: 'claude-haiku-5-5',
        contextTokens: 1_000_000,
        contextWindowSelectable: false,
      }),
    ]);
    windows.remember(AgentKind.Claude, 'claude-haiku-5-5', 900_000);
    expect(await models.list(AgentKind.Claude)).toEqual([
      expect.objectContaining({ contextTokens: 900_000 }),
    ]);
    windows.remember(AgentKind.Claude, 'claude-haiku-next', 700_000);
    vi.mocked(claude.modelDetails).mockResolvedValue({
      id: 'haiku',
      label: 'Haiku next',
      resolvedModel: 'claude-haiku-next',
      contextTokens: 800_000,
      source: 'cli',
    });
    expect(await models.list(AgentKind.Claude)).toEqual([
      expect.objectContaining({
        resolvedModel: 'claude-haiku-next',
        contextTokens: 800_000,
      }),
    ]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('uses the measured Codex default, never its catalog maximum or a named window choice', async () => {
    const windows = new ContextWindowStore({
      file: join(mkdtempSync(join(tmpdir(), 'picker-codex-')), 'windows.json'),
    });
    const codex = new CodexAdapter({
      prices: {
        priceOf: () => ({
          input: 1,
          output: 1,
          cacheRead: 1,
          cacheWrite: 1,
          tiers: [],
          contextTokens: 1_050_000,
        }),
      },
    });
    vi.spyOn(codex, 'listModels').mockResolvedValue([
      { id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol', source: 'cli' },
    ]);
    const versions = new AgentVersionService();
    vi.spyOn(versions, 'resolve').mockResolvedValue('1');
    const models = new ModelsService(
      new AgentAdapterRegistry([codex]),
      new ProcessRegistry(),
      versions,
      freshVocabularyStore(),
      { windows },
    );
    windows.remember(AgentKind.Codex, 'gpt-6.1-sol', 828_400, '872k');
    expect((await models.list(AgentKind.Codex))[0]).not.toHaveProperty(
      'contextTokens',
    );
    windows.remember(AgentKind.Codex, 'gpt-6.1-sol', 475_000);
    expect((await models.list(AgentKind.Codex))[0]).toMatchObject({
      contextTokens: 475_000,
      contextWindowSelectable: true,
    });
  });

  it('refreshes local discovery without persisting it in the native model cache', async () => {
    const ollama = new OllamaService();
    const discover = vi
      .spyOn(ollama, 'list')
      .mockResolvedValueOnce([
        { id: 'ollama/first', label: 'first', source: 'ollama' },
      ])
      .mockResolvedValueOnce([
        { id: 'ollama/second', label: 'second', source: 'ollama' },
      ]);
    const { models, claude, cursor } = service({ ollama });
    const ask = vi
      .spyOn(claude, 'listModels')
      .mockResolvedValue(structuredClone(LISTED));
    expect(await models.list(AgentKind.Claude)).toEqual([
      ...LISTED,
      { id: 'ollama/first', label: 'first', source: 'ollama' },
    ]);
    expect(await models.list(AgentKind.Claude)).toEqual([
      ...LISTED,
      { id: 'ollama/second', label: 'second', source: 'ollama' },
    ]);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledTimes(2);
    vi.spyOn(cursor, 'listModels').mockResolvedValue([]);
    expect(await models.list(AgentKind.CursorAgent)).toEqual([
      expect.objectContaining({
        source: 'ollama',
        unavailableReason: expect.stringContaining('does not expose offline'),
      }),
    ]);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('seeds the mirror with the READ time, not the stored timestamp', async () => {
    // The defect this pins is silent: the store keeps serving an entry for an
    // hour before it revalidates, while this cache expires it after ten
    // minutes. Seeded with the DISK timestamp, every entry older than the TTL
    // but younger than the revalidate window failed the memory check on EVERY
    // call — so the disk read and its shape walk ran per request instead of
    // once per TTL window, for the whole remaining fifty minutes.
    //
    // The store shares the test's CLOCK, which is load-bearing: with its own
    // real `Date.now` its `fetchedAt` sits in a different epoch from the fake
    // one, `now - fetchedAt` goes hugely negative, and the memory entry reads
    // as fresh whichever timestamp seeded it — so the assertion below would
    // hold with the fix reverted.
    let clock = 0;
    const store = new ModelVocabularyStore({
      file: join(mkdtempSync(join(tmpdir(), 'geniro-models-')), 'v.json'),
      now: () => clock,
    });
    const reads = vi.spyOn(store, 'read');
    const { models, cursor } = service(
      { ttlMs: 10 * 60_000, now: () => clock },
      store,
    );
    const ask = vi
      .spyOn(cursor, 'listModels')
      .mockResolvedValue(structuredClone(LISTED));

    await models.list('cursor-agent');
    expect(ask).toHaveBeenCalledTimes(1);

    // Past the memory TTL, still inside the store's own revalidate window: the
    // store answers and re-seeds the mirror.
    clock = 30 * 60_000;
    await models.list('cursor-agent');
    const afterReseed = reads.mock.calls.length;

    // The very next call must be answered from memory. Seeded from disk it is
    // already expired again, and every call re-reads the store for ever.
    await models.list('cursor-agent');
    await models.list('cursor-agent');

    expect(reads.mock.calls.length).toBe(afterReseed);
  });

  it('asks the CLI once when two callers race a cold list', async () => {
    // Listing cursor's models spawns a process group, so two chat panes
    // mounting their model chip at once must not launch two of them for one
    // account-level answer.
    const { models, cursor } = service();
    const ask = vi
      .spyOn(cursor, 'listModels')
      .mockResolvedValue(structuredClone(LISTED));

    const [a, b] = await Promise.all([
      models.list('cursor-agent'),
      models.list('cursor-agent'),
    ]);

    expect(ask).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });
});

describe('ModelsService — one list per ACCOUNT', () => {
  it("asks per profile, and never serves one account's models to another", async () => {
    // The composer's own reader, and the defect from its end: the memory cache
    // was keyed by AGENT alone, so the first chat to open its picker filed its
    // subscription's models under the CLI's name and every other account was
    // served that. Which models exist is decided by the subscription, and the
    // subscription is the config directory.
    const { models } = service();
    const listed = vi
      .spyOn(ClaudeAdapter.prototype, 'listModels')
      .mockImplementation(({ configDir }) =>
        Promise.resolve([
          {
            id: `model-for-${configDir ?? 'default'}`,
            label: 'Whatever this account offers',
            source: 'cli' as const,
          },
        ]),
      );

    const team = await models.list('claude', '/profiles/team');
    const max = await models.list('claude', '/profiles/max');
    // Served from cache the second time round, so the key SPLITS rather than
    // merely defeating the cache.
    const teamAgain = await models.list('claude', '/profiles/team');

    expect(team.map((m) => m.id)).toEqual(['model-for-/profiles/team']);
    expect(max.map((m) => m.id)).toEqual(['model-for-/profiles/max']);
    expect(teamAgain).toEqual(team);
    expect(listed).toHaveBeenCalledTimes(2);
    listed.mockRestore();
  });
});

describe('ModelsService — an account change (`forgetAgent`)', () => {
  const OLD: AgentModelWire[] = [
    { id: 'old-account-model', label: 'Old', source: 'cli' },
  ];
  const NEW: AgentModelWire[] = [
    { id: 'new-account-model', label: 'New', source: 'cli' },
  ];

  /** A listing the SPEC answers, so an ask can be held open across a forget. */
  function heldListing(cursor: CursorAcpAdapter): {
    answer: (index: number, models: AgentModelWire[]) => void;
    calls: () => number;
  } {
    const pending: ((models: AgentModelWire[]) => void)[] = [];
    vi.spyOn(cursor, 'listModels').mockImplementation(
      () =>
        new Promise<AgentModelWire[]>((resolve) => {
          pending.push(resolve);
        }),
    );
    return {
      answer: (index, models) => pending[index]?.(structuredClone(models)),
      calls: () => pending.length,
    };
  }

  /** Let the listing's own awaits (the version) run until the ask is made. */
  async function untilAsked(calls: () => number, count: number): Promise<void> {
    while (calls() < count) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  it('drops the MEMORY copy, which is read before the store', async () => {
    // A sign-in forgot the durable store alone, and this mirror is consulted
    // FIRST — so the previous account's models were served for the rest of the
    // ten-minute TTL.
    const { models, cursor, store } = service();
    const listing = heldListing(cursor);
    const first = models.list('cursor-agent');
    await untilAsked(listing.calls, 1);
    listing.answer(0, OLD);
    await first;

    // The durable half is dropped as the sign-in always dropped it; what is
    // under test is that the memory half now goes with it.
    store.forget('cursor-agent');
    expect(models.forgetAgent('cursor-agent')).toBe(1);
    const second = models.list('cursor-agent');
    await untilAsked(listing.calls, 2);
    listing.answer(1, NEW);

    expect(await second).toEqual(NEW);
  });

  it('never files an answer whose ask started before the forget', async () => {
    // The race the forget alone cannot close: an ask already running was taken
    // under the credentials just replaced, and landing after the forget it
    // wrote the previous account's list back — into memory AND onto disk.
    const { models, cursor, store } = service();
    const listing = heldListing(cursor);
    const before = models.list('cursor-agent');
    await untilAsked(listing.calls, 1);

    models.forgetAgent('cursor-agent');
    store.forget('cursor-agent');
    const after = models.list('cursor-agent');
    await untilAsked(listing.calls, 2);
    listing.answer(0, OLD);
    await before;
    listing.answer(1, NEW);

    expect(await after).toEqual(NEW);
    // Served from memory now, and it is the NEW account's list.
    expect(await models.list('cursor-agent')).toEqual(NEW);
    expect(listing.calls()).toBe(2);
    expect(
      store.read('cursor-agent', null, null, '2026.08.11-e8db854', isList)
        ?.value,
    ).toEqual(NEW);
  });

  it('never files a BACKGROUND refresh that straddled the forget', async () => {
    // Serve-then-refresh: a stored answer past its revalidate window is served
    // and re-asked behind the response. A sign-in landing while that refresh
    // runs must not have it write the old account's models back for a week.
    let clock = 0;
    const store = new ModelVocabularyStore({
      file: join(mkdtempSync(join(tmpdir(), 'geniro-models-')), 'v.json'),
      now: () => clock,
    });
    store.remember('cursor-agent', null, null, '2026.08.11-e8db854', OLD);
    clock = 2 * 60 * 60_000;
    const { models, cursor } = service({ now: () => clock }, store);
    const listing = heldListing(cursor);

    expect(await models.list('cursor-agent')).toEqual(OLD);
    await untilAsked(listing.calls, 1);
    store.forget('cursor-agent');
    models.forgetAgent('cursor-agent');
    listing.answer(0, OLD);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      store.read('cursor-agent', null, null, '2026.08.11-e8db854', isList),
    ).toBeNull();
  });
});

describe('ModelsService — a listing the CLI could not answer', () => {
  it('asks again well inside the TTL after an empty listing', async () => {
    let clock = 0;
    const { models, cursor } = service({
      ttlMs: 10 * 60_000,
      now: () => clock,
    });
    const ask = vi
      .spyOn(cursor, 'listModels')
      .mockResolvedValueOnce([])
      .mockResolvedValue(structuredClone(LISTED));

    expect(await models.list('cursor-agent')).toEqual([]);
    clock = 2 * 60_000;

    expect(
      (await models.list('cursor-agent')).map((model) => model.id),
    ).toContain('claude-opus-5');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('keeps serving the last good list when a refresh comes back empty', async () => {
    let clock = 0;
    const store = new ModelVocabularyStore({
      file: join(mkdtempSync(join(tmpdir(), 'geniro-models-')), 'v.json'),
      now: () => clock,
    });
    store.remember('cursor-agent', null, null, '2026.08.11-e8db854', LISTED);
    clock = 2 * 60 * 60_000;
    const { models, cursor } = service({ now: () => clock }, store);
    const ask = vi.spyOn(cursor, 'listModels').mockResolvedValue([]);

    expect(
      (await models.list('cursor-agent')).map((model) => model.id),
    ).toContain('claude-opus-5');
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      (await models.list('cursor-agent')).map((model) => model.id),
    ).toContain('claude-opus-5');
  });

  it("serves the previous version's list when the first probe after an upgrade comes back empty, and files nothing", async () => {
    let clock = 0;
    const store = new ModelVocabularyStore({
      file: join(mkdtempSync(join(tmpdir(), 'geniro-models-')), 'v.json'),
      now: () => clock,
    });
    store.remember('cursor-agent', null, null, '2026.08.04-aaa8809', LISTED);
    clock = 60_000;
    const { models, cursor } = service({ now: () => clock }, store);
    const ask = vi
      .spyOn(cursor, 'listModels')
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { id: 'claude-opus-6', label: 'Claude Opus 6', source: 'cli' },
      ]);

    expect(
      (await models.list('cursor-agent')).map((model) => model.id),
    ).toEqual(['claude-opus-5']);
    expect(
      store.read('cursor-agent', null, null, '2026.08.11-e8db854', isList),
    ).toBeNull();

    clock += 31_000;
    expect(
      (await models.list('cursor-agent')).map((model) => model.id),
    ).toEqual(['claude-opus-6']);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('treats a listing that threw like an empty one and asks again after the retry window', async () => {
    let clock = 0;
    const { models, cursor } = service({
      ttlMs: 10 * 60_000,
      now: () => clock,
    });
    const ask = vi
      .spyOn(cursor, 'listModels')
      .mockRejectedValueOnce(new Error('probe crashed'))
      .mockResolvedValue(structuredClone(LISTED));

    expect(await models.list('cursor-agent')).toEqual([]);
    clock = 10_000;
    expect(await models.list('cursor-agent')).toEqual([]);
    expect(ask).toHaveBeenCalledTimes(1);
    clock = 31_000;

    expect(
      (await models.list('cursor-agent')).map((model) => model.id),
    ).toEqual(['claude-opus-5']);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('does not ask again inside the retry window', async () => {
    let clock = 0;
    const { models, cursor } = service({ now: () => clock });
    const ask = vi.spyOn(cursor, 'listModels').mockResolvedValue([]);

    await models.list('cursor-agent');
    clock = 10_000;
    await models.list('cursor-agent');

    expect(ask).toHaveBeenCalledTimes(1);
  });
});

/** The store's shape guard, in miniature. */
function isList(value: unknown): value is AgentModelWire[] {
  return Array.isArray(value);
}
