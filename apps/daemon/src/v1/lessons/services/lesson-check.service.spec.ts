import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnalysisTurn, RunStatusEvent } from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import type { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ChatService } from '../../agents/services/chat.service';
import type { MemoryService } from '../../memory/services/memory.service';
import type { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Run } from '../../runs/entity/run.entity';
import type { LessonProposalDao } from '../dao/lesson-proposal.dao';
import type { LessonSegmentDao } from '../dao/lesson-segment.dao';
import type { LessonProposal } from '../entity/lesson-proposal.entity';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import {
  type CheckLessonsCall,
  DEFAULT_LESSONS_CONFIG,
  LESSON_CHECK_REASON_MAX_CHARS,
  LESSON_RULE_MAX_CHARS,
  LESSON_SEGMENT_MAX_ATTEMPTS,
  LESSON_TITLE_MAX_CHARS,
  type LessonModelChoice,
} from '../lessons.types';
import { LessonCheckService } from './lesson-check.service';
import type { LessonFilingService } from './lesson-filing.service';
import { LessonsConfigService } from './lessons-config.service';
import { LessonsEventBus } from './lessons-events.bus';

const CHECKER: LessonModelChoice = {
  agent: 'codex',
  configDir: '/profiles/codex-b',
  model: 'gpt-judge',
  effort: 'high',
  contextWindow: null,
  modelParameters: {},
};

const TURN: AnalysisTurn = {
  analysisRunId: 'chk',
  sourceRunId: 'src',
  snapshotSeq: 9,
  sourceWorking: false,
  purpose: 'lessons_check',
};

function runOf(overrides: Partial<Run>): Run {
  return {
    id: 'src',
    title: 'Migrate the cache',
    teamId: null,
    projectId: null,
    projectSource: 'none',
    cwd: null,
    status: 'completed',
    agentKind: 'claude',
    model: null,
    configDir: null,
    analysisSourceRunId: null,
    analysisTeamSlug: null,
    editsTeamSlug: null,
    editsProjectId: null,
    reflectedThroughSeq: null,
    pendingDeleteAt: null,
    archivedAt: null,
    ...overrides,
  } as unknown as Run;
}

function segmentOf(overrides: Record<string, unknown> = {}): LessonSegment {
  return {
    id: 'seg-1',
    runId: 'src',
    fromSeq: 2,
    toSeq: 9,
    status: 'checking',
    reflectionRunId: 'refl',
    checkRunId: 'chk',
    ...overrides,
  } as unknown as LessonSegment;
}

function proposalOf(
  id: string,
  overrides: Record<string, unknown> = {},
): LessonProposal {
  return {
    id,
    reflectionRunId: 'refl',
    title: `Title ${id}`,
    rule: `Rule ${id}`,
    why: `Why ${id}`,
    signalKind: 'user_correction',
    evidenceSeq: 5,
    evidenceQuote: `quote of ${id}`,
    target: JSON.stringify({ scope: 'project', type: 'feedback' }),
    dedup: 'new',
    status: 'checking',
    checkRunId: null,
    checkVerdict: null,
    checkReason: null,
    decidedAt: null,
    ...overrides,
  } as unknown as LessonProposal;
}

