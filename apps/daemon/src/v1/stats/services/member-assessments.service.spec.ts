import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { MemberAssessmentDao } from '../dao/member-assessment.dao';
import { MemberAssessmentRecord } from '../entity/member-assessment.entity';
import { MemberAssessmentsService } from './member-assessments.service';

describe('MemberAssessmentsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: MemberAssessmentsService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [MemberAssessmentRecord],
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
    const dao = new MemberAssessmentDao(orm.em.fork());
    service = new MemberAssessmentsService(orm.em, dao);
    await dao.file(
      ['dev', 'qa'].map((memberId) => ({
        slug: 'dev-team',
        chatRunId: 'analysis-1',
        chatKind: 'analysis' as const,
        cardSeq: 5,
        filedAt: new Date('2026-10-20T10:00:00.000Z'),
        libraryVersion: null,
        runs: 2,
        runIds: [],
        memberId,
        usefulness: 3,
        quality: 3,
        verdict: 'keep' as const,
        summary: 'Fine',
        evidence: [],
        items: [],
        judge: { agent: 'claude', model: null },
        userVerdict: null,
      })),
    );
  });

  it("records the user's verdict and its trimmed note on one member's marks, and clears it", async () => {
    const saved = await service.setVerdict({
      chatRunId: 'analysis-1',
      cardSeq: 5,
      memberId: 'dev',
      verdict: 'disagree',
      note: '  it skipped the tests  ',
    });

    expect(saved.verdicts).toEqual([
      {
        memberId: 'dev',
        userVerdict: {
          verdict: 'disagree',
          note: 'it skipped the tests',
          at: expect.any(String),
        },
      },
      { memberId: 'qa', userVerdict: null },
    ]);

    await service.setVerdict({
      chatRunId: 'analysis-1',
      cardSeq: 5,
      memberId: 'dev',
      verdict: null,
    });

    expect((await service.verdictsOfCard('analysis-1', 5)).verdicts[0]).toEqual(
      { memberId: 'dev', userVerdict: null },
    );
  });

  it('refuses a verdict on an assessment the ledger does not hold', async () => {
    await expect(
      service.setVerdict({
        chatRunId: 'analysis-1',
        cardSeq: 6,
        memberId: 'dev',
        verdict: 'agree',
      }),
    ).rejects.toMatchObject({ errorCode: 'ASSESSMENT_NOT_FOUND' });
  });
});
