import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MEMORY_TEXT_TRIGGERS,
  MEMORY_TEXT_VERSION,
  retiredMemoryTriggerDrops,
} from '../../../db/memory-text-index.ddl';
import { RunDao } from '../../agents/dao/run.dao';
import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import type { RunPlace } from '../../projects/projects.types';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import { Task } from '../../tasks/entity/task.entity';
import { make, memoryDb } from '../__tests__/memory-db';
import { MemoryDao } from '../dao/memory.dao';
import { MemoryReviewFindingDao } from '../dao/memory-review-finding.dao';
import { Memory } from '../entity/memory.entity';
import {
  DEFAULT_MEMORY_CONFIG,
  MEMORY_INDEX_PREFACE,
  type MemoryActor,
  type MemoryChangedEvent,
  type MemoryMergeRequest,
  type MemorySaveOutcome,
  type MemoryStatusOutcome,
  type MemoryTextDatabase,
} from '../memory.types';
import { importedTextHash } from '../utils/memory-text';
import type { MemoryService } from './memory.service';
import { MemoryReviewService } from './memory-review.service';

const NONE: RunPlace = { projectId: null, teamSlug: null };

function inProject(projectId: string): RunPlace {
  return { projectId, teamSlug: null };
}

const USER: MemoryActor = { kind: 'user' };

const AGENT: MemoryActor = {
  kind: 'agent',
  runId: 'run-a',
  agentKind: 'claude',
  model: 'opus',
};

function savedOf(outcome: MemorySaveOutcome | MemoryStatusOutcome) {
  if (
    outcome.kind !== 'created' &&
    outcome.kind !== 'updated' &&
    outcome.kind !== 'changed'
  ) {
    throw new Error(`expected a saved entry, got ${JSON.stringify(outcome)}`);
  }
  return outcome.entry;
}

function created(outcome: MemorySaveOutcome) {
  if (outcome.kind !== 'created' && outcome.kind !== 'updated') {
    throw new Error(`expected a saved entry, got ${JSON.stringify(outcome)}`);
  }
  return outcome.entry;
}

