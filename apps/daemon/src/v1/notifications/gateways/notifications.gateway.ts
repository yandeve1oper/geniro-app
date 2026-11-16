import { Inject, Logger, type OnModuleDestroy, Optional } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  type WsResponse,
} from '@nestjs/websockets';
import type { Subscription } from 'rxjs';
import type { Server, Socket } from 'socket.io';

import { cameViaRemote } from '../../../auth/remote-marker';
import { RUNTIME_TOKEN, type RuntimeInfo } from '../../../auth/runtime';
import { enforceWsHandshakeAuth } from '../../../auth/ws-auth';
import {
  MAX_ANSWER_LENGTH,
  MAX_OPTION_ID_LENGTH,
} from '../../agents/chat.types';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import { PartialStreamService } from '../../agents/services/partial-stream.service';
import { ResourceAlertEventBus } from '../../agents/services/resource-alert-events.bus';
import { SubagentRecoveryService } from '../../agents/services/subagent-recovery.service';
import {
  extractBooleanField,
  extractStringField,
} from '../../agents/utils/ws-payload';
import { BROWSER_REPLY_MAX_BYTES } from '../../browser/browser.types';
import { BrowserBridgeService } from '../../browser/services/browser-bridge.service';
import { DebugLogService } from '../../diagnostics/services/debug-log.service';
import { KnowledgeEventBus } from '../../knowledge/services/knowledge-events.bus';
import { LessonsEventBus } from '../../lessons/services/lessons-events.bus';
import { MemoryEventBus } from '../../memory/services/memory-events.bus';
import { ProjectEventBus } from '../../projects/services/project-events.bus';
import { ShareEventBus } from '../../shares/services/share-events.bus';
import { UsageEventBus } from '../../stats/services/usage-events.bus';
import { TaskEventBus } from '../../tasks/services/task-events.bus';
import { WsPresenceService } from '../services/ws-presence.service';

/**
 * Defensively read a `verdict` payload: `{runId, requestId, allow, answer?}`.
 * `answer` is the user's picked option / typed text for a question card
 * (AskUserQuestion, M4) — optional and only honored as a non-empty string, so
 * the plain approve/deny wire stays byte-compatible.
 *
 * TWIN PARSER: the renderer produces this envelope in
 * `DaemonClient.sendVerdict` (apps/ui/src/renderer/daemon-client.ts) — no
 * daemon↔renderer shared package exists, so a shape change here must be
 * mirrored there, and vice versa.
 */
function extractVerdict(data: unknown): {
  runId: string;
  requestId: string;
  allow: boolean;
  answer?: string;
  optionId?: string;
} | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const { runId, requestId, allow, answer, optionId } = data as {
    runId?: unknown;
    requestId?: unknown;
    allow?: unknown;
    answer?: unknown;
    optionId?: unknown;
  };
  if (
    typeof runId !== 'string' ||
    runId.length === 0 ||
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    typeof allow !== 'boolean' ||
    (answer !== undefined &&
      (typeof answer !== 'string' ||
        answer.length === 0 ||
        answer.length > MAX_ANSWER_LENGTH)) ||
    (optionId !== undefined &&
      (typeof optionId !== 'string' ||
        optionId.length === 0 ||
        optionId.length > MAX_OPTION_ID_LENGTH))
  ) {
    return null;
  }
  return {
    runId,
    requestId,
    allow,
    answer: typeof answer === 'string' ? answer : undefined,
    ...(typeof optionId === 'string' ? { optionId } : {}),
  };
}

/** Socket.IO room a client joins to receive one run's streamed items. */
function runRoom(runId: string): string {
  return `run:${runId}`;
}

/**
 * The room a client joins to receive the debug log.
 *
 * Not keyed by anything: the log is daemon-wide, and there is exactly one of
 * it. A room rather than a broadcast because nobody should receive this unless
 * they opened the panel — with `agent-stdio` on it is thousands of lines a
 * turn, and a client that is not showing them would be paying to throw them
 * away.
 */
const DEBUG_ROOM = 'debug';

/** Defensively read a runId from a `join`/`leave` payload (string or `{runId}`). */
function extractRunId(data: unknown): string | null {
  return extractStringField(data, 'runId');
}

/** The room every socket of the Mac's own windows joins — never a paired device's. */
const DESKTOP_ROOM = 'desktop';

