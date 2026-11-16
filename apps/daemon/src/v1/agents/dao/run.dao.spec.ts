import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { ItemDao } from './item.dao';
import { RunDao } from './run.dao';

/**
 * Real-driver DAO spec for the run listings the service specs only fake
 * ("Mirrors the real query's chat-only scoping…" in chat.service.spec, the
 * pending-counts orphan filter in team-executor.service.spec). Same in-memory
 * better-sqlite3 harness as item.dao.spec: real entities, the daemon config's
 * discovery settings, actual SQL.
 */
describe('RunDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: RunDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, Item, NodeState],
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
  });

  beforeEach(async () => {
    await orm.schema.clear();
    dao = new RunDao(orm.em.fork());
  });

  it('leaves a run it only READ exactly as it was when its fork is flushed', async () => {
    // Declared with the `'datetime'` string, every date column read as dirty
    // on load (its snapshot an ISO string, its value the stored number), so a
    // flush of a fork that had merely loaded a run re-stamped its `updatedAt`
    // — re-dating rows nobody touched and reordering the sidebar.
    const old = new Date('2026-01-01T00:00:00.000Z');
    await dao.create({ id: 'r1', createdAt: old, updatedAt: old });
    const em = orm.em.fork();
    await new RunDao(em).getById('r1');

    await em.flush();

    const run = await new RunDao(orm.em.fork()).getById('r1');
    expect(run!.updatedAt.toISOString()).toBe(old.toISOString());
    expect(run!.createdAt.toISOString()).toBe(old.toISOString());
  });

  describe('existingIds', () => {
    it('answers the ids of the runs that still exist, archived ones included, and nothing for a run deleted or never made', async () => {
      await dao.create({ id: 'live-1', archivedAt: null });
      await dao.create({ id: 'live-2', archivedAt: new Date(1_000) });

      expect(
        await dao.existingIds(['live-1', 'gone', 'live-1', 'live-2']),
      ).toEqual(new Set(['live-1', 'live-2']));
    });

    it('answers an empty set for no ids', async () => {
      await dao.create({ id: 'live-1', archivedAt: null });

      expect(await dao.existingIds([])).toEqual(new Set());
    });
  });

  describe('listChats', () => {
    it('lists chat runs only (teamId null), newest first', async () => {
      // Oldest inserted first, with explicit createdAt values: a dropped
      // ORDER BY (insertion order) flips the expected order below.
      const older = await dao.create({ createdAt: new Date(1_000) });
      const newer = await dao.create({ createdAt: new Date(2_000) });
      await dao.create({ teamId: 'wf-1', createdAt: new Date(3_000) });

      const chats = await dao.listChats('active');

      expect(chats.map((run) => run.id)).toEqual([newer.id, older.id]);
    });

    it('leaves archived chats out of the active listing', async () => {
      const active = await dao.create({ createdAt: new Date(1_000) });
      await dao.create({
        createdAt: new Date(2_000),
        archivedAt: new Date(9_000),
      });

      const chats = await dao.listChats('active');

      expect(chats.map((run) => run.id)).toEqual([active.id]);
    });

    it('lists ONLY archived chats when asked for the archive', async () => {
      await dao.create({ createdAt: new Date(1_000) });
      const archived = await dao.create({
        createdAt: new Date(2_000),
        archivedAt: new Date(9_000),
      });
      // An archived TEAM run is still out of scope: this route is the
      // chat listing, and the team half of the sidebar has its own
      // (`listTeamRuns`, which takes the same scope).
      await dao.create({
        teamId: 'wf-1',
        createdAt: new Date(3_000),
        archivedAt: new Date(9_000),
      });

      const chats = await dao.listChats('archived');

      expect(chats.map((run) => run.id)).toEqual([archived.id]);
    });

    it('lists both sides under `all`, still newest first', async () => {
      // The one scope that states NO condition on `archivedAt`. Narrow it back
      // to either side and one of these ids goes missing; drop the ORDER BY and
      // the pair comes back in insertion order, which is the reverse.
      const archived = await dao.create({
        createdAt: new Date(1_000),
        archivedAt: new Date(9_000),
      });
      const active = await dao.create({ createdAt: new Date(2_000) });
      // A team run is out of scope on EVERY side, `all` included — the
      // scope widens the archive, never the run kind.
      await dao.create({ teamId: 'wf-1', createdAt: new Date(3_000) });

      const chats = await dao.listChats('all');

      expect(chats.map((run) => run.id)).toEqual([active.id, archived.id]);
    });

    it('pages the archive newest first, a page after the last row of the one before', async () => {
      const archivedAt = new Date(9_000);
      const ids = [];
      for (let at = 1; at <= 5; at += 1) {
        ids.push(
          (await dao.create({ createdAt: new Date(at * 1_000), archivedAt }))
            .id,
        );
      }
      const [oldest, , middle, , newest] = ids;

      const first = await dao.listChats('archived', undefined, { limit: 2 });
      const last = first.at(-1)!;
      const second = await dao.listChats('archived', undefined, {
        limit: 2,
        before: { createdAt: last.createdAt, id: last.id },
      });

      expect(first.map((run) => run.id)).toEqual([newest, ids[3]]);
      expect(second.map((run) => run.id)).toEqual([middle, ids[1]]);
      const third = await dao.listChats('archived', undefined, {
        limit: 2,
        before: { createdAt: second[1]!.createdAt, id: second[1]!.id },
      });
      expect(third.map((run) => run.id)).toEqual([oldest]);
    });

    it('neither skips nor repeats runs created in the same millisecond across a page edge', async () => {
      const same = new Date(5_000);
      const created = [];
      for (const id of ['a', 'b', 'c']) {
        created.push((await dao.create({ id, createdAt: same })).id);
      }

      const first = await dao.listChats('active', undefined, { limit: 2 });
      const second = await dao.listChats('active', undefined, {
        limit: 2,
        before: { createdAt: same, id: first.at(-1)!.id },
      });

      expect([...first, ...second].map((run) => run.id)).toEqual([
        'c',
        'b',
        'a',
      ]);
    });

    it('answers one run, on the scope it is asked under', async () => {
      const wanted = await dao.create({
        createdAt: new Date(1_000),
        archivedAt: new Date(9_000),
      });
      await dao.create({ createdAt: new Date(2_000) });

      expect(
        (await dao.listChats('all', undefined, { runId: wanted.id })).map(
          (run) => run.id,
        ),
      ).toEqual([wanted.id]);
      expect(
        await dao.listChats('active', undefined, { runId: wanted.id }),
      ).toEqual([]);
    });

    it('lists every run scanned under another pull-request rule, never-scanned ones included', async () => {
      const never = await dao.create({ createdAt: new Date(1_000) });
      const older = await dao.create({
        createdAt: new Date(2_000),
        pullRequestsScannedSeq: 4,
        pullRequestsScanVersion: 1,
      });
      await dao.create({
        createdAt: new Date(3_000),
        pullRequestsScannedSeq: 4,
        pullRequestsScanVersion: 2,
      });

      const outdated = await dao.listOutdatedPullRequestScans(2);

      expect(outdated.map((run) => run.id)).toEqual([older.id, never.id]);
    });

    it('pages team runs by the same cursor', async () => {
      const older = await dao.create({
        teamId: 'wf-1',
        createdAt: new Date(1_000),
      });
      const newer = await dao.create({
        teamId: 'wf-1',
        createdAt: new Date(2_000),
      });

      const page = await dao.listTeamRuns('all', undefined, {
        limit: 1,
        before: { createdAt: newer.createdAt, id: newer.id },
      });

      expect(page.map((run) => run.id)).toEqual([older.id]);
    });

    it('leaves the builder’s team-editing chat out of EVERY scope', async () => {
      // It is a chat by every column the listing filters on — no teamId, no
      // archive — so only `editsTeamSlug` keeps it off the sidebar, and
      // `all` is the scope that would otherwise let it back in.
      const mine = await dao.create({ createdAt: new Date(1_000) });
      await dao.create({
        createdAt: new Date(2_000),
        editsTeamSlug: 'review-team',
      });
      await dao.create({
        createdAt: new Date(3_000),
        editsTeamSlug: 'review-team',
        archivedAt: new Date(9_000),
      });

      expect((await dao.listChats('active')).map((run) => run.id)).toEqual([
        mine.id,
      ]);
      expect((await dao.listChats('archived')).map((run) => run.id)).toEqual(
        [],
      );
      expect((await dao.listChats('all')).map((run) => run.id)).toEqual([
        mine.id,
      ]);
      // And it is still reachable where the panel looks for it — hidden from
      // the sidebar, not hidden from the builder.
      expect(
        (await dao.listEditingTeam('review-team')).map((run) => run.id),
      ).toHaveLength(2);
    });

    it('leaves a project’s own chat out of EVERY scope, and finds it by its project apart from a builder chat bound to one', async () => {
      const mine = await dao.create({ createdAt: new Date(1_000) });
      const own = await dao.create({
        createdAt: new Date(2_000),
        editsProjectId: 'p1',
      });
      const shelved = await dao.create({
        createdAt: new Date(3_000),
        editsProjectId: 'p1',
        archivedAt: new Date(9_000),
      });
      await dao.create({
        createdAt: new Date(4_000),
        editsTeamSlug: 'review-team',
        editsProjectId: 'p1',
      });

      for (const scope of ['active', 'archived', 'all'] as const) {
        expect(
          (await dao.listChats(scope)).map((run) => run.id),
          scope,
        ).toEqual(scope === 'archived' ? [] : [mine.id]);
      }
      expect((await dao.listEditingProject('p1')).map((run) => run.id)).toEqual(
        [shelved.id, own.id],
      );
      expect(await dao.projectChatProjectIds()).toEqual(['p1']);
    });

    it('leaves a thread’s analysis out of EVERY scope, and finds it by its source', async () => {
      // Opened from its source thread's popup, never from the sidebar: only
      // `analysisSourceRunId` tells it from an ordinary chat.
      const source = await dao.create({ createdAt: new Date(1_000) });
      const older = await dao.create({
        createdAt: new Date(2_000),
        analysisSourceRunId: source.id,
      });
      const newer = await dao.create({
        createdAt: new Date(3_000),
        analysisSourceRunId: source.id,
        archivedAt: new Date(9_000),
      });
      await dao.create({
        createdAt: new Date(4_000),
        analysisSourceRunId: 'another-thread',
      });

      for (const scope of ['active', 'archived', 'all'] as const) {
        expect(
          (await dao.listChats(scope))
            .map((run) => run.id)
            .filter((id) => id !== source.id),
        ).toEqual([]);
      }
      expect(
        (await dao.listAnalysesOf(source.id)).map((run) => run.id),
      ).toEqual([newer.id, older.id]);
    });

    it('keeps a lessons reflection out of every listing and out of the thread’s own analysis, and still cascades it', async () => {
      const source = await dao.create({ createdAt: new Date(1_000) });
      const review = await dao.create({
        createdAt: new Date(2_000),
        analysisSourceRunId: source.id,
      });
      const labelledReview = await dao.create({
        createdAt: new Date(2_500),
        analysisSourceRunId: source.id,
        analysisPurpose: 'review',
      });
      const lessons = await dao.create({
        createdAt: new Date(3_000),
        analysisSourceRunId: source.id,
        analysisPurpose: 'lessons',
      });

      for (const scope of ['active', 'archived', 'all'] as const) {
        expect(
          (await dao.listChats(scope))
            .map((run) => run.id)
            .filter((id) => id !== source.id),
        ).toEqual([]);
      }
      expect(
        (await dao.listReviewAnalysesOf(source.id)).map((run) => run.id),
      ).toEqual([labelledReview.id, review.id]);
      expect(
        (await dao.listLessonReflectionsOf(source.id)).map((run) => run.id),
      ).toEqual([lessons.id]);
      expect(
        (await dao.listAnalysesOf(source.id)).map((run) => run.id),
      ).toEqual([lessons.id, labelledReview.id, review.id]);
      expect((await dao.teamLedgerChats()).map((run) => run.id).sort()).toEqual(
        [labelledReview.id, review.id].sort(),
      );
    });
  });

  describe('listThreads', () => {
    it('leaves out archived threads, builder chats, project chats and both kinds of analysis, and keeps team runs', async () => {
      const chat = await dao.create({
        title: 'Pelican',
        updatedAt: new Date(2_000),
      });
      const teamRun = await dao.create({
        title: 'Pelican team',
        teamId: 'wf-1',
        updatedAt: new Date(3_000),
      });
      await dao.create({
        title: 'Pelican archived',
        archivedAt: new Date(9_000),
      });
      await dao.create({ title: 'Pelican builder', editsTeamSlug: 'dev-team' });
      await dao.create({
        title: 'Pelican project',
        editsProjectId: 'project-1',
      });
      await dao.create({
        title: 'Pelican analysis',
        analysisSourceRunId: 'source-1',
      });
      await dao.create({
        title: 'Pelican team analysis',
        analysisTeamSlug: 'dev-team',
      });

      const threads = await dao.listThreads(null, 50);

      expect(threads.map((run) => run.id)).toEqual([teamRun.id, chat.id]);
    });

    it('lists the threads last worked in first', async () => {
      const older = await dao.create({
        title: 'older',
        updatedAt: new Date(1_000),
      });
      const newest = await dao.create({
        title: 'newest',
        updatedAt: new Date(3_000),
      });
      const middle = await dao.create({
        title: 'middle',
        updatedAt: new Date(2_000),
      });

      const threads = await dao.listThreads(null, 50);

      expect(threads.map((run) => run.id)).toEqual([
        newest.id,
        middle.id,
        older.id,
      ]);
    });

    it('narrows the listing to the titles that hold the query', async () => {
      const build = await dao.create({
        title: 'Pelican build',
        updatedAt: new Date(3_000),
      });
      await dao.create({ title: 'Otter build', updatedAt: new Date(2_000) });
      const review = await dao.create({
        title: 'Review: Pelican',
        updatedAt: new Date(1_000),
      });

      const threads = await dao.listThreads('pelican', 50);

      expect(threads.map((run) => run.id)).toEqual([build.id, review.id]);
    });

    it('holds the limit to the newest threads', async () => {
      await dao.create({ title: 'a', updatedAt: new Date(1_000) });
      const b = await dao.create({ title: 'b', updatedAt: new Date(2_000) });
      const c = await dao.create({ title: 'c', updatedAt: new Date(3_000) });

      const threads = await dao.listThreads(null, 2);

      expect(threads.map((run) => run.id)).toEqual([c.id, b.id]);
    });
  });

  describe('team analyses', () => {
    it('leaves a team’s analysis out of EVERY scope, and finds it by its slug', async () => {
      const older = await dao.create({
        createdAt: new Date(2_000),
        analysisTeamSlug: 'review-team',
      });
      const newer = await dao.create({
        createdAt: new Date(3_000),
        analysisTeamSlug: 'review-team',
        archivedAt: new Date(9_000),
      });
      await dao.create({
        createdAt: new Date(4_000),
        analysisTeamSlug: 'other-team',
      });
      const chat = await dao.create({ createdAt: new Date(1_000) });

      for (const scope of ['active', 'archived', 'all'] as const) {
        expect(
          (await dao.listChats(scope))
            .map((run) => run.id)
            .filter((id) => id !== chat.id),
        ).toEqual([]);
      }
      expect(
        (await dao.listTeamAnalyses('review-team')).map((run) => run.id),
      ).toEqual([newer.id, older.id]);
      expect((await dao.teamAnalysisSlugs()).sort()).toEqual([
        'other-team',
        'review-team',
      ]);
    });

    it('reads a team’s newest runs, archived ones included, newest first, up to the limit', async () => {
      await dao.create({
        id: 'w1',
        teamId: 'team',
        createdAt: new Date(1_000),
      });
      await dao.create({
        id: 'w2',
        teamId: 'team',
        createdAt: new Date(2_000),
      });
      await dao.create({
        id: 'w3',
        teamId: 'team',
        createdAt: new Date(3_000),
        archivedAt: new Date(5_000),
      });
      await dao.create({
        id: 'w4',
        teamId: 'team',
        createdAt: new Date(4_000),
      });
      await dao.create({
        id: 'x1',
        teamId: 'other',
        createdAt: new Date(6_000),
      });
      await dao.create({ id: 'c1', createdAt: new Date(7_000) });

      expect(
        (await dao.newestTeamRuns('team', 2)).map((run) => run.id),
      ).toEqual(['w4', 'w3']);
      expect(
        (await dao.newestTeamRuns('team', 10)).map((run) => run.id),
      ).toEqual(['w4', 'w3', 'w2', 'w1']);
      expect(
        (await dao.newestTeamRuns('team', null)).map((run) => run.id),
      ).toEqual(['w4', 'w3', 'w2', 'w1']);
    });
  });

  describe('listOrphanedAnalyses', () => {
    it('answers only the analyses whose source thread is gone', async () => {
      const source = await dao.create({});
      // An analysis whose source is alive stays.
      await dao.create({ analysisSourceRunId: source.id });
      const orphan = await dao.create({ analysisSourceRunId: 'deleted-run' });
      await dao.create({});

      expect((await dao.listOrphanedAnalyses()).map((run) => run.id)).toEqual([
        orphan.id,
      ]);
    });

    it('keeps the analysis of an archived thread', async () => {
      const shelved = await dao.create({ archivedAt: new Date() });
      await dao.create({ analysisSourceRunId: shelved.id });

      expect(await dao.listOrphanedAnalyses()).toEqual([]);
    });

    it('answers none when no thread has an analysis', async () => {
      await dao.create({});

      expect(await dao.listOrphanedAnalyses()).toEqual([]);
    });
  });

  describe('archivedRunsBefore', () => {
    it('answers the archived runs shelved at or before the cutoff, oldest first', async () => {
      // Oldest FIRST here, unlike every listing above, and the order is what a
      // sweep interrupted part-way depends on: it has removed the rows furthest
      // past the window, so the next one resumes instead of re-walking them.
      const old = await dao.create({ archivedAt: new Date(1_000) });
      const older = await dao.create({ archivedAt: new Date(500) });
      // Exactly ON the cutoff — `$lte`, because a window is "shelved at least
      // this long ago" and the boundary instant satisfies it.
      const onCutoff = await dao.create({ archivedAt: new Date(5_000) });
      // Past it by a millisecond, and safe.
      await dao.create({ archivedAt: new Date(5_001) });

      expect(
        (await dao.archivedRunsBefore(new Date(5_000))).map((run) => run.id),
      ).toEqual([older.id, old.id, onCutoff.id]);
      expect(await dao.countArchivedBefore(new Date(5_000))).toBe(3);
    });

    it('never answers a chat that is not archived at all', async () => {
      // The one row whose deletion would be unforgivable: a live thread on the
      // desk. `archivedAt` is NULL there, and SQL comparisons against NULL are
      // neither true nor false — so the `$ne: null` is doing real work rather
      // than restating the `$lte`.
      await dao.create({ createdAt: new Date(1_000) });

      expect(await dao.archivedRunsBefore(new Date(9_999))).toEqual([]);
      expect(await dao.countArchivedBefore(new Date(9_999))).toBe(0);
    });

    it('answers a TEAM run too, and says which it is', async () => {
      // It answered chats alone until team runs became archivable, which
      // left the retention window covering half the shelf and saying nothing.
      // The kind rides along because the sweep picks a teardown by it.
      const wf = await dao.create({
        teamId: 'wf-1',
        archivedAt: new Date(1_000),
      });
      const chat = await dao.create({ archivedAt: new Date(2_000) });

      expect(await dao.archivedRunsBefore(new Date(9_999))).toEqual([
        { id: wf.id, teamId: 'wf-1' },
        { id: chat.id, teamId: null },
      ]);
    });
  });

  describe('listRunningChats', () => {
    it('scopes to running chats — non-running chats and team runs are excluded', async () => {
      await dao.create({ status: 'pending' });
      const running = await dao.create({ status: 'running' });
      await dao.create({ status: 'completed' });
      // A mid-turn TEAM run is the team executor's reconcile concern.
      await dao.create({ teamId: 'wf-1', status: 'running' });

      const stale = await dao.listRunningChats();

      expect(stale.map((run) => run.id)).toEqual([running.id]);
    });
  });

  describe('listTeamRuns', () => {
    it('lists team runs only (teamId set), newest first', async () => {
      const older = await dao.create({
        teamId: 'wf-1',
        createdAt: new Date(1_000),
      });
      const newer = await dao.create({
        teamId: 'wf-2',
        createdAt: new Date(2_000),
      });
      await dao.create({ createdAt: new Date(3_000) }); // chat run

      const runs = await dao.listTeamRuns('active');

      expect(runs.map((run) => run.id)).toEqual([newer.id, older.id]);
    });

    it('answers the scope exactly as the chat listing does', async () => {
      // The two halves feed ONE sidebar, so `active` must hide a shelved
      // team run, `archived` must show only it, and `all` must hold both.
      const active = await dao.create({
        teamId: 'wf-1',
        createdAt: new Date(1_000),
      });
      const archived = await dao.create({
        teamId: 'wf-2',
        createdAt: new Date(2_000),
        archivedAt: new Date(9_000),
      });

      expect((await dao.listTeamRuns('active')).map((r) => r.id)).toEqual([
        active.id,
      ]);
      expect((await dao.listTeamRuns('archived')).map((r) => r.id)).toEqual([
        archived.id,
      ]);
      expect((await dao.listTeamRuns('all')).map((r) => r.id)).toEqual([
        archived.id,
        active.id,
      ]);
    });
  });

  describe('listRunningTeamRuns', () => {
    it('treats pending AND running team runs as orphans; terminal and chat runs never appear', async () => {
      // A team run is created `running`, but pending still counts as
      // non-terminal (see the DAO doc comment) — pin both.
      const pending = await dao.create({
        teamId: 'wf-1',
        status: 'pending',
      });
      const running = await dao.create({
        teamId: 'wf-1',
        status: 'running',
      });
      await dao.create({ teamId: 'wf-1', status: 'completed' });
      await dao.create({ teamId: 'wf-1', status: 'failed' });
      await dao.create({ teamId: 'wf-1', status: 'cancelled' });
      await dao.create({ status: 'running' }); // mid-turn chat, not an orphan here

      const stale = await dao.listRunningTeamRuns();

      // No ORDER BY on this query — compare as a set.
      expect(stale.map((run) => run.id).sort()).toEqual(
        [pending.id, running.id].sort(),
      );
    });
  });

  describe('forgetCustomInstructions', () => {
    it('clears the user’s own text and leaves a task run’s task instructions intact', async () => {
      // The two columns exist so this purge — the user retracting their OWN
      // standing text — cannot take a card's label block and report ask with
      // it. Read back through a fresh fork: `nativeUpdate` bypasses the
      // writing fork's identity map.
      const taskRun = await dao.create({
        customInstructions: 'REGRETTED',
        taskInstructions: 'LABEL BLOCK\n\nREPORT ASK',
      });
      const cardOnly = await dao.create({
        taskInstructions: 'ANOTHER CARD',
      });

      await expect(dao.forgetCustomInstructions()).resolves.toBe(1);

      const reader = new RunDao(orm.em.fork());
      const stored = await reader.getById(taskRun.id);
      expect(stored?.customInstructions).toBeNull();
      expect(stored?.taskInstructions).toBe('LABEL BLOCK\n\nREPORT ASK');
      expect((await reader.getById(cardOnly.id))?.taskInstructions).toBe(
        'ANOTHER CARD',
      );
    });
  });

  describe('clearPendingQuestionIf', () => {
    it('clears the column only while it still holds the expected card', async () => {
      // The compare-and-swap a deferred verdict clears its own card with: a
      // different card that went up meanwhile must survive the clear.
      const mine = await dao.create({ pendingQuestion: 'MINE' });
      const other = await dao.create({ pendingQuestion: 'OTHER' });

      await expect(dao.clearPendingQuestionIf(mine.id, 'MINE')).resolves.toBe(
        true,
      );
      await expect(dao.clearPendingQuestionIf(other.id, 'MINE')).resolves.toBe(
        false,
      );

      const reader = new RunDao(orm.em.fork());
      expect((await reader.getById(mine.id))?.pendingQuestion).toBeNull();
      expect((await reader.getById(other.id))?.pendingQuestion).toBe('OTHER');
    });
  });

  describe('retitle', () => {
    // The predicate is the whole no-clobber guarantee, and it lives in SQL —
    // the service's own read is only an early exit, so a fake cannot stand in
    // for these.
    //
    // Every read-back goes through a FRESH dao: `nativeUpdate` writes past the
    // identity map, so the entity the writing fork still holds keeps the old
    // title. That is the DAO's documented caveat, and reading it back through
    // the same fork would assert the cache rather than the row.
    const stored = async (id: string): Promise<string | null> =>
      (await new RunDao(orm.em.fork()).getById(id))?.title ?? null;
    it('names a run whose title is still null', async () => {
      const run = await dao.create({});

      await expect(
        dao.retitle(run.id, 'Fix Conflicts Worktree', null),
      ).resolves.toBe(true);
      expect(await stored(run.id)).toBe('Fix Conflicts Worktree');
    });

    it('refuses to name a run that has since been renamed', async () => {
      // The race the service cannot close by reading first: resolving a title
      // takes several reads, and a PATCH landing inside that window must win.
      const run = await dao.create({ title: 'My own name for this' });

      await expect(dao.retitle(run.id, 'Auto Generated', null)).resolves.toBe(
        false,
      );
      expect(await stored(run.id)).toBe('My own name for this');
    });

    it('replaces one title with another only while the old one is still there', async () => {
      const run = await dao.create({ title: 'look at the merge conflicts' });

      await expect(
        dao.retitle(
          run.id,
          'Fix Conflicts Worktree',
          'look at the merge conflicts',
        ),
      ).resolves.toBe(true);
      expect(await stored(run.id)).toBe('Fix Conflicts Worktree');

      // The same upgrade replayed against the title it no longer holds.
      await expect(
        dao.retitle(run.id, 'Something Else', 'look at the merge conflicts'),
      ).resolves.toBe(false);
      expect(await stored(run.id)).toBe('Fix Conflicts Worktree');
    });

    it('never touches another run', async () => {
      const mine = await dao.create({});
      const theirs = await dao.create({});

      await dao.retitle(mine.id, 'Mine', null);

      expect(await stored(theirs.id)).toBeNull();
    });
  });

  describe('updateWithoutActivity', () => {
    // `updatedAt` is the sidebar's "last activity". A bookkeeping write — the
    // pull-request capture pass run over every listed run, an archive, a pin —
    // moving it re-dated a whole archive to "just now" on opening it.
    const LAST_WORKED = new Date(1_000);
    const readBack = async (id: string) =>
      new RunDao(orm.em.fork()).getById(id);

    it('writes the column and leaves updatedAt where the last real write put it', async () => {
      const run = await dao.create({ updatedAt: LAST_WORKED });

      await dao.updateWithoutActivity(run.id, { pullRequestsScannedSeq: 7 });

      const stored = await readBack(run.id);
      expect(stored?.pullRequestsScannedSeq).toBe(7);
      expect(stored?.updatedAt.getTime()).toBe(LAST_WORKED.getTime());
    });

    it('is a real difference from updateById, which does stamp it', async () => {
      // The control: without it, a harness that never stamped `updatedAt` at
      // all would pass the case above for free.
      const run = await dao.create({ updatedAt: LAST_WORKED });

      await dao.updateById(run.id, { pullRequestsScannedSeq: 7 });

      expect((await readBack(run.id))?.updatedAt.getTime()).toBeGreaterThan(
        LAST_WORKED.getTime(),
      );
    });

    it('leaves nothing for a later flush of the same fork to write again', async () => {
      // The run is MANAGED in the writing fork. A native write the identity
      // map never heard of leaves that copy differing from the row, and the
      // next flush then writes the column a second time — stamping
      // `updatedAt` after all.
      const em = orm.em.fork();
      const writer = new RunDao(em);
      const { id } = await dao.create({ updatedAt: LAST_WORKED });
      const managed = await writer.getById(id);
      expect(managed).not.toBeNull();

      await writer.updateWithoutActivity(id, { taskList: '[]' });
      await em.flush();

      const stored = await readBack(id);
      expect(stored?.taskList).toBe('[]');
      expect(stored?.updatedAt.getTime()).toBe(LAST_WORKED.getTime());
      expect(managed?.taskList).toBe('[]');
    });

    it('pinning and releasing a group do not re-date the thread', async () => {
      const run = await dao.create({ updatedAt: LAST_WORKED, groupId: 'g-1' });

      await dao.repin(run, true);
      expect(run.pinnedPosition).toBe(0);
      await dao.clearGroup('g-1');

      const stored = await readBack(run.id);
      expect(stored?.groupId).toBeNull();
      expect(stored?.pinnedPosition).toBeNull();
      expect(stored?.updatedAt.getTime()).toBe(LAST_WORKED.getTime());
    });
  });

  describe('rememberContext', () => {
    const readBack = async (id: string) =>
      new RunDao(orm.em.fork()).getById(id);

    it('marks a stand-in count until a stated one or a compaction clears it', async () => {
      const run = await dao.create({});

      await dao.rememberContext(run.id, {
        contextTokens: 900,
        contextEstimated: true,
      });
      expect((await readBack(run.id))?.contextEstimated).toBe(true);

      await dao.rememberContext(run.id, { contextTokens: 1_200 });
      expect((await readBack(run.id))?.contextEstimated).toBeNull();

      await dao.rememberContext(run.id, {
        contextTokens: 1_500,
        contextEstimated: true,
      });
      await dao.forgetContext(run.id);
      expect(await readBack(run.id)).toMatchObject({
        contextTokens: null,
        contextEstimated: null,
      });
    });
  });

  describe('rememberWork', () => {
    const readBack = async (id: string) =>
      new RunDao(orm.em.fork()).getById(id);

    it('SUMS across turns rather than replacing — the whole difference from rememberContext', async () => {
      // A chat's totals have to cover the CONVERSATION, not its newest turn:
      // under a replacing writer this reads 300/2, which is what the transcript
      // fold already gives and what the durable column exists to beat.
      const run = await dao.create({});

      await dao.rememberWork(run.id, 500, 3);
      await dao.rememberWork(run.id, 300, 2);

      expect(await readBack(run.id)).toMatchObject({
        workedMs: 800,
        toolCalls: 5,
      });
    });

    it('a turn reporting no timing leaves the time already counted alone', async () => {
      // The ordinary case on every ACP agent — it reports no duration at all,
      // so the tool count must keep accumulating while the clock stands.
      const run = await dao.create({});
      await dao.rememberWork(run.id, 500, 3);

      await dao.rememberWork(run.id, null, 2);

      expect(await readBack(run.id)).toMatchObject({
        workedMs: 500,
        toolCalls: 5,
      });
    });

    it('leaves both figures null when the turn carries nothing positive', async () => {
      const run = await dao.create({});

      await dao.rememberWork(run.id, 0, 0);

      expect(await readBack(run.id)).toMatchObject({
        workedMs: null,
        toolCalls: null,
      });
    });

    it('writes nothing for a run id that does not exist, and does not throw', async () => {
      await expect(
        dao.rememberWork('missing-run', 500, 3),
      ).resolves.toBeUndefined();

      expect(await readBack('missing-run')).toBeNull();
    });
  });

  describe('readWork', () => {
    it('reads back what rememberWork just wrote, THROUGH the identity map', async () => {
      // The whole reason this method exists rather than a `getById` at the call
      // site: `rememberWork` lands as a `nativeUpdate`, which the identity map
      // never sees, so a DAO that has already loaded this run answers with the
      // totals as they stood BEFORE the turn. The settle announce is built from
      // this read, so a stale answer would broadcast last turn's figures as
      // this turn's and freeze every client that trusts them.
      const run = await dao.create({});
      // Load the row first, so the identity map is holding the pre-write copy.
      await dao.getById(run.id);
      await dao.rememberWork(run.id, 500, 3);

      expect(await dao.readWork(run.id)).toEqual({
        workedMs: 500,
        toolCalls: 3,
        promptCacheExpiresAt: null,
        promptCacheTtlMs: null,
        promptCacheTtlReason: null,
      });
    });

    it('answers nulls for a run that has never been measured', async () => {
      // Distinct from the missing-run case below: the run EXISTS and its
      // figures are null, which the announce must carry as null rather than as
      // a zero nobody measured.
      const run = await dao.create({});

      expect(await dao.readWork(run.id)).toEqual({
        workedMs: null,
        toolCalls: null,
        promptCacheExpiresAt: null,
        promptCacheTtlMs: null,
        promptCacheTtlReason: null,
      });
    });

    it('reads back the prompt-cache expiry rememberPromptCache just wrote', async () => {
      // Same identity-map trap as the totals: the write is a `nativeUpdate`.
      const run = await dao.create({});
      await dao.getById(run.id);
      await dao.rememberPromptCache(
        run.id,
        { ttlMs: 3_600_000, reason: null },
        new Date('2026-10-09T10:00:00.000Z'),
      );

      expect((await dao.readWork(run.id))?.promptCacheExpiresAt).toEqual(
        new Date('2026-10-09T11:00:00.000Z'),
      );
    });
  });

  describe('rememberPromptCache', () => {
    const at = new Date('2026-10-09T10:00:00.000Z');

    it('moves the expiry on by the lifetime the run last stated when a turn reports none', async () => {
      // A Stop or a failure reports no usage, but its requests kept the cache
      // warm — so the expiry moves, by the lifetime known from earlier.
      const run = await dao.create({});
      await dao.rememberPromptCache(
        run.id,
        { ttlMs: 300_000, reason: 'extra-usage' },
        at,
      );
      const later = new Date('2026-10-09T10:20:00.000Z');
      await dao.rememberPromptCache(
        run.id,
        { ttlMs: null, reason: null },
        later,
      );

      const read = await dao.readWork(run.id);
      expect(read?.promptCacheExpiresAt).toEqual(
        new Date('2026-10-09T10:25:00.000Z'),
      );
      // The reason explains the lifetime that was reused, so it stays with it.
      expect(read?.promptCacheTtlReason).toBe('extra-usage');
    });

    it('replaces the reason whenever a turn reports a lifetime', async () => {
      // Leaving extra usage: the next turn writes the hour and states no
      // reason, and the stored reason must not go on explaining a lifetime
      // the cache no longer has.
      const run = await dao.create({});
      await dao.rememberPromptCache(
        run.id,
        { ttlMs: 300_000, reason: 'extra-usage' },
        at,
      );
      await dao.rememberPromptCache(
        run.id,
        { ttlMs: 3_600_000, reason: null },
        at,
      );

      const read = await dao.readWork(run.id);
      expect(read?.promptCacheTtlMs).toBe(3_600_000);
      expect(read?.promptCacheTtlReason).toBeNull();
    });

    it('writes nothing for a run that has never stated a lifetime', async () => {
      // A CLI with no prompt cache must never grow an expiry — the composer
      // would warn about a cache that does not exist.
      const run = await dao.create({});
      await dao.rememberPromptCache(run.id, { ttlMs: null, reason: null }, at);

      expect((await dao.readWork(run.id))?.promptCacheExpiresAt).toBeNull();
    });
  });

  describe('reconcileMarks', () => {
    it('answers each run with its newest item seq and the seq recorded for it', async () => {
      await dao.create({ id: 'never-read' });
      await dao.create({ id: 'recorded' });
      await dao.create({ id: 'empty' });
      const items = new ItemDao(orm.em.fork());
      for (const [runId, seq] of [
        ['never-read', 0],
        ['never-read', 4],
        ['recorded', 2],
        ['recorded', 7],
      ] as const) {
        await items.create({ runId, seq, kind: 'message', payload: '{}' });
      }
      await dao.markReconciledThrough('recorded', 7);

      const marks = await new RunDao(orm.em.fork()).reconcileMarks();

      expect(
        new Map(
          marks.map((mark) => [
            mark.runId,
            [mark.newestSeq, mark.reconciledThroughSeq],
          ]),
        ),
      ).toEqual(
        new Map([
          ['never-read', [4, null]],
          ['recorded', [7, 7]],
          ['empty', [-1, null]],
        ]),
      );
    });

    it('records a mark without re-dating the run', async () => {
      const old = new Date('2026-01-01T00:00:00.000Z');
      await dao.create({ id: 'r1', createdAt: old, updatedAt: old });

      await dao.markReconciledThrough('r1', 3);

      const run = await new RunDao(orm.em.fork()).getById('r1');
      expect(run!.reconciledThroughSeq).toBe(3);
      expect(run!.updatedAt.toISOString()).toBe(old.toISOString());
    });

    it('counts a soft-deleted row as the newest seq', async () => {
      await dao.create({ id: 'r1' });
      const items = new ItemDao(orm.em.fork());
      await items.create({
        runId: 'r1',
        seq: 1,
        kind: 'message',
        payload: '{}',
      });
      await items.create({
        runId: 'r1',
        seq: 2,
        kind: 'message',
        payload: '{}',
        deletedAt: new Date(),
      });

      const [mark] = await new RunDao(orm.em.fork()).reconcileMarks();

      expect(mark?.newestSeq).toBe(2);
    });
  });

  describe('pullRequestsOf', () => {
    it('answers only the pull requests a run opened, never the ones it touched', async () => {
      const pr = (number: number) => ({
        owner: 'acme',
        repo: 'platform',
        number,
        url: `https://github.com/acme/platform/pull/${number}`,
        seq: 1,
      });
      const opened = await dao.create({
        pullRequests: JSON.stringify([pr(87)]),
        touchedPullRequests: JSON.stringify([pr(6841)]),
      });
      const touchedOnly = await dao.create({
        touchedPullRequests: JSON.stringify([pr(6841)]),
      });

      const byRun = await dao.pullRequestsOf([opened.id, touchedOnly.id]);

      expect(byRun.get(opened.id)?.map((row) => row.number)).toEqual([87]);
      expect(byRun.has(touchedOnly.id)).toBe(false);
    });
  });

  describe('boardFactsOf', () => {
    it('answers each staged run its current stage and position, and leaves the rest out', async () => {
      const progress = {
        rev: 1,
        current: 'review',
        position: { index: 2, total: 3 },
        stages: [
          { id: 'build', title: 'Build', status: 'done', next: ['review'] },
          { id: 'review', title: 'Review', status: 'current', next: [] },
        ],
      };
      const staged = await dao.create({
        stageProgress: JSON.stringify(progress),
      });
      const finished = await dao.create({
        stageProgress: JSON.stringify({
          ...progress,
          current: null,
          position: { index: 3, total: 3 },
        }),
      });
      const plain = await dao.create({});

      const { stages: byRun } = await dao.boardFactsOf([
        staged.id,
        finished.id,
        plain.id,
      ]);

      expect(byRun.get(staged.id)).toEqual({
        title: 'Review',
        index: 2,
        total: 3,
      });
      expect(byRun.get(finished.id)).toEqual({
        title: null,
        index: 3,
        total: 3,
      });
      expect(byRun.has(plain.id)).toBe(false);
    });

    it('answers in the same read the pull requests each run opened, never the ones it touched', async () => {
      const pr = (number: number) => ({
        owner: 'acme',
        repo: 'platform',
        number,
        url: `https://github.com/acme/platform/pull/${number}`,
        seq: 1,
      });
      const opened = await dao.create({
        pullRequests: JSON.stringify([pr(87)]),
        touchedPullRequests: JSON.stringify([pr(6841)]),
      });
      const touchedOnly = await dao.create({
        touchedPullRequests: JSON.stringify([pr(6841)]),
      });

      const { pullRequests } = await dao.boardFactsOf([
        opened.id,
        touchedOnly.id,
      ]);

      expect(pullRequests.get(opened.id)?.map((row) => row.number)).toEqual([
        87,
      ]);
      expect(pullRequests.has(touchedOnly.id)).toBe(false);
    });
  });

  describe('readWork (missing run)', () => {
    it('answers null for a run id that does not exist, and does not throw', async () => {
      // The settle path reads this AFTER writing the status, so a run torn down
      // underneath it must cost the announce its figures and never the settle.
      await expect(dao.readWork('missing-run')).resolves.toBeNull();
    });
  });

  describe('a run being deleted with lessons extracted first', () => {
    it('leaves a chat being deleted out of the chat listings, the thread listing and the shelf counts', async () => {
      const kept = await dao.create({
        title: 'kept',
        createdAt: new Date(1_000),
      });
      await dao.create({
        title: 'deleting',
        createdAt: new Date(2_000),
        pendingDeleteAt: new Date(9_000),
      });

      expect((await dao.listChats('active')).map((r) => r.id)).toEqual([
        kept.id,
      ]);
      expect((await dao.listThreads(null, 50)).map((r) => r.id)).toEqual([
        kept.id,
      ]);
      expect(await dao.countByShelf()).toEqual({ active: 1, archived: 0 });
    });

    it('leaves a team run being deleted out of the team listing and the shelf counts', async () => {
      const kept = await dao.create({
        teamId: 'wf-1',
        createdAt: new Date(1_000),
      });
      await dao.create({
        teamId: 'wf-1',
        createdAt: new Date(2_000),
        archivedAt: new Date(9_000),
        pendingDeleteAt: new Date(9_000),
      });

      expect((await dao.listTeamRuns('all')).map((r) => r.id)).toEqual([
        kept.id,
      ]);
      expect(await dao.countByShelf()).toEqual({ active: 1, archived: 0 });
    });

    it('lists only the runs pending delete, for the start-up delete', async () => {
      await dao.create({ createdAt: new Date(1_000) });
      const pending = await dao.create({
        teamId: 'wf-1',
        createdAt: new Date(2_000),
        pendingDeleteAt: new Date(9_000),
      });

      expect((await dao.listPendingDeletes()).map((r) => r.id)).toEqual([
        pending.id,
      ]);
    });
  });
});
