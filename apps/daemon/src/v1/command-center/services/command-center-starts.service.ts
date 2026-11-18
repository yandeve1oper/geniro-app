import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';

import {
  HOST_START_THREAD_TOOL,
  SINGLE_AGENT_NODE,
  type StartThreadAnswer,
  type StartThreadInput,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { ChatService } from '../../agents/services/chat.service';
import { HostWakeBus } from '../../agents/services/host-wake.bus';
import { ProjectDao } from '../../projects/dao/project.dao';
import type { Project } from '../../projects/entity/project.entity';
import { taskIdentifier } from '../../projects/utils/project-key';
import type { AgentKind } from '../../runs/runs.types';
import { TaskDao } from '../../tasks/dao/task.dao';
import type { Task } from '../../tasks/entity/task.entity';
import { TaskEventBus } from '../../tasks/services/task-events.bus';
import { TasksService } from '../../tasks/services/tasks.service';
import type { CommandCenterStart } from '../command-center.types';
import { START_FAILURE_MAX_CHARS } from '../command-center.types';
import { CommandCenterChatService } from './command-center-chat.service';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The card id of one start request, derivable from the task's own columns. */
function startCardId(taskId: string, requestedAt: Date): string {
  return `command-center-start:${taskId}:${requestedAt.getTime()}`;
}

function folded(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The manager's starts: `start_thread` files a backlog card and records a
 * start request on it; the user's Start (or a manager chat in `auto`)
 * approves it; Electron main's drain prepares the worktree and starts the run
 * with `startedBy: 'manager'`; the manager is woken when it has started or
 * failed. The request lives on the task row, so a restart loses nothing: the
 * Start cards still waiting are tracked again at boot, and a start the
 * manager was not told about is told then.
 */
@Injectable()
export class CommandCenterStartsService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CommandCenterStartsService.name);
  private subscription: Subscription | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
    private readonly wakes: HostWakeBus,
    private readonly projectDao: ProjectDao,
    private readonly taskDao: TaskDao,
    private readonly tasks: TasksService,
    private readonly taskEvents: TaskEventBus,
    private readonly managers: CommandCenterChatService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.taskEvents.allChanges().subscribe(() => {
      void this.reportStarted();
    });
  }

  onApplicationBootstrap(): void {
    void this.rehydrate();
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  /** `start_thread`: file the card and put its start to the user, or approve it in `auto`. */
  async start(
    managerRunId: string,
    input: StartThreadInput,
  ): Promise<StartThreadAnswer> {
    const em = this.em.fork();
    const manager = await this.runDao.getById(managerRunId, em);
    if (manager === null || manager.commandCenter !== true) {
      return {
        status: 'refused',
        code: 'NOT_MANAGER',
        reason: 'only the command center manager starts threads',
      };
    }
    const project = this.projectNamed(
      await this.projectDao.listAll(em),
      input.project,
    );
    if (project === null) {
      return {
        status: 'refused',
        code: 'PROJECT_NOT_FOUND',
        reason: `no project has the id or name "${input.project}"`,
      };
    }
    const task = await this.tasks.create({
      projectId: project.id,
      title: input.title,
      description: input.brief,
      status: 'backlog',
      ...(input.agent === undefined
        ? {}
        : { agentKind: input.agent as AgentKind }),
      ...(input.team === undefined ? {} : { teamSlug: input.team }),
    });
    const requestedAt = new Date();
    const auto = manager.approval === 'auto';
    await this.taskDao.setStartRequest(
      task.id,
      {
        requestedAt,
        byRunId: managerRunId,
        approvedAt: auto ? requestedAt : null,
        note: input.note?.trim() ? input.note.trim() : null,
      },
      em,
    );
    const identifier = taskIdentifier(project.taskKey, task.number);
    if (auto) {
      return { status: 'starting', taskId: task.id, identifier };
    }
    try {
      await this.chats.raiseOwnedCard(
        managerRunId,
        startCardId(task.id, requestedAt),
        this.cardOf(task.id, input.title, project.name, input.brief),
        this.responderFor(managerRunId, task.id, input.title),
      );
    } catch (error) {
      this.logger.error(
        `run ${managerRunId} could not put a Start card on screen: ${messageOf(error)}`,
      );
      await this.taskDao.setStartRequest(task.id, null, em);
      return {
        status: 'refused',
        code: 'CARD_NOT_SHOWN',
        reason: `the card ${identifier ?? task.id} was filed in backlog, but its Start card could not be shown`,
      };
    }
    return { status: 'card_shown', taskId: task.id, identifier };
  }

  /** Every approved start not yet started, for Electron main's drain. */
  async approvedStarts(): Promise<CommandCenterStart[]> {
    const em = this.em.fork();
    const tasks = await this.taskDao.listApprovedStarts(em);
    if (tasks.length === 0) {
      return [];
    }
    const projects = new Map(
      (await this.projectDao.listAll(em)).map((project) => [
        project.id,
        project,
      ]),
    );
    return tasks.flatMap((task) => {
      const project = projects.get(task.projectId);
      return project === undefined
        ? []
        : [
            {
              taskId: task.id,
              projectId: task.projectId,
              title: task.title,
              status: task.status,
              folder: task.folder ?? project.folder,
            },
          ];
    });
  }

  /** The drain could not start it: the request ends and the manager is told why. */
  async failed(taskId: string, reason: string): Promise<void> {
    const em = this.em.fork();
    const task = await this.taskDao.getById(taskId, em);
    if (task === null || task.startRequestedByRunId === null) {
      return;
    }
    const managerRunId = task.startRequestedByRunId;
    await this.taskDao.setStartRequest(taskId, null, em);
    await this.taskDao.clearStartRequester(taskId, em);
    const said = reason.slice(0, START_FAILURE_MAX_CHARS);
    this.wakeManager(
      managerRunId,
      `start-failed:${taskId}`,
      `[command center] The thread "${task.title}" (card ${taskId}) could not be started: ${said}. The card stays in backlog; tell the user, or try again with start_thread once the cause is fixed.`,
      `Could not start "${task.title}"`,
    );
  }

  private projectNamed(
    projects: readonly Project[],
    name: string,
  ): Project | null {
    const byId = projects.find((project) => project.id === name.trim());
    if (byId !== undefined) {
      return byId;
    }
    const byName = projects.filter(
      (project) => folded(project.name) === folded(name),
    );
    return byName.length === 1 ? (byName[0] ?? null) : null;
  }

  private cardOf(
    taskId: string,
    title: string,
    project: string,
    brief: string,
  ): { toolName: string; input: unknown } {
    return {
      toolName: HOST_START_THREAD_TOOL,
      input: { taskId, title, project, brief },
    };
  }

  private responderFor(managerRunId: string, taskId: string, title: string) {
    return (allow: boolean, answer?: string): void => {
      this.carryOutVerdict(managerRunId, taskId, title, allow, answer).catch(
        (error: unknown) => {
          this.logger.error(
            `run ${managerRunId} Start card verdict for ${taskId} not carried out: ${messageOf(error)}`,
          );
        },
      );
    };
  }

  private async carryOutVerdict(
    managerRunId: string,
    taskId: string,
    title: string,
    allow: boolean,
    answer: string | undefined,
  ): Promise<void> {
    const em = this.em.fork();
    const task = await this.taskDao.getById(taskId, em);
    const requestedAt = task?.startRequestedAt ?? null;
    let message: string;
    if (task === null || requestedAt === null) {
      message = `[command center] The Start card for "${title}" was answered, but its card is gone or no longer asks to start; nothing was started.`;
    } else if (allow) {
      await this.taskDao.approveStartRequest(taskId, new Date(), em);
      message = `[command center] The user approved starting "${title}". It is starting now; you are told when it has.`;
    } else {
      await this.taskDao.setStartRequest(taskId, null, em);
      await this.taskDao.clearStartRequester(taskId, em);
      message = `[command center] The user declined to start "${title}". The card stays in backlog.`;
    }
    const note = answer?.trim() ?? '';
    try {
      await this.chats.deliverOwnedCardVerdict(
        managerRunId,
        requestedAt === null
          ? `command-center-start:${taskId}`
          : startCardId(taskId, requestedAt),
        allow && requestedAt !== null,
        note === '' ? message : `${message}\nThe user's note: ${note}`,
        answer,
      );
    } catch (error) {
      this.logger.error(
        `run ${managerRunId} Start card verdict not delivered: ${messageOf(error)}`,
      );
    }
  }

  /** Tell each manager about the threads it asked for that have started. */
  private async reportStarted(): Promise<void> {
    try {
      const em = this.em.fork();
      for (const task of await this.taskDao.listStartedForManager(em)) {
        await this.reportOne(task);
      }
    } catch (error) {
      this.logger.warn(`manager starts not reported: ${messageOf(error)}`);
    }
  }

  private async reportOne(task: Task): Promise<void> {
    const managerRunId = task.startRequestedByRunId;
    if (managerRunId === null || task.runId === null) {
      return;
    }
    const em = this.em.fork();
    if (!(await this.taskDao.claimStartReport(task.id, managerRunId, em))) {
      return;
    }
    let handle: string | undefined;
    try {
      await this.managers.addToRoster(
        managerRunId,
        [task.runId],
        'manager',
        task.startRequestNote,
      );
      handle = (await this.managers.rosterThreads(managerRunId)).find(
        ({ entry }) => entry.threadRunId === task.runId,
      )?.entry.handle;
    } catch (error) {
      await this.taskDao.releaseStartReport(task.id, managerRunId, em);
      throw error;
    }
    this.wakeManager(
      managerRunId,
      `started:${task.id}`,
      `[command center] The thread "${task.title}" has started${handle === undefined ? '' : ` as ${handle}`} (thread ${task.runId}). It is on your roster.`,
      `Started "${task.title}"`,
    );
  }

  private wakeManager(
    managerRunId: string,
    key: string,
    prompt: string,
    message: string,
  ): void {
    this.wakes.publish({
      key: `command-center:${key}`,
      owner: {
        target: 'chat',
        runId: managerRunId,
        memberId: SINGLE_AGENT_NODE,
        conversationId: null,
        caller: SINGLE_AGENT_NODE,
      },
      prompt,
      row: { severity: 'info', message, woke: true },
      note: prompt,
      onDelivered: () => undefined,
    });
  }

  /** Track every Start card still waiting again, and tell what a restart left untold. */
  private async rehydrate(): Promise<void> {
    try {
      const em = this.em.fork();
      for (const task of await this.taskDao.listPendingStartRequests(em)) {
        const managerRunId = task.startRequestedByRunId;
        const requestedAt = task.startRequestedAt;
        if (managerRunId === null || requestedAt === null) {
          continue;
        }
        const cardId = startCardId(task.id, requestedAt);
        const closed =
          (
            await this.itemDao.rowsByPayloadId(
              managerRunId,
              ['approval_verdict', 'unanswerable'],
              [cardId],
              undefined,
              em,
            )
          ).length > 0;
        if (closed) {
          await this.taskDao.setStartRequest(task.id, null, em);
          await this.taskDao.clearStartRequester(task.id, em);
          continue;
        }
        const project = await this.projectDao.getById(task.projectId, em);
        this.chats.trackOwnedCard(
          managerRunId,
          cardId,
          this.cardOf(
            task.id,
            task.title,
            project?.name ?? '',
            task.description ?? '',
          ),
          this.responderFor(managerRunId, task.id, task.title),
        );
      }
      await this.reportStarted();
    } catch (error) {
      this.logger.error(`Start card rehydration failed: ${messageOf(error)}`);
    }
  }
}
