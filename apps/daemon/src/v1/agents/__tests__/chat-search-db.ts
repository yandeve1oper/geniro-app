import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import { ChatSearchIndexDao } from '../dao/chat-search-index.dao';
import { ChatTextIndexService } from '../services/chat-text-index.service';

const AT = new Date('2026-01-01T00:00:00Z');

/**
 * An in-memory database brought up the way `main.ts` brings the real one up:
 * the additive schema sync, then the chat text index. The sync's table filter
 * is the real config's, which the boot-twice case depends on.
 */
export async function chatSearchDb(): Promise<{
  orm: MikroORM;
  dao: () => ChatSearchIndexDao;
  ensureIndex: () => Promise<void>;
  run: (id: string, extra?: Partial<Run>) => Promise<void>;
  item: (id: string, extra?: Partial<Item>) => Promise<Item>;
}> {
  const orm = await MikroORM.init(
    defineConfig({
      ...GENIRO_ORM_RUNTIME,
      dbName: ':memory:',
      entities: [Run, Item],
      allowGlobalContext: true,
      namingStrategy: UnderscoreNamingStrategy,
      discovery: { checkDuplicateFieldNames: false },
      schemaGenerator: mikroOrmConfig.schemaGenerator,
    }),
  );
  await orm.schema.update({ safe: true });
  const dao = () => new ChatSearchIndexDao(orm.em.fork());
  return {
    orm,
    dao,
    ensureIndex: () => new ChatTextIndexService(dao()).ensure(),
    async run(id, extra = {}) {
      const em = orm.em.fork();
      em.persist(
        em.create(Run, {
          id,
          status: 'completed',
          title: `title ${id}`,
          cwd: '/project',
          createdAt: AT,
          updatedAt: AT,
          ...extra,
        }),
      );
      await em.flush();
    },
    async item(id, extra = {}) {
      const em = orm.em.fork();
      const row = em.create(Item, {
        id,
        runId: 'run-a',
        seq: 1,
        kind: 'message',
        role: 'user',
        payload: JSON.stringify({ text: 'hello' }),
        createdAt: AT,
        updatedAt: AT,
        ...extra,
      });
      em.persist(row);
      await em.flush();
      return row;
    },
  };
}

/** A message payload, as the persist seam writes one. */
export function said(text: string): string {
  return JSON.stringify({ text });
}
