import {
  defineConfig,
  MikroORM,
  raw,
  SqlitePlatform,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ItemDao } from '../v1/agents/dao/item.dao';
import { Item } from '../v1/runs/entity/item.entity';
import { NodeState } from '../v1/runs/entity/node-state.entity';
import { Run } from '../v1/runs/entity/run.entity';
import { recordSentStatements } from './__tests__/sent-statements';
import { bindQuery, MAX_BOUND_VALUES } from './bound-sqlite.connection';
import { GENIRO_ORM_RUNTIME, GeniroEntityManager } from './sqlite.driver';

describe('bindQuery', () => {
  const platform = new SqlitePlatform();

  it('leaves every value out of the text and binds it in order', () => {
    const at = new Date('2026-11-18T00:44:21.000Z');

    expect(
      bindQuery(
        platform,
        'insert into `items` (`a`, `b`, `c`, `d`, `e`) values (?, ?, ?, ?, ?)',
        ["it's\u0000", 7, true, null, at],
      ),
    ).toEqual({
      sql: 'insert into `items` (`a`, `b`, `c`, `d`, `e`) values (?, ?, ?, ?, ?)',
      params: ["it's\u0000", 7, 1, null, at.getTime()],
    });
  });

  it('quotes a `??` identifier into the text and keeps an escaped `\\?` literal', () => {
    expect(
      bindQuery(platform, 'select ?? from t where x = ? and y = \\?', [
        'col',
        'v',
      ]),
    ).toEqual({
      sql: 'select `col` from t where x = ? and y = ?',
      params: ['v'],
    });
  });

  it('spreads an array into one placeholder per element', () => {
    expect(
      bindQuery(platform, 'select * from t where seq in (?)', [[1, 2, 3]]),
    ).toEqual({
      sql: 'select * from t where seq in (?, ?, ?)',
      params: [1, 2, 3],
    });
  });

  it("splices a raw fragment's SQL in and binds the fragment's own values", () => {
    expect(
      bindQuery(platform, 'select * from t where ? and z = ?', [
        raw('json_extract(payload, ?) = ?', ['$.callId', 'call-7']),
        'last',
      ]),
    ).toEqual({
      sql: 'select * from t where json_extract(payload, ?) = ? and z = ?',
      params: ['$.callId', 'call-7', 'last'],
    });
  });

  it('binds a plain object as its JSON', () => {
    expect(bindQuery(platform, 'select ?', [{ a: 1 }]).params).toEqual([
      '{"a":1}',
    ]);
  });

  it('binds each IN list as one JSON array once the statement would pass the bind limit', () => {
    const ids = Array.from({ length: MAX_BOUND_VALUES }, (_, n) => `id-${n}`);
    const list = ids.map(() => '?').join(', ');

    expect(
      bindQuery(
        platform,
        `select * from t where run_id = ? and id in (${list}) and seq in (?, ?)`,
        ['run-a', ...ids, 1, 2],
      ),
    ).toEqual({
      sql: 'select * from t where run_id = ? and id in (select value from json_each(?)) and seq in (select value from json_each(?))',
      params: ['run-a', JSON.stringify(ids), '[1,2]'],
    });
  });

  it('keeps one placeholder per value while the statement is within the limit', () => {
    expect(
      bindQuery(platform, 'select * from t where id in (?, ?)', ['a', 'b']),
    ).toEqual({
      sql: 'select * from t where id in (?, ?)',
      params: ['a', 'b'],
    });
  });
});

/**
 * Real driver, real SQL: the defect is in how a statement reaches SQLite, so a
 * fake could never enter it. Configured like the daemon's own
 * `db/mikro-orm.config.ts`, with explicit entity classes in place of its glob.
 */