function build(
  options: {
    checker?: LessonModelChoice | null;
    source?: Partial<Run> | null;
    rows?: LessonProposal[];
    segment?: LessonSegment | null;
    project?: { id: string; folder: string } | null;
    createFails?: Error;
    sendFails?: Error;
  } = {},
) {
  const rows = options.rows ?? [proposalOf('p1'), proposalOf('p2')];
  const source = options.source === null ? null : runOf(options.source ?? {});
  const flush = vi.fn(() => Promise.resolve());
  const em = { fork: () => em, flush } as unknown as EntityManager;
  const runDao = {
    getById: vi.fn((id: string) =>
      Promise.resolve(
        id === 'chk'
          ? runOf({
              id: 'chk',
              agentKind: 'codex',
              model: 'gpt-judge',
            } as Partial<Run>)
          : source,
      ),
    ),
  };
  const itemDao = { getByRun: vi.fn(() => Promise.resolve([])) };
  const chats = {
    createChat: vi.fn((_input: Record<string, unknown>) =>
      options.createFails === undefined
        ? Promise.resolve({ id: 'chk' })
        : Promise.reject(options.createFails),
    ),
    sendMessage: vi.fn((_runId: string, _brief: string) =>
      options.sendFails === undefined
        ? Promise.resolve({})
        : Promise.reject(options.sendFails),
    ),
    delete: vi.fn((_runId: string) => Promise.resolve({ deleted: true })),
    cancel: vi.fn((_runId: string) => Promise.resolve()),
  };
  const segments = {
    updateById: vi.fn(
      (_id: string, _patch: Record<string, unknown>, _em: unknown) =>
        Promise.resolve(),
    ),
    ofCheck: vi.fn(() =>
      Promise.resolve(
        options.segment === undefined ? segmentOf() : options.segment,
      ),
    ),
  };
  const proposals = {
    updateById: vi.fn(
      (_id: string, _patch: Record<string, unknown>, _em: unknown) =>
        Promise.resolve(),
    ),
    ofReflection: vi.fn(() => Promise.resolve(rows)),
  };
  const filing = {
    useCheck: vi.fn(() => () => undefined),
    deliver: vi.fn(
      (
        _segment: LessonSegment,
        _rows: readonly LessonProposal[],
        _check: unknown,
      ) => Promise.resolve(),
    ),
    deliverUnchecked: vi.fn(
      (
        _segment: LessonSegment,
        _rows: readonly LessonProposal[],
        _check: unknown,
        _reason: string,
      ) => Promise.resolve(),
    ),
  };
  const statuses = new Subject<RunStatusEvent>();
  const config = new LessonsConfigService();
  config.set({
    ...DEFAULT_LESSONS_CONFIG,
    checker: options.checker === undefined ? CHECKER : options.checker,
  });
  const service = new LessonCheckService(
    em,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    chats as unknown as ChatService,
    { allStatuses: () => statuses.asObservable() } as unknown as AgentEventBus,
    { enabled: true } as MemoryService,
    {
      projectOfRun: vi.fn(() => Promise.resolve(options.project ?? null)),
    } as unknown as ProjectScopeService,
    segments as unknown as LessonSegmentDao,
    proposals as unknown as LessonProposalDao,
    filing as unknown as LessonFilingService,
    config,
    new LessonsEventBus(),
  );
  return { service, rows, chats, segments, proposals, filing, statuses, flush };
}

function verdicts(...list: CheckLessonsCall['verdicts']): CheckLessonsCall {
  return { verdicts: list };
}

function refusalCodes(outcome: {
  status: string;
  problems?: { code: string }[];
}) {
  return outcome.status === 'refused'
    ? outcome.problems!.map((problem) => problem.code)
    : [];
}

describe('LessonCheckService.start', () => {
  let folder: string;

  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'lessons-check-')));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('delivers the lessons at once and starts no check chat while the check is off', async () => {
    const { service, rows, chats, filing } = build({ checker: null });

    await service.start(segmentOf({ status: 'reflecting' }), rows);

    expect(chats.createChat).not.toHaveBeenCalled();
    expect(filing.deliver).toHaveBeenCalledTimes(1);
    expect(filing.deliver.mock.calls[0]![1]).toBe(rows);
    expect(filing.deliver.mock.calls[0]![2]).toBeNull();
  });

  it('starts no check chat when there is no lesson to check', async () => {
    const { service, chats, filing } = build({ rows: [] });

    await service.start(segmentOf(), []);

    expect(chats.createChat).not.toHaveBeenCalled();
    expect(filing.deliver).toHaveBeenCalledTimes(1);
  });

  it('starts a hidden lessons_check chat on the checker model, effort and profile', async () => {
    const { service, rows, chats, segments, proposals } = build({
      source: { cwd: folder },
    });

    await service.start(
      segmentOf({ status: 'reflecting', checkRunId: null }),
      rows,
    );

    expect(chats.createChat).toHaveBeenCalledTimes(1);
    const input = chats.createChat.mock.calls[0]![0];
    expect(input).toMatchObject({
      agentKind: 'codex',
      model: 'gpt-judge',
      effort: 'high',
      configDir: '/profiles/codex-b',
      cwd: folder,
      analysisSource: {
        runId: 'src',
        seq: 9,
        working: false,
        purpose: 'lessons_check',
      },
    });
    expect(segments.updateById.mock.calls[0]![1]).toMatchObject({
      status: 'checking',
      checkRunId: 'chk',
    });
    expect(proposals.updateById.mock.calls.map((call) => call[0])).toEqual([
      'p1',
      'p2',
    ]);
    expect(proposals.updateById.mock.calls[0]![1]).toEqual({
      checkRunId: 'chk',
    });
  });

  it('briefs the check with every lesson it must judge and its evidence', async () => {
    const { service, rows, chats } = build({ source: { cwd: folder } });

    await service.start(segmentOf(), rows);

    expect(chats.sendMessage).toHaveBeenCalledTimes(1);
    const [runId, brief] = chats.sendMessage.mock.calls[0]!;
    expect(runId).toBe('chk');
    for (const id of ['p1', 'p2']) {
      expect(brief).toContain(`id ${id}`);
      expect(brief).toContain(`quote of ${id}`);
      expect(brief).toContain(`Rule ${id}`);
    }
  });

  it('counts a chat that cannot be created as a failed attempt and tries again', async () => {
    const { service, rows, chats, filing } = build({
      source: { cwd: folder },
      createFails: new Error('profile signed out'),
    });

    await service.start(segmentOf(), rows);

    expect(chats.createChat).toHaveBeenCalledTimes(LESSON_SEGMENT_MAX_ATTEMPTS);
    expect(filing.deliverUnchecked).toHaveBeenCalledTimes(1);
    expect(filing.deliverUnchecked.mock.calls[0]![3]).toBe(
      'check: profile signed out',
    );
    expect(filing.deliver).not.toHaveBeenCalled();
  });

  it('deletes a check chat whose brief cannot be sent, and counts the attempt', async () => {
    const { service, rows, chats, filing } = build({
      source: { cwd: folder },
      sendFails: new Error('adapter down'),
    });

    await service.start(segmentOf(), rows);

    expect(chats.delete).toHaveBeenCalledTimes(LESSON_SEGMENT_MAX_ATTEMPTS);
    expect(filing.deliverUnchecked.mock.calls[0]![3]).toBe(
      'check: adapter down',
    );
  });
});

