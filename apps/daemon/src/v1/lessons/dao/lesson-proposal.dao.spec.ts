import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LessonProposal } from '../entity/lesson-proposal.entity';
import { LessonProposalDao } from './lesson-proposal.dao';

type Overrides = Partial<LessonProposal>;

describe('LessonProposalDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: LessonProposalDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [LessonProposal],
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
    dao = new LessonProposalDao(orm.em.fork());
  });

  function insert(overrides: Overrides): Promise<LessonProposal> {
    return dao.create({
      sourceRunId: 'run-a',
      reflectionRunId: 'refl',
      segmentId: 'seg',
      title: 'Rule',
      rule: 'Rule in full.',
      why: 'Why.',
      signalKind: 'user_correction',
      evidenceSeq: 3,
      evidenceQuote: 'a quote of eight',
      target: JSON.stringify({
        kind: 'memory',
        scope: 'global',
        type: 'feedback',
      }),
      dedup: JSON.stringify({ verdict: 'new', handle: null }),
      status: 'proposed',
      ...overrides,
    });
  }

  describe('rejectedIn', () => {
    it('answers the rejected lessons of one team, newest decision first', async () => {
      await insert({
        id: 'old',
        teamSlug: 'team-a',
        status: 'rejected',
        decidedAt: new Date(1_000),
      });
      await insert({
        id: 'new',
        teamSlug: 'team-a',
        status: 'rejected',
        decidedAt: new Date(3_000),
      });
      await insert({
        id: 'mid',
        teamSlug: 'team-a',
        status: 'rejected',
        decidedAt: new Date(2_000),
      });
      await insert({
        id: 'saved',
        teamSlug: 'team-a',
        status: 'saved',
        decidedAt: new Date(4_000),
      });
      await insert({
        id: 'other-team',
        teamSlug: 'team-b',
        status: 'rejected',
        decidedAt: new Date(5_000),
      });
      await insert({
        id: 'project',
        projectId: 'p1',
        teamSlug: null,
        status: 'rejected',
        decidedAt: new Date(6_000),
      });

      const rejected = await dao.rejectedIn(
        { projectId: 'p1', teamSlug: 'team-a' },
        20,
      );

      expect(rejected.map((row) => row.id)).toEqual(['new', 'mid', 'old']);
    });

    it('answers the rejected lessons of one project outside any team, and leaves its team runs out', async () => {
      await insert({
        id: 'project',
        projectId: 'p1',
        teamSlug: null,
        status: 'rejected',
        decidedAt: new Date(1_000),
      });
      await insert({
        id: 'team-run',
        projectId: 'p1',
        teamSlug: 'team-a',
        status: 'rejected',
        decidedAt: new Date(2_000),
      });
      await insert({
        id: 'other-project',
        projectId: 'p2',
        teamSlug: null,
        status: 'rejected',
        decidedAt: new Date(3_000),
      });
      await insert({
        id: 'no-place',
        projectId: null,
        teamSlug: null,
        status: 'rejected',
        decidedAt: new Date(4_000),
      });

      const rejected = await dao.rejectedIn(
        { projectId: 'p1', teamSlug: null },
        20,
      );

      expect(rejected.map((row) => row.id)).toEqual(['project']);
    });

    it('answers the rejected lessons of no place only when the thread has neither a project nor a team', async () => {
      await insert({
        id: 'no-place',
        projectId: null,
        teamSlug: null,
        status: 'rejected',
        decidedAt: new Date(1_000),
      });
      await insert({
        id: 'project',
        projectId: 'p1',
        teamSlug: null,
        status: 'rejected',
        decidedAt: new Date(2_000),
      });

      const rejected = await dao.rejectedIn(
        { projectId: null, teamSlug: null },
        20,
      );

      expect(rejected.map((row) => row.id)).toEqual(['no-place']);
    });

    it('stops at the limit, keeping the newest decisions', async () => {
      for (const n of [1, 2, 3, 4]) {
        await insert({
          id: `r${n}`,
          teamSlug: 'team-a',
          status: 'rejected',
          decidedAt: new Date(n * 1_000),
        });
      }

      const rejected = await dao.rejectedIn(
        { projectId: null, teamSlug: 'team-a' },
        2,
      );

      expect(rejected.map((row) => row.id)).toEqual(['r4', 'r3']);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await insert({
        id: 'a-proposed',
        sourceRunId: 'run-a',
        status: 'proposed',
        createdAt: new Date(1_000),
      });
      await insert({
        id: 'a-saved',
        sourceRunId: 'run-a',
        status: 'saved',
        createdAt: new Date(2_000),
      });
      await insert({
        id: 'b-proposed',
        sourceRunId: 'run-b',
        status: 'proposed',
        createdAt: new Date(3_000),
      });
    });

    it('answers every proposal newest first when no filter is given', async () => {
      const rows = await dao.list({});

      expect(rows.map((row) => row.id)).toEqual([
        'b-proposed',
        'a-saved',
        'a-proposed',
      ]);
    });

    it('narrows to one status', async () => {
      const rows = await dao.list({ status: 'proposed' });

      expect(rows.map((row) => row.id)).toEqual(['b-proposed', 'a-proposed']);
    });

    it('narrows to one source thread', async () => {
      const rows = await dao.list({ sourceRunId: 'run-a' });

      expect(rows.map((row) => row.id)).toEqual(['a-saved', 'a-proposed']);
    });

    it('narrows to both at once', async () => {
      const rows = await dao.list({ status: 'proposed', sourceRunId: 'run-a' });

      expect(rows.map((row) => row.id)).toEqual(['a-proposed']);
    });
  });
});
