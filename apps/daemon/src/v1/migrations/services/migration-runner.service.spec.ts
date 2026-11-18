import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Project } from '../../projects/entity/project.entity';
import {
  APP_MIGRATIONS_TABLE,
  type DatabaseMigration,
  type FileMigration,
  MIGRATING_LINE_PREFIX,
  type Migration,
  MIGRATION_ERROR_FILE,
  type MigrationErrorReport,
  type MigrationsDatabase,
} from '../migrations.types';
import { MigrationFailedError } from '../utils/migration-failed-error';
import { MigrationRunnerService } from './migration-runner.service';

function createsTable(id: string, table: string): DatabaseMigration {
  return {
    id,
    kind: 'database',
    async up({ db }) {
      await db.schema
        .createTable(table)
        .addColumn('id', 'text', (column) => column.primaryKey())
        .execute();
    },
    async down({ db }) {
      await db.schema.dropTable(table).execute();
    },
  };
}

function failing(id: string): DatabaseMigration {
  return {
    id,
    kind: 'database',
    up: () => Promise.reject(new Error('boom')),
    down: () => Promise.resolve(),
  };
}

describe('MigrationRunnerService.run', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let userDataDir: string;
  let lines: string[];

  beforeEach(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Project],
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
      }),
    );
    em = orm.em;
    userDataDir = mkdtempSync(join(tmpdir(), 'geniro-migrations-'));
    lines = [];
  });

  afterEach(async () => {
    await orm.close(true);
    rmSync(userDataDir, { recursive: true, force: true });
  });

  function runner(migrations: readonly Migration[]): MigrationRunnerService {
    return new MigrationRunnerService(em, {
      migrations,
      userDataDir,
      appVersion: '9.9.9',
      writeLine: (line) => lines.push(line),
    });
  }

  const db = (): Kysely<MigrationsDatabase> =>
    em.fork().getKysely<MigrationsDatabase>();

  async function tables(): Promise<string[]> {
    return (await db().introspection.getTables()).map((table) => table.name);
  }

  async function journal(): Promise<MigrationsDatabase['app_migrations'][]> {
    return db()
      .selectFrom(APP_MIGRATIONS_TABLE)
      .selectAll()
      .orderBy('id')
      .execute();
  }

  function errorReport(): MigrationErrorReport {
    return JSON.parse(
      readFileSync(join(userDataDir, MIGRATION_ERROR_FILE), 'utf8'),
    ) as MigrationErrorReport;
  }

  it('applies pending migrations once and records them in app_migrations', async () => {
    const migrations = [
      createsTable('0001-alpha', 'alpha'),
      createsTable('0002-beta', 'beta'),
    ];

    await expect(runner(migrations).run()).resolves.toEqual({
      applied: ['0001-alpha', '0002-beta'],
    });
    await expect(runner(migrations).run()).resolves.toEqual({ applied: [] });

    expect(await tables()).toEqual(
      expect.arrayContaining(['alpha', 'beta', APP_MIGRATIONS_TABLE]),
    );
    const rows = await journal();
    expect(rows.map((row) => [row.id, row.app_version])).toEqual([
      ['0001-alpha', '9.9.9'],
      ['0002-beta', '9.9.9'],
    ]);
    expect(lines).toEqual([
      `${MIGRATING_LINE_PREFIX} {"id":"0001-alpha","step":1,"of":2}`,
      `${MIGRATING_LINE_PREFIX} {"id":"0002-beta","step":2,"of":2}`,
    ]);
  });

  it('applies only what a profile has not applied yet', async () => {
    await runner([createsTable('0001-alpha', 'alpha')]).run();
    lines = [];

    await expect(
      runner([
        createsTable('0001-alpha', 'alpha'),
        createsTable('0002-beta', 'beta'),
      ]).run(),
    ).resolves.toEqual({ applied: ['0002-beta'] });
    expect(lines).toEqual([
      `${MIGRATING_LINE_PREFIX} {"id":"0002-beta","step":1,"of":1}`,
    ]);
  });

  it('rolls back every DB step of the launch when one fails and writes migration-error.json', async () => {
    const run = runner([
      createsTable('0001-alpha', 'alpha'),
      failing('0002-bad'),
    ]).run();

    await expect(run).rejects.toBeInstanceOf(MigrationFailedError);
    expect(await tables()).not.toContain('alpha');
    expect(await journal()).toEqual([]);
    expect(errorReport()).toMatchObject({
      id: '0002-bad',
      step: 2,
      of: 2,
      kind: 'database',
      message: 'boom',
      backupDir: null,
      appVersion: '9.9.9',
    });
  });

  it('removes the error report once a later launch migrates cleanly', async () => {
    await expect(runner([failing('0001-bad')]).run()).rejects.toThrow('boom');
    expect(existsSync(join(userDataDir, MIGRATION_ERROR_FILE))).toBe(true);

    await runner([createsTable('0001-bad', 'fixed')]).run();

    expect(existsSync(join(userDataDir, MIGRATION_ERROR_FILE))).toBe(false);
  });

  it('runs file steps only after the DB commit', async () => {
    const seen: string[][] = [];
    const fileStep: FileMigration = {
      id: '0001-files',
      kind: 'files',
      async up() {
        seen.push((await journal()).map((row) => row.id));
      },
      down: () => Promise.resolve(),
    };

    await runner([fileStep, createsTable('0002-alpha', 'alpha')]).run();

    expect(seen).toEqual([['0002-alpha']]);
    expect((await journal()).map((row) => row.id)).toEqual([
      '0001-files',
      '0002-alpha',
    ]);
    expect(lines).toEqual([
      `${MIGRATING_LINE_PREFIX} {"id":"0002-alpha","step":1,"of":2}`,
      `${MIGRATING_LINE_PREFIX} {"id":"0001-files","step":2,"of":2}`,
    ]);
  });

  it('runs no file step when a DB step fails', async () => {
    let ran = false;
    const fileStep: FileMigration = {
      id: '0002-files',
      kind: 'files',
      up: () => {
        ran = true;
        return Promise.resolve();
      },
      down: () => Promise.resolve(),
    };

    await expect(
      runner([failing('0001-bad'), fileStep]).run(),
    ).rejects.toThrow();

    expect(ran).toBe(false);
  });

  it('backs a rewritten file up and names the backup when the file step fails', async () => {
    const settings = join(userDataDir, 'settings.json');
    writeFileSync(settings, '{"a":1}');
    const fileStep: FileMigration = {
      id: '0001-rewrite',
      kind: 'files',
      up({ backup }) {
        backup(settings);
        writeFileSync(settings, '{"a":2}');
        return Promise.reject(new Error('half done'));
      },
      down: () => Promise.resolve(),
    };

    await expect(runner([fileStep]).run()).rejects.toThrow('half done');

    const { backupDir, kind } = errorReport();
    expect(kind).toBe('files');
    expect(backupDir).toMatch(/backups\/0001-rewrite-/);
    expect(readFileSync(join(backupDir ?? '', 'settings.json'), 'utf8')).toBe(
      '{"a":1}',
    );
    expect(await journal()).toEqual([]);
  });

  it("keeps a backed-up file's folder, so two files of one name never overwrite each other", async () => {
    mkdirSync(join(userDataDir, 'teams', 'team'), { recursive: true });
    const flat = join(userDataDir, 'teams', 'a.yaml');
    const nested = join(userDataDir, 'teams', 'team', 'a.yaml');
    writeFileSync(flat, 'flat');
    writeFileSync(nested, 'nested');
    const copies: string[] = [];
    const fileStep: FileMigration = {
      id: '0001-yaml',
      kind: 'files',
      up({ backup }) {
        copies.push(backup(flat), backup(nested));
        return Promise.resolve();
      },
      down: () => Promise.resolve(),
    };

    await runner([fileStep]).run();

    expect(copies.map((copy) => readFileSync(copy, 'utf8'))).toEqual([
      'flat',
      'nested',
    ]);
    expect(copies[1]).toMatch(/0001-yaml-[^/]+\/teams\/team\/a\.yaml$/);
  });

  it('refuses a registry that names one id twice', async () => {
    await expect(
      runner([createsTable('0001-a', 'a'), createsTable('0001-a', 'b')]).run(),
    ).rejects.toThrow('registered twice');
    expect(await tables()).not.toContain('a');
  });

  it('reverts one applied migration and forgets it', async () => {
    const migrations = [createsTable('0001-alpha', 'alpha')];
    await runner(migrations).run();

    await runner(migrations).revert('0001-alpha');

    expect(await tables()).not.toContain('alpha');
    expect(await journal()).toEqual([]);
    await expect(runner(migrations).revert('0001-alpha')).rejects.toThrow(
      'not applied',
    );
    await expect(runner(migrations).revert('0009-unknown')).rejects.toThrow(
      'no migration 0009-unknown',
    );
  });

  it('reverts an applied file migration outside any transaction and forgets it', async () => {
    let reverted = false;
    const fileStep: FileMigration = {
      id: '0001-files',
      kind: 'files',
      up: () => Promise.resolve(),
      down: () => {
        reverted = true;
        return Promise.resolve();
      },
    };
    await runner([fileStep]).run();

    await runner([fileStep]).revert('0001-files');

    expect(reverted).toBe(true);
    expect(await journal()).toEqual([]);
  });
});
