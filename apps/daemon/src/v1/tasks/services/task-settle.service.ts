import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import {
  type InterruptCause,
  parseInterruptCause,
  resumesUnattended,
} from '../../../utils/stop-cause';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import { RunTeardownService } from '../../agents/services/run-teardown.service';
import {
  asRecord,
  parseJsonColumn,
  payloadString,
} from '../../agents/utils/json-util';
import { ProjectDao } from '../../projects/dao/project.dao';
import type { Project } from '../../projects/entity/project.entity';
import {
  AUTOPILOT_LIMIT_FALLBACK_MS,
  AUTOPILOT_LIMIT_RESET_GRACE_MS,
} from '../../projects/projects.types';
import { ProjectEventBus } from '../../projects/services/project-events.bus';
import { isBreakerOpen } from '../../projects/utils/breaker';
import {
  type AgentKind,
  isTerminalRunStatus,
  type ItemKind,
  type RunStatus,
} from '../../runs/runs.types';
import { resetInstantFrom } from '../../teams/utils/reset-instant';
import { TaskDao } from '../dao/task.dao';
import type { Task } from '../entity/task.entity';
import type { TaskStatus, TaskWire } from '../tasks.types';
import { TaskEventBus } from './task-events.bus';
import { TasksService } from './tasks.service';

/**
 * Where a card that was being WORKED lands when its run ends in a way the agent
 * could not report itself.
 *
 * `completed` is deliberately absent. A run finishing is not the task being
 * finished — the agent says that itself, through `update_task`, together with
 * its report (`TaskBoardToolService`). Moving the card here on the run's own
 * ending is what put a thread's last message on the card as its "report",
 * which was whatever the agent happened to say last — an interim "waiting for
 * the check, then I'll open the PR" as readily as a conclusion.
 *
 * A failure and a cancel stay: an agent whose process died cannot call a tool,
 * and a user who pressed Stop has already decided. A cancel sends the card
 * back to the column it can be started from rather than marking it failed —
 * they did not fail at anything.
 */
const ENDED_TASK_STATUS: Partial<Record<RunStatus, TaskStatus>> = {
  failed: 'failed',
  cancelled: 'todo',
};

/**
 * How a run ended, as far as its card is concerned: its status, or
 * `interrupted` — a `failed` run whose work was cut off by the DAEMON stopping
 * rather than by anything the agent or the user did.
 */
type RunEnding = RunStatus | 'interrupted';

/**
 * The rows the boot reconcile writes AFTER an interruption's closing `error`,
 * which {@link TaskSettleService.interruptCauseOf} looks past to find it.
 *
 * `ChatService.reconcileOrphanedRuns` follows its error with `unanswerable`
 * rows, `TeamExecutorService.reconcileOrphanedRuns` adds a `status` per open
 * member turn and a `call_result` per open call, and the delegate and shell boot
 * sweeps that run after both close what the dead process left out. None of
 * them is the run carrying on; all of them are bookkeeping about how it
 * stopped.
 */
const INTERRUPTION_TRAILERS: readonly ItemKind[] = [
  'unanswerable',
  'status',
  'call_result',
  'subagent_info',
  'shell_info',
];

/**
 * Where an interrupted card waits to be picked up again, when the project's
 * intake column is not one a card can wait in.
 *
 * The intake column is a free choice in the autopilot's settings, and moving a
 * card to `done` would announce its work FINISHED and have its worktree
 * collected — so only the two waiting columns are honoured.
 */
const WAITING_COLUMNS: readonly TaskStatus[] = ['backlog', 'todo'];

/**
 * What the board does when a task's run ends by itself.
 *
 * This module OBSERVES the agent plane and never drives it — the same shape
 * `v1/stats` takes, and for the same reason: `AgentEventBus` is where both
 * execution paths converge, so one subscription covers every way a run can
 * settle and nothing in `v1/agents` has to know that tasks exist.
 *
 * It no longer writes a report and no longer moves a card on success; both are
 * the agent's (see {@link ENDED_TASK_STATUS}). What is left is what an agent
 * cannot do for itself: park a card whose run failed or was stopped, put back
 * a card whose run the daemon's own shutdown cut off, keep the autopilot's
 * failure streak, release a card whose run was deleted, and end the run's
 * processes once its card's work is finished. A card that merely settles keeps
 * its CLI for the kept-session idle window.
 */
