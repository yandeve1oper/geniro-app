import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { RunDao } from '../../agents/dao/run.dao';
import { Run } from '../../runs/entity/run.entity';
import { MAX_AVATAR_BYTES } from '../teams.types';
import { TEAM_BACKUP_DIR } from '../utils/team-backup';
import {
  AVATAR_SWEEP_GRACE_MS,
  avatarIdsIn,
  AvatarStoreService,
} from './avatar-store.service';

/** A removal the next `rm` waits on, to hold a sweep between its check and its delete. */
const { rmGate } = vi.hoisted(() => ({
  rmGate: {
    next: null as null | { reached: () => void; release: Promise<void> },
  },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>): Promise<void> => {
      const gate = rmGate.next;
      if (gate !== null) {
        rmGate.next = null;
        gate.reached();
        await gate.release;
      }
      return actual.rm(...args);
    },
  };
});

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(tag: string): Buffer {
  return Buffer.concat([PNG_HEAD, Buffer.from(tag)]);
}

const idOf = (bytes: Buffer, extension = 'png'): string =>
  `${createHash('sha256').update(bytes).digest('hex')}.${extension}`;

describe('AvatarStoreService', () => {
  let orm: MikroORM;
  let dir: string;
  let service: AvatarStoreService;
  let now: number;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run],
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    dir = await mkdtemp(join(tmpdir(), 'geniro-avatars-'));
    now = Date.now();
    service = new AvatarStoreService(new RunDao(orm.em.fork()), {
      root: join(dir, 'avatars'),
      teamsDir: join(dir, 'teams'),
      now: () => now,
    });
    await mkdir(join(dir, 'teams', TEAM_BACKUP_DIR), { recursive: true });
  });

  afterEach(async () => {
    rmGate.next = null;
    await rm(dir, { recursive: true, force: true });
  });

  async function savedLongAgo(tag: string): Promise<string> {
    const id = await service.save(pngBytes(tag));
    const old = new Date(now - AVATAR_SWEEP_GRACE_MS - 60_000);
    await utimes(join(dir, 'avatars', id), old, old);
    return id;
  }

  const stored = (): Promise<string[]> => readdir(join(dir, 'avatars'));

  it('names a picture by the sha256 of its bytes and writes it once', async () => {
    const bytes = pngBytes('same');

    const first = await service.save(bytes);
    const second = await service.save(Buffer.from(bytes));

    expect(first).toBe(idOf(bytes));
    expect(second).toBe(first);
    expect(await stored()).toEqual([first]);
    expect(await service.read(first)).toEqual({
      mediaType: 'image/png',
      base64: bytes.toString('base64'),
    });
  });

  it('takes a picture of exactly 1 MB and refuses one byte more', async () => {
    const exact = Buffer.concat([
      PNG_HEAD,
      Buffer.alloc(MAX_AVATAR_BYTES - PNG_HEAD.byteLength),
    ]);

    expect(await service.save(exact)).toBe(idOf(exact));
    await expect(
      service.save(Buffer.concat([exact, Buffer.from([0])])),
    ).rejects.toMatchObject({ code: 'AVATAR_TOO_LARGE' });
  });

  it('keeps a picture saved again while a sweep is deleting it', async () => {
    const id = await savedLongAgo('raced');
    let reached!: () => void;
    let release!: () => void;
    const atDelete = new Promise<void>((resolve) => {
      reached = resolve;
    });
    rmGate.next = {
      reached: () => reached(),
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };

    const sweeping = service.sweep([id]);
    await atDelete;
    const saving = service.save(pngBytes('raced'));
    expect(
      await Promise.race([
        saving.then(() => 'saved'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 50)),
      ]),
    ).toBe('waiting');
    release();

    expect(await sweeping).toBe(1);
    expect(await saving).toBe(id);
    expect(await stored()).toEqual([id]);
  });

  it('restarts the grace of a picture saved again', async () => {
    const id = await savedLongAgo('again');

    await service.save(pngBytes('again'));

    expect(await service.sweep([id])).toBe(0);
    expect(await stored()).toEqual([id]);
  });

  it('never reads a file outside its folder, however the id climbs out', async () => {
    const outside = pngBytes('outside the avatars folder');
    await writeFile(join(dir, 'outside.png'), outside);

    await expect(service.read('../outside.png')).rejects.toMatchObject({
      code: 'AVATAR_NOT_FOUND',
    });
    await expect(service.sweep(['../outside.png'])).resolves.toBe(0);
    expect((await stat(join(dir, 'outside.png'))).isFile()).toBe(true);
  });

  it('answers not found for a well-formed id with no file', async () => {
    await expect(
      service.read(idOf(pngBytes('never saved'))),
    ).rejects.toMatchObject({ code: 'AVATAR_NOT_FOUND' });
  });

  it('finds every picture id a team file names', () => {
    const a = idOf(pngBytes('a'));
    const b = idOf(pngBytes('b'), 'webp');
    expect(
      avatarIdsIn(
        `- avatar:\n    kind: picture\n    value: ${a}\n- value: ${b}\n`,
      ),
    ).toEqual(new Set([a, b]));
    expect(avatarIdsIn(null)).toEqual(new Set());
  });

  it('removes an old dropped picture no stored copy of a team names', async () => {
    const orphan = await savedLongAgo('orphan');

    expect(await service.sweep([orphan])).toBe(1);
    expect(await stored()).not.toContain(orphan);
  });

  it('keeps a picture a library team names', async () => {
    const id = await savedLongAgo('library');
    await writeFile(
      join(dir, 'teams', 'dev.team.yaml'),
      `members:\n  - avatar:\n      kind: picture\n      value: ${id}\n`,
    );

    expect(await service.sweep([id])).toBe(0);
    expect(await stored()).toEqual([id]);
  });

  it('keeps a picture only a backup names', async () => {
    const id = await savedLongAgo('backup');
    await writeFile(
      join(dir, 'teams', TEAM_BACKUP_DIR, 'dev.2026-10-01T00-00-00.yaml'),
      `value: ${id}\n`,
    );

    expect(await service.sweep([id])).toBe(0);
    expect(await stored()).toEqual([id]);
  });

  it('keeps a picture only a run snapshot names', async () => {
    const id = await savedLongAgo('snapshot');
    const run = new Run();
    run.teamSnapshot = JSON.stringify({ members: [{ avatar: { value: id } }] });
    await orm.em.fork().persist(run).flush();

    expect(await service.sweep([id])).toBe(0);
    expect(await stored()).toEqual([id]);
  });

  it('keeps a picture younger than an hour that nothing names yet', async () => {
    const id = await service.save(pngBytes('fresh'));
    const justUnder = new Date(now - AVATAR_SWEEP_GRACE_MS + 60_000);
    await utimes(join(dir, 'avatars', id), justUnder, justUnder);

    expect(await service.sweep([id])).toBe(0);
    expect((await stat(join(dir, 'avatars', id))).isFile()).toBe(true);
  });

  it('sweeps an upload no team ever saved when it walks the whole folder', async () => {
    const neverSaved = await savedLongAgo('never saved');
    const named = await savedLongAgo('named');
    const fresh = await service.save(pngBytes('just uploaded'));
    await writeFile(join(dir, 'teams', 'dev.team.yaml'), `value: ${named}\n`);

    expect(await service.sweepAll()).toBe(1);
    expect((await stored()).sort()).toEqual([fresh, named].sort());
    expect(await stored()).not.toContain(neverSaved);
  });

  it('walks nothing and throws nothing when no picture was ever stored', async () => {
    await expect(service.sweepAll()).resolves.toBe(0);
  });

  it('looks only at the pictures a write dropped, never at others', async () => {
    const untouched = await savedLongAgo('untouched');
    const dropped = await savedLongAgo('dropped');

    expect(await service.sweep([dropped])).toBe(1);
    expect(await stored()).toEqual([untouched]);
  });

  it('removes only the unnamed one of two old dropped pictures', async () => {
    const kept = await savedLongAgo('kept');
    const dropped = await savedLongAgo('dropped');
    await writeFile(join(dir, 'teams', 'dev.team.yaml'), `value: ${kept}\n`);

    expect(await service.sweep([kept, dropped])).toBe(1);
    expect(await stored()).toEqual([kept]);
    expect(await stored()).not.toContain(dropped);
  });

  it('does not throw and removes nothing when the library cannot be read', async () => {
    const id = await savedLongAgo('stuck');
    await rm(join(dir, 'teams'), { recursive: true });
    await writeFile(join(dir, 'teams'), 'not a directory');

    expect(await service.sweep([id])).toBe(0);
    expect(await stored()).toHaveLength(1);
  });
});
