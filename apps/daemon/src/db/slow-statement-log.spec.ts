import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
import type { CompiledQuery, DatabaseConnection, Driver } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatTextDatabase } from '../v1/agents/chat.types';
import { Item } from '../v1/runs/entity/item.entity';
import { NodeState } from '../v1/runs/entity/node-state.entity';
import { Run } from '../v1/runs/entity/run.entity';
import {
  SLOW_STATEMENT_MS,
  timedDriver,
  valueFreeSql,
} from './slow-statement-log';
import { GENIRO_ORM_RUNTIME } from './sqlite.driver';

describe('valueFreeSql', () => {
  it('takes every string and number literal out of a statement MikroORM pasted values into', () => {
    expect(
      valueFreeSql(
        "select `i0`.`payload` from `items` as `i0` where `i0`.`run_id` = 'run-1' and `i0`.`payload` like '%token sk-abc''d%' and `i0`.`seq` > 42 limit 10",
      ),
    ).toBe(
      'select `i0`.`payload` from `items` as `i0` where `i0`.`run_id` = ? and `i0`.`payload` like ? and `i0`.`seq` > ? limit ?',
    );
  });

  it('cuts a long statement to a bounded length', () => {
    const shape = valueFreeSql(`select ${'`c`, '.repeat(400)}1`);
    expect(shape.length).toBe(601);
    expect(shape.endsWith('…')).toBe(true);
  });
});

describe('timedDriver', () => {
  function driverRunning(msPerStatement: number, fail = false): Driver {
    const connection = {
      executeQuery: () => {
        const until = Date.now() + msPerStatement;
        while (Date.now() < until) {
          // A synchronous statement holds the thread like better-sqlite3 does.
        }
        return fail
          ? Promise.reject(new Error('SQLITE_BUSY'))
          : Promise.resolve({ rows: [] });
      },
    } as unknown as DatabaseConnection;
    return {
      acquireConnection: () => Promise.resolve(connection),
    } as unknown as Driver;
  }

  const query = { sql: 'select 1' } as CompiledQuery;

  it('reports a statement at or past the threshold, a failed one included', async () => {
    const onSlow = vi.fn();
    const ok = await timedDriver(
      driverRunning(SLOW_STATEMENT_MS + 20),
      onSlow,
    ).acquireConnection();
    const failing = await timedDriver(
      driverRunning(SLOW_STATEMENT_MS + 20, true),
      onSlow,
    ).acquireConnection();

    await ok.executeQuery(query);
    await expect(failing.executeQuery(query)).rejects.toThrow('SQLITE_BUSY');

    expect(onSlow.mock.calls.map(([sql]) => sql)).toEqual([
      'select 1',
      'select 1',
    ]);
  });

  it('stays quiet for a fast statement, and wraps a reused connection once', async () => {
    const onSlow = vi.fn();
    const driver = timedDriver(driverRunning(0), onSlow);
    const first = await driver.acquireConnection();
    const again = await driver.acquireConnection();

    await again.executeQuery(query);

    expect(again).toBe(first);
    expect(onSlow).not.toHaveBeenCalled();
  });
});

describe('TimedSqliteConnection under the daemon’s driver', () => {
  let orm: MikroORM | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    await orm?.close(true);
    orm = null;
  });

  it('times a statement built on getKysely(), which never reaches the ORM’s own logger', async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, Item, NodeState],
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += SLOW_STATEMENT_MS;
      return clock;
    });

    await orm.em
      .fork()
      .getKysely<ChatTextDatabase>()
      .selectFrom('items')
      .select('id')
      .where('run_id', '=', 'secret-run')
      .execute();

    expect(warn).toHaveBeenCalledWith(
      `slow statement ${SLOW_STATEMENT_MS} ms: select "id" from "items" where "run_id" = ?`,
    );
  });
});
