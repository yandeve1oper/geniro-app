import { EntityManager as CoreEntityManager } from '@mikro-orm/core';
import { SqlEntityManager } from '@mikro-orm/sqlite';
import { Global, Module } from '@nestjs/common';

/**
 * The `@mikro-orm/sqlite` `EntityManager` every DAO injects, as the one
 * manager the ORM runs on.
 *
 * `@mikro-orm/nestjs` provides the manager under the core token and under the
 * class the config names (`GeniroEntityManager`); with that class configured,
 * the driver package's own token is no longer among them.
 */
@Global()
@Module({
  providers: [
    {
      provide: SqlEntityManager,
      useFactory: (em: CoreEntityManager) => em,
      inject: [CoreEntityManager],
    },
  ],
  exports: [SqlEntityManager],
})
export class SqlEntityManagerModule {}
