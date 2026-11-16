import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnalysisTurn } from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import type { KnowledgeService } from '../../knowledge/services/knowledge.service';
import type { MemoryService } from '../../memory/services/memory.service';
import type { ProjectScopeService } from '../../projects/services/project-scope.service';
import { member, teamOf } from '../../teams/__tests__/team-builders';
import { teamSnapshotOf } from '../../teams/utils/team-snapshot';
import type { LessonProposalDao } from '../dao/lesson-proposal.dao';
import type { LessonSegmentDao } from '../dao/lesson-segment.dao';
import { LessonProposal } from '../entity/lesson-proposal.entity';
import type {
  LessonDedup,
  LessonModelChoice,
  LessonTarget,
} from '../lessons.types';
import {
  type LessonFiled,
  LessonFilingService,
  type ProposedLesson,
} from './lesson-filing.service';
import type { LessonRowWriter } from './lesson-row.writer';
import type { LessonsConfigService } from './lessons-config.service';
import type { LessonsEventBus } from './lessons-events.bus';

type Item = {
  seq: number;
  kind: string;
  role: string | null;
  payload: string;
};

type SavedOutcome =
  | { kind: 'created'; entry: { handle: string; status: 'active' | 'pending' } }
  | {
      kind: 'near_duplicate';
      candidates: { handle: string }[];
      pending: string[];
    };

const SEGMENT_FROM = 4;
const SEGMENT_TO = 9;
const LEASE = new Date('2026-11-15T10:00:00.000Z');
const TEAM = teamOf([member('builder'), member('reviewer')], {
  name: 'Reviewers',
});
const TEAM_SNAPSHOT = teamSnapshotOf(TEAM);
const SEEN_M3 = { id: 'id-m3', handle: 'm3', title: 'Use pnpm, not npm!' };
const SEEN_M7 = { id: 'id-m7', handle: 'm7', title: 'Port 47615' };

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

