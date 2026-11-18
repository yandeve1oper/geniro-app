import type { Configuration, Constructor } from '@mikro-orm/core';
import {
  AbstractSqlDriver,
  MikroORM,
  SqlEntityManager,
  SqliteConnection,
  type SqliteDriver,
  SqlitePlatform,
} from '@mikro-orm/sqlite';

import { BoundSqliteConnection } from './bound-sqlite.connection';

/**
 * `@mikro-orm/sqlite`'s own `SqliteDriver` with {@link BoundSqliteConnection}
 * in place of the stock connection: the stock driver's constructor is the same
 * call with `SqliteConnection`.
 */
export class GeniroSqliteDriver extends AbstractSqlDriver<SqliteConnection> {
  constructor(config: Configuration) {
    super(config, new SqlitePlatform(), BoundSqliteConnection, [
      'kysely',
      'better-sqlite3',
    ]);
  }

  override getORMClass(): Constructor<MikroORM> {
    return MikroORM;
  }
}

/**
 * An `EntityManager` whose failed flush leaves nothing behind.
 *
 * MikroORM keeps the changes of a flush that threw scheduled in its unit of
 * work, so every later flush on the same manager sends them again and fails
 * the same way. A team pass writes every row through one manager, so a single
 * row SQLite refused took every later row, status and call ending of that
 * pass with it. Clearing on failure confines a refused write to its own call,
 * which still throws.
 */
export class GeniroEntityManager extends SqlEntityManager<SqliteDriver> {
  override async flush(): Promise<void> {
    try {
      await super.flush();
    } catch (err) {
      this.clear();
      throw err;
    }
  }
}

/**
 * The driver and manager every daemon ORM runs on — the app's and each spec's
 * alike, so a spec exercises the statements the app sends.
 */
export const GENIRO_ORM_RUNTIME = {
  driver: GeniroSqliteDriver,
  entityManager: GeniroEntityManager,
} as const;