describe('LessonCheckService.file', () => {
  it('delivers kept lessons unchanged, with the check the card names', async () => {
    const { service, rows, filing, flush } = build();

    const outcome = await service.file(
      TURN,
      verdicts(
        { proposalId: 'p1', verdict: 'keep', reason: 'Passes.' },
        { proposalId: 'p2', verdict: 'keep', reason: ' Also passes. ' },
      ),
    );

    expect(outcome).toEqual({ status: 'recorded', kept: 2, dropped: 0 });
    expect(flush).toHaveBeenCalled();
    expect(
      rows.map((row) => [row.title, row.status, row.checkVerdict]),
    ).toEqual([
      ['Title p1', 'checking', 'keep'],
      ['Title p2', 'checking', 'keep'],
    ]);
    expect(rows[1]!.checkReason).toBe('Also passes.');
    expect(filing.deliver).toHaveBeenCalledTimes(1);
    expect(filing.deliver.mock.calls[0]![1]).toEqual(rows);
    expect(filing.deliver.mock.calls[0]![2]).toEqual({
      runId: 'chk',
      agentKind: 'codex',
      model: 'gpt-judge',
    });
  });

  it('replaces the title and rule of a rewrite and keeps its evidence', async () => {
    const { service, rows, filing } = build({ rows: [proposalOf('p1')] });

    const outcome = await service.file(
      TURN,
      verdicts({
        proposalId: 'p1',
        verdict: 'rewrite',
        reason: 'Too vague.',
        rewrite: { title: '  New title ', rule: ' New rule. ' },
      }),
    );

    expect(outcome).toEqual({ status: 'recorded', kept: 1, dropped: 0 });
    expect(rows[0]).toMatchObject({
      title: 'New title',
      rule: 'New rule.',
      why: 'Why p1',
      evidenceSeq: 5,
      evidenceQuote: 'quote of p1',
      checkVerdict: 'rewrite',
      status: 'checking',
    });
    expect(filing.deliver.mock.calls[0]![1][0]).toBe(rows[0]);
  });

  it('turns a drop into dropped_by_check with its reason and counts it apart', async () => {
    const { service, rows, filing } = build();

    const outcome = await service.file(
      TURN,
      verdicts(
        { proposalId: 'p1', verdict: 'keep', reason: 'Passes.' },
        { proposalId: 'p2', verdict: 'drop', reason: ' One-off fix. ' },
      ),
    );

    expect(outcome).toEqual({ status: 'recorded', kept: 1, dropped: 1 });
    expect(rows[1]).toMatchObject({
      status: 'dropped_by_check',
      checkVerdict: 'drop',
      checkReason: 'One-off fix.',
    });
    expect(rows[1]!.decidedAt).toBeInstanceOf(Date);
    expect(rows[0]!.status).toBe('checking');
    expect(filing.deliver).toHaveBeenCalledTimes(1);
  });

  it('needs no verdict for a lesson that is no longer under check', async () => {
    const { service, filing } = build({
      rows: [proposalOf('p1'), proposalOf('p2', { status: 'saved' })],
    });

    const outcome = await service.file(
      TURN,
      verdicts({ proposalId: 'p1', verdict: 'keep', reason: 'Passes.' }),
    );

    expect(outcome).toEqual({ status: 'recorded', kept: 1, dropped: 0 });
    expect(filing.deliver).toHaveBeenCalledTimes(1);
  });

  describe('refusals record nothing and deliver nothing', () => {
    async function refused(
      call: CheckLessonsCall,
      options: Parameters<typeof build>[0] = {},
    ) {
      const built = build(options);
      const outcome = await built.service.file(TURN, call);
      expect(outcome.status).toBe('refused');
      expect(built.filing.deliver).not.toHaveBeenCalled();
      expect(built.flush).not.toHaveBeenCalled();
      expect(built.rows.every((row) => row.checkVerdict === null)).toBe(true);
      return outcome;
    }

    const KEEP_P1 = {
      proposalId: 'p1',
      verdict: 'keep',
      reason: 'ok',
    } as const;
    const KEEP_P2 = {
      proposalId: 'p2',
      verdict: 'keep',
      reason: 'ok',
    } as const;

    it('UNKNOWN_LESSON for an id the brief did not list', async () => {
      const outcome = await refused(
        verdicts(KEEP_P1, KEEP_P2, { ...KEEP_P1, proposalId: 'ghost' }),
      );

      expect(refusalCodes(outcome)).toEqual(['UNKNOWN_LESSON']);
      expect(JSON.stringify(outcome)).toContain('verdicts[2]: ghost');
    });

    it('MISSING_VERDICT for a lesson with no verdict', async () => {
      const outcome = await refused(verdicts(KEEP_P1));

      expect(refusalCodes(outcome)).toEqual(['MISSING_VERDICT']);
      expect(JSON.stringify(outcome)).toContain('no verdict for p2');
    });

    it('DUPLICATE_VERDICT for a lesson judged twice', async () => {
      const outcome = await refused(verdicts(KEEP_P1, KEEP_P1, KEEP_P2));

      expect(refusalCodes(outcome)).toEqual(['DUPLICATE_VERDICT']);
    });

    it('REWRITE_MISMATCH for a rewrite verdict without a rewrite', async () => {
      const outcome = await refused(
        verdicts({ ...KEEP_P1, verdict: 'rewrite' }, KEEP_P2),
      );

      expect(refusalCodes(outcome)).toEqual(['REWRITE_MISMATCH']);
    });

    it('REWRITE_MISMATCH for a rewrite sent with another verdict', async () => {
      const outcome = await refused(
        verdicts({ ...KEEP_P1, rewrite: { title: 't', rule: 'r' } }, KEEP_P2),
      );

      expect(refusalCodes(outcome)).toEqual(['REWRITE_MISMATCH']);
    });

    it('TOO_LONG for a reason, a rewritten title and a rewritten rule over their caps', async () => {
      const outcome = await refused(
        verdicts(
          {
            proposalId: 'p1',
            verdict: 'rewrite',
            reason: 'r'.repeat(LESSON_CHECK_REASON_MAX_CHARS + 1),
            rewrite: {
              title: 't'.repeat(LESSON_TITLE_MAX_CHARS + 1),
              rule: 'u'.repeat(LESSON_RULE_MAX_CHARS + 1),
            },
          },
          KEEP_P2,
        ),
      );

      expect(refusalCodes(outcome)).toEqual([
        'TOO_LONG',
        'TOO_LONG',
        'TOO_LONG',
      ]);
      const text = JSON.stringify(outcome);
      expect(text).toContain('reason is over');
      expect(text).toContain('rewrite.title is over');
      expect(text).toContain('rewrite.rule is over');
    });

    it('accepts texts exactly at their caps', async () => {
      const { service } = build({ rows: [proposalOf('p1')] });

      const outcome = await service.file(
        TURN,
        verdicts({
          proposalId: 'p1',
          verdict: 'rewrite',
          reason: 'r'.repeat(LESSON_CHECK_REASON_MAX_CHARS),
          rewrite: {
            title: 't'.repeat(LESSON_TITLE_MAX_CHARS),
            rule: 'u'.repeat(LESSON_RULE_MAX_CHARS),
          },
        }),
      );

      expect(outcome.status).toBe('recorded');
    });

    it('NOT_A_CHECK for a turn that is not a lessons check', async () => {
      const { service, filing } = build();

      const outcome = await service.file(
        { ...TURN, purpose: 'lessons' },
        verdicts(KEEP_P1, KEEP_P2),
      );

      expect(refusalCodes(outcome)).toEqual(['NOT_A_CHECK']);
      expect(filing.deliver).not.toHaveBeenCalled();
    });

    it('NOT_A_CHECK for a check started on no reflection', async () => {
      const { service } = build({ segment: null });

      const outcome = await service.file(TURN, verdicts(KEEP_P1, KEEP_P2));

      expect(refusalCodes(outcome)).toEqual(['NOT_A_CHECK']);
    });

    it('ALREADY_CHECKED once the stretch is past checking', async () => {
      const { service, filing } = build({
        segment: segmentOf({ status: 'reflected' }),
      });

      const outcome = await service.file(TURN, verdicts(KEEP_P1, KEEP_P2));

      expect(refusalCodes(outcome)).toEqual(['ALREADY_CHECKED']);
      expect(filing.deliver).not.toHaveBeenCalled();
    });
  });
});

