import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LessonSegment } from '../entity/lesson-segment.entity';
import { LessonSegmentDao } from './lesson-segment.dao';

describe('LessonSegmentDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: LessonSegmentDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [LessonSegment],
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
    dao = new LessonSegmentDao(orm.em.fork());
  });

  function insert(runId: string, reflectionRunId: string | null) {
    return dao.create({
      runId,
      fromSeq: -1,
      toSeq: 4,
      closedBy: 'manual',
      status: 'reflected',
      reflectionRunId,
    });
  }

  describe('ofReflection', () => {
    it('answers the segment a reflection was started on, and none for another reflection', async () => {
      const segment = await insert('run-a', 'refl-1');
      await insert('run-a', 'refl-2');

      expect((await dao.ofReflection('refl-1'))?.id).toBe(segment.id);
      expect(await dao.ofReflection('refl-unknown')).toBeNull();
    });
  });

  describe('deleteOfRuns', () => {
    it('drops the segments of the runs named and no other', async () => {
      await insert('run-a', 'refl-1');
      await insert('run-b', 'refl-2');
      const kept = await insert('run-c', 'refl-3');

      await dao.deleteOfRuns(['run-a', 'run-b']);

      const left = await dao.getAll({});
      expect(left.map((segment) => segment.id)).toEqual([kept.id]);
    });

    it('drops nothing when no run is named', async () => {
      await insert('run-a', 'refl-1');

      await dao.deleteOfRuns([]);

      expect(await dao.getAll({})).toHaveLength(1);
    });
  });
});