@Injectable()
export class TaskSettleService implements OnModuleInit {
  private readonly logger = new Logger(TaskSettleService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
    private readonly runDao: RunDao,
    private readonly taskDao: TaskDao,
    private readonly projectDao: ProjectDao,
    private readonly tasks: TasksService,
    /**
     * Read for one question only — whether a failed run's LAST word is the
     * boot reconcile's `interrupted` row (see {@link interruptCauseOf}). The
     * run's status cannot say it: an interrupted run is closed `failed`.
     */
    private readonly itemDao: ItemDao,
    private readonly projectEvents: ProjectEventBus,
    private readonly adapters: AgentAdapterRegistry,
    private readonly sessions: AgentSessionRegistry,
    private readonly taskEvents: TaskEventBus,
    private readonly teardown: RunTeardownService,
  ) {}

  onModuleInit(): void {
    this.tasks.useOwedReconcile((taskId) => {
      void this.reconcileTask(taskId).catch((error: unknown) => {
        this.logger.warn(
          `could not reconcile task ${taskId} after its start: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
    this.bus.allStatuses().subscribe((event) => {
      if (event.status === 'running') {
        void this.followRunWorking(event.runId).catch((error: unknown) => {
          this.logger.warn(
            `could not put the task for run ${event.runId} back to work: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
        return;
      }
      // An announce carries a null status to say only what the run is DOING;
      // it asserts nothing about settling.
      if (event.status == null || !isTerminalRunStatus(event.status)) {
        return;
      }
      const status = event.status;
      // Detached rather than awaited: a rejection escaping an RxJS subscriber
      // becomes an unhandled rejection, and a board that cannot be updated
      // must not take the turn's own settle down with it.
      void this.settle(event.runId, status).catch((error: unknown) => {
        this.logger.warn(
          `could not settle the task for run ${event.runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });

    this.taskEvents.allChanges().subscribe((event) => {
      if (event.reason !== 'work-finished') {
        return;
      }
      void this.endFinishedWork(event.taskId).catch((error: unknown) => {
        this.logger.warn(
          `could not end the processes of finished task ${event.taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });

    this.bus.allDeleted().subscribe((runId) => {
      void this.releaseDeletedRun(runId).catch((error: unknown) => {
        this.logger.warn(
          `could not release the task holding deleted run ${runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
  }

  /**
   * A card's work is FINISHED and its worktree is about to be collected: end
   * its run's processes now rather than at the end of the kept-session window.
   * The CLIs close gracefully first; a command the agent detached is outside
   * their process group, so what is left is reaped once they are gone, never
   * during, so the reap does not signal a CLI still finishing.
   *
   * Asked again against the card and run as they are NOW, since the event was
   * written: a Run press or a Follow up landing in between has started a turn
   * on the very process this would close. An archived or deleted run is left
   * to its teardown, which reaps it once.
   */
  private async endFinishedWork(taskId: string): Promise<void> {
    const em = this.em.fork();
    const task = await this.taskDao.getById(taskId, em);
    if (!task?.runId) {
      return;
    }
    const run = await this.runDao.getById(task.runId, em);
    const { taskIds } = await this.tasks.finishedAmong([taskId]);
    if (
      taskIds.length === 0 ||
      run === null ||
      run.archivedAt !== null ||
      this.tasks.isStarting(taskId) ||
      this.teardown.hasEnded(task.runId)
    ) {
      return;
    }
    await this.sessions.closeFinishedRun(task.runId);
    this.teardown.reapDetached(task.runId);
  }

  /**
   * Put a FAILED card back to work when the run it failed on works again;
   * any other card whose own run works again is announced where it stands.
   *
   * A card's run is an ordinary chat, so a turn that errored is routinely
   * followed by the user carrying the conversation on IN THE CHAT — which goes
   * straight to `ChatService` and never through `TaskRunsService`, the path
   * that moves a card when the panel's Follow up is pressed. Without this the
   * card sat in `failed` for good under a conversation that went on to finish
   * cleanly. REPORTED on the card that asked for merged pull requests to end
   * in `done`, which its own recovered run could then never reach.
   *
   * ONLY `failed` is lifted: a card in review is one whose conversation the
   * user continues deliberately, and the agent moves it again itself if the
   * work reopens.
   */
  private async followRunWorking(runId: string): Promise<void> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run?.taskId) {
      return;
    }
    const task = await this.taskDao.getById(run.taskId, em);
    // A card that has since been started on a DIFFERENT run failed on that
    // one, not on this.
    if (!task || task.runId !== runId) {
      return;
    }
    if (task.status !== 'failed') {
      this.tasks.announceRunChanged(task);
      return;
    }
    await this.tasks.moveStatus(task.id, { from: 'failed', to: 'in_progress' });
  }

  /**
   * Let go of a run that has been deleted out from under its card.
   *
   * A task's run is an ordinary chat, so it can be deleted from the chat
   * sidebar like any other — and the card holding it then names a run nothing
   * can answer for. Left alone it sits in `in_progress` for good with Run
   * disabled, because the button asks the RUN whether an agent is working and
   * a missing run is not a settled one.
   *
   * So the edge is cleared and a card that was being worked goes back to the
   * column it can be started from. The REPORT stays: it is stored on the card
   * and is the card's account of the work, not a pointer into the transcript.
   *
   * The WORKTREE is deliberately untouched — the branch and the directory are
   * main's, they outlive the conversation, and the agent's work is in them.
   */
  private async releaseDeletedRun(runId: string): Promise<void> {
    const em = this.em.fork();
    const task = await this.taskDao.findByRunId(runId, em);
    if (!task) {
      return;
    }
    await this.tasks.update(task.id, { runId: null });
    if (task.status === 'in_progress') {
      await this.tasks.moveStatus(task.id, {
        from: 'in_progress',
        to: 'todo',
      });
    }
  }

  /**
   * Reconcile one run's card against the run's stored status.
   *
   * The same call the subscription makes, exposed because the broadcast is the
   * one thing a closed app misses: a run that settles while no window is open
   * announces to nobody, so the card is reconciled from the row when the board
   * next loads it.
   *
   * `from` says which of the two is asking, and it decides one thing only:
   * when the ending is COUNTED against the failure streak. An `event` is the
   * one announcement of this ending, so it counts. A `reconcile` re-reads a row
   * that has usually been counted already — see the note under the move.
   */
  async settle(
    runId: string,
    status: RunStatus,
    from: 'event' | 'reconcile' = 'event',
  ): Promise<void> {
    if (!isTerminalRunStatus(status)) {
      return;
    }
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run?.taskId) {
      return;
    }
    const task = await this.taskDao.getById(run.taskId, em);
    // A card deleted while its agent worked, or one that has since been
    // started on a DIFFERENT run — an older run settling must not move a card
    // that has moved on from it.
    if (!task || task.runId !== runId) {
      return;
    }
    // A Run press or a Follow up in flight: the start moves the card to
    // `in_progress` before its run is working, and until then the card names
    // a SETTLED run — the one being continued, or the previous one. Reconciled
    // now, the card the user just pressed would be put back (a Stop
    // re-stamped, a failure counted again) under a run about to work. Held
    // off, not dropped: a start that fails with the card where it found it
    // announces nothing, so the reconcile is made again, against the card's
    // CURRENT run, once the start lets go (`reconcileTask`).
    if (from === 'reconcile' && this.tasks.isStarting(task.id)) {
      this.tasks.deferReconcile(task.id);
      return;
    }
    const worked = task.status === 'in_progress';
    const interruptedBy =
      status === 'failed' ? await this.interruptCauseOf(runId, em) : null;
    const ending: RunEnding = interruptedBy !== null ? 'interrupted' : status;
    const limitUntil =
      ending === 'failed'
        ? await this.usageLimitEndOf(runId, run.agentKind, em)
        : null;
    // A Stop is recorded on the CARD, ahead of the move that puts it back in
    // the intake column, so it arrives there already marked. The run's own
    // `cancelled` is not enough to go on: the user continuing the thread moves
    // the run on, and with it the only evidence that they had stopped the card
    // — see `Task.stoppedAt`. Only a card that was being WORKED: stopping one
    // follow-up turn of a card in review stops no task, and marking it there
    // left the autopilot skipping the card long after the thread finished.
    if (ending === 'cancelled' && worked) {
      await this.taskDao.setStoppedAt(task.id, new Date(), em);
    }
    // An interruption the app did not make on purpose — a crash, or a stop
    // nobody announced — is held for a person the way a Stop is: the agent may
    // have been halfway through an edit, and the autopilot continuing the card
    // would re-send its brief over whatever it left in the worktree.
    if (interruptedBy !== null && worked && !resumesUnattended(interruptedBy)) {
      await this.taskDao.setStoppedAt(task.id, new Date(), em, interruptedBy);
    }
    if (from === 'event') {
      // The AGENT's verdict outranks the run's: a card it moved to `failed`
      // through `update_task` is a task that failed, however cleanly the turn
      // that said so ended. Read as a completion, it CLEARED the streak — so an
      // autopilot whose every card was declared failed never tripped its
      // breaker. Counted as the failure of a card that was being worked, which
      // it was until the agent moved it.
      const declaredFailed = ending === 'completed' && task.status === 'failed';
      await this.recordOutcome(
        task.projectId,
        declaredFailed ? 'failed' : ending,
        worked || declaredFailed,
        limitUntil,
        em,
      );
    }
    // A card in Done — the user's drag, or the agent's own `update_task` —
    // becomes FINISHED now, or once the run's live work outside a turn ends:
    // the move could not release the worktree while the agent still worked.
    if (task.status === 'done') {
      const finished = await this.tasks.finishWhenFree(task);
      if (!finished && from === 'event') {
        this.tasks.announceRunChanged(task);
      }
      return;
    }
    // Only a card still reading as worked is moved. The run is an ordinary
    // chat, so a follow-up after review settles it again — and a card the
    // agent or the user already moved must stay where they put it.
    //
    // An INTERRUPTED card goes back to where the autopilot picks work up. Not
    // to `failed` — the agent failed at nothing; the app was quit, or the
    // daemon died, under it — and not necessarily to the `todo` a Stop sends
    // a card to: a Stop parks the card for the user, while this one is meant
    // to be picked up again, so it goes to the project's intake column. Its
    // run reads `failed` rather than `cancelled`, so the queue does not list
    // it as stopped either — unless a crash, or a stop nobody announced, cut
    // it off, which the hold above leaves to a person. The next Run, pressed
    // or the autopilot's, CONTINUES its thread: the run is settled, so
    // `TaskRunsService.resumableRun` takes it like any other.
    const to =
      ending === 'interrupted'
        ? await this.intakeColumn(task.projectId, em)
        : ENDED_TASK_STATUS[ending];
    if (to === undefined || !worked) {
      // Never from a reconcile: a board reconciles on every load and every
      // `task_changed`, so announcing there would reload the board for good.
      if (from === 'event') {
        this.tasks.announceRunChanged(task);
      }
      return;
    }
    await this.tasks.moveStatus(task.id, { from: 'in_progress', to });
    // A reconcile counts an ending only when it is the one that MOVES the card.
    // It re-reads every card still in `in_progress` on every board load and
    // every `task_changed`, and a card whose run COMPLETED is never moved here
    // (its agent moves it), so counting on that path cleared the streak again
    // on each load — an open board kept the breaker from ever tripping while
    // other cards failed. The move is also what makes the count happen once:
    // the card leaves `in_progress`, so no later load reads this run again.
    // After the move rather than before it, so two boards reconciling at once
    // count only the one whose compare-and-set won.
    if (from === 'reconcile') {
      await this.recordOutcome(task.projectId, ending, worked, limitUntil, em);
    }
  }

  /**
   * Why this run was cut off, when its last word is the boot reconcile saying
   * so — the `error` row carrying `interrupted: true` (and the cause) that
   * `ChatService.reconcileOrphanedRuns` and
   * `TeamExecutorService.reconcileOrphanedRuns` write for a run the daemon
   * stopped under (a SIGKILL, or a shutdown, which leaves a working run
   * `running` on purpose so that it is closed this way).
   *
   * The LAST word, not merely the newest error: a thread continued after an
   * interruption and then failed for real has moved on from it, so the newest
   * row that is not one of the reconcile's own trailers
   * ({@link INTERRUPTION_TRAILERS}) has to BE that error. One indexed query
   * for one row. Null when the run was not cut off.
   */
  private async interruptCauseOf(
    runId: string,
    em: EntityManager,
  ): Promise<InterruptCause | null> {
    const last = await this.itemDao.getOne(
      { runId, kind: { $nin: [...INTERRUPTION_TRAILERS] } },
      { orderBy: { seq: 'desc' }, disableIdentityMap: true },
      em,
    );
    if (last?.kind !== 'error') {
      return null;
    }
    const payload = asRecord(parseJsonColumn(last.payload));
    return payload?.interrupted === true
      ? parseInterruptCause(payload.interruptCause)
      : null;
  }

  /**
   * When a usage limit that ended this run reopens, or null when the run failed
   * for any other reason. The CLI's own words decide (`AgentAdapter.failureFrom`);
   * a team run names no CLI of its own, so any CLI's reading of the row counts.
   */
  private async usageLimitEndOf(
    runId: string,
    agentKind: AgentKind | null,
    em: EntityManager,
  ): Promise<Date | null> {
    const last = await this.itemDao.getOne(
      { runId, kind: 'error' },
      { orderBy: { seq: 'desc' }, disableIdentityMap: true },
      em,
    );
    const message = payloadString(parseJsonColumn(last?.payload), 'message');
    if (message === null) {
      return null;
    }
    const adapters =
      agentKind !== null
        ? [this.adapters.for(agentKind)]
        : [...this.adapters.all().values()];
    const limit = adapters
      .map((adapter) => adapter.failureFrom(message))
      .find((failure) => failure.class === 'rate_limited');
    if (limit === undefined) {
      return null;
    }
    const now = Date.now();
    const instant =
      limit.resetsAt === null
        ? null
        : resetInstantFrom(limit.resetsAt, new Date(now));
    return new Date(
      instant === null
        ? now + AUTOPILOT_LIMIT_FALLBACK_MS
        : Math.max(instant, now) + AUTOPILOT_LIMIT_RESET_GRACE_MS,
    );
  }

  /**
   * The column an interrupted card goes back to: the one the project's
   * autopilot picks work up from, when a card can wait there — see
   * {@link WAITING_COLUMNS}.
   */
  private async intakeColumn(
    projectId: string,
    em: EntityManager,
  ): Promise<TaskStatus> {
    const intake = (await this.projectDao.getById(projectId, em))
      ?.autopilotIntakeStatus;
    return intake !== undefined && WAITING_COLUMNS.includes(intake)
      ? intake
      : 'todo';
  }

  /**
   * Move the project's failure streak, which is what opens and closes the
   * breaker.
   *
   * Counted per PROJECT and kept on the row rather than in memory, because the
   * daemon may exit between two tasks — the idle window is measured in
   * minutes — and a breaker that forgot its count on every restart could never
   * reach a threshold at all.
   *
   * A CANCEL moves nothing in either direction: the user stopped their own
   * agent, which is neither a fault to count nor a success to clear one. Nor
   * does an INTERRUPTION, for the same reason from the other side: the daemon
   * stopping under the agent says nothing about the work — counted, quitting
   * the app three times during runs would switch the autopilot off.
   *
   * A failure counts only on a card that was being WORKED, on a project that is
   * armed. The streak is a claim about unattended work: a follow-up turn
   * failing in a thread already in review is not a task failing, and a person
   * re-running something on a disarmed project is not building evidence for a
   * breaker that is guarding nothing. A SUCCESS clears it either way — the card
   * may well have been moved by its agent before the turn ended, and whatever
   * started the run, the thing works. The one completion that is NOT a success
   * is a card its agent moved to `failed`, which {@link settle} hands in as the
   * failure it is.
   *
   * A spent usage limit is the account's state, not a fault of the work: it
   * moves nothing in the streak and holds an armed project until it reopens.
   */
  private async recordOutcome(
    projectId: string,
    ending: RunEnding,
    worked: boolean,
    limitUntil: Date | null,
    em: EntityManager,
  ): Promise<void> {
    if (ending === 'cancelled' || ending === 'interrupted') {
      return;
    }
    const project = await this.projectDao.getById(projectId, em);
    if (!project) {
      return;
    }
    if (ending === 'completed') {
      if (
        project.autopilotFailureStreak !== 0 ||
        project.autopilotLimitUntil !== null
      ) {
        project.autopilotFailureStreak = 0;
        project.autopilotLimitUntil = null;
        await em.flush();
        this.projectEvents.publish({ projectId });
      }
      return;
    }
    if (limitUntil !== null) {
      await this.holdForUsageLimit(project, limitUntil, em);
      return;
    }
    if (!worked || !project.autopilotEnabled) {
      return;
    }
    project.autopilotFailureStreak += 1;
    await em.flush();
    this.projectEvents.publish({ projectId });
    if (isBreakerOpen(project)) {
      this.logger.warn(
        `project ${project.id} has ${project.autopilotFailureStreak} failed runs in a row — the autopilot has stopped picking work up`,
      );
    }
  }

  /** The later of two limits stands: the project waits until both have reopened. */
  private async holdForUsageLimit(
    project: Project,
    until: Date,
    em: EntityManager,
  ): Promise<void> {
    const held = project.autopilotLimitUntil;
    if (!project.autopilotEnabled || (held !== null && held >= until)) {
      return;
    }
    project.autopilotLimitUntil = until;
    await em.flush();
    this.projectEvents.publish({ projectId: project.id });
    this.logger.log(
      `project ${project.id} hit a usage limit — the autopilot goes on at ${until.toISOString()}`,
    );
  }

  /**
   * Catch one board up on runs that settled while nobody was listening.
   *
   * The broadcast is the one thing a closed app misses: a run that fails with
   * no window open announces to nobody, and the card is still drawn as
   * working when the board next loads. So the board asks for this on the way
   * in, and the run ROW answers — the same question the live path asks, put to
   * the durable copy instead of to an event that has already passed.
   *
   * Only a card that believes it is working is examined: everything else has
   * either already been settled or was never started from here.
   *
   * A null project is the board of EVERY project, which is what the board
   * shows with no project picked.
   */
  async reconcileProject(projectId: string | null): Promise<TaskWire[]> {
    await this.settleCutOffCards(projectId);
    return projectId === null
      ? this.tasks.listAll()
      : this.tasks.listForProject(projectId);
  }

  /**
   * The settling half of {@link reconcileProject}, without the listing — what
   * the daemon's boot runs once, because the boot reconciles announce their
   * interrupted runs before this service has subscribed to hear them.
   */
  async settleCutOffCards(projectId: string | null): Promise<void> {
    const em = this.em.fork();
    const tasks =
      projectId === null
        ? await this.taskDao.listAll(em)
        : await this.taskDao.listForProject(projectId, em);
    for (const task of tasks) {
      // Per card, on the subscriber's own terms: `settle` ends in a
      // compare-and-set that throws when the row moved since it was read, and
      // `reconcileTasks` is the board's ONLY listing call — so one contested
      // card must not cost the user every other one.
      await this.reconcileCard(task, em).catch((error: unknown) => {
        this.logger.warn(
          `could not reconcile task ${task.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  }

  /**
   * Reconcile ONE card against its CURRENT run — the reconcile a start held
   * off (`TasksService.releaseStart`), made once it has let go.
   */
  async reconcileTask(taskId: string): Promise<void> {
    const em = this.em.fork();
    const task = await this.taskDao.getById(taskId, em);
    if (task) {
      await this.reconcileCard(task, em);
    }
  }

  /** A card still reading as worked, settled if its run has ended. */
  private async reconcileCard(task: Task, em: EntityManager): Promise<void> {
    if (task.runId === null || task.status !== 'in_progress') {
      return;
    }
    const run = await this.runDao.getById(task.runId, em);
    if (!run || !isTerminalRunStatus(run.status)) {
      return;
    }
    await this.settle(task.runId, run.status, 'reconcile');
  }
}
