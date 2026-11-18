import { copyFileSync, globSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type EntityClass, MetadataStorage } from '@mikro-orm/core';
import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';

import { CHAT_TEXT_TABLES } from '../db/chat-text-index.ddl';
import { KNOWLEDGE_TEXT_TABLES } from '../db/knowledge-text-index.ddl';
import { MEMORY_TEXT_TABLES } from '../db/memory-text-index.ddl';
import { GENIRO_ORM_RUNTIME } from '../db/sqlite.driver';
import type { Migration } from '../v1/migrations/migrations.types';
import { APP_MIGRATIONS_TABLES } from '../v1/migrations/migrations.types';
import { MigrationRunnerService } from '../v1/migrations/services/migration-runner.service';

const SRC_DIR = join(__dirname, '..');

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export interface FixtureDatabase {
  app_migrations: { id: string };
  sqlite_master: { name: string; type: string; tbl_name: string; sql: string };
  [table: string]: Record<string, unknown>;
}

export const marker = (table: string, column: string): string =>
  `${table}.${column}`;

/**
 * Every daemon entity class, imported the way the daemon's own glob finds
 * them. Glob discovery inside the suite finds none, which would make a sync
 * check vacuous.
 */
export async function entityClasses(): Promise<EntityClass<object>[]> {
  await Promise.all(
    globSync('**/*.entity.ts', { cwd: SRC_DIR }).map(
      (file) => import(join(SRC_DIR, file)) as Promise<unknown>,
    ),
  );
  return Object.values(MetadataStorage.getMetadata()).map(
    (meta) => meta.class as EntityClass<object>,
  );
}

export async function openDatabase(
  dbName: string,
  entities: boolean,
): Promise<MikroORM> {
  return MikroORM.init(
    defineConfig({
      ...GENIRO_ORM_RUNTIME,
      dbName,
      namingStrategy: UnderscoreNamingStrategy,
      allowGlobalContext: true,
      discovery: { warnWhenNoEntities: false, checkDuplicateFieldNames: false },
      entities: entities ? await entityClasses() : [],
      schemaGenerator: {
        skipTables: [
          CHAT_TEXT_TABLES,
          MEMORY_TEXT_TABLES,
          KNOWLEDGE_TEXT_TABLES,
          APP_MIGRATIONS_TABLES,
        ],
      },
    }),
  );
}

/** One row a NOT NULL column without a default would otherwise refuse, each of `markedColumns` holding its marker. */
export async function insertMarkedRow(
  orm: MikroORM,
  table: string,
  markedColumns: readonly string[],
): Promise<void> {
  const columns = await orm.em
    .fork()
    .getConnection()
    .execute<ColumnInfo[]>(`pragma table_info(\`${table}\`)`);
  const row: Record<string, unknown> = {};
  for (const column of columns) {
    if (markedColumns.includes(column.name)) {
      row[column.name] = /int|bool/i.test(column.type)
        ? 1
        : marker(table, column.name);
    } else if (
      column.pk > 0 ||
      (column.notnull && column.dflt_value === null)
    ) {
      row[column.name] = /int|bool|real|num|date/i.test(column.type)
        ? column.pk > 0
          ? 1
          : 0
        : `fixture-${column.name}`;
    }
  }
  await orm.em
    .fork()
    .getKysely<FixtureDatabase>()
    .insertInto(table)
    .values(row)
    .execute();
}

/**
 * The schema sync's SQL once `migrations` alone have run on a copy of the
 * profile's database, read before any sync, which would otherwise have applied
 * what it found and left nothing to see.
 */
export async function syncSqlAfter(
  userData: string,
  migrations: readonly Migration[],
): Promise<string> {
  const preview = mkdtempSync(join(tmpdir(), 'geniro-sync-preview-'));
  try {
    const dbName = join(preview, 'geniro.db');
    copyFileSync(join(userData, 'geniro.db'), dbName);
    const plain = await openDatabase(dbName, false);
    try {
      await new MigrationRunnerService(plain.em, {
        migrations: [...migrations],
        userDataDir: preview,
        appVersion: 'spec',
        writeLine: () => undefined,
      }).run();
    } finally {
      await plain.close(true);
    }
    const orm = await openDatabase(dbName, true);
    try {
      return await orm.schema.getUpdateSchemaSQL({ safe: true, wrap: false });
    } finally {
      await orm.close(true);
    }
  } finally {
    rmSync(preview, { recursive: true, force: true });
  }
}