describe('GeniroSqliteDriver (in-memory sqlite)', () => {
  let orm: MikroORM;
  /** What an agent printed when its binary grep hit a NUL — from the traced run. */
  const text = 'still running\u0000 hasPendingAgents';

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, Item, NodeState],
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

  it('writes a transcript row whose text holds a NUL byte, and keeps the byte', async () => {
    await new ItemDao(orm.em.fork()).create({
      runId: 'run-a',
      seq: 0,
      kind: 'tool_result',
      payload: JSON.stringify({ result: text }),
      searchText: text,
    });

    const [row] = await new ItemDao(orm.em.fork()).getByRun('run-a');
    expect(row?.searchText).toBe(text);
  });

  it('matches a NUL-bearing value in a WHERE clause', async () => {
    const row = await orm.em.fork().findOne(Item, { searchText: text });
    expect(row?.runId).toBe('run-a');
  });

  it('writes the output of a `cat` of a binary file, thousands of NULs and multibyte text included', async () => {
    // Pasted into the statement as `'…' || char(0) || '…'`, this insert failed
    // with `Expression tree is too large (maximum depth 1000)`.
    const binary = `%YAML 1.1\n${"\u0000\u0001ß'".repeat(4000)}\u0000Карта 🗺\u0000`;
    await new ItemDao(orm.em.fork()).create({
      runId: 'run-binary',
      seq: 0,
      kind: 'tool_result',
      payload: JSON.stringify({ result: binary }),
      searchText: binary,
    });

    const [row] = await new ItemDao(orm.em.fork()).getByRun('run-binary');
    expect(row?.searchText).toBe(binary);
    const matched = await orm.em.fork().findOne(Item, { searchText: binary });
    expect(matched?.runId).toBe('run-binary');
  });

  it('hands SQLite the statement with its values bound, not written into its text', async () => {
    const { sent, stop } = await recordSentStatements(orm);
    const marker = 'a value only the parameters may carry';

    await new ItemDao(orm.em.fork()).create({
      runId: 'run-bound',
      seq: 0,
      kind: 'message',
      payload: JSON.stringify({ text: marker }),
      searchText: marker,
    });
    stop();

    const insert = sent.find((statement) => statement.sql.startsWith('insert'));
    expect(insert?.sql).not.toContain(marker);
    expect(insert?.params).toContain(marker);
  });

  it('reads and deletes by an `$in` list longer than SQLite binds in one statement', async () => {
    await new ItemDao(orm.em.fork()).create({
      runId: 'run-many',
      seq: 0,
      kind: 'message',
      payload: '{}',
      searchText: 'needle\u0000',
    });
    const texts = Array.from({ length: 40_000 }, (_, n) => `hay-${n}`);
    texts.push('needle\u0000');

    const found = await orm.em
      .fork()
      .find(Item, { searchText: { $in: texts } });
    expect(found.map((row) => row.runId)).toEqual(['run-many']);

    await orm.em.fork().nativeDelete(Item, { searchText: { $in: texts } });
    expect(await new ItemDao(orm.em.fork()).getByRun('run-many')).toEqual([]);
  });

  it('reads dates, booleans and `$in` lists back through bound values', async () => {
    const em = orm.em.fork();
    const at = new Date('2026-11-18T00:44:21.000Z');
    em.create(
      NodeState,
      {
        runId: 'run-typed',
        memberId: 'middle',
        status: 'running',
        contextEstimated: true,
        createdAt: at,
        updatedAt: at,
      },
      { partial: true },
    );
    await em.flush();

    const found = await orm.em.fork().find(NodeState, {
      runId: { $in: ['run-typed', 'run-missing'] },
      contextEstimated: true,
      createdAt: { $gte: at },
    });
    expect(found.map((row) => [row.memberId, row.createdAt.getTime()])).toEqual(
      [['middle', at.getTime()]],
    );
  });
});

describe('GeniroEntityManager', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, Item, NodeState],
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

  it('is the manager the runtime hands out, forks included', () => {
    expect(orm.em).toBeInstanceOf(GeniroEntityManager);
    expect(orm.em.fork()).toBeInstanceOf(GeniroEntityManager);
  });

  it('writes the next change after a flush SQLite refused', async () => {
    const em = orm.em.fork();
    em.create(
      Item,
      {
        runId: 'run-x',
        seq: 1,
        kind: null as unknown as 'message',
        payload: '{}',
      },
      { partial: true },
    );
    await expect(em.flush()).rejects.toThrow();

    em.create(
      Item,
      { runId: 'run-x', seq: 2, kind: 'message', payload: '{}' },
      { partial: true },
    );
    await em.flush();

    const stored = await new ItemDao(orm.em.fork()).getByRun('run-x');
    expect(stored.map((item) => item.seq)).toEqual([2]);
  });
});
