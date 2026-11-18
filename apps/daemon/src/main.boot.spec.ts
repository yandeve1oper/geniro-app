import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig, MikroORM } from '@mikro-orm/sqlite';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BOOT_TIMEOUT_MS, bootDaemon } from './__tests__/boot-daemon';
import { GENIRO_ORM_RUNTIME } from './db/sqlite.driver';
import { DAEMON_STOP_CAUSE_NAME, type DaemonInfo } from './utils/handshake';
import {
  APP_MIGRATIONS_TABLE,
  MIGRATING_LINE_PREFIX,
} from './v1/migrations/migrations.types';
import { MIGRATIONS } from './v1/migrations/utils/migration-registry';

/**
 * Boots the REAL daemon — the whole Nest container, from source, exactly as
 * `pnpm daemon:dev` does — and drives it from outside.
 *
 * Every other spec here builds the instance it tests by hand, so a break in
 * the framework underneath (a DI change, a lifecycle-order change, a library
 * pair that refuses to render the OpenAPI document) would ship green.
 */

const SOCKET_TIMEOUT_MS = 5_000;

let child: ChildProcess;
let userData: string;
let info: DaemonInfo;
let output = (): string => '';

const base = () => `http://${info.host}:${info.port}`;
const auth = () => ({ authorization: `Bearer ${info.token}` });

/**
 * `fetch`, with the response body read to its end before it is returned.
 *
 * A case that read only `status` left the body unread, and its connection
 * with it. The SIGTERM case's graceful close then waited on those
 * connections: at load average 90–180 the daemon was still up when the case
 * timed out in 5 runs of 21, and exited only at its own idle exit a minute
 * later. With every body read it exited in 36–226ms, 10 runs of 10.
 */
async function request(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  return new Response(await res.arrayBuffer(), {
    status: res.status,
    headers: res.headers,
  });
}

