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

  function stretch(
    runId: string,
    closedAt: string,
    status: LessonSegment['status'] = 'queued',
  ) {
    return dao.create({
      runId,
      fromSeq: -1,
      toSeq: 4,
      closedBy: 'archive',
      closedAt: new Date(closedAt),
      status,
      reflectionRunId: null,
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

  describe('queuedOf and listQueued', () => {
    it('answers the queued stretch of a thread, and none once that stretch is skipped', async () => {
      const kept = await stretch('run-a', '2026-11-13T10:00:00.000Z');
      await stretch('run-b', '2026-11-13T11:00:00.000Z', 'skipped');

      expect((await dao.queuedOf('run-a'))?.id).toBe(kept.id);
      expect(await dao.queuedOf('run-b')).toBeNull();
      expect(await dao.queuedOf('run-unknown')).toBeNull();
    });

    it('lists the queued stretches oldest closed first, the order the runner takes them in', async () => {
      const newest = await stretch('run-a', '2026-11-13T12:00:00.000Z');
      const oldest = await stretch('run-b', '2026-11-13T09:00:00.000Z');
      await stretch('run-c', '2026-11-13T10:00:00.000Z', 'reflected');

      expect((await dao.listQueued()).map((segment) => segment.id)).toEqual([
        oldest.id,
        newest.id,
      ]);
    });
  });

  describe('listByStatus', () => {
    it('lists the segments in the statuses named, newest closed first, for one run or for every run', async () => {
      const older = await stretch('run-a', '2026-11-13T09:00:00.000Z');
      const newer = await stretch(
        'run-a',
        '2026-11-13T12:00:00.000Z',
        'reflecting',
      );
      const other = await stretch('run-b', '2026-11-13T11:00:00.000Z');
      await stretch('run-b', '2026-11-13T10:00:00.000Z', 'reflected');

      expect(
        (await dao.listByStatus(['queued', 'reflecting'], null)).map(
          (segment) => segment.id,
        ),
      ).toEqual([newer.id, other.id, older.id]);
      expect(
        (await dao.listByStatus(['queued', 'reflecting'], 'run-a')).map(
          (segment) => segment.id,
        ),
      ).toEqual([newer.id, older.id]);
      expect(await dao.listByStatus(['skipped'], null)).toEqual([]);
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
