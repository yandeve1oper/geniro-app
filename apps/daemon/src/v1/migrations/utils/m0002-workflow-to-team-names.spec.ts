import { mkdtempSync, rmSync } from 'node:fs';
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
import { MigrationRunnerService } from '../services/migration-runner.service';
import { appMigrationsJournal } from './m0001-app-migrations-journal';
import {
  WORKFLOW_TO_TEAM_COLUMNS,
  WORKFLOW_TO_TEAM_TABLES,
  workflowToTeamNames,
} from './m0002-workflow-to-team-names';

type Row = Record<string, string | number | null>;

const PRE_M2_TABLES: Record<string, Row> = {
  runs: {
    id: 'run-1',
    workflow_id: 'dev-team',
    pending_workflow_proposal: '{"cardId":"c1"}',
    edits_workflow_slug: 'dev-team',
    workflow_instructions: 'edit the file',
    analysis_workflow_slug: 'dev-team',
    workflow_snapshot: '{"name":"Dev Team"}',
  },
  tasks: { id: 'task-1', workflow_slug: 'dev-team' },
  projects: { id: 'project-1', workflow_slug: 'dev-team' },
  run_groups: { id: 'group-1', auto_workflow_id: 'dev-team' },
  usage_activity: {
    id: 'activity-1',
    kind: 'thread',
    workflow_slug: 'dev-team',
    workflow_version: 'abc123',
    workflow_version_inferred: 0,
  },
  usage_events: { id: 'event-1', workflow_name: 'Dev Team' },
  workflow_versions: { slug: 'dev-team', version: 'abc123' },
  workflow_change_log: { id: 'log-1', slug: 'dev-team', changed_at: 'now' },
  workflow_recommendations: {
    id: 'rec-1',
    slug: 'dev-team',
    filed_at: 'now',
    chat_run_id: 'run-1',
    card_seq: 4,
    item_id: 'W-1',
  },
};

const PRE_M2_INDEXES: readonly {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
}[] = [
  {
    name: 'usage_activity_workflow_slug_kind_index',
    table: 'usage_activity',
    columns: ['workflow_slug', 'kind'],
    unique: false,
  },
  {
    name: 'workflow_change_log_slug_changed_at_index',
    table: 'workflow_change_log',
    columns: ['slug', 'changed_at'],
    unique: false,
  },
  {
    name: 'workflow_recommendations_slug_filed_at_index',
    table: 'workflow_recommendations',
    columns: ['slug', 'filed_at'],
    unique: false,
  },
  {
    name: 'workflow_recommendations_chat_run_id_card_seq_item_id_unique',
    table: 'workflow_recommendations',
    columns: ['chat_run_id', 'card_seq', 'item_id'],
    unique: true,
  },
];

const TEAM_INDEXES = [
  'usage_activity_team_slug_kind_index',
  'team_change_log_slug_changed_at_index',
  'team_recommendations_slug_filed_at_index',
  'team_recommendations_chat_run_id_card_seq_item_id_unique',
];

interface SqliteMaster {
  sqlite_master: { type: string; name: string; tbl_name: string };
}

describe('0002-workflow-to-team-names', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let userDataDir: string;

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
    userDataDir = mkdtempSync(join(tmpdir(), 'geniro-m0002-'));
  });

  afterEach(async () => {
    await orm.close(true);
    rmSync(userDataDir, { recursive: true, force: true });
  });

  const db = (): Kysely<Record<string, Row>> =>
    em.fork().getKysely<Record<string, Row>>();

  function runner(): MigrationRunnerService {
    return new MigrationRunnerService(em, {
      migrations: [appMigrationsJournal, workflowToTeamNames],
      userDataDir,
      appVersion: '9.9.9',
      writeLine: () => undefined,
    });
  }

  async function buildPreM2(): Promise<void> {
    for (const [table, row] of Object.entries(PRE_M2_TABLES)) {
      let create = db().schema.createTable(table);
      for (const [column, value] of Object.entries(row)) {
        create = create.addColumn(
          column,
          typeof value === 'number' ? 'integer' : 'text',
        );
      }
      await create.execute();
      await db().insertInto(table).values(row).execute();
    }
    for (const index of PRE_M2_INDEXES) {
      const create = db()
        .schema.createIndex(index.name)
        .on(index.table)
        .columns(index.columns);
      await (index.unique ? create.unique() : create).execute();
    }
  }

  async function columns(): Promise<Map<string, string[]>> {
    const tables = await db().introspection.getTables();
    return new Map(
      tables.map((table) => [
        table.name,
        table.columns.map((column) => column.name),
      ]),
    );
  }

  async function indexes(): Promise<string[]> {
    const rows = await em
      .fork()
      .getKysely<SqliteMaster>()
      .selectFrom('sqlite_master')
      .select('name')
      .where('type', '=', 'index')
      .where('name', 'not like', 'sqlite_autoindex_%')
      .execute();
    return rows.map((row) => row.name).sort();
  }

  async function value(table: string, column: string): Promise<unknown> {
    const row = await db()
      .selectFrom(table)
      .select(column)
      .executeTakeFirstOrThrow();
    return row[column];
  }

  it("keeps every renamed column's data", async () => {
    await buildPreM2();

    await runner().run();

    const after = await columns();
    for (const [from, to] of WORKFLOW_TO_TEAM_TABLES) {
      expect(after.has(from)).toBe(false);
      expect(after.has(to)).toBe(true);
    }
    for (const [table, from, to] of WORKFLOW_TO_TEAM_COLUMNS) {
      expect(after.get(table)).not.toContain(from);
      expect(await value(table, to)).toBe(PRE_M2_TABLES[table]?.[from]);
    }
    expect(await value('team_versions', 'version')).toBe('abc123');
    expect(await value('team_change_log', 'slug')).toBe('dev-team');
    expect(await value('team_recommendations', 'item_id')).toBe('W-1');
    expect(await indexes()).toEqual([...TEAM_INDEXES].sort());
  });

  it('keeps the unique index unique under its new name', async () => {
    await buildPreM2();
    await runner().run();

    await expect(
      db()
        .insertInto('team_recommendations')
        .values({ ...PRE_M2_TABLES.workflow_recommendations, id: 'rec-2' })
        .execute(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('down restores the old names', async () => {
    await buildPreM2();
    await runner().run();

    await runner().revert(workflowToTeamNames.id);

    const after = await columns();
    for (const [from, to] of WORKFLOW_TO_TEAM_TABLES) {
      expect(after.has(to)).toBe(false);
      expect(after.has(from)).toBe(true);
    }
    for (const [table, from, to] of WORKFLOW_TO_TEAM_COLUMNS) {
      const name = WORKFLOW_TO_TEAM_TABLES.find(([, t]) => t === table)?.[0];
      expect(after.get(name ?? table)).not.toContain(to);
      expect(await value(name ?? table, from)).toBe(
        PRE_M2_TABLES[table]?.[from],
      );
    }
    expect(await indexes()).toEqual(
      PRE_M2_INDEXES.map((index) => index.name).sort(),
    );
  });

  it('does nothing on a fresh profile, where no source table exists yet', async () => {
    await expect(runner().run()).resolves.toEqual({
      applied: ['0001-app-migrations-journal', '0002-workflow-to-team-names'],
    });

    expect([...(await columns()).keys()]).toEqual(['app_migrations']);
  });
});