/**
 * Loopback notifications gateway (Socket.IO). The renderer authenticates with
 * the per-launch loopback token via the handshake `auth` payload (browsers
 * can't set an Authorization header on the WS upgrade). `cors.origin: '*'` is
 * safe — the daemon binds 127.0.0.1 only and the token is the real gate.
 *
 * M2 grows the M1 hello/echo stub into the live run-event channel: a single
 * subscription to {@link AgentEventBus} fans each persisted item out to its
 * run's room, and clients `join`/`leave` a run to stream it. Because items are
 * persisted before they reach the bus (persist-then-emit), a client that joins
 * late replays the history over REST first, then attaches here for live items,
 * de-duplicating on `seq`.
 */
@WebSocketGateway({
  path: '/ws',
  cors: { origin: '*' },
  maxHttpBufferSize: BROWSER_REPLY_MAX_BYTES,
})
export class NotificationsGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    OnModuleDestroy
{
  private readonly logger = new Logger(NotificationsGateway.name);
  private busSubscription?: Subscription;
  private deltaSubscription?: Subscription;
  private statusSubscription?: Subscription;
  private deletedSubscription?: Subscription;
  private changedSubscription?: Subscription;
  private groupsSubscription?: Subscription;
  private debugSubscription?: Subscription;
  private usageSubscription?: Subscription;
  private taskSubscription?: Subscription;
  private shareSubscription?: Subscription;
  private memorySubscription?: Subscription;
  private lessonsSubscription?: Subscription;
  private knowledgeSubscription?: Subscription;
  private threadMessagesSubscription?: Subscription;
  private projectSubscription?: Subscription;
  private resourceAlertSubscription?: Subscription;
  /**
   * Debug fan-out failures, counted rather than logged.
   *
   * Logging one would feed the very stream that just failed — `this.logger`
   * writes into the debug sink — so an emit error would produce an entry,
   * which would fail to emit, which would log again. A counter breaks that
   * loop; the diagnostics report is where it surfaces.
   */
  private debugEmitFailures = 0;

  constructor(
    @Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo,
    private readonly bus: AgentEventBus,
    private readonly approvals: ApprovalRegistry,
    private readonly presence: WsPresenceService,
    private readonly debugLog: DebugLogService,
    private readonly usage: UsageEventBus,
    private readonly tasks: TaskEventBus,
    private readonly partials: PartialStreamService,
    private readonly subagents: SubagentRecoveryService,
    private readonly shares: ShareEventBus,
    private readonly memories: MemoryEventBus,
    private readonly projects: ProjectEventBus,
    private readonly knowledge: KnowledgeEventBus,
    private readonly resourceAlerts: ResourceAlertEventBus,
    private readonly browserBridge: BrowserBridgeService,
    @Optional() private readonly lessons?: LessonsEventBus,
  ) {}

