import { randomUUID } from 'node:crypto';

import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import { ThreadMessage } from '../../runs/entity/thread-message.entity';
import { UsageActivity } from '../../stats/entity/usage-activity.entity';
import { Task } from '../../tasks/entity/task.entity';
import { CommandCenterRosterEntry } from '../entity/command-center-roster.entity';

/** The tables the command center reads, on an in-memory database with the production schema generator. */
export async function commandCenterDb() {
  const orm = await MikroORM.init(
    defineConfig({
      dbName: ':memory:',
      entities: [
        Run,
        Item,
        Task,
        ThreadMessage,
        UsageActivity,
        CommandCenterRosterEntry,
      ],
      allowGlobalContext: true,
      namingStrategy: UnderscoreNamingStrategy,
      discovery: { checkDuplicateFieldNames: false },
      schemaGenerator: mikroOrmConfig.schemaGenerator,
    }),
  );
  await orm.schema.update({ safe: true });
  const em = orm.em;

  const seedRun = async (
    id: string,
    extra: Partial<Run> = {},
  ): Promise<Run> => {
    const fork = em.fork();
    const run = Object.assign(new Run(), {
      id,
      status: 'completed',
      title: id,
      ...extra,
    } as Run);
    fork.persist(run);
    await fork.flush();
    return run;
  };

  const seedItem = async (
    runId: string,
    seq: number,
    createdAt: Date,
    kind: Item['kind'],
    payload: unknown = {},
    extra: Partial<Item> = {},
  ): Promise<void> => {
    const fork = em.fork();
    fork.persist(
      Object.assign(new Item(), {
        id: randomUUID(),
        runId,
        seq,
        kind,
        role: null,
        memberId: null,
        payload: JSON.stringify(payload),
        createdAt,
        ...extra,
      } as Item),
    );
    await fork.flush();
  };

  const seedTask = async (
    runId: string,
    status: Task['status'],
    extra: Partial<Task> = {},
  ): Promise<void> => {
    const fork = em.fork();
    fork.persist(
      Object.assign(new Task(), {
        projectId: 'project-1',
        title: `card for ${runId}`,
        runId,
        status,
        ...extra,
      } as Task),
    );
    await fork.flush();
  };

  const seedRoster = async (
    managerRunId: string,
    threadRunId: string,
    handle: string,
    extra: Partial<CommandCenterRosterEntry> = {},
  ): Promise<void> => {
    const fork = em.fork();
    fork.persist(
      Object.assign(new CommandCenterRosterEntry(), {
        managerRunId,
        threadRunId,
        handle,
        reason: 'auto',
        note: null,
        joinedAt: new Date(0),
        leftAt: null,
        ...extra,
      } as CommandCenterRosterEntry),
    );
    await fork.flush();
  };

  return { orm, em, seedRun, seedItem, seedTask, seedRoster };
}
