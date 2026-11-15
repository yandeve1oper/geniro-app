import type { Server, Socket } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeInfo } from '../../../auth/runtime';
import type { ItemWire, RunWire } from '../../agents/chat.types';
import { FakeContextWindowStore } from '../../agents/services/__tests__/fake-context-window-store';
import { FakeDelegateSpendStore } from '../../agents/services/__tests__/fake-delegate-spend-store';
import { FakeUnrecordedSpendStore } from '../../agents/services/__tests__/fake-unrecorded-spend-store';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import { PartialStreamService } from '../../agents/services/partial-stream.service';
import { ResourceAlertEventBus } from '../../agents/services/resource-alert-events.bus';
import type { SubagentRecoveryService } from '../../agents/services/subagent-recovery.service';
import { BrowserBridgeService } from '../../browser/services/browser-bridge.service';
import { DebugLogService } from '../../diagnostics/services/debug-log.service';
import { KnowledgeEventBus } from '../../knowledge/services/knowledge-events.bus';
import { MemoryEventBus } from '../../memory/services/memory-events.bus';
import { ProjectEventBus } from '../../projects/services/project-events.bus';
import { ShareEventBus } from '../../shares/services/share-events.bus';
import { UsageEventBus } from '../../stats/services/usage-events.bus';
import { TaskEventBus } from '../../tasks/services/task-events.bus';
import { WsPresenceService } from '../services/ws-presence.service';
import { NotificationsGateway } from './notifications.gateway';

const runtime: RuntimeInfo = {
  token: 'good-token',
  version: '9.9.9',
  startedAt: 0,
  port: 47615,
};

function fakeSocket(token: unknown): {
  handshake: { auth: { token: unknown } };
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
} {
  return {
    handshake: { auth: { token } },
    emit: vi.fn(),
    disconnect: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
  };
}

/**
 * The REAL service over a real bus — it holds nothing but in-memory buffers,
 * and the gateway only ever reads its `stream()`. A double here would leave
 * the debug fan-out asserting against the double rather than the fan-out.
 */
function debugLog(): DebugLogService {
  return new DebugLogService(new AgentEventBus());
}

function subagents(): SubagentRecoveryService {
  return { schedule: vi.fn() } as unknown as SubagentRecoveryService;
}

/**
 * The REAL live plane, over its own bus and an in-memory window store — the
 * gateway only ever reads its `snapshot`, which is a projection of whatever
 * the service holds, so a double would assert against the double.
 */
function partials(
  bus: AgentEventBus = new AgentEventBus(),
): PartialStreamService {
  return new PartialStreamService(
    bus,
    new FakeContextWindowStore().asStore(),
    new FakeUnrecordedSpendStore().asStore(),
    new FakeDelegateSpendStore().asStore(),
  );
}

function wireItem(runId: string, seq: number): ItemWire {
  return {
    id: `i-${seq}`,
    runId,
    memberId: null,
    seq,
    kind: 'message',
    role: 'assistant',
    payload: { text: 'hi' },
    createdAt: new Date(0).toISOString(),
  };
}

