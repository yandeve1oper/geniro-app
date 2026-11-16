import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tempDir } from '../../agents/__tests__/temp-dir';
import { RunDao } from '../../agents/dao/run.dao';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import type { RunPlace } from '../../projects/projects.types';
import { Run } from '../../runs/entity/run.entity';
import { make, memoryDb } from '../__tests__/memory-db';
import { MemoryDao } from '../dao/memory.dao';
import { Memory } from '../entity/memory.entity';
import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryActor,
  type MemoryReviewPage,
  type MemoryReviewQuery,
  type MemorySaveInput,
  type MemorySaveOutcome,
} from '../memory.types';
import { usageDay } from '../utils/memory-usage-day';
import { MemoryReviewService } from './memory-review.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.now() + 100 * DAY);
const daysBefore = (days: number) =>
  usageDay(new Date(NOW.getTime() - days * DAY));
const ago = (days: number) => new Date(Date.now() - days * DAY);

const NONE: RunPlace = { projectId: null, teamSlug: null };
const inProject = (projectId: string): RunPlace => ({
  projectId,
  teamSlug: null,
});
const inTeam = (teamSlug: string): RunPlace => ({
  projectId: null,
  teamSlug,
});

const AGENT: MemoryActor = {
  kind: 'agent',
  runId: 'run-a',
  agentKind: 'claude',
  model: 'opus',
};
const USER: MemoryActor = { kind: 'user' };

function entryOf(outcome: MemorySaveOutcome) {
  if (outcome.kind !== 'created' && outcome.kind !== 'updated') {
    throw new Error(`expected a saved entry, got ${JSON.stringify(outcome)}`);
  }
  return outcome.entry;
}

function titlesOf(page: MemoryReviewPage): string[] {
  return page.rows.map((row) => row.entry.title).sort();
}

function rowTitled(page: MemoryReviewPage, title: string) {
  const row = page.rows.find((candidate) => candidate.entry.title === title);
  if (!row) {
    throw new Error(`no row ${title}`);
  }
  return row;
}