describe('MemoryService', () => {
  let db: Awaited<ReturnType<typeof memoryDb>>;

  beforeEach(async () => {
    db = await memoryDb();
  });

  afterEach(async () => {
    clearSecrets();
    await db.orm.close();
  });

  it('saves an entry with the next handle and the writer as its provenance', async () => {
    const published: MemoryChangedEvent[] = [];
    db.events.allChanges().subscribe((event) => published.push(event));

    const first = created(
      await db.service.save(
        AGENT,
        { title: 'Use pnpm', body: 'Never npm in this repo.' },
        NONE,
      ),
    );
    const second = created(
      await db.service.save(
        AGENT,
        { title: 'Daemon binds loopback', body: '127.0.0.1 only.' },
        NONE,
      ),
    );

    expect(first.handle).toBe('m1');
    expect(second.handle).toBe('m2');
    expect(first.status).toBe('active');
    expect(first.source).toEqual({
      actor: 'agent',
      agentKind: 'claude',
      model: 'opus',
      runId: 'run-a',
      importedFrom: null,
    });
    expect(published).toEqual([
      {
        memoryId: first.id,
        change: 'created',
        status: 'active',
        projectId: null,
        teamSlug: null,
      },
      {
        memoryId: second.id,
        change: 'created',
        status: 'active',
        projectId: null,
        teamSlug: null,
      },
    ]);
  });

  it('refuses a body over 8192 bytes and takes one of exactly 8192', async () => {
    const outcome = await db.service.save(
      AGENT,
      { title: 'Long', body: 'я'.repeat(4097) },
      NONE,
    );
    const atLimit = await db.service.save(
      AGENT,
      { title: 'Full', body: 'я'.repeat(4096) },
      NONE,
    );

    expect(outcome).toMatchObject({ kind: 'refused', code: 'INVALID_ENTRY' });
    expect(atLimit.kind).toBe('created');
  });

  it('refuses a title carrying an invisible character', async () => {
    const outcome = await db.service.save(
      AGENT,
      { title: 'Use\u202e pnpm', body: 'x' },
      NONE,
    );

    expect(outcome).toMatchObject({ kind: 'refused', code: 'INVALID_ENTRY' });
  });

  it('refuses a multi-line title', async () => {
    const outcome = await db.service.save(
      AGENT,
      { title: 'one\ntwo', body: 'body' },
      NONE,
    );

    expect(outcome).toMatchObject({ kind: 'refused', code: 'INVALID_ENTRY' });
  });

  it('refuses a body containing a registered secret without echoing it', async () => {
    const secret = 'sk-test-0123456789abcdef';
    registerSecret(secret, 'test');

    const outcome = await db.service.save(
      AGENT,
      { title: 'API key', body: `the key is ${secret}` },
      NONE,
    );

    expect(outcome).toMatchObject({ kind: 'refused', code: 'CONTAINS_SECRET' });
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(await db.em.fork().count(Memory, {})).toBe(0);
  });

  it('refuses a near-duplicate title in the same scope and accepts it with notDuplicateOf', async () => {
    const original = created(
      await db.service.save(
        AGENT,
        { title: 'Always run pnpm full-check', body: 'before finishing' },
        NONE,
      ),
    );

    const duplicate = await db.service.save(
      AGENT,
      { title: 'Run pnpm full-check always', body: 'again' },
      NONE,
    );
    expect(duplicate.kind).toBe('near_duplicate');
    expect(
      duplicate.kind === 'near_duplicate' &&
        duplicate.candidates.map((hit) => hit.handle),
    ).toEqual([original.handle]);

    const vouched = await db.service.save(
      AGENT,
      {
        title: 'Run pnpm full-check always',
        body: 'again',
        notDuplicateOf: [original.handle],
      },
      NONE,
    );
    expect(vouched.kind).toBe('created');
  });

  it('does not call an entry in another scope a duplicate', async () => {
    await db.service.save(
      AGENT,
      { title: 'Always run pnpm full-check', body: 'global' },
      NONE,
    );

    const outcome = await db.service.save(
      AGENT,
      { title: 'Always run pnpm full-check', body: 'project' },
      inProject('project-1'),
    );

    expect(outcome.kind).toBe('created');
  });

  it('refuses a stale rev and returns the current entry', async () => {
    const entry = created(
      await db.service.save(AGENT, { title: 'Port', body: '47615' }, NONE),
    );
    const updated = created(
      await db.service.save(
        AGENT,
        { handle: entry.handle, rev: entry.rev, title: 'Port', body: '47616' },
        NONE,
      ),
    );
    expect(updated.rev).toBe(entry.rev + 1);

    const stale = await db.service.save(
      AGENT,
      { handle: entry.handle, rev: entry.rev, title: 'Port', body: '1' },
      NONE,
    );

    expect(stale).toMatchObject({
      kind: 'stale',
      current: { handle: entry.handle, rev: updated.rev, body: '47616' },
    });
  });

  it('lands agent writes as pending when agentWrites is pending', async () => {
    db.service.setConfig({
      enabled: true,
      agentWrites: 'pending',
      nativeMemoryOff: false,
      autoForgetAfterDays: null,
      removeNotUseful: true,
    });

    const agentEntry = created(
      await db.service.save(AGENT, { title: 'Pending', body: 'x' }, NONE),
    );
    const userEntry = created(
      await db.service.save(
        { kind: 'user' },
        { title: 'Mine', body: 'y' },
        NONE,
      ),
    );

    expect(agentEntry.status).toBe('pending');
    expect(userEntry.status).toBe('active');
  });

  describe('while the user reviews agent writes', () => {
    beforeEach(() => {
      db.service.setConfig({
        enabled: true,
        agentWrites: 'pending',
        nativeMemoryOff: false,
        autoForgetAfterDays: null,
        removeNotUseful: true,
      });
    });

    async function approved() {
      return created(
        await db.service.save(
          { kind: 'user' },
          { title: 'Reviewed fact', body: 'kept as written' },
          NONE,
        ),
      );
    }

    it('refuses an agent’s update and forget, leaving the reviewed entry as it was', async () => {
      const entry = await approved();

      const update = await db.service.save(
        AGENT,
        { handle: entry.handle, rev: entry.rev, title: 'x', body: 'y' },
        NONE,
      );
      const forget = await db.service.forget(AGENT, entry.handle, 'no', NONE);

      expect(update).toMatchObject({ kind: 'refused', code: 'UNDER_REVIEW' });
      expect(forget).toMatchObject({ kind: 'refused', code: 'UNDER_REVIEW' });
      const row = await db.em.fork().findOneOrFail(Memory, { id: entry.id });
      expect([row.status, row.body, row.rev]).toEqual([
        'active',
        'kept as written',
        entry.rev,
      ]);
    });

    it('holds an analysis chat’s new entry for review like any agent’s', async () => {
      const entry = created(
        await db.service.save(
          { ...AGENT, kind: 'analysis' },
          { title: 'From analysis', body: 'x' },
          NONE,
        ),
      );

      expect(entry.status).toBe('pending');
      expect(entry.source.actor).toBe('analysis');
    });

    it('names a copy of an entry waiting for review without quoting it, and lets the user past it', async () => {
      await db.service.save(
        AGENT,
        { title: 'Always run pnpm full-check', body: 'unreviewed text' },
        NONE,
      );

      const again = await db.service.save(
        AGENT,
        { title: 'Run pnpm full-check always', body: 'again' },
        NONE,
      );

      expect(again).toEqual({
        kind: 'near_duplicate',
        candidates: [],
        pending: ['m1'],
        updatable: false,
      });

      const vouched = await db.service.save(
        AGENT,
        {
          title: 'Run pnpm full-check always',
          body: 'again',
          notDuplicateOf: ['m1'],
        },
        NONE,
      );
      expect(vouched.kind).toBe('created');

      const byUser = await db.service.save(
        { kind: 'user' },
        { title: 'Always run pnpm full-check', body: 'the user’s own' },
        NONE,
      );
      expect(byUser.kind).toBe('created');
    });
  });

  describe('the scope rule', () => {
    async function seed() {
      const global = created(
        await db.service.save(AGENT, { title: 'Global kiwi', body: 'g' }, NONE),
      );
      const p1 = created(
        await db.service.save(
          AGENT,
          { title: 'Project kiwi', body: 'p' },
          inProject('p1'),
        ),
      );
      const gone = created(
        await db.service.save(AGENT, { title: 'Gone kiwi', body: 'x' }, NONE),
      );
      await db.service.forget(AGENT, gone.handle, 'obsolete', NONE);
      db.service.setConfig({
        enabled: true,
        agentWrites: 'pending',
        nativeMemoryOff: false,
        autoForgetAfterDays: null,
        removeNotUseful: true,
      });
      const waiting = created(
        await db.service.save(
          AGENT,
          { title: 'Waiting kiwi', body: 'w' },
          NONE,
        ),
      );
      db.service.setConfig({
        enabled: true,
        agentWrites: 'active',
        nativeMemoryOff: false,
        autoForgetAfterDays: null,
        removeNotUseful: true,
      });
      return { global, p1, gone, waiting };
    }

    it('shows a run with no project only active global entries, on every read', async () => {
      const { global, p1, gone, waiting } = await seed();

      expect(
        (await db.service.search('kiwi', NONE, 10)).map((h) => h.handle),
      ).toEqual([global.handle]);
      const read = await db.service.read(
        [global.handle, p1.handle, gone.handle],
        NONE,
      );
      expect(read.entries.map((e) => e.handle)).toEqual([global.handle]);
      expect(read.missing).toEqual([p1.handle, gone.handle]);
      expect((await db.service.listVisible(NONE)).map((e) => e.handle)).toEqual(
        [global.handle],
      );
      expect((await db.service.read([waiting.handle], NONE)).missing).toEqual([
        waiting.handle,
      ]);
    });

    it('keeps a run with no project from changing a project’s entry, and its global save from counting that entry a duplicate', async () => {
      const { p1 } = await seed();

      expect(
        await db.service.save(
          AGENT,
          { handle: p1.handle, rev: p1.rev, title: 'x', body: 'y' },
          NONE,
        ),
      ).toMatchObject({ kind: 'refused', code: 'NOT_FOUND' });
      expect(
        await db.service.forget(AGENT, p1.handle, 'no', NONE),
      ).toMatchObject({ kind: 'refused', code: 'NOT_FOUND' });
      expect(
        (
          await db.service.save(
            AGENT,
            { title: 'Project kiwi', body: 'global copy' },
            NONE,
          )
        ).kind,
      ).toBe('created');
    });

    it('lists a project run’s active entries only, global ones included', async () => {
      const { global, p1 } = await seed();

      expect(
        (await db.service.listVisible(inProject('p1')))
          .map((e) => e.handle)
          .sort(),
      ).toEqual([global.handle, p1.handle].sort());
    });

    it('changes exactly the entry a handle names', async () => {
      const first = created(
        await db.service.save(AGENT, { title: 'First', body: 'one' }, NONE),
      );
      const second = created(
        await db.service.save(AGENT, { title: 'Second', body: 'two' }, NONE),
      );

      await db.service.save(
        AGENT,
        {
          handle: second.handle,
          rev: second.rev,
          title: 'Second',
          body: 'changed',
        },
        NONE,
      );
      await db.service.forget(AGENT, second.handle, 'done', NONE);

      const row = await db.em.fork().findOneOrFail(Memory, { id: first.id });
      expect([row.status, row.body, row.rev]).toEqual([
        'active',
        'one',
        first.rev,
      ]);
    });

    it('ranks the stronger match first, and cuts to the limit after ranking', async () => {
      const weak = created(
        await db.service.save(
          AGENT,
          { title: 'Notes', body: 'mentions papaya once' },
          NONE,
        ),
      );
      const strong = created(
        await db.service.save(
          AGENT,
          { title: 'Papaya papaya', body: 'papaya papaya papaya' },
          NONE,
        ),
      );

      expect(
        (await db.service.search('papaya', NONE, 5)).map((h) => h.handle),
      ).toEqual([strong.handle, weak.handle]);
      expect(
        (await db.service.search('papaya', NONE, 1)).map((h) => h.handle),
      ).toEqual([strong.handle]);
    });
  });

  describe('an agent’s reach', () => {
    it('cannot update or forget another project’s entry, a forgotten one, or a pending one', async () => {
      const other = created(
        await db.service.save(
          AGENT,
          { title: 'Other', body: 'p2' },
          inProject('p2'),
        ),
      );
      const gone = created(
        await db.service.save(
          AGENT,
          { title: 'Gone', body: 'g' },
          inProject('p1'),
        ),
      );
      await db.service.forget(AGENT, gone.handle, 'obsolete', inProject('p1'));
      db.service.setConfig({
        enabled: true,
        agentWrites: 'pending',
        nativeMemoryOff: false,
        autoForgetAfterDays: null,
        removeNotUseful: true,
      });
      const waiting = created(
        await db.service.save(
          AGENT,
          { title: 'Waiting', body: 'w' },
          inProject('p1'),
        ),
      );
      db.service.setConfig({
        enabled: true,
        agentWrites: 'active',
        nativeMemoryOff: false,
        autoForgetAfterDays: null,
        removeNotUseful: true,
      });

      for (const entry of [other, gone, waiting]) {
        expect(
          await db.service.save(
            AGENT,
            { handle: entry.handle, rev: entry.rev, title: 'x', body: 'y' },
            inProject('p1'),
          ),
        ).toMatchObject({ kind: 'refused', code: 'NOT_FOUND' });
        expect(
          await db.service.forget(AGENT, entry.handle, 'no', inProject('p1')),
        ).toMatchObject({ kind: 'refused', code: 'NOT_FOUND' });
      }
      const row = await db.em.fork().findOneOrFail(Memory, { id: other.id });
      expect([row.status, row.body]).toEqual(['active', 'p2']);
    });

    it('refuses a project entry from a run with no project', async () => {
      expect(
        await db.service.save(
          AGENT,
          { title: 'x', body: 'y', scope: 'project' },
          NONE,
        ),
      ).toMatchObject({ kind: 'refused', code: 'NO_PROJECT' });
    });

    it('refuses a forget reason that is empty, two lines, or carries a secret', async () => {
      const secret = 'sk-test-reason-0123456789';
      registerSecret(secret, 'test');
      const entry = created(
        await db.service.save(AGENT, { title: 'Fact', body: 'b' }, NONE),
      );

      for (const reason of ['  ', 'one\ntwo', `leaked ${secret}`]) {
        const outcome = await db.service.forget(
          AGENT,
          entry.handle,
          reason,
          NONE,
        );
        expect(outcome.kind).toBe('refused');
      }
      const row = await db.em.fork().findOneOrFail(Memory, { id: entry.id });
      expect(row.status).toBe('active');
    });

    it('keeps the writer’s provenance when another agent forgets the entry', async () => {
      const entry = created(
        await db.service.save(AGENT, { title: 'Fact', body: 'b' }, NONE),
      );

      await db.service.forget(
        { kind: 'agent', runId: 'run-b', agentKind: 'codex', model: null },
        entry.handle,
        'superseded',
        NONE,
      );

      const row = await db.em.fork().findOneOrFail(Memory, { id: entry.id });
      expect([row.status, row.sourceRunId, row.sourceAgentKind]).toEqual([
        'forgotten',
        'run-a',
        'claude',
      ]);
    });
  });

  it('lets the user, never an agent, restore a forgotten entry, which agents then find again', async () => {
    const entry = created(
      await db.service.save(AGENT, { title: 'Fact', body: 'tangerine' }, NONE),
    );
    await db.service.forget(AGENT, entry.handle, 'wrong', NONE);

    const byAgent = await db.service.setStatus(AGENT, entry.id, 'active');
    const restored = await db.service.setStatus(
      { kind: 'user' },
      entry.id,
      'active',
    );

    expect(byAgent).toMatchObject({ kind: 'refused', code: 'USER_ONLY' });
    expect(restored).toMatchObject({
      kind: 'changed',
      entry: { status: 'active' },
    });
    expect(
      (await db.service.search('tangerine', NONE, 5)).map((h) => h.handle),
    ).toEqual([entry.handle]);
  });

  it('lists what a run may see, its project’s entries first, each most recently used first', async () => {
    const globalOld = created(
      await db.service.save(AGENT, { title: 'G old', body: 'x' }, NONE),
    );
    const globalNew = created(
      await db.service.save(AGENT, { title: 'G new', body: 'x' }, NONE),
    );
    const own = created(
      await db.service.save(
        AGENT,
        { title: 'Own', body: 'x' },
        inProject('p1'),
      ),
    );
    await db.service.save(
      AGENT,
      { title: 'Theirs', body: 'x' },
      inProject('p2'),
    );
    await db.em
      .fork()
      .nativeUpdate(
        Memory,
        { id: globalOld.id },
        { lastUsedAt: new Date('2020-01-01T00:00:00Z') },
      );
    await db.service.read([globalNew.handle], inProject('p1'));

    const listed = await db.service.listVisible(inProject('p1'));

    expect(listed.map((entry) => entry.handle)).toEqual([
      own.handle,
      globalNew.handle,
      globalOld.handle,
    ]);
  });

  describe('a new run’s snapshot', () => {
    const FACTS = { taskId: null, cwd: '/repo/app' };

    beforeEach(() => {
      db.service.setConfig(DEFAULT_MEMORY_CONFIG);
    });

    async function project() {
      const em = db.em.fork();
      em.persist(make(Project, { id: 'p1', name: 'App', folder: '/repo/app' }));
      await em.flush();
    }

    function indexLines(index: string | null): string[] {
      return (index ?? '').split('\n');
    }

    it('caps the index at 2 KB on whole lines and ends with the +N more footer', async () => {
      const titles = Array.from(
        { length: 30 },
        (_, n) => `Note ${n} ${'word '.repeat(20)}end`,
      );
      const em = db.em.fork();
      titles.forEach((title, n) =>
        em.persist(
          make(Memory, {
            handle: n + 1,
            title,
            body: 'x',
            type: 'project',
            status: 'active',
            sourceActor: 'user',
          }),
        ),
      );
      await em.flush();

      const { memoryIndex } = await db.service.runSnapshot(FACTS);

      const lines = indexLines(memoryIndex);
      const listed = lines.slice(1, -1);
      expect(Buffer.byteLength(memoryIndex ?? '')).toBeLessThanOrEqual(2048);
      expect(lines[0]).toBe(MEMORY_INDEX_PREFACE);
      expect(listed.length).toBeGreaterThan(0);
      expect(listed.length).toBeLessThan(30);
      for (const line of listed) {
        expect(titles.some((title) => line.includes(` ${title} (`))).toBe(true);
      }
      expect(lines.at(-1)).toBe(
        `(+${30 - listed.length} more — memory_search)`,
      );
    });

    it('orders project entries before global, most recently used first', async () => {
      await project();
      const globalOld = created(
        await db.service.save(USER, { title: 'Global old', body: 'x' }, NONE),
      );
      const globalNew = created(
        await db.service.save(USER, { title: 'Global new', body: 'x' }, NONE),
      );
      const own = created(
        await db.service.save(
          USER,
          { title: 'Own rule', body: 'x' },
          inProject('p1'),
        ),
      );
      await db.service.save(
        USER,
        { title: 'Theirs', body: 'x' },
        inProject('p2'),
      );
      await db.em
        .fork()
        .nativeUpdate(
          Memory,
          { id: globalOld.id },
          { lastUsedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
        );
      await db.service.read([globalNew.handle], inProject('p1'));

      const { memoryIndex } = await db.service.runSnapshot(FACTS);

      expect(indexLines(memoryIndex)).toEqual([
        MEMORY_INDEX_PREFACE,
        `- ${own.handle} [project] Own rule (project)`,
        `- ${globalNew.handle} [project] Global new (global, used today)`,
        `- ${globalOld.handle} [project] Global old (global, used 3d ago)`,
      ]);
    });

    it('omits pending and forgotten entries', async () => {
      const kept = created(
        await db.service.save(USER, { title: 'Kept', body: 'x' }, NONE),
      );
      const gone = created(
        await db.service.save(USER, { title: 'Gone', body: 'x' }, NONE),
      );
      await db.service.forget(AGENT, gone.handle, 'wrong', NONE);
      db.service.setConfig({
        enabled: true,
        agentWrites: 'pending',
        nativeMemoryOff: false,
        autoForgetAfterDays: null,
        removeNotUseful: true,
      });
      await db.service.save(AGENT, { title: 'Waiting', body: 'x' }, NONE);

      const { memoryIndex } = await db.service.runSnapshot(FACTS);

      expect(indexLines(memoryIndex).slice(1)).toEqual([
        `- ${kept.handle} [project] Kept (global)`,
      ]);
    });

    it('masks a secret registered after a title was saved', async () => {
      const secret = 'sk-title-0123456789abcdef';
      await db.service.save(
        USER,
        { title: `Key ${secret} rotates`, body: 'x' },
        NONE,
      );
      registerSecret(secret, 'late');

      const { memoryIndex } = await db.service.runSnapshot(FACTS);

      expect(memoryIndex).toContain('Key ');
      expect(memoryIndex).toContain(' rotates');
      expect(memoryIndex).not.toContain(secret);
    });

    it('carries no index for a run that may see no entry, and nothing at all while memory is off', async () => {
      await db.service.save(
        USER,
        { title: 'Theirs', body: 'x' },
        inProject('p2'),
      );

      const empty = await db.service.runSnapshot(FACTS);
      db.service.setConfig({
        enabled: false,
        agentWrites: 'active',
        nativeMemoryOff: false,
        autoForgetAfterDays: null,
        removeNotUseful: true,
      });
      const off = await db.service.runSnapshot(FACTS);

      expect(empty).toEqual({
        nativeMemoryOff: false,
        memoryIndex: null,
        indexIds: [],
      });
      expect(off).toEqual({
        nativeMemoryOff: false,
        memoryIndex: null,
        indexIds: [],
      });
    });

    it('carries nothing until the user’s settings have arrived, then the index alone', async () => {
      const fresh = await memoryDb();
      try {
        await fresh.service.save(USER, { title: 'Kept', body: 'x' }, NONE);

        const before = await fresh.service.runSnapshot(FACTS);
        fresh.service.setConfig(DEFAULT_MEMORY_CONFIG);
        const after = await fresh.service.runSnapshot(FACTS);

        expect(before).toEqual({
          nativeMemoryOff: false,
          memoryIndex: null,
          indexIds: [],
        });
        expect(after.memoryIndex).toContain('Kept');
        expect(after.nativeMemoryOff).toBe(false);
      } finally {
        await fresh.orm.close();
      }
    });

    it.each([
      ['the user’s own', 'user', null, true],
      ['an import’s', 'import', null, true],
      ['an agent’s unreviewed', 'agent', null, false],
      ['an analysis chat’s unreviewed', 'analysis', null, false],
      ['an agent’s approved', 'agent', new Date('2026-10-01T00:00:00Z'), true],
    ] as const)(
      'lists %s entry: %s',
      async (_label, sourceActor, approvedAt, listed) => {
        const em = db.em.fork();
        em.persist(
          make(Memory, {
            handle: 1,
            title: 'Rule',
            body: 'x',
            type: 'user',
            status: 'active',
            sourceActor,
            approvedAt,
          }),
        );
        await em.flush();

        const { memoryIndex } = await db.service.runSnapshot(FACTS);

        expect(indexLines(memoryIndex).slice(1)).toEqual(
          listed ? ['- m1 [user] Rule (global)'] : [],
        );
      },
    );

    it('admits an agent’s entry the user approves while it is already active', async () => {
      const theirs = created(
        await db.service.save(AGENT, { title: 'Theirs', body: 'x' }, NONE),
      );

      const approved = await db.service.setStatus(USER, theirs.id, 'active');
      const { memoryIndex } = await db.service.runSnapshot(FACTS);

      expect(approved).toMatchObject({
        kind: 'changed',
        entry: { status: 'active', approvedAt: expect.any(String) },
      });
      expect(indexLines(memoryIndex).slice(1)).toEqual([
        `- ${theirs.handle} [project] Theirs (global)`,
      ]);
    });

    it('keeps the first approval when the user approves an entry again', async () => {
      const theirs = created(
        await db.service.save(AGENT, { title: 'Theirs', body: 'x' }, NONE),
      );
      const first = await db.service.setStatus(USER, theirs.id, 'active');

      const again = await db.service.setStatus(USER, theirs.id, 'active');

      expect(first.kind === 'changed' && first.entry.approvedAt).toBeTruthy();
      expect(again).toMatchObject({
        kind: 'changed',
        entry: {
          approvedAt: first.kind === 'changed' ? first.entry.approvedAt : null,
          rev: first.kind === 'changed' ? first.entry.rev : -1,
        },
      });
    });

    it('leaves an agent’s unreviewed entry out until the user approves it, and again once an agent rewrites it', async () => {
      const mine = created(
        await db.service.save(USER, { title: 'Mine', body: 'x' }, NONE),
      );
      const theirs = created(
        await db.service.save(AGENT, { title: 'Theirs', body: 'x' }, NONE),
      );
      const listed = async () =>
        indexLines((await db.service.runSnapshot(FACTS)).memoryIndex).slice(1);

      const before = await listed();
      await db.service.setStatus(USER, theirs.id, 'active');
      const approved = await listed();
      const current = await db.service.read([theirs.handle], NONE);
      await db.service.save(
        AGENT,
        {
          handle: theirs.handle,
          rev: current.entries[0]!.rev,
          title: 'Theirs',
          body: 'rewritten',
        },
        NONE,
      );
      const rewritten = await listed();

      expect(before).toEqual([`- ${mine.handle} [project] Mine (global)`]);
      expect(approved.map((line) => line.split(' ')[1])).toEqual(
        expect.arrayContaining([mine.handle, theirs.handle]),
      );
      expect(rewritten.map((line) => line.split(' ')[1])).toEqual([
        mine.handle,
      ]);
    });

    it('starts the run without an index when the read fails, the CLIs’ own memory as the user set it', async () => {
      db.service.setConfig({ ...DEFAULT_MEMORY_CONFIG, nativeMemoryOff: true });
      await db.service.save(USER, { title: 'Kept', body: 'x' }, NONE);
      vi.spyOn(db.service, 'listVisible').mockRejectedValueOnce(
        new Error('disk gone'),
      );

      const snapshot = await db.service.runSnapshot(FACTS);

      expect(snapshot).toEqual({
        nativeMemoryOff: true,
        memoryIndex: null,
        indexIds: [],
      });
    });

    it('switches each CLI’s own memory off only while the shared memory is on and the user asked', async () => {
      db.service.setConfig({ ...DEFAULT_MEMORY_CONFIG, nativeMemoryOff: true });
      const asked = await db.service.runSnapshot(FACTS);
      db.service.setConfig({
        enabled: false,
        agentWrites: 'active',
        nativeMemoryOff: true,
        autoForgetAfterDays: null,
        removeNotUseful: true,
      });
      const memoryOff = await db.service.runSnapshot(FACTS);

      expect(asked.nativeMemoryOff).toBe(true);
      expect(memoryOff.nativeMemoryOff).toBe(false);
    });
  });

  it('refuses an agent write while memory is off', async () => {
    db.service.setConfig({
      enabled: false,
      agentWrites: 'active',
      nativeMemoryOff: false,
      autoForgetAfterDays: null,
      removeNotUseful: true,
    });

    const outcome = await db.service.save(
      AGENT,
      { title: 'Off', body: 'x' },
      NONE,
    );

    expect(outcome).toMatchObject({ kind: 'refused', code: 'MEMORY_DISABLED' });
  });

  it('never lets a secret registered after saving leave through a search excerpt, even cut', async () => {
    const secret = 'sk-late-0123456789abcdef0123';
    const entry = created(
      await db.service.save(
        AGENT,
        { title: 'Old note', body: `${'x '.repeat(76)}${secret} tail` },
        NONE,
      ),
    );
    registerSecret(secret, 'late');

    const [hit] = await db.service.search('note', NONE, 5);

    expect(hit?.handle).toBe(entry.handle);
    expect(hit?.excerpt).not.toContain(secret.slice(0, 6));
  });

  it('never returns forgotten or pending entries from search', async () => {
    const kept = created(
      await db.service.save(
        AGENT,
        { title: 'Kept fact', body: 'zebra crossing' },
        NONE,
      ),
    );
    const forgotten = created(
      await db.service.save(
        AGENT,
        { title: 'Old fact', body: 'zebra stripes' },
        NONE,
      ),
    );
    await db.service.forget(AGENT, forgotten.handle, 'wrong', NONE);
    db.service.setConfig({
      enabled: true,
      agentWrites: 'pending',
      nativeMemoryOff: false,
      autoForgetAfterDays: null,
      removeNotUseful: true,
    });
    await db.service.save(
      AGENT,
      { title: 'Unreviewed fact', body: 'zebra herd' },
      NONE,
    );

    const hits = await db.service.search('zebra', NONE, 10);

    expect(hits.map((hit) => hit.handle)).toEqual([kept.handle]);
  });

  it('searches global entries and the run’s own project, never another project’s', async () => {
    const global = created(
      await db.service.save(AGENT, { title: 'Global', body: 'kiwi' }, NONE),
    );
    const own = created(
      await db.service.save(
        AGENT,
        { title: 'Own', body: 'kiwi' },
        inProject('p1'),
      ),
    );
    await db.service.save(
      AGENT,
      { title: 'Other', body: 'kiwi' },
      inProject('p2'),
    );

    const hits = await db.service.search('kiwi', inProject('p1'), 10);

    expect(hits.map((hit) => hit.handle).sort()).toEqual(
      [global.handle, own.handle].sort(),
    );
  });

  it('reads whole entries, stamps lastUsedAt, and reports another project’s as missing', async () => {
    const own = created(
      await db.service.save(
        AGENT,
        { title: 'Own', body: 'body' },
        inProject('p1'),
      ),
    );
    const other = created(
      await db.service.save(
        AGENT,
        { title: 'Other', body: 'body' },
        inProject('p2'),
      ),
    );

    const result = await db.service.read(
      [own.handle, other.handle],
      inProject('p1'),
    );

    expect(result.entries.map((entry) => entry.handle)).toEqual([own.handle]);
    expect(result.missing).toEqual([other.handle]);
    const row = await db.em.fork().findOneOrFail(Memory, { id: own.id });
    expect(row.lastUsedAt).not.toBeNull();
    expect(row.updatedAt.toISOString()).toBe(own.updatedAt);
  });

  it('finds an entry written before the index existed, after the boot check rebuilds it', async () => {
    const em = db.em.fork();
    em.persist(
      make(Memory, {
        handle: 1,
        title: 'Imported',
        body: 'pomegranate',
        type: 'project',
        status: 'active',
        sourceActor: 'import',
      }),
    );
    await em.flush();
    // A table rebuild takes its triggers with it; a row written meanwhile is
    // missing from the index.
    for (const drop of retiredMemoryTriggerDrops(MEMORY_TEXT_VERSION + 1).slice(
      -MEMORY_TEXT_TRIGGERS.length,
    )) {
      await db.em.getConnection().execute(drop, [], 'run');
    }
    await db.em
      .getKysely<MemoryTextDatabase>()
      .deleteFrom('memories_fts')
      .execute();

    await db.index().ensure();

    expect(
      (await db.service.search('pomegranate', NONE, 5)).map((h) => h.handle),
    ).toEqual(['m1']);
  });

  describe('team memory', () => {
    const TEAM_A: RunPlace = { projectId: null, teamSlug: 'a' };
    const TEAM_B: RunPlace = { projectId: null, teamSlug: 'b' };
    const RUN_IN_A: RunPlace = { projectId: 'p1', teamSlug: 'a' };

    async function seedPlaces() {
      const save = async (title: string, place: RunPlace) =>
        created(
          await db.service.save(
            USER,
            {
              title,
              body: `${title} body`,
              scope: place.teamSlug === null ? undefined : 'team',
            },
            place,
          ),
        );
      return {
        global: await save('Global kiwi', NONE),
        project: await save('Project kiwi', inProject('p1')),
        otherProject: await save('Other project kiwi', inProject('p2')),
        a: await save('Team a kiwi', TEAM_A),
        b: await save('Team b kiwi', TEAM_B),
      };
    }

    it('settles a deleted team’s entries as the user chose, leaving every other team’s alone', async () => {
      const kept = await seedPlaces();
      const placeOf = async (id: string) => {
        const entry = await db.service.get(id);
        return [entry?.status, entry?.teamSlug];
      };

      expect(await db.service.settleDeletedTeam('a', 'keep')).toBe(0);
      expect(await placeOf(kept.a.id)).toEqual(['active', 'a']);

      expect(await db.service.settleDeletedTeam('a', 'forget')).toBe(1);
      expect(await placeOf(kept.a.id)).toEqual(['forgotten', 'a']);
      expect(await placeOf(kept.b.id)).toEqual(['active', 'b']);

      expect(await db.service.settleDeletedTeam('b', 'global')).toBe(1);
      expect(await placeOf(kept.b.id)).toEqual(['active', null]);
      expect(await placeOf(kept.global.id)).toEqual(['active', null]);
    });

    it('refuses filing the user’s entry under a team the library does not hold, but edits one kept under a deleted team', async () => {
      const library = new Set(['a']);
      db.service.useTeamLookup(async (slug) => library.has(slug));
      const entry = savedOf(
        await db.service.create({
          title: 'Kept note',
          body: 'x',
          type: 'project',
          projectId: null,
          teamSlug: 'a',
        }),
      );

      const ghost = await db.service.create({
        title: 'Ghost note',
        body: 'x',
        type: 'project',
        projectId: null,
        teamSlug: 'ghost',
      });
      library.delete('a');
      const edited = await db.service.edit(entry.id, {
        rev: entry.rev,
        title: 'Kept note, edited',
        body: 'x',
        type: 'project',
        projectId: null,
        teamSlug: 'a',
      });

      expect(ghost).toMatchObject({ kind: 'refused', code: 'NO_TEAM' });
      expect(edited).toMatchObject({
        kind: 'updated',
        entry: { teamSlug: 'a' },
      });
    });

    it('a team run sees global, its project and its team entries, not another team’s', async () => {
      await db.em
        .fork()
        .persist(make(Project, { id: 'p1', name: 'App', folder: '/repo/app' }))
        .flush();
      const { global, project, a, b } = await seedPlaces();
      db.service.setConfig(DEFAULT_MEMORY_CONFIG);
      const visible = [global.handle, project.handle, a.handle].sort();

      expect(
        (await db.service.search('kiwi', RUN_IN_A, 10))
          .map((hit) => hit.handle)
          .sort(),
      ).toEqual(visible);
      const read = await db.service.read(
        [global.handle, project.handle, a.handle],
        RUN_IN_A,
      );
      expect(read.entries.map((entry) => entry.handle).sort()).toEqual(visible);
      expect((await db.service.read([b.handle], RUN_IN_A)).missing).toEqual([
        b.handle,
      ]);
      expect(
        (await db.service.listVisible(RUN_IN_A)).map((entry) => entry.handle),
      ).toEqual([a.handle, project.handle, global.handle]);
      const snapshot = await db.service.runSnapshot({
        taskId: null,
        cwd: '/repo/app',
        teamSlug: 'a',
      });
      expect(snapshot.memoryIndex).toContain('Team a kiwi');
      expect(snapshot.memoryIndex).toContain('Project kiwi');
      expect(snapshot.memoryIndex).toContain('Global kiwi');
      expect(snapshot.memoryIndex).not.toContain('Team b kiwi');
      expect(snapshot.memoryIndex).toContain('Team a kiwi (team');
    });

    it('shows a run outside any team no team’s entries', async () => {
      const { global, project } = await seedPlaces();

      expect(
        (await db.service.listVisible(inProject('p1'))).map((e) => e.handle),
      ).toEqual([project.handle, global.handle]);
    });

    it('cannot update or forget another team’s entry', async () => {
      const { b } = await seedPlaces();

      expect(
        await db.service.save(
          AGENT,
          { handle: b.handle, rev: b.rev, title: 'x', body: 'y' },
          TEAM_A,
        ),
      ).toMatchObject({ kind: 'refused', code: 'NOT_FOUND' });
      expect(
        await db.service.forget(AGENT, b.handle, 'no', TEAM_A),
      ).toMatchObject({ kind: 'refused', code: 'NOT_FOUND' });
    });

    describe('saving with scope: team', () => {
      async function seedRuns() {
        const em = db.em.fork();
        em.persist(make(Run, { id: 'r-team', status: 'running', teamId: 'a' }));
        em.persist(make(Run, { id: 'r-chat', status: 'running' }));
        await em.flush();
      }

      it('files the entry under the run’s team, with no project', async () => {
        await seedRuns();
        const published: MemoryChangedEvent[] = [];
        db.events.allChanges().subscribe((event) => published.push(event));

        const entry = created(
          await db.service.save(
            AGENT,
            { title: 'Team rule', body: 'x', scope: 'team' },
            await db.service.scopeOf('r-team'),
          ),
        );

        expect(entry).toMatchObject({ projectId: null, teamSlug: 'a' });
        expect(published).toEqual([
          {
            memoryId: entry.id,
            change: 'created',
            status: 'active',
            projectId: null,
            teamSlug: 'a',
          },
        ]);
      });

      it('refuses a chat run, which has no team', async () => {
        await seedRuns();

        expect(
          await db.service.save(
            AGENT,
            { title: 'Team rule', body: 'x', scope: 'team' },
            await db.service.scopeOf('r-chat'),
          ),
        ).toMatchObject({ kind: 'refused', code: 'NO_TEAM' });
      });

      it('keeps an updated team entry in its team, and files other scopes elsewhere', async () => {
        const team = created(
          await db.service.save(
            AGENT,
            { title: 'Team rule', body: 'x', scope: 'team' },
            RUN_IN_A,
          ),
        );
        const updated = created(
          await db.service.save(
            AGENT,
            {
              handle: team.handle,
              rev: team.rev,
              title: 'Team rule',
              body: 'y',
            },
            RUN_IN_A,
          ),
        );
        const plain = created(
          await db.service.save(AGENT, { title: 'Plain', body: 'p' }, RUN_IN_A),
        );
        const global = created(
          await db.service.save(
            AGENT,
            { title: 'Mine', body: 'g', scope: 'global' },
            RUN_IN_A,
          ),
        );

        expect(updated).toMatchObject({ projectId: null, teamSlug: 'a' });
        expect(plain).toMatchObject({ projectId: 'p1', teamSlug: null });
        expect(global).toMatchObject({ projectId: null, teamSlug: null });
      });

      it('counts a same-titled entry a duplicate only in the same team', async () => {
        await db.service.save(
          AGENT,
          { title: 'Use pnpm', body: 'x', scope: 'team' },
          TEAM_A,
        );

        expect(
          (
            await db.service.save(
              AGENT,
              { title: 'Use pnpm', body: 'x', scope: 'team' },
              TEAM_B,
            )
          ).kind,
        ).toBe('created');
        expect(
          (
            await db.service.save(
              AGENT,
              { title: 'Use pnpm', body: 'x', scope: 'team' },
              TEAM_A,
            )
          ).kind,
        ).toBe('near_duplicate');
        expect(
          (await db.service.save(AGENT, { title: 'Use pnpm', body: 'x' }, NONE))
            .kind,
        ).toBe('created');
      });
    });
  });

  describe('scopeOf', () => {
    async function seed() {
      const em = db.em.fork();
      em.persist(
        make(Project, {
          id: 'p-cards',
          name: 'Cards',
          folder: '/elsewhere',
        }),
      );
      em.persist(
        make(Project, { id: 'p-app', name: 'App', folder: '/repo/app' }),
      );
      em.persist(
        make(Task, { id: 'task-1', projectId: 'p-cards', title: 'T' }),
      );
      await em.flush();
    }

    async function run(id: string, extra: Partial<Run>) {
      const em = db.em.fork();
      em.persist(make(Run, { id, status: 'completed', ...extra }));
      await em.flush();
    }

    it('takes the task card’s project over the folder the run works in', async () => {
      await seed();
      await run('r-task', { taskId: 'task-1', cwd: '/repo/app' });

      expect(await db.service.scopeOf('r-task')).toEqual(inProject('p-cards'));
    });

    it('takes the project whose folder the run’s worktree resolves to', async () => {
      await seed();
      await run('r-wt', { cwd: '/wt/task-1' });

      expect(await db.service.scopeOf('r-wt')).toEqual(inProject('p-app'));
    });

    it('uses the stored project; a deleted one means no project', async () => {
      await seed();
      await run('r-bound', {
        cwd: '/repo/app',
        projectId: 'p-cards',
        projectSource: 'explicit',
      });
      await run('r-unbound', {
        cwd: '/repo/app',
        taskId: 'task-1',
        projectId: null,
        projectSource: 'explicit',
      });

      expect(await db.service.scopeOf('r-bound')).toEqual(inProject('p-cards'));
      expect(await db.service.scopeOf('r-unbound')).toEqual(NONE);

      const em = db.em.fork();
      em.remove(await em.findOneOrFail(Project, 'p-cards'));
      await em.flush();
      expect(await db.service.scopeOf('r-bound')).toEqual(NONE);
    });

    it('answers global only for a folder no project owns', async () => {
      await seed();
      await run('r-free', { cwd: '/tmp/scratch' });

      expect(await db.service.scopeOf('r-free')).toEqual(NONE);
      expect(await db.service.scopeOf('no-such-run')).toEqual(NONE);
    });

    it('names a team run’s team beside its project, and a chat’s never', async () => {
      await seed();
      await run('r-team', { teamId: 'team-a', cwd: '/repo/app' });
      await run('r-chat', { cwd: '/repo/app' });

      expect(await db.service.scopeOf('r-team')).toEqual({
        projectId: 'p-app',
        teamSlug: 'team-a',
      });
      expect(await db.service.scopeOf('r-chat')).toEqual(inProject('p-app'));
      expect(
        await db.service.scopeFor({
          taskId: null,
          cwd: '/tmp/scratch',
          teamSlug: 'team-b',
        }),
      ).toEqual({ projectId: null, teamSlug: 'team-b' });
    });
  });

  describe('actorOf', () => {
    it('names a team member’s own agent over the run’s', async () => {
      const em = db.em.fork();
      em.persist(
        make(Run, {
          id: 'wf',
          status: 'running',
          agentKind: 'claude',
          model: 'opus',
        }),
      );
      em.persist(
        make(NodeState, {
          runId: 'wf',
          memberId: 'coder',
          agentKind: 'codex',
          model: 'gpt-5',
        }),
      );
      await em.flush();

      expect(await db.service.actorOf('wf', 'coder')).toEqual({
        kind: 'agent',
        runId: 'wf',
        agentKind: 'codex',
        model: 'gpt-5',
      });
      expect(await db.service.actorOf('wf', 'agent')).toEqual({
        kind: 'agent',
        runId: 'wf',
        agentKind: 'claude',
        model: 'opus',
      });
    });
  });

  describe('the user’s own view', () => {
    async function seedRows(rows: Partial<Memory>[]) {
      const em = db.em.fork();
      em.persist(make(Project, { id: 'p1', name: 'App', folder: '/repo/app' }));
      rows.forEach((row, n) =>
        em.persist(
          make(Memory, {
            handle: n + 1,
            title: `Note ${n + 1}`,
            body: `body ${n + 1}`,
            type: 'project',
            status: 'active',
            sourceActor: 'user',
            ...row,
          }),
        ),
      );
      await em.flush();
    }

    const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute));

    it('lists newest edit first and pages on without repeating or skipping a row, ties included', async () => {
      await seedRows([
        { updatedAt: at(1) },
        { updatedAt: at(3) },
        { updatedAt: at(3) },
        { updatedAt: at(2) },
        { updatedAt: at(5) },
      ]);

      const seen: string[] = [];
      let page = await db.service.list({ limit: 2 });
      for (;;) {
        seen.push(...page.memories.map((entry) => entry.title));
        if (page.next === null) {
          break;
        }
        page = await db.service.list({ limit: 2, ...page.next });
      }

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect(seen[0]).toBe('Note 5');
      expect(seen.slice(1, 3).sort()).toEqual(['Note 2', 'Note 3']);
      expect(seen.slice(3)).toEqual(['Note 4', 'Note 1']);
    });

    it('lists active and pending by default, and each filter narrows to what it names', async () => {
      await seedRows([
        { status: 'active', title: 'Global fact' },
        { status: 'pending', title: 'Waiting fact', projectId: 'p1' },
        { status: 'forgotten', title: 'Old fact' },
        { status: 'active', title: 'Feedback fact', type: 'feedback' },
      ]);
      const titles = async (query: Parameters<MemoryService['list']>[0]) =>
        (await db.service.list(query)).memories.map((e) => e.title).sort();

      expect(await titles({})).toEqual([
        'Feedback fact',
        'Global fact',
        'Waiting fact',
      ]);
      expect(await titles({ status: 'forgotten' })).toEqual(['Old fact']);
      expect(await titles({ scope: 'project', projectId: 'p1' })).toEqual([
        'Waiting fact',
      ]);
      expect(await titles({ scope: 'global' })).toEqual([
        'Feedback fact',
        'Global fact',
      ]);
      expect(await titles({ type: 'feedback' })).toEqual(['Feedback fact']);
      expect(await titles({ q: 'waiting' })).toEqual(['Waiting fact']);
      expect(await titles({ handle: 'm3' })).toEqual(['Old fact']);
      expect(await titles({ handle: 'M2', status: 'active' })).toEqual([]);
    });

    it('splits the active entries by reach: what a run’s index may list, and what only a search finds', async () => {
      await seedRows([
        { title: 'Mine', sourceActor: 'user' },
        { title: 'Imported', sourceActor: 'import' },
        { title: 'Approved', sourceActor: 'agent', approvedAt: at(1) },
        { title: 'Saved at once', sourceActor: 'agent' },
        { title: 'Analysis note', sourceActor: 'analysis' },
        { title: 'Waiting', sourceActor: 'agent', status: 'pending' },
      ]);
      const listed = async (reach: 'index' | 'search') =>
        (await db.service.list({ status: 'active', reach })).memories
          .map((e) => `${e.title}:${e.indexed}`)
          .sort();

      expect(await listed('index')).toEqual([
        'Approved:true',
        'Imported:true',
        'Mine:true',
      ]);
      expect(await listed('search')).toEqual([
        'Analysis note:false',
        'Saved at once:false',
      ]);
      expect(
        (await db.service.list({ status: 'pending' })).memories.map(
          (e) => e.indexed,
        ),
      ).toEqual([false]);
    });

    it('moves an agent’s active entry into the index and back to search only, announcing each move', async () => {
      await seedRows([{ title: 'Saved at once', sourceActor: 'agent' }]);
      const [entry] = (await db.service.list({ status: 'active' })).memories;
      const announced: string[] = [];
      db.events.allChanges().subscribe((event) => announced.push(event.change));

      const indexed = await db.service.setIndexed(USER, entry!.id, true);
      const searchOnly = await db.service.setIndexed(USER, entry!.id, false);

      expect(indexed).toMatchObject({
        kind: 'changed',
        entry: { indexed: true, approvedAt: expect.any(String), rev: 2 },
      });
      expect(searchOnly).toMatchObject({
        kind: 'changed',
        entry: { indexed: false, approvedAt: null, rev: 3 },
      });
      expect(announced).toEqual(['approved', 'updated']);
      expect(
        (await db.service.list({ status: 'active', reach: 'search' })).memories,
      ).toHaveLength(1);
    });

    it('leaves an entry already where it is asked to go untouched and unannounced', async () => {
      await seedRows([
        { title: 'Approved', sourceActor: 'agent', approvedAt: at(1) },
        { title: 'Saved at once', sourceActor: 'agent' },
      ]);
      const listed = (await db.service.list({ status: 'active' })).memories;
      const byTitle = new Map(listed.map((e) => [e.title, e]));
      const announced: string[] = [];
      db.events.allChanges().subscribe((event) => announced.push(event.change));

      const again = await db.service.setIndexed(
        USER,
        byTitle.get('Approved')!.id,
        true,
      );
      const stillSearch = await db.service.setIndexed(
        USER,
        byTitle.get('Saved at once')!.id,
        false,
      );

      expect(again).toMatchObject({
        kind: 'changed',
        entry: {
          rev: byTitle.get('Approved')!.rev,
          approvedAt: byTitle.get('Approved')!.approvedAt,
        },
      });
      expect(stillSearch).toMatchObject({
        kind: 'changed',
        entry: { rev: byTitle.get('Saved at once')!.rev, indexed: false },
      });
      expect(announced).toEqual([]);
    });

    it('refuses to take the user’s own or an imported entry out of the index, to move a waiting or forgotten one, and an agent’s move', async () => {
      await seedRows([
        { title: 'Mine', sourceActor: 'user' },
        { title: 'Imported', sourceActor: 'import' },
        { title: 'Waiting', sourceActor: 'agent', status: 'pending' },
        { title: 'Gone', sourceActor: 'agent', status: 'forgotten' },
      ]);
      const ids = new Map(
        (await db.service.list({ handle: undefined, limit: 10 })).memories
          .concat((await db.service.list({ status: 'forgotten' })).memories)
          .map((e) => [e.title, e.id]),
      );

      expect(
        await db.service.setIndexed(USER, ids.get('Mine')!, false),
      ).toMatchObject({
        kind: 'refused',
        code: 'ALWAYS_INDEXED',
      });
      expect(
        await db.service.setIndexed(USER, ids.get('Imported')!, false),
      ).toMatchObject({ kind: 'refused', code: 'ALWAYS_INDEXED' });
      expect(
        await db.service.setIndexed(USER, ids.get('Waiting')!, true),
      ).toMatchObject({ kind: 'refused', code: 'NOT_ACTIVE' });
      expect(
        await db.service.setIndexed(USER, ids.get('Gone')!, true),
      ).toMatchObject({
        kind: 'refused',
        code: 'NOT_ACTIVE',
      });
      expect(
        await db.service.setIndexed(AGENT, ids.get('Mine')!, true),
      ).toMatchObject({
        kind: 'refused',
        code: 'USER_ONLY',
      });
    });

    it('previews a place’s index as a run’s snapshot cuts it: how many fit of all it may list', async () => {
      await seedRows([
        ...Array.from({ length: 60 }, (_, n) => ({
          title: `Rule number ${n} about how this project is built and tested`,
        })),
        { title: 'Search only', sourceActor: 'agent' },
        { title: 'Theirs', projectId: 'p1' },
      ]);

      const global = await db.service.indexPreview({
        projectId: null,
        teamSlug: null,
      });
      const inProject = await db.service.indexPreview({
        projectId: 'p1',
        teamSlug: null,
      });

      expect(global.eligible).toBe(60);
      expect(global.listed).toBeGreaterThan(0);
      expect(global.listed).toBeLessThan(60);
      expect(global.ids).toHaveLength(global.listed);
      expect(inProject.eligible).toBe(61);
      expect(inProject.ids[0]).toBe(
        (await db.service.list({ scope: 'project', projectId: 'p1' }))
          .memories[0]!.id,
      );
    });

    it('lists one team’s entries only with scope: team', async () => {
      await seedRows([
        { title: 'Global fact' },
        { title: 'Project fact', projectId: 'p1' },
        { title: 'Team a fact', teamSlug: 'a' },
        { title: 'Team b fact', teamSlug: 'b' },
      ]);
      const titles = async (query: Parameters<MemoryService['list']>[0]) =>
        (await db.service.list(query)).memories.map((e) => e.title).sort();

      expect(await titles({ scope: 'team', teamSlug: 'a' })).toEqual([
        'Team a fact',
      ]);
      expect(await titles({ scope: 'global' })).toEqual(['Global fact']);
      expect(await titles({ scope: 'project', projectId: 'p1' })).toEqual([
        'Project fact',
      ]);
      expect(await titles({})).toHaveLength(4);
    });

    it('creates and edits the user’s entry under a team', async () => {
      await seedRows([]);

      const entry = savedOf(
        await db.service.create({
          title: 'Team habit',
          body: 'x',
          type: 'project',
          projectId: null,
          teamSlug: 'a',
        }),
      );
      const moved = savedOf(
        await db.service.edit(entry.id, {
          rev: entry.rev,
          title: 'Team habit',
          body: 'x',
          type: 'project',
          projectId: 'p1',
          teamSlug: null,
        }),
      );

      expect(entry).toMatchObject({ projectId: null, teamSlug: 'a' });
      expect(moved).toMatchObject({ projectId: 'p1', teamSlug: null });
    });

    it('creates the user’s entry where the user filed it, and refuses a project that does not exist', async () => {
      await seedRows([]);

      const entry = savedOf(
        await db.service.create({
          title: 'Ship on Fridays',
          body: 'never',
          type: 'feedback',
          projectId: 'p1',
        }),
      );
      const missing = await db.service.create({
        title: 'Elsewhere',
        body: 'x',
        type: 'project',
        projectId: 'nope',
      });

      expect(entry).toMatchObject({
        projectId: 'p1',
        status: 'active',
        type: 'feedback',
        source: { actor: 'user' },
      });
      expect(missing).toMatchObject({ kind: 'refused', code: 'NO_PROJECT' });
    });

    it('refuses the user a near-duplicate title until the user vouches past it', async () => {
      await seedRows([{ title: 'Use pnpm for installs' }]);
      const input = {
        title: 'Use pnpm for installs',
        body: 'again',
        type: 'project' as const,
        projectId: null,
      };

      const refusedCopy = await db.service.create(input);
      const vouched = await db.service.create({
        ...input,
        notDuplicateOf: ['m1'],
      });

      expect(refusedCopy).toMatchObject({ kind: 'near_duplicate' });
      expect(vouched).toMatchObject({ kind: 'created' });
    });

    it('edits at the read rev only, and an edit of a pending agent entry makes it the user’s own and active', async () => {
      await seedRows([
        {
          status: 'pending',
          sourceActor: 'agent',
          sourceAgentKind: 'claude',
          sourceRunId: 'run-a',
        },
      ]);
      const [pending] = (await db.service.list({})).memories;
      const published: MemoryChangedEvent[] = [];
      db.events.allChanges().subscribe((event) => published.push(event));
      const edit = {
        title: 'Reworded',
        body: 'by the user',
        type: 'reference' as const,
        projectId: 'p1',
        teamSlug: null,
      };

      const stale = await db.service.change(pending!.id, {
        ...edit,
        rev: pending!.rev + 1,
      });
      const saved = savedOf(
        await db.service.change(pending!.id, { ...edit, rev: pending!.rev }),
      );

      expect(stale).toMatchObject({ kind: 'stale' });
      expect(saved).toMatchObject({
        title: 'Reworded',
        status: 'active',
        projectId: 'p1',
        type: 'reference',
        rev: pending!.rev + 1,
        source: { actor: 'user', agentKind: null, runId: null },
      });
      expect(published).toEqual([
        {
          memoryId: pending!.id,
          change: 'updated',
          status: 'active',
          projectId: 'p1',
          teamSlug: null,
        },
      ]);
    });

    it('refuses to edit a forgotten entry until it is restored', async () => {
      await seedRows([{ status: 'forgotten' }]);
      const [gone] = (await db.service.list({ status: 'forgotten' })).memories;

      const outcome = await db.service.change(gone!.id, {
        rev: gone!.rev,
        title: 't',
        body: 'b',
        type: 'project',
        projectId: null,
        teamSlug: null,
      });

      expect(outcome).toMatchObject({ kind: 'refused', code: 'NOT_FOUND' });
    });

    it('names each status change by what it did: approved, forgotten, restored', async () => {
      await seedRows([{ status: 'pending', sourceActor: 'agent' }]);
      const [entry] = (await db.service.list({})).memories;
      const published: MemoryChangedEvent[] = [];
      db.events.allChanges().subscribe((event) => published.push(event));

      await db.service.change(entry!.id, { status: 'active' });
      await db.service.change(entry!.id, { status: 'forgotten' });
      await db.service.change(entry!.id, { status: 'active' });

      expect(published.map((event) => event.change)).toEqual([
        'approved',
        'forgotten',
        'restored',
      ]);
    });

    it('restores a forgotten entry to the status it had, approving nothing', async () => {
      await seedRows([
        { status: 'pending', sourceActor: 'agent' },
        { status: 'active', sourceActor: 'agent', approvedAt: at(1) },
      ]);
      const [waiting, approvedOne] = (
        await db.em.fork().find(Memory, {}, { orderBy: { handle: 'asc' } })
      ).map((row) => row.id);

      await db.service.forgetAll();
      await db.service.change(waiting!, { status: 'active' });
      await db.service.change(approvedOne!, { status: 'forgotten' });
      await db.service.change(approvedOne!, { status: 'active' });
      const rows = await db.em
        .fork()
        .find(Memory, {}, { orderBy: { handle: 'asc' } });

      expect(rows.map((row) => [row.status, row.approvedAt])).toEqual([
        ['pending', null],
        ['active', at(1)],
      ]);
    });

    it('forgets only active and pending entries, in one bulk change, each still restorable', async () => {
      await seedRows([
        { status: 'active' },
        { status: 'pending' },
        { status: 'forgotten', rev: 4 },
      ]);
      const published: MemoryChangedEvent[] = [];
      db.events.allChanges().subscribe((event) => published.push(event));

      const result = await db.service.forgetAll();
      const announced = [...published];
      const rows = await db.em
        .fork()
        .find(Memory, {}, { orderBy: { handle: 'asc' } });
      const restored = await db.service.setStatus(USER, rows[0]!.id, 'active');

      expect(result).toEqual({ forgotten: 2 });
      expect(rows.map((row) => [row.status, row.rev])).toEqual([
        ['forgotten', 2],
        ['forgotten', 2],
        ['forgotten', 4],
      ]);
      expect(announced).toEqual([
        {
          memoryId: null,
          change: 'bulk',
          status: 'forgotten',
          projectId: null,
          teamSlug: null,
        },
      ]);
      expect(restored).toMatchObject({
        kind: 'changed',
        entry: { status: 'active' },
      });
    });

    it('exports every active and pending entry with its type, scope and source, and leaves forgotten ones out', async () => {
      await seedRows([
        { title: 'Global note', type: 'user', sourceActor: 'user' },
        {
          title: 'App note',
          projectId: 'p1',
          status: 'pending',
          sourceActor: 'agent',
          sourceAgentKind: 'codex',
          sourceModel: 'gpt-5',
        },
        { title: 'Gone note', status: 'forgotten' },
        { title: 'Team note', teamSlug: 'alpha' },
        {
          title: 'Imported note',
          sourceActor: 'import',
          sourceImportedFrom: '/home/me/.claude/projects/x/memory/a.md',
        },
      ]);

      const { markdown, count } = await db.service.exportMarkdown();

      expect(count).toBe(4);
      expect(markdown).not.toContain('Gone note');
      expect(markdown).toMatch(
        /## Team: alpha[\s\S]*### m4 · Team note\n\n- Type: project\n- Status: active\n- Scope: Team: alpha\n/,
      );
      expect(markdown).toMatch(
        /## Global[\s\S]*### m1 · Global note\n\n- Type: user\n- Status: active\n- Scope: Global\n- Source: user/,
      );
      expect(markdown).toMatch(
        /## Project: App[\s\S]*### m2 · App note\n\n- Type: project\n- Status: pending\n- Scope: Project: App\n- Source: agent \(codex · gpt-5\)/,
      );
      expect(markdown).toContain(
        '- Source: imported from /home/me/.claude/projects/x/memory/a.md',
      );
    });
  });

  describe('usage', () => {
    async function usageOf(...ids: string[]) {
      return (await db.usageDao.daysOf(ids)).map((day) => ({
        memoryId: day.memoryId,
        reads: day.reads,
        searchHits: day.searchHits,
        indexShows: day.indexShows,
      }));
    }

    it('counts each read once per call, on the UTC day it happened', async () => {
      const read = created(
        await db.service.save(USER, { title: 'Use pnpm', body: 'x' }, NONE),
      );
      vi.useFakeTimers({ now: Date.UTC(2026, 10, 3, 3, 0), toFake: ['Date'] });

      for (let n = 0; n < 3; n += 1) {
        await db.service.read([read.handle, read.handle], NONE);
      }
      vi.useRealTimers();

      expect(await db.usageDao.daysOf([read.id])).toEqual([
        {
          memoryId: read.id,
          day: '2026-11-03',
          reads: 3,
          searchHits: 0,
          indexShows: 0,
        },
      ]);
    });

    it('does not count a missing handle', async () => {
      const theirs = created(
        await db.service.save(
          USER,
          { title: 'Theirs', body: 'x' },
          inProject('p2'),
        ),
      );

      const { entries, missing } = await db.service.read(
        [theirs.handle, 'm999'],
        NONE,
      );

      expect(entries).toEqual([]);
      expect(missing).toEqual([theirs.handle, 'm999']);
      expect(await usageOf(theirs.id)).toEqual([]);
    });

    it('a search hit does not move lastUsedAt', async () => {
      const hit = created(
        await db.service.save(USER, { title: 'Use pnpm', body: 'x' }, NONE),
      );

      const hits = await db.service.search('pnpm', NONE, 5);

      expect(hits.map((h) => h.id)).toEqual([hit.id]);
      expect(await usageOf(hit.id)).toEqual([
        { memoryId: hit.id, reads: 0, searchHits: 1, indexShows: 0 },
      ]);
      const row = await db.em.fork().findOneOrFail(Memory, { id: hit.id });
      expect(row.lastUsedAt).toBeNull();
    });

    it('a measured instruction size writes no usage', async () => {
      db.service.setConfig(DEFAULT_MEMORY_CONFIG);
      const shown = created(
        await db.service.save(USER, { title: 'Shown', body: 'x' }, NONE),
      );

      const snapshot = await db.service.runSnapshot({
        taskId: null,
        cwd: '/repo/app',
      });

      expect(snapshot.indexIds).toEqual([shown.id]);
      expect(await usageOf(shown.id)).toEqual([]);

      await db.service.countIndexShows(snapshot.indexIds);

      expect(await usageOf(shown.id)).toEqual([
        { memoryId: shown.id, reads: 0, searchHits: 0, indexShows: 1 },
      ]);
    });

    it('a counter failure leaves the tool answer intact', async () => {
      const read = created(
        await db.service.save(USER, { title: 'Use pnpm', body: 'x' }, NONE),
      );
      vi.spyOn(db.usageDao, 'add').mockRejectedValue(new Error('disk full'));

      const answer = await db.service.read([read.handle], NONE);
      const hits = await db.service.search('pnpm', NONE, 5);
      await db.service.countIndexShows([read.id]);

      expect(answer.entries.map((e) => e.id)).toEqual([read.id]);
      expect(hits.map((h) => h.id)).toEqual([read.id]);
    });

    it('a failed lastUsedAt stamp still answers the read and counts it', async () => {
      const read = created(
        await db.service.save(USER, { title: 'Use pnpm', body: 'x' }, NONE),
      );
      vi.spyOn(MemoryDao.prototype, 'touch').mockRejectedValueOnce(
        new Error('locked'),
      );

      const answer = await db.service.read([read.handle], NONE);

      expect(answer.entries.map((e) => e.id)).toEqual([read.id]);
      expect(await usageOf(read.id)).toEqual([
        { memoryId: read.id, reads: 1, searchHits: 0, indexShows: 0 },
      ]);
    });
  });

  describe('cleanup batches', () => {
    const FACTS = { taskId: null, cwd: '/repo/app' };

    beforeEach(() => {
      db.service.setConfig(DEFAULT_MEMORY_CONFIG);
    });

    async function seed(
      title: string,
      actor: MemoryActor = USER,
      place: RunPlace = NONE,
    ) {
      return created(await db.service.save(actor, { title, body: 'x' }, place));
    }

    async function rowOf(id: string) {
      return db.em.fork().findOneOrFail(Memory, { id });
    }

    it('undo returns each row to its own earlier status, pending included', async () => {
      const active = await seed('Pnpm workspace');
      db.service.setConfig({
        enabled: true,
        agentWrites: 'pending',
        nativeMemoryOff: false,
        autoForgetAfterDays: null,
        removeNotUseful: true,
      });
      const pending = await seed('Loopback binding', AGENT);
      db.service.setConfig(DEFAULT_MEMORY_CONFIG);
      expect(pending.status).toBe('pending');

      const batch = await db.service.forgetBatch([active.id, pending.id]);

      expect(batch).toMatchObject({ forgotten: 2, skipped: [] });
      expect(await db.service.restoreBatch(batch.batchId!)).toEqual({
        restored: 2,
      });
      const rows = await db.em
        .fork()
        .find(Memory, {}, { orderBy: { handle: 'asc' } });
      expect(rows.map((row) => [row.title, row.status])).toEqual([
        ['Pnpm workspace', 'active'],
        ['Loopback binding', 'pending'],
      ]);
    });

    it('a row restored by hand then forgotten by hand is not touched by the old batch', async () => {
      const entry = await seed('Pnpm workspace');
      const batch = await db.service.forgetBatch([entry.id]);
      await db.service.setStatus(USER, entry.id, 'active');
      await db.service.setStatus(USER, entry.id, 'forgotten');

      expect(await db.service.restoreBatch(batch.batchId!)).toEqual({
        restored: 0,
      });
      expect((await rowOf(entry.id)).status).toBe('forgotten');
    });

    it('forgetting a batch drops the entries from a new index and restoring returns them', async () => {
      const entry = await seed('Pnpm workspace');
      await seed('Loopback binding');
      const indexed = async () =>
        (await db.service.runSnapshot(FACTS)).memoryIndex ?? '';
      expect(await indexed()).toContain('Pnpm workspace');

      const batch = await db.service.forgetBatch([entry.id]);

      expect(await indexed()).not.toContain('Pnpm workspace');
      expect(await indexed()).toContain('Loopback binding');
      await db.service.restoreBatch(batch.batchId!);
      expect(await indexed()).toContain('Pnpm workspace');
    });

    it('forgetBatch skips an entry already forgotten or gone, names it, and publishes one bulk change', async () => {
      const forgotten = await seed('Pnpm workspace');
      const live = await seed('Loopback binding');
      await db.service.setStatus(USER, forgotten.id, 'forgotten');
      const published: MemoryChangedEvent[] = [];
      db.events.allChanges().subscribe((event) => published.push(event));

      const result = await db.service.forgetBatch([
        forgotten.id,
        live.id,
        'no-such-id',
      ]);

      expect(result).toEqual({
        batchId: expect.any(String),
        forgotten: 1,
        skipped: [
          {
            id: forgotten.id,
            handle: forgotten.handle,
            reason: 'already forgotten',
          },
          { id: 'no-such-id', handle: null, reason: 'no such entry' },
        ],
      });
      expect(published.filter((event) => event.change === 'bulk')).toEqual([
        {
          memoryId: null,
          change: 'bulk',
          status: 'forgotten',
          projectId: null,
          teamSlug: null,
          batchId: result.batchId,
        },
      ]);
      expect((await rowOf(live.id)).forgetBatchId).toBe(result.batchId);
    });

    it('every forget path stamps forgottenAt and clears the batch id, and a restore stamps restoredAt', async () => {
      const batched = await seed('Pnpm workspace');
      const byAgent = await seed('Loopback binding', AGENT);
      const byHand = await seed('Colima restarts');
      const swept = await seed('Changelog format');
      const batch = await db.service.forgetBatch([batched.id]);

      await db.service.forget(AGENT, byAgent.handle, 'obsolete', NONE);
      await db.service.setStatus(USER, byHand.id, 'forgotten');
      await db.service.forgetAll();

      const stateOf = async (id: string) => {
        const row = await rowOf(id);
        return {
          status: row.status,
          forgetBatchId: row.forgetBatchId,
          forgotten: row.forgottenAt !== null,
          restored: row.restoredAt !== null,
        };
      };
      const forgottenByEachPath = {
        status: 'forgotten',
        forgetBatchId: null,
        forgotten: true,
        restored: false,
      };
      expect(await stateOf(batched.id)).toEqual({
        ...forgottenByEachPath,
        forgetBatchId: batch.batchId,
      });
      expect(await stateOf(byAgent.id)).toEqual(forgottenByEachPath);
      expect(await stateOf(byHand.id)).toEqual(forgottenByEachPath);
      expect(await stateOf(swept.id)).toEqual(forgottenByEachPath);

      await db.service.setStatus(USER, batched.id, 'active');

      expect(await stateOf(batched.id)).toEqual({
        status: 'active',
        forgetBatchId: null,
        forgotten: false,
        restored: true,
      });
    });

    it('a save marks whether the text states a limit and which paths it names', async () => {
      await db.service.save(
        AGENT,
        {
          title: 'Build rule',
          body: 'Never run npm. See apps/daemon/src/main.ts and docs/a.md:12.',
        },
        NONE,
      );
      await db.service.save(
        AGENT,
        { title: 'Colima restarts', body: 'Daemon shares colima.' },
        NONE,
      );

      const rows = await db.em
        .fork()
        .find(Memory, {}, { orderBy: { handle: 'asc' } });
      expect(
        rows.map((row) => [
          row.statesRule,
          row.referencedPaths === null ? null : JSON.parse(row.referencedPaths),
        ]),
      ).toEqual([
        [true, ['apps/daemon/src/main.ts', 'docs/a.md']],
        [false, null],
      ]);
    });
  });

  describe('merge', () => {
    beforeEach(() => {
      db.service.setConfig(DEFAULT_MEMORY_CONFIG);
    });

    async function seed(title: string) {
      return created(await db.service.save(USER, { title, body: 'x' }, NONE));
    }

    async function rowOf(id: string) {
      return db.em.fork().findOneOrFail(Memory, { id });
    }

    function mergeOf(sourceIds: string[]): MemoryMergeRequest {
      return {
        sourceIds,
        title: 'Pnpm workspace rule',
        body: 'Use pnpm in the workspace.',
        type: 'project',
        projectId: null,
        teamSlug: null,
      };
    }

    it('merge is atomic: refused for a third near-duplicate, it forgets nothing', async () => {
      const first = await seed('Pnpm workspace install');
      const second = await seed('Pnpm workspace layout');
      await seed('Pnpm workspace rule');
      const published: MemoryChangedEvent[] = [];
      db.events.allChanges().subscribe((event) => published.push(event));

      const outcome = await db.service.merge(mergeOf([first.id, second.id]));

      expect(outcome).toMatchObject({ kind: 'near_duplicate' });
      expect((await rowOf(first.id)).status).toBe('active');
      expect((await rowOf(second.id)).status).toBe('active');
      expect(await db.em.fork().count(Memory)).toBe(3);
      expect(published).toEqual([]);
    });

    it('publishes the new entry and the batch only after the commit, and restoring the batch publishes the merged entry forgotten', async () => {
      const first = await seed('Pnpm workspace install');
      const second = await seed('Pnpm workspace layout');
      const published: MemoryChangedEvent[] = [];
      db.events.allChanges().subscribe((event) => published.push(event));

      const outcome = await db.service.merge(mergeOf([first.id, second.id]));
      if (outcome.kind !== 'merged') {
        throw new Error(`expected a merge, got ${outcome.kind}`);
      }
      const { entry, batchId } = outcome.result;

      expect(published).toEqual([
        expect.objectContaining({
          memoryId: entry.id,
          change: 'created',
          status: 'active',
        }),
        expect.objectContaining({
          memoryId: null,
          change: 'bulk',
          status: 'forgotten',
          batchId,
        }),
      ]);

      published.splice(0);
      await db.service.restoreBatch(batchId);

      expect(published).toContainEqual(
        expect.objectContaining({
          memoryId: entry.id,
          change: 'forgotten',
          status: 'forgotten',
        }),
      );
    });

    it('publishes nothing for a refused merge', async () => {
      const first = await seed('Pnpm workspace install');
      const published: MemoryChangedEvent[] = [];
      db.events.allChanges().subscribe((event) => published.push(event));

      expect(
        await db.service.merge(mergeOf([first.id, first.id])),
      ).toMatchObject({ kind: 'refused', code: 'INVALID_ENTRY' });
      expect(published).toEqual([]);
    });

    it('rolls the new entry back when a source is not taken in the same transaction', async () => {
      const first = await seed('Pnpm workspace install');
      const second = await seed('Pnpm workspace layout');
      const taken = vi
        .spyOn(MemoryDao.prototype, 'forgetBatch')
        .mockResolvedValueOnce([first.id]);
      const published: MemoryChangedEvent[] = [];
      db.events.allChanges().subscribe((event) => published.push(event));

      const outcome = await db.service.merge(mergeOf([first.id, second.id]));
      taken.mockRestore();

      expect(outcome).toMatchObject({ kind: 'refused', code: 'NOT_FOUND' });
      expect((await rowOf(first.id)).status).toBe('active');
      expect((await rowOf(second.id)).status).toBe('active');
      expect(await db.em.fork().count(Memory)).toBe(2);
      expect(published).toEqual([]);
    });

    it('restoring its batch returns both sources and removes the new entry', async () => {
      const first = await seed('Pnpm workspace install');
      const second = await seed('Pnpm workspace layout');

      const outcome = await db.service.merge(mergeOf([first.id, second.id]));

      if (outcome.kind !== 'merged') {
        throw new Error(`expected a merge, got ${outcome.kind}`);
      }
      const { entry, batchId, forgotten } = outcome.result;
      expect(entry).toMatchObject({
        status: 'active',
        source: { actor: 'user' },
      });
      expect([...forgotten].sort()).toEqual(
        [first.handle, second.handle].sort(),
      );
      for (const source of [first, second]) {
        expect(await rowOf(source.id)).toMatchObject({
          status: 'forgotten',
          mergedIntoId: entry.id,
          forgetBatchId: batchId,
        });
      }

      expect(await db.service.restoreBatch(batchId)).toEqual({ restored: 2 });

      for (const source of [first, second]) {
        expect(await rowOf(source.id)).toMatchObject({
          status: 'active',
          mergedIntoId: null,
        });
      }
      expect((await rowOf(entry.id)).status).toBe('forgotten');
    });

    it('a merged entry shows the read total of its sources, and a source restored by hand drops out of it', async () => {
      const first = await seed('Pnpm workspace install');
      const second = await seed('Pnpm workspace layout');
      await db.usageDao.add([
        {
          memoryId: first.id,
          day: '2025-01-01',
          reads: 3,
          searchHits: 0,
          indexShows: 0,
        },
        {
          memoryId: second.id,
          day: '2025-01-01',
          reads: 2,
          searchHits: 0,
          indexShows: 0,
        },
      ]);
      const outcome = await db.service.merge(mergeOf([first.id, second.id]));
      if (outcome.kind !== 'merged') {
        throw new Error(`expected a merge, got ${outcome.kind}`);
      }
      const review = new MemoryReviewService(
        db.em,
        new MemoryDao(db.em),
        new ProjectDao(db.em),
        db.usage,
        new RunDao(db.em),
        db.service,
      );
      const readsOfMerged = async () =>
        (await review.page({ tab: 'cold', minAgeDays: 0 })).rows.find(
          (row) => row.entry.id === outcome.result.entry.id,
        )?.usage.reads;

      expect(await readsOfMerged()).toBe(5);

      await db.service.change(first.id, { status: 'active' });

      expect(await readsOfMerged()).toBe(2);
    });

    it('refuses fewer than two distinct sources, and a source already forgotten, forgetting nothing', async () => {
      const first = await seed('Pnpm workspace install');
      const second = await seed('Pnpm workspace layout');

      expect(
        await db.service.merge(mergeOf([first.id, first.id])),
      ).toMatchObject({ kind: 'refused', code: 'INVALID_ENTRY' });

      await db.service.setStatus(USER, second.id, 'forgotten');

      expect(
        await db.service.merge(mergeOf([first.id, second.id])),
      ).toMatchObject({ kind: 'refused', code: 'NOT_FOUND' });
      expect((await rowOf(first.id)).status).toBe('active');
      expect((await rowOf(second.id)).status).toBe('forgotten');
      expect(await db.em.fork().count(Memory)).toBe(2);
    });
  });

  describe('the automatic sweep', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const NOW = new Date(Date.UTC(2026, 10, 11, 12));
    const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);
    const ARMED = { ...DEFAULT_MEMORY_CONFIG, autoForgetAfterDays: 30 };

    async function at<T>(when: Date, work: () => Promise<T>): Promise<T> {
      vi.useFakeTimers({ now: when, toFake: ['Date'] });
      try {
        return await work();
      } finally {
        vi.useRealTimers();
      }
    }

    async function seedAgent(
      title: string,
      place: RunPlace = NONE,
      type?: 'feedback',
    ) {
      return at(daysAgo(60), async () =>
        created(
          await db.service.save(AGENT, { title, body: 'x', type }, place),
        ),
      );
    }

    async function runAt(
      id: string,
      when: Date,
      extra: Partial<Run> = {},
    ): Promise<void> {
      await at(when, async () => {
        const em = db.em.fork();
        em.persist(make(Run, { id, status: 'completed', ...extra }));
        await em.flush();
      });
    }

    async function statusOf(id: string) {
      return (await db.em.fork().findOneOrFail(Memory, { id })).status;
    }

    async function raw(
      id: string,
      set: Partial<MemoryTextDatabase['memories']>,
    ) {
      await db.em
        .fork()
        .getKysely<MemoryTextDatabase>()
        .updateTable('memories')
        .set(set)
        .where('id', '=', id)
        .execute();
    }

    beforeEach(async () => {
      db.service.setConfig(ARMED);
      await db.usage.markBackfilled();
      await runAt('r-recent', daysAgo(1));
    });

    it('the sweep skips kept, warned and pending entries, and a dormant project', async () => {
      const cold = await seedAgent('Cold global');
      const kept = await seedAgent('Kept entry');
      await db.service.setKept(kept.id, true);
      const correction = await seedAgent('A correction', NONE, 'feedback');
      const mine = await at(daysAgo(60), async () =>
        created(
          await db.service.save(USER, { title: 'Mine', body: 'x' }, NONE),
        ),
      );
      db.service.setConfig({ ...ARMED, agentWrites: 'pending' });
      const pending = await seedAgent('Waiting entry');
      db.service.setConfig(ARMED);
      const live = await seedAgent('Live project', inProject('p-live'));
      const dormant = await seedAgent('Dormant project', inProject('p-old'));
      await runAt('r-live', daysAgo(5), { projectId: 'p-live' });
      await runAt('r-old', daysAgo(45), { projectId: 'p-old' });

      const result = await db.service.sweepCold(NOW);

      expect(result).toMatchObject({ forgotten: 2, skipped: [] });
      expect(result?.batchId).toEqual(expect.any(String));
      expect(await statusOf(cold.id)).toBe('forgotten');
      expect(await statusOf(live.id)).toBe('forgotten');
      expect(await statusOf(kept.id)).toBe('active');
      expect(await statusOf(correction.id)).toBe('active');
      expect(await statusOf(mine.id)).toBe('active');
      expect(await statusOf(pending.id)).toBe('pending');
      expect(await statusOf(dormant.id)).toBe('active');
      expect(
        (await db.em.fork().findOneOrFail(Memory, { id: cold.id }))
          .forgetBatchId,
      ).toBe(result?.batchId);
    });

    it('sweeps a team’s entries only while the team has a recent run', async () => {
      const live = await seedAgent('Live team entry');
      const quiet = await seedAgent('Quiet team entry');
      await raw(live.id, { team_slug: 't-live' });
      await raw(quiet.id, { team_slug: 't-quiet' });
      await runAt('r-team-live', daysAgo(3), { teamId: 't-live' });
      await runAt('r-team-quiet', daysAgo(40), { teamId: 't-quiet' });

      await db.service.sweepCold(NOW);

      expect(await statusOf(live.id)).toBe('forgotten');
      expect(await statusOf(quiet.id)).toBe('active');
    });

    it('leaves every global entry when no run was started lately', async () => {
      const fresh = await memoryDb();
      try {
        fresh.service.setConfig(ARMED);
        await fresh.usage.markBackfilled();
        const entry = await at(daysAgo(60), async () =>
          created(
            await fresh.service.save(
              AGENT,
              { title: 'Quiet', body: 'x' },
              NONE,
            ),
          ),
        );

        expect(await fresh.service.sweepCold(NOW)).toMatchObject({
          batchId: null,
          forgotten: 0,
        });
        expect(
          (await fresh.em.fork().findOneOrFail(Memory, { id: entry.id }))
            .status,
        ).toBe('active');
      } finally {
        await fresh.orm.close();
      }
    });

    it('does nothing while memory is off or before the backfill finished', async () => {
      const entry = await seedAgent('Cold global');

      db.service.setConfig({ ...ARMED, enabled: false });
      expect(await db.service.sweepCold(NOW)).toBeNull();

      const counting = await memoryDb();
      try {
        counting.service.setConfig(ARMED);
        expect(counting.usage.backfillMarker?.doneVersion).toBeNull();
        expect(await counting.service.sweepCold(NOW)).toBeNull();
      } finally {
        await counting.orm.close();
      }

      expect(await statusOf(entry.id)).toBe('active');
    });

    it('lists its batch as automatic, beside a hand-made one that is not', async () => {
      const cold = await seedAgent('Cold global');
      const mine = await seedAgent('Picked by hand');
      const byHand = await db.service.forgetBatch([mine.id]);
      const swept = await db.service.sweepCold(NOW);
      const review = new MemoryReviewService(
        db.em,
        new MemoryDao(db.em),
        new ProjectDao(db.em),
        db.usage,
        new RunDao(db.em),
        db.service,
      );

      const { batches } = await review.batches();

      expect(await statusOf(cold.id)).toBe('forgotten');
      expect(
        Object.fromEntries(
          batches.map((batch) => [batch.batchId, batch.automatic]),
        ),
      ).toEqual({ [byHand.batchId!]: false, [swept!.batchId!]: true });
    });

    it('is off by default', async () => {
      const entry = await seedAgent('Cold global');

      db.service.setConfig(DEFAULT_MEMORY_CONFIG);
      expect(DEFAULT_MEMORY_CONFIG.autoForgetAfterDays).toBeNull();
      expect(await db.service.sweepCold(NOW)).toBeNull();

      const unpushed = await memoryDb();
      try {
        await unpushed.usage.markBackfilled();
        expect(await unpushed.service.sweepCold(NOW)).toBeNull();
      } finally {
        await unpushed.orm.close();
      }

      expect(await statusOf(entry.id)).toBe('active');
    });

    it('its batch restores whole', async () => {
      const first = await seedAgent('Cold one');
      const second = await seedAgent('Cold two');

      const result = await db.service.sweepCold(NOW);

      expect(result?.forgotten).toBe(2);
      expect(await db.service.restoreBatch(result!.batchId!)).toEqual({
        restored: 2,
      });
      expect(await statusOf(first.id)).toBe('active');
      expect(await statusOf(second.id)).toBe('active');
    });

    it('a restored batch is not swept again inside the window', async () => {
      const entry = await seedAgent('Cold one');
      const swept = await at(NOW, () => db.service.sweepCold(NOW));
      await at(NOW, () => db.service.restoreBatch(swept!.batchId!));

      expect(
        await db.service.sweepCold(new Date(NOW.getTime() + 29 * DAY)),
      ).toMatchObject({ batchId: null, forgotten: 0 });
      expect(await statusOf(entry.id)).toBe('active');
      await runAt('r-later', new Date(NOW.getTime() + 30 * DAY));
      expect(
        (await db.service.sweepCold(new Date(NOW.getTime() + 31 * DAY)))
          ?.forgotten,
      ).toBe(1);
    });

    it('an entry edited, approved or read inside the window is not swept', async () => {
      const edited = await seedAgent('Edited entry');
      const approved = await seedAgent('Approved entry');
      const read = await seedAgent('Read entry');
      const stamped = await seedAgent('Stamped entry');
      const untouched = await seedAgent('Untouched entry');
      await at(daysAgo(2), async () =>
        db.service.save(
          AGENT,
          {
            handle: edited.handle,
            rev: edited.rev,
            title: 'Edited entry',
            body: 'y',
          },
          NONE,
        ),
      );
      await raw(approved.id, { approved_at: daysAgo(2).getTime() });
      await at(daysAgo(2), () => db.service.read([read.handle], NONE));
      await raw(read.id, { last_used_at: null });
      await raw(stamped.id, { last_used_at: daysAgo(2).getTime() });

      const result = await db.service.sweepCold(NOW);

      expect(result?.forgotten).toBe(1);
      expect(await statusOf(untouched.id)).toBe('forgotten');
      expect(await statusOf(edited.id)).toBe('active');
      expect(await statusOf(approved.id)).toBe('active');
      expect(await statusOf(read.id)).toBe('active');
      expect(await statusOf(stamped.id)).toBe('active');
    });

    it('runs a while after the start, then once a day, until shutdown', () => {
      vi.useFakeTimers();
      const sweep = vi.spyOn(db.service, 'sweepCold').mockResolvedValue(null);
      try {
        db.service.onModuleInit();

        vi.advanceTimersByTime(4 * 60 * 1000);
        expect(sweep).not.toHaveBeenCalled();
        vi.advanceTimersByTime(60 * 1000);
        expect(sweep).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(DAY);
        expect(sweep).toHaveBeenCalledTimes(2);

        db.service.onApplicationShutdown();
        vi.advanceTimersByTime(2 * DAY);
        expect(sweep).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a failing run is logged and the next day runs again', async () => {
      vi.useFakeTimers();
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const sweep = vi
        .spyOn(db.service, 'sweepCold')
        .mockRejectedValueOnce(new Error('database is locked'))
        .mockResolvedValue(null);
      try {
        db.service.onModuleInit();

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(warn).toHaveBeenCalledWith(
          'memory auto-forget failed: database is locked',
        );
        await vi.advanceTimersByTimeAsync(DAY);
        expect(sweep).toHaveBeenCalledTimes(2);
      } finally {
        db.service.onApplicationShutdown();
        warn.mockRestore();
        vi.useRealTimers();
      }
    });

    it('never purges: a swept entry keeps its text', async () => {
      const entry = await seedAgent('Cold global');

      await db.service.sweepCold(NOW);

      const row = await db.em.fork().findOneOrFail(Memory, { id: entry.id });
      expect([row.title, row.body, row.purgedTextHash]).toEqual([
        'Cold global',
        'x',
        null,
      ]);
    });
  });

  describe('purge', () => {
    beforeEach(() => {
      db.service.setConfig(DEFAULT_MEMORY_CONFIG);
    });

    async function tombstone(id: string) {
      return db.em
        .fork()
        .getKysely<MemoryTextDatabase>()
        .selectFrom('memories')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    }

    it('a purge frees no handle and erases the text from search', async () => {
      await db.service.save(USER, { title: 'Keep me', body: 'x' }, NONE);
      const top = created(
        await db.service.save(
          USER,
          { title: 'Pomegranate rule', body: 'Pomegranate seeds.' },
          NONE,
        ),
      );
      await db.service.setStatus(USER, top.id, 'forgotten');

      expect(await db.service.purge(top.id)).toEqual({
        id: top.id,
        handle: 'm2',
      });

      expect(
        await db.em
          .fork()
          .getKysely<MemoryTextDatabase>()
          .selectFrom('memories_fts')
          .select('memory_id')
          .where('memories_fts', '=', 'pomegranate')
          .execute(),
      ).toEqual([]);
      const next = created(
        await db.service.save(USER, { title: 'After purge', body: 'x' }, NONE),
      );
      expect(next.handle).toBe('m3');
      const row = await tombstone(top.id);
      expect([row.title, row.body, row.deleted_at !== null]).toEqual([
        '',
        '',
        true,
      ]);
      expect(await db.service.get(top.id)).toBeNull();
    });

    it('refuses an entry that is not forgotten', async () => {
      const active = created(
        await db.service.save(USER, { title: 'Live entry', body: 'x' }, NONE),
      );

      expect(await db.service.purge(active.id)).toBe('not-forgotten');
      expect(await db.service.purge('no-such-id')).toBe('missing');
      await db.service.setStatus(USER, active.id, 'forgotten');
      await db.service.purge(active.id);
      expect(await db.service.purge(active.id)).toBe('missing');
      expect((await tombstone(active.id)).title).toBe('');
    });

    it('usage figures survive a purge', async () => {
      const entry = created(
        await db.service.save(USER, { title: 'Read me', body: 'x' }, NONE),
      );
      await db.service.read([entry.handle], NONE);
      await db.service.setStatus(USER, entry.id, 'forgotten');

      await db.service.purge(entry.id);

      expect(
        (await db.usageDao.daysOf([entry.id])).map((day) => day.reads),
      ).toEqual([1]);
    });

    it('a purge clears the reason', async () => {
      const entry = created(
        await db.service.save(AGENT, { title: 'Stale entry', body: 'x' }, NONE),
      );
      await db.service.forget(
        AGENT,
        entry.handle,
        'Stale entry is wrong',
        NONE,
      );

      await db.service.purge(entry.id);

      const row = await tombstone(entry.id);
      expect([row.forget_reason, row.forget_batch_id]).toEqual([null, null]);
    });

    it('a purge erases every finding that quotes the entry, on either side', async () => {
      const save = async (title: string) =>
        created(await db.service.save(USER, { title, body: 'x' }, NONE));
      const gone = await save('Purged entry');
      const left = await save('Left entry');
      const right = await save('Right entry');
      const finding = (aId: string, bId: string) => ({
        memoryAId: aId,
        memoryBId: bId,
        hashA: 'hash-a',
        hashB: 'hash-b',
        outcome: 'contradicts' as const,
        quoteA: 'Purged entry',
        quoteB: 'Left entry',
        reason: 'they disagree',
        agentKind: AgentKind.Claude,
        model: null,
      });
      await db.findings.record([
        finding(gone.id, left.id),
        finding(right.id, gone.id),
        finding(left.id, right.id),
      ]);
      await db.service.setStatus(USER, gone.id, 'forgotten');

      await db.service.purge(gone.id);

      const stored = await db.em
        .fork()
        .getKysely<MemoryTextDatabase>()
        .selectFrom('memory_review_findings')
        .select(['memory_a_id', 'memory_b_id'])
        .execute();
      expect(stored).toEqual([{ memory_a_id: left.id, memory_b_id: right.id }]);
    });

    it('empties a batch-forgotten entry without moving its edit time, and announces it once', async () => {
      const entry = created(
        await db.service.save(USER, { title: 'Batch entry', body: 'x' }, NONE),
      );
      await db.service.forgetBatch([entry.id]);
      const before = await tombstone(entry.id);
      const published: MemoryChangedEvent[] = [];
      db.events.allChanges().subscribe((event) => published.push(event));

      await db.service.purge(entry.id);

      const row = await tombstone(entry.id);
      expect([row.forget_batch_id, row.updated_at]).toEqual([
        null,
        before.updated_at,
      ]);
      expect(published).toEqual([
        {
          memoryId: null,
          change: 'bulk',
          status: 'forgotten',
          projectId: null,
          teamSlug: null,
        },
      ]);
    });

    it('keeps a text hash for an imported entry only', async () => {
      const mine = created(
        await db.service.save(USER, { title: 'Mine', body: 'x' }, NONE),
      );
      await db.service.importNotes([
        {
          key: 'k1',
          title: 'Imported',
          body: 'y',
          type: 'project',
          projectId: null,
          importedFrom: '/n.md',
        },
      ]);
      const imported = await db.em
        .fork()
        .findOneOrFail(Memory, { title: 'Imported' });
      await db.service.forgetAll();

      await db.service.purge(mine.id);
      await db.service.purge(imported.id);

      expect((await tombstone(mine.id)).purged_text_hash).toBeNull();
      expect((await tombstone(imported.id)).purged_text_hash).toBe(
        importedTextHash('Imported', 'y'),
      );
    });

    it('rolls the purge back when the findings cannot be dropped', async () => {
      const entry = created(
        await db.service.save(USER, { title: 'Stale entry', body: 'x' }, NONE),
      );
      const batch = await db.service.forgetBatch([entry.id]);
      vi.spyOn(
        MemoryReviewFindingDao.prototype,
        'deleteNaming',
      ).mockRejectedValueOnce(new Error('locked'));

      await expect(db.service.purge(entry.id)).rejects.toThrow('locked');

      const row = await tombstone(entry.id);
      expect([row.title, row.deleted_at, row.forget_batch_id]).toEqual([
        'Stale entry',
        null,
        batch.batchId,
      ]);
    });
  });

  describe('a lesson saved to memory', () => {
    const LESSON = { sourceRunId: 'run-lesson-src', proposalId: 'lp-1' };
    const LESSON_ENTRY = {
      title: 'Check before retrying',
      body: 'Change the check input before rerunning it.',
      type: 'feedback' as const,
      projectId: 'p1',
      teamSlug: null,
    };

    async function project() {
      const em = db.em.fork();
      em.persist(make(Project, { id: 'p1', name: 'App', folder: '/repo/app' }));
      await em.flush();
    }

    beforeEach(() => {
      db.service.setConfig({
        enabled: true,
        agentWrites: 'pending',
        nativeMemoryOff: false,
        autoForgetAfterDays: null,
        removeNotUseful: true,
      });
    });

    it('lands active while agent writes wait for review, naming its thread and proposal', async () => {
      await project();

      const saved = savedOf(await db.service.create(LESSON_ENTRY, LESSON));
      const agentWrite = created(
        await db.service.save(
          AGENT,
          { title: 'Agent note', body: 'x' },
          inProject('p1'),
        ),
      );

      expect(agentWrite.status).toBe('pending');
      expect(saved.status).toBe('active');
      expect(saved.source.runId).toBe('run-lesson-src');
      const row = await db.em.fork().findOneOrFail(Memory, { id: saved.id });
      expect(row.lessonProposalId).toBe('lp-1');
    });

    it('is in the memory index of the project it was filed under', async () => {
      await project();
      const saved = savedOf(await db.service.create(LESSON_ENTRY, LESSON));

      const { memoryIndex, indexIds } = await db.service.runSnapshot({
        taskId: null,
        cwd: '/repo/app',
      });

      expect(indexIds).toEqual([saved.id]);
      expect(memoryIndex?.split('\n')).toContainEqual(
        expect.stringContaining(` ${LESSON_ENTRY.title} (`),
      );
    });
  });
  describe('a lessons reflection as a writer', () => {
    beforeEach(() => {
      db.service.setConfig(DEFAULT_MEMORY_CONFIG);
    });

    async function analysisActor(
      id: string,
      analysisPurpose: 'lessons' | 'review',
    ) {
      const em = db.em.fork();
      em.persist(
        make(Run, {
          id,
          status: 'running',
          agentKind: 'claude',
          model: 'opus',
          analysisSourceRunId: 'source',
          analysisPurpose,
        }),
      );
      await em.flush();
      return db.service.actorOf(id, 'agent');
    }

    it('is refused a save and a forget, leaving the entry as it was', async () => {
      const reflection = await analysisActor('reflection', 'lessons');
      const kept = savedOf(
        await db.service.save(USER, { title: 'Kept', body: 'x' }, NONE),
      );

      expect(
        await db.service.save(reflection, { title: 'Lesson', body: 'y' }, NONE),
      ).toMatchObject({ kind: 'refused', code: 'REFLECTION_READ_ONLY' });
      expect(
        await db.service.forget(reflection, kept.handle, 'no', NONE),
      ).toMatchObject({ kind: 'refused', code: 'REFLECTION_READ_ONLY' });
      expect((await db.service.get(kept.id))?.status).toBe('active');
    });

    it('is not refused as a review analysis is not, a save or a forget', async () => {
      const review = await analysisActor('review', 'review');
      const kept = savedOf(
        await db.service.save(USER, { title: 'Kept', body: 'x' }, NONE),
      );

      expect(
        await db.service.save(
          review,
          { title: 'Review note', body: 'y' },
          NONE,
        ),
      ).toMatchObject({ kind: 'created' });
      expect(
        await db.service.forget(review, kept.handle, 'no', NONE),
      ).toMatchObject({ kind: 'forgotten' });
    });
  });
});

