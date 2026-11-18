import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Goal } from '../../runs/entity/goal.entity';
import { Run } from '../../runs/entity/run.entity';
import type { RunStatusEvent } from '../chat.types';
import { GoalDao } from '../dao/goal.dao';
import { RunDao } from '../dao/run.dao';
import { AgentEventBus } from '../services/agent-events.bus';
import { GoalsService } from '../services/goals.service';

/** A `GoalsService` over an in-memory database, with the announces it made. */
export async function goalsDb() {
  const orm = await MikroORM.init(
    defineConfig({
      ...GENIRO_ORM_RUNTIME,
      dbName: ':memory:',
      entities: [Goal, Run],
      allowGlobalContext: true,
      namingStrategy: UnderscoreNamingStrategy,
      discovery: { checkDuplicateFieldNames: false },
      schemaGenerator: mikroOrmConfig.schemaGenerator,
    }),
  );
  await orm.schema.update({ safe: true });
  const em = orm.em;
  const bus = new AgentEventBus();
  const announced: RunStatusEvent[] = [];
  bus.allStatuses().subscribe((event) => announced.push(event));
  const service = new GoalsService(em, new RunDao(em), new GoalDao(em), bus);
  const seedRun = async (
    id: string,
    extra: Partial<Run> = {},
  ): Promise<void> => {
    const fork = em.fork();
    fork.persist(
      Object.assign(new Run(), { id, status: 'running', ...extra } as Run),
    );
    await fork.flush();
  };
  return { orm, em, bus, service, announced, seedRun };
}