describe('MemoryReviewService', () => {
  let db: Awaited<ReturnType<typeof memoryDb>>;
  let review: MemoryReviewService;

  beforeEach(async () => {
    db = await memoryDb();
    db.service.setConfig(DEFAULT_MEMORY_CONFIG);
    review = new MemoryReviewService(
      db.em,
      new MemoryDao(db.em),
      new ProjectDao(db.em),
      db.usage,
      new RunDao(db.em),
      db.service,
    );
  });

  afterEach(async () => {
    await db.orm.close();
  });

  async function save(
    actor: MemoryActor,
    input: MemorySaveInput,
    place: RunPlace = NONE,
  ) {
    return entryOf(await db.service.save(actor, input, place));
  }

  async function addProject(id: string, folder: string) {
    const em = db.em.fork();
    em.persist(make(Project, { id, name: id, folder }));
    await em.flush();
  }

  async function use(memoryId: string, day: string, reads: number) {
    await db.usageDao.add([
      { memoryId, day, reads, searchHits: 0, indexShows: 0 },
    ]);
  }

  async function stamp(id: string, at: Date) {
    await new MemoryDao(db.em).touch([id], at);
  }

  async function setCreatedAt(id: string, at: Date) {
    await db.em.fork().nativeUpdate(Memory, { id }, { createdAt: at });
  }

  it('sorts and counts over every row, past the page', async () => {
    const plain = await save(AGENT, { title: 'Pnpm workspace', body: 'x' });
    const quiet = await save(AGENT, { title: 'Loopback binding', body: 'x' });
    const reader3 = await save(AGENT, { title: 'Colima restarts', body: 'x' });
    const reader1 = await save(AGENT, { title: 'Changelog format', body: 'x' });
    const reader5 = await save(AGENT, {
      title: 'Migration journal',
      body: 'x',
    });
    await use(reader3.id, daysBefore(100), 3);
    await use(reader1.id, daysBefore(120), 1);
    await use(reader5.id, daysBefore(150), 5);

    const first = await review.page({ limit: 2 }, NOW);
    const second = await review.page({ limit: 2, cursor: first.next! }, NOW);
    const third = await review.page({ limit: 2, cursor: second.next! }, NOW);

    expect([first.total, second.total, third.total]).toEqual([5, 5, 5]);
    expect([first.next, second.next, third.next]).toEqual(['2', '4', null]);
    const rows = [...first.rows, ...second.rows, ...third.rows];
    expect(rows.map((row) => row.usage.reads)).toEqual([0, 0, 1, 3, 5]);
    expect(rows.map((row) => row.entry.id).sort()).toEqual(
      [plain.id, quiet.id, reader3.id, reader1.id, reader5.id].sort(),
    );
    expect(third.rows.map((row) => row.entry.id)).toEqual([reader5.id]);
  });

  it('a read 100 days ago is cold, a read in the window is not', async () => {
    const cold = await save(AGENT, { title: 'Pnpm workspace', body: 'x' });
    const warm = await save(AGENT, { title: 'Loopback binding', body: 'x' });
    await use(cold.id, daysBefore(100), 1);
    await use(warm.id, daysBefore(10), 1);

    const page = await review.page({}, NOW);

    expect(page.rows.map((row) => row.entry.id)).toEqual([cold.id]);
    expect(page.rows[0]?.usage).toMatchObject({
      reads: 1,
      readsLast90Days: 0,
      lastReadAt: daysBefore(100),
    });
    expect((await review.summary(NOW)).proposed).toBe(1);
  });

  it('a kept entry never appears in the cold tab, shows in kept, and returns when unkept', async () => {
    const kept = await save(AGENT, { title: 'Pnpm workspace', body: 'x' });
    const plain = await save(AGENT, { title: 'Loopback binding', body: 'x' });
    await db.service.setKept(kept.id, true);

    const cold = await review.page({}, NOW);
    const keptTab = await review.page({ tab: 'kept' }, NOW);

    expect(cold.rows.map((row) => row.entry.id)).toEqual([plain.id]);
    expect(keptTab.rows.map((row) => row.entry.id)).toEqual([kept.id]);
    expect(keptTab.rows[0]?.keptAt).not.toBeNull();
    expect((await review.ids({}, NOW)).ids).toEqual([plain.id]);

    await db.service.setKept(kept.id, false);

    const unkept = await review.page({}, NOW);
    expect(unkept.rows.map((row) => row.entry.id).sort()).toEqual(
      [kept.id, plain.id].sort(),
    );
    expect((await review.page({ tab: 'kept' }, NOW)).total).toBe(0);
  });

  it('review/ids leaves warned rows out', async () => {
    await save(AGENT, {
      title: 'Correction note',
      body: 'x',
      type: 'feedback',
    });
    await save(AGENT, { title: 'About the user', body: 'x', type: 'user' });
    await save(USER, { title: 'Mine', body: 'x' });
    await save(AGENT, { title: 'Pnpm only', body: 'Never run npm here.' });
    const clean = await save(AGENT, { title: 'Colima restarts', body: 'x' });

    expect(await review.ids({}, NOW)).toEqual({
      ids: [clean.id],
      warnedSkipped: 4,
    });
    const page = await review.page({}, NOW);
    expect(
      Object.fromEntries(
        page.rows.map((row) => [row.entry.title, row.warning]),
      ),
    ).toEqual({
      'Correction note': 'feedback',
      'About the user': 'user',
      Mine: 'writtenByYou',
      'Pnpm only': 'statesLimit',
      'Colima restarts': null,
    });
  });

  it('an entry not swept yet counts as warned until the sweep reads it', async () => {
    const clean = await save(AGENT, { title: 'Colima restarts', body: 'x' });
    await db.em
      .fork()
      .nativeUpdate(Memory, { id: clean.id }, { statesRule: null });

    expect(
      rowTitled(await review.page({}, NOW), 'Colima restarts').warning,
    ).toBe('notChecked');
    expect(await review.ids({}, NOW)).toEqual({ ids: [], warnedSkipped: 1 });

    await review.sweepQuietly();

    expect(
      rowTitled(await review.page({}, NOW), 'Colima restarts').warning,
    ).toBeNull();
    expect(await review.ids({}, NOW)).toEqual({
      ids: [clean.id],
      warnedSkipped: 0,
    });
    const row = await db.em.fork().findOneOrFail(Memory, { id: clean.id });
    expect(row.statesRule).toBe(false);
  });

  it('filters by type, scope, warnings only/hide and reference gone', async () => {
    const root = tempDir('memory-review-root-');
    await addProject('p1', root);
    await save(
      AGENT,
      { title: 'Build entry', body: 'Build runs from apps/gone/build.ts.' },
      inProject('p1'),
    );
    await save(AGENT, { title: 'Loopback binding', body: 'x' });
    await save(
      AGENT,
      { title: 'Team lint', body: 'x', scope: 'team' },
      inTeam('team-a'),
    );
    await save(AGENT, {
      title: 'Correction note',
      body: 'x',
      type: 'feedback',
    });
    await save(AGENT, {
      title: 'Changelog format',
      body: 'Never edit the changelog by hand.',
    });

    const titles = async (query: MemoryReviewQuery) =>
      titlesOf(await review.page(query, NOW));

    expect(await titles({ type: 'feedback' })).toEqual(['Correction note']);
    expect(await titles({ scope: 'global' })).toEqual([
      'Changelog format',
      'Correction note',
      'Loopback binding',
    ]);
    expect(await titles({ scope: 'project', projectId: 'p1' })).toEqual([
      'Build entry',
    ]);
    expect(await titles({ scope: 'team', teamSlug: 'team-a' })).toEqual([
      'Team lint',
    ]);
    expect(await titles({ warnings: 'only' })).toEqual([
      'Changelog format',
      'Correction note',
    ]);
    expect(await titles({ warnings: 'hide' })).toEqual([
      'Build entry',
      'Loopback binding',
      'Team lint',
    ]);
    const gone = await review.page({ referenceGone: 'true' }, NOW);
    expect(titlesOf(gone)).toEqual(['Build entry']);
    expect(rowTitled(gone, 'Build entry').referencesGone).toEqual([
      'apps/gone/build.ts',
    ]);
  });

  it('the age filter keeps young entries out and younger counts them', async () => {
    await save(AGENT, { title: 'Pnpm workspace', body: 'x' });
    await save(AGENT, { title: 'Loopback binding', body: 'x' });
    await save(AGENT, { title: 'Colima restarts', body: 'x' });
    const now = new Date();

    const young = await review.page({}, now);

    expect(young).toMatchObject({ rows: [], total: 0, younger: 3 });
    expect(await review.summary(now)).toMatchObject({
      proposed: 0,
      younger: 3,
    });
    expect((await review.page({ minAgeDays: 0 }, now)).total).toBe(3);
    expect(await review.page({}, NOW)).toMatchObject({ total: 3, younger: 0 });
  });

  it('a denied folder is not reference gone', async () => {
    const root = tempDir('memory-review-denied-');
    const locked = join(root, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'inside.ts'), 'export {};\n');
    await addProject('p2', root);
    await save(
      AGENT,
      { title: 'Locked module', body: 'Lives in locked/inside.ts.' },
      inProject('p2'),
    );

    chmodSync(locked, 0o000);
    try {
      const page = await review.page({}, NOW);

      expect(rowTitled(page, 'Locked module').referencesGone).toEqual([]);
      expect((await review.page({ referenceGone: 'true' }, NOW)).total).toBe(0);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('a missing file is reference gone, and a missing project folder leaves nothing gone', async () => {
    const root = tempDir('memory-review-missing-');
    await addProject('p3', root);
    await addProject('p4', join(root, 'no-such-repo'));
    await save(
      AGENT,
      { title: 'Moved file', body: 'Lives in src/moved.ts.' },
      inProject('p3'),
    );
    await save(
      AGENT,
      { title: 'Detached repo', body: 'Lives in src/any.ts.' },
      inProject('p4'),
    );

    const page = await review.page({}, NOW);

    expect(rowTitled(page, 'Moved file').referencesGone).toEqual([
      'src/moved.ts',
    ]);
    expect(rowTitled(page, 'Detached repo').referencesGone).toEqual([]);
  });

  it('summary counts every row over its statuses, read and kept marks', async () => {
    const read = await save(USER, { title: 'Pnpm workspace', body: 'x' });
    await save(AGENT, { title: 'Edit rule', body: 'Never edit it.' });
    const kept = await save(AGENT, { title: 'Loopback binding', body: 'x' });
    await db.service.setKept(kept.id, true);
    db.service.setConfig({
      enabled: true,
      agentWrites: 'pending',
      nativeMemoryOff: false,
      autoForgetAfterDays: null,
      removeNotUseful: true,
    });
    await save(AGENT, { title: 'Colima restarts', body: 'x' });
    db.service.setConfig(DEFAULT_MEMORY_CONFIG);
    const gone = await save(AGENT, { title: 'Changelog format', body: 'x' });
    const batch = await db.service.forgetBatch([gone.id]);
    await use(read.id, daysBefore(10), 2);
    const newest = {
      batchId: batch.batchId,
      count: 1,
      forgottenAt: expect.any(String),
      automatic: false,
      kind: 'manual',
      title: 'Changelog format',
      reason: null,
      purgeAt: null,
    };

    expect(await review.summary(NOW)).toEqual({
      active: 3,
      pending: 1,
      read: 1,
      neverRead: 2,
      proposed: 2,
      proposedWithWarning: 1,
      younger: 0,
      kept: 1,
      forgotten: 1,
      minAgeDays: 14,
      countedSince: daysBefore(10),
      counting: true,
      lastBatch: newest,
      lastPass: [newest],
      autoForget: null,
    });
    await db.usage.markBackfilled();
    expect((await review.summary(NOW)).counting).toBe(false);
  });

  it('the newest pass lists every batch forgotten at its instant, with the purge dates the batch list gives', async () => {
    const dao = new MemoryDao(db.em);
    const older = await save(AGENT, { title: 'Older cleanup', body: 'x' });
    await dao.forgetBatch([older.id], 'manual-older', ago(5));
    const pass = ago(2);
    const pnpm = await save(AGENT, { title: 'Use pnpm', body: 'x' });
    const loopback = await save(AGENT, { title: 'Loopback only', body: 'x' });
    const colima = await save(AGENT, { title: 'Colima restarts', body: 'x' });
    const lesson = await save(AGENT, { title: 'Auto lesson', body: 'x' });
    await dao.forgetBatch([pnpm.id], 'marks-1', pass);
    await dao.forgetBatch([loopback.id], 'marks-2', pass);
    await dao.forgetBatch([colima.id], 'marks-3', pass);
    await dao.forgetBatch([lesson.id], 'expired-lesson-1', pass);

    const summary = await review.summary(NOW);
    const listed = (await review.batches()).batches;

    expect(summary.lastPass).toHaveLength(4);
    expect(summary.lastPass).toEqual(listed.slice(0, 4));
    expect(listed[4]?.batchId).toBe('manual-older');
    expect(summary.lastBatch).toEqual(summary.lastPass[0]);
    expect(summary.lastPass.map((batch) => batch.kind).sort()).toEqual([
      'expired_lesson',
      'marks',
      'marks',
      'marks',
    ]);
    expect(summary.lastPass.every((batch) => batch.purgeAt !== null)).toBe(
      true,
    );

    db.service.setConfig({ ...DEFAULT_MEMORY_CONFIG, removeNotUseful: false });
    const off = await review.summary(NOW);

    expect(
      off.lastPass
        .filter((batch) => batch.kind === 'marks')
        .map((batch) => batch.purgeAt),
    ).toEqual([null, null, null]);
    expect(
      off.lastPass.find((batch) => batch.kind === 'expired_lesson')?.purgeAt,
    ).not.toBeNull();
    expect(off.lastPass).toEqual((await review.batches()).batches.slice(0, 4));
  });

  it('the auto-forget figure is what the sweep takes now, with the warned ones beside it', async () => {
    const em = db.em.fork();
    em.persist(make(Run, { id: 'r-recent', status: 'completed' }));
    await em.flush();
    await db.em
      .fork()
      .nativeUpdate(Run, { id: 'r-recent' }, { createdAt: ago(-99) });
    await save(AGENT, { title: 'Cold one', body: 'x' });
    await save(AGENT, { title: 'Cold two', body: 'x' });
    await save(USER, { title: 'Written by me', body: 'x' });
    const kept = await save(AGENT, { title: 'Kept entry', body: 'x' });
    await db.service.setKept(kept.id, true);
    const read = await save(AGENT, { title: 'Read lately', body: 'x' });
    await use(read.id, daysBefore(3), 1);

    expect((await review.summary(NOW, 30)).autoForget).toEqual({
      days: 30,
      forget: 2,
      warned: 1,
    });
    expect((await review.summary(NOW, 365)).autoForget).toEqual({
      days: 365,
      forget: 0,
      warned: 0,
    });
    db.service.setConfig({ ...DEFAULT_MEMORY_CONFIG, autoForgetAfterDays: 30 });
    await db.usage.markBackfilled();
    expect((await db.service.sweepCold(NOW))?.forgotten).toBe(2);
    expect((await review.summary(NOW, 30)).autoForget).toMatchObject({
      forget: 0,
      warned: 1,
    });
  });

  it.each(['oldestSaved', 'largest', 'longestSinceRead'] as const)(
    'orders cold rows by %s over every row',
    async (sort) => {
      const ledgerOnly = await save(AGENT, {
        title: 'Pnpm workspace',
        body: 'x'.repeat(50),
      });
      const never = await save(AGENT, {
        title: 'Loopback binding',
        body: 'x'.repeat(10),
      });
      const stampOnly = await save(AGENT, {
        title: 'Colima restarts',
        body: 'x'.repeat(300),
      });
      await setCreatedAt(never.id, new Date(Date.UTC(2020, 0, 1)));
      await setCreatedAt(ledgerOnly.id, new Date(Date.UTC(2020, 0, 2)));
      await setCreatedAt(stampOnly.id, new Date(Date.UTC(2020, 0, 3)));
      await use(ledgerOnly.id, daysBefore(100), 1);
      await stamp(stampOnly.id, new Date(NOW.getTime() - 120 * DAY));
      const expected = {
        oldestSaved: [never.id, ledgerOnly.id, stampOnly.id],
        largest: [stampOnly.id, ledgerOnly.id, never.id],
        longestSinceRead: [never.id, stampOnly.id, ledgerOnly.id],
      }[sort];

      const page = await review.page({ sort }, NOW);

      expect(page.rows.map((row) => row.entry.id)).toEqual(expected);
    },
  );

  it('a read stamped inside the window keeps an entry out of Least used', async () => {
    const recent = await save(AGENT, { title: 'Pnpm workspace', body: 'x' });
    const old = await save(AGENT, { title: 'Loopback binding', body: 'x' });
    await stamp(recent.id, new Date(NOW.getTime() - 10 * DAY));
    await stamp(old.id, new Date(NOW.getTime() - 100 * DAY));

    const page = await review.page({ sort: 'leastUsed' }, NOW);

    expect(page.rows.map((row) => row.entry.id)).toEqual([old.id]);
    expect(page.rows[0]?.usage.lastReadAt).toBe(daysBefore(100));
  });

  it('lastReadAt is the later of the ledger day and the stamp', async () => {
    const ledgerNewer = await save(AGENT, {
      title: 'Pnpm workspace',
      body: 'x',
    });
    const stampNewer = await save(AGENT, {
      title: 'Loopback binding',
      body: 'x',
    });
    const unread = await save(AGENT, { title: 'Colima restarts', body: 'x' });
    await use(ledgerNewer.id, daysBefore(20), 1);
    await stamp(ledgerNewer.id, new Date(NOW.getTime() - 50 * DAY));
    await use(stampNewer.id, daysBefore(60), 1);
    await stamp(stampNewer.id, new Date(NOW.getTime() - 30 * DAY));
    for (const entry of [ledgerNewer, stampNewer, unread]) {
      await db.service.setKept(entry.id, true);
    }

    const page = await review.page({ tab: 'kept' }, NOW);

    expect(
      Object.fromEntries(
        page.rows.map((row) => [row.entry.title, row.usage.lastReadAt]),
      ),
    ).toEqual({
      'Pnpm workspace': daysBefore(20),
      'Loopback binding': daysBefore(30),
      'Colima restarts': null,
    });
  });

  it('the Forgotten tab lists newest forgotten first, an old row without forgottenAt by its edit time', async () => {
    const forgotten = await save(USER, { title: 'Pnpm workspace', body: 'x' });
    const legacy = await save(USER, { title: 'Loopback binding', body: 'x' });
    const batch = await db.service.forgetBatch([forgotten.id]);
    const forgottenAt = ago(5);
    const editedAt = ago(2);
    const em = db.em.fork();
    await em.nativeUpdate(Memory, { id: forgotten.id }, { forgottenAt });
    await em.nativeUpdate(
      Memory,
      { id: legacy.id },
      { status: 'forgotten', forgottenAt: null, updatedAt: editedAt },
    );

    const page = await review.page({ tab: 'forgotten' }, NOW);

    expect(
      page.rows.map((row) => [
        row.entry.title,
        row.forgottenAt,
        row.forgetBatchId,
      ]),
    ).toEqual([
      ['Loopback binding', editedAt.toISOString(), null],
      ['Pnpm workspace', forgottenAt.toISOString(), batch.batchId],
    ]);
  });

  it('a reference check does not overwrite an entry edited meanwhile', async () => {
    const root = tempDir('memory-review-stale-');
    await addProject('p5', root);
    const entry = await save(
      AGENT,
      { title: 'Build entry', body: 'Build runs from apps/gone/build.ts.' },
      inProject('p5'),
    );
    const edited = entryOf(
      await db.service.edit(entry.id, {
        rev: entry.rev,
        title: 'Build entry',
        body: 'Build runs from apps/gone/build.ts, now from elsewhere.',
        type: 'project',
        projectId: 'p5',
        teamSlug: null,
      }),
    );
    const dao = new MemoryDao(db.em);

    await dao.setReferencesGone(
      { id: entry.id, rev: entry.rev },
      '["apps/gone/build.ts"]',
      NOW,
    );

    const stale = await db.em.fork().findOneOrFail(Memory, { id: entry.id });
    expect([stale.referencesGone, stale.referencesCheckedAt]).toEqual([
      null,
      null,
    ]);

    await dao.setReferencesGone(
      { id: entry.id, rev: edited.rev },
      '["apps/gone/build.ts"]',
      NOW,
    );

    const current = await db.em.fork().findOneOrFail(Memory, { id: entry.id });
    expect(current.referencesGone).toBe('["apps/gone/build.ts"]');
  });

  it('a failing reference check still answers the page', async () => {
    const root = tempDir('memory-review-down-');
    await addProject('p6', root);
    await save(
      AGENT,
      { title: 'Build entry', body: 'Build runs from apps/gone/build.ts.' },
      inProject('p6'),
    );
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const down = new MemoryReviewService(
      db.em,
      new MemoryDao(db.em),
      {
        getAll: () => Promise.reject(new Error('down')),
      } as unknown as ProjectDao,
      db.usage,
      new RunDao(db.em),
      db.service,
    );

    try {
      const page = await down.page({}, NOW);

      expect(titlesOf(page)).toEqual(['Build entry']);
      expect(rowTitled(page, 'Build entry').referencesGone).toEqual([]);
      expect(warn).toHaveBeenCalledWith('memory reference check failed: down');
    } finally {
      warn.mockRestore();
    }
  });

  it('names a hand-made cleanup manual and a sweep automatic, and titles only a one-entry batch', async () => {
    const em = db.em.fork();
    em.persist(make(Run, { id: 'r-recent', status: 'completed' }));
    await em.flush();
    await db.em
      .fork()
      .nativeUpdate(Run, { id: 'r-recent' }, { createdAt: ago(-99) });
    await save(AGENT, { title: 'Cold one', body: 'x' });
    await save(AGENT, { title: 'Cold two', body: 'x' });
    const mine = await save(USER, { title: 'Picked by hand', body: 'x' });
    const byHand = await db.service.forgetBatch([mine.id]);
    db.service.setConfig({ ...DEFAULT_MEMORY_CONFIG, autoForgetAfterDays: 30 });
    await db.usage.markBackfilled();
    const swept = await db.service.sweepCold(NOW);

    const { batches } = await review.batches();

    expect(batches.find((batch) => batch.batchId === swept?.batchId)).toEqual({
      batchId: swept?.batchId,
      count: 2,
      forgottenAt: NOW.toISOString(),
      automatic: true,
      kind: 'automatic',
      title: null,
      reason: null,
      purgeAt: null,
    });
    expect(
      batches.find((batch) => batch.batchId === byHand.batchId),
    ).toMatchObject({
      automatic: false,
      kind: 'manual',
      count: 1,
      title: 'Picked by hand',
      reason: null,
      purgeAt: null,
    });
  });

  it('gives a marks cleanup and an expired lesson a purge date 30 days on, and a marks cleanup none while the switch is off', async () => {
    const stale = await save(USER, { title: 'Stale flag', body: 'x' });
    for (const threadId of ['t1', 't2', 't3']) {
      await db.marks.record(
        {
          memoryId: stale.id,
          threadId,
          runId: threadId,
          memberId: null,
          source: 'agent',
          verdict: 'not_useful',
          reason: `${threadId} saw it stale`,
          evidenceSeq: null,
          agentKind: 'claude',
          model: null,
        },
        new Date(NOW.getTime() - DAY),
        db.em.fork(),
      );
    }
    const lesson = entryOf(
      await db.service.fileLesson(
        { kind: 'lesson', runId: 'refl-1', agentKind: 'claude', model: 'opus' },
        { title: 'Check before retrying', body: 'x', type: 'feedback' },
        { projectId: null, teamSlug: null },
        { sourceRunId: 'src-1', proposalId: 'lp-1' },
      ),
    );
    const purgeAt = new Date(NOW.getTime() + 30 * DAY).toISOString();

    expect(await db.service.sweepMarks(NOW)).toMatchObject({
      forgotten: 1,
      expired: 1,
    });
    let { batches: listed } = await review.batches();

    expect(listed.find((batch) => batch.kind === 'marks')).toEqual({
      batchId: expect.stringMatching(/^marks-/),
      count: 1,
      forgottenAt: NOW.toISOString(),
      automatic: false,
      kind: 'marks',
      title: 'Stale flag',
      reason:
        '3 threads marked it not useful: a deleted thread — t1 saw it stale; a deleted thread — t2 saw it stale; a deleted thread — t3 saw it stale',
      purgeAt,
    });
    expect(listed.find((batch) => batch.kind === 'expired_lesson')).toEqual({
      batchId: expect.stringMatching(/^expired-lesson-/),
      count: 1,
      forgottenAt: NOW.toISOString(),
      automatic: false,
      kind: 'expired_lesson',
      title: lesson.title,
      reason: 'An auto lesson no thread marked helped in 90 days',
      purgeAt,
    });

    db.service.setConfig({ ...DEFAULT_MEMORY_CONFIG, removeNotUseful: false });
    ({ batches: listed } = await review.batches());

    expect(listed.find((batch) => batch.kind === 'marks')?.purgeAt).toBeNull();
    expect(
      listed.find((batch) => batch.kind === 'expired_lesson')?.purgeAt,
    ).toBe(purgeAt);
  });
});
