import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';

import type { ThreadMessageSent } from '../../agents/chat.types';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ThreadInboxService } from '../../agents/services/thread-inbox.service';
import { SPAN_ROW_KINDS } from '../../agents/utils/active-spans';
import type { ItemKind } from '../../runs/runs.types';
import { TaskDao } from '../../tasks/dao/task.dao';
import { TaskEventBus } from '../../tasks/services/task-events.bus';
import { CommandCenterService } from './command-center.service';
import { CommandCenterEventBus } from './command-center-events.bus';

/** The rows that move a card: its strip, its column or its activity line. */
const CARD_KINDS = new Set<ItemKind>([
  ...SPAN_ROW_KINDS,
  'message',
  'error',
  'stage_change',
  'thread_outcome',
]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turns what other modules publish into the command center's two events: a
 * run whose card moved (`command_center_changed`), and a message between the
 * manager and a thread (`command_center_contact`). Subscribing here, never
 * publishing from those modules, keeps them unaware of the command center.
 */
@Injectable()
export class CommandCenterEventsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CommandCenterEventsService.name);
  private readonly subscriptions: Subscription[] = [];

  constructor(
    private readonly em: EntityManager,
    private readonly agents: AgentEventBus,
    private readonly tasks: TaskEventBus,
    private readonly taskDao: TaskDao,
    private readonly inbox: ThreadInboxService,
    private readonly board: CommandCenterService,
    private readonly events: CommandCenterEventBus,
  ) {}

  onModuleInit(): void {
    this.subscriptions.push(
      this.agents.allStatuses().subscribe(({ runId }) => {
        this.events.publishChanged([runId], 'status');
      }),
      this.agents.all().subscribe(({ runId, item }) => {
        if (CARD_KINDS.has(item.kind)) {
          this.events.publishChanged([runId], 'items');
        }
      }),
      this.tasks.allChanges().subscribe(({ taskId }) => {
        void this.taskMoved(taskId);
      }),
      this.agents.allThreadMessagesSent().subscribe((sent) => {
        void this.messageSent(sent);
      }),
      this.agents.allReplyCreditsSpent().subscribe(({ toRunId }) => {
        this.events.publishChanged([toRunId], 'items');
      }),
    );
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
  }

  private async taskMoved(taskId: string): Promise<void> {
    try {
      const task = await this.taskDao.getById(taskId, this.em.fork());
      if (task?.runId !== null && task?.runId !== undefined) {
        this.events.publishChanged([task.runId], 'task');
      }
    } catch (error) {
      this.logger.warn(
        `task ${taskId} change not relayed: ${messageOf(error)}`,
      );
    }
  }

  private async messageSent(sent: ThreadMessageSent): Promise<void> {
    try {
      const managerRunId = await this.board.managerRunId();
      if (
        managerRunId === null ||
        (sent.fromRunId !== managerRunId && sent.toRunId !== managerRunId)
      ) {
        return;
      }
      const threadRunId =
        sent.fromRunId === managerRunId ? sent.toRunId : sent.fromRunId;
      const awaiting = await this.inbox.awaitingRepliesFrom(managerRunId);
      this.events.publishContact({
        messageId: sent.messageId,
        fromRunId: sent.fromRunId,
        toRunId: sent.toRunId,
        at: sent.at.toISOString(),
        awaitingReply: awaiting.has(threadRunId),
      });
      this.events.publishChanged([threadRunId], 'items');
    } catch (error) {
      this.logger.warn(
        `message ${sent.messageId} contact not relayed: ${messageOf(error)}`,
      );
    }
  }
}
