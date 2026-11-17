import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import {
  BadRequestException,
  InternalException,
  NotFoundException,
} from '@packages/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_ARTIFACT_ANSWERS_BYTES } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import { ArtifactStoreService } from './artifact-store.service';
import { ChatArtifactsService } from './chat-artifacts.service';

interface Row {
  seq: number;
  payload: string;
  createdAt: Date;
}

/**
 * `Item.payload` is a JSON TEXT column, so the DAO hands back a STRING. Rows
 * are built from `JSON.stringify` here for that reason and not for tidiness:
 * feeding this fold objects is a proxy the test fabricates, and under it a
 * reader that never parses passes every case while dropping every real row.
 */
function row(seq: number, payload: unknown): Row {
  return {
    seq,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    createdAt: new Date(seq * 1000),
  };
}

function artifact(
  artifactId: string,
  version: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    artifactId,
    version,
    title: `${artifactId} v${version}`,
    summary: null,
    key: 'k'.repeat(64),
    ...extra,
  };
}

/** The rows arrive oldest-first, exactly as `ItemDao.artifactRows` orders them. */
function build(
  rows: Row[],
  runExists = true,
  store = new ArtifactStoreService({ root: join(tmpdir(), 'unused') }),
): ChatArtifactsService {
  const em = { fork: () => em } as unknown as EntityManager;
  const runDao = {
    getById: () => Promise.resolve(runExists ? { id: 'run' } : null),
  } as unknown as RunDao;
  const itemDao = {
    artifactRows: () => Promise.resolve(rows),
  } as unknown as ItemDao;
  return new ChatArtifactsService(em, runDao, itemDao, store);
}

describe('ChatArtifactsService', () => {
  it('collapses every revision of one artifact to its newest row', async () => {
    const service = build([
      row(10, artifact('plan', 1)),
      row(20, artifact('plan', 2)),
      row(30, artifact('plan', 3)),
    ]);

    const { artifacts } = await service.read('run');

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      artifactId: 'plan',
      version: 3,
      seq: 30,
    });
  });

  it('lists one entry per artifact, newest first', async () => {
    const service = build([
      row(10, artifact('plan', 1)),
      row(20, artifact('chart', 1)),
      row(30, artifact('plan', 2)),
    ]);

    const { artifacts } = await service.read('run');

    expect(artifacts.map((a) => a.artifactId)).toEqual(['plan', 'chart']);
    expect(artifacts.map((a) => a.seq)).toEqual([30, 20]);
  });

  it('drops a row that cannot address a page, keeping the rest', async () => {
    const service = build([
      row(10, artifact('ok', 1)),
      row(20, { ...artifact('no-key', 1), key: '  ' }),
      row(30, { ...artifact('no-version', 1), version: 0 }),
      row(40, { ...artifact('no-title', 1), title: null }),
      row(50, 'not json at all'),
      row(60, JSON.stringify('a string, validly encoded')),
      row(70, JSON.stringify(null)),
    ]);

    const { artifacts } = await service.read('run');

    expect(artifacts.map((a) => a.artifactId)).toEqual(['ok']);
  });

  it('does NOT let an unreadable later row erase the page it superseded', async () => {
    // The fold keys by artifact and the last write wins — so a malformed row
    // must be dropped BEFORE it reaches the map, or republishing badly would
    // take a working page out of the panel.
    const service = build([
      row(10, artifact('plan', 1)),
      row(20, { ...artifact('plan', 2), key: null }),
    ]);

    const { artifacts } = await service.read('run');

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ artifactId: 'plan', version: 1 });
  });

  it('carries the row summary and the time it was published', async () => {
    const service = build([
      row(10, artifact('plan', 2, { summary: '  three phases  ' })),
    ]);

    const { artifacts } = await service.read('run');

    expect(artifacts[0]?.summary).toBe('three phases');
    expect(artifacts[0]?.at).toBe(new Date(10_000).toISOString());
  });

  it('refuses a run that does not exist', async () => {
    const service = build([], false);

    await expect(service.read('run')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ChatArtifactsService answers', () => {
  const RUN = '11111111-2222-4333-8444-555555555555';
  let root: string;
  let store: ArtifactStoreService;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'geniro-artifact-answers-'));
    store = new ArtifactStoreService({ root });
    await store.publish(RUN, {
      id: 'vote',
      title: 'Vote',
      html: '<p>vote</p>',
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('answers no values and no time for a page nobody answered', async () => {
    const service = build([], true, store);

    expect(await service.readAnswers(RUN, 'vote')).toEqual({
      values: {},
      updatedAt: null,
    });
  });

  it('merges what a save changed into what was kept, forgets an answer saved as null, and reads them back', async () => {
    const service = build([], true, store);

    await service.saveAnswers(RUN, 'vote', { 'call-1': 'agree', note: 'x' });
    const saved = await service.saveAnswers(RUN, 'vote', {
      'call-2': 'disagree',
      note: null,
    });
    const read = await service.readAnswers(RUN, 'vote');

    expect(read).toEqual(saved);
    expect(read.values).toEqual({ 'call-1': 'agree', 'call-2': 'disagree' });
    expect(read.updatedAt).not.toBeNull();
  });

  it('hands the agent each page with answers under its title, or only the one it names', async () => {
    await store.publish(RUN, { id: 'other', title: 'Other', html: '<p>o</p>' });
    const service = build(
      [
        row(1, artifact('vote', 1, { title: 'Vote on calls' })),
        row(2, artifact('other', 1, { title: 'Other page' })),
      ],
      true,
      store,
    );
    await service.saveAnswers(RUN, 'vote', { 'call-1': 'agree' });
    await service.saveAnswers(RUN, 'other', { pick: 'b' });

    const all = await service.keptAnswers(RUN, null);
    const one = await service.keptAnswers(RUN, 'vote');

    expect(
      all
        .map(({ artifactId, title, values }) => ({ artifactId, title, values }))
        .sort((a, b) => a.artifactId.localeCompare(b.artifactId)),
    ).toEqual([
      { artifactId: 'other', title: 'Other page', values: { pick: 'b' } },
      {
        artifactId: 'vote',
        title: 'Vote on calls',
        values: { 'call-1': 'agree' },
      },
    ]);
    expect(one.map((page) => page.artifactId)).toEqual(['vote']);
  });

  it('refuses answers for a page the run does not hold, or a run that is gone', async () => {
    await expect(
      build([], true, store).saveAnswers(RUN, 'nothing', { a: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      build([], false, store).readAnswers(RUN, 'vote'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(store.listAnswers(RUN)).toEqual([]);
  });

  it('refuses to merge into kept answers it cannot read, and leaves the file as it was', async () => {
    const service = build([], true, store);
    const file = join(root, RUN, 'vote', 'answers.json');
    writeFileSync(file, '{ not json');

    await expect(
      service.saveAnswers(RUN, 'vote', { 'call-1': 'agree' }),
    ).rejects.toBeInstanceOf(InternalException);
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('refuses answers past the limit and keeps what was kept', async () => {
    const service = build([], true, store);
    await service.saveAnswers(RUN, 'vote', { kept: true });

    await expect(
      service.saveAnswers(RUN, 'vote', {
        long: 'x'.repeat(MAX_ARTIFACT_ANSWERS_BYTES),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((await service.readAnswers(RUN, 'vote')).values).toEqual({
      kept: true,
    });
  });
});
