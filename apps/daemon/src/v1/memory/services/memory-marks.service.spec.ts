import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunDao } from '../../agents/dao/run.dao';
import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import { memoryFence } from '../../mcp/tools/memory-mcp-tool';
import { memoryReadResultText } from '../../mcp/tools/memory-read/memory-read.reader';
import type { RunPlace } from '../../projects/projects.types';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import { memoryDb } from '../__tests__/memory-db';
import { Memory } from '../entity/memory.entity';
import { MemoryMark } from '../entity/memory-mark.entity';
import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryActor,
  type MemoryEntry,
  type MemoryFeedbackOutcome,
  type MemoryFeedbackVerdict,
  type MemoryLessonSource,
  type MemorySaveOutcome,
  type MemoryTextDatabase,
  type MemoryUserStatus,
} from '../memory.types';

const NONE: RunPlace = { projectId: null, teamSlug: null };
const FACTS = { taskId: null, cwd: '/repo/app' };
const USER: MemoryActor = { kind: 'user' };
const LESSON: Extract<MemoryActor, { kind: 'lesson' }> = {
  kind: 'lesson',
  runId: 'refl-1',
  agentKind: 'claude',
  model: 'opus',
};
const SOURCE: MemoryLessonSource = { sourceRunId: 'src-1', proposalId: 'lp-1' };

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 1, 9, 0, 0);
const at = (days: number) => new Date(START + days * DAY);

const agent = (runId: string): MemoryActor => ({
  kind: 'agent',
  runId,
  agentKind: 'claude',
  model: 'opus',
});

function entryOf(outcome: MemorySaveOutcome): MemoryEntry {
  if (outcome.kind !== 'created' && outcome.kind !== 'updated') {
    throw new Error(`expected a saved entry, got ${JSON.stringify(outcome)}`);
  }
  return outcome.entry;
}

function indexOf(entries: readonly MemoryEntry[]): string {
  return entries
    .map((entry) => `- ${entry.handle} [${entry.type}] ${entry.title} (global)`)
    .join('\n');
}