describe('MemoryService.fileLesson', () => {
  let db: Awaited<ReturnType<typeof memoryDb>>;

  const LESSON: Extract<MemoryActor, { kind: 'lesson' }> = {
    kind: 'lesson',
    runId: 'refl-1',
    agentKind: 'claude',
    model: 'opus',
  };
  const SOURCE = { sourceRunId: 'src-1', proposalId: 'lp-1' };
  const FACTS = { taskId: null, cwd: '/repo/app' };

  beforeEach(async () => {
    db = await memoryDb();
    db.service.setConfig(DEFAULT_MEMORY_CONFIG);
  });

  afterEach(async () => {
    await db.orm.close();
  });

  it('writes an active entry stamped as a lesson, naming its thread and proposal', async () => {
    const entry = created(
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

    expect(entry).toMatchObject({
      status: 'active',
      type: 'feedback',
      approvedAt: null,
      source: {
        actor: 'lesson',
        agentKind: 'claude',
        model: 'opus',
        runId: 'src-1',
        importedFrom: null,
      },
    });
    const row = await db.em.fork().findOneOrFail(Memory, { id: entry.id });
    expect(row.lessonProposalId).toBe('lp-1');
  });

  it('keeps the entry out of the next run’s index but finds it by search', async () => {
    await db.service.fileLesson(
      LESSON,
      { title: 'Check before retrying', body: 'zebra rule', type: 'feedback' },
      NONE,
      SOURCE,
    );

    const snapshot = await db.service.runSnapshot(FACTS);
    const hits = await db.service.search('zebra', NONE, 10);

    expect(snapshot.indexIds).toEqual([]);
    expect(snapshot.memoryIndex ?? '').not.toContain('Check before retrying');
    expect(hits.map((hit) => hit.title)).toEqual(['Check before retrying']);
  });

  it('lands the entry pending while the user reviews agent writes', async () => {
    db.service.setConfig({ ...DEFAULT_MEMORY_CONFIG, agentWrites: 'pending' });

    const entry = created(
      await db.service.fileLesson(
        LESSON,
        { title: 'Check before retrying', body: 'x', type: 'feedback' },
        NONE,
        SOURCE,
      ),
    );

    expect(entry.status).toBe('pending');
    expect(entry.source.actor).toBe('lesson');
  });

  it('writes nothing for a near duplicate of an active entry', async () => {
    await db.service.save(
      USER,
      { title: 'Always run pnpm full-check', body: 'before finishing' },
      NONE,
    );

    const outcome = await db.service.fileLesson(
      LESSON,
      { title: 'Run pnpm full-check always', body: 'again', type: 'feedback' },
      NONE,
      SOURCE,
    );

    expect(outcome.kind).toBe('near_duplicate');
    expect(await db.em.fork().count(Memory, {})).toBe(1);
  });
});
