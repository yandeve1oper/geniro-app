import {
  type Dictionary,
  isRaw,
  JsonProperty,
  type LoggingOptions,
  NativeQueryBuilder,
  type Platform,
  raw,
  type RawQueryFragment,
  type Transaction,
  Utils,
} from '@mikro-orm/sqlite';
import {
  type AbortableQueryOptions,
  CompiledQuery,
  type InflightQueryAbortStrategy,
  type Kysely,
  type QueryResult,
} from 'kysely';

import { TimedSqliteConnection } from './slow-statement-log';

/** A statement with its values kept apart from its text, as SQLite binds them. */
export interface BoundStatement {
  sql: string;
  params: unknown[];
}

type BindableValue = string | number | bigint | Buffer | null;

/**
 * The most values one SQLite statement binds (`SQLITE_MAX_VARIABLE_NUMBER` in
 * the better-sqlite3 the daemon ships: 32766 prepared, 100000 refused).
 */
export const MAX_BOUND_VALUES = 32_766;

/** One `IN` list as MikroORM writes it: a placeholder per value, then its close. */
const IN_LIST = /\?(?:, \?)*\)/y;

/**
 * `query` with every `?` value placeholder left for SQLite to bind and its
 * value in `params`, in the same walk `Platform.formatQuery` makes: `??` is an
 * identifier, quoted into the text; `\?` is a literal question mark; a raw
 * fragment's own SQL is spliced in with its own values bound; an array becomes
 * one placeholder per element.
 *
 * MikroORM 7 binds nothing: it pastes every value into the statement text
 * through the platform's escaping, so a value is only as safe as that escaping.
 * A NUL ended the literal early, and spelling each NUL as `char(0)` nested the
 * statement one level per byte, past SQLite's depth limit of 1000, for any
 * binary output an agent printed. A bound value is stored byte for byte, of any
 * content and length, and is never parsed.
 *
 * A statement past {@link MAX_BOUND_VALUES} has each of its `IN` lists bound
 * as one JSON array read back through `json_each`, which keeps every value's
 * type and bytes and still searches the column's index.
 */
export function bindQuery(
  platform: Platform,
  query: string,
  params: readonly unknown[],
): BoundStatement {
  const bound: unknown[] = [];
  const sql = bindInto(platform, query, params, bound, false);
  if (bound.length <= MAX_BOUND_VALUES) {
    return { sql, params: bound };
  }
  const compacted: unknown[] = [];
  return {
    sql: bindInto(platform, query, params, compacted, true),
    params: compacted,
  };
}

function bindInto(
  platform: Platform,
  query: string,
  params: readonly unknown[],
  bound: unknown[],
  compactLists: boolean,
): string {
  if (params.length === 0) {
    return query;
  }
  let j = 0;
  let pos = 0;
  let out = '';
  if (query.startsWith('?')) {
    if (query[1] === '?') {
      out += platform.quoteIdentifier(params[j++] as string);
      pos = 2;
    } else {
      out += placeholderFor(platform, params[j++], bound);
      pos = 1;
    }
  }
  while (pos < query.length) {
    const idx = query.indexOf('?', pos + 1);
    if (idx === -1) {
      out += query.substring(pos, query.length);
      break;
    }
    if (query.substring(idx - 1, idx + 1) === '\\?') {
      out += `${query.substring(pos, idx - 1)}?`;
      pos = idx + 1;
    } else if (query.substring(idx, idx + 2) === '??') {
      out +=
        query.substring(pos, idx) +
        platform.quoteIdentifier(params[j++] as string);
      pos = idx + 2;
    } else {
      const list = compactLists ? inListAt(query, idx, params, j) : null;
      if (list !== null) {
        bound.push(list.json);
        out += `${query.substring(pos, idx)}select value from json_each(?))`;
        j += list.count;
        pos = idx + list.length;
        continue;
      }
      out +=
        query.substring(pos, idx) +
        placeholderFor(platform, params[j++], bound);
      pos = idx + 1;
    }
  }
  return out;
}

/**
 * The `IN` list opening at `idx` as one JSON array, when it holds more than one
 * value and every value is one JSON carries as SQLite reads it back.
 */
function inListAt(
  query: string,
  idx: number,
  params: readonly unknown[],
  from: number,
): { json: string; count: number; length: number } | null {
  if (query.substring(idx - 4, idx).toLowerCase() !== 'in (') {
    return null;
  }
  IN_LIST.lastIndex = idx;
  const match = IN_LIST.exec(query);
  if (match === null) {
    return null;
  }
  const count = (match[0].length + 1) / 3;
  if (count < 2) {
    return null;
  }
  const values: (string | number | null)[] = [];
  for (const value of params.slice(from, from + count)) {
    const plain = bindable(value);
    if (
      isRaw(value) ||
      Array.isArray(value) ||
      typeof plain === 'bigint' ||
      Buffer.isBuffer(plain)
    ) {
      return null;
    }
    values.push(plain);
  }
  return { json: JSON.stringify(values), count, length: match[0].length };
}