/** Bounds a socket wait below the test's own timeout, so a hang names its step. */
function within<T>(promise: Promise<T>, step: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ${step} within ${SOCKET_TIMEOUT_MS}ms`)),
      SOCKET_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'geniro-boot-spec-'));
  // What the UI leaves before it stops a daemon; this boot must consume it.
  writeFileSync(join(userData, DAEMON_STOP_CAUSE_NAME), 'quit');
  ({ child, info, output } = await bootDaemon(userData));
}, BOOT_TIMEOUT_MS + 5_000);

afterAll(() => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  rmSync(userData, { recursive: true, force: true });
});

describe('the daemon boots and serves', () => {
  it("consumes the UI's note of why the previous daemon stopped", () => {
    // Left on disk, it would label the NEXT unannounced stop — a SIGKILL read
    // as this quit, and the autopilot continuing work a crash cut off.
    expect(existsSync(join(userData, DAEMON_STOP_CAUSE_NAME))).toBe(false);
  });

  it('answers its readiness probe', async () => {
    const res = await request(`${base()}/health/check`);
    expect(res.status).toBe(200);
  });

  it('gates the REST API behind the launch token', async () => {
    expect((await request(`${base()}/v1/chats`)).status).toBe(403);
    expect(
      (await request(`${base()}/v1/chats`, { headers: auth() })).status,
    ).toBe(200);
  });

  it('builds the chat search index at boot — a search answers', async () => {
    // A missing table would make this a 500: `ChatTextIndexService.ensure`
    // only logs its own failure.
    const res = await request(`${base()}/v1/chats/search?query=hello`, {
      headers: auth(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hits: [], partialReason: null });
  });

  it('runs the migrations before the schema sync', async () => {
    expect(output()).toContain(
      `${MIGRATING_LINE_PREFIX} {"id":"0001-app-migrations-journal","step":1,"of":${MIGRATIONS.length}}`,
    );
    const orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: join(userData, 'geniro.db'),
        entities: [],
        discovery: { warnWhenNoEntities: false },
      }),
    );
    const db = orm.em.fork().getKysely<{
      sqlite_master: { name: string; type: string; rowid: number };
      app_migrations: { id: string };
    }>();
    try {
      // sqlite_master rows are appended as tables are created, so on this
      // fresh profile the journal coming first means it predates the sync.
      const tables = await db
        .selectFrom('sqlite_master')
        .select('name')
        .where('type', '=', 'table')
        .orderBy('rowid')
        .execute();
      expect(tables[0]?.name).toBe(APP_MIGRATIONS_TABLE);
      expect(tables.map((table) => table.name)).toContain('runs');
      const applied = await db
        .selectFrom('app_migrations')
        .select('id')
        .execute();
      expect(applied.map((row) => row.id).sort()).toEqual(
        MIGRATIONS.map((migration) => migration.id),
      );
    } finally {
      await orm.close(true);
    }
  });

  it('switches its database to WAL at boot', () => {
    // SQLite records the journal mode in the file's own header: bytes 18 and
    // 19 (the write and read format versions) are 2 in WAL mode, and 1 under
    // the rollback journal a new database starts in.
    const header = readFileSync(join(userData, 'geniro.db')).subarray(18, 20);
    expect([...header]).toEqual([2, 2]);
  });

  it('measures a draft team’s instruction sizes on its static route, not as a slug', async () => {
    const res = await request(`${base()}/v1/teams/instruction-sizes`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({
        team: {
          name: 'draft',
          mode: 'lead',
          members: [
            {
              id: 'solo',
              name: 'solo',
              agent: 'claude',
              approval: 'auto',
              instructions: 'INSTRUCTIONS',
            },
          ],
          triggers: [{ kind: 'first-message', member: 'solo' }],
          instructionBlocks: [],
        },
        customInstructions: 'MINE',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: { memberId: string; parts: { source: string }[] }[];
    };
    expect(body.members.map((member) => member.memberId)).toEqual(['solo']);
    expect(body.members[0]?.parts.map((part) => part.source)).toEqual([
      'preamble',
      'backgroundWorkNote',
      'customInstructions',
      'instructions',
    ]);
  });

  it('renders the OpenAPI document — and only for the launch token', async () => {
    // Every mount the gate covers: the UI, both documents (siblings of the
    // UI path, not children) and the Scalar reference.
    for (const path of [
      '/swagger-api',
      '/swagger-api-json',
      '/swagger-api-yaml',
      '/swagger-api/reference',
    ]) {
      expect((await request(`${base()}${path}`)).status).toBe(403);
      const wrong = await request(`${base()}${path}`, {
        headers: { authorization: 'Bearer wrong' },
      });
      expect(wrong.status).toBe(403);
      expect(
        (await request(`${base()}${path}`, { headers: auth() })).status,
      ).toBe(200);
    }
    const res = await request(`${base()}/swagger-api-json`, {
      headers: auth(),
    });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths?: Record<string, unknown> };
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThan(50);
  });

  it(
    'runs a gateway message handler for an authenticated socket',
    async () => {
      const socket: Socket = io(base(), {
        path: '/ws',
        auth: { token: info.token },
        transports: ['websocket'],
        reconnection: false,
      });
      const exceptions: unknown[] = [];
      socket.on('exception', (e: unknown) => exceptions.push(e));
      try {
        await within(
          new Promise<void>((resolve, reject) => {
            socket.once('connect', () => resolve());
            socket.once('connect_error', reject);
          }),
          'connect',
        );
        const echoed = await within(
          new Promise<unknown>((resolve) => {
            socket.once('echo', resolve);
            socket.emit('echo', { ping: 1 });
          }),
          'echo',
        );
        expect(echoed).toEqual({ ping: 1 });
        expect(exceptions).toEqual([]);
      } finally {
        socket.close();
      }
    },
    SOCKET_TIMEOUT_MS * 3,
  );

  it(
    'refuses a socket that presents the wrong token',
    async () => {
      const socket: Socket = io(base(), {
        path: '/ws',
        auth: { token: 'wrong' },
        transports: ['websocket'],
        reconnection: false,
      });
      try {
        const reason = await within(
          new Promise<string>((resolve) => {
            socket.once('disconnect', (why: string) => resolve(why));
          }),
          'disconnect',
        );
        expect(reason).toBe('io server disconnect');
      } finally {
        socket.close();
      }
    },
    SOCKET_TIMEOUT_MS * 2,
  );

  it('shuts down on SIGTERM and clears its pidfile and lock', async () => {
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    child.kill('SIGTERM');
    await exited;
    expect(existsSync(join(userData, 'daemon.json'))).toBe(false);
    expect(existsSync(join(userData, 'daemon.lock'))).toBe(false);
  }, 15_000);
});
