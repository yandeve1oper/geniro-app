import type { MikroORM } from '@mikro-orm/sqlite';
import { vi } from 'vitest';

/** One statement as better-sqlite3 handed it to SQLite: its text and its bound values. */
export interface SentStatement {
  sql: string;
  params: unknown[];
}

type Runner = (...args: unknown[]) => unknown;
type PreparedStatement = Record<'all' | 'get' | 'run' | 'iterate', Runner>;

/**
 * Record every statement `orm`'s database runs from now until `stop()`, at the
 * last step before SQLite: `Database.prototype.prepare` and the run of what it
 * prepared. Below every wrapper the daemon puts on the driver, so it sees what
 * the ORM and `em.getKysely()` send alike.
 */
export async function recordSentStatements(
  orm: MikroORM,
): Promise<{ sent: SentStatement[]; stop: () => void }> {
  const db = (await orm.em
    .getConnection()
    .getNativeClient()) as unknown as object;
  const proto = Object.getPrototypeOf(db) as {
    prepare: (sql: string) => PreparedStatement;
  };
  const prepare = proto.prepare;
  const sent: SentStatement[] = [];
  const spy = vi.spyOn(proto, 'prepare').mockImplementation(function (
    this: unknown,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    for (const method of ['all', 'get', 'run', 'iterate'] as const) {
      const run = statement[method].bind(statement);
      statement[method] = (...args: unknown[]) => {
        const [first] = args;
        sent.push({
          sql,
          params: Array.isArray(first) ? (first as unknown[]).slice() : args,
        });
        return run(...args);
      };
    }
    return statement;
  });
  return { sent, stop: () => spy.mockRestore() };
}
