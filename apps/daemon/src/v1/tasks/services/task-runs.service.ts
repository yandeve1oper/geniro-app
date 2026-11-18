import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { interruptedReason } from '../../../utils/stop-cause';
import { RunDao } from '../../agents/dao/run.dao';
import { ChatService } from '../../agents/services/chat.service';
import { RunGroupsService } from '../../agents/services/run-groups.service';
import { assertTeamRun } from '../../agents/utils/run-kind';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { ProjectQueueService } from '../../projects/services/project-queue.service';
import { taskIdentifier } from '../../projects/utils/project-key';
import { Run } from '../../runs/entity/run.entity';
import { isTerminalRunStatus } from '../../runs/runs.types';
import { RunTeamService } from '../../teams/services/run-team.service';
import { TeamExecutorService } from '../../teams/services/team-executor.service';
import { TeamOverlayService } from '../../teams/services/team-overlay.service';
import { membersThatAsk } from '../../teams/utils/unattended';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import {
  type ResolvedAgentTarget,
  type ResolvedRunTarget,
  type ResolvedTeamTarget,
  type StartTaskRun,
  type TaskWire,
} from '../tasks.types';
import { composeLabelInstructions } from '../utils/label-instructions-prompt';
import {
  isRunTargetProblem,
  resolveRunTarget,
  RUN_TARGET_PROBLEM_CODE,
  RUN_TARGET_PROBLEM_REASON,
} from '../utils/run-target';
import { parseTaskFiles } from '../utils/task-files';
import {
  composeTaskPrompt,
  TASK_REPORT_INSTRUCTIONS,
  TASK_REPORT_INSTRUCTIONS_TEAM,
} from '../utils/task-prompt';
import { LabelInstructionsService } from './label-instructions.service';
import { TasksService } from './tasks.service';

/**
 * Starting an agent on a task.
 *
 * The card is what the user presses; an ordinary CHAT is what runs. That is
 * the whole design — a task run is not a second execution path, it is
 * `ChatService` called with a worktree as its cwd, which is why this module
 * imports `AgentsModule` rather than growing an engine of its own.
 *
 * It runs no git. The worktree and the branch arrive already made, from the
 * Electron main process, because every git call in this app belongs there.
 */
@Injectable()
export class TaskRunsService {
  private readonly logger = new Logger(TaskRunsService.name);

  /**
   * One project's starts, serialized.
   *
   * `TasksService.claimStart` stops one CARD being started twice; this stops
   * one PROJECT exceeding its cap, which is a different race and is not
   * covered by it. Two conductors picking two DIFFERENT eligible tasks both
   * count the running runs, both find a slot free, and both start — the cap is
   * exceeded without either card being touched twice, so neither the Set nor
   * the status compare-and-set can see it.
   *
   * In-process serialization is sufficient because there is exactly one
   * daemon per userData dir, which `utils/instance-lock.ts` enforces — every
   * window's conductor reaches this one map. A second daemon would defeat it,
   * and is refused at boot for its own reasons.
   */
  private readonly perProject = new Map<string, Promise<unknown>>();

  constructor(
    private readonly em: EntityManager,
    private readonly taskDao: TaskDao,
    private readonly projectDao: ProjectDao,
    private readonly runDao: RunDao,
    private readonly tasks: TasksService,
    private readonly chats: ChatService,
    private readonly queue: ProjectQueueService,
    private readonly executor: TeamExecutorService,
    private readonly groups: RunGroupsService,
    private readonly labelInstructions: LabelInstructionsService,
    private readonly overlays: TeamOverlayService,
    private readonly runTeams: RunTeamService,
  ) {}

