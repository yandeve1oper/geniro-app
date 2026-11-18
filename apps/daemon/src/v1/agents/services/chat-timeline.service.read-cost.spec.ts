import type { Configuration, Constructor } from '@mikro-orm/core';
import {
  AbstractSqlDriver,
  defineConfig,
  type Dictionary,
  MikroORM,
  type RequiredEntityData,
  SqliteConnection,
  SqlitePlatform,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import type {
  CompiledQuery,
  DatabaseConnection,
  Dialect,
  Driver,
  QueryResult,
} from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { kindRowsPassthrough } from '../__tests__/kind-rows-passthrough';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { ChatTimelineService } from './chat-timeline.service';

const TOOL_ROWS = 20_000;
const ROW_BUDGET = 1_000;

let rowsRead = 0;

function rowCounting(driver: Driver): Driver {
  const counted = new WeakSet<DatabaseConnection>();
  const acquire = driver.acquireConnection.bind(driver);
  driver.acquireConnection = async (options) => {
    const connection = await acquire(options);
    if (!counted.has(connection)) {
      const execute = connection.executeQuery.bind(connection);
      connection.executeQuery = async <R>(
        query: CompiledQuery,
      ): Promise<QueryResult<R>> => {
        const result = await execute<R>(query);
        rowsRead += result.rows.length;
        return result;
      };
      counted.add(connection);
    }
    return connection;
  };
  return driver;
}

/** Counts the rows of every statement, the ORM's and `getKysely()`'s alike. */
class RowCountingConnection extends SqliteConnection {
  override createKyselyDialect(options: Dictionary): Dialect {
    const dialect = super.createKyselyDialect(options);
    const createDriver = dialect.createDriver.bind(dialect);
    dialect.createDriver = () => rowCounting(createDriver());
    return dialect;
  }
}

class RowCountingDriver extends AbstractSqlDriver<SqliteConnection> {
  constructor(config: Configuration) {
    super(config, new SqlitePlatform(), RowCountingConnection, [
      'kysely',
      'better-sqlite3',
    ]);
  }

  override getORMClass(): Constructor<MikroORM> {
    return MikroORM;
  }
}

describe('ChatTimelineService over a long run (in-memory sqlite)', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        driver: RowCountingDriver,
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

  beforeEach(async () => {
    await orm.schema.clear();
    await new RunDao(orm.em.fork()).create({
      id: 'run-a',
      status: 'running',
      teamId: null,
    });
    const at = (seq: number): Date =>
      new Date(Date.UTC(2026, 9, 27, 12) + seq * 1000);
    const rows: RequiredEntityData<Item>[] = [];
    const push = (
      kind: string,
      role: string | null,
      payload: unknown,
    ): void => {
      const seq = rows.length;
      rows.push({
        id: `i-${seq}`,
        runId: 'run-a',
        seq,
        kind: kind as Item['kind'],
        role,
        payload: JSON.stringify(payload),
        createdAt: at(seq),
        updatedAt: at(seq),
      });
    };
    push('message', 'user', { text: 'first question' });
    push('message', 'assistant', { text: 'working on it' });
    for (let n = 0; n < TOOL_ROWS / 2; n += 1) {
      push('tool_call', 'assistant', { id: `t${n}`, name: 'Bash', input: {} });
      push('tool_result', 'tool', { id: `t${n}`, result: 'ok' });
    }
    push('turn_complete', null, { usage: { inputTokens: 1, outputTokens: 1 } });
    push('message', 'user', { text: 'second question' });
    push('reasoning', 'assistant', { text: 'thinking' });
    push('turn_complete', null, { usage: { inputTokens: 1, outputTokens: 1 } });
    await orm.em.fork().insertMany(Item, rows);
    rowsRead = 0;
  });

  it('builds the rail without reading every row of a run whose history is mostly tool calls', async () => {
    const em = orm.em.fork();
    const items = new ItemDao(em);
    const service = new ChatTimelineService(
      em,
      items,
      new RunDao(em),
      kindRowsPassthrough(items),
    );

    const { markers } = await service.read('run-a');

    expect(markers.map((m) => [m.preview, m.segment.aiMessages])).toEqual([
      ['first question', 1],
      ['second question', 1],
    ]);
    expect(markers[0]!.segment.elapsedMs).toBe((TOOL_ROWS + 2) * 1000);
    expect(markers[1]!.segment.elapsedMs).toBe(2000);
    expect(rowsRead).toBeGreaterThan(0);
    expect(rowsRead).toBeLessThan(ROW_BUDGET);
  });
});
