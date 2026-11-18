import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import type {
  ItemWire,
  MemberAssessment,
  RecommendationMarks,
  RecommendationsPayload,
} from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { Run } from '../../runs/entity/run.entity';
import { member, teamOf } from '../../teams/__tests__/team-builders';
import type { TeamStoreService } from '../../teams/services/team-store.service';
import type { Team } from '../../teams/teams.types';
import { teamVersionOf } from '../../teams/utils/team-version';
import { MemberAssessmentDao } from '../dao/member-assessment.dao';
import { TeamRecommendationDao } from '../dao/team-recommendation.dao';
import { MemberAssessmentRecord } from '../entity/member-assessment.entity';
import { TeamRecommendation } from '../entity/team-recommendation.entity';
import { filedRecommendationsOf } from '../utils/recommendation-ledger';
import { RecommendationLedgerService } from './recommendation-ledger.service';

const LIBRARY: Team = teamOf([member('dev')], { name: 'Dev Team' });

function card(ids: string[]): RecommendationsPayload {
  return {
    sourceRunId: 'newest',
    sourceKind: 'team',
    timing: null,
    items: ids.map((id) => ({
      id,
      target: id.startsWith('W-') ? 'team' : 'repo',
      territory: 'process',
      kind: 'model',
      location: 'dev',
      title: `Title of ${id}`,
      change: `change for ${id}`,
      evidence: [{ runId: 'newest', seq: 4, quote: 'slow' }],
      rootCause: 'the reviewer runs the largest model',
      impact:
        id === 'W-1'
          ? {
              minutesSaved: 4,
              costSavedUsd: 0.6,
              basis: 'turn spans',
              confidence: 3,
              outcome: 'reviewer 9m → 5m per run',
            }
          : { minutesSaved: 4, basis: 'turn spans', confidence: 3 },
      risk: { level: 'low', note: 'none' },
    })),
  };
}

const DEV: MemberAssessment = {
  member: 'dev',
  usefulness: 4,
  quality: 2,
  verdict: 'reconfigure',
  summary: 'Carries every run, but its patches come back from review twice',
  evidence: [{ runId: 'newest', seq: 4, quote: 'slow' }],
  items: ['W-1'],
};

function assessedCard(
  ids: string[],
  members: MemberAssessment[],
): RecommendationsPayload {
  return { ...card(ids), members };
}

type ChatRun = Pick<
  Run,
  'id' | 'analysisTeamSlug' | 'editsTeamSlug' | 'analysisSourceRunId'
> &
  Partial<Pick<Run, 'teamId' | 'agentKind' | 'model'>>;

interface StoredRow {
  seq: number;
  kind: string;
  role: string | null;
  createdAt: Date;
  payload: string;
}

/**
 * The copy of a team chat's recommendations — the cards, the Applies and the
 * marks — into the ledger that outlives the chat, live off a real bus and by the
 * boot sweep, through the real DAO.
 */
