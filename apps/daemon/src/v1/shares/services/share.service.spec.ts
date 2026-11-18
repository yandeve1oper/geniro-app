import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { BadRequestException } from '@packages/common';
import { Subject } from 'rxjs';
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
import type { HostWake, RunWire } from '../../agents/chat.types';
import type { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ArtifactPageService } from '../../agents/services/artifact-page.service';
import type { ArtifactStoreService } from '../../agents/services/artifact-store.service';
import { HostWakeBus } from '../../agents/services/host-wake.bus';
import type { ManagedCommandResult } from '../../agents/utils/managed-command';
import { ArtifactShareDao } from '../dao/artifact-share.dao';
import { ArtifactShare } from '../entity/artifact-share.entity';
import type {
  ShareAsker,
  ShareChangedEvent,
  ShareCommandRunner,
  ShareConfig,
  ShareDestination,
} from '../shares.types';
import { ShareService } from './share.service';
import { ShareEventBus } from './share-events.bus';
import type { ShareKeychain } from './share-keychain.service';

const RUN = '11111111-2222-4333-8444-555555555555';
const DAY = 24 * 60 * 60 * 1000;
const GCS: ShareDestination = {
  kind: 'gcs',
  id: 'company',
  name: 'Company',
  linkBase: 'https://artifacts.example.com',
  bucket: 'company-share',
  prefix: 'geniro',
};
const CONFIG: ShareConfig = {
  destinations: [GCS],
  defaultDestinationId: 'company',
  agentsMayShare: true,
  autoRevokeAfterDays: null,
};

function ok(partial: Partial<ManagedCommandResult> = {}): ManagedCommandResult {
  return { code: 0, stdout: '', stderr: '', timedOut: false, ...partial };
}

/** What gcloud 536 prints once the account's credentials were revoked. */
const REVOKED = ok({
  code: 1,
  stderr:
    'ERROR: (gcloud.auth.print-access-token) Your current active account [me@example.com] does not have any valid credentials\nPlease run:\n\n  $ gcloud auth login\n',
});

const ASKER: ShareAsker = {
  runId: '11111111-2222-4333-8444-555555555555',
  memberId: 'agent',
  conversationId: null,
  caller: 'agent',
  target: 'chat',
};

const isCheck = (args: readonly string[]): boolean =>
  args.includes('print-access-token');