describe('LessonCheckService check runs that settle without verdicts', () => {
  it('starts the check again, up to the attempt limit, then delivers the lessons unchecked', async () => {
    const built = build({ source: { cwd: realpathSync(tmpdir()) } });
    built.service.onModuleInit();
    await built.service.start(segmentOf(), built.rows);
    expect(built.chats.createChat).toHaveBeenCalledTimes(1);

    built.statuses.next({
      runId: 'chk',
      status: 'completed',
    } as RunStatusEvent);
    await vi.waitFor(() =>
      expect(built.chats.createChat).toHaveBeenCalledTimes(2),
    );
    expect(built.filing.deliverUnchecked).not.toHaveBeenCalled();

    built.statuses.next({
      runId: 'chk',
      status: 'completed',
    } as RunStatusEvent);
    await vi.waitFor(() =>
      expect(built.chats.createChat).toHaveBeenCalledTimes(
        LESSON_SEGMENT_MAX_ATTEMPTS,
      ),
    );
    expect(built.filing.deliverUnchecked).not.toHaveBeenCalled();

    built.statuses.next({
      runId: 'chk',
      status: 'completed',
    } as RunStatusEvent);
    await vi.waitFor(() =>
      expect(built.filing.deliverUnchecked).toHaveBeenCalledTimes(1),
    );
    expect(built.chats.createChat).toHaveBeenCalledTimes(
      LESSON_SEGMENT_MAX_ATTEMPTS,
    );
    const [, rows, check, reason] =
      built.filing.deliverUnchecked.mock.calls[0]!;
    expect(rows).toEqual(built.rows);
    expect(check).toEqual({
      runId: 'chk',
      agentKind: 'codex',
      model: 'gpt-judge',
    });
    expect(reason).toBe('check: the check ended without its verdicts');
    expect(built.filing.deliver).not.toHaveBeenCalled();
    built.service.onModuleDestroy();
  });

  it('ignores a run that is not a check still waiting for its verdicts', async () => {
    const built = build({ segment: segmentOf({ status: 'reflected' }) });
    built.service.onModuleInit();

    built.statuses.next({
      runId: 'chk',
      status: 'completed',
    } as RunStatusEvent);
    await vi.waitFor(() => expect(built.segments.ofCheck).toHaveBeenCalled());
    await Promise.resolve();

    expect(built.chats.createChat).not.toHaveBeenCalled();
    expect(built.filing.deliverUnchecked).not.toHaveBeenCalled();
    built.service.onModuleDestroy();
  });

  it('registers itself with the filing service and unregisters on destroy', () => {
    const built = build();
    const release = vi.fn();
    built.filing.useCheck.mockReturnValue(release);

    built.service.onModuleInit();
    expect(built.filing.useCheck).toHaveBeenCalledTimes(1);
    built.service.onModuleDestroy();

    expect(release).toHaveBeenCalledTimes(1);
  });
});
