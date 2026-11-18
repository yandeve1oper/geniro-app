import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { RunDao } from '../../agents/dao/run.dao';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { fakeLiveWork } from '../__tests__/fake-live-work';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import { TASK_FILES_MAX } from '../tasks.types';
import { TaskAttachmentService } from './task-attachment.service';
import { TaskEventBus } from './task-events.bus';
import { TaskFilesService } from './task-files.service';
import { TasksService } from './tasks.service';

/**
 * The files a user binds to a card.
 *
 * REPORTED as the missing half — "я всё ещё не могу прицеплять файлы, например
 * zip-архивы, то есть как attachments". Real database and a real directory,
 * because what is under test is a path that has to EXIST and a column that has
 * to round-trip.
 */
/**
 * Where this spec's attachment deletes are aimed.
 *
 * Named explicitly rather than left to the service's default, which resolves
 * `environment.userDataDir` — the one shared resource the specs redirect for
 * themselves. Nothing is written here; the service only ever removes
 * `<root>/<task uuid>`, which cannot exist for a freshly minted id.
 */
const ATTACHMENTS_ROOT = join(tmpdir(), 'geniro-task-attachments-spec');

describe('TaskFilesService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let service: TaskFilesService;
  let tasks: TasksService;
  let dir: string;
  let taskId: string;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Project, Task],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await orm.schema.clear();
    dir = mkdtempSync(join(tmpdir(), 'geniro-files-'));
    em = orm.em.fork();
    const taskDao = new TaskDao(em);
    const projectDao = new ProjectDao(em);
    tasks = new TasksService(
      em,
      taskDao,
      projectDao,
      new TaskEventBus(),
      new TaskAttachmentService(ATTACHMENTS_ROOT),
      new RunDao(em),
      fakeLiveWork().liveWork,
    );
    service = new TaskFilesService(em, taskDao, tasks);
    const project = await projectDao.create({ name: 'B', folder: dir });
    await em.flush();
    const task = await tasks.create({ projectId: project.id, title: 'card' });
    taskId = task.id;
  });

  const write = (name: string): string => {
    const path = join(dir, name);
    writeFileSync(path, 'x');
    return path;
  };

  it('binds a file by PATH and states its size', async () => {
    const path = write('bundle.zip');

    const task = await service.attach(taskId, path);

    expect(task.attachments).toEqual([
      { id: expect.any(String), name: 'bundle.zip', path, bytes: 1 },
    ]);
  });

  it('refuses a path with no file behind it', async () => {
    // Checked HERE for the reason every other user-supplied path in this
    // daemon is: a card naming a file nobody can open would be discovered by
    // the agent, minutes later, one process away.
    await expect(
      service.attach(taskId, join(dir, 'not-there.zip')),
    ).rejects.toThrow(/no file at/);
  });

  it('refuses a DIRECTORY', async () => {
    await expect(service.attach(taskId, dir)).rejects.toThrow(/not a file/);
  });

  it('refuses a relative path', async () => {
    await expect(service.attach(taskId, 'bundle.zip')).rejects.toThrow(
      /absolute/,
    );
  });

  it('treats attaching the same file twice as the double-press it is', async () => {
    const path = write('bundle.zip');

    await service.attach(taskId, path);
    const task = await service.attach(taskId, path);

    expect(task.attachments).toHaveLength(1);
  });

  it('bounds the list, since it is read into the agent’s prompt', async () => {
    for (let i = 0; i < TASK_FILES_MAX; i += 1) {
      await service.attach(taskId, write(`f${i}.txt`));
    }

    await expect(service.attach(taskId, write('one-more.txt'))).rejects.toThrow(
      /at most/,
    );
  });

  it('detaches the reference and LEAVES THE FILE', async () => {
    // geniro did not put it there. A detach that deleted a user's own archive
    // would be unforgivable, and it is the one thing this service must never
    // do.
    const path = write('bundle.zip');
    const attached = await service.attach(taskId, path);

    const task = await service.detach(taskId, attached.attachments[0]!.id);

    expect(task.attachments).toEqual([]);
    expect(() => writeFileSync(path, 'still here')).not.toThrow();
  });

  /**
   * The files geniro STORES under a card — a phone's upload, an agent's
   * screenshot — where every other entry is a reference to the user's own.
   * Real directories throughout: what is under test is which bytes are left on
   * disk.
   */
  describe('files geniro stored itself', () => {
    let uploadsRoot: string;
    let withUploads: TaskFilesService;
    const bytes = Buffer.from('uploaded bytes').toString('base64');

    beforeEach(() => {
      uploadsRoot = join(dir, 'task-attachments');
      withUploads = new TaskFilesService(
        em,
        new TaskDao(em),
        tasks,
        new TaskAttachmentService(uploadsRoot),
      );
    });

    /** Every file under the card's own upload directory, at any depth. */
    const storedFiles = (): string[] => {
      const own = join(uploadsRoot, taskId);
      return existsSync(own)
        ? readdirSync(own, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
        : [];
    };

    it('refuses an upload to a full card before writing a byte', async () => {
      for (let i = 0; i < TASK_FILES_MAX; i += 1) {
        await withUploads.attach(taskId, write(`f${i}.txt`));
      }

      await expect(
        withUploads.upload(taskId, 'one-more.zip', bytes),
      ).rejects.toThrow(/at most/);
      expect(storedFiles()).toEqual([]);
    });

    it('deletes the stored bytes when the bind refuses them after all', async () => {
      // Two uploads racing for the last slot: both pass the early check, and
      // the bind's own check inside the transaction refuses one of them.
      const bind = vi
        .spyOn(withUploads, 'attach')
        .mockRejectedValueOnce(new Error('TOO_MANY_ATTACHMENTS'));

      await expect(
        withUploads.upload(taskId, 'notes.txt', bytes),
      ).rejects.toThrow('TOO_MANY_ATTACHMENTS');
      expect(bind).toHaveBeenCalledTimes(1);
      expect(storedFiles()).toEqual([]);
    });

    it('deletes an upload when it is detached', async () => {
      const card = await withUploads.upload(taskId, 'notes.txt', bytes);
      const [stored] = card.attachments;

      await withUploads.detach(taskId, stored!.id);

      expect(existsSync(stored!.path)).toBe(false);
      expect(storedFiles()).toEqual([]);
    });

    // `update_task` points the REPORT at the copy it keeps on the card, so
    // removing the copy with the list entry would break that picture.
    it('keeps a stored file the card’s report still shows', async () => {
      const card = await withUploads.upload(taskId, 'shot.png', bytes);
      const [stored] = card.attachments;
      await tasks.update(taskId, {
        report: `Done.\n\n![shot](${stored!.path})`,
      });

      await withUploads.detach(taskId, stored!.id);

      expect(existsSync(stored!.path)).toBe(true);
    });

    it('leaves a user’s own file where it is', async () => {
      const path = write('bundle.zip');
      const card = await withUploads.attach(taskId, path);

      await withUploads.detach(taskId, card.attachments[0]!.id);

      expect(existsSync(path)).toBe(true);
    });

    it('never deletes a user’s file a `..` path only appears to put under the card', async () => {
      const mine = write('mine.txt');
      mkdirSync(join(uploadsRoot, taskId), { recursive: true });
      // Lexically under the card's directory; on disk, `dir/mine.txt`. Spelled
      // as a string, since `join` would normalize the `..` away right here.
      const disguised = `${uploadsRoot}/${taskId}/../../mine.txt`;
      const card = await withUploads.attach(taskId, disguised);

      await withUploads.detach(taskId, card.attachments[0]!.id);

      expect(existsSync(mine)).toBe(true);
    });

    it('never deletes through a link planted inside the card’s directory', async () => {
      const elsewhere = join(dir, 'elsewhere');
      mkdirSync(elsewhere);
      const mine = join(elsewhere, 'mine.txt');
      writeFileSync(mine, 'x');
      mkdirSync(join(uploadsRoot, taskId), { recursive: true });
      symlinkSync(elsewhere, join(uploadsRoot, taskId, 'link'));
      const card = await withUploads.attach(
        taskId,
        join(uploadsRoot, taskId, 'link', 'mine.txt'),
      );

      await withUploads.detach(taskId, card.attachments[0]!.id);

      expect(existsSync(mine)).toBe(true);
    });
  });

  it('answers with the card when the id names nothing', async () => {
    // A double-press on remove, or a stale panel. Nothing to do is not an
    // error, and the caller redraws from the answer either way.
    const task = await service.detach(taskId, 'no-such-id');

    expect(task.attachments).toEqual([]);
  });
});