  afterInit(server: Server): void {
    // A browser request goes to the one socket that registered as the browser's
    // host and never to DESKTOP_ROOM: it acts with the Mac's own browser, and a
    // second window would run it twice.
    this.browserBridge.attachEmitter((socketId, event, payload) => {
      server.to(socketId).emit(event, payload);
    });
    // Isolate per-emit failures: a single throw from `emit` (or a bus error)
    // must not terminate this subscription, or ALL live streaming would die
    // silently for the rest of the daemon's life.
    this.busSubscription = this.bus.all().subscribe({
      next: ({ runId, item }) => {
        try {
          server.to(runRoom(runId)).emit('item', item);
        } catch (err) {
          this.logger.error(
            `failed to emit item to ${runRoom(runId)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`agent event bus errored: ${String(err)}`),
    });
    // The EPHEMERAL live-text plane rides the same rooms, as its own event so
    // a client can ignore it entirely and still receive a complete transcript.
    // Isolated for the same reason as above: a throw here must not kill item
    // delivery, which is the durable half.
    this.deltaSubscription = this.bus.allDeltas().subscribe({
      next: (delta) => {
        try {
          server.to(runRoom(delta.runId)).emit('agent_delta', delta);
        } catch (err) {
          this.logger.error(
            `failed to emit agent_delta to ${runRoom(delta.runId)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`agent delta bus errored: ${String(err)}`),
    });
    // Run status goes to EVERY client, not to the run's room. A client only
    // joins the run it is showing, so a background run's badge had no way to
    // learn it had settled and lied until the next refetch. Isolated like the
    // two above.
    this.statusSubscription = this.bus.allStatuses().subscribe({
      next: (status) => {
        try {
          server.emit('run_status', status);
        } catch (err) {
          this.logger.error(
            `failed to broadcast run_status for ${status.runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`run status bus errored: ${String(err)}`),
    });
    // A task write goes to EVERY client, not to a run's room — a board is not
    // scoped to one run, and a card can move from a window that has none of
    // this project's runs open at all. Isolated like its neighbours.
    this.taskSubscription = this.tasks.allChanges().subscribe({
      next: (change) => {
        try {
          server.emit('task_changed', change);
        } catch (err) {
          this.logger.error(
            `failed to broadcast task_changed for ${change.taskId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`task event bus errored: ${String(err)}`),
    });
    // A share row written or removed goes to every DESKTOP client, whichever
    // run it has open: an agent's share waiting on sign-in must reach the
    // window that will ask the user. Never a paired device, which no share
    // route serves; and the event never carries the link.
    this.shareSubscription = this.shares.allChanges().subscribe({
      next: (change) => {
        try {
          server.to(DESKTOP_ROOM).emit('shares_changed', change);
        } catch (err) {
          this.logger.error(
            `failed to broadcast shares_changed for ${change.shareId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`share event bus errored: ${String(err)}`),
    });
    // Goes to EVERY client, paired devices included: a phone reads the same
    // waiting list. The event names the thread, never a message.
    this.threadMessagesSubscription = this.bus
      .allThreadMessageChanges()
      .subscribe({
        next: (change) => {
          try {
            server.emit('thread_messages_changed', change);
          } catch (err) {
            this.logger.error(
              `failed to broadcast thread_messages_changed (${change.runId}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
        error: (err: unknown) =>
          this.logger.error(`thread message bus errored: ${String(err)}`),
      });
    // Goes to EVERY client, paired devices included: the phone shows the same
    // alert strip. No payload; clients read the list over HTTP.
    //
    // TWIN PARSER: `DaemonClient.onResourceAlertsChanged`
    // (apps/ui/src/renderer/daemon-client.ts) takes this event bare.
    this.resourceAlertSubscription = this.resourceAlerts
      .allChanges()
      .subscribe({
        next: () => {
          try {
            server.emit('resource_alerts_changed');
          } catch (err) {
            this.logger.error(
              `failed to broadcast resource_alerts_changed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
        error: (err: unknown) =>
          this.logger.error(`resource alert bus errored: ${String(err)}`),
      });
    // A memory write goes to EVERY client, paired devices included: the user
    // reads and edits memory from the phone too. The event names the entry,
    // never its text.
    this.memorySubscription = this.memories.allChanges().subscribe({
      next: (change) => {
        try {
          server.emit('memory_changed', change);
        } catch (err) {
          this.logger.error(
            `failed to broadcast memory_changed (${change.change} ${change.memoryId ?? 'many'}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`memory event bus errored: ${String(err)}`),
    });
    // A lessons change goes to every client on the same terms: offers and
    // "Not reflected yet" are acted on from the phone too. It names the thread only.
    this.lessonsSubscription = this.lessons?.allChanges().subscribe({
      next: (change) => {
        try {
          server.emit('lessons_changed', change);
        } catch (err) {
          this.logger.error(
            `failed to broadcast lessons_changed (${change.runId ?? 'many'}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`lessons event bus errored: ${String(err)}`),
    });
    // A knowledge write goes to EVERY client, as a memory write does; the
    // event names the document and its place, never its text.
    this.knowledgeSubscription = this.knowledge.allChanges().subscribe({
      next: (change) => {
        try {
          server.emit('knowledge_changed', change);
        } catch (err) {
          this.logger.error(
            `failed to broadcast knowledge_changed (${change.change} ${change.documentId ?? 'many'}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`knowledge event bus errored: ${String(err)}`),
    });
    // A project write goes to EVERY client, paired devices included, like a
    // task write: the Projects page, the board and the composer all read it.
    this.projectSubscription = this.projects.allChanges().subscribe({
      next: (change) => {
        try {
          server.emit('projects_changed', change);
        } catch (err) {
          this.logger.error(
            `failed to broadcast projects_changed for ${change.projectId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`project event bus errored: ${String(err)}`),
    });
    // A DESTROYED run goes to every client, and it is the one announcement
    // whose absence a client cannot recover from on its own.
    //
    // `bus.allDeleted()` had three subscribers and all of them were inside the
    // daemon, so the fact never crossed the wire at all: whichever client
    // pressed Delete dropped the row itself, and every OTHER client kept a row
    // for a run that no longer existed — with no event able to correct it,
    // since `run_status` only ever describes runs that are still there. The
    // ghost then answered a click with `404 RUN_NOT_FOUND`, which is how a user
    // came to have a row they could neither open nor delete. REPORTED as "I
    // cant delete thread from app", against a run whose `runs`, `items` and
    // `node_state` rows had all been gone for minutes.
    //
    // No room, on `run_status`'s reasoning exactly: a client joins only the run
    // it is showing, and the row that has to disappear is in every client's
    // sidebar. Isolated like its neighbours.
    this.deletedSubscription = this.bus.allDeleted().subscribe({
      next: (runId) => {
        try {
          server.emit('run_deleted', { runId });
        } catch (err) {
          this.logger.error(
            `failed to broadcast run_deleted for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`run deleted bus errored: ${String(err)}`),
    });
    // A RE-FILED run goes to every client too, and for `run_deleted`'s
    // reason: archiving, renaming or pinning moves a row in every sidebar, and
    // a client joins only the run it is showing. Without it a thread archived
    // on the phone stayed on the desktop's desk — REPORTED as "I deleted
    // threads from mobile, but still can see it on PC".
    //
    // TWIN PARSER: `parseChangedRuns` in apps/ui/src/renderer/daemon-client.ts
    // reads this `{runs}` envelope; a shape change here is mirrored there.
    this.changedSubscription = this.bus.allChanged().subscribe({
      next: (runs) => {
        try {
          server.emit('runs_changed', { runs });
        } catch (err) {
          this.logger.error(
            `failed to broadcast runs_changed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`run changed bus errored: ${String(err)}`),
    });
    // A recorded turn goes to EVERY client, like `run_status` and for the
    // mirror-image reason: the page that cares is Stats, which belongs to no
    // run's room — it is about all of them at once. It is a handful of bytes
    // per finished turn, and without it an open Stats page kept showing the
    // totals it was opened on while the agent went on spending. Isolated like
    // its neighbours, so a throw here cannot take transcript delivery with it.
    // The sidebar's GROUP list changed, for every client, on `runs_changed`'s
    // reasoning: a group made or deleted on the phone has to appear or vanish
    // on the desktop too, and a client joins only the run it is showing. No
    // payload — the client re-reads `GET /v1/groups`, the one answer it
    // already draws groups from.
    //
    // TWIN PARSER: `onGroupsChanged` in apps/ui/src/renderer/daemon-client.ts
    // listens for this event name; renaming it here is mirrored there.
    this.groupsSubscription = this.bus.allGroupsChanged().subscribe({
      next: () => {
        try {
          server.emit('groups_changed', {});
        } catch (err) {
          this.logger.error(
            `failed to broadcast groups_changed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`groups changed bus errored: ${String(err)}`),
    });
    this.usageSubscription = this.usage.all().subscribe({
      next: (event) => {
        try {
          server.emit('usage_recorded', event);
        } catch (err) {
          this.logger.error(
            `failed to broadcast usage_recorded for ${event.runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`usage event bus errored: ${String(err)}`),
    });
    // The debug log goes to the DEBUG_ROOM, not to every client — the one
    // stream here that nobody should receive by default. It carries the raw
    // agent conversation when that channel is on, at thousands of lines a
    // turn, and a client that never opened the panel has no use for a single
    // one of them. Joining the room is the act of opening the panel.
    //
    // Isolated like its neighbours: a throw in this fan-out must not be able
    // to kill transcript delivery, which is the half the app depends on.
    this.debugSubscription = this.debugLog.stream().subscribe({
      next: (entry) => {
        try {
          server.to(DEBUG_ROOM).emit('debug', entry);
        } catch {
          // Deliberately NOT `this.logger.error`: that call is itself a source
          // of debug entries, so logging a fan-out failure through it feeds
          // the stream that just failed and recurses. The counter is what
          // records it instead.
          this.debugEmitFailures += 1;
        }
      },
      error: () => {
        this.debugEmitFailures += 1;
      },
    });
  }

  onModuleDestroy(): void {
    this.busSubscription?.unsubscribe();
    this.deltaSubscription?.unsubscribe();
    this.statusSubscription?.unsubscribe();
    this.taskSubscription?.unsubscribe();
    this.shareSubscription?.unsubscribe();
    this.memorySubscription?.unsubscribe();
    this.lessonsSubscription?.unsubscribe();
    this.knowledgeSubscription?.unsubscribe();
    this.threadMessagesSubscription?.unsubscribe();
    this.projectSubscription?.unsubscribe();
    this.resourceAlertSubscription?.unsubscribe();
    this.deletedSubscription?.unsubscribe();
    this.changedSubscription?.unsubscribe();
    this.groupsSubscription?.unsubscribe();
    this.debugSubscription?.unsubscribe();
    this.usageSubscription?.unsubscribe();
  }

  /**
   * Start/stop receiving debug entries on this socket.
   *
   * A room rather than a per-socket flag so the fan-out stays one `emit` no
   * matter how many clients are watching, exactly like the run rooms.
   */
  @SubscribeMessage('debug_subscribe')
  async debugSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): Promise<WsResponse<{ subscribed: boolean }>> {
    // Default TRUE: `debug_subscribe` with no body plainly means "subscribe",
    // and a missing field must not silently mean the opposite.
    const on = extractBooleanField(data, 'on') ?? true;
    if (on) {
      await client.join(DEBUG_ROOM);
    } else {
      await client.leave(DEBUG_ROOM);
    }
    return { event: 'debug_subscribed', data: { subscribed: on } };
  }

  handleConnection(client: Socket): void {
    if (!enforceWsHandshakeAuth(client, this.runtime)) {
      // Deliberately NOT counted: a socket that failed the token check was
      // never a client, and counting it would keep the daemon believing
      // someone is using it.
      return;
    }
    this.presence.opened(client.id);
    // The Mac's own windows, apart from a paired device's socket (stamped by
    // the LAN gateway): share changes go to these only, as every share route
    // is desktop-only.
    if (!cameViaRemote(client.handshake.headers ?? {})) {
      void client.join(DESKTOP_ROOM);
    }
    client.emit('hello', { version: this.runtime.version });
  }

  handleDisconnect(client: Socket): void {
    this.presence.closed(client.id);
    this.browserBridge.unregister(client.id);
  }

  /**
   * The desktop window offers to host the in-app browser. Refused from a paired
   * device's socket: the browser is the Mac's.
   */
  @SubscribeMessage('browser_host')
  browserHost(@ConnectedSocket() client: Socket): void {
    if (cameViaRemote(client.handshake.headers ?? {})) {
      this.logger.debug('refused browser_host from a remote socket');
      return;
    }
    this.browserBridge.register(client.id);
  }

  /**
   * An answer to a `browser_request`.
   *
   * TWIN PARSER: the renderer emits this envelope from
   * `apps/ui/src/renderer/daemon-client.ts`; the shape is `BrowserReplySchema`
   * (`v1/browser/browser.types.ts`).
   */
  @SubscribeMessage('browser_reply')
  browserReply(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): void {
    this.browserBridge.reply(client.id, data);
  }

  @SubscribeMessage('join')
  async join(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): Promise<WsResponse<{ runId: string | null }>> {
    const runId = extractRunId(data);
    if (runId) {
      await client.join(runRoom(runId));
      this.subagents.schedule(runId);
      // The live plane as it stands, to this socket alone. A delta is
      // published only when its figure changes and the room kept nothing for
      // a client that was not in it, so a thread reopened mid-turn started on
      // an empty plane — and its header lost the running spend until the next
      // reading moved. Sent before `joined`, so the client holds the plane by
      // the time it learns the join landed.
      for (const delta of this.partials.snapshot(runId)) {
        client.emit('agent_delta', delta);
      }
    }
    return { event: 'joined', data: { runId } };
  }

  @SubscribeMessage('leave')
  leave(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): WsResponse<{ runId: string | null }> {
    const runId = extractRunId(data);
    if (runId) {
      void client.leave(runRoom(runId));
    }
    return { event: 'left', data: { runId } };
  }

  /**
   * The elicitation card's answer: routes a tool-approval verdict to the
   * paused `ask`-mode turn via the {@link ApprovalRegistry}. The acknowledgment
   * distinguishes applied, expired, and retryable-invalid payloads. The socket
   * is already token-authenticated at `handleConnection`.
   *
   * TWIN PARSER: the `verdict_ack` reply shape is re-declared by the renderer
   * as `VerdictAck` (apps/ui/src/renderer/daemon-client.ts) — a shape change
   * here must be mirrored there, and vice versa.
   */
  @SubscribeMessage('verdict')
  verdict(@MessageBody() data: unknown): WsResponse<{
    runId: string | null;
    requestId: string | null;
    status: 'applied' | 'expired' | 'invalid';
  }> {
    const parsed = extractVerdict(data);
    if (!parsed) {
      return {
        event: 'verdict_ack',
        data: {
          runId: extractStringField(data, 'runId'),
          requestId: extractStringField(data, 'requestId'),
          status: 'invalid',
        },
      };
    }
    const applied = this.approvals.resolve(
      parsed.runId,
      parsed.requestId,
      parsed.allow,
      parsed.answer,
      parsed.optionId,
    );
    return {
      event: 'verdict_ack',
      data: {
        runId: parsed.runId,
        requestId: parsed.requestId,
        status: applied ? 'applied' : 'expired',
      },
    };
  }

  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown): WsResponse<unknown> {
    return { event: 'echo', data };
  }
}
