import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { LineBaseline } from '../entity/line-baseline.entity';
import { LineBaselineDao } from './line-baseline.dao';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

/**
 * Real-driver DAO spec: the unique index and the conditional update are what keep two
 * windows measuring one folder at once from writing two baselines, so they run here
 * against SQLite rather than being mirrored by a fake.
 */
describe('LineBaselineDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: LineBaselineDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [LineBaseline],
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
    dao = new LineBaselineDao(orm.em.fork());
  });

  const row = (baseSha: string) => ({
    folderKey: 'folder-1',
    root: '/repo',
    branch: 'main',
    baseSha,
  });

  it('answers the baseline the first writer set, when a second finds the key taken', async () => {
    expect(await dao.setIfAbsent(row(SHA_A))).toBe(SHA_A);

    // The second writer also found none and tried to set its own commit.
    expect(await dao.setIfAbsent(row(SHA_B))).toBe(SHA_A);
    expect(await dao.baseShaOf('folder-1')).toBe(SHA_A);
  });

  it('replaces a stale baseline once, and a second report of the same stale commit reads the replacement', async () => {
    await dao.setIfAbsent(row(SHA_A));

    expect(await dao.replaceIfCurrent('folder-1', SHA_A, SHA_B)).toBe(SHA_B);
    // The commit this caller found stale has already been replaced, so nothing is written.
    expect(await dao.replaceIfCurrent('folder-1', SHA_A, SHA_C)).toBe(SHA_B);
    expect(await dao.baseShaOf('folder-1')).toBe(SHA_B);
  });

  it('answers null for a folder with no baseline', async () => {
    expect(await dao.baseShaOf('folder-unknown')).toBeNull();
  });
});
