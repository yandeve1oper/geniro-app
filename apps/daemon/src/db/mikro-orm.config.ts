import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, UnderscoreNamingStrategy } from '@mikro-orm/sqlite';

import { environment } from '../environments';
import { APP_MIGRATIONS_TABLES } from '../v1/migrations/migrations.types';
import { CHAT_TEXT_TABLES } from './chat-text-index.ddl';
import { KNOWLEDGE_TEXT_TABLES } from './knowledge-text-index.ddl';
import { MEMORY_TEXT_TABLES } from './memory-text-index.ddl';
import { GENIRO_ORM_RUNTIME } from './sqlite.driver';

const { dbPath } = environment;

/**
 * mikro-orm config, cloned from Geniro's apps/api and adapted to SQLite
 * (better-sqlite3-backed `@mikro-orm/sqlite`) for local-first use — the
 * Postgres connection/SSL/schema keys are dropped in favour of a single
 * `dbName` file path.
 */
export default defineConfig({
  ...GENIRO_ORM_RUNTIME,
  dbName: dbPath,
  entities: [join(__dirname, '..', '**', '*.entity.js')],
  entitiesTs: [join(__dirname, '..', '**', '*.entity.ts')],
  // Spread optional DTO fields into FilterQuery without unwanted IS NULL.
  ignoreUndefinedInQuery: true,
  // NestJS request-scoping handles context isolation.
  allowGlobalContext: true,
  namingStrategy: UnderscoreNamingStrategy,
  discovery: { checkDuplicateFieldNames: false },
  // The full-text indexes and the migration journal are not entities and must
  // stay invisible to the schema sync — see CHAT_TEXT_TABLES.
  schemaGenerator: {
    skipTables: [
      CHAT_TEXT_TABLES,
      MEMORY_TEXT_TABLES,
      KNOWLEDGE_TEXT_TABLES,
      APP_MIGRATIONS_TABLES,
    ],
  },
  // NO `extensions` and no `seeder` block, unlike the sibling's config, and
  // the omission is load-bearing twice over.
  //
  // `SeedManager` comes from a devDEPENDENCY, and this file is imported by
  // `main.ts` — so registering it here would ship a daemon that cannot boot:
  // `pnpm deploy --prod` strips devDependencies out of the packaged app, and
  // the config would then fail to resolve `@mikro-orm/seeder` before Nest ever
  // starts. `db/seed.ts` registers it instead, being the one entry point that
  // is never packaged.
  //
  // The sibling also carries `Migrator`, which this repo deliberately does not
  // have: the schema is synced additively on launch (`orm.schema.update({ safe:
  // true })`), and what a sync cannot express runs first through geniro's own
  // journaled runner (`v1/migrations`).
  //
  // mikro-orm v7 discovers entities via dynamic import() and emits file:// URLs;
  // turn them back into paths so the swc CJS transform's require() shim accepts
  // them. `fileURLToPath`, never `new URL(id).pathname`: the latter keeps the
  // URL's percent-encoding, so a checkout under a path with a space in it (every
  // task worktree, under `~/Library/Application Support/`) asked `require` for
  // `Application%20Support` and the daemon died before Nest started.
  dynamicImportProvider: async (id: string) => {
    const path = id.startsWith('file://') ? fileURLToPath(id) : id;
    return import(path);
  },
});
