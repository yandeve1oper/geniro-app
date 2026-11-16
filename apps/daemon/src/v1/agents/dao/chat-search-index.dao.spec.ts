import type { MikroORM } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHAT_TEXT_TRIGGERS,
  CHAT_TEXT_VERSION,
  retiredTriggerDrops,
} from '../../../db/chat-text-index.ddl';
import { Item } from '../../runs/entity/item.entity';
import { chatSearchDb, said } from '../__tests__/chat-search-db';
import { GlobalChatSearchQuerySchema } from '../chat.types';
import { chatTextMatchQuery } from '../utils/chat-text-query';

const RUN_A = '00000000-0000-4000-8000-00000000000a';
const RUN_B = '00000000-0000-4000-8000-00000000000b';

describe('ChatSearchIndexDao (in-memory sqlite)', () => {
  let db: Awaited<ReturnType<typeof chatSearchDb>>;
  let orm: MikroORM;

  beforeEach(async () => {
    db = await chatSearchDb();
    orm = db.orm;
  });

  afterEach(async () => {
    await orm.close(true);
  });

  async function ids(query: string, extra: object = {}): Promise<string[]> {
    const options = GlobalChatSearchQuerySchema.parse({ query, ...extra });
    const matchQuery = chatTextMatchQuery(query);
    if (matchQuery === null) {
      return [];
    }
    const rows = await db.dao().match(options, matchQuery, 50);
    return rows.map((row) => row.id).sort();
  }

  it('fills the index from history at first boot — messages and reasoning only, with valid text', async () => {
    await db.run(RUN_A);
    await db.item('msg', { runId: RUN_A, payload: said('pricing discount') });
    await db.item('think', {
      runId: RUN_A,
      kind: 'reasoning',
      role: null,
      payload: said('discount reasoning'),
    });
    await db.item('tool', {
      runId: RUN_A,
      kind: 'tool_result',
      payload: said('discount in a tool result'),
    });
    await db.item('broken', { runId: RUN_A, payload: '{not json discount' });
    await db.item('textless', {
      runId: RUN_A,
      payload: JSON.stringify({ text: 42 }),
    });

    await db.ensureIndex();

    expect(await ids('discount')).toEqual(['msg', 'think']);
    expect(await db.dao().presentTriggers()).toEqual(
      new Set(CHAT_TEXT_TRIGGERS.map((trigger) => trigger.name)),
    );
  });

  it('keeps the index current inside every write — insert, edit and delete', async () => {
    await db.run(RUN_A);
    await db.ensureIndex();

    const row = await db.item('live', {
      runId: RUN_A,
      payload: said('first wording'),
    });
    expect(await ids('first')).toEqual(['live']);

    const em = orm.em.fork();
    await em.nativeUpdate(Item, { id: row.id }, { payload: said('second') });
    expect(await ids('first')).toEqual([]);
    expect(await ids('second')).toEqual(['live']);

    // The search-text projection is written by its own UPDATE; the index
    // still answers after it.
    await em.nativeUpdate(Item, { id: row.id }, { searchText: 'whatever' });
    expect(await ids('second')).toEqual(['live']);

    await em.nativeDelete(Item, { id: row.id });
    expect(await ids('second')).toEqual([]);
  });

  it('rewrites nothing in the index for an update that touches neither the kind nor the payload', async () => {
    await db.run(RUN_A);
    await db.ensureIndex();
    await db.item('live', { runId: RUN_A, payload: said('kept wording') });
    const em = orm.em.fork();
    // Every row any statement wrote on this connection, triggers included.
    const writes = async () =>
      (
        await em
          .getKysely({ convertValues: false })
          .selectNoFrom((eb) => eb.fn<number>('total_changes', []).as('n'))
          .executeTakeFirstOrThrow()
      ).n;

    const before = await writes();
    await em.nativeUpdate(Item, { id: 'live' }, { searchText: 'whatever' });
    expect((await writes()) - before).toBe(1);
    expect(await ids('kept')).toEqual(['live']);
  });

  it('indexes only words rows once the triggers run — a tool row stays out, and a row that stops being one leaves', async () => {
    await db.run(RUN_A);
    await db.ensureIndex();
    await db.item('tool', {
      runId: RUN_A,
      kind: 'tool_result',
      payload: said('secret tool output'),
    });
    await db.item('msg', {
      runId: RUN_A,
      seq: 2,
      payload: said('plain output'),
    });
    expect(await ids('output')).toEqual(['msg']);

    await orm.em
      .fork()
      .nativeUpdate(Item, { id: 'msg' }, { kind: 'tool_call' });
    expect(await ids('output')).toEqual([]);
  });

  it('never fails an item write over a payload it cannot read', async () => {
    await db.run(RUN_A);
    await db.ensureIndex();
    await expect(
      db.item('broken', { runId: RUN_A, payload: '{"text": "unterminated' }),
    ).resolves.toBeDefined();
    expect(await ids('unterminated')).toEqual([]);
  });

  it('finds a word by its beginning, case- and diacritic-insensitively', async () => {
    await db.run(RUN_A);
    await db.item('ru', {
      runId: RUN_A,
      payload: said('Проверка платежей прошла'),
    });
    await db.item('en', {
      runId: RUN_A,
      payload: said('Idempotency key for Café orders'),
    });
    await db.ensureIndex();

    expect(await ids('платеж')).toEqual(['ru']);
    expect(await ids('IDEMPOT')).toEqual(['en']);
    expect(await ids('cafe')).toEqual(['en']);
    expect(await ids('платеж OR idempot')).toEqual(['en', 'ru']);
    // Every word must match.
    expect(await ids('платеж idempot')).toEqual([]);
  });

  it('keeps every word required around an OR group', async () => {
    await db.run(RUN_A);
    const texts = ['foo bar', 'baz', 'foo baz', 'bar'];
    for (const [index, text] of texts.entries()) {
      await db.item(`t${index}`, {
        runId: RUN_A,
        seq: index + 1,
        payload: said(text),
      });
    }
    await db.ensureIndex();
    expect(await ids('foo bar OR baz')).toEqual(['t0', 't2']);
  });

  it('applies run, folder, archive, builder, analysis and soft-delete scopes before the limit', async () => {
    await db.run(RUN_A, { cwd: '/one' });
    await db.run(RUN_B, { cwd: '/two', archivedAt: new Date() });
    await db.run('gone', { deletedAt: new Date() });
    await db.run('builder', { editsTeamSlug: 'dev-team' });
    // An analysis quotes its source, so it would answer the same words.
    await db.run('analysis', { analysisSourceRunId: RUN_A });
    await db.run('wf-analysis', { analysisTeamSlug: 'dev-team' });
    await db.item('a', { runId: RUN_A, payload: said('shared word') });
    await db.item('b', { runId: RUN_B, payload: said('shared word') });
    await db.item('c', { runId: 'gone', payload: said('shared word') });
    await db.item('e', { runId: 'builder', payload: said('shared word') });
    await db.item('f', { runId: 'analysis', payload: said('shared word') });
    await db.item('g', { runId: 'wf-analysis', payload: said('shared word') });
    await db.item('d', {
      runId: RUN_A,
      seq: 2,
      payload: said('shared word'),
      deletedAt: new Date(),
    });
    await db.ensureIndex();

    expect(await ids('shared')).toEqual(['a', 'b']);
    expect(await ids('shared', { includeArchived: false })).toEqual(['a']);
    expect(await ids('shared', { runId: RUN_B })).toEqual(['b']);
    expect(await ids('shared', { cwd: '/one' })).toEqual(['a']);
  });

  it('answers hostile query text without an FTS5 syntax error', async () => {
    await db.run(RUN_A);
    await db.item('a', { runId: RUN_A, payload: said('a "quoted" thing') });
    await db.ensureIndex();
    const answers: Record<string, string[]> = {};
    for (const query of [
      '"quoted"',
      'NEAR(a b)',
      'col:quoted',
      'a AND OR NOT',
      'thing*',
      '-quoted',
      '(quoted',
      "o'clock",
      'OR OR quoted OR',
      '^quoted',
      'a\u0000thing',
    ]) {
      answers[query] = await ids(query);
    }
    expect(answers).toEqual({
      '"quoted"': ['a'],
      'NEAR(a b)': [],
      'col:quoted': [],
      'a AND OR NOT': [],
      'thing*': ['a'],
      '-quoted': ['a'],
      '(quoted': ['a'],
      "o'clock": [],
      'OR OR quoted OR': ['a'],
      '^quoted': ['a'],
      'a\u0000thing': ['a'],
    });
  });

  it('survives the boot-time schema sync, and rebuilds when a trigger is gone', async () => {
    await db.run(RUN_A);
    await db.item('a', { runId: RUN_A, payload: said('kept across boots') });
    await db.ensureIndex();

    // The next launch: schema sync first, then the index check.
    await orm.schema.update({ safe: true });
    expect((await db.dao().presentTriggers()).size).toBe(
      CHAT_TEXT_TRIGGERS.length,
    );
    await db.ensureIndex();
    expect(await ids('kept')).toEqual(['a']);
    await db.item('b', { runId: RUN_A, seq: 2, payload: said('kept too') });
    expect(await ids('kept')).toEqual(['a', 'b']);

    // A table rebuild takes its triggers with it; a row written meanwhile is
    // not indexed until the next boot notices and rebuilds.
    await orm.em
      .getConnection()
      .execute(retiredTriggerDrops(CHAT_TEXT_VERSION + 1)[0]!, [], 'run');
    await db.item('c', { runId: RUN_A, seq: 3, payload: said('kept late') });
    expect(await ids('late')).toEqual([]);
    await db.ensureIndex();
    expect(await ids('kept')).toEqual(['a', 'b', 'c']);
  });

  it('still writes a message when two versions’ insert triggers are installed together', async () => {
    await db.run(RUN_A);
    await db.ensureIndex();
    // An older build started on a profile a newer one already upgraded.
    const insert = CHAT_TEXT_TRIGGERS[0]!;
    await orm.em
      .getConnection()
      .execute(
        insert.sql.replace(insert.name, `${insert.name}_other`),
        [],
        'run',
      );
    await expect(
      db.item('twice', { runId: RUN_A, payload: said('written twice') }),
    ).resolves.toBeDefined();
    expect(await ids('twice')).toEqual(['twice']);
  });

  it('reads a run for a context read only where a search could have found it', async () => {
    await db.run(RUN_A);
    await db.run('builder', { editsTeamSlug: 'dev-team' });
    await db.run('analysis', { analysisSourceRunId: RUN_A });
    await db.run('wf-analysis', { analysisTeamSlug: 'dev-team' });
    const dao = db.dao();

    expect((await dao.run(RUN_A))?.id).toBe(RUN_A);
    expect(await dao.run('builder')).toBeUndefined();
    expect(await dao.run('analysis')).toBeUndefined();
    expect(await dao.run('wf-analysis')).toBeUndefined();
  });

  it('leaves a run being deleted out of the search and out of a context read', async () => {
    const RETIRING = '00000000-0000-4000-8000-00000000000c';
    await db.run(RUN_A);
    await db.run(RETIRING, { pendingDeleteAt: new Date() });
    await db.item('kept', { runId: RUN_A, payload: said('retiring wording') });
    await db.item('hidden', {
      runId: RETIRING,
      payload: said('retiring wording'),
    });
    await db.ensureIndex();

    expect(await ids('retiring')).toEqual(['kept']);
    expect(await ids('retiring', { runId: RETIRING })).toEqual([]);
    expect((await db.dao().run(RUN_A))?.id).toBe(RUN_A);
    expect(await db.dao().run(RETIRING)).toBeUndefined();
  });

  it('reads neighbours nearest first, words only, breaking a seq tie by id', async () => {
    await db.run(RUN_A);
    await db.item('m1', { runId: RUN_A, seq: 1 });
    await db.item('t2', { runId: RUN_A, seq: 2, kind: 'tool_call' });
    await db.item('m3a', { runId: RUN_A, seq: 3 });
    await db.item('m3b', { runId: RUN_A, seq: 3 });
    await db.item('m4', { runId: RUN_A, seq: 4, kind: 'reasoning' });
    await db.item('other', { runId: RUN_B, seq: 2 });
    const dao = db.dao();
    const target = await dao.row(RUN_A, 'm3a');
    expect(target?.id).toBe('m3a');

    const before = await dao.neighbours(target!, 'before', 5);
    const after = await dao.neighbours(target!, 'after', 5);
    expect(before.map((row) => row.id)).toEqual(['m1']);
    expect(after.map((row) => row.id)).toEqual(['m3b', 'm4']);
    expect(
      (await dao.neighbours(target!, 'after', 1)).map((row) => row.id),
    ).toEqual(['m3b']);
    expect(await dao.neighbours(target!, 'before', 0)).toEqual([]);
  });
});
