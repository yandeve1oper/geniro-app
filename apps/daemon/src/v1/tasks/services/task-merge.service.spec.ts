import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { RunDao } from '../../agents/dao/run.dao';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import { fakeLiveWork } from '../__tests__/fake-live-work';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import { TASKS_AWAITING_MERGE_MAX } from '../tasks.types';
import { TaskAttachmentService } from './task-attachment.service';
import { TaskEventBus } from './task-events.bus';
import { TaskMergeService } from './task-merge.service';
import { TasksService } from './tasks.service';

/**
 * Real database throughout, on `task-settle.service.spec.ts`' own reasoning:
 * what is under test is which cards are handed out and where one lands, both
 * of which are reads of stored state.
 */
const ATTACHMENTS_ROOT = join(tmpdir(), 'geniro-task-merge-spec');

const PR_URL = 'https://github.com/geniro-io/geniro-app/pull/7';

/** When GitHub says a pull request merged — any time serves a card never Done. */
const MERGED_AT = '2026-09-07T12:00:00Z';

describe('TaskMergeService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: TaskMergeService;
  let tasks: TasksService;
  let taskDao: TaskDao;
  let runDao: RunDao;
  let em: EntityManager;
  let projectId: string;
  let runSeq = 0;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Project, Task, Run, Item],
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
    em = orm.em.fork();
    runSeq = 0;
    taskDao = new TaskDao(em);
    runDao = new RunDao(em);
    const projectDao = new ProjectDao(em);
    tasks = new TasksService(
      em,
      taskDao,
      projectDao,
      new TaskEventBus(),
      new TaskAttachmentService(ATTACHMENTS_ROOT),
      runDao,
      fakeLiveWork().liveWork,
    );
    service = new TaskMergeService(em, taskDao, runDao, tasks);
    const project = await projectDao.create({
      name: 'Board',
      folder: '/tmp/geniro-task-merge-spec',
    });
    projectId = project.id;
  });

  /** `urls` as the run row stores the pull requests it opened. */
  const opened = (urls: string[]): string =>
    JSON.stringify(
      urls.map((url, index) => ({
        owner: 'geniro-io',
        repo: 'geniro-app',
        number: 7 + index,
        url,
        seq: index,
      })),
    );

  /** A card in review, whose run captured `urls` as the pull requests it opened. */
  const inReview = async (urls: string[] = [PR_URL], title = 'ship it') => {
    runSeq += 1;
    const runId = `run-${runSeq}`;
    const task = await tasks.create({ projectId, title });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'in_progress' });
    await runDao.create({
      id: runId,
      teamId: null,
      status: 'completed',
      agentKind: 'claude',
      taskId: task.id,
      pullRequests: opened(urls),
    });
    await tasks.update(task.id, { runId });
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });
    return { task, runId };
  };

  /**
   * `count` cards in review, card `index` with a run that opened
   * `urlsOf(index)`, written in one flush per table — for the cases that need
   * a column past the cap.
   *
   * Through {@link inReview} that is five writes a card and 101 cards a case:
   * ~0.7s on an idle machine, and past the 5s timeout on a loaded one. What
   * these cases check is which stored cards a sweep hands out, so the rows are
   * the ones `inReview` leaves, written directly. Each card is a millisecond
   * newer than the one before, as cards made one after another are.
   */
  const manyInReview = async (
    count: number,
    urlsOf: (index: number) => string[],
  ): Promise<string[]> => {
    const from = Date.now();
    const cards = Array.from({ length: count }, (_, index) => {
      runSeq += 1;
      return {
        runId: `run-${runSeq}`,
        at: new Date(from + index),
        urls: urlsOf(index),
      };
    });
    const created = await taskDao.createMany(
      cards.map(({ runId, at }, index) => ({
        projectId,
        title: `card ${index}`,
        number: index + 1,
        status: 'in_review' as const,
        runId,
        createdAt: at,
        updatedAt: at,
      })),
    );
    await runDao.createMany(
      cards.map(({ runId, urls }, index) => ({
        id: runId,
        teamId: null,
        status: 'completed' as const,
        agentKind: 'claude' as const,
        taskId: created[index]!.id,
        pullRequests: opened(urls),
      })),
    );
    return created.map((task) => task.id);
  };

  describe('listAwaitingMerge', () => {
    it('hands out a card in review with the pull requests its run opened', async () => {
      const { task } = await inReview();

      expect(await service.listAwaitingMerge()).toEqual([
        {
          taskId: task.id,
          projectId,
          title: 'ship it',
          pullRequests: [
            {
              owner: 'geniro-io',
              repo: 'geniro-app',
              number: 7,
              url: PR_URL,
              seq: 0,
            },
          ],
          lastDoneAt: null,
        },
      ]);
    });

    it('leaves out a card whose run opened nothing', async () => {
      await inReview([]);

      // The caller's only use for a row is to ask GitHub about it, so a card
      // it can ask nothing about is a lookup paid for no possible answer.
      expect(await service.listAwaitingMerge()).toEqual([]);
    });

    it('never watches, ends or shows a pull request the run only touched', async () => {
      const { task, runId } = await inReview([]);
      await runDao.updateWithoutActivity(runId, {
        touchedPullRequests: JSON.stringify([
          {
            owner: 'geniro-io',
            repo: 'geniro-app',
            number: 9,
            url: PR_URL,
            seq: 0,
          },
        ]),
      });

      expect(await service.listAwaitingMerge()).toEqual([]);
      await expect(
        service.settleMerged(task.id, PR_URL, MERGED_AT),
      ).rejects.toThrow(/TASK_PULL_REQUEST_UNKNOWN|did not open/u);
      expect((await tasks.get(task.id)).pullRequests).toEqual([]);
    });

    it('leaves out a card that is not in review', async () => {
      const { task } = await inReview();
      await tasks.moveStatus(task.id, { from: 'in_review', to: 'todo' });

      expect(await service.listAwaitingMerge()).toEqual([]);
    });

    it('caps how many cards one sweep hands out', async () => {
      await manyInReview(TASKS_AWAITING_MERGE_MAX + 1, (index) => [
        `${PR_URL}${index}`,
      ]);

      // An unattended tick must not grow with a column somebody left in review
      // for a year — each card costs the watcher a lookup against GitHub.
      expect(await service.listAwaitingMerge()).toHaveLength(
        TASKS_AWAITING_MERGE_MAX,
      );
    });

    /** Make one card the newest in review, whatever the clock did meanwhile. */
    const newest = async (taskId: string): Promise<void> => {
      await em.nativeUpdate(
        Task,
        { id: taskId },
        { updatedAt: new Date(Date.now() + 60_000) },
      );
    };

    // The cap applies AFTER the cards with nothing to watch are dropped, or a
    // full window of them hides every card that has a pull request.
    it('finds a card to watch behind a full window of cards with none', async () => {
      await manyInReview(TASKS_AWAITING_MERGE_MAX, () => []);
      const { task } = await inReview([PR_URL], 'watch me');
      await newest(task.id);

      expect(
        (await service.listAwaitingMerge()).map((row) => row.taskId),
      ).toEqual([task.id]);
    });

    // A pull request that stays open, or is closed without merging, leaves its
    // card in review and its `updatedAt` untouched — so a handout that always
    // began at the oldest named the same cards on every sweep.
    it('reaches a card past the cap on a later sweep', async () => {
      const ids = await manyInReview(TASKS_AWAITING_MERGE_MAX + 1, (index) => [
        `${PR_URL}${index}`,
      ]);
      await newest(ids[ids.length - 1]!);

      const first = await service.listAwaitingMerge();
      const second = await service.listAwaitingMerge();

      expect(first).toHaveLength(TASKS_AWAITING_MERGE_MAX);
      expect(second).toHaveLength(TASKS_AWAITING_MERGE_MAX);
      expect(new Set([...first, ...second].map((row) => row.taskId)).size).toBe(
        ids.length,
      );
    });
  });

  describe('settleMerged', () => {
    it('ends a card in review whose pull request was merged', async () => {
      const { task } = await inReview();

      const moved = await service.settleMerged(task.id, PR_URL, MERGED_AT);

      expect(moved.status).toBe('done');
      expect((await tasks.get(task.id)).status).toBe('done');
    });

    it('leaves a card the user has already moved on where it is', async () => {
      const { task } = await inReview();
      await tasks.moveStatus(task.id, { from: 'in_review', to: 'todo' });

      // An ordinary race: the sweep runs on a timer against a board somebody
      // is using. Ending it anyway would drag the card out of the column they
      // just chose for it.
      const answered = await service.settleMerged(task.id, PR_URL, MERGED_AT);

      expect(answered.status).toBe('todo');
    });

    it('refuses a pull request this card never opened', async () => {
      const { task } = await inReview();

      // Not a race — a caller reporting about the wrong card, which would end
      // work nobody finished.
      await expect(
        service.settleMerged(
          task.id,
          'https://github.com/other/repo/pull/1',
          MERGED_AT,
        ),
      ).rejects.toThrow(/TASK_PULL_REQUEST_UNKNOWN|did not open/u);
      expect((await tasks.get(task.id)).status).toBe('in_review');
    });

    it('refuses a card that no longer exists', async () => {
      await expect(
        service.settleMerged('nope', PR_URL, MERGED_AT),
      ).rejects.toThrow(/TASK_NOT_FOUND|not found/u);
    });

    it('ends a card that has never been Done even when GitHub gave no merge time', async () => {
      // The boundary only exists once a card has been Done: before that, every
      // merge of a pull request this card opened is this round's.
      const { task } = await inReview();

      const moved = await service.settleMerged(task.id, PR_URL, null);

      expect(moved.status).toBe('done');
    });
  });

  /**
   * A card re-opened after Done continues the SAME thread, and a run's
   * captures only ever grow — so the pull request that ended it the first
   * time is merged still. These pin the boundary `Task.lastDoneAt`, and that it
   * is judged by when a merge HAPPENED rather than by when a pull request was
   * captured.
   */
  describe('a card that has been Done before', () => {
    const NEXT_URL = 'https://github.com/geniro-io/geniro-app/pull/8';

    const capture = (url: string, number: number, seq: number) => ({
      owner: 'geniro-io',
      repo: 'geniro-app',
      number,
      url,
      seq,
    });

    /** When the card last entered Done, as its row holds it. */
    const lastDoneAt = async (taskId: string): Promise<Date> => {
      const row = await orm.em.fork().findOneOrFail(Task, { id: taskId });
      expect(row.lastDoneAt).toBeInstanceOf(Date);
      return row.lastDoneAt!;
    };

    const offsetFrom = (at: Date, ms: number): string =>
      new Date(at.getTime() + ms).toISOString();

    /** The refusal's own code, read off the exception rather than its prose. */
    const PREVIOUS_ROUND = { errorCode: 'TASK_PULL_REQUEST_PREVIOUS_ROUND' };

    /**
     * The regression: PR #7 still OPEN, and the card dragged to Done and
     * straight back — a mis-drag or an undo is enough.
     */
    const draggedToDoneAndBack = async () => {
      const { task } = await inReview([PR_URL]);
      await tasks.moveStatus(task.id, { from: 'in_review', to: 'done' });
      await tasks.moveStatus(task.id, { from: 'done', to: 'in_review' });
      return task;
    };

    it('is ended by the later merge of a pull request that was still open when it went to Done and back', async () => {
      // Judged by when #7 was CAPTURED, it never could be: the capture predates
      // the drag, and a capture is dated by its first sighting for good.
      const task = await draggedToDoneAndBack();
      const mergedAt = offsetFrom(await lastDoneAt(task.id), 60_000);

      const moved = await service.settleMerged(task.id, PR_URL, mergedAt);

      expect(moved.status).toBe('done');
    });

    // The merge time is GitHub's and the boundary this Mac's. The watcher ends a
    // card seconds after the merge, so a Mac clock running behind GitHub's put
    // the boundary BEFORE that merge — and the re-opened card was ended again
    // by the very merge that ended its first round.
    it('never lets the merge a card was ended ON end it again, whatever this clock says', async () => {
      const { task } = await inReview([PR_URL]);
      // GitHub's clock a minute AHEAD of this one.
      const mergedAt = new Date(Date.now() + 60_000).toISOString();
      await service.settleMerged(task.id, PR_URL, mergedAt);
      await tasks.moveStatus(task.id, { from: 'done', to: 'in_review' });

      await expect(
        service.settleMerged(task.id, PR_URL, mergedAt),
      ).rejects.toMatchObject(PREVIOUS_ROUND);
    });

    it('still lists that card, with the boundary the watcher judges its merge by', async () => {
      const task = await draggedToDoneAndBack();

      expect(await service.listAwaitingMerge()).toEqual([
        {
          taskId: task.id,
          projectId,
          title: 'ship it',
          pullRequests: [capture(PR_URL, 7, 0)],
          lastDoneAt: (await lastDoneAt(task.id)).toISOString(),
        },
      ]);
    });

    /**
     * The case the boundary exists for: PR #7 merged and ended the card; the
     * user re-opened it and the agent opened #8 in the same thread; the card is
     * in review again with #8 unreviewed.
     */
    const reopenedAfterMerge = async () => {
      const { task, runId } = await inReview([PR_URL]);
      const firstMerge = new Date(Date.now() - 60_000).toISOString();
      await service.settleMerged(task.id, PR_URL, firstMerge);
      await tasks.moveStatus(task.id, { from: 'done', to: 'in_progress' });
      await runDao.updateById(runId, {
        pullRequests: JSON.stringify([
          capture(PR_URL, 7, 0),
          capture(NEXT_URL, 8, 1),
        ]),
      });
      await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });
      return { task, firstMerge };
    };

    it('refuses to end it again on the merge that ended it the first time', async () => {
      // Accepted, the card went straight back to Done and its worktree was
      // collected while #8 was still in review.
      const { task, firstMerge } = await reopenedAfterMerge();

      await expect(
        service.settleMerged(task.id, PR_URL, firstMerge),
      ).rejects.toMatchObject(PREVIOUS_ROUND);
      expect((await tasks.get(task.id)).status).toBe('in_review');
    });

    it('ends it on the merge of the pull request opened since', async () => {
      const { task } = await reopenedAfterMerge();
      const mergedAt = offsetFrom(await lastDoneAt(task.id), 60_000);

      const moved = await service.settleMerged(task.id, NEXT_URL, mergedAt);

      expect(moved.status).toBe('done');
    });

    it('refuses a merge whose time GitHub did not give', async () => {
      // It may be the finished round's: ending a card on that is the defect,
      // while leaving one in review costs a drag.
      const { task } = await reopenedAfterMerge();

      await expect(
        service.settleMerged(task.id, NEXT_URL, null),
      ).rejects.toMatchObject(PREVIOUS_ROUND);
      expect((await tasks.get(task.id)).status).toBe('in_review');
    });

    it('refuses a merge stamped at the very instant the card reached Done', async () => {
      // "After" is strict: a merge no later than the move to Done belongs to
      // the round that move ended.
      const { task } = await reopenedAfterMerge();
      const at = (await lastDoneAt(task.id)).toISOString();

      await expect(
        service.settleMerged(task.id, NEXT_URL, at),
      ).rejects.toMatchObject(PREVIOUS_ROUND);
    });

    it('lists the finished round’s pull request beside the new one, with the boundary', async () => {
      // The watcher tells them apart by when each MERGED — so both are handed
      // out, and so is the instant that separates them.
      const { task } = await reopenedAfterMerge();

      expect(await service.listAwaitingMerge()).toEqual([
        expect.objectContaining({
          taskId: task.id,
          pullRequests: [capture(PR_URL, 7, 0), capture(NEXT_URL, 8, 1)],
          lastDoneAt: (await lastDoneAt(task.id)).toISOString(),
        }),
      ]);
    });

    it('is still ended when sent back for another pass on the SAME open pull request', async () => {
      // A restart is not a boundary: a card taken out of review for another
      // pass keeps its open pull request, and that pull request's merge is the
      // one that ends it.
      const { task } = await inReview([PR_URL]);
      await tasks.moveStatus(task.id, { from: 'in_review', to: 'in_progress' });
      await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });

      expect(
        (await service.listAwaitingMerge()).flatMap((row) =>
          row.pullRequests.map((pullRequest) => pullRequest.url),
        ),
      ).toEqual([PR_URL]);
      expect(
        (await service.settleMerged(task.id, PR_URL, MERGED_AT)).status,
      ).toBe('done');
    });
  });
});
