import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { TeamVersion } from '../entity/team-version.entity';
import { TeamVersionDao } from './team-version.dao';

/** Real-driver spec: the upsert's conflict clause runs against SQLite itself. */
describe('TeamVersionDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: TeamVersionDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [TeamVersion],
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    dao = new TeamVersionDao(orm.em.fork());
  });

  const at = (iso: string): Date => new Date(iso);

  it('records a version once, keeping its first team', async () => {
    await dao.register('dev-team', 'v1', '{"a":1}', at('2026-10-02T00:00:00Z'));
    await dao.register('dev-team', 'v1', '{"b":2}', at('2026-10-03T00:00:00Z'));

    expect(await dao.graphsOf('dev-team')).toEqual([
      {
        version: 'v1',
        graph: '{"a":1}',
        firstSeenAt: at('2026-10-02T00:00:00Z'),
      },
    ]);
  });

  it('moves firstSeenAt earlier when an older run of the version is recorded later', async () => {
    await dao.register('dev-team', 'v1', '{}', at('2026-10-05T00:00:00Z'));
    await dao.register('dev-team', 'v1', '{}', at('2026-10-01T00:00:00Z'));

    expect((await dao.graphsOf('dev-team'))[0]?.firstSeenAt).toEqual(
      at('2026-10-01T00:00:00Z'),
    );
  });

  it('lists one team’s versions oldest first', async () => {
    await dao.register('dev-team', 'v2', '{}', at('2026-10-05T00:00:00Z'));
    await dao.register('dev-team', 'v1', '{}', at('2026-10-01T00:00:00Z'));
    await dao.register('other', 'v9', '{}', at('2026-09-01T00:00:00Z'));

    expect((await dao.graphsOf('dev-team')).map((row) => row.version)).toEqual([
      'v1',
      'v2',
    ]);
  });
});
