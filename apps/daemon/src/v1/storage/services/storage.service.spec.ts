import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { tempDir } from '../../agents/__tests__/temp-dir';
import { RunDao } from '../../agents/dao/run.dao';
import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import type { ChatService } from '../../agents/services/chat.service';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { TaskDao } from '../../tasks/dao/task.dao';
import { Task } from '../../tasks/entity/task.entity';
import type { StorageGroupId, StorageUsage } from '../storage.types';
import { ORPHAN_MIN_AGE_MS, StorageService } from './storage.service';

const NOW = Date.UTC(2026, 9, 31, 12);
const OLD = new Date(NOW - ORPHAN_MIN_AGE_MS - 60_000);
const SCANNED_AT = new Date(NOW).toISOString();

function write(path: string, bytes = 10): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x'.repeat(bytes));
}

function age(path: string, at: Date = OLD): void {
  utimesSync(path, at, at);
}

function group(usage: StorageUsage, id: StorageGroupId) {
  return usage.groups.find((g) => g.id === id);
}

describe('StorageService', () => {
  let orm: MikroORM;
  let root: string;
  let registry: ProcessRegistry;
  let sessions: { workingOffTurn: number };
  let freeDisk: number;
  let sweepArchivedBefore: ReturnType<
    typeof vi.fn<(cutoff: Date) => Promise<{ deleted: number }>>
  >;
  let vacuum: ReturnType<typeof vi.fn<(file: string) => Promise<void>>>;
  let service: StorageService;

  beforeEach(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, NodeState, Task],
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
        schemaGenerator: mikroOrmConfig.schemaGenerator,
      }),
    );
    await orm.schema.create();
    root = tempDir('storage-');
    registry = new ProcessRegistry();
    sessions = { workingOffTurn: 0 };
    freeDisk = 1024 ** 4;
    sweepArchivedBefore = vi.fn(async (_cutoff: Date) => ({ deleted: 2 }));
    vacuum = vi.fn(async (_file: string) => {});
    const adapters = {
      all: () =>
        new Map([
          [
            'cursor-agent',
            {
              getConfig: () => ({
                userData: {
                  conversations: ['cursor-sessions'],
                  caches: ['cursor-profiles'],
                  leftovers: ['cursor-probe.json'],
                },
              }),
            },
          ],
        ]),
    } as unknown as AgentAdapterRegistry;
    service = new StorageService(
      orm.em,
      { sweepArchivedBefore } as unknown as ChatService,
      registry,
      sessions as unknown as AgentSessionRegistry,
      adapters,
      new RunDao(orm.em),
      new TaskDao(orm.em),
      {
        root,
        databaseFile: join(root, 'geniro.db'),
        openLogFile: () => join(root, 'logs', 'geniro-daemon-open.jsonl'),
        vacuum,
        freeDiskBytes: async () => freeDisk,
        now: () => NOW,
      },
    );
  });

  afterEach(async () => {
    await orm.close(true);
  });

  async function settle(): Promise<void> {
    await vi.waitFor(() => {
      expect(service.job()?.state).not.toBe('running');
    });
  }

  it('files every name it knows by group and hands the rest to the desktop app', async () => {
    write(join(root, 'geniro.db'), 5000);
    write(join(root, 'cursor-sessions', 's1', 'store.db'));
    write(join(root, 'cursor-profiles', 'p1'));
    write(join(root, 'settings.json.bak-20260830'));
    write(join(root, 'cursor-probe.json'));
    write(join(root, 'task-reports', 'r.md'));
    write(join(root, 'daemon.json'));
    write(join(root, 'Cookies'));
    mkdirSync(join(root, 'worktrees', 'abc'), { recursive: true });

    const usage = await service.usage();

    expect(group(usage, 'database')?.entries.map((e) => e.name)).toEqual([
      'geniro.db',
    ]);
    expect(group(usage, 'agentSessions')?.entries.map((e) => e.name)).toEqual([
      'cursor-sessions',
    ]);
    expect(group(usage, 'caches')?.entries.map((e) => e.name)).toEqual([
      'cursor-profiles',
    ]);
    expect(group(usage, 'appState')?.entries.map((e) => e.name)).toEqual([
      'daemon.json',
    ]);
    expect(
      group(usage, 'leftovers')
        ?.entries.map((e) => e.name)
        .sort(),
    ).toEqual(['cursor-probe.json', 'task-reports']);
    expect(group(usage, 'settingsCopies')?.entries.map((e) => e.name)).toEqual([
      'settings.json.bak-20260830',
    ]);
    expect(usage.unclaimed).toEqual(['Cookies', 'worktrees']);
    expect(group(usage, 'agentSessions')?.clean).toEqual([]);
  });

  it('keeps the library the rename moved out of as app state, never a leftover', async () => {
    write(join(root, 'workflows', '.migrated', 'dev-team.geniro.yaml'));

    const usage = await service.usage();

    expect(group(usage, 'appState')?.entries.map((e) => e.name)).toEqual([
      'workflows',
    ]);
    expect(group(usage, 'leftovers')?.entries ?? []).toEqual([]);
    expect(usage.unclaimed).toEqual([]);
  });

  it('files member pictures with the teams, never as a leftover or unclaimed', async () => {
    write(join(root, 'avatars', `${'a'.repeat(64)}.png`), 4_000);

    const usage = await service.usage();

    expect(group(usage, 'teams')?.entries.map((e) => e.name)).toEqual([
      'avatars',
    ]);
    expect(group(usage, 'leftovers')?.entries ?? []).toEqual([]);
    expect(usage.unclaimed).toEqual([]);
  });

  it('counts team backups apart from the teams and never twice', async () => {
    write(join(root, 'teams', 'a.team.yaml'), 100);
    write(join(root, 'teams', '.backups', 'a.2026.yaml'), 50_000);
    write(join(root, 'teams', '.backups', 'a.2027.yaml'), 50_000);

    const usage = await service.usage();
    const backups = group(usage, 'teamBackups')!;
    const teams = group(usage, 'teams')!;

    expect(backups.bytes).toBeGreaterThanOrEqual(100_000);
    expect(teams.bytes).toBeLessThan(backups.bytes);
    expect(backups.clean).toEqual([
      expect.objectContaining({ target: 'teamBackups', count: 2 }),
    ]);
    expect(backups.clean[0]!.bytes).toBeGreaterThanOrEqual(100_000);
  });

  it('counts the archived chats older than every period, never as a one-press clean-up', async () => {
    const dao = new RunDao(orm.em);
    const DAY = 24 * 60 * 60 * 1000;
    write(join(root, 'geniro.db'));
    await dao.create({ id: 'live' });
    await dao.create({ id: 'today', archivedAt: new Date(NOW) });
    await dao.create({ id: 'week-edge', archivedAt: new Date(NOW - 7 * DAY) });
    await dao.create({ id: 'month', archivedAt: new Date(NOW - 20 * DAY) });
    await dao.create({
      id: 'just-inside-30',
      archivedAt: new Date(NOW - 30 * DAY + 1),
    });
    await dao.create({ id: 'on-30', archivedAt: new Date(NOW - 30 * DAY) });
    await dao.create({ id: 'season', archivedAt: new Date(NOW - 75 * DAY) });
    await dao.create({ id: 'ancient', archivedAt: new Date(NOW - 400 * DAY) });

    const usage = await service.usage();

    expect(usage.chats.active).toBe(1);
    expect(usage.chats.archived).toBe(7);
    expect(
      usage.chats.archivedPeriods.map(({ days, count }) => [days, count]),
    ).toEqual([
      [7, 6],
      [30, 3],
      [60, 2],
      [90, 1],
      [null, 7],
    ]);
    expect(usage.chats.archivedPeriods[1]?.archivedBefore).toBe(
      new Date(NOW - 30 * DAY).toISOString(),
    );
    expect(usage.chats.archivedPeriods[4]?.archivedBefore).toBe(SCANNED_AT);
    expect(usage.scannedAt).toBe(SCANNED_AT);
    expect(group(usage, 'database')?.clean).not.toContainEqual(
      expect.objectContaining({ target: 'archivedChats' }),
    );
  });

  it("offers only an old folder whose chat no longer exists, a deleted chat's row counting as existing", async () => {
    const dao = new RunDao(orm.em);
    await dao.create({ id: 'kept' });
    await dao.create({ id: 'soft-deleted', deletedAt: new Date(NOW) });
    for (const name of ['kept', 'soft-deleted', 'gone', 'gone-recent']) {
      write(join(root, 'attachments', name, 'a.png'));
      age(join(root, 'attachments', name));
    }
    age(join(root, 'attachments', 'gone-recent'), new Date(NOW - 60_000));
    write(join(root, 'artifacts', 'gone-too', 'v1.html'));
    age(join(root, 'artifacts', 'gone-too'));

    const usage = await service.usage();

    expect(group(usage, 'chatFiles')?.clean).toEqual([
      expect.objectContaining({ target: 'orphanChatFiles', count: 2 }),
    ]);

    await service.start('orphanChatFiles');
    await settle();

    expect(existsSync(join(root, 'attachments', 'gone'))).toBe(false);
    expect(existsSync(join(root, 'artifacts', 'gone-too'))).toBe(false);
    expect(existsSync(join(root, 'attachments', 'gone-recent'))).toBe(true);
    expect(existsSync(join(root, 'attachments', 'kept'))).toBe(true);
    expect(existsSync(join(root, 'attachments', 'soft-deleted'))).toBe(true);
    expect(service.job()).toMatchObject({ state: 'done', removed: 2 });
  });

  it('removes every log file but the one being written', async () => {
    write(join(root, 'logs', 'geniro-daemon-old.jsonl'));
    write(join(root, 'logs', 'geniro-daemon-open.jsonl'));

    expect(group(await service.usage(), 'logs')?.clean).toEqual([
      expect.objectContaining({ target: 'logs', count: 1 }),
    ]);
    await service.start('logs');
    await settle();

    expect(existsSync(join(root, 'logs', 'geniro-daemon-old.jsonl'))).toBe(
      false,
    );
    expect(existsSync(join(root, 'logs', 'geniro-daemon-open.jsonl'))).toBe(
      true,
    );
  });

  it('removes the team backups and leaves the teams', async () => {
    write(join(root, 'teams', 'a.team.yaml'));
    write(join(root, 'teams', '.backups', 'a.2026.yaml'), 9000);

    await service.start('teamBackups');
    await settle();

    expect(existsSync(join(root, 'teams', '.backups', 'a.2026.yaml'))).toBe(
      false,
    );
    expect(existsSync(join(root, 'teams', 'a.team.yaml'))).toBe(true);
    expect(service.job()?.freedBytes).toBeGreaterThanOrEqual(9000);
  });

  it('removes the leftovers and keeps what the app still reads and the settings copies', async () => {
    write(join(root, 'task-reports', 'r.md'));
    write(join(root, 'cursor-probe.json'));
    write(join(root, 'settings.json.corrupt-2026'));
    write(join(root, 'daemon.json'));
    write(join(root, 'settings.json'));

    await service.start('leftovers');
    await settle();

    expect(existsSync(join(root, 'task-reports'))).toBe(false);
    expect(existsSync(join(root, 'cursor-probe.json'))).toBe(false);
    expect(existsSync(join(root, 'settings.json.corrupt-2026'))).toBe(true);
    expect(existsSync(join(root, 'daemon.json'))).toBe(true);
    expect(existsSync(join(root, 'settings.json'))).toBe(true);
  });

  it('removes the settings copies only on their own clean-up', async () => {
    write(join(root, 'settings.json.corrupt-2026'));
    write(join(root, 'settings.json.bak-2025'));
    write(join(root, 'settings.json'));

    await service.start('settingsCopies');
    await settle();

    expect(existsSync(join(root, 'settings.json.corrupt-2026'))).toBe(false);
    expect(existsSync(join(root, 'settings.json.bak-2025'))).toBe(false);
    expect(existsSync(join(root, 'settings.json'))).toBe(true);
  });

  it('deletes the archived chats up to the cutoff it is handed, through the chat sweep', async () => {
    await service.start('archivedChats', '2026-10-01T12:00:00.000Z');
    await settle();

    expect(sweepArchivedBefore).toHaveBeenCalledWith(
      new Date('2026-10-01T12:00:00.000Z'),
    );
    expect(service.job()).toMatchObject({ state: 'done', removed: 2 });
  });

  it('refuses to delete archived chats with no cutoff, and starts nothing', async () => {
    await expect(service.start('archivedChats')).rejects.toMatchObject({
      code: 'STORAGE_CUTOFF_REQUIRED',
    });

    expect(sweepArchivedBefore).not.toHaveBeenCalled();
    expect(service.job()).toBeNull();
  });

  it('schedules a compaction for the next start instead of running it', async () => {
    write(join(root, 'geniro.db'), 100_000);

    const job = await service.start('compactDatabase');

    expect(job.state).toBe('scheduled');
    expect(existsSync(join(root, 'compact-on-start'))).toBe(true);
    expect(vacuum).not.toHaveBeenCalled();
  });

  it('compacts at start when asked, once, and reports what it gave back', async () => {
    write(join(root, 'geniro.db'), 100_000);
    await service.start('compactDatabase');
    vacuum.mockImplementation(async () => {
      write(join(root, 'geniro.db'), 10);
    });

    await service.compactIfScheduled();
    await service.compactIfScheduled();

    expect(vacuum).toHaveBeenCalledTimes(1);
    expect(vacuum).toHaveBeenCalledWith(join(root, 'geniro.db'));
    expect(existsSync(join(root, 'compact-on-start'))).toBe(false);
    expect(service.job()).toMatchObject({
      target: 'compactDatabase',
      state: 'done',
    });
    expect(service.job()?.freedBytes).toBeGreaterThanOrEqual(90_000);
  });

  it('does not ask again after a compaction at start that failed', async () => {
    await service.start('compactDatabase');
    vacuum.mockRejectedValue(new Error('disk full'));

    await service.compactIfScheduled();

    expect(service.job()).toMatchObject({
      state: 'failed',
      error: 'disk full',
    });
    expect(existsSync(join(root, 'compact-on-start'))).toBe(false);
  });

  it('starts nothing else while a compaction waits for the restart', async () => {
    await service.start('compactDatabase');

    await expect(service.start('logs')).rejects.toMatchObject({
      code: 'STORAGE_BUSY',
    });
  });

  it('refuses to schedule a compaction the disk has no room for', async () => {
    write(join(root, 'geniro.db'), 100_000);
    freeDisk = 150_000;

    await expect(service.start('compactDatabase')).rejects.toMatchObject({
      code: 'STORAGE_NO_ROOM',
    });
    expect(existsSync(join(root, 'compact-on-start'))).toBe(false);
  });

  it('skips a scheduled compaction the disk has no room for by the start', async () => {
    write(join(root, 'geniro.db'), 100_000);
    await service.start('compactDatabase');
    freeDisk = 150_000;

    await service.compactIfScheduled();

    expect(vacuum).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'compact-on-start'))).toBe(false);
    expect(service.job()).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('free on the disk'),
    });
  });

  it('compacts nothing at a start nobody asked to compact', async () => {
    await service.compactIfScheduled();

    expect(vacuum).not.toHaveBeenCalled();
    expect(service.job()).toBeNull();
  });

  it('refuses to schedule a compaction while an agent works in a turn', async () => {
    registry.tryClaim('busy-run');

    await expect(service.start('compactDatabase')).rejects.toMatchObject({
      code: 'STORAGE_AGENTS_WORKING',
    });
    expect(existsSync(join(root, 'compact-on-start'))).toBe(false);
  });

  it('refuses to schedule a compaction while a kept agent works between turns', async () => {
    sessions.workingOffTurn = 1;

    await expect(service.start('compactDatabase')).rejects.toMatchObject({
      code: 'STORAGE_AGENTS_WORKING',
    });
    expect(existsSync(join(root, 'compact-on-start'))).toBe(false);
  });

  it('offers to compact the space deleted rows left in the file', async () => {
    const dao = new RunDao(orm.em);
    for (let i = 0; i < 40; i += 1) {
      await dao.create({ id: `bulky-${i}`, notes: 'x'.repeat(20_000) });
    }
    await orm.em.fork().nativeDelete(Run, {});
    write(join(root, 'geniro.db'));

    const database = group(await service.usage(), 'database');

    expect(database?.clean).toContainEqual({
      target: 'compactDatabase',
      count: 0,
      bytes: expect.any(Number),
    });
    const compact = database?.clean.find((o) => o.target === 'compactDatabase');
    expect(compact?.bytes).toBeGreaterThan(400_000);
  });

  it("offers only an old folder whose card no longer exists, a deleted card's row counting as existing", async () => {
    const tasks = new TaskDao(orm.em);
    const kept = await tasks.create({ projectId: 'p', title: 'kept' });
    const gone = await tasks.create({
      projectId: 'p',
      title: 'deleted',
      deletedAt: new Date(NOW),
    });
    for (const name of [kept.id, gone.id, 'orphan', 'orphan-recent']) {
      write(join(root, 'task-attachments', name, 'a.png'));
      age(join(root, 'task-attachments', name));
    }
    age(
      join(root, 'task-attachments', 'orphan-recent'),
      new Date(NOW - 60_000),
    );

    await service.start('orphanTaskFiles');
    await settle();

    expect(existsSync(join(root, 'task-attachments', 'orphan'))).toBe(false);
    expect(existsSync(join(root, 'task-attachments', 'orphan-recent'))).toBe(
      true,
    );
    expect(existsSync(join(root, 'task-attachments', kept.id))).toBe(true);
    expect(existsSync(join(root, 'task-attachments', gone.id))).toBe(true);
    expect(service.job()).toMatchObject({ state: 'done', removed: 1 });
  });

  it('refuses a second clean-up while one runs', async () => {
    let finish: () => void = () => {};
    sweepArchivedBefore.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ deleted: 0 });
        }),
    );
    void service.start('archivedChats', SCANNED_AT);

    await expect(service.start('logs')).rejects.toMatchObject({
      code: 'STORAGE_BUSY',
    });
    finish();
    await settle();
  });

  it('records a failed clean-up with its reason', async () => {
    sweepArchivedBefore.mockRejectedValue(new Error('disk full'));

    await service.start('archivedChats', SCANNED_AT);
    await settle();

    expect(service.job()).toMatchObject({
      state: 'failed',
      error: 'disk full',
    });
  });
});
