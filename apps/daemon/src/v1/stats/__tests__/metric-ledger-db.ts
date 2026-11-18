import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { claudeToolCallMetric } from '../../agents/adapters/claude/utils/claude-mcp-tool-name.utils';
import { codexToolCallMetric } from '../../agents/adapters/codex/utils/codex-items.utils';
import { cursorToolCallMetric } from '../../agents/adapters/cursor-acp/utils/cursor-tool-metric.utils';
import type { ItemWire } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { Goal } from '../../runs/entity/goal.entity';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { AgentKind, ItemKind } from '../../runs/runs.types';
import { MetricLedgerDao } from '../dao/metric-ledger.dao';
import { ToolCallEvent } from '../entity/tool-call-event.entity';
import { UsageActivity } from '../entity/usage-activity.entity';
import { ThreadMetricsLedgerService } from '../services/thread-metrics-ledger.service';

/** Each CLI's own tool-name reading, as its adapter answers `toolCallMetric`. */
const METRICS: Record<
  AgentKind,
  (name: string, kind: string | null) => { tool: string; server: string | null }
> = {
  claude: claudeToolCallMetric,
  codex: codexToolCallMetric,
  'cursor-agent': cursorToolCallMetric,
};

/** The ledger service over an in-memory database, with helpers to feed it rows. */
export async function metricLedgerDb() {
  const orm = await MikroORM.init(
    defineConfig({
      ...GENIRO_ORM_RUNTIME,
      dbName: ':memory:',
      entities: [Run, Item, NodeState, Goal, ToolCallEvent, UsageActivity],
      allowGlobalContext: true,
      namingStrategy: UnderscoreNamingStrategy,
      discovery: { checkDuplicateFieldNames: false },
      schemaGenerator: mikroOrmConfig.schemaGenerator,
    }),
  );
  await orm.schema.update({ safe: true });
  const em = orm.em;
  const adapterOf = (kind: AgentKind) => ({
    toolCallMetric: (name: string, toolKind: string | null) =>
      METRICS[kind](name, toolKind),
  });
  const adapters = {
    for: adapterOf,
    all: () =>
      new Map(
        (Object.keys(METRICS) as AgentKind[]).map((kind) => [
          kind,
          adapterOf(kind),
        ]),
      ),
  } as unknown as AgentAdapterRegistry;
  const ledger = new MetricLedgerDao(em);
  const service = new ThreadMetricsLedgerService(
    em,
    new AgentEventBus(),
    new RunDao(em),
    new NodeStateDao(em),
    new ItemDao(em),
    adapters,
    ledger,
  );
  const seedRun = async (id: string, extra: Partial<Run> = {}) => {
    const fork = em.fork();
    fork.persist(
      Object.assign(new Run(), {
        id,
        status: 'running',
        createdAt: new Date('2026-11-01T09:00:00.000Z'),
        ...extra,
      } as Run),
    );
    await fork.flush();
  };
  const seedMember = async (
    runId: string,
    memberId: string,
    agent: AgentKind,
  ) => {
    const fork = em.fork();
    fork.persist(
      Object.assign(new NodeState(), {
        runId,
        memberId,
        status: 'completed',
        agentKind: agent,
      } as NodeState),
    );
    await fork.flush();
  };
  let next = 1;
  /** Write a row to `items` and hand it to the ledger as the bus would. */
  const row = async (
    runId: string,
    kind: ItemKind,
    payload: Record<string, unknown>,
    at: string,
    memberId: string | null = null,
    inCall: string | null = null,
  ): Promise<ItemWire> => {
    const seq = next++;
    const fork = em.fork();
    const entity = fork.create(Item, {
      runId,
      seq,
      kind,
      role: null,
      memberId,
      payload: JSON.stringify(payload),
      createdAt: new Date(at),
      inCall,
    } as Item);
    await fork.flush();
    return {
      id: entity.id,
      runId,
      memberId,
      seq,
      kind,
      role: null,
      payload,
      createdAt: at,
      inCall,
    };
  };
  const feed = async (
    runId: string,
    kind: ItemKind,
    payload: Record<string, unknown>,
    at: string,
    memberId: string | null = null,
    inCall: string | null = null,
  ): Promise<ItemWire> => {
    const item = await row(runId, kind, payload, at, memberId, inCall);
    await service.observe({ runId, item });
    return item;
  };
  return { orm, em, ledger, service, seedRun, seedMember, row, feed };
}