describe('MemoryMarks through MemoryService', () => {
  let db: Awaited<ReturnType<typeof memoryDb>>;
  let seq: number;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at(0));
    db = await memoryDb();
    db.service.setConfig(DEFAULT_MEMORY_CONFIG);
    seq = 0;
  });

  afterEach(async () => {
    clearSecrets();
    vi.useRealTimers();
    await db.orm.close();
  });

  function setNow(when: Date): void {
    vi.setSystemTime(when);
  }

  async function userEntry(title: string): Promise<MemoryEntry> {
    return entryOf(await db.service.save(USER, { title, body: 'x' }, NONE));
  }

  async function agentEntry(title: string): Promise<MemoryEntry> {
    return entryOf(
      await db.service.save(agent('writer'), { title, body: 'x' }, NONE),
    );
  }

  async function thread(
    id: string,
    opts: {
      title?: string;
      index?: readonly MemoryEntry[];
      analysisPurpose?: 'lessons';
    } = {},
  ): Promise<void> {
    await new RunDao(db.em.fork()).create({
      id,
      status: 'completed',
      teamId: null,
    });
    await db.em.fork().nativeUpdate(
      Run,
      { id },
      {
        title: opts.title ?? id,
        memoryIndex: opts.index ? indexOf(opts.index) : null,
        analysisPurpose: opts.analysisPurpose ?? null,
      },
    );
  }

  async function readBy(
    runId: string,
    returned: readonly MemoryEntry[],
  ): Promise<void> {
    const id = `toolu_${seq}`;
    const handles = returned.map((entry) => entry.handle);
    await row(runId, 'tool_call', {
      id,
      name: `mcp__geniro-${runId.slice(0, 8)}__memory_read`,
      input: { ids: handles },
    });
    await row(runId, 'tool_result', {
      id,
      name: null,
      result: [
        {
          type: 'text',
          text: memoryReadResultText([...returned], [], memoryFence()),
        },
      ],
      isError: false,
    });
  }

  async function row(
    runId: string,
    kind: 'tool_call' | 'tool_result',
    payload: Record<string, unknown>,
  ): Promise<void> {
    const em = db.em.fork();
    em.persist(
      em.create(Item, {
        runId,
        seq: seq++,
        kind,
        role: 'assistant',
        memberId: null,
        payload: JSON.stringify(payload),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    await em.flush();
  }

  function mark(
    runId: string,
    entry: MemoryEntry,
    verdict: MemoryFeedbackVerdict,
    reason = `${runId} says ${verdict}`,
    memberId: string | null = null,
  ): Promise<MemoryFeedbackOutcome> {
    return db.service.feedback(
      agent(runId),
      memberId,
      entry.handle,
      verdict,
      reason,
      NONE,
    );
  }

  async function marksOf(memoryId: string): Promise<MemoryMark[]> {
    return db.em.fork().find(MemoryMark, { memoryId });
  }

  async function rowOf(id: string): Promise<Memory> {
    return db.em.fork().findOneOrFail(Memory, { id });
  }

  async function tombstoneOf(id: string) {
    return db.em
      .fork()
      .getKysely<MemoryTextDatabase>()
      .selectFrom('memories')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  async function setStatusOf(id: string, status: MemoryUserStatus) {
    return db.service.setStatus(USER, id, status);
  }

  function markedOf(outcome: MemoryFeedbackOutcome) {
    if (outcome.kind !== 'marked') {
      throw new Error(`expected a mark, got ${JSON.stringify(outcome)}`);
    }
    return outcome;
  }

  it('forgets an entry marked not useful by 3 threads', async () => {
    const entry = await agentEntry('Pin the node version');
    await thread('t1', { title: 'Fix the install', index: [entry] });
    await thread('t2', { title: 'Retry the build', index: [entry] });
    await thread('t3', { title: 'Clean the cache', index: [entry] });

    setNow(at(0));
    expect(
      markedOf(await mark('t1', entry, 'not_useful', 'the flag was renamed'))
        .forgotten,
    ).toBe(false);
    setNow(new Date(at(0).getTime() + 60_000));
    expect(
      markedOf(await mark('t2', entry, 'not_useful', 'the cache path moved'))
        .forgotten,
    ).toBe(false);
    setNow(new Date(at(0).getTime() + 120_000));
    expect(
      markedOf(await mark('t3', entry, 'not_useful', 'the old tag is gone'))
        .forgotten,
    ).toBe(true);

    const row = await rowOf(entry.id);
    expect(row.status).toBe('forgotten');
    expect(row.forgetBatchId).toMatch(/^marks-/);
    expect(row.forgetReason).toBe(
      '3 threads marked it not useful: “Fix the install” — the flag was renamed; “Retry the build” — the cache path moved; “Clean the cache” — the old tag is gone',
    );
  });

  it('forgets a user-written entry the same way and names the marks in the batch reason', async () => {
    const entry = await userEntry('Use pnpm');
    await thread('t1', { title: 'Install deps', index: [entry] });
    await thread('t2', { title: 'Run the tests', index: [entry] });
    await thread('t3', { title: 'Tag a release', index: [entry] });

    await mark('t1', entry, 'not_useful', 'npm works here too');
    setNow(new Date(at(0).getTime() + 60_000));
    await mark('t2', entry, 'misleading', 'the lockfile is npm');
    setNow(new Date(at(0).getTime() + 120_000));
    const last = markedOf(
      await mark('t3', entry, 'not_useful', 'the repo has no pnpm'),
    );

    expect(last.forgotten).toBe(true);
    const row = await rowOf(entry.id);
    expect(row.sourceActor).toBe('user');
    expect(row.status).toBe('forgotten');
    expect(row.forgetBatchId).toMatch(/^marks-/);
    expect(row.forgetReason).toBe(
      '3 threads marked it not useful: “Install deps” — npm works here too; “Run the tests” — the lockfile is npm; “Tag a release” — the repo has no pnpm',
    );
  });

  it('keeps an entry marked by 3 members of one team run', async () => {
    const entry = await userEntry('Ship drafts');
    await thread('team-run', { title: 'Team run', index: [entry] });

    for (const member of ['member-a', 'member-b', 'member-c']) {
      expect(
        markedOf(
          await mark(
            'team-run',
            entry,
            'not_useful',
            `${member} saw a stale flag`,
            member,
          ),
        ).forgotten,
      ).toBe(false);
    }

    expect((await rowOf(entry.id)).status).toBe('active');
    const tallies = await db.marks.tallies(
      [entry.id],
      new Date(),
      db.em.fork(),
    );
    expect(tallies.get(entry.id)).toMatchObject({
      helped: 0,
      notUseful: 1,
    });
  });

  it('needs one more not-useful thread for each helped one', async () => {
    const entry = await userEntry('Ship drafts');
    for (const id of ['h1', 'h2', 'n1', 'n2', 'n3', 'n4', 'n5']) {
      await thread(id, { index: [entry] });
    }

    await mark('h1', entry, 'helped');
    await mark('h2', entry, 'helped');
    for (const id of ['n1', 'n2', 'n3']) {
      expect(markedOf(await mark(id, entry, 'not_useful')).forgotten).toBe(
        false,
      );
    }
    expect(markedOf(await mark('n4', entry, 'not_useful')).forgotten).toBe(
      false,
    );
    expect((await rowOf(entry.id)).status).toBe('active');

    expect(markedOf(await mark('n5', entry, 'not_useful')).forgotten).toBe(
      true,
    );
    expect((await rowOf(entry.id)).status).toBe('forgotten');
  });

  it('ignores marks older than 90 days', async () => {
    db.service.setConfig({ ...DEFAULT_MEMORY_CONFIG, removeNotUseful: false });
    const stale = await userEntry('Stale fact');
    const recent = await userEntry('Recent fact');
    for (const id of ['s1', 's2', 's3']) {
      await thread(id, { index: [stale] });
    }
    for (const id of ['r1', 'r2', 'r3']) {
      await thread(id, { index: [recent] });
    }
    setNow(at(0));
    for (const id of ['s1', 's2', 's3']) {
      await mark(id, stale, 'not_useful');
    }
    setNow(at(60));
    for (const id of ['r1', 'r2', 'r3']) {
      await mark(id, recent, 'not_useful');
    }
    db.service.setConfig(DEFAULT_MEMORY_CONFIG);

    const swept = await db.service.sweepMarks(at(91));

    expect(swept).toMatchObject({ forgotten: 1 });
    expect((await rowOf(stale.id)).status).toBe('active');
    expect((await rowOf(recent.id)).status).toBe('forgotten');
  });

  it('purges an entry forgotten by marks after 30 days, not before', async () => {
    const entry = await userEntry('Stale tag');
    for (const id of ['t1', 't2', 't3']) {
      await thread(id, { index: [entry] });
      await mark(id, entry, 'not_useful');
    }
    expect((await rowOf(entry.id)).status).toBe('forgotten');

    expect(await db.service.sweepMarks(at(29))).toMatchObject({ purged: 0 });
    expect(await tombstoneOf(entry.id)).toMatchObject({
      title: 'Stale tag',
      deleted_at: null,
    });

    expect(await db.service.sweepMarks(at(31))).toMatchObject({ purged: 1 });
    expect(await tombstoneOf(entry.id)).toMatchObject({ title: '' });
    expect((await tombstoneOf(entry.id)).deleted_at).not.toBeNull();
  });

  it('deletes an entry’s marks with its text when it is purged', async () => {
    const entry = await userEntry('Stale branch name');
    for (const id of ['t1', 't2', 't3']) {
      await thread(id, { index: [entry] });
      await mark(id, entry, 'not_useful', `${id}: the branch was renamed`);
    }
    expect(await marksOf(entry.id)).toHaveLength(3);

    await db.service.sweepMarks(at(31));

    expect((await tombstoneOf(entry.id)).deleted_at).not.toBeNull();
    expect(await marksOf(entry.id)).toEqual([]);
  });

  it('lets a reflection’s newer broken mark take its thread’s vote and cast none', async () => {
    const entry = await userEntry('Run the linter first');
    for (const id of ['t1', 't2', 't3']) {
      await thread(id, { index: [entry] });
    }
    await mark('t1', entry, 'not_useful', 'did not apply');
    await mark('t2', entry, 'not_useful', 'did not apply either');
    setNow(new Date(at(0).getTime() + 60_000));
    await db.service.markByReflection(LESSON, 't1', [
      {
        memoryId: entry.id,
        handle: entry.handle,
        verdict: 'broken',
        reason: 'the agent skipped the linter the rule asks for',
        evidenceSeq: 4,
      },
    ]);
    setNow(new Date(at(0).getTime() + 120_000));
    await mark('t3', entry, 'misleading', 'it named the wrong script');

    expect((await rowOf(entry.id)).status).toBe('active');
    const [track] = (await db.service.list({ status: 'active' })).tracks;
    expect(track).toMatchObject({ helped: 0, notUseful: 2 });
  });

  it('counts a thread analysis’s mark for the thread it read, replacing that thread’s vote', async () => {
    const entry = await userEntry('Prefer the staging cluster');
    await thread('src', { index: [entry] });
    await thread('an-1', { index: [entry] });
    await db.em
      .fork()
      .nativeUpdate(Run, { id: 'an-1' }, { analysisSourceRunId: 'src' });

    await mark('src', entry, 'not_useful', 'the cluster was retired');
    await db.service.feedback(
      { kind: 'analysis', runId: 'an-1', agentKind: 'claude', model: 'opus' },
      null,
      entry.handle,
      'helped',
      'the analysis found it still right',
      NONE,
    );

    const marks = await marksOf(entry.id);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      threadId: 'src',
      runId: 'an-1',
      verdict: 'helped',
    });
  });

  it('stops counting marks made before a restore', async () => {
    const entry = await userEntry('Use pnpm');
    for (const id of ['t1', 't2', 't3']) {
      await thread(id, { index: [entry] });
      await mark(id, entry, 'not_useful');
    }
    expect((await rowOf(entry.id)).status).toBe('forgotten');

    setNow(at(1));
    await setStatusOf(entry.id, 'active');
    expect((await rowOf(entry.id)).status).toBe('active');

    setNow(at(2));
    for (const id of ['t4', 't5', 't6']) {
      await thread(id, { index: [entry] });
    }
    expect(markedOf(await mark('t4', entry, 'not_useful')).forgotten).toBe(
      false,
    );
    expect(markedOf(await mark('t5', entry, 'not_useful')).forgotten).toBe(
      false,
    );
    expect((await rowOf(entry.id)).status).toBe('active');
    expect(markedOf(await mark('t6', entry, 'not_useful')).forgotten).toBe(
      true,
    );
  });

  it('promotes a lesson helped by 2 threads', async () => {
    const lesson = entryOf(
      await db.service.fileLesson(
        LESSON,
        {
          title: 'Check before retrying',
          body: 'Change the input first.',
          type: 'feedback',
        },
        NONE,
        SOURCE,
      ),
    );
    await thread('l1', { title: 'Retry one' });
    await thread('l2', { title: 'Retry two' });
    await readBy('l1', [lesson]);
    await readBy('l2', [lesson]);
    expect((await db.service.runSnapshot(FACTS)).indexIds).not.toContain(
      lesson.id,
    );

    await mark('l1', lesson, 'helped', 'the input fix worked');
    expect((await rowOf(lesson.id)).promotedAt).toBeNull();
    await mark('l2', lesson, 'helped', 'the input fix worked again');

    expect((await rowOf(lesson.id)).promotedAt).not.toBeNull();
    expect(await db.service.get(lesson.id)).toMatchObject({ indexed: true });
    const snapshot = await db.service.runSnapshot(FACTS);
    expect(snapshot.indexIds).toContain(lesson.id);
    expect(snapshot.memoryIndex).toContain(
      `- ${lesson.handle} [feedback] Check before retrying`,
    );
  });

  it('takes a promoted lesson out on Search only and promotes it again only on two new helped threads', async () => {
    const lesson = entryOf(
      await db.service.fileLesson(
        LESSON,
        {
          title: 'Check before retrying',
          body: 'Change the input first.',
          type: 'feedback',
        },
        NONE,
        SOURCE,
      ),
    );
    for (const id of ['l1', 'l2', 'l3', 'l4']) {
      await thread(id, { title: `Retry ${id}` });
      await readBy(id, [lesson]);
    }
    await mark('l1', lesson, 'helped', 'the input fix worked');
    await mark('l2', lesson, 'helped', 'the input fix worked again');
    expect(await db.service.get(lesson.id)).toMatchObject({ indexed: true });

    setNow(at(1));
    expect(await db.service.setIndexed(USER, lesson.id, false)).toMatchObject({
      kind: 'changed',
      entry: { indexed: false, promotedAt: null },
    });
    expect((await db.service.runSnapshot(FACTS)).indexIds).not.toContain(
      lesson.id,
    );

    setNow(at(2));
    await mark('l3', lesson, 'helped', 'worked a third time');
    expect(await db.service.get(lesson.id)).toMatchObject({
      indexed: false,
      promotedAt: null,
    });

    await mark('l4', lesson, 'helped', 'worked a fourth time');
    expect(await db.service.get(lesson.id)).toMatchObject({ indexed: true });
    expect((await db.service.runSnapshot(FACTS)).indexIds).toContain(lesson.id);
  });

  it('takes a promoted lesson out of the index once an agent rewrites it', async () => {
    const lesson = entryOf(
      await db.service.fileLesson(
        LESSON,
        {
          title: 'Check before retrying',
          body: 'Change the input first.',
          type: 'feedback',
        },
        NONE,
        SOURCE,
      ),
    );
    for (const id of ['l1', 'l2']) {
      await thread(id, { index: [] });
      await readBy(id, [lesson]);
      await mark(id, lesson, 'helped', `${id}: the input fix worked`);
    }
    const promoted = await rowOf(lesson.id);
    expect(promoted.promotedAt).not.toBeNull();

    entryOf(
      await db.service.save(
        agent('writer'),
        {
          handle: lesson.handle,
          rev: promoted.rev,
          title: 'Check the input before retrying',
          body: 'Change it first.',
        },
        NONE,
      ),
    );

    expect((await rowOf(lesson.id)).promotedAt).toBeNull();
    expect((await db.service.runSnapshot(FACTS)).indexIds).not.toContain(
      lesson.id,
    );
  });

  it('expires an auto lesson 90 days after its last helped mark, not after a read', async () => {
    setNow(at(0));
    const lesson = entryOf(
      await db.service.fileLesson(
        LESSON,
        {
          title: 'Check before retrying',
          body: 'Change the input first.',
          type: 'feedback',
        },
        NONE,
        SOURCE,
      ),
    );
    await thread('l1', { title: 'Retry one' });
    setNow(at(9));
    await readBy('l1', [lesson]);
    setNow(at(10));
    await mark('l1', lesson, 'helped');

    setNow(at(95));
    await db.service.read([lesson.handle], NONE);

    expect(await db.service.sweepMarks(at(99))).toMatchObject({ expired: 0 });
    expect((await rowOf(lesson.id)).status).toBe('active');

    const expired = await db.service.sweepMarks(at(101));

    expect(expired).toMatchObject({ expired: 1 });
    const row = await rowOf(lesson.id);
    expect(row.status).toBe('forgotten');
    expect(row.forgetBatchId).toMatch(/^expired-lesson-/);
    expect(row.forgetReason).toBe(
      'An auto lesson no thread marked helped in 90 days',
    );
  });

  it('leaves forgetting and its purge off while removal is switched off, but still expires lessons', async () => {
    const forgotten = await userEntry('Old flag');
    for (const id of ['f1', 'f2', 'f3']) {
      await thread(id, { index: [forgotten] });
      await mark(id, forgotten, 'not_useful');
    }
    expect((await rowOf(forgotten.id)).status).toBe('forgotten');

    db.service.setConfig({ ...DEFAULT_MEMORY_CONFIG, removeNotUseful: false });
    const kept = await userEntry('Use pnpm');
    for (const id of ['u1', 'u2', 'u3']) {
      await thread(id, { index: [kept] });
      await mark(id, kept, 'not_useful');
    }
    expect((await rowOf(kept.id)).status).toBe('active');
    const lesson = entryOf(
      await db.service.fileLesson(
        LESSON,
        {
          title: 'Check before retrying',
          body: 'Change the input first.',
          type: 'feedback',
        },
        NONE,
        SOURCE,
      ),
    );

    expect(await db.service.sweepMarks(at(31))).toMatchObject({
      forgotten: 0,
      expired: 0,
      purged: 0,
    });
    expect((await rowOf(kept.id)).status).toBe('active');

    expect(await db.service.sweepMarks(at(91))).toMatchObject({
      forgotten: 0,
      expired: 1,
    });
    expect((await rowOf(lesson.id)).status).toBe('forgotten');

    expect(await db.service.sweepMarks(at(122))).toMatchObject({ purged: 1 });
    expect(await tombstoneOf(lesson.id)).toMatchObject({ title: '' });
    expect(await tombstoneOf(forgotten.id)).toMatchObject({
      title: 'Old flag',
      deleted_at: null,
    });
  });

  it('refuses a mark from a run that never had the entry in front of it, and writes none', async () => {
    const entry = await userEntry('Use pnpm');
    await thread('blind', { title: 'Blind run' });

    const outcome = await mark('blind', entry, 'helped');

    expect(outcome).toMatchObject({ kind: 'refused', code: 'NOT_SEEN' });
    expect(await db.em.fork().count(MemoryMark, {})).toBe(0);
  });

  it('refuses a mark on a handle no visible entry holds', async () => {
    await thread('t1', { title: 'Any run' });

    const outcome = await db.service.feedback(
      agent('t1'),
      null,
      'm999',
      'helped',
      'looked right',
      NONE,
    );

    expect(outcome).toMatchObject({ kind: 'refused', code: 'NOT_FOUND' });
  });

  it('refuses a mark with no reason or with one over the limit', async () => {
    const entry = await userEntry('Use pnpm');
    await thread('t1', { index: [entry] });

    const empty = await mark('t1', entry, 'helped', '   ');
    const long = await mark('t1', entry, 'helped', 'x'.repeat(201));

    expect(empty).toMatchObject({ kind: 'refused', code: 'REASON_REQUIRED' });
    expect(long).toMatchObject({ kind: 'refused', code: 'TOO_LONG' });
    expect(await db.em.fork().count(MemoryMark, {})).toBe(0);
  });

  it('refuses a reason that carries a registered secret, without echoing it', async () => {
    const secret = 'sk-test-marks-0123456789abcdef';
    registerSecret(secret, 'test');
    const entry = await userEntry('Use pnpm');
    await thread('t1', { index: [entry] });

    const outcome = await mark('t1', entry, 'helped', `key ${secret}`);

    expect(outcome).toMatchObject({ kind: 'refused', code: 'CONTAINS_SECRET' });
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(await db.em.fork().count(MemoryMark, {})).toBe(0);
  });

  it('refuses a mark from a lessons reflection, which only reports what entries did', async () => {
    const entry = await userEntry('Use pnpm');
    await thread('refl-run', {
      title: 'Lessons reflection',
      index: [entry],
      analysisPurpose: 'lessons',
    });

    const outcome = await db.service.feedback(
      {
        kind: 'analysis',
        runId: 'refl-run',
        agentKind: 'claude',
        model: 'opus',
      },
      null,
      entry.handle,
      'helped',
      'the reflection saw it',
      NONE,
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      code: 'REFLECTION_READ_ONLY',
    });
    expect(await db.em.fork().count(MemoryMark, {})).toBe(0);
  });

  it('replaces the same thread’s earlier mark, leaving one row for it', async () => {
    const entry = await userEntry('Use pnpm');
    await thread('t1', { index: [entry] });

    await mark('t1', entry, 'not_useful', 'wrong tool');
    await mark('t1', entry, 'helped', 'turned out right');

    const rows = await db.em.fork().find(MemoryMark, { memoryId: entry.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: 'helped',
      reason: 'turned out right',
    });
  });

  it('tells the lists to read again when removal by marks is switched, and only then', async () => {
    const published: unknown[] = [];
    db.events.allChanges().subscribe((event) => published.push(event));

    db.service.setConfig({ ...DEFAULT_MEMORY_CONFIG, enabled: true });
    expect(published).toEqual([]);

    db.service.setConfig({ ...DEFAULT_MEMORY_CONFIG, removeNotUseful: false });
    expect(published).toEqual([
      expect.objectContaining({ memoryId: null, change: 'bulk' }),
    ]);
  });

  it('a helped mark stamps the entry as used and counts one read', async () => {
    setNow(at(5));
    const entry = await userEntry('Use pnpm');
    await thread('t1', { index: [entry] });

    await mark('t1', entry, 'helped');

    expect((await db.service.get(entry.id))?.lastUsedAt).toBe(
      at(5).toISOString(),
    );
    expect(
      (await db.usageDao.daysOf([entry.id])).map((day) => day.reads),
    ).toEqual([1]);
  });

  it('counts no second read for a helped entry the run already read', async () => {
    setNow(at(5));
    const entry = await userEntry('Use pnpm');
    await thread('t1', { index: [] });
    await readBy('t1', [entry]);

    markedOf(await mark('t1', entry, 'helped'));

    expect((await db.service.get(entry.id))?.lastUsedAt).toBe(
      at(5).toISOString(),
    );
    expect(await db.usageDao.daysOf([entry.id])).toEqual([]);
  });

  it('counts the figures of the track record over every mark and use, past any list cap', async () => {
    const entry = await userEntry('Use pnpm');
    const em = db.em.fork();
    for (let i = 0; i < 120; i += 1) {
      await db.marks.record(
        {
          memoryId: entry.id,
          threadId: `h${i}`,
          runId: `h${i}`,
          memberId: null,
          source: 'agent',
          verdict: 'helped',
          reason: 'used it',
          evidenceSeq: null,
          agentKind: 'claude',
          model: null,
        },
        at(0),
        em,
      );
    }
    const days = Array.from({ length: 120 }, (_, i) =>
      new Date(Date.UTC(2026, 0, 1) + i * DAY).toISOString().slice(0, 10),
    );
    await db.usageDao.add(
      days.map((day) => ({
        memoryId: entry.id,
        day,
        reads: 1,
        searchHits: 0,
        indexShows: 0,
      })),
    );

    const listed = await db.service.list({});

    expect(listed.tracks.find((track) => track.memoryId === entry.id)).toEqual({
      memoryId: entry.id,
      indexShows: 0,
      reads: 120,
      helped: 120,
      notUseful: 0,
    });
  });
});