describe('NotificationsGateway', () => {
  it('broadcasts a resource alert change to every client, bare', () => {
    const resourceAlerts = new ResourceAlertEventBus();
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      resourceAlerts,
      new BrowserBridgeService(),
    );
    const emit = vi.fn();
    const to = vi.fn();
    gw.afterInit({ emit, to } as unknown as Server);

    resourceAlerts.publish();

    expect(emit).toHaveBeenCalledWith('resource_alerts_changed');
    expect(to).not.toHaveBeenCalled();
    gw.onModuleDestroy();
  });

  it('broadcasts a knowledge write to every client, naming no text', () => {
    const knowledge = new KnowledgeEventBus();
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      knowledge,
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const emit = vi.fn();
    gw.afterInit({ emit, to: vi.fn() } as unknown as Server);

    const change = {
      documentId: 'd1',
      change: 'approved' as const,
      place: 'project:p1',
    };
    knowledge.publish(change);

    expect(emit).toHaveBeenCalledWith('knowledge_changed', change);
  });

  it('disconnects a socket presenting a bad token and never says hello', () => {
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const socket = fakeSocket('wrong-token');

    gw.handleConnection(socket as unknown as Socket);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('greets a socket presenting the per-launch token', () => {
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const socket = fakeSocket('good-token');

    gw.handleConnection(socket as unknown as Socket);

    expect(socket.emit).toHaveBeenCalledWith('hello', {
      version: runtime.version,
    });
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('join reads the runId from {runId} and string payloads, ignores empty', async () => {
    const recovery = subagents();
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      recovery,
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const socket = fakeSocket('good-token');

    await expect(
      gw.join(socket as unknown as Socket, { runId: 'r1' }),
    ).resolves.toEqual({
      event: 'joined',
      data: { runId: 'r1' },
    });
    expect(socket.join).toHaveBeenCalledWith('run:r1');
    expect(recovery.schedule).toHaveBeenCalledWith('r1');

    await expect(gw.join(socket as unknown as Socket, 'r2')).resolves.toEqual({
      event: 'joined',
      data: { runId: 'r2' },
    });
    expect(socket.join).toHaveBeenCalledWith('run:r2');
    expect(recovery.schedule).toHaveBeenCalledWith('r2');

    // An empty/garbage payload yields a null runId and joins no room.
    await expect(
      gw.join(socket as unknown as Socket, { runId: '' }),
    ).resolves.toEqual({
      event: 'joined',
      data: { runId: null },
    });
    expect(socket.join).toHaveBeenCalledTimes(2);
    expect(recovery.schedule).toHaveBeenCalledTimes(2);
  });

  it('hands a joining socket the live plane as it stands, before `joined`', async () => {
    // REPORTED as a team header that read ~$40 and then $1.71 after
    // switching threads away and back: the running spend lives on the live
    // plane alone, a delta is published only when its figure changes, and the
    // room kept nothing for a client that was not in it — so the reopened
    // thread started on an empty plane and stayed there.
    const live = partials();
    live.cost('r1', 'engineer::call-1', 'engineer', 38.5);
    live.append('r1', 'manager', 'manager', 'While that runs');
    live.cost('other-run', 'agent', null, 9);
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      live,
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const socket = fakeSocket('good-token');

    const ack = await gw.join(socket as unknown as Socket, { runId: 'r1' });

    expect(ack).toEqual({ event: 'joined', data: { runId: 'r1' } });
    const deltas = socket.emit.mock.calls.filter(
      ([event]) => event === 'agent_delta',
    );
    expect(deltas.map(([, delta]) => delta)).toEqual([
      expect.objectContaining({
        runId: 'r1',
        ownerKey: 'engineer::call-1',
        memberId: 'engineer',
        spentCostUsd: 38.5,
      }),
      expect.objectContaining({
        runId: 'r1',
        ownerKey: 'manager',
        memberId: 'manager',
        text: 'While that runs',
      }),
    ]);
  });

  it('sends nothing extra to a socket joining a run with no live state', async () => {
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const socket = fakeSocket('good-token');

    await gw.join(socket as unknown as Socket, { runId: 'r1' });

    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('does not acknowledge joined until Socket.IO room membership completes', async () => {
    const recovery = subagents();
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      recovery,
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const socket = fakeSocket('good-token');
    let resolveJoin!: () => void;
    socket.join.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveJoin = resolve;
      }),
    );
    let settled = false;
    const response = gw
      .join(socket as unknown as Socket, { runId: 'r1' })
      .finally(() => {
        settled = true;
      });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(recovery.schedule).not.toHaveBeenCalled();
    resolveJoin();
    await expect(response).resolves.toEqual({
      event: 'joined',
      data: { runId: 'r1' },
    });
  });

  it('leave reads the runId and leaves the room', () => {
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const socket = fakeSocket('good-token');

    expect(gw.leave(socket as unknown as Socket, { runId: 'r1' })).toEqual({
      event: 'left',
      data: { runId: 'r1' },
    });
    expect(socket.leave).toHaveBeenCalledWith('run:r1');
  });

  it('isolates a per-emit failure so the bus subscription survives', () => {
    const bus = new AgentEventBus();
    const gw = new NotificationsGateway(
      runtime,
      bus,
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    let calls = 0;
    const emit = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        throw new Error('emit boom'); // a single bad emit must not kill the sub
      }
    });
    const server = { to: vi.fn(() => ({ emit })) } as unknown as Server;
    gw.afterInit(server);

    // The first publish throws inside emit — it must be caught, not propagate.
    expect(() =>
      bus.publish({ runId: 'r1', item: wireItem('r1', 0) }),
    ).not.toThrow();
    // The subscription is still alive: a second publish is still delivered.
    bus.publish({ runId: 'r2', item: wireItem('r2', 1) });

    expect(server.to).toHaveBeenCalledWith('run:r1');
    expect(server.to).toHaveBeenCalledWith('run:r2');
    expect(emit).toHaveBeenCalledTimes(2);

    gw.onModuleDestroy();
  });

  it('broadcasts a recorded turn to EVERY client, and stops on destroy', () => {
    const usage = new UsageEventBus();
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      usage,
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const emit = vi.fn();
    // `to` is the ROOM path; a usage event must never take it — the Stats page
    // joins no room, so a roomed emit would reach nobody at all.
    const to = vi.fn(() => ({ emit: vi.fn() }));
    const server = { emit, to } as unknown as Server;
    gw.afterInit(server);

    const event = {
      runId: 'r1',
      memberId: null,
      occurredAt: '2026-08-17T00:00:00.000Z',
      turn: true,
    };
    usage.publish(event);

    expect(emit).toHaveBeenCalledWith('usage_recorded', event);
    expect(to).not.toHaveBeenCalled();

    gw.onModuleDestroy();
    usage.publish({ ...event, runId: 'r2' });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('broadcasts a task write to EVERY client, and stops on destroy', () => {
    const tasks = new TaskEventBus();
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      tasks,
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const emit = vi.fn();
    // `to` is the ROOM path; a task write must never take it — a board is not
    // scoped to one run's room, so a roomed emit would reach nobody watching
    // that project's cards.
    const to = vi.fn(() => ({ emit: vi.fn() }));
    const server = { emit, to } as unknown as Server;
    gw.afterInit(server);

    const change = { taskId: 't1', projectId: 'p1', status: 'todo' as const };
    tasks.publishTaskChanged(change);

    expect(emit).toHaveBeenCalledWith('task_changed', change);
    expect(to).not.toHaveBeenCalled();

    gw.onModuleDestroy();
    tasks.publishTaskChanged({ ...change, taskId: 't2' });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('broadcasts a share write to EVERY client, and stops on destroy', () => {
    const shares = new ShareEventBus();
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      shares,
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const emit = vi.fn();
    const roomEmit = vi.fn();
    const to = vi.fn(() => ({ emit: roomEmit }));
    gw.afterInit({ emit, to } as unknown as Server);

    const change = {
      runId: 'r1',
      shareId: 's1',
      status: 'awaiting-sign-in' as const,
      title: 'Report',
      destinationName: 'Company',
      askedByAgent: true,
      signInRequested: true,
    };
    shares.publish(change);

    // To the Mac's own windows only, never a broadcast a paired phone hears.
    expect(to).toHaveBeenCalledWith('desktop');
    expect(roomEmit).toHaveBeenCalledWith('shares_changed', change);
    expect(emit).not.toHaveBeenCalled();

    gw.onModuleDestroy();
    shares.publish({ ...change, shareId: 's2' });
    expect(roomEmit).toHaveBeenCalledTimes(1);
  });

  it('broadcasts a memory write to every client, phone included, until destroyed', () => {
    const memories = new MemoryEventBus();
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      memories,
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit: vi.fn() }));
    gw.afterInit({ emit, to } as unknown as Server);

    const change = {
      memoryId: 'm-1',
      change: 'created' as const,
      status: 'active' as const,
      projectId: null,
      teamSlug: null,
    };
    memories.publish(change);

    expect(emit).toHaveBeenCalledWith('memory_changed', change);
    expect(to).not.toHaveBeenCalled();

    const bulk = {
      memoryId: null,
      change: 'bulk' as const,
      status: 'forgotten' as const,
      projectId: null,
      teamSlug: null,
    };
    memories.publish(bulk);
    expect(emit).toHaveBeenLastCalledWith('memory_changed', bulk);

    gw.onModuleDestroy();
    memories.publish({ ...change, memoryId: 'm-2' });
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('broadcasts a thread message change to every client, phone included, until destroyed', () => {
    const bus = new AgentEventBus();
    const gw = new NotificationsGateway(
      runtime,
      bus,
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit: vi.fn() }));
    gw.afterInit({ emit, to } as unknown as Server);

    bus.publishThreadMessagesChanged('r1');

    expect(emit).toHaveBeenCalledWith('thread_messages_changed', {
      runId: 'r1',
    });
    expect(to).not.toHaveBeenCalled();

    gw.onModuleDestroy();
    bus.publishThreadMessagesChanged('r2');
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('broadcasts a project write to every client, phone included, until destroyed', () => {
    const projects = new ProjectEventBus();
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      projects,
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit: vi.fn() }));
    gw.afterInit({ emit, to } as unknown as Server);

    projects.publish({ projectId: 'p-1' });
    expect(emit).toHaveBeenCalledWith('projects_changed', { projectId: 'p-1' });
    expect(to).not.toHaveBeenCalled();

    gw.onModuleDestroy();
    projects.publish({ projectId: 'p-2' });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('puts the Mac’s own sockets in the desktop room and a paired device’s outside it', () => {
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const desktop = fakeSocket('good-token');
    const phone = {
      ...fakeSocket('good-token'),
      handshake: {
        auth: { token: 'good-token' },
        headers: { 'x-geniro-via': 'remote' },
      },
    };

    gw.handleConnection(desktop as unknown as Socket);
    gw.handleConnection(phone as unknown as Socket);

    expect(desktop.join).toHaveBeenCalledWith('desktop');
    expect(phone.join).not.toHaveBeenCalledWith('desktop');
  });

  it('broadcasts a deleted run to EVERY client, and stops on destroy', () => {
    const bus = new AgentEventBus();
    const gw = new NotificationsGateway(
      runtime,
      bus,
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const emit = vi.fn();
    // `to` is the ROOM path; a deletion must never take it — every OTHER
    // client's ghost row has to be corrected, not just the room of whoever
    // pressed Delete.
    const to = vi.fn(() => ({ emit: vi.fn() }));
    const server = { emit, to } as unknown as Server;
    gw.afterInit(server);

    bus.publishRunDeleted('r1');

    expect(emit).toHaveBeenCalledWith('run_deleted', { runId: 'r1' });
    expect(to).not.toHaveBeenCalled();

    gw.onModuleDestroy();
    bus.publishRunDeleted('r2');
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('runs_changed broadcast', () => {
  const runtime = {
    token: 't',
    version: '0',
  } as unknown as import('../../../auth/runtime').RuntimeInfo;

  it('broadcasts a re-filed run to EVERY client, and stops on destroy', () => {
    // A thread archived on the phone must leave the desktop's sidebar too, and
    // the desktop never joined that run's room — so the room path is wrong
    // here exactly as it is for a deletion.
    const bus = new AgentEventBus();
    const gw = new NotificationsGateway(
      runtime,
      bus,
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit: vi.fn() }));
    gw.afterInit({ emit, to } as unknown as Server);

    const row = { id: 'r1', archivedAt: '2026-09-24T00:00:00.000Z' };
    bus.publishRunsChanged([row] as unknown as RunWire[]);

    expect(emit).toHaveBeenCalledWith('runs_changed', { runs: [row] });
    expect(to).not.toHaveBeenCalled();

    // An empty list announces nothing: no client has a row to re-file.
    bus.publishRunsChanged([]);
    expect(emit).toHaveBeenCalledTimes(1);

    gw.onModuleDestroy();
    bus.publishRunsChanged([row] as unknown as RunWire[]);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('verdict round-trip', () => {
  const runtime = {
    token: 't',
    version: '0',
  } as unknown as import('../../../auth/runtime').RuntimeInfo;

  it('routes a valid verdict to the approval registry and acks applied', () => {
    const approvals = new ApprovalRegistry();
    const respond = vi.fn(() => true);
    approvals.track({
      runId: 'r1',
      memberId: 'n1',
      requestId: 'req-1',
      toolName: 'Write',
      input: {},
      question: false,
      respond,
    });
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      approvals,
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );

    const ack = gw.verdict({ runId: 'r1', requestId: 'req-1', allow: true });
    expect(ack).toEqual({
      event: 'verdict_ack',
      data: { runId: 'r1', requestId: 'req-1', status: 'applied' },
    });
    expect(respond).toHaveBeenCalledWith(true);
  });

  it('forwards a picked option id, and refuses a malformed one without consuming the card', () => {
    const approvals = new ApprovalRegistry();
    const respond = vi.fn(() => true);
    const track = (requestId: string): void =>
      approvals.track({
        runId: 'r1',
        memberId: 'n1',
        requestId,
        toolName: 'Bash',
        input: {},
        question: false,
        respond,
      });
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      approvals,
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );

    track('req-o');
    expect(
      gw.verdict({
        runId: 'r1',
        requestId: 'req-o',
        allow: true,
        optionId: 'session',
      }).data.status,
    ).toBe('applied');
    expect(respond).toHaveBeenLastCalledWith(true, undefined, 'session');

    track('req-bad');
    for (const optionId of ['', 7, 'x'.repeat(257)]) {
      expect(
        gw.verdict({ runId: 'r1', requestId: 'req-bad', allow: true, optionId })
          .data.status,
      ).toBe('invalid');
    }
    // Still open: a malformed pick is not a plain approve.
    expect(approvals.listByRun('r1').map((p) => p.requestId)).toEqual([
      'req-bad',
    ]);
  });

  it('distinguishes expired requests from malformed verdicts', () => {
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );
    expect(
      gw.verdict({ runId: 'r1', requestId: 'ghost', allow: false }).data,
    ).toEqual({ runId: 'r1', requestId: 'ghost', status: 'expired' });
    expect(gw.verdict({ nonsense: true }).data).toEqual({
      runId: null,
      requestId: null,
      status: 'invalid',
    });
  });

  it('forwards valid answers and rejects invalid ones without consuming the question', () => {
    const approvals = new ApprovalRegistry();
    const respond = vi.fn(() => true);
    const track = (requestId: string): void =>
      approvals.track({
        runId: 'r1',
        memberId: 'n1',
        requestId,
        toolName: 'AskUserQuestion',
        input: {},
        question: true,
        respond,
      });
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      approvals,
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      new BrowserBridgeService(),
    );

    track('req-a');
    gw.verdict({
      runId: 'r1',
      requestId: 'req-a',
      allow: true,
      answer: 'Blue',
    });
    expect(respond).toHaveBeenLastCalledWith(true, 'Blue');

    // Non-string / empty / oversize answers must not consume the one-shot
    // approval as a plain approve; the user can correct and resubmit.
    track('req-b');
    expect(
      gw.verdict({
        runId: 'r1',
        requestId: 'req-b',
        allow: true,
        answer: 42,
      }).data,
    ).toEqual({ runId: 'r1', requestId: 'req-b', status: 'invalid' });
    track('req-c');
    expect(
      gw.verdict({
        runId: 'r1',
        requestId: 'req-c',
        allow: true,
        answer: '',
      }).data,
    ).toEqual({ runId: 'r1', requestId: 'req-c', status: 'invalid' });
    track('req-d');
    expect(
      gw.verdict({
        runId: 'r1',
        requestId: 'req-d',
        allow: true,
        answer: 'x'.repeat(40_000),
      }).data,
    ).toEqual({ runId: 'r1', requestId: 'req-d', status: 'invalid' });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(approvals.listByRun('r1')).toHaveLength(3);
  });
});

describe('browser host sockets', () => {
  function setup(): {
    gw: NotificationsGateway;
    bridge: BrowserBridgeService;
    to: ReturnType<typeof vi.fn>;
    sent: ReturnType<typeof vi.fn>;
  } {
    const bridge = new BrowserBridgeService();
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
      new WsPresenceService(),
      debugLog(),
      new UsageEventBus(),
      new TaskEventBus(),
      partials(),
      subagents(),
      new ShareEventBus(),
      new MemoryEventBus(),
      new ProjectEventBus(),
      new KnowledgeEventBus(),
      new ResourceAlertEventBus(),
      bridge,
    );
    const sent = vi.fn();
    const to = vi.fn(() => ({ emit: sent }));
    gw.afterInit({ emit: vi.fn(), to } as unknown as Server);
    return { gw, bridge, to, sent };
  }

  function socket(id: string, headers: Record<string, string> = {}): Socket {
    return { id, handshake: { headers } } as unknown as Socket;
  }

  const request = {
    runId: 'r1',
    memberName: 'Dev',
    op: { kind: 'tabs' as const },
    allowedHosts: null,
  };

  it('refuses browser_host from a remote socket', async () => {
    const { gw, bridge, to } = setup();

    gw.browserHost(socket('phone', { 'x-geniro-via': 'remote' }));

    expect(bridge.hasHost()).toBe(false);
    await expect(bridge.request(request)).resolves.toMatchObject({
      status: 'failed',
    });
    expect(to).not.toHaveBeenCalled();
  });

  it('registers browser_host from a desktop socket', () => {
    const { gw, bridge, to, sent } = setup();

    gw.browserHost(socket('mac'));
    void bridge.request(request);

    expect(bridge.hasHost()).toBe(true);
    expect(to).toHaveBeenCalledWith('mac');
    expect(to).not.toHaveBeenCalledWith('desktop');
    expect(sent).toHaveBeenCalledWith(
      'browser_request',
      expect.objectContaining({ runId: 'r1', op: { kind: 'tabs' } }),
    );
  });

  it('ignores browser_reply from another socket', async () => {
    const { gw, bridge, sent } = setup();
    gw.browserHost(socket('mac'));
    const outcome = bridge.request(request);
    const { id } = sent.mock.calls[0]?.[1] as { id: string };
    const settled = vi.fn();
    void outcome.then(settled);

    gw.browserReply(socket('other'), { id, ok: true, text: 'spoofed' });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    gw.browserReply(socket('mac'), { id, ok: true, text: 'real' });
    await expect(outcome).resolves.toEqual({ status: 'done', text: 'real' });
  });

  it('fails the pending requests when the host socket disconnects', async () => {
    const { gw, bridge } = setup();
    gw.browserHost(socket('mac'));
    const outcome = bridge.request(request);

    gw.handleDisconnect(socket('mac'));

    await expect(outcome).resolves.toMatchObject({ status: 'failed' });
    expect(bridge.hasHost()).toBe(false);
  });
});