function placeholderFor(
  platform: Platform,
  value: unknown,
  bound: unknown[],
): string {
  if (isRaw(value)) {
    const fragment = value as RawQueryFragment;
    return bindInto(platform, fragment.sql, fragment.params, bound, false);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => placeholderFor(platform, item, bound))
      .join(', ');
  }
  bound.push(bindable(value));
  return '?';
}

/** The value SQLite stores for what `SqlitePlatform.escape` would have pasted. */
function bindable(value: unknown): BindableValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (
    Utils.isPlainObject(value) ||
    Boolean((value as { [JsonProperty]?: unknown })[JsonProperty])
  ) {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * The daemon's SQLite connection: every ORM statement runs with its values
 * bound ({@link bindQuery}) rather than pasted into its text, and is timed by
 * {@link TimedSqliteConnection}. `em.getKysely()` already binds; this brings
 * the ORM's own reads and writes to the same footing.
 */
export class BoundSqliteConnection extends TimedSqliteConnection {
  override async execute<
    T extends QueryResult<unknown> | Dictionary | Dictionary[] = Dictionary[],
  >(
    query: string | NativeQueryBuilder | RawQueryFragment,
    params: readonly unknown[] | Dictionary<unknown> = [],
    method: 'all' | 'get' | 'run' = 'all',
    ctx?: Transaction,
    loggerContext?: LoggingOptions,
  ): Promise<T> {
    await this.ensureConnection();
    const statement = this.bound(query, params);
    const { abort, context } = abortOptionsOf(loggerContext);
    const client = (ctx as Kysely<unknown> | undefined) ?? this.getClient();
    return this.executeQuery(
      this.getSql(statement.sql, statement.sql, loggerContext),
      async () => {
        const res = await client.executeQuery(
          CompiledQuery.raw(statement.sql, statement.params),
          abort,
        );
        return this.transformRawResult<T>(res, method);
      },
      { query: statement.sql, params: statement.params, ...context },
    );
  }

  override async *stream<T extends Dictionary>(
    query: string | NativeQueryBuilder | RawQueryFragment,
    params: readonly unknown[] | Dictionary<unknown> = [],
    ctx?: Transaction<Kysely<unknown>>,
    loggerContext?: LoggingOptions,
    chunkSize?: number,
  ): AsyncIterableIterator<T> {
    await this.ensureConnection();
    const statement = this.bound(query, params);
    const sql = this.getSql(statement.sql, statement.sql, loggerContext);
    const { abort, context } = abortOptionsOf(loggerContext);
    const compiled = {
      ...CompiledQuery.raw(statement.sql, statement.params),
      query: { kind: 'SelectQueryNode' },
    } as unknown as CompiledQuery<T>;
    const logged = { sql, params: statement.params, ...context };
    try {
      const rows = (ctx ?? this.getClient())
        .getExecutor()
        .stream<T>(compiled, chunkSize ?? 100, abort);
      this.logQuery(sql, logged);
      for await (const chunk of rows) {
        for (const row of this.transformRawResult<T[]>(chunk, 'all')) {
          yield row;
        }
      }
    } catch (err) {
      this.logQuery(sql, { ...logged, level: 'error' });
      throw err;
    }
  }

  /** What `AbstractSqlConnection.prepareQuery` reads a call as, bound rather than formatted. */
  private bound(
    query: string | NativeQueryBuilder | RawQueryFragment,
    params: readonly unknown[] | Dictionary<unknown>,
  ): BoundStatement {
    let sql: string | NativeQueryBuilder | RawQueryFragment = query;
    let values: readonly unknown[] | Dictionary<unknown> = params;
    if (sql instanceof NativeQueryBuilder) {
      sql = sql.toRaw();
    }
    if (typeof sql === 'string' && !Array.isArray(values)) {
      sql = raw(sql, values);
    }
    if (isRaw(sql)) {
      const fragment = sql as RawQueryFragment;
      values = fragment.params;
      sql = fragment.sql;
    }
    const text = sql as string;
    const list = values as readonly unknown[];
    return bindQuery(
      this.platform,
      this.config.get('onQuery')(text, list),
      list,
    );
  }
}

/**
 * The cancellation the query builder stashes on `loggerContext`, apart from the
 * rest, as `AbstractSqlConnection` reads it (its helper is not exported).
 */
function abortOptionsOf(loggerContext: LoggingOptions | undefined): {
  abort: AbortableQueryOptions | undefined;
  context: LoggingOptions | undefined;
} {
  const stashed = loggerContext as
    | (LoggingOptions & {
        signal?: AbortSignal;
        inflightQueryAbortStrategy?: InflightQueryAbortStrategy;
      })
    | undefined;
  if (stashed?.signal == null && stashed?.inflightQueryAbortStrategy == null) {
    return { abort: undefined, context: loggerContext };
  }
  const { signal, inflightQueryAbortStrategy, ...rest } = stashed;
  return { abort: { signal, inflightQueryAbortStrategy }, context: rest };
}
