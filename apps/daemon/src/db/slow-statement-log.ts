import { type Dictionary, SqliteConnection } from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
import type {
  CompiledQuery,
  DatabaseConnection,
  Dialect,
  Driver,
  QueryResult,
} from 'kysely';

/** A statement at least this slow is written to the debug log. */
export const SLOW_STATEMENT_MS = 100;

const MAX_LOGGED_SQL = 600;

/**
 * `@mikro-orm/sqlite`'s connection, with every statement timed where both the
 * ORM's queries and `em.getKysely()`'s reach better-sqlite3: the Kysely
 * dialect's driver. A statement at or past {@link SLOW_STATEMENT_MS} — failed
 * ones included, a lock wait being one — is written to the debug log by its
 * shape alone (`valueFreeSql`).
 */
export class TimedSqliteConnection extends SqliteConnection {
  private readonly slow = new Logger('SlowStatement');

  override createKyselyDialect(options: Dictionary): Dialect {
    const dialect = super.createKyselyDialect(options);
    const createDriver = dialect.createDriver.bind(dialect);
    dialect.createDriver = () =>
      timedDriver(createDriver(), (sql, ms) => {
        this.slow.warn(
          `slow statement ${Math.round(ms)} ms: ${valueFreeSql(sql)}`,
        );
      });
    return dialect;
  }
}

/** `driver`, with every statement its connections run timed into `onSlow`. */
export function timedDriver(
  driver: Driver,
  onSlow: (sql: string, ms: number) => void,
): Driver {
  const timed = new WeakSet<DatabaseConnection>();
  const acquire = driver.acquireConnection.bind(driver);
  driver.acquireConnection = async (options) => {
    const connection = await acquire(options);
    if (!timed.has(connection)) {
      const execute = connection.executeQuery.bind(connection);
      connection.executeQuery = async <R>(
        query: CompiledQuery,
      ): Promise<QueryResult<R>> => {
        const started = performance.now();
        try {
          return await execute<R>(query);
        } finally {
          const ms = performance.now() - started;
          if (ms >= SLOW_STATEMENT_MS) {
            onSlow(query.sql, ms);
          }
        }
      };
      timed.add(connection);
    }
    return connection;
  };
  return driver;
}

/**
 * The statement's shape: every string and number literal read as `?`, cut to a
 * bounded length. Values are bound, but a statement can still spell a literal
 * in its text (the ORM's own fragments, a schema statement), and a literal can
 * be a path or a token.
 */
export function valueFreeSql(sql: string): string {
  const shape = sql
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
  return shape.length <= MAX_LOGGED_SQL
    ? shape
    : `${shape.slice(0, MAX_LOGGED_SQL)}…`;
}