const CHECKER: LessonModelChoice = {
  agent: 'claude',
  configDir: null,
  model: 'opus',
  effort: 'high',
  contextWindow: null,
  modelParameters: {},
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
    source?: {
      reflectedThroughSeq: number | null;
      teamId?: string;
      teamSnapshot?: string | null;
    } | null;
    project?: { id: string } | null;
    documents?: { id: string }[];
    visible?: { id: string; handle: string; title: string }[];
    seen?: { id: string; handle: string; title: string }[];
    items?: Item[];
    closedBy?: 'manual' | 'archive' | 'delete';
    checker?: LessonModelChoice | null;
    saved?: SavedOutcome;
  } = {},
) {
  const source =
    options.source === undefined
      ? {
          id: 'src',
          title: 'Migrate the cache',
          teamId: null,
          teamSnapshot: null,
          reflectedThroughSeq: SEGMENT_FROM,
        }
      : options.source === null
        ? null
        : {
            id: 'src',
            title: 'Migrate the cache',
            teamId: null,
            teamSnapshot: null,
            ...options.source,
          };
  const reflection = {
    id: 'refl',
    agentKind: 'claude',
    model: 'opus',
  };
  const segment = {
    id: 'seg-1',
    runId: 'src',
    fromSeq: SEGMENT_FROM,
    toSeq: SEGMENT_TO,
    closedBy: options.closedBy ?? 'manual',
    leaseUntil: LEASE,
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
    seenEntries: vi.fn(() => Promise.resolve(options.seen ?? [])),
    markByReflection: vi.fn(() => Promise.resolve()),
    fileLesson: vi.fn(() =>
      Promise.resolve(
        options.saved ?? {
          kind: 'created',
          entry: { handle: 'm-new', status: 'active' },
        },
      ),
    ),
  };
  const projectScope = {
    projectOfRun: vi.fn(() => Promise.resolve(options.project ?? null)),
  };
  const knowledge = {
    list: vi.fn(() =>
      Promise.resolve({ documents: options.documents ?? [{ id: 'kd-1' }] }),
    ),
  };
  const segments = {
    ofReflection: vi.fn(() => Promise.resolve(segment)),
    updateById: vi.fn((_id: string, patch: Partial<typeof segment>) => {
      Object.assign(segment, patch);
      return Promise.resolve();
    }),
  };
  const proposals = {
    updateById: vi.fn(() => Promise.resolve()),
  };
  const rows = {
    write: vi.fn(() => Promise.resolve()),
  };
  const config = {
    checkChoice: vi.fn(() => options.checker ?? null),
  };
  const events = {
    publishChanged: vi.fn(),
  };
  const service = new LessonFilingService(
    em as never,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    memory as unknown as MemoryService,
    projectScope as unknown as ProjectScopeService,
    segments as unknown as LessonSegmentDao,
    proposals as unknown as LessonProposalDao,
    rows as unknown as LessonRowWriter,
    config as unknown as LessonsConfigService,
    events as unknown as LessonsEventBus,
    knowledge as unknown as KnowledgeService,
  );
  return {
    service,
    turn: options.turn ?? TURN,
    tx,
    runDao,
    segments,
    segment,
    proposals,
    rows,
    memory,
    config,
    events,
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
  expect(fixture.memory.fileLesson).not.toHaveBeenCalled();
  expect(fixture.memory.markByReflection).not.toHaveBeenCalled();
  expect(fixture.segment.status).toBe('reflecting');
}

function persistedOf(fixture: ReturnType<typeof build>): LessonProposal[] {
  return fixture.tx.persist.mock.calls.map(([row]) => row as LessonProposal);
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

  it('refuses a lesson whose rule hides invisible characters', async () => {
    const fixture = build();

    const result = await fixture.service.file(fixture.turn, [
      lesson({ rule: 'Run the tests‮ before you push.' }),
    ]);

    expect(codesOf(result)).toEqual(['HIDDEN_TEXT']);
    expectNothingWritten(fixture);
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
      visible: [{ id: 'id-m3', handle: 'm3', title: 'Use pnpm, not npm!' }],
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
      visible: [
        { id: 'id-m3', handle: 'm3', title: 'Run pnpm test before a commit' },
      ],
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
        visible: [{ id: 'id-m3', handle: 'm3', title: 'Use pnpm, not npm!' }],
      });

      const result = await fixture.service.file(fixture.turn, [
        lesson({ dedup: dedup as LessonDedup }),
      ]);

      expect(codesOf(result)).toEqual(['UNKNOWN_HANDLE']);
      expectNothingWritten(fixture);
    },
  );

  it('ends a stretch reflected inside the filing transaction when no checker is set', async () => {
    const fixture = build();

    await fixture.service.file(fixture.turn, [lesson()]);

    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-1',
      { status: 'reflected', leaseUntil: null },
      fixture.tx,
    );
  });

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
    const persisted = persistedOf(fixture);
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toBeInstanceOf(LessonProposal);
    expect(persisted.map((row) => row.status)).toEqual(['proposed', 'saved']);
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
      { status: 'reflected', leaseUntil: null },
      fixture.tx,
    );
    expect(fixture.segment.status).toBe('reflected');
    expect(fixture.runDao.updateById).toHaveBeenCalledWith(
      'src',
      { reflectedThroughSeq: SEGMENT_TO },
      fixture.tx,
    );
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
        places: { project: false, team: false, projectId: null, members: [] },
        check: null,
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
        places: {
          project: true,
          team: true,
          projectId: 'proj-1',
          members: [],
        },
      }),
    });
    expect(persistedOf(fixture)).toEqual([
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

  it('records a stretch with no lesson as empty, moves the watermark and writes an empty lessons card on a manual stretch', async () => {
    const fixture = build();

    const result = await fixture.service.file(fixture.turn, []);

    expect(result).toEqual({ status: 'recorded', count: 0 });
    expect(fixture.tx.persist).not.toHaveBeenCalled();
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-1',
      { status: 'empty', leaseUntil: null },
      fixture.tx,
    );
    expect(fixture.segment.status).toBe('empty');
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

  it('writes no card for an automatic stretch that found no lesson, and tells the thread it changed', async () => {
    const fixture = build({ closedBy: 'archive' });

    const result = await fixture.service.file(fixture.turn, []);

    expect(result).toEqual({ status: 'recorded', count: 0 });
    expect(fixture.segment.status).toBe('empty');
    expect(fixture.rows.write).not.toHaveBeenCalled();
    expect(fixture.events.publishChanged).toHaveBeenCalledWith('src');
  });

  it('files a memory-target lesson through fileLesson as a lesson write and records it saved by auto', async () => {
    const fixture = build();

    await fixture.service.file(fixture.turn, [
      lesson({
        target: { kind: 'memory', scope: 'global', type: 'feedback' },
      }),
    ]);

    expect(fixture.memory.fileLesson).toHaveBeenCalledWith(
      {
        kind: 'lesson',
        runId: 'refl',
        agentKind: 'claude',
        model: 'opus',
      },
      expect.objectContaining({
        title: lesson().title,
        type: 'feedback',
      }),
      { projectId: null, teamSlug: null },
      { sourceRunId: 'src', proposalId: persistedOf(fixture)[0]!.id },
    );
    expect(fixture.rows.write).toHaveBeenCalledWith('src', {
      kind: 'lesson_outcome',
      payload: expect.objectContaining({
        proposalId: persistedOf(fixture)[0]!.id,
        status: 'saved',
        by: 'auto',
        memoryHandle: 'm-new',
        resultRef: 'm-new',
      }),
    });
    expect(fixture.proposals.updateById).toHaveBeenCalledWith(
      persistedOf(fixture)[0]!.id,
      expect.objectContaining({ status: 'saved', resultRef: 'm-new' }),
      expect.anything(),
    );
  });

  it('records a lesson filed under agent writes pending as pending, not saved', async () => {
    const fixture = build({
      saved: {
        kind: 'created',
        entry: { handle: 'm-wait', status: 'pending' },
      },
    });

    await fixture.service.file(fixture.turn, [
      lesson({
        target: { kind: 'memory', scope: 'global', type: 'feedback' },
      }),
    ]);

    expect(fixture.rows.write).toHaveBeenCalledWith('src', {
      kind: 'lesson_outcome',
      payload: expect.objectContaining({
        status: 'pending',
        memoryHandle: 'm-wait',
      }),
    });
  });

  it('records a lesson that near-duplicates an entry as skipped_duplicate, naming the handle', async () => {
    const fixture = build({
      saved: {
        kind: 'near_duplicate',
        candidates: [{ handle: 'm3' }],
        pending: [],
      },
    });

    await fixture.service.file(fixture.turn, [
      lesson({
        target: { kind: 'memory', scope: 'global', type: 'feedback' },
      }),
    ]);

    expect(fixture.rows.write).toHaveBeenCalledWith('src', {
      kind: 'lesson_outcome',
      payload: expect.objectContaining({
        status: 'skipped_duplicate',
        memoryHandle: 'm3',
        reason: 'm3 already says this',
      }),
    });
    expect(fixture.proposals.updateById).toHaveBeenCalledWith(
      persistedOf(fixture)[0]!.id,
      expect.objectContaining({ status: 'skipped_duplicate', resultRef: 'm3' }),
      expect.anything(),
    );
  });

  it('holds the proposals as checking and starts the check instead of filing when a checker is set', async () => {
    const fixture = build({ checker: CHECKER });
    const starter = vi.fn(() => Promise.resolve());
    fixture.service.useCheck(starter);

    const result = await fixture.service.file(fixture.turn, [
      lesson({
        target: { kind: 'memory', scope: 'global', type: 'feedback' },
      }),
    ]);

    expect(result).toEqual({ status: 'recorded', count: 1 });
    expect(persistedOf(fixture).map((row) => row.status)).toEqual(['checking']);
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-1',
      { status: 'checking', leaseUntil: LEASE },
      fixture.tx,
    );
    expect(starter).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'seg-1', status: 'checking' }),
      [expect.objectContaining({ status: 'checking' })],
    );
    expect(fixture.memory.fileLesson).not.toHaveBeenCalled();
    expect(fixture.rows.write).not.toHaveBeenCalled();
  });

  it('files every lesson at once without a check when no checker is set, even with a check starter registered', async () => {
    const fixture = build();
    const starter = vi.fn(() => Promise.resolve());
    fixture.service.useCheck(starter);

    await fixture.service.file(fixture.turn, [
      lesson({
        target: { kind: 'memory', scope: 'global', type: 'feedback' },
      }),
    ]);

    expect(starter).not.toHaveBeenCalled();
    expect(fixture.memory.fileLesson).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['project instructions', { kind: 'project_instructions' }],
    ['a new knowledge document', { kind: 'knowledge', handle: null }],
    ['a team member', { kind: 'member_instructions', memberId: 'builder' }],
  ])(
    'records a lesson for %s as proposed, files no memory entry, and puts it on the card',
    async (_, target) => {
      const fixture = build({
        project: { id: 'proj-1' },
        source: {
          reflectedThroughSeq: SEGMENT_FROM,
          teamId: 'reviewers',
          teamSnapshot: TEAM_SNAPSHOT,
        },
      });

      const result = await fixture.service.file(fixture.turn, [
        lesson({ target: target as LessonTarget }),
      ]);

      expect(result).toEqual({ status: 'recorded', count: 1 });
      expect(persistedOf(fixture).map((row) => row.status)).toEqual([
        'proposed',
      ]);
      expect(fixture.memory.fileLesson).not.toHaveBeenCalled();
      expect(fixture.rows.write).toHaveBeenCalledTimes(1);
      expect(fixture.rows.write).toHaveBeenCalledWith('src', {
        kind: 'lessons',
        payload: expect.objectContaining({
          proposals: [expect.objectContaining({ target })],
        }),
      });
    },
  );

  it('stores the places the thread had on the proposal: its project and its team run members', async () => {
    const fixture = build({
      project: { id: 'proj-1' },
      source: {
        reflectedThroughSeq: SEGMENT_FROM,
        teamId: 'reviewers',
        teamSnapshot: TEAM_SNAPSHOT,
      },
    });

    await fixture.service.file(fixture.turn, [
      lesson({ target: { kind: 'project_instructions' } }),
    ]);

    expect(JSON.parse(persistedOf(fixture)[0]!.places!)).toEqual({
      project: true,
      team: true,
      projectId: 'proj-1',
      members: [
        { id: 'builder', name: 'builder' },
        { id: 'reviewer', name: 'reviewer' },
      ],
    });
  });

  it.each([
    [
      'project instructions on a thread with no project',
      { kind: 'project_instructions' },
      {
        source: {
          reflectedThroughSeq: SEGMENT_FROM,
          teamId: 'reviewers',
          teamSnapshot: TEAM_SNAPSHOT,
        },
      },
      'NO_PLACE_FOR_TARGET',
    ],
    [
      'a knowledge document on a thread with no project',
      { kind: 'knowledge', handle: null },
      { source: { reflectedThroughSeq: SEGMENT_FROM } },
      'NO_PLACE_FOR_TARGET',
    ],
    [
      'member instructions on a thread that is not a team run',
      { kind: 'member_instructions', memberId: 'builder' },
      { project: { id: 'proj-1' } },
      'NO_PLACE_FOR_TARGET',
    ],
    [
      'member instructions for a member the team run does not have',
      { kind: 'member_instructions', memberId: 'ghost' },
      {
        project: { id: 'proj-1' },
        source: {
          reflectedThroughSeq: SEGMENT_FROM,
          teamId: 'reviewers',
          teamSnapshot: TEAM_SNAPSHOT,
        },
      },
      'UNKNOWN_MEMBER',
    ],
    [
      'a knowledge document the project does not have',
      { kind: 'knowledge', handle: 'k-missing' },
      { project: { id: 'proj-1' }, documents: [] },
      'UNKNOWN_DOCUMENT',
    ],
  ])('refuses %s, writing nothing', async (_, target, options, code) => {
    const fixture = build(options);

    const result = await fixture.service.file(fixture.turn, [
      lesson({ target: target as LessonTarget }),
    ]);

    expect(codesOf(result)).toEqual([code]);
    expectNothingWritten(fixture);
  });

  it.each(['refines', 'broken_again'] as const)(
    'keeps a memory lesson that %s an entry as proposed, filing no entry for it, while a new lesson beside it is filed',
    async (verdict) => {
      const fixture = build({
        visible: [
          { id: 'id-m3', handle: 'm3', title: 'Run pnpm test before a commit' },
        ],
      });

      const result = await fixture.service.file(fixture.turn, [
        lesson({
          target: { kind: 'memory', scope: 'global', type: 'feedback' },
          dedup: { verdict, handle: 'm3' },
        }),
        lesson({
          title: 'Keep cache keys free of run ids',
          rule: 'Derive cache keys from content only, never from a run id.',
          evidence: { seq: 9, quote: 'cache key must not include the run id' },
          target: { kind: 'memory', scope: 'global', type: 'feedback' },
          dedup: { verdict: 'new', handle: null },
        }),
      ]);

      expect(result).toEqual({ status: 'recorded', count: 2 });
      expect(persistedOf(fixture).map((row) => row.status)).toEqual([
        'proposed',
        'saved',
      ]);
      expect(fixture.memory.fileLesson).toHaveBeenCalledTimes(1);
      expect(fixture.memory.fileLesson).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ title: 'Keep cache keys free of run ids' }),
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it('refuses a second filing of the same reflection, writing nothing more', async () => {
    const fixture = build();
    await fixture.service.file(fixture.turn, [lesson()]);

    const again = await fixture.service.file(fixture.turn, [lesson()]);

    expect(codesOf(again)).toEqual(['ALREADY_FILED']);
    expect(fixture.tx.persist).toHaveBeenCalledTimes(1);
    expect(fixture.rows.write).toHaveBeenCalledTimes(1);
  });

  it('records a followed effect on an entry the thread saw as a reflection mark, naming the thread and the reflection', async () => {
    const fixture = build({ visible: [SEEN_M3], seen: [SEEN_M3] });

    const result = await fixture.service.file(
      fixture.turn,
      [],
      [
        {
          handle: 'm3',
          effect: 'followed',
          seq: 6,
          reason: 'the agent ran pnpm as the rule says',
        },
      ],
    );

    expect(result).toEqual({ status: 'recorded', count: 0 });
    expect(fixture.memory.seenEntries).toHaveBeenCalledWith(
      'src',
      { projectId: null, teamSlug: null },
      1,
    );
    expect(fixture.memory.markByReflection).toHaveBeenCalledWith(
      { kind: 'lesson', runId: 'refl', agentKind: 'claude', model: 'opus' },
      'src',
      [
        {
          memoryId: 'id-m3',
          handle: 'm3',
          verdict: 'helped',
          reason: 'the agent ran pnpm as the rule says',
          evidenceSeq: 6,
        },
      ],
    );
  });

  it('maps a misled effect to a misleading mark and a broken one to broken, each on its own entry and row', async () => {
    const fixture = build({
      visible: [SEEN_M3, SEEN_M7],
      seen: [SEEN_M3, SEEN_M7],
    });

    await fixture.service.file(
      fixture.turn,
      [],
      [
        {
          handle: 'm3',
          effect: 'misled',
          seq: 6,
          reason: 'following it led to the wrong command',
        },
        {
          handle: 'm7',
          effect: 'broken',
          seq: 9,
          reason: 'the agent hard-coded the port it says not to',
        },
      ],
    );

    expect(fixture.memory.markByReflection).toHaveBeenCalledWith(
      { kind: 'lesson', runId: 'refl', agentKind: 'claude', model: 'opus' },
      'src',
      [
        {
          memoryId: 'id-m3',
          handle: 'm3',
          verdict: 'misleading',
          reason: 'following it led to the wrong command',
          evidenceSeq: 6,
        },
        {
          memoryId: 'id-m7',
          handle: 'm7',
          verdict: 'broken',
          reason: 'the agent hard-coded the port it says not to',
          evidenceSeq: 9,
        },
      ],
    );
  });

  it('refuses an effect on an entry the thread’s agents never had in front of them, filing and recording nothing', async () => {
    const fixture = build({ visible: [SEEN_M3], seen: [] });

    const result = await fixture.service.file(
      fixture.turn,
      [lesson()],
      [
        {
          handle: 'm3',
          effect: 'followed',
          seq: 6,
          reason: 'the agent ran pnpm',
        },
      ],
    );

    expect(codesOf(result)).toEqual(['NOT_SEEN']);
    expectNothingWritten(fixture);
  });

  it.each([4, 10])(
    'refuses an effect whose row %i is outside the reflection’s stretch, recording nothing',
    async (seq) => {
      const fixture = build({ visible: [SEEN_M3], seen: [SEEN_M3] });

      const result = await fixture.service.file(
        fixture.turn,
        [],
        [
          {
            handle: 'm3',
            effect: 'followed',
            seq,
            reason: 'the agent ran pnpm',
          },
        ],
      );

      expect(codesOf(result)).toEqual(['EVIDENCE_OUT_OF_SEGMENT']);
      expectNothingWritten(fixture);
    },
  );

  it('refuses more than ten effects, recording nothing', async () => {
    const fixture = build({ visible: [SEEN_M3], seen: [SEEN_M3] });
    const effects = Array.from({ length: 11 }, () => ({
      handle: 'm3',
      effect: 'followed' as const,
      seq: 6,
      reason: 'the agent ran pnpm',
    }));

    const result = await fixture.service.file(fixture.turn, [], effects);

    expect(codesOf(result)).toEqual(['TOO_MANY']);
    expectNothingWritten(fixture);
  });

  it('records the marks of its effects even when the reflection files no lesson', async () => {
    const fixture = build({ visible: [SEEN_M3], seen: [SEEN_M3] });

    const result = await fixture.service.file(
      fixture.turn,
      [],
      [
        {
          handle: 'm3',
          effect: 'followed',
          seq: 6,
          reason: 'the agent ran pnpm as the rule says',
        },
      ],
    );

    expect(result).toEqual({ status: 'recorded', count: 0 });
    expect(fixture.segment.status).toBe('empty');
    expect(fixture.memory.markByReflection).toHaveBeenCalledWith(
      { kind: 'lesson', runId: 'refl', agentKind: 'claude', model: 'opus' },
      'src',
      [
        {
          memoryId: 'id-m3',
          handle: 'm3',
          verdict: 'helped',
          reason: 'the agent ran pnpm as the rule says',
          evidenceSeq: 6,
        },
      ],
    );
  });
  it('still records the stretch when writing its marks fails, so the filing is never stranded', async () => {
    const fixture = build({ visible: [SEEN_M3], seen: [SEEN_M3] });
    fixture.memory.markByReflection.mockImplementationOnce(() =>
      Promise.reject(new Error('database is locked')),
    );

    const result = await fixture.service.file(
      fixture.turn,
      [],
      [
        {
          handle: 'm3',
          effect: 'misled',
          seq: 6,
          reason: 'the stale flag sent the agent wrong',
        },
      ],
    );

    expect(result).toEqual({ status: 'recorded', count: 0 });
    expect(fixture.segment.status).toBe('empty');
    expect(fixture.memory.markByReflection).toHaveBeenCalledTimes(1);
  });
});
