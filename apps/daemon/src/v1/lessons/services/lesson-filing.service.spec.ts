import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnalysisTurn } from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import type { MemoryService } from '../../memory/services/memory.service';
import type { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { LessonSegmentDao } from '../dao/lesson-segment.dao';
import { LessonProposal } from '../entity/lesson-proposal.entity';
import type { LessonDedup, LessonTarget } from '../lessons.types';
import {
  type LessonFiled,
  LessonFilingService,
  type ProposedLesson,
} from './lesson-filing.service';
import type { LessonRowWriter } from './lesson-row.writer';

type Item = {
  seq: number;
  kind: string;
  role: string | null;
  payload: string;
};

const SEGMENT_FROM = 4;
const SEGMENT_TO = 9;

const ITEMS: Item[] = [
  message(4, 'the earlier stretch says use pnpm not npm too'),
  message(5, 'text of row five is here'),
  message(6, 'No, use pnpm not npm in this repo'),
  message(9, 'The cache key must not include the run id'),
  message(10, 'the later stretch says use pnpm not npm too'),
];

function message(seq: number, text: string): Item {
  return {
    seq,
    kind: 'message',
    role: 'user',
    payload: JSON.stringify({ text }),
  };
}

const TURN: AnalysisTurn = {
  analysisRunId: 'refl',
  sourceRunId: 'src',
  snapshotSeq: SEGMENT_TO,
  sourceWorking: false,
  purpose: 'lessons',
};

function lesson(overrides: Partial<ProposedLesson> = {}): ProposedLesson {
  return {
    title: "WHEN a check fails → DON'T retry it unchanged",
    rule: 'Change what a failing check exercises before rerunning it.',
    why: 'The same check failed three times unchanged.',
    signalKind: 'user_correction',
    evidence: { seq: 6, quote: 'use pnpm not npm' },
    target: { kind: 'memory', scope: 'project', type: 'feedback' },
    dedup: { verdict: 'new', handle: null },
    ...overrides,
  };
}

function build(
  options: {
    turn?: AnalysisTurn;
    source?: { reflectedThroughSeq: number | null; teamId?: string } | null;
    project?: { id: string } | null;
    visible?: { handle: string; title: string }[];
    items?: Item[];
  } = {},
) {
  const source =
    options.source === undefined
      ? {
          id: 'src',
          title: 'Migrate the cache',
          teamId: null,
          reflectedThroughSeq: SEGMENT_FROM,
        }
      : options.source === null
        ? null
        : {
            id: 'src',
            title: 'Migrate the cache',
            teamId: null,
            ...options.source,
          };
  const reflection = {
    id: 'refl',
    agentKind: 'claude',
    model: 'opus',
  };
  const segment = {
    id: 'seg-1',
    fromSeq: SEGMENT_FROM,
    toSeq: SEGMENT_TO,
    status: 'reflecting',
  };
  const items = options.items ?? ITEMS;

  const tx = { persist: vi.fn() };
  const em = {
    fork: () => em,
    transactional: vi.fn((work: (inner: typeof tx) => Promise<void>) =>
      work(tx),
    ),
  };
  const runDao = {
    getById: vi.fn((id: string) =>
      Promise.resolve(id === 'src' ? source : reflection),
    ),
    updateById: vi.fn(() => Promise.resolve()),
  };
  const itemDao = {
    analysisPage: vi.fn(
      (
        _runId: string,
        page: { afterSeq: number; maxSeq: number; limit: number },
      ) =>
        Promise.resolve(
          items
            .filter(
              (item) => item.seq > page.afterSeq && item.seq <= page.maxSeq,
            )
            .slice(0, page.limit),
        ),
    ),
  };
  const memory = {
    listVisible: vi.fn(() => Promise.resolve(options.visible ?? [])),
  };
  const projectScope = {
    projectOfRun: vi.fn(() => Promise.resolve(options.project ?? null)),
  };
  const segments = {
    ofReflection: vi.fn(() => Promise.resolve(segment)),
    updateById: vi.fn((_id: string, patch: Partial<typeof segment>) => {
      Object.assign(segment, patch);
      return Promise.resolve();
    }),
  };
  const rows = {
    write: vi.fn(() => Promise.resolve()),
  };
  const service = new LessonFilingService(
    em as never,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    memory as unknown as MemoryService,
    projectScope as unknown as ProjectScopeService,
    segments as unknown as LessonSegmentDao,
    rows as unknown as LessonRowWriter,
  );
  return {
    service,
    turn: options.turn ?? TURN,
    tx,
    runDao,
    segments,
    segment,
    rows,
  };
}

function codesOf(result: LessonFiled): string[] {
  return result.status === 'refused'
    ? result.problems.map((problem) => problem.code)
    : [];
}

function expectNothingWritten(fixture: ReturnType<typeof build>): void {
  expect(fixture.tx.persist).not.toHaveBeenCalled();
  expect(fixture.segments.updateById).not.toHaveBeenCalled();
  expect(fixture.runDao.updateById).not.toHaveBeenCalled();
  expect(fixture.rows.write).not.toHaveBeenCalled();
  expect(fixture.segment.status).toBe('reflecting');
}

describe('LessonFilingService.file', () => {
  afterEach(() => {
    clearSecrets();
  });

  it.each([
    ['a thread review', 'review' as const],
    ['an untagged analysis', undefined],
  ])('refuses a call from %s, writing nothing', async (_, purpose) => {
    const fixture = build({ turn: { ...TURN, purpose } });

    const result = await fixture.service.file(fixture.turn, [lesson()]);

    expect(codesOf(result)).toEqual(['NOT_A_REFLECTION']);
    expectNothingWritten(fixture);
  });

  it('refuses a reflection whose thread is gone, writing nothing', async () => {
    const fixture = build({ source: null });

    const result = await fixture.service.file(fixture.turn, [lesson()]);

    expect(codesOf(result)).toEqual(['SOURCE_GONE']);
    expectNothingWritten(fixture);
  });

  it('refuses more than three lessons, writing nothing', async () => {
    const fixture = build();

    const result = await fixture.service.file(fixture.turn, [
      lesson({ title: 'First rule about checks' }),
      lesson({ title: 'Second rule about builds' }),
      lesson({ title: 'Third rule about caches' }),
      lesson({ title: 'Fourth rule about stores' }),
    ]);

    expect(codesOf(result)).toEqual(['TOO_MANY']);
    expectNothingWritten(fixture);
  });

  it('accepts three lessons, the most one reflection may file', async () => {
    const fixture = build();

    const result = await fixture.service.file(fixture.turn, [
      lesson({ title: 'First rule about checks' }),
      lesson({ title: 'Second rule about builds' }),
      lesson({ title: 'Third rule about caches' }),
    ]);

    expect(result).toEqual({ status: 'recorded', count: 3 });
  });

  it.each([
    ['at the watermark', SEGMENT_FROM],
    ['past the stretch', SEGMENT_TO + 1],
  ])(
    'refuses evidence %s, even when its quote is in that row',
    async (_, seq) => {
      const fixture = build();

      const result = await fixture.service.file(fixture.turn, [
        lesson({ evidence: { seq, quote: 'use pnpm not npm' } }),
      ]);

      expect(codesOf(result)).toEqual(['EVIDENCE_OUT_OF_SEGMENT']);
      expectNothingWritten(fixture);
    },
  );

  it.each([
    [SEGMENT_FROM + 1, 'text of row five'],
    [SEGMENT_TO, 'cache key must not include'],
  ])(
    'accepts evidence at row %i, the first and last inside the stretch',
    async (seq, quote) => {
      const fixture = build();

      const result = await fixture.service.file(fixture.turn, [
        lesson({ evidence: { seq, quote } }),
      ]);

      expect(result).toEqual({ status: 'recorded', count: 1 });
    },
  );

  it('refuses a quote that is not in the row the evidence names', async () => {
    const fixture = build();

    const absent = await fixture.service.file(fixture.turn, [
      lesson({ evidence: { seq: 6, quote: 'a sentence no row holds' } }),
    ]);
    const elsewhere = await fixture.service.file(fixture.turn, [
      lesson({ evidence: { seq: 6, quote: 'text of row five' } }),
    ]);

    expect(codesOf(absent)).toEqual(['QUOTE_NOT_FOUND']);
    expect(codesOf(elsewhere)).toEqual(['QUOTE_NOT_FOUND']);
    expectNothingWritten(fixture);
  });

  it('matches a quote across collapsed whitespace', async () => {
    const fixture = build({
      items: [message(6, 'No, use pnpm   not\n npm in this repo')],
    });

    const result = await fixture.service.file(fixture.turn, [
      lesson({ evidence: { seq: 6, quote: 'use pnpm\nnot   npm' } }),
    ]);

    expect(result).toEqual({ status: 'recorded', count: 1 });
  });

  it.each([
    ['title', { title: 'a'.repeat(121) }],
    ['rule', { rule: 'a'.repeat(301) }],
    ['why', { why: 'a'.repeat(301) }],
  ])('refuses a %s over its limit', async (_, override) => {
    const fixture = build();

    const result = await fixture.service.file(fixture.turn, [lesson(override)]);

    expect(codesOf(result)).toEqual(['TOO_LONG']);
    expectNothingWritten(fixture);
  });

  it('accepts a title of exactly 120 characters', async () => {
    const fixture = build();

    const result = await fixture.service.file(fixture.turn, [
      lesson({ title: 'a'.repeat(120) }),
    ]);

    expect(result).toEqual({ status: 'recorded', count: 1 });
  });

  it('refuses a lesson that carries a secret the daemon knows', async () => {
    registerSecret('ghp_exampleToken0123456789', 'github token');
    const fixture = build();

    const result = await fixture.service.file(fixture.turn, [
      lesson({
        rule: 'Never paste ghp_exampleToken0123456789 into a command.',
      }),
    ]);

    expect(codesOf(result)).toEqual(['CONTAINS_SECRET']);
    expectNothingWritten(fixture);
  });

  it('refuses a new lesson whose title a visible entry already carries', async () => {
    const fixture = build({
      visible: [{ handle: 'm3', title: 'Use pnpm, not npm!' }],
    });

    const duplicate = await fixture.service.file(fixture.turn, [
      lesson({
        title: 'use pnpm not npm',
        dedup: { verdict: 'new', handle: null },
      }),
    ]);
    const refining = await fixture.service.file(fixture.turn, [
      lesson({
        title: 'use pnpm not npm',
        dedup: { verdict: 'refines', handle: 'm3' },
      }),
    ]);

    expect(codesOf(duplicate)).toEqual(['NEAR_DUPLICATE']);
    expect(refining).toEqual({ status: 'recorded', count: 1 });
  });

  it('refuses a new lesson that says a visible entry in other words, and records one that says another thing', async () => {
    const fixture = build({
      visible: [{ handle: 'm3', title: 'Run pnpm test before a commit' }],
    });

    const similar = await fixture.service.file(fixture.turn, [
      lesson({ title: 'Run pnpm test before any commit' }),
    ]);
    const unrelated = await fixture.service.file(fixture.turn, [
      lesson({ title: 'Keep cache keys free of run ids' }),
    ]);

    expect(codesOf(similar)).toEqual(['NEAR_DUPLICATE']);
    expect(unrelated).toEqual({ status: 'recorded', count: 1 });
  });

  it.each([
    ['refines', { verdict: 'refines', handle: 'm99' }],
    [
      'broken_again without a handle',
      { verdict: 'broken_again', handle: null },
    ],
  ] as const)(
    'refuses a %s verdict that names no visible entry',
    async (_, dedup) => {
      const fixture = build({
        visible: [{ handle: 'm3', title: 'Use pnpm, not npm!' }],
      });

      const result = await fixture.service.file(fixture.turn, [
        lesson({ dedup: dedup as LessonDedup }),
      ]);

      expect(codesOf(result)).toEqual(['UNKNOWN_HANDLE']);
      expectNothingWritten(fixture);
    },
  );

  it('records every lesson at once, moves the watermark and writes one lessons row', async () => {
    const fixture = build();
    const second: ProposedLesson = lesson({
      title: 'Keep cache keys free of run ids',
      rule: 'Derive cache keys from content only, never from a run id.',
      why: 'A run id in the key made every run miss the cache.',
      signalKind: 'user_correction',
      evidence: { seq: 9, quote: 'cache key must not include the run id' },
      target: { kind: 'memory', scope: 'global', type: 'feedback' },
      dedup: { verdict: 'new', handle: null },
    });

    const result = await fixture.service.file(fixture.turn, [lesson(), second]);

    expect(result).toEqual({ status: 'recorded', count: 2 });
    const persisted = fixture.tx.persist.mock.calls.map(
      ([row]) => row as LessonProposal,
    );
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toBeInstanceOf(LessonProposal);
    expect(persisted.map((row) => row.status)).toEqual([
      'proposed',
      'proposed',
    ]);
    expect(persisted.map((row) => row.segmentId)).toEqual(['seg-1', 'seg-1']);
    expect(persisted.map((row) => row.sourceRunId)).toEqual(['src', 'src']);
    expect(persisted.map((row) => row.reflectionRunId)).toEqual([
      'refl',
      'refl',
    ]);
    expect(
      persisted.map((row) => JSON.parse(row.target) as LessonTarget),
    ).toEqual([lesson().target, second.target]);
    expect(
      persisted.map((row) => JSON.parse(row.dedup) as LessonDedup),
    ).toEqual([lesson().dedup, second.dedup]);

    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-1',
      { status: 'reflected' },
      fixture.tx,
    );
    expect(fixture.segment.status).toBe('reflected');
    expect(fixture.runDao.updateById).toHaveBeenCalledWith(
      'src',
      { reflectedThroughSeq: SEGMENT_TO },
      fixture.tx,
    );
    expect(fixture.rows.write).toHaveBeenCalledTimes(1);
    expect(fixture.rows.write).toHaveBeenCalledWith('src', {
      kind: 'lessons',
      payload: {
        reflectionRunId: 'refl',
        segmentId: 'seg-1',
        fromSeq: SEGMENT_FROM,
        toSeq: SEGMENT_TO,
        agentKind: 'claude',
        model: 'opus',
        proposals: [
          {
            id: persisted[0]!.id,
            title: lesson().title,
            rule: lesson().rule,
            why: lesson().why,
            signalKind: 'user_correction',
            evidence: { seq: 6, quote: 'use pnpm not npm' },
            target: lesson().target,
            dedup: lesson().dedup,
          },
          {
            id: persisted[1]!.id,
            title: second.title,
            rule: second.rule,
            why: second.why,
            signalKind: 'user_correction',
            evidence: {
              seq: 9,
              quote: 'cache key must not include the run id',
            },
            target: second.target,
            dedup: second.dedup,
          },
        ],
        places: { project: false, team: false },
      },
    });
  });

  it('tells the card which memory scopes the thread can save to', async () => {
    const fixture = build({
      source: { reflectedThroughSeq: SEGMENT_FROM, teamId: 'reviewers' },
      project: { id: 'proj-1' },
    });

    await fixture.service.file(fixture.turn, [lesson()]);

    expect(fixture.rows.write).toHaveBeenCalledWith('src', {
      kind: 'lessons',
      payload: expect.objectContaining({
        places: { project: true, team: true },
      }),
    });
    expect(
      fixture.tx.persist.mock.calls.map(([row]) => row as LessonProposal),
    ).toEqual([
      expect.objectContaining({ projectId: 'proj-1', teamSlug: 'reviewers' }),
    ]);
  });

  it('keeps the source watermark where it is when it is already past the stretch', async () => {
    const fixture = build({
      source: { reflectedThroughSeq: SEGMENT_TO + 3 },
    });

    const result = await fixture.service.file(fixture.turn, [lesson()]);

    expect(result).toEqual({ status: 'recorded', count: 1 });
    expect(fixture.runDao.updateById).not.toHaveBeenCalled();
  });

  it('records a stretch with no lesson as a success that moves the watermark and writes an empty lessons row', async () => {
    const fixture = build();

    const result = await fixture.service.file(fixture.turn, []);

    expect(result).toEqual({ status: 'recorded', count: 0 });
    expect(fixture.tx.persist).not.toHaveBeenCalled();
    expect(fixture.segment.status).toBe('reflected');
    expect(fixture.runDao.updateById).toHaveBeenCalledWith(
      'src',
      { reflectedThroughSeq: SEGMENT_TO },
      fixture.tx,
    );
    expect(fixture.rows.write).toHaveBeenCalledWith('src', {
      kind: 'lessons',
      payload: expect.objectContaining({ proposals: [] }),
    });
  });

  it('refuses a second filing of the same reflection, writing nothing more', async () => {
    const fixture = build();
    await fixture.service.file(fixture.turn, [lesson()]);

    const again = await fixture.service.file(fixture.turn, [lesson()]);

    expect(codesOf(again)).toEqual(['ALREADY_FILED']);
    expect(fixture.tx.persist).toHaveBeenCalledTimes(1);
    expect(fixture.rows.write).toHaveBeenCalledTimes(1);
  });
});