describe('RecommendationLedgerService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: TeamRecommendationDao;
  let assessments: MemberAssessmentDao;
  let bus: AgentEventBus;
  let chats: Map<string, ChatRun>;
  let stored: Map<string, StoredRow[]>;
  let service: RecommendationLedgerService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [TeamRecommendation, MemberAssessmentRecord],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    dao = new TeamRecommendationDao(orm.em.fork());
    assessments = new MemberAssessmentDao(orm.em.fork());
    bus = new AgentEventBus();
    const chat = (
      id: string,
      fields: Partial<ChatRun> = {},
    ): [string, ChatRun] => [
      id,
      {
        id,
        analysisTeamSlug: null,
        editsTeamSlug: null,
        analysisSourceRunId: null,
        ...fields,
      },
    ];
    chats = new Map([
      chat('analysis-1', {
        analysisTeamSlug: 'dev-team',
        agentKind: 'codex',
        model: 'gpt-6.1-sol',
      }),
      chat('builder-1', { editsTeamSlug: 'dev-team' }),
      chat('plain-chat'),
      chat('team-run', { teamId: 'dev-team' }),
      chat('thread-analysis', { analysisSourceRunId: 'team-run' }),
      chat('chat-analysis', { analysisSourceRunId: 'plain-chat' }),
    ]);
    stored = new Map();
    service = new RecommendationLedgerService(
      orm.em,
      bus,
      {
        getById: (id: string) => Promise.resolve(chats.get(id) ?? null),
        teamLedgerChats: () =>
          Promise.resolve(
            [...chats.values()].filter(
              (chat) =>
                chat.analysisTeamSlug !== null ||
                chat.editsTeamSlug !== null ||
                chat.analysisSourceRunId !== null,
            ),
          ),
      } as unknown as RunDao,
      {
        rowsOfKinds: (runId: string) =>
          Promise.resolve(
            (stored.get(runId) ?? []).filter((row) => row.kind !== 'message'),
          ),
        userMessagesInOrder: (runId: string) =>
          Promise.resolve(
            (stored.get(runId) ?? []).filter((row) => row.kind === 'message'),
          ),
      } as unknown as ItemDao,
      dao,
      assessments,
      {
        get: () => Promise.resolve({ slug: 'dev-team', team: LIBRARY }),
      } as unknown as TeamStoreService,
    );
  });

  function publish(
    runId: string,
    seq: number,
    kind: ItemWire['kind'],
    payload: unknown,
    role: string | null = null,
    at = `2026-10-20T10:00:${String(seq).padStart(2, '0')}.000Z`,
  ): void {
    bus.publish({
      runId,
      item: {
        id: `${runId}-${seq}`,
        runId,
        memberId: null,
        seq,
        kind,
        role,
        payload,
        createdAt: at,
        inCall: null,
      } as ItemWire,
    });
  }

  describe('live', () => {
    beforeEach(() => {
      service.onModuleInit();
    });

    it("files a team analysis's card with the library's version, then what the user selected and how each item was marked", async () => {
      publish('analysis-1', 5, 'recommendations', card(['W-1', 'W-2', 'R-1']));
      publish(
        'analysis-1',
        7,
        'message',
        { text: 'apply', apply: { cardSeq: 5, ids: ['W-1', 'R-1'] } },
        'user',
      );
      const marks: RecommendationMarks = {
        cardSeq: 5,
        outcomes: [
          { id: 'W-1', status: 'applied', backup: '.backups/x.yaml' },
          { id: 'R-1', status: 'failed', note: 'the file moved' },
        ],
      };
      publish('analysis-1', 9, 'recommendation_outcome', marks);
      await service.settled();

      const rows = await dao.rowsOf('dev-team');
      expect(
        rows.map((row) => [
          row.itemId,
          row.selectedAt !== null,
          row.outcome,
          row.outcomeNote,
        ]),
      ).toEqual([
        ['W-1', true, 'applied', null],
        ['W-2', false, null, null],
        ['R-1', true, 'failed', 'the file moved'],
      ]);
      expect(rows[0]).toMatchObject({
        chatRunId: 'analysis-1',
        chatKind: 'analysis',
        cardSeq: 5,
        filedAt: new Date('2026-10-20T10:00:05.000Z'),
        libraryVersion: teamVersionOf(LIBRARY),
        title: 'Title of W-1',
        change: 'change for W-1',
        rootCause: 'the reviewer runs the largest model',
        minutesSaved: 4,
        costSavedUsd: 0.6,
        expectedOutcome: 'reviewer 9m → 5m per run',
        confidence: 3,
        risk: 'low',
        outcomeSeq: 9,
      });
      expect(rows[1]).toMatchObject({
        costSavedUsd: null,
        expectedOutcome: null,
      });
    });

    it("files a builder chat's card under the team it edits", async () => {
      publish('builder-1', 3, 'recommendations', card(['W-1']));
      await service.settled();

      expect(await dao.rowsOf('dev-team')).toEqual([
        expect.objectContaining({
          chatRunId: 'builder-1',
          chatKind: 'builder',
        }),
      ]);
    });

    it('files nothing for a chat that is not about a team, nor for a message that applies nothing', async () => {
      publish('plain-chat', 3, 'recommendations', card(['R-1']));
      publish('analysis-1', 4, 'message', { text: 'thanks' }, 'user');
      await service.settled();

      expect(await dao.rowsOf('dev-team')).toEqual([]);
    });

    it("files a team analysis's member assessments with the runs it read and the titles of the items that carry them out", async () => {
      publish(
        'analysis-1',
        5,
        'recommendations',
        assessedCard(
          ['W-1', 'R-1'],
          [DEV, { ...DEV, member: 'qa', verdict: 'keep', items: [] }],
        ),
      );
      await service.settled();

      expect(await assessments.rowsOf('dev-team')).toEqual([
        {
          slug: 'dev-team',
          chatRunId: 'analysis-1',
          chatKind: 'analysis',
          cardSeq: 5,
          filedAt: new Date('2026-10-20T10:00:05.000Z'),
          libraryVersion: teamVersionOf(LIBRARY),
          runs: 1,
          runIds: ['newest'],
          memberId: 'dev',
          usefulness: 4,
          quality: 2,
          verdict: 'reconfigure',
          summary: DEV.summary,
          evidence: DEV.evidence,
          items: [{ id: 'W-1', title: 'Title of W-1' }],
          judge: { agent: 'codex', model: 'gpt-6.1-sol' },
          userVerdict: null,
        },
        expect.objectContaining({ memberId: 'qa', verdict: 'keep', items: [] }),
      ]);
    });

    it("files a thread analysis's assessments under the team its source run ran, and none of its items", async () => {
      publish(
        'thread-analysis',
        5,
        'recommendations',
        assessedCard(['W-1'], [DEV]),
      );
      publish(
        'thread-analysis',
        7,
        'message',
        { text: 'apply', apply: { cardSeq: 5, ids: ['W-1'] } },
        'user',
      );
      publish('chat-analysis', 3, 'recommendations', assessedCard(['R-1'], []));
      await service.settled();

      expect(await assessments.rowsOf('dev-team')).toEqual([
        expect.objectContaining({
          chatRunId: 'thread-analysis',
          chatKind: 'thread',
          runs: 1,
          memberId: 'dev',
        }),
      ]);
      expect(await dao.rowsOf('dev-team')).toEqual([]);
    });

    it('keeps the newest mark of an item whichever order two marks arrive in', async () => {
      publish('analysis-1', 5, 'recommendations', card(['W-1']));
      await service.settled();
      await dao.markOutcome(
        'analysis-1',
        5,
        { itemId: 'W-1', outcome: 'applied', note: null },
        { seq: 12, at: new Date('2026-10-20T11:00:00.000Z') },
      );

      publish('analysis-1', 9, 'recommendation_outcome', {
        cardSeq: 5,
        outcomes: [{ id: 'W-1', status: 'failed', note: 'stale' }],
      });
      await service.settled();

      expect((await dao.rowsOf('dev-team'))[0]).toMatchObject({
        outcome: 'applied',
        outcomeSeq: 12,
      });
    });
  });

  describe('sweep', () => {
    it('reads an item filed before the rename, whose target says workflow, as a team item', async () => {
      const [filed] = filedRecommendationsOf(
        { slug: 'dev-team', chatRunId: 'analysis-1', chatKind: 'analysis' },
        {
          seq: 4,
          createdAt: new Date(0),
          payload: {
            ...card(['W-1']),
            sourceKind: 'workflow',
            items: card(['W-1']).items.map((item) => ({
              ...item,
              target: 'workflow',
            })),
          },
        },
        null,
      )!;
      expect(filed?.target).toBe('team');
      await dao.file([{ ...filed!, target: 'workflow' }]);

      expect((await dao.rowsOf('dev-team')).map((row) => row.target)).toEqual([
        'team',
      ]);
    });

    it('copies what the live copy missed from every team chat that still exists, once', async () => {
      const row = (
        seq: number,
        kind: string,
        payload: unknown,
        role: string | null = null,
      ): StoredRow => ({
        seq,
        kind,
        role,
        createdAt: new Date(
          `2026-10-20T10:00:${String(seq).padStart(2, '0')}.000Z`,
        ),
        payload: JSON.stringify(payload),
      });
      stored.set('analysis-1', [
        row(5, 'recommendations', card(['W-1', 'W-2'])),
        row(7, 'message', { apply: { cardSeq: 5, ids: ['W-2'] } }, 'user'),
        row(8, 'recommendation_outcome', {
          cardSeq: 5,
          outcomes: [{ id: 'W-2', status: 'skipped', note: 'not now' }],
        }),
      ]);
      stored.set('plain-chat', [row(2, 'recommendations', card(['R-1']))]);
      stored.set('thread-analysis', [
        row(3, 'recommendations', assessedCard(['W-1'], [DEV])),
      ]);

      await expect(service.sweep()).resolves.toBe(3);
      await service.sweep();

      expect(
        (await assessments.rowsOf('dev-team')).map((entry) => [
          entry.chatRunId,
          entry.memberId,
        ]),
      ).toEqual([['thread-analysis', 'dev']]);

      const rows = await dao.rowsOf('dev-team');
      expect(rows.map((entry) => [entry.itemId, entry.outcome])).toEqual([
        ['W-1', null],
        ['W-2', 'skipped'],
      ]);
      expect(rows[1]).toMatchObject({
        selectedAt: new Date('2026-10-20T10:00:07.000Z'),
        outcomeNote: 'not now',
        libraryVersion: null,
      });
    });
  });
});
