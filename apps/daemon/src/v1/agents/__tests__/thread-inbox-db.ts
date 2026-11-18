import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Run } from '../../runs/entity/run.entity';
import { ThreadMessage } from '../../runs/entity/thread-message.entity';
import { RunDao } from '../dao/run.dao';
import { ThreadMessageDao } from '../dao/thread-message.dao';
import { AgentEventBus } from '../services/agent-events.bus';
import type { AgentSessionRegistry } from '../services/agent-session.registry';
import type { RunNoticeWriter } from '../services/run-notice.writer';
import { ThreadInboxService } from '../services/thread-inbox.service';

export interface RecordedNotice {
  runId: string;
  message: string;
  caption: string;
}

export interface RecordedNote {
  key: string;
  prompt: string;
}

/** A `ThreadInboxService` over an in-memory database, with the notices and owed notes it made. */
export async function threadInboxDb() {
  const orm = await MikroORM.init(
    defineConfig({
      ...GENIRO_ORM_RUNTIME,
      dbName: ':memory:',
      entities: [ThreadMessage, Run],
      allowGlobalContext: true,
      namingStrategy: UnderscoreNamingStrategy,
      discovery: { checkDuplicateFieldNames: false },
      schemaGenerator: mikroOrmConfig.schemaGenerator,
    }),
  );
  await orm.schema.update({ safe: true });
  const em = orm.em;
  const bus = new AgentEventBus();
  const changed: string[] = [];
  bus
    .allThreadMessageChanges()
    .subscribe((change) => changed.push(change.runId));
  const notices: RecordedNotice[] = [];
  const notes: RecordedNote[] = [];
  const recordingNotices = {
    warn: async (runId: string, message: string, caption: string) => {
      notices.push({ runId, message, caption });
    },
  } as unknown as RunNoticeWriter;
  const recordingSessions = {
    oweKeyNote: (key: string, prompt: string) => {
      notes.push({ key, prompt });
      return true;
    },
  } as unknown as AgentSessionRegistry;
  const service = new ThreadInboxService(
    em,
    new ThreadMessageDao(em),
    new RunDao(em),
    bus,
    recordingSessions,
    recordingNotices,
  );
  const seedRun = async (
    id: string,
    extra: Partial<Run> = {},
  ): Promise<void> => {
    const fork = em.fork();
    fork.persist(
      Object.assign(new Run(), {
        id,
        status: 'running',
        title: id,
        ...extra,
      } as Run),
    );
    await fork.flush();
  };
  const seedMessage = async (
    extra: Partial<ThreadMessage> = {},
  ): Promise<ThreadMessage> => {
    const fork = em.fork();
    const row = Object.assign(new ThreadMessage(), {
      fromRunId: 'sender',
      fromTitle: 'Sender',
      fromMember: null,
      fromSessionKey: 'sender',
      toRunId: 'target',
      text: 'hello',
      wake: true,
      ...extra,
    } as ThreadMessage);
    fork.persist(row);
    await fork.flush();
    return row;
  };
  const rowsTo = (runId: string): Promise<ThreadMessage[]> =>
    em
      .fork()
      .find(
        ThreadMessage,
        { toRunId: runId },
        { orderBy: { createdAt: 'asc', id: 'asc' } },
      );
  return {
    orm,
    em,
    bus,
    service,
    changed,
    notices,
    notes,
    seedRun,
    seedMessage,
    rowsTo,
  };
}