/** The plaintext an uploaded envelope decrypts to under `key`. */
function decryptEnvelope(envelope: string, key: string): string {
  const match =
    /<script id="payload" type="application\/json">([^<]*)<\/script>/.exec(
      envelope,
    );
  const { iv, ct } = JSON.parse(match?.[1] ?? '{}') as {
    iv: string;
    ct: string;
  };
  const data = Buffer.from(ct, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'base64url'),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAAD(Buffer.from('geniro-share-v1'));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([
    decipher.update(data.subarray(0, data.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

function nth<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`no item ${index}`);
  }
  return item;
}

describe('ShareService', () => {
  let orm: MikroORM;
  let service: ShareService;
  let dao: ArtifactShareDao;
  let keys: Map<string, string>;
  let version: number;
  /** Every destination command run, with the uploaded envelope captured at upload time. */
  let commands: { args: string[]; envelope?: string }[];
  /** Every credential check run, and whether its stdout was discarded. */
  let checks: { args: string[]; discardStdout: boolean }[];
  let nextResult: (args: string[]) => ManagedCommandResult;
  let wakes: HostWake[];
  /** The artifacts the store still holds. */
  let stored: Set<string>;
  let changes: ShareChangedEvent[];
  let deleted: Subject<string>;
  let changed: Subject<RunWire[]>;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [ArtifactShare],
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
    keys = new Map();
    version = 1;
    commands = [];
    checks = [];
    stored = new Set(['report', 'notes']);
    wakes = [];
    changes = [];
    deleted = new Subject();
    changed = new Subject();
    nextResult = () => ok();
    dao = new ArtifactShareDao(orm.em.fork());
    const run: ShareCommandRunner = (command) => {
      if (isCheck(command.args)) {
        checks.push({
          args: [command.command, ...command.args],
          discardStdout: command.discardStdout === true,
        });
        return Promise.resolve(nextResult(command.args));
      }
      const upload = command.args.includes('cp');
      commands.push({
        args: [command.command, ...command.args],
        ...(upload
          ? {
              envelope: readFileSync(
                command.args.find((arg) => arg.startsWith('/')) ?? '',
                'utf8',
              ),
            }
          : {}),
      });
      return Promise.resolve(nextResult(command.args));
    };
    service = new ShareService(
      dao,
      {
        latest: (runId: string, artifactId: string) =>
          runId === RUN && stored.has(artifactId)
            ? { version, key: 'serving-key' }
            : null,
      } as unknown as ArtifactStoreService,
      {
        document: (_r: string, _a: string, v: number) =>
          `<!DOCTYPE html><html><head></head><body><p>secret-report v${v}</p></body></html>`,
      } as unknown as ArtifactPageService,
      {
        write: (id: string, key: string) => {
          keys.set(id, key);
          return Promise.resolve();
        },
        read: (id: string) => Promise.resolve(keys.get(id) ?? null),
        delete: (id: string) => {
          keys.delete(id);
          return Promise.resolve();
        },
      } as unknown as ShareKeychain,
      run,
      events,
      hostWakes,
      {
        allDeleted: () => deleted.asObservable(),
        allChanged: () => changed.asObservable(),
      } as unknown as AgentEventBus,
    );
    service.onModuleInit();
  });

  const events = new ShareEventBus();
  events.allChanges().subscribe((event) => changes.push(event));
  const hostWakes = new HostWakeBus();
  hostWakes.subscribe((wake) => wakes.push(wake));

  const share = (by: 'user' | 'agent' = 'user') =>
    service.share({ runId: RUN, artifactId: 'report', title: 'Report', by });

  /** A live share row first made at `createdAt`, with its key in the Keychain. */
  const seedShare = async (
    artifactId: string,
    createdAt: number,
  ): Promise<ArtifactShare> => {
    const row = await dao.create({
      runId: RUN,
      artifactId,
      title: artifactId,
      destination: JSON.stringify(GCS),
      objectId: `object-${artifactId}`,
      linkBase: GCS.linkBase,
      sharedVersion: 1,
      sharedBy: 'agent',
      createdAt: new Date(createdAt),
    });
    keys.set(row.id, `key-${artifactId}`);
    return row;
  };

  it('shares nothing before Electron main has pushed the settings', async () => {
    await expect(share()).rejects.toThrow(/have not reached the daemon/);
    expect(commands).toHaveLength(0);
  });

  it('uploads only ciphertext, which the link’s own key decrypts back to the page', async () => {
    service.setConfig(CONFIG);

    const { url, share: row } = await share();

    const key = /#k=(.+)$/.exec(url ?? '')?.[1] ?? '';
    expect(url).toMatch(
      /^https:\/\/artifacts\.example\.com\/geniro\/[0-9a-f]{32}\/index\.html#k=[A-Za-z0-9_-]{43}$/,
    );
    const upload = nth(commands, 0);
    expect(upload.args.slice(0, 3)).toEqual(['gcloud', 'storage', 'cp']);
    expect(upload.envelope).not.toContain('secret-report');
    expect(decryptEnvelope(upload.envelope ?? '', key)).toContain(
      'secret-report v1',
    );
    expect(keys.get(row.id)).toBe(key);
    expect(row).toMatchObject({
      sharedVersion: 1,
      sharedBy: 'user',
      status: 'live',
    });
  });

  it('re-sharing keeps the link and uploads the newer version to the same object', async () => {
    service.setConfig(CONFIG);
    const first = await share();
    version = 2;

    const second = await share('agent');

    expect(second.url).toBe(first.url);
    expect(nth(commands, 1).args.at(-1)).toBe(nth(commands, 0).args.at(-1));
    const key = /#k=(.+)$/.exec(second.url ?? '')?.[1] ?? '';
    expect(decryptEnvelope(nth(commands, 1).envelope ?? '', key)).toContain(
      'v2',
    );
    expect(await service.list(RUN)).toEqual([
      expect.objectContaining({ sharedVersion: 2, sharedBy: 'agent' }),
    ]);
  });

  it('a failed first upload leaves no row and no key behind, and says why', async () => {
    service.setConfig(CONFIG);
    nextResult = () =>
      ok({ code: 1, stderr: 'ERROR: 403 permission denied\n' });

    // A 4xx: the exception filter would replace a 5xx's reason with a generic one.
    await expect(share()).rejects.toBeInstanceOf(BadRequestException);
    await expect(share()).rejects.toThrow(/403 permission denied/);

    expect(await service.list()).toEqual([]);
    expect(keys.size).toBe(0);
  });

  it('two presses at once share once, through the per-page lock', async () => {
    service.setConfig(CONFIG);

    const [a, b] = await Promise.all([share(), share()]);

    expect(a.url).toBe(b.url);
    expect(await service.list()).toHaveLength(1);
  });

  describe('revoke', () => {
    it('deletes the object, then the key, then the row', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();

      expect(await service.revoke(row.id)).toEqual({ status: 'revoked' });

      expect(nth(commands, 1).args.slice(0, 3)).toEqual([
        'gcloud',
        'storage',
        'rm',
      ]);
      expect(keys.has(row.id)).toBe(false);
      expect(await service.list()).toEqual([]);
    });

    it('keeps the row and the key when the remote delete fails, so a retry can still delete it', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();
      nextResult = () => ok({ code: 1, stderr: 'ERROR: network unreachable' });

      expect(await service.revoke(row.id)).toEqual({
        status: 'revoke-failed',
        detail: 'ERROR: network unreachable',
      });

      expect(keys.has(row.id)).toBe(true);
      expect(await service.list()).toEqual([
        expect.objectContaining({ status: 'revoke-failed' }),
      ]);
    });

    it('treats gcloud’s “matched no objects” as already revoked', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();
      nextResult = () =>
        ok({
          code: 1,
          stderr:
            'ERROR: (gcloud.storage.rm) The following URLs matched no objects or files:\n-gs://x',
        });

      expect(await service.revoke(row.id)).toEqual({ status: 'revoked' });
      expect(await service.list()).toEqual([]);
    });

    it('keeps the key when a revoke timed out, whatever its output said', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();
      nextResult = () =>
        ok({ code: null, timedOut: true, stderr: 'No URLs matched' });

      expect(await service.revoke(row.id)).toMatchObject({
        status: 'revoke-failed',
      });
      expect(keys.has(row.id)).toBe(true);
    });

    it.each([
      [
        'a custom command',
        {
          kind: 'command',
          id: 'own',
          name: 'Own',
          linkBase: 'https://pages.example.com',
          upload: ['/usr/local/bin/put', '{file}', '{object}'],
          remove: ['/usr/local/bin/del', '{object}'],
        },
      ],
      [
        's3',
        {
          kind: 's3',
          id: 'own',
          name: 'Own',
          linkBase: 'https://pages.example.com',
          bucket: 'pages',
        },
      ],
    ] satisfies [string, ShareDestination][])(
      'judges %s by its exit status, even when its output reads like gcloud’s “gone”',
      async (_kind, own) => {
        service.setConfig({
          destinations: [own],
          defaultDestinationId: 'own',
          agentsMayShare: true,
          autoRevokeAfterDays: null,
        });
        const { share: row } = await share();
        nextResult = () => ok({ code: 1, stderr: 'ERROR: No URLs matched' });

        expect(await service.revoke(row.id)).toMatchObject({
          status: 'revoke-failed',
        });
        expect(keys.has(row.id)).toBe(true);
      },
    );

    it('revokes once when two revokes race, the second finding the row gone', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();

      const results = await Promise.all([
        service.revoke(row.id),
        service.revoke(row.id),
      ]);

      expect(results).toEqual([{ status: 'revoked' }, { status: 'revoked' }]);
      expect(commands.filter((c) => c.args.includes('rm'))).toHaveLength(1);
    });

    it('treats an object already gone as revoked', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();
      nextResult = () => ok({ code: 1, stderr: 'ERROR: No URLs matched' });

      expect(await service.revoke(row.id)).toEqual({ status: 'revoked' });
    });

    it('revokes from where the page was shared even after the destination left Settings', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();
      service.setConfig({
        ...CONFIG,
        destinations: [],
        defaultDestinationId: null,
      });

      await service.revoke(row.id);

      expect(nth(commands, 1).args).toContain(
        nth(commands, 0).args.at(-1) ?? 'missing',
      );
    });
  });

  describe('revokeAll', () => {
    it('revokes the pages named and carries on past one that fails', async () => {
      service.setConfig(CONFIG);
      const first = await seedShare('first', DAY);
      const failing = await seedShare('failing', DAY);
      const last = await seedShare('last', DAY);
      nextResult = (args) =>
        args.some((arg) => arg.includes(failing.objectId))
          ? ok({ code: 1, stderr: 'ERROR: permission denied' })
          : ok();

      expect(await service.revokeAll([first.id, failing.id, last.id])).toEqual({
        revoked: 2,
        failed: 1,
        detail: 'ERROR: permission denied',
      });

      expect(keys.has(first.id)).toBe(false);
      expect(keys.has(last.id)).toBe(false);
      expect(keys.has(failing.id)).toBe(true);
      expect(await service.list()).toEqual([
        expect.objectContaining({ id: failing.id, status: 'revoke-failed' }),
      ]);
    });

    it('leaves a page shared after the list was read alone', async () => {
      service.setConfig(CONFIG);
      const listed = await seedShare('listed', DAY);
      const newer = await seedShare('newer', DAY);

      expect(await service.revokeAll([listed.id])).toMatchObject({
        revoked: 1,
      });

      expect((await service.list()).map((s) => s.id)).toEqual([newer.id]);
      expect(keys.has(newer.id)).toBe(true);
    });

    it('counts a page already revoked as neither revoked nor failed', async () => {
      service.setConfig(CONFIG);
      const gone = await seedShare('gone', DAY);
      const live = await seedShare('live', DAY);
      await service.revoke(gone.id);

      expect(await service.revokeAll([gone.id, live.id])).toEqual({
        revoked: 1,
        failed: 0,
        detail: null,
      });
    });

    it('counts a revoke that throws as failed and goes on to the next page', async () => {
      service.setConfig(CONFIG);
      const unreadable = await seedShare('unreadable', DAY);
      await dao.updateById(unreadable.id, { destination: 'not json' });
      const live = await seedShare('live', DAY);

      expect(await service.revokeAll([unreadable.id, live.id])).toEqual({
        revoked: 1,
        failed: 1,
        detail: 'the destination this page was shared to could not be read',
      });
      expect(keys.has(live.id)).toBe(false);
    });
  });

  describe('revokeExpired', () => {
    const NOW = Date.parse('2026-10-22T12:00:00Z');

    const turnOn = (days: number | null): void => {
      service.setConfig({ ...CONFIG, autoRevokeAfterDays: days });
    };

    it('revokes only the pages first shared longer ago than the setting', async () => {
      const old = await seedShare('old', NOW - 31 * DAY);
      const recent = await seedShare('recent', NOW - 29 * DAY);
      turnOn(30);

      expect(await service.revokeExpired(NOW)).toEqual({
        revoked: 1,
        failed: 0,
        detail: null,
      });

      expect((await service.list()).map((s) => s.id)).toEqual([recent.id]);
      expect(keys.has(old.id)).toBe(false);
    });

    it('revokes nothing while the setting is off', async () => {
      await seedShare('old', NOW - 3650 * DAY);
      turnOn(null);

      expect(await service.revokeExpired(NOW)).toEqual({
        revoked: 0,
        failed: 0,
        detail: null,
      });
      expect(commands).toHaveLength(0);
    });

    it('revokes oldest first and stops once the setting is switched off mid-sweep', async () => {
      await seedShare('newer', NOW - 35 * DAY);
      const oldest = await seedShare('oldest', NOW - 40 * DAY);
      turnOn(30);
      nextResult = () => {
        service.setConfig({ ...CONFIG, autoRevokeAfterDays: null });
        return ok();
      };

      expect(await service.revokeExpired(NOW)).toMatchObject({ revoked: 1 });
      expect((await service.list()).map((s) => s.artifactId)).toEqual([
        'newer',
      ]);
      expect(keys.has(oldest.id)).toBe(false);
    });

    it('keeps a page the setting was lengthened to cover mid-sweep', async () => {
      await seedShare('a', NOW - 40 * DAY);
      await seedShare('b', NOW - 35 * DAY);
      turnOn(30);
      nextResult = () => {
        service.setConfig({ ...CONFIG, autoRevokeAfterDays: 38 });
        return ok();
      };

      expect(await service.revokeExpired(NOW)).toMatchObject({ revoked: 1 });
      expect((await service.list()).map((s) => s.artifactId)).toEqual(['b']);
    });

    it('resolves with nothing done when the shares cannot be read', async () => {
      turnOn(30);
      vi.spyOn(dao, 'sharedBefore').mockRejectedValueOnce(
        new Error('SQLITE_BUSY'),
      );

      await expect(service.revokeExpired(NOW)).resolves.toEqual({
        revoked: 0,
        failed: 0,
        detail: null,
      });
    });

    it('never sweeps on a settings push, so a shorter window waits for the timer', async () => {
      const old = await seedShare('old', Date.now() - 400 * DAY);
      // A sweep reads the shares synchronously as it starts.
      const sweeps = vi.spyOn(dao, 'sharedBefore');

      turnOn(30);
      turnOn(7);

      expect(sweeps).not.toHaveBeenCalled();
      expect((await service.list()).map((s) => s.id)).toEqual([old.id]);
    });

    describe('the timer', () => {
      beforeEach(() => {
        vi.useFakeTimers({
          toFake: [
            'setTimeout',
            'clearTimeout',
            'setInterval',
            'clearInterval',
          ],
        });
      });

      afterEach(() => {
        service.onApplicationShutdown();
        vi.useRealTimers();
      });

      it('sweeps a minute after the start, then every six hours until shutdown', async () => {
        turnOn(30);
        const old = await seedShare('old', Date.now() - 400 * DAY);
        const sweeps = vi.spyOn(dao, 'sharedBefore');
        service.onModuleInit();

        vi.advanceTimersByTime(60 * 1000 - 1);
        expect(sweeps).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(sweeps).toHaveBeenCalledTimes(1);
        await service.revokeExpired();
        expect(keys.has(old.id)).toBe(false);

        vi.advanceTimersByTime(6 * 60 * 60 * 1000 - 60 * 1000 - 1);
        expect(sweeps).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(sweeps).toHaveBeenCalledTimes(2);
        await service.revokeExpired();

        service.onApplicationShutdown();
        const after = await seedShare('after', Date.now() - 400 * DAY);
        vi.advanceTimersByTime(6 * 60 * 60 * 1000);

        expect(sweeps).toHaveBeenCalledTimes(2);
        expect(keys.has(after.id)).toBe(true);
      });
    });
  });

  describe('shareForAgent', () => {
    const agent = (remote = false) =>
      service.shareForAgent(
        { runId: RUN, artifactId: 'report', title: 'Report' },
        remote,
      );

    it.each([
      ['a paired device', CONFIG, true, /only available on the Mac/],
      [
        'the switch off',
        { ...CONFIG, agentsMayShare: false },
        false,
        /not allowed agents/,
      ],
      [
        'no default destination',
        { ...CONFIG, defaultDestinationId: null },
        false,
        /no default place/,
      ],
    ])(
      'refuses with %s and uploads nothing',
      async (_name, config, remote, reason) => {
        service.setConfig(config);

        const outcome = await agent(remote);

        expect(outcome).toEqual({
          kind: 'not-shared',
          reason: expect.stringMatching(reason),
        });
        expect(commands).toHaveLength(0);
      },
    );

    it('returns the link when allowed, recorded as shared by the agent', async () => {
      service.setConfig(CONFIG);

      const outcome = await agent();

      expect(outcome).toEqual({
        kind: 'shared',
        url: expect.stringContaining('#k='),
      });
      expect(await service.list()).toEqual([
        expect.objectContaining({ sharedBy: 'agent' }),
      ]);
    });

    it('turns a failed upload into a reason rather than an error', async () => {
      service.setConfig(CONFIG);
      nextResult = () => ok({ code: 1, stderr: 'gcloud: not logged in' });

      expect(await agent()).toEqual({
        kind: 'not-shared',
        reason: expect.stringContaining('not logged in'),
      });
    });

    it('bakes in the theme of the user’s last press', async () => {
      service.setConfig(CONFIG);
      await service.share({
        runId: RUN,
        artifactId: 'report',
        title: 'Report',
        by: 'user',
        themeVars: { '--geniro-bg': '#123456' },
      });
      version = 2;

      const outcome = await agent();

      const key =
        outcome.kind === 'shared'
          ? (/#k=(.+)$/.exec(outcome.url)?.[1] ?? '')
          : '';
      expect(decryptEnvelope(nth(commands, 1).envelope ?? '', key)).toContain(
        '--geniro-bg: #123456;',
      );
    });
  });

  it('still lists a row whose destination cannot be read, and says why it cannot link', async () => {
    const row = await dao.create({
      runId: RUN,
      artifactId: 'broken',
      title: 'Broken',
      destination: '{',
      objectId: 'obj',
      linkBase: 'https://x.example',
      sharedVersion: 1,
      sharedBy: 'user',
    });
    keys.set(row.id, 'k'.repeat(43));

    expect(await service.list()).toEqual([
      expect.objectContaining({ id: row.id, destinationName: '' }),
    ]);
    await expect(service.link(row.id)).rejects.toThrow(/could not be read/);
  });

  describe('link', () => {
    it('reads back the same link the share returned', async () => {
      service.setConfig(CONFIG);
      const { url, share: row } = await share();

      expect(await service.link(row.id)).toEqual({ url });
    });

    it('refuses an unknown share', async () => {
      await expect(service.link('nope')).rejects.toThrow(/no such shared page/);
    });

    it('says the key is gone rather than minting a new one, for the link and a re-share', async () => {
      service.setConfig(CONFIG);
      const { share: row } = await share();
      keys.delete(row.id);

      await expect(service.link(row.id)).rejects.toThrow(
        /no longer in the Keychain/,
      );
      await expect(share()).rejects.toThrow(/no longer in the Keychain/);
      expect(keys.size).toBe(0);
    });
  });

  describe('check', () => {
    it('passes an empty place that gcloud reports as matching nothing', async () => {
      nextResult = (args) =>
        isCheck(args)
          ? ok({ stdout: 'ya29.live-token' })
          : ok({
              code: 1,
              stderr: 'ERROR: One or more URLs matched no objects.',
            });
      expect(await service.check(GCS)).toEqual({
        state: 'signed-in',
        detail: 'Reached Company.',
        signIn: { cli: 'gcloud', label: 'Google Cloud' },
      });
    });

    it('checks the credential with stdout discarded, then lists where pages go', async () => {
      await service.check(GCS);

      expect(checks).toEqual([
        {
          args: ['gcloud', 'auth', 'print-access-token'],
          discardStdout: true,
        },
      ]);
      expect(nth(commands, 0).args).toEqual([
        'gcloud',
        'storage',
        'ls',
        'gs://company-share/geniro/',
      ]);
    });

    it('says sign-in is required for a revoked login, and lists nothing', async () => {
      nextResult = (args) => (isCheck(args) ? REVOKED : ok());

      expect(await service.check(GCS)).toMatchObject({
        state: 'sign-in-required',
        detail: expect.stringContaining('does not have any valid credentials'),
      });
      expect(commands).toHaveLength(0);
    });

    it('offers no sign-in for a missing bucket or a missing CLI', async () => {
      nextResult = (args) =>
        isCheck(args)
          ? ok()
          : ok({
              code: 1,
              stderr:
                'ERROR: (gcloud.storage.ls) gs://company-share not found: 404.',
            });
      expect(await service.check(GCS)).toMatchObject({ state: 'check-failed' });

      nextResult = () => ok({ code: null, spawnError: 'spawn gcloud ENOENT' });
      expect(await service.check(GCS)).toMatchObject({
        state: 'check-failed',
        detail: expect.stringContaining('is its CLI installed'),
      });
    });

    it('says a custom command with no sign-in is not set up, and runs nothing', async () => {
      expect(
        await service.check({
          kind: 'command',
          id: 'own',
          name: 'Own',
          linkBase: 'https://pages.example.com',
          upload: ['/usr/local/bin/put', '{file}', '{object}'],
          remove: ['/usr/local/bin/del', '{object}'],
        }),
      ).toEqual({ state: 'not-set-up', signIn: null });
      expect([...commands, ...checks]).toHaveLength(0);
    });

    it('checks a custom command that runs gcloud with gcloud’s own check', async () => {
      nextResult = (args) => (isCheck(args) ? REVOKED : ok());
      expect(
        await service.check({
          kind: 'command',
          id: 'team',
          name: 'Team',
          linkBase: 'https://pages.example.com',
          upload: ['gcloud', 'storage', 'cp', '{file}', 'gs://team/{object}'],
          remove: ['gcloud', 'storage', 'rm', 'gs://team/{object}'],
        }),
      ).toMatchObject({
        state: 'sign-in-required',
        signIn: { cli: 'gcloud', label: 'Google Cloud' },
      });
    });
  });

  describe('a signed-out destination', () => {
    beforeEach(() => {
      service.setConfig(CONFIG);
    });

    const signedOut = (): void => {
      nextResult = (args) => (isCheck(args) ? REVOKED : ok());
    };
    const signedIn = (): void => {
      nextResult = () => ok();
    };
    const agent = () =>
      service.shareForAgent(
        { runId: RUN, artifactId: 'report', title: 'Report', asker: ASKER },
        false,
      );

    it('keeps a pressed share waiting on sign-in, uploads nothing, and keeps its key', async () => {
      signedOut();

      const { share: row, url } = await share();

      expect(url).toBeNull();
      expect(row).toMatchObject({
        status: 'awaiting-sign-in',
        sharedVersion: 0,
        signIn: { cli: 'gcloud', label: 'Google Cloud' },
        askedByAgent: false,
        lastError: expect.stringContaining(
          'does not have any valid credentials',
        ),
      });
      expect(commands).toHaveLength(0);
      expect(checks).toEqual([
        expect.objectContaining({ discardStdout: true }),
      ]);
      expect(keys.has(row.id)).toBe(true);
    });

    it('also waits when the check passed but the upload says the login lapsed', async () => {
      nextResult = (args) =>
        isCheck(args)
          ? ok()
          : ok({
              code: 1,
              stderr:
                'ERROR: (gcloud.storage.cp) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.',
            });

      expect((await share()).share.status).toBe('awaiting-sign-in');
    });

    it('after sign-in uploads the newest version to the link fixed at the first attempt', async () => {
      signedOut();
      const { share: row } = await share();
      const key = keys.get(row.id);
      signedIn();
      version = 3;

      expect(await service.retryAwaiting('company')).toEqual([row.id]);

      const { url } = await service.link(row.id);
      expect(url.endsWith(`#k=${key}`)).toBe(true);
      expect(
        decryptEnvelope(nth(commands, 0).envelope ?? '', key ?? ''),
      ).toContain('secret-report v3');
      expect(await service.list()).toEqual([
        expect.objectContaining({
          status: 'live',
          sharedVersion: 3,
          lastError: null,
        }),
      ]);
    });

    it('stays waiting when the CLI is still signed out, and retries nothing on its own', async () => {
      signedOut();
      await share();

      await service.retryAwaiting('company');
      await service.retryAwaiting('another-destination');

      expect(await service.list()).toEqual([
        expect.objectContaining({ status: 'awaiting-sign-in' }),
      ]);
      expect(checks).toHaveLength(2);
      expect(commands).toHaveLength(0);
    });

    it('tells an agent the user was asked to sign in, then wakes it with the link — never putting the link in the row', async () => {
      signedOut();
      expect(await agent()).toEqual({
        kind: 'awaiting-sign-in',
        label: 'Google Cloud',
      });
      expect(wakes).toHaveLength(0);
      signedIn();

      await service.retryAwaiting('company');

      const wake = nth(wakes, 0);
      const [row] = await service.list();
      const { url } = await service.link(row?.id ?? '');
      expect(wake.owner).toEqual(ASKER);
      expect(wake.prompt).toContain(`Shared link: ${url}`);
      expect(JSON.stringify(wake.row)).not.toContain('#k=');
      expect(wake.row.shares).toEqual([
        { shareId: row?.id, title: 'Report', outcome: 'shared' },
      ]);
    });

    it('marks the agent told only once its turn opened, and re-wakes at boot until then', async () => {
      signedOut();
      await agent();
      signedIn();
      await service.retryAwaiting('company');
      expect(await dao.listOwedWakes()).toHaveLength(1);

      await service.republishOwedWakes();
      expect(wakes).toHaveLength(2);

      nth(wakes, 1).onDelivered();
      await expect.poll(async () => (await dao.listOwedWakes()).length).toBe(0);
      await service.republishOwedWakes();
      expect(wakes).toHaveLength(2);
      expect(nth(await service.list(), 0).askedByAgent).toBe(false);
    });

    it('marks the share failed and wakes the agent with why when the retry fails for another reason', async () => {
      signedOut();
      await agent();
      nextResult = (args) =>
        isCheck(args)
          ? ok()
          : ok({
              code: 1,
              stderr:
                'ERROR: (gcloud.storage.cp) gs://company-share not found: 404.',
            });

      await service.retryAwaiting('company');

      expect(await service.list()).toEqual([
        expect.objectContaining({
          status: 'failed',
          sharedVersion: 0,
          lastError: expect.stringContaining('404'),
        }),
      ]);
      expect(nth(wakes, 0).prompt).toContain(
        'Not shared: ERROR: (gcloud.storage.cp)',
      );
      expect(nth(wakes, 0).row.shares?.[0]?.outcome).toBe('not-shared');
    });

    it('answers no link for a share never uploaded', async () => {
      signedOut();
      const { share: row } = await share();

      await expect(service.link(row.id)).rejects.toThrow(
        /has not been shared yet/,
      );
    });

    it('revokes a share never uploaded without any remote delete', async () => {
      signedOut();
      const { share: row } = await share();

      expect(await service.revoke(row.id)).toEqual({ status: 'revoked' });
      expect(commands).toHaveLength(0);
      expect(keys.has(row.id)).toBe(false);
      expect(await service.list()).toEqual([]);
    });

    it('drops a waiting share, and its key, when its chat is deleted', async () => {
      signedOut();
      const { share: row } = await share();

      deleted.next(RUN);

      await expect.poll(async () => (await service.list()).length).toBe(0);
      expect(keys.has(row.id)).toBe(false);
    });

    it('drops it when its chat is archived, but not on a rename', async () => {
      signedOut();
      await share();

      // A drop's first step is reading the run's shares, so a rename that
      // reads none started no drop at all.
      const reads = vi.spyOn(dao, 'list');
      changed.next([{ id: RUN, archivedAt: null } as unknown as RunWire]);
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore();
      expect(await service.list()).toHaveLength(1);

      changed.next([
        { id: RUN, archivedAt: new Date().toISOString() } as unknown as RunWire,
      ]);
      await expect.poll(async () => (await service.list()).length).toBe(0);
    });

    it('puts a re-share of a live page back to live, on the version it holds, when dropped', async () => {
      signedIn();
      await share();
      signedOut();
      version = 2;
      expect((await share()).share).toMatchObject({
        status: 'awaiting-sign-in',
        sharedVersion: 1,
      });

      deleted.next(RUN);

      await expect
        .poll(async () => (await service.list())[0]?.status)
        .toBe('live');
      expect(nth(await service.list(), 0).sharedVersion).toBe(1);
    });

    it('drops an agent’s waiting share left by an earlier daemon when the first push already has agents off', async () => {
      // As a previous launch left it: waiting on sign-in, asked by an agent.
      await dao.create({
        runId: RUN,
        artifactId: 'report',
        title: 'Report',
        destination: JSON.stringify(GCS),
        objectId: 'obj',
        linkBase: GCS.linkBase,
        sharedVersion: 0,
        sharedBy: 'agent',
        status: 'awaiting-sign-in',
        asker: JSON.stringify([ASKER]),
      });
      const fresh = new ShareService(
        dao,
        {} as ArtifactStoreService,
        {} as ArtifactPageService,
        {
          read: () => Promise.resolve(null),
          delete: () => Promise.resolve(),
        } as unknown as ShareKeychain,
        () => Promise.resolve(ok()),
        new ShareEventBus(),
        new HostWakeBus(),
        {
          allDeleted: () => deleted.asObservable(),
          allChanged: () => changed.asObservable(),
        } as unknown as AgentEventBus,
      );

      fresh.setConfig({ ...CONFIG, agentsMayShare: false });

      await expect.poll(async () => (await fresh.list()).length).toBe(0);
    });

    it('drops only agents’ waiting shares when the user stops letting agents share', async () => {
      signedOut();
      await agent();
      await service.share({
        runId: RUN,
        artifactId: 'notes',
        title: 'Notes',
        by: 'user',
      });

      service.setConfig({ ...CONFIG, agentsMayShare: false });

      await expect
        .poll(async () => (await service.list()).map((s) => s.artifactId))
        .toEqual(['notes']);
    });

    it('drops an agent’s waiting share at retry time when agents may no longer share, uploading nothing and waking nobody', async () => {
      signedOut();
      await agent();
      service.setConfig({ ...CONFIG, agentsMayShare: false });
      signedIn();

      expect(await service.retryAwaiting('company')).toEqual([]);

      expect(commands).toHaveLength(0);
      expect(wakes).toHaveLength(0);
      await expect.poll(async () => (await service.list()).length).toBe(0);
    });

    it('still shares an agent’s waiting page after sign-in when no default place is set any more — the row names its own', async () => {
      signedOut();
      await agent();
      service.setConfig({ ...CONFIG, defaultDestinationId: null });
      signedIn();

      await service.retryAwaiting('company');

      expect(await service.list()).toEqual([
        expect.objectContaining({ status: 'live' }),
      ]);
      expect(nth(wakes, 0).prompt).toContain('Shared link: https://');
    });

    it('wakes every agent that asked for a waiting page, not only the latest', async () => {
      signedOut();
      await agent();
      const other: ShareAsker = {
        ...ASKER,
        memberId: 'reviewer',
        caller: 'reviewer',
        target: 'team',
      };
      await service.shareForAgent(
        { runId: RUN, artifactId: 'report', title: 'Report', asker: other },
        false,
      );
      signedIn();

      await service.retryAwaiting('company');

      expect(wakes.map((w) => w.owner)).toEqual([ASKER, other]);
      expect(
        wakes.every((w) => w.prompt.includes('Shared link: https://')),
      ).toBe(true);
      // Told only once both wakes settled.
      nth(wakes, 0).onDelivered();
      await new Promise((resolve) => setImmediate(resolve));
      expect(nth(await service.list(), 0).askedByAgent).toBe(true);
      nth(wakes, 1).onDelivered();
      await expect
        .poll(async () => nth(await service.list(), 0).askedByAgent)
        .toBe(false);
    });

    it('settles each asker on its own: a boot re-sends only to the one whose wake never settled', async () => {
      signedOut();
      await agent();
      const other: ShareAsker = {
        ...ASKER,
        memberId: 'reviewer',
        caller: 'reviewer',
        target: 'team',
      };
      await service.shareForAgent(
        { runId: RUN, artifactId: 'report', title: 'Report', asker: other },
        false,
      );
      signedIn();
      await service.retryAwaiting('company');
      nth(wakes, 0).onDelivered();
      await expect
        .poll(async () =>
          JSON.parse((await dao.listOwedWakes())[0]?.asker ?? 'null'),
        )
        .toEqual([other]);
      wakes = [];

      await service.republishOwedWakes();

      expect(wakes.map((w) => w.owner)).toEqual([other]);
    });

    it('wakes a team asker stored before the rename, which names its run `workflow`', async () => {
      await dao.create({
        runId: RUN,
        artifactId: 'report',
        title: 'Report',
        destination: JSON.stringify(GCS),
        objectId: 'obj',
        linkBase: GCS.linkBase,
        sharedVersion: 1,
        sharedBy: 'agent',
        status: 'live',
        asker: JSON.stringify([{ ...ASKER, target: 'workflow' }]),
      });

      await service.republishOwedWakes();

      expect(wakes.map((w) => w.owner)).toEqual([{ ...ASKER, target: 'team' }]);
    });

    it('shares a never-uploaded page to the place Settings name now when its own place was removed', async () => {
      signedOut();
      await agent();
      const OTHER: ShareDestination = {
        ...GCS,
        id: 'other',
        name: 'Other',
        bucket: 'other-share',
      };
      service.setConfig({
        ...CONFIG,
        destinations: [OTHER],
        defaultDestinationId: 'other',
      });
      await expect
        .poll(async () => (await service.list())[0]?.status)
        .toBe('failed');
      signedIn();

      expect(await agent()).toEqual({
        kind: 'shared',
        url: expect.stringContaining('#k='),
      });

      const upload = commands.find((c) => c.args.includes('cp'));
      expect(upload?.args.join(' ')).toContain('gs://other-share/');
      expect(upload?.args.join(' ')).not.toContain('company-share');
      expect(await service.list()).toEqual([
        expect.objectContaining({ status: 'live', destinationId: 'other' }),
      ]);
    });

    it('withdraws a link held for a busy turn once agents may not share: the wake reports itself withdrawn', async () => {
      signedOut();
      await agent();
      signedIn();
      await service.retryAwaiting('company');
      const held = nth(wakes, 0);
      expect(held.withdrawn?.()).toBe(false);

      service.setConfig({ ...CONFIG, agentsMayShare: false });

      expect(held.withdrawn?.()).toBe(true);
    });

    it('withdraws a link not yet sent once the user turned agent sharing off, and never sends it', async () => {
      signedOut();
      await agent();
      signedIn();
      await service.retryAwaiting('company');
      expect(wakes).toHaveLength(1);
      service.setConfig({ ...CONFIG, agentsMayShare: false });

      await service.republishOwedWakes();

      expect(wakes).toHaveLength(1);
      await expect
        .poll(async () => nth(await service.list(), 0).askedByAgent)
        .toBe(false);
    });

    it('holds the boot sweep until the first settings push says whether agents may share', async () => {
      signedOut();
      await agent();
      signedIn();
      await service.retryAwaiting('company');
      const restarted = new ShareService(
        dao,
        {} as ArtifactStoreService,
        {} as ArtifactPageService,
        {
          read: (id: string) => Promise.resolve(keys.get(id) ?? null),
          delete: () => Promise.resolve(),
        } as unknown as ShareKeychain,
        () => Promise.resolve(ok()),
        new ShareEventBus(),
        hostWakes,
        {
          allDeleted: () => deleted.asObservable(),
          allChanged: () => changed.asObservable(),
        } as unknown as AgentEventBus,
      );
      const before = wakes.length;

      await restarted.republishOwedWakes();
      expect(wakes).toHaveLength(before);

      restarted.setConfig(CONFIG);
      await expect.poll(() => wakes.length).toBe(before + 1);
      expect(nth(wakes, before).prompt).toContain('Shared link: https://');
    });

    it('re-shares a page an agent already shared even when no default place is set any more', async () => {
      signedIn();
      expect((await agent()).kind).toBe('shared');
      service.setConfig({ ...CONFIG, defaultDestinationId: null });
      version = 2;

      expect(await agent()).toEqual({
        kind: 'shared',
        url: expect.stringContaining('#k='),
      });
      expect(nth(await service.list(), 0).sharedVersion).toBe(2);
    });

    it('fails a waiting share whose place was removed from Settings, and tells the agent why', async () => {
      signedOut();
      await agent();

      service.setConfig({
        ...CONFIG,
        destinations: [],
        defaultDestinationId: null,
      });

      await expect
        .poll(async () => (await service.list())[0]?.status)
        .toBe('failed');
      expect(nth(wakes, 0).prompt).toContain(
        'Not shared: the place it was being shared to was removed from Settings → Sharing',
      );
      expect(commands).toHaveLength(0);
    });

    it('fails a waiting share whose page is gone by the retry, and tells the agent why', async () => {
      signedOut();
      await agent();
      stored.delete('report');
      signedIn();

      await service.retryAwaiting('company');

      expect(commands).toHaveLength(0);
      expect(await service.list()).toEqual([
        expect.objectContaining({
          status: 'failed',
          lastError: 'this page is no longer stored, so it cannot be shared',
        }),
      ]);
      expect(nth(wakes, 0).prompt).toContain(
        'Not shared: this page is no longer stored, so it cannot be shared',
      );
    });

    it('asks the user once — on the write that puts an agent’s share into waiting — and never broadcasts a link', async () => {
      signedOut();
      await agent();
      await service.retryAwaiting('company');
      signedIn();
      await service.retryAwaiting('company');

      expect(changes.map((c) => c.signInRequested)).toEqual([
        true,
        ...changes.slice(1).map(() => false),
      ]);
      expect(changes.at(-1)).toMatchObject({
        status: 'live',
        askedByAgent: true,
      });
      expect(JSON.stringify(changes)).not.toContain('#k=');
      for (const key of keys.values()) {
        expect(JSON.stringify(changes)).not.toContain(key);
      }
    });
  });
});