  async start(taskId: string, input: StartTaskRun): Promise<TaskWire> {
    if (!this.tasks.claimStart(taskId)) {
      throw new ConflictException(
        'TASK_RUN_STARTING',
        `task ${taskId} is already starting a run`,
      );
    }
    try {
      const projectId = await this.projectIdOf(taskId);
      const wire = await this.queued(projectId, () =>
        this.startClaimed(taskId, input),
      );
      // A start that WORKED is the answer to a Stop, so the card is the
      // autopilot's again from here — see `Task.stoppedAt`. Only after the run
      // exists: a press that failed leaves the card stopped, since nothing the
      // user asked for has happened yet. The same start proves its worktree
      // could be made, so a prepare failure on record is over too.
      const em = this.em.fork();
      await this.taskDao.setStoppedAt(taskId, null, em);
      await this.taskDao.setPrepareFailure(taskId, null, em);
      await this.taskDao.settleStartRequest(taskId, em);
      return wire;
    } finally {
      this.tasks.releaseStart(taskId);
    }
  }

  /**
   * Run `fn` after every start already queued for this project.
   *
   * The chain is kept on failures too — a start that threw still finished, and
   * dropping the tail there would let the next caller run beside one still in
   * flight. The entry is deleted only when this call is still the tail, so a
   * later start that has already chained onto it is never orphaned.
   */
  private async queued<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.perProject.get(projectId) ?? Promise.resolve();
    const mine = prior.then(fn, fn);
    this.perProject.set(
      projectId,
      mine.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await mine;
    } finally {
      const tail = this.perProject.get(projectId);
      if (tail !== undefined) {
        void tail.then(() => {
          if (this.perProject.get(projectId) === tail) {
            this.perProject.delete(projectId);
          }
        });
      }
    }
  }

  /**
   * The library's answer to "can this team run unattended", for
   * `resolveRunTarget` — asked the same way `TaskQueueService` asks it, so
   * the route never refuses a card the queue handed out, nor starts one it
   * held back.
   *
   * Only for an autopilot start that resolves to a team; every other start
   * never consults it. A team the library cannot read answers false: the
   * refusal is the safe reading, and the executor's own lookup is what reports
   * a missing team on a hand press.
   */
  private async unattendedTeam(
    levels: Parameters<typeof resolveRunTarget>[0],
    startedBy: StartTaskRun['startedBy'],
    projectId: string,
  ): Promise<(slug: string) => boolean> {
    const asUser = resolveRunTarget(levels, 'user');
    if (
      startedBy !== 'autopilot' ||
      isRunTargetProblem(asUser) ||
      asUser.kind !== 'team'
    ) {
      return () => false;
    }
    const safe = await this.overlays
      .effectiveBySlug(asUser.teamSlug, projectId)
      .then(({ team }) => membersThatAsk(team).length === 0)
      .catch(() => false);
    return (slug) => safe && slug === asUser.teamSlug;
  }

  private async projectIdOf(taskId: string): Promise<string> {
    const em = this.em.fork();
    return (await this.require(taskId, em)).projectId;
  }

  private async startClaimed(
    taskId: string,
    input: StartTaskRun,
  ): Promise<TaskWire> {
    const em = this.em.fork();
    const task = await this.require(taskId, em);
    // The card's edge as this press FOUND it, so a failed start can put back
    // exactly what it overwrote — see `abandon`. Copied out rather than read
    // off `task` later, which is a managed entity and not a snapshot.
    const found: RunEdge = {
      runId: task.runId,
      branch: task.branch,
      worktreePath: task.worktreePath,
    };
    const project = await this.requireProject(task.projectId, em);
    // Most specific first: this press, then the card, then the project. The
    // first rung naming a target decides whether an agent or a team runs.
    const levels = [input, task, project];
    const target = resolveRunTarget(
      levels,
      input.startedBy,
      await this.unattendedTeam(levels, input.startedBy, task.projectId),
    );
    if (isRunTargetProblem(target)) {
      throw new BadRequestException(
        RUN_TARGET_PROBLEM_CODE[target.reason],
        `${RUN_TARGET_PROBLEM_REASON[target.reason]} (${project.id})`,
      );
    }
    await this.assertNotAlreadyRunning(task, em);
    await this.assertAutopilotMayStart(project, task, input);

    // Read before the move below, so a failed lookup has no reservation to
    // undo.
    const labelInstructions = composeLabelInstructions(
      await this.labelInstructions.forTask(task),
    );

    // The MOVE is the reservation, which is why it happens before the chat
    // exists rather than after: a card sitting in `in_progress` is what a
    // second board's start is refused against. Everything after it is undone
    // by `abandon` if the run cannot be made.
    await this.tasks.moveStatus(taskId, {
      from: input.from,
      to: 'in_progress',
    });

    // A card that has already been worked CONTINUES its own thread rather than
    // opening a second one beside it. REPORTED as "now i can run already
    // completed task - and it will create new thread", then settled in one
    // line: "let's even not ask user to create new chat - let's always continue
    // in existing one". The conversation IS the card's history — what was
    // tried, what the user said about it, what the agent found — and starting
    // cold discards all of it and leaves two threads for one card in a sidebar
    // that now labels both `GEN-12`.
    //
    // Before the create arms rather than inside them, because both are the
    // same decision: the run this card already holds is the run it should be
    // worked in, whichever engine made it. `resumableRun` only ever hands back
    // a run of the engine AND the target this press resolved to, so a chat is
    // never sent into a team run, nor the reverse.
    const resumed =
      target.kind === 'agent'
        ? await this.resume(task, input, target, labelInstructions, em)
        : await this.resumeTeam(task, input, target, em);
    if (resumed !== null) {
      return resumed;
    }

    // Where the run is FILED in the sidebar. The project's group when it names
    // one — a deliberate answer about where its runs belong. Otherwise the
    // group whose rule claims the card's REAL folder: the run itself works in
    // a worktree, a path no rule was ever written for, so leaving the choice
    // to the run's own cwd filed every task run as Ungrouped — REPORTED
    // against the autopilot as "tasks have no folder of their own … they land
    // in UNGROUPED although they belong to the geniro folder".
    // A project can still name a group deleted before the delete released
    // its projects; that binding counts as none, so the folder rule decides.
    const projectGroupId =
      project.groupId !== null && (await this.groups.exists(project.groupId))
        ? project.groupId
        : null;
    const groupId =
      projectGroupId ??
      (await this.groups.resolveAutoGroupId({
        cwd: task.folder ?? project.folder,
        teamId: target.kind === 'team' ? target.teamSlug : null,
      }));

    // Held so `abandon` can take the run down with the rest. Without it a
    // failure after creation leaves a run whose `taskId` points at a card that
    // no longer names it, working directory already pruned by the caller.
    let runId: string | null = null;
    try {
      if (target.kind === 'team') {
        const run = await this.startTeamRun(target.teamSlug, {
          task,
          project,
          input,
          groupId,
          labelInstructions,
        });
        runId = run.id;
        // No `sendMessage` here, and that is the arm's whole difference: a
        // team's seed prompt IS its opening message, persisted by the
        // executor before the trigger member's first turn. A LATER press sends into this run instead
        // — see `resumeTeam`.
        return await this.recordRun(taskId, run.id, input);
      }

      const run = await this.chats.createChat({
        agentKind: target.agentKind,
        cwd: input.cwd,
        startSha: input.startSha,
        startDirty: input.startDirty,
        model: target.model ?? undefined,
        effort: target.effort ?? undefined,
        contextWindow: target.contextWindow ?? undefined,
        ...(Object.keys(target.modelParameters).length === 0
          ? {}
          : { modelParameters: target.modelParameters }),
        approval: this.chats.offeredApproval(target.agentKind, target.approval),
        configDir: target.configDir ?? undefined,
        customInstructions: input.customInstructions,
        replyLanguage: input.replyLanguage,
        agentOptions: input.agentOptions,
        taskInstructions: this.composeTaskInstructions(
          labelInstructions,
          'agent',
        ),
        // The card's own title, so the thread is findable in a sidebar that
        // lists it beside every other conversation. `ChatTitleService` leaves
        // a titled run alone, so this is not overwritten later.
        title: task.title,
        taskId: task.id,
        // And what that card is CALLED, written onto the run beside the id it
        // belongs to. The chat list draws it as the thread's own label, which
        // is the whole reason it is denormalized: the sidebar holds run rows
        // and no board — see `Run.taskIdentifier`.
        ...identifierOf(task, project),
        // Resolved above from the project, else from the card's real folder —
        // never from this worktree, a path nothing has ever been filed under.
        groupId,
      });

      runId = run.id;
      const wire = await this.recordRun(taskId, run.id, input);
      await this.chats.sendMessage(run.id, this.brief(task, input));
      return wire;
    } catch (error) {
      await this.abandon(taskId, input.from, runId, target.kind, found);
      throw error;
    }
  }

  /**
   * Start the team arm.
   *
   * The three overrides it passes are the whole of what a task run needs the
   * executor to do differently, and each is an answer the library route has no
   * way to give: the card's `taskId` (so `TaskSettleService` can move it when
   * the team run finishes), the card's own title (so the sidebar names the WORK
   * rather than restating which team ran), and the group resolved for it
   * in `startClaimed` (a worktree being a path no auto-file rule has ever
   * seen).
   */
  private startTeamRun(
    slug: string,
    context: {
      task: Task;
      project: Project;
      input: StartTaskRun;
      groupId: string | null;
      labelInstructions: string | null;
    },
  ): Promise<{ id: string }> {
    const { task, project, input, groupId, labelInstructions } = context;
    return this.executor.startRunBySlug(slug, {
      cwd: input.cwd,
      prompt: this.brief(task, input),
      customInstructions: input.customInstructions,
      replyLanguage: input.replyLanguage,
      agentOptions: input.agentOptions,
      startSha: input.startSha,
      startDirty: input.startDirty,
      taskInstructions: this.composeTaskInstructions(labelInstructions, 'team'),
      taskId: task.id,
      ...identifierOf(task, project),
      title: task.title,
      groupId,
    });
  }

  /**
   * Continue the card's existing thread, or answer null when there is none to
   * continue and a new one has to be made.
   *
   * The thread is continued only when it is the thread this press RESOLVES to.
   * Continuity is worth having because the conversation is the card's history,
   * but it is worth having only for the target the card now names: a card
   * re-pointed at another agent, or at a team, would otherwise go on
   * running the old one for good, with the panel showing the new one and no
   * way out short of deleting the run.
   *
   * The resolved settings are applied to the thread before the turn starts, for
   * the same reason — a model or an approval mode changed on the card is a
   * change to how the next turn runs, not to how the next NEW thread runs. This
   * is also what makes the autopilot's forced approval hold on this path:
   * `chat.service.ts` reads the mode off the RUN row and falls back to `ask`,
   * so a resumed unattended turn would otherwise park on a permission card
   * forever, holding its slot and its worktree while the failure breaker sees
   * nothing wrong.
   *
   * A run still WORKING is not a disqualifier — `assertNotAlreadyRunning` has
   * already refused the press by the time this is reached.
   *
   * The card's task instructions ride the same settings patch, rewritten from
   * `labelInstructions` — resolved by the caller before the card moved — so a
   * label instruction edited, added or removed since the thread began reaches
   * this turn. The user's own `customInstructions` snapshot is left alone.
   *
   * On failure the card is put back where it came from and the RUN is never
   * deleted. That is the whole difference from `abandon`, which deletes what it
   * started: this thread is the card's history, and a send that failed is not a
   * reason to destroy it. The settings patch is not rolled back either — it
   * describes how the card's next turn should run, which a failed send does
   * not change.
   */
  private async resume(
    task: Task,
    input: StartTaskRun,
    target: ResolvedAgentTarget,
    labelInstructions: string | null,
    em: EntityManager,
  ): Promise<TaskWire | null> {
    const run = await this.resumableRun(task, target, em);
    if (run === null) {
      return null;
    }
    try {
      // The card is re-pointed at its own run BEFORE the turn starts, on the
      // create path's own reasoning: `recordRun` also writes the worktree and
      // branch this press prepared, and the settle path reads them.
      const wire = await this.recordRun(task.id, run.id, input);
      // ONLY the fields that actually resolved, because `updateSettings`
      // branches on a key's PRESENCE and not on its value. A null carried
      // through is not "leave it alone" but an instruction: `configDir: null`
      // reaches `moveToConfigDir`, which refuses outright for a CLI that reads
      // no config directory at all — so every re-press on a cursor-agent card
      // would 400 — and `model: null` is a CLEAR that takes the run's context
      // window and model parameters with it. An unset rung omits the key,
      // which is what the create arm's `?? undefined` already does.
      const approval = this.chats.offeredApproval(
        target.agentKind,
        target.approval,
      );
      const resolved = {
        ...(approval === undefined ? {} : { approval }),
        // Omitted when it already IS the run's model, not only when it is
        // unset. `updateSettings` reads a PRESENT `model` as a CHANGE and
        // clears the run's context window and model parameters with it, so a
        // re-press on an unchanged card would silently drop a `1m` window or
        // an `optimize_for` the user picked inside that thread — the very loss
        // the null-vs-absent split above exists to prevent, reached by sending
        // a value rather than a null. `moveToConfigDir` takes the same stance
        // one field over: a picker can re-choose what is already chosen.
        ...(target.model === null || target.model === run.model
          ? {}
          : { model: target.model }),
        ...(target.effort === null ? {} : { effort: target.effort }),
        ...(target.contextWindow === null
          ? {}
          : { contextWindow: target.contextWindow }),
        ...(Object.keys(target.modelParameters).length === 0
          ? {}
          : { modelParameters: target.modelParameters }),
        ...(target.configDir === null ? {} : { configDir: target.configDir }),
        // Always present: a card always carries at least the report ask. Text
        // that changed respawns the thread's kept CLI process on this turn —
        // `AgentAdapter.sessionKey` hashes it — which is acceptable on an
        // explicit press of Run, and is the only way the change can reach it.
        taskInstructions: this.composeTaskInstructions(
          labelInstructions,
          'agent',
        ),
      };
      // Before the send, which reads the run row for the turn.
      await this.chats.updateSettings(run.id, resolved);
      await this.chats.sendMessage(run.id, this.continuation(task, input));
      return wire;
    } catch (error) {
      await this.tasks.moveStatus(task.id, {
        from: 'in_progress',
        to: input.from,
      });
      throw error;
    }
  }

  /**
   * Continue the card's existing TEAM run, or answer null when there is
   * none to continue and a new one has to be made — `resume`'s twin for the
   * team arm.
   *
   * The press goes through `TeamExecutorService.sendMessage`, the channel the
   * run's own composer uses: a settled run starts its trigger member again,
   * every member resuming its own session, so the team remembers the earlier
   * pass instead of starting cold in a second thread beside the first. The
   * text is `continuation`'s, on the agent arm's reasoning.
   *
   * The run keeps the team it was started with — its snapshot, never the
   * library's current copy (`RunTeamService`) — and the settings it was
   * started with: a team run has no settings patch to re-resolve the
   * card's label instructions or the board's switches onto.
   *
   * Failure is handled exactly as `resume` handles it: the card goes back,
   * the run is never deleted.
   */
  private async resumeTeam(
    task: Task,
    input: StartTaskRun,
    target: ResolvedTeamTarget,
    em: EntityManager,
  ): Promise<TaskWire | null> {
    const run = await this.resumableRun(task, target, em);
    if (run === null || !(await this.continuesUnattended(run, input, em))) {
      return null;
    }
    try {
      // Before the send, on `resume`'s reasoning: the worktree and branch this
      // press prepared are written onto the card, and the settle path reads
      // them.
      const wire = await this.recordRun(task.id, run.id, input);
      await this.executor.sendMessage(run.id, this.continuation(task, input));
      return wire;
    } catch (error) {
      await this.tasks.moveStatus(task.id, {
        from: 'in_progress',
        to: input.from,
      });
      throw error;
    }
  }

  /**
   * Whether this press may continue `run` with nobody watching.
   *
   * A person's press always may. The autopilot's was vetted by
   * `unattendedTeam` against the LIBRARY's copy, but a continued run walks
   * its own snapshot, which may still hold a member that asks — and a card the
   * autopilot holds must never reach a permission card nobody will answer. So
   * the snapshot is asked too; one that asks, or cannot be read, makes a new
   * run from the vetted library copy instead.
   */
  private async continuesUnattended(
    run: Run,
    input: StartTaskRun,
    em: EntityManager,
  ): Promise<boolean> {
    if ((input.startedBy ?? 'user') !== 'autopilot') {
      return true;
    }
    return this.runTeams
      .teamOf(assertTeamRun(run, run.id), em)
      .then((team) => membersThatAsk(team).length === 0)
      .catch(() => false);
  }

  /**
   * The card's own run, when it is one this press can actually continue.
   *
   * FOUR states disqualify a run, and each one is a real card rather than a
   * defensive branch: the card has never been run; its run was DELETED by the
   * user (the conversation is gone, so there is nothing to continue); its run
   * is ARCHIVED, which the daemon holds inert on purpose (`RUN_ARCHIVED`); or
   * the run is not one of the target this press resolved to — a card
   * re-pointed at a different agent, at a different team, or from one
   * engine to the other. Continuing then would send the new target's
   * words into the old one: a chat into a team run is refused outright
   * (`NOT_A_CHAT_RUN`), and the rest would run the old target for good, with
   * the panel showing the new one. In every one of them the answer is the
   * same and it is not an error: make a new run.
   */
  private async resumableRun(
    task: Task,
    target: ResolvedRunTarget,
    em: EntityManager,
  ): Promise<Run | null> {
    if (task.runId === null) {
      return null;
    }
    const run = await this.runDao.getById(task.runId, em);
    if (
      !run ||
      run.archivedAt !== null ||
      !isTerminalRunStatus(run.status) ||
      !isRunOf(run, target)
    ) {
      return null;
    }
    return run;
  }

  /**
   * What a NEW thread opens with: the card's brief, plus whatever the user
   * added to this press.
   *
   * The addition goes after the description and BEFORE the attachment list,
   * which stays last for the reason `composeTaskPrompt` records — a CLI names
   * the conversation from this text, and a list of paths at the top titles the
   * chat after somebody's folder.
   */
  private brief(task: Task, input: StartTaskRun): string {
    return composeTaskPrompt(
      task,
      parseTaskFiles(task.attachments),
      input.prompt,
    );
  }

  /**
   * What a CONTINUED thread is sent, which is deliberately not the same thing.
   *
   * The user's own words when they wrote any: the brief is already in this
   * conversation, and repeating it would bury the one new sentence under a
   * paragraph the agent has read before.
   *
   * The brief again when they wrote none, and that is the useful default
   * rather than a filler: pressing Run a second time with nothing to add means
   * "work this card again", and the card may have CHANGED since the first
   * press — an edited description, a file attached — so the brief is both the
   * honest restatement and the only way those edits reach the agent.
   */
  private continuation(task: Task, input: StartTaskRun): string {
    const added = input.prompt?.trim() ?? '';
    return added === '' ? this.brief(task, input) : added;
  }

  /**
   * Write the run onto the card — the other end of the edge, in one update.
   */
  private recordRun(
    taskId: string,
    runId: string,
    input: StartTaskRun,
  ): Promise<TaskWire> {
    return this.tasks.update(taskId, {
      runId,
      branch: input.branch,
      worktreePath: input.cwd,
    });
  }

  /**
   * Put the card back where the press found it.
   *
   * Its own failure is swallowed: the caller is owed the error that actually
   * stopped the run, and a card someone else moved in the meantime is not this
   * request's to drag back.
   *
   * The edge is put back to what the press FOUND (`found`), never nulled: a
   * card routinely arrives here holding the thread it was worked in before —
   * re-pointed at a team the library no longer has, say — and that thread
   * still names the card through `Run.taskId`. Nulling the card's end erased
   * its link to that conversation while the conversation went on claiming the
   * card, and the next Run opened a second thread beside it. A start that
   * failed before making a run (`runId` null) wrote nothing onto the edge, so
   * there is nothing to put back at all.
   */
  private async abandon(
    taskId: string,
    from: Task['status'],
    runId: string | null,
    kind: ResolvedRunTarget['kind'],
    found: RunEdge,
  ): Promise<void> {
    // The CARD first. Everything here is best-effort, and of the two the card
    // is what a user can be stuck on: left in `in_progress` it is refused by
    // the very guard that protects a live run, so a failure while cleaning up
    // would cost them the ability to start it again. The edge and the column
    // are restored under separate catches for the same reason — a restored
    // `worktreePath` is re-checked to exist, and a directory that has gone
    // since must not also cost the card its way back to `from`.
    if (runId !== null) {
      try {
        await this.tasks.update(taskId, found);
      } catch (error) {
        this.logger.warn(
          `could not restore task ${taskId}'s run link after a failed start: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    try {
      await this.tasks.moveStatus(taskId, { from: 'in_progress', to: from });
    } catch (error) {
      this.logger.warn(
        `could not return task ${taskId} to ${from} after a failed start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // Its OWN catch, so a failing teardown cannot swallow the card revert
    // above — which is the half a user can be stuck on. `Run.taskId` and
    // `Task.runId` are two ends of one edge, and a chat left naming a card
    // that no longer names it back is the disagreement `run.entity.ts` says
    // nothing writes.
    //
    // Routed by ENGINE, because both deletes are kind-guarded: `chats.delete`
    // asserts a chat run and `deleteRun` asserts a team one, so sending a
    // team run to the chat teardown throws `NOT_A_CHAT_RUN` — swallowed by
    // the catch below, leaving exactly the orphaned run row this block exists
    // to prevent, and leaving it silently.
    if (runId !== null) {
      try {
        await (kind === 'team'
          ? this.executor.deleteRun(runId)
          : this.chats.delete(runId));
      } catch (error) {
        this.logger.warn(
          `could not delete run ${runId} after a failed start: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * What this card asks of the run working it: its LABEL instructions, then
   * geniro's own report ask — the label block first because it is written for
   * a class of card, and the ask this run itself needs is the more specific.
   *
   * Stored as `Run.taskInstructions`, never joined into the user's own
   * `customInstructions`: `turnInstructionParts` places the pair directly
   * after that text, so the turn reads user's own → label block → report ask,
   * while the user's purge of their own text leaves this intact.
   *
   * `labelInstructions` is already final, so this only joins the two parts.
   */
  private composeTaskInstructions(
    labelInstructions: string | null,
    kind: ResolvedRunTarget['kind'],
  ): string {
    const ask =
      kind === 'team'
        ? TASK_REPORT_INSTRUCTIONS_TEAM
        : TASK_REPORT_INSTRUCTIONS;
    return labelInstructions === null ? ask : `${labelInstructions}\n\n${ask}`;
  }

  /**
   * Refuse a card whose agent is still working.
   *
   * The status check above cannot answer this on its own: a card dragged out
   * of `in_progress` by hand still points at the run it started, and starting
   * a second one would leave the first working in a worktree nothing names.
   *
   * It asks the RUN rather than merely noticing the id, because a settled run
   * is a card's history and not a claim on it — a task that has been through
   * review must be runnable again, and a bare `runId !== null` would refuse
   * every card that had ever run once.
   */
  /**
   * The cap and the breaker, enforced where the run is actually made.
   *
   * `GET /v1/projects/:id/queue` already narrows its handout to the free
   * slots, and that is a convenience rather than the guard: it answers a
   * conductor that asked, and nothing obliges a conductor to ask. This is the
   * line — the daemon refusing, over the rows, inside the per-project gate, so
   * two windows that polled in the same instant cannot both get past it.
   *
   * Only an autopilot start is bounded. A person pressing Run has decided to
   * spend the disk, and the breaker exists to stop UNATTENDED work — refusing
   * them is how they would be prevented from checking that the thing which
   * broke is fixed before they re-arm.
   *
   * A card its user STOPPED, or an unannounced interruption cut off
   * (`Task.interruptedBy`), is
   * refused here too, for the same reason the cap is: the queue already keeps
   * it out of the handout, and that is the fast answer rather than the line.
   */
  private async assertAutopilotMayStart(
    project: Project,
    task: Task,
    input: StartTaskRun,
  ): Promise<void> {
    if ((input.startedBy ?? 'user') !== 'autopilot') {
      return;
    }
    if (task.stoppedAt !== null && task.interruptedBy !== null) {
      throw new ConflictException(
        'TASK_INTERRUPTED',
        `task ${task.id}: ${interruptedReason(task.interruptedBy)}`,
      );
    }
    if (task.stoppedAt !== null) {
      throw new ConflictException(
        'TASK_STOPPED_BY_USER',
        `task ${task.id} was stopped by its user — the autopilot leaves it alone until Run is pressed`,
      );
    }
    const queue = await this.queue.readRaw(project.id);
    if (queue.breakerOpen) {
      throw new ConflictException(
        'AUTOPILOT_BREAKER_OPEN',
        `project ${project.id} has ${queue.failureStreak} failed runs in a row — re-arm it before the autopilot starts another`,
      );
    }
    if (queue.limitHoldUntil !== null) {
      throw new ConflictException(
        'AUTOPILOT_LIMIT_HOLD',
        `project ${project.id} waits for its usage limit to reset at ${queue.limitHoldUntil.toISOString()}`,
      );
    }
    if (queue.running >= queue.cap) {
      throw new ConflictException(
        'AUTOPILOT_AT_CAP',
        `project ${project.id} is already running ${queue.running} of ${queue.cap} tasks`,
      );
    }
  }

  private async assertNotAlreadyRunning(
    task: Task,
    em: EntityManager,
  ): Promise<void> {
    if (task.runId === null) {
      return;
    }
    const run = await this.runDao.getById(task.runId, em);
    if (run && !isTerminalRunStatus(run.status)) {
      throw new ConflictException(
        'TASK_ALREADY_RUNNING',
        `task ${task.id} is already being worked by run ${task.runId}`,
      );
    }
  }

  private async require(taskId: string, em: EntityManager): Promise<Task> {
    const task = await this.taskDao.getById(taskId, em);
    if (!task) {
      throw new NotFoundException(
        'TASK_NOT_FOUND',
        `no task with id ${taskId}`,
      );
    }
    return task;
  }

  private async requireProject(
    projectId: string,
    em: EntityManager,
  ): Promise<Project> {
    const project = await this.projectDao.getById(projectId, em);
    if (!project) {
      throw new NotFoundException(
        'PROJECT_NOT_FOUND',
        `no project with id ${projectId}`,
      );
    }
    return project;
  }
}

/**
 * Whether `run` was made for `target`: a team run of the same team,
 * or a chat on the same CLI.
 */
function isRunOf(run: Run, target: ResolvedRunTarget): boolean {
  return target.kind === 'team'
    ? run.teamId === target.teamSlug
    : run.teamId === null && run.agentKind === target.agentKind;
}

/** The card's end of the run↔task edge — the three fields a start writes. */
type RunEdge = Pick<Task, 'runId' | 'branch' | 'worktreePath'>;

/**
 * The card's identifier for the run row, or nothing at all.
 *
 * A SPREAD rather than a value, because both create inputs spell the field
 * `taskIdentifier?: string` — optional, not nullable, exactly as `taskId` is —
 * so a card with no identifier says nothing rather than sending a null the
 * input has no shape for. `taskIdentifier` itself already answers null for
 * a card with no number or a project with no key.
 */
function identifierOf(
  task: Task,
  project: Project,
): { taskIdentifier?: string } {
  const identifier = taskIdentifier(project.taskKey, task.number);
  return identifier === null ? {} : { taskIdentifier: identifier };
}
