import type { MikroORM } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import { make } from '../../memory/__tests__/memory-db';
import type { MemoryService } from '../../memory/services/memory.service';
import { Project } from '../../projects/entity/project.entity';
import type { RunPlace } from '../../projects/projects.types';
import { Run } from '../../runs/entity/run.entity';
import { knowledgeDb } from '../__tests__/knowledge-db';
import { KnowledgeRevision } from '../entity/knowledge-revision.entity';
import {
  DEFAULT_KNOWLEDGE_CONFIG,
  KNOWLEDGE_INDEX_MAX_BYTES,
  KNOWLEDGE_REVISIONS_KEPT,
  KNOWLEDGE_TITLE_MAX_CHARS,
  type KnowledgeActor,
  type KnowledgeChangedEvent,
  type KnowledgeItemWrite,
  type KnowledgeSaveOutcome,
} from '../knowledge.types';
import type { KnowledgeService } from './knowledge.service';
import type { KnowledgeEventBus } from './knowledge-events.bus';
import type { KnowledgeTextIndexService } from './knowledge-text-index.service';

const AGENT: KnowledgeActor = {
  kind: 'agent',
  runId: 'run-1',
  memberId: 'senior',
  agentKind: 'claude',
  model: 'opus',
};
const NOWHERE: RunPlace = { projectId: null, teamSlug: null };
const IN_P1: RunPlace = { projectId: 'p1', teamSlug: null };
const P1_T1: RunPlace = { projectId: 'p1', teamSlug: 't1' };
const SECRET = 'geniro-test-token-9f3a2b7c';

const doc = (
  over: Partial<Parameters<KnowledgeService['create']>[0]> = {},
) => ({
  place: 'global',
  title: 'Release checklist',
  whenToRead: 'Cutting a release.',
  body: 'Tag only after CI is green.',
  ...over,
});

describe('KnowledgeService', () => {
  let orm: MikroORM;
  let service: KnowledgeService;
  let events: KnowledgeEventBus;
  let index: () => KnowledgeTextIndexService;
  let memory: MemoryService;

  const applied = (outcome: KnowledgeSaveOutcome) => {
    if (outcome.kind !== 'applied') {
      throw new Error(`expected applied, got ${JSON.stringify(outcome)}`);
    }
    return outcome.document;
  };
  const proposed = (outcome: KnowledgeSaveOutcome) => {
    if (outcome.kind !== 'proposed') {
      throw new Error(`expected proposed, got ${JSON.stringify(outcome)}`);
    }
    return outcome.document;
  };
  const refusalOf = (outcome: { kind: string; code?: string }) =>
    outcome.kind === 'refused' ? outcome.code : `not refused: ${outcome.kind}`;
  const pendingOf = async (id: string) => {
    const { revisions } = await service.revisions(id);
    const pending = revisions.find((row) => row.status === 'pending');
    if (!pending) {
      throw new Error('no pending revision');
    }
    return pending;
  };
  const ftsRows = async (id: string) => {
    const rows = await orm.em
      .fork()
      .getKysely<{ knowledge_fts: { document_id: string } }>({
        convertValues: false,
      })
      .selectFrom('knowledge_fts')
      .select('document_id')
      .where('document_id', '=', id)
      .execute();
    return rows.length;
  };

  beforeEach(async () => {
    const db = await knowledgeDb();
    orm = db.orm;
    service = db.service;
    events = db.events;
    index = db.index;
    memory = db.memory;
    const em = orm.em.fork();
    em.persist(make(Project, { id: 'p1', name: 'Atlas', folder: '/atlas' }));
    await em.flush();
  });

  afterEach(async () => {
    await orm.close();
  });

  describe('handles', () => {
    it('keeps one handle per place and refuses a duplicate in Global', async () => {
      applied(await service.create(doc({ handle: 'release' })));
      applied(
        await service.create(doc({ handle: 'release', place: 'project:p1' })),
      );
      expect(refusalOf(await service.create(doc({ handle: 'release' })))).toBe(
        'HANDLE_TAKEN',
      );
    });

    it('derives a free handle from the title when none is given', async () => {
      const first = applied(await service.create(doc()));
      const second = applied(await service.create(doc()));
      expect([first.handle, second.handle]).toEqual([
        'release-checklist',
        'release-checklist-2',
      ]);
    });

    it('takes a Cyrillic handle and refuses an uppercase one', async () => {
      expect(
        applied(await service.create(doc({ handle: 'чек-лист' }))).handle,
      ).toBe('чек-лист');
      expect(refusalOf(await service.create(doc({ handle: 'Release' })))).toBe(
        'INVALID_DOCUMENT',
      );
    });

    it('refuses a project or team that does not exist', async () => {
      expect(
        refusalOf(await service.create(doc({ place: 'project:nope' }))),
      ).toBe('NO_PROJECT');
      service.useTeamLookup(async () => false);
      expect(refusalOf(await service.create(doc({ place: 'team:nope' })))).toBe(
        'NO_TEAM',
      );
    });
  });

  describe('visibility', () => {
    beforeEach(async () => {
      applied(
        await service.create(doc({ handle: 'same', body: 'from global' })),
      );
      applied(
        await service.create(
          doc({ handle: 'same', place: 'team:t1', body: 'from team' }),
        ),
      );
      applied(
        await service.create(
          doc({ handle: 'same', place: 'project:p1', body: 'from project' }),
        ),
      );
    });

    it('gives the nearest place the handle in list, search and read alike', async () => {
      const read = await service.read(P1_T1, 'same');
      expect(read.kind === 'found' && read.document.body).toBe('from project');
      const listed = await service.search(P1_T1, undefined);
      expect(listed.hits.map((hit) => hit.level)).toEqual(['project']);
      const found = await service.search(P1_T1, 'global');
      expect(found.hits).toEqual([]);
      const team = await service.read(
        { projectId: null, teamSlug: 't1' },
        'same',
      );
      expect(team.kind === 'found' && team.document.body).toBe('from team');
      const none = await service.read(NOWHERE, 'same');
      expect(none.kind === 'found' && none.document.body).toBe('from global');
    });

    it('never answers with another project', async () => {
      applied(
        await service.create(doc({ handle: 'only-p1', place: 'project:p1' })),
      );
      expect(
        (await service.read({ projectId: 'p2', teamSlug: null }, 'only-p1'))
          .kind,
      ).toBe('missing');
    });

    it('names similar handles when one is not there', async () => {
      applied(await service.create(doc({ title: 'Seed data recipe' })));
      const missing = await service.read(NOWHERE, 'seed-data');
      expect(missing).toEqual({
        kind: 'missing',
        similar: ['seed-data-recipe'],
      });
    });
  });

  describe('search', () => {
    it('finds a title before a body', async () => {
      applied(
        await service.create(
          doc({ title: 'Other', handle: 'in-body', body: 'rollback steps' }),
        ),
      );
      applied(
        await service.create(
          doc({
            title: 'Other two',
            handle: 'in-when',
            whenToRead: 'Doing a rollback.',
          }),
        ),
      );
      applied(
        await service.create(doc({ title: 'Rollback', handle: 'in-title' })),
      );
      const { hits } = await service.search(NOWHERE, 'rollback');
      expect(hits.map((hit) => hit.handle)).toEqual([
        'in-title',
        'in-when',
        'in-body',
      ]);
    });

    it('retries with OR when every term finds nothing', async () => {
      applied(
        await service.create(
          doc({ title: 'Инструкция по релизу', handle: 'релиз' }),
        ),
      );
      expect(
        (await service.search(NOWHERE, 'инструкция zzzqqq')).hits.map(
          (hit) => hit.handle,
        ),
      ).toEqual(['релиз']);
    });

    it('finds the words an edit adds and stops finding the ones it removes', async () => {
      const live = applied(
        await service.create(doc({ handle: 'edited', body: 'alpha bravo' })),
      );
      applied(
        await service.edit(live.id, {
          rev: live.rev,
          title: live.title,
          whenToRead: live.whenToRead,
          body: 'alpha charlie',
        }),
      );
      expect(
        (await service.search(NOWHERE, 'charlie')).hits.map(
          (hit) => hit.handle,
        ),
      ).toEqual(['edited']);
      expect((await service.search(NOWHERE, 'bravo')).hits).toEqual([]);
    });

    it('survives text FTS5 would read as syntax', async () => {
      expect((await service.search(NOWHERE, '"NEAR( --')).hits).toEqual([]);
    });
  });

  describe('agent writes', () => {
    it('never serves a pending revision, for a proposed document or a pending change', async () => {
      const made = proposed(
        await service.save(
          AGENT,
          {
            title: 'Secret plan',
            whenToRead: 'Never.',
            body: 'proposed text',
            reason: 'found it useful',
          },
          NOWHERE,
        ),
      );
      expect(made.status).toBe('proposed');
      expect(made.rev).toBe(0);
      expect((await service.read(NOWHERE, made.handle)).kind).toBe('missing');
      expect((await service.search(NOWHERE, 'proposed')).hits).toEqual([]);

      const live = applied(await service.create(doc({ body: 'live text' })));
      proposed(
        await service.save(
          AGENT,
          {
            handle: live.handle,
            rev: live.rev,
            edits: [{ find: 'live', replace: 'pending' }],
            reason: 'better',
          },
          NOWHERE,
        ),
      );
      const read = await service.read(NOWHERE, live.handle);
      expect(read.kind === 'found' && read.document.body).toBe('live text');
      expect((await service.search(NOWHERE, 'pending')).hits).toEqual([]);
      expect(await snapshot(service)).not.toContain('Secret plan');
    });

    it('reserves a proposed handle and frees it on reject', async () => {
      const made = proposed(
        await service.save(
          AGENT,
          { title: 'Plan', whenToRead: 'W.', body: 'B', reason: 'r' },
          NOWHERE,
        ),
      );
      expect(
        refusalOf(await service.create(doc({ handle: made.handle }))),
      ).toBe('HANDLE_TAKEN');
      await service.reject((await pendingOf(made.id)).id);
      expect(await service.get(made.id)).toBeNull();
      applied(await service.create(doc({ handle: made.handle })));
    });

    it('publishes a proposed document on approve at rev 1', async () => {
      const made = proposed(
        await service.save(
          AGENT,
          { title: 'Plan', whenToRead: 'W.', body: 'B', reason: 'r' },
          NOWHERE,
        ),
      );
      const done = applied(
        await service.approve((await pendingOf(made.id)).id),
      );
      expect(done.status).toBe('active');
      expect(done.rev).toBe(1);
      expect(done.approvedAt).not.toBeNull();
      expect((await service.read(NOWHERE, made.handle)).kind).toBe('found');
    });

    it('refuses approving a stale proposal', async () => {
      const live = applied(await service.create(doc()));
      proposed(
        await service.save(
          AGENT,
          {
            handle: live.handle,
            rev: live.rev,
            edits: [{ find: 'green', replace: 'red' }],
            reason: 'r',
          },
          NOWHERE,
        ),
      );
      const pending = await pendingOf(live.id);
      applied(
        await service.edit(live.id, {
          rev: live.rev,
          title: live.title,
          whenToRead: live.whenToRead,
          body: 'newer text',
        }),
      );
      expect((await service.revision(pending.id))?.stale).toBe(true);
      expect(refusalOf(await service.approve(pending.id))).toBe(
        'PROPOSAL_STALE',
      );
      expect((await service.get(live.id))?.body).toBe('newer text');
    });

    it('applies edits only when every find is unique', async () => {
      const live = applied(await service.create(doc({ body: 'one two two' })));
      service.setConfig({ enabled: true, agentWrites: 'direct' });
      const save = (find: string) =>
        service.save(
          AGENT,
          {
            handle: live.handle,
            rev: live.rev,
            edits: [
              { find: 'one', replace: 'uno' },
              { find, replace: 'x' },
            ],
            reason: 'r',
          },
          NOWHERE,
        );
      const repeated = await save('two');
      expect(refusalOf(repeated)).toBe('INVALID_EDITS');
      expect(repeated.kind === 'refused' && repeated.reason).toContain(
        'edit 2: find appears more than once',
      );
      const missing = await save('three');
      expect(missing.kind === 'refused' && missing.reason).toContain(
        'edit 2: find is not in the document',
      );
      expect((await service.get(live.id))?.body).toBe('one two two');
    });

    it('refuses a whole body on an existing document', async () => {
      const live = applied(await service.create(doc()));
      expect(
        refusalOf(
          await service.save(
            AGENT,
            {
              handle: live.handle,
              rev: live.rev,
              body: 'everything',
              reason: 'r',
            },
            NOWHERE,
          ),
        ),
      ).toBe('INVALID_DOCUMENT');
    });

    it('answers stale with the current text when the rev moved', async () => {
      const live = applied(await service.create(doc()));
      const outcome = await service.save(
        AGENT,
        {
          handle: live.handle,
          rev: 7,
          edits: [{ find: 'green', replace: 'red' }],
          reason: 'r',
        },
        NOWHERE,
      );
      expect(outcome.kind).toBe('stale');
    });

    it('applies at once in direct mode and clears the approval', async () => {
      service.setConfig({ enabled: true, agentWrites: 'direct' });
      const live = applied(await service.create(doc()));
      const done = applied(
        await service.save(
          AGENT,
          {
            handle: live.handle,
            rev: live.rev,
            edits: [{ find: 'green', replace: 'red' }],
            reason: 'r',
          },
          NOWHERE,
        ),
      );
      expect(done.rev).toBe(2);
      expect(done.approvedAt).toBeNull();
      expect(done.source.actor).toBe('agent');
      const made = applied(
        await service.save(
          AGENT,
          { title: 'Direct', whenToRead: 'W.', body: 'B', reason: 'r' },
          NOWHERE,
        ),
      );
      expect(made.status).toBe('active');
      expect(made.rev).toBe(1);
      expect(made.approvedAt).toBeNull();
    });

    it('refuses agent writes while the user lets agents only read, or turned it off', async () => {
      const input = { title: 'T', whenToRead: 'W.', body: 'B', reason: 'r' };
      service.setConfig({ enabled: true, agentWrites: 'off' });
      expect(refusalOf(await service.save(AGENT, input, NOWHERE))).toBe(
        'KNOWLEDGE_READ_ONLY',
      );
      service.setConfig({ enabled: false, agentWrites: 'review' });
      expect(refusalOf(await service.save(AGENT, input, NOWHERE))).toBe(
        'KNOWLEDGE_DISABLED',
      );
    });

    it('caps the changes waiting on one document', async () => {
      const live = applied(await service.create(doc({ body: 'word' })));
      const save = () =>
        service.save(
          AGENT,
          {
            handle: live.handle,
            rev: live.rev,
            edits: [{ find: 'word', replace: 'other' }],
            reason: 'r',
          },
          NOWHERE,
        );
      for (let i = 0; i < 20; i += 1) {
        proposed(await save());
      }
      expect(refusalOf(await save())).toBe('TOO_MANY_PROPOSALS');
    });

    it('refuses a registered secret in the title, when to read, the text, the edit or the reason', async () => {
      registerSecret(SECRET, 'test key');
      try {
        const input = {
          title: 'Plan',
          whenToRead: 'W.',
          body: 'B',
          reason: 'r',
        };
        expect(
          refusalOf(
            await service.save(
              AGENT,
              { ...input, title: `Plan ${SECRET}` },
              NOWHERE,
            ),
          ),
        ).toBe('CONTAINS_SECRET');
        expect(
          refusalOf(
            await service.save(
              AGENT,
              { ...input, whenToRead: `When ${SECRET}` },
              NOWHERE,
            ),
          ),
        ).toBe('CONTAINS_SECRET');
        expect(
          refusalOf(
            await service.save(
              AGENT,
              { ...input, body: `Use ${SECRET}` },
              NOWHERE,
            ),
          ),
        ).toBe('CONTAINS_SECRET');
        expect(
          refusalOf(
            await service.save(
              AGENT,
              { ...input, reason: `for ${SECRET}` },
              NOWHERE,
            ),
          ),
        ).toBe('CONTAINS_SECRET');
        const live = applied(await service.create(doc()));
        expect(
          refusalOf(
            await service.save(
              AGENT,
              {
                handle: live.handle,
                rev: live.rev,
                edits: [{ find: 'green', replace: `red ${SECRET}` }],
                reason: 'r',
              },
              NOWHERE,
            ),
          ),
        ).toBe('CONTAINS_SECRET');
      } finally {
        clearSecrets();
      }
    });

    it('turns a change to an active document down and leaves the document as it was', async () => {
      const live = applied(await service.create(doc({ body: 'live text' })));
      proposed(
        await service.save(
          AGENT,
          {
            handle: live.handle,
            rev: live.rev,
            edits: [{ find: 'live', replace: 'pending' }],
            reason: 'better',
          },
          NOWHERE,
        ),
      );
      const pending = await pendingOf(live.id);
      expect(await service.reject(pending.id)).toEqual({
        kind: 'rejected',
        deleted: false,
      });
      const kept = await service.get(live.id);
      expect(kept?.body).toBe('live text');
      expect(kept?.rev).toBe(live.rev);
      expect(kept?.status).toBe('active');
      expect(kept?.pending).toBe(0);
      const { revisions } = await service.revisions(live.id);
      expect(revisions.find((row) => row.id === pending.id)?.status).toBe(
        'rejected',
      );
    });

    it('gives an agent document a suffix over a handle its run can see, nearer or farther', async () => {
      applied(
        await service.create(doc({ handle: 'handbook', body: 'global body' })),
      );
      applied(
        await service.create(
          doc({
            handle: 'atlas-notes',
            title: 'Atlas notes',
            place: 'project:p1',
            body: 'project body',
          }),
        ),
      );
      const farther = proposed(
        await service.save(
          AGENT,
          {
            title: 'Handbook',
            whenToRead: 'W.',
            body: 'B',
            reason: 'r',
            place: 'project',
          },
          IN_P1,
        ),
      );
      const nearer = proposed(
        await service.save(
          AGENT,
          {
            title: 'Atlas notes',
            whenToRead: 'W.',
            body: 'B',
            reason: 'r',
            place: 'global',
          },
          IN_P1,
        ),
      );
      expect([farther.handle, nearer.handle]).toEqual([
        'handbook-2',
        'atlas-notes-2',
      ]);
      const shadowed = await service.read(IN_P1, 'handbook');
      expect(shadowed.kind === 'found' && shadowed.document.body).toBe(
        'global body',
      );
      const own = await service.read(IN_P1, 'atlas-notes');
      expect(own.kind === 'found' && own.document.body).toBe('project body');
    });

    it('files a new document at the nearest level unless told otherwise', async () => {
      const save = (place: RunPlace, level?: 'global' | 'team' | 'project') =>
        service.save(
          AGENT,
          {
            title: `T ${level ?? 'x'}`,
            whenToRead: 'W.',
            body: 'B',
            reason: 'r',
            place: level,
          },
          place,
        );
      expect(proposed(await save(IN_P1)).place).toBe('project:p1');
      expect(proposed(await save(IN_P1, 'global')).place).toBe('global');
      expect(refusalOf(await save(IN_P1, 'team'))).toBe('NO_TEAM');
      expect(refusalOf(await save(NOWHERE, 'project'))).toBe('NO_PROJECT');
    });
  });

  describe('the user', () => {
    it('answers stale for a rev that moved and keeps the text', async () => {
      const live = applied(await service.create(doc()));
      const patch = {
        rev: live.rev,
        title: live.title,
        whenToRead: live.whenToRead,
        body: 'second',
      };
      applied(await service.edit(live.id, patch));
      expect((await service.edit(live.id, patch)).kind).toBe('stale');
    });

    it('archives and restores, and permanently deletes only what is archived', async () => {
      const live = applied(await service.create(doc()));
      expect(
        refusalOf((await service.remove(live.id)) ?? { kind: 'gone' }),
      ).toBe('NOT_EDITABLE');
      await service.setStatus(live.id, 'archived');
      expect((await service.read(NOWHERE, live.handle)).kind).toBe('missing');
      await service.setStatus(live.id, 'active');
      expect((await service.read(NOWHERE, live.handle)).kind).toBe('found');
      await service.setStatus(live.id, 'archived');
      expect(await service.remove(live.id)).toBeNull();
      expect(await ftsRows(live.id)).toBe(0);
      expect(await service.get(live.id)).toBeNull();
      expect((await service.revisions(live.id)).revisions).toEqual([]);
    });

    it('writes an old version as a new one', async () => {
      const live = applied(await service.create(doc({ body: 'first' })));
      const next = applied(
        await service.edit(live.id, {
          rev: 1,
          title: live.title,
          whenToRead: live.whenToRead,
          body: 'second',
        }),
      );
      const { revisions } = await service.revisions(live.id);
      const oldest = revisions.find((row) => row.rev === 1);
      const restored = applied(
        await service.restoreRevision(oldest?.id ?? '', next.rev),
      );
      expect(restored.rev).toBe(3);
      expect(restored.body).toBe('first');
    });

    it('diffs a revision against the version it was made from', async () => {
      const live = applied(await service.create(doc({ body: 'first' })));
      applied(
        await service.edit(live.id, {
          rev: 1,
          title: live.title,
          whenToRead: live.whenToRead,
          body: 'second',
        }),
      );
      const { revisions } = await service.revisions(live.id);
      const newest = revisions.find((row) => row.rev === 2);
      const detail = await service.revision(newest?.id ?? '');
      expect(detail?.diff).toContain('-first');
      expect(detail?.diff).toContain('+second');
    });

    it('keeps the newest decided revisions and every pending one', async () => {
      let rev = 1;
      const live = applied(await service.create(doc({ body: 'v0' })));
      proposed(
        await service.save(
          AGENT,
          {
            handle: live.handle,
            rev: 1,
            edits: [{ find: 'v0', replace: 'w' }],
            reason: 'r',
          },
          NOWHERE,
        ),
      );
      for (let i = 1; i <= KNOWLEDGE_REVISIONS_KEPT + 3; i += 1) {
        const done = applied(
          await service.edit(live.id, {
            rev,
            title: live.title,
            whenToRead: live.whenToRead,
            body: `v${i}`,
          }),
        );
        rev = done.rev;
      }
      const { revisions } = await service.revisions(live.id);
      expect(revisions.filter((row) => row.status === 'applied')).toHaveLength(
        KNOWLEDGE_REVISIONS_KEPT,
      );
      expect(revisions.filter((row) => row.status === 'pending')).toHaveLength(
        1,
      );
    });

    it('takes hidden characters out of a person’s text and keeps emoji and line breaks', async () => {
      const made = applied(
        await service.create(
          doc({
            title: 'Rel\u200bease',
            whenToRead: 'Bef\u202eore a tag',
            body: 'one\n\ttwo\u200b three\u{E0041} 👩\u200D💻',
          }),
        ),
      );
      expect(made.title).toBe('Release');
      expect(made.whenToRead).toBe('Before a tag');
      expect(made.body).toBe('one\n\ttwo three 👩\u200D💻');
      expect((await service.get(made.id))?.body).toBe(made.body);

      const edited = applied(
        await service.edit(made.id, {
          rev: made.rev,
          title: made.title,
          whenToRead: made.whenToRead,
          body: 'clean\u2060 text',
        }),
      );
      expect(edited.body).toBe('clean text');
    });

    it.each([
      ['title', 'the title must not be empty'],
      ['whenToRead', 'when to read must not be empty'],
      ['body', 'the text must not be empty'],
    ])(
      'refuses a person’s %s that is nothing but hidden characters as empty',
      async (field, reason) => {
        const refused = await service.create(doc({ [field]: '\u200b\u202e' }));
        expect(refused).toMatchObject({
          kind: 'refused',
          code: 'INVALID_DOCUMENT',
          reason,
        });
      },
    );

    it.each([
      ['title', 'the title holds'],
      ['whenToRead', 'when to read holds'],
    ])(
      'tells an agent its %s holds a hidden character, not a wrong length',
      async (field, reason) => {
        const hidden = await service.save(
          AGENT,
          {
            title: 'T',
            whenToRead: 'W.',
            body: 'text',
            reason: 'r',
            [field]: 'Rel\u200bease',
          },
          NOWHERE,
        );
        expect(hidden.kind === 'refused' && hidden.reason).toContain(reason);
      },
    );

    it('names the length of a title over the limit', async () => {
      const length = KNOWLEDGE_TITLE_MAX_CHARS + 1;
      const refused = await service.create(doc({ title: 'x'.repeat(length) }));
      expect(refused).toMatchObject({
        kind: 'refused',
        reason: `the title is ${length} characters; the limit is ${KNOWLEDGE_TITLE_MAX_CHARS}`,
      });
    });

    it('refuses a secret split by a hidden character', async () => {
      registerSecret(SECRET, 'test key');
      try {
        const split = `${SECRET.slice(0, 4)}\u200b${SECRET.slice(4)}`;
        expect(refusalOf(await service.create(doc({ body: split })))).toBe(
          'CONTAINS_SECRET',
        );
      } finally {
        clearSecrets();
      }
    });

    it('refuses a secret, and an agent’s hidden character naming the line', async () => {
      const hidden = await service.save(
        AGENT,
        {
          title: 'T',
          whenToRead: 'W.',
          body: 'one\ntwo\u200bthree',
          reason: 'r',
        },
        NOWHERE,
      );
      expect(hidden.kind === 'refused' && hidden.reason).toContain('line 2');
    });

    it('lists bodyless heads with the waiting filter and pages by cursor', async () => {
      const a = applied(await service.create(doc({ handle: 'a' })));
      applied(await service.create(doc({ handle: 'b' })));
      proposed(
        await service.save(
          AGENT,
          {
            handle: a.handle,
            rev: 1,
            edits: [{ find: 'green', replace: 'red' }],
            reason: 'r',
          },
          NOWHERE,
        ),
      );
      const made = proposed(
        await service.save(
          AGENT,
          { title: 'New', whenToRead: 'W.', body: 'B', reason: 'r' },
          IN_P1,
        ),
      );
      const waiting = await service.list({ status: 'waiting' });
      expect(waiting.documents.map((row) => row.id).sort()).toEqual(
        [a.id, made.id].sort(),
      );
      expect(Object.keys(waiting.documents[0] ?? {})).not.toContain('body');
      const first = await service.list({ limit: 1 });
      expect(first.documents).toHaveLength(1);
      const second = await service.list({
        limit: 1,
        cursor: first.next ?? undefined,
      });
      expect(second.documents[0]?.id).not.toBe(first.documents[0]?.id);
      expect((await service.list({ place: 'project:p1' })).documents).toEqual(
        [],
      );
    });

    it('finds a handle in every place that holds it', async () => {
      applied(await service.create(doc({ handle: 'same' })));
      applied(
        await service.create(doc({ handle: 'same', place: 'project:p1' })),
      );
      applied(await service.create(doc({ handle: 'other' })));
      const { documents } = await service.list({ handle: 'same' });
      expect(documents.map((row) => row.place).sort()).toEqual([
        'global',
        'project:p1',
      ]);
    });

    it('counts active and waiting by place', async () => {
      applied(await service.create(doc({ place: 'project:p1' })));
      proposed(
        await service.save(
          AGENT,
          { title: 'New', whenToRead: 'W.', body: 'B', reason: 'r' },
          IN_P1,
        ),
      );
      expect(await service.counts()).toEqual({
        places: [{ place: 'project:p1', active: 1, waiting: 1, documents: 2 }],
        active: 1,
        waiting: 1,
      });
    });

    it('refuses a registered secret in what the user creates or edits', async () => {
      registerSecret(SECRET, 'test key');
      try {
        expect(
          refusalOf(await service.create(doc({ title: `Key ${SECRET}` }))),
        ).toBe('CONTAINS_SECRET');
        expect(
          refusalOf(
            await service.create(doc({ whenToRead: `When ${SECRET}` })),
          ),
        ).toBe('CONTAINS_SECRET');
        expect(
          refusalOf(await service.create(doc({ body: `Use ${SECRET}` }))),
        ).toBe('CONTAINS_SECRET');
        const live = applied(await service.create(doc()));
        expect(
          refusalOf(
            await service.edit(live.id, {
              rev: live.rev,
              title: live.title,
              whenToRead: live.whenToRead,
              body: `Use ${SECRET}`,
            }),
          ),
        ).toBe('CONTAINS_SECRET');
      } finally {
        clearSecrets();
      }
    });

    it('stamps lastReadAt when a read opens a document', async () => {
      const live = applied(await service.create(doc()));
      expect((await service.get(live.id))?.lastReadAt).toBeNull();
      expect((await service.read(NOWHERE, live.handle)).kind).toBe('found');
      expect((await service.get(live.id))?.lastReadAt).not.toBeNull();
    });

    it('keeps an agent’s saved document out of the run index until the user takes its text', async () => {
      service.setConfig({ enabled: true, agentWrites: 'direct' });
      const facts = { taskId: null, cwd: null, projectId: null };
      const saved = applied(
        await service.save(
          AGENT,
          { title: 'Unreviewed', whenToRead: 'W.', body: 'B', reason: 'r' },
          NOWHERE,
        ),
      );
      expect(saved.approvedAt).toBeNull();
      expect((await service.runSnapshot(facts)).knowledgeIndex).toBeNull();

      const edited = applied(
        await service.edit(saved.id, {
          rev: saved.rev,
          title: saved.title,
          whenToRead: saved.whenToRead,
          body: 'B, read',
        }),
      );

      expect(edited.approvedAt).not.toBeNull();
      expect((await service.runSnapshot(facts)).knowledgeIndex).toContain(
        '- unreviewed — Unreviewed.',
      );
    });

    it('puts an agent’s saved document into the run index on the user’s press, and back to search only', async () => {
      service.setConfig({ enabled: true, agentWrites: 'direct' });
      const facts = { taskId: null, cwd: null, projectId: null };
      const saved = applied(
        await service.save(
          AGENT,
          { title: 'Saved at once', whenToRead: 'W.', body: 'B', reason: 'r' },
          NOWHERE,
        ),
      );

      const indexed = await service.setIndexed(saved.id, true);
      const listedThen = (await service.runSnapshot(facts)).knowledgeIndex;
      const searchOnly = await service.setIndexed(saved.id, false);

      expect(indexed).toMatchObject({
        kind: 'changed',
        head: { approvedAt: expect.any(String), rev: saved.rev },
      });
      expect(listedThen).toContain('- saved-at-once — Saved at once.');
      expect(searchOnly).toMatchObject({
        kind: 'changed',
        head: { approvedAt: null },
      });
      expect((await service.runSnapshot(facts)).knowledgeIndex).toBeNull();
    });

    it('saves agent writes at once until Electron pushes a setting', () => {
      expect(DEFAULT_KNOWLEDGE_CONFIG).toEqual({
        enabled: true,
        agentWrites: 'direct',
      });
    });

    it('keeps a version restored after the user loaded it in the index', async () => {
      service.setConfig({ enabled: true, agentWrites: 'direct' });
      const saved = applied(
        await service.save(
          AGENT,
          { title: 'Loaded', whenToRead: 'W.', body: 'B', reason: 'r' },
          NOWHERE,
        ),
      );
      await service.setIndexed(saved.id, true);
      const [current] = (await service.revisions(saved.id)).revisions;

      const restored = applied(
        await service.restoreRevision(current!.id, saved.rev),
      );

      expect(restored.approvedAt).not.toBeNull();
    });

    it('refuses to move a proposed or archived document in or out of the index', async () => {
      const proposed = await service.save(
        AGENT,
        { title: 'Proposed', whenToRead: 'W.', body: 'B', reason: 'r' },
        NOWHERE,
      );
      const archived = applied(await service.create(doc()));
      await service.setStatus(archived.id, 'archived');

      expect(proposed.kind).toBe('proposed');
      expect(
        await service.setIndexed(
          proposed.kind === 'proposed' ? proposed.document.id : '',
          true,
        ),
      ).toMatchObject({ kind: 'refused', code: 'NOT_EDITABLE' });
      expect(await service.setIndexed(archived.id, false)).toMatchObject({
        kind: 'refused',
        code: 'NOT_EDITABLE',
      });
    });

    it('keeps a restored version unreviewed unless the user took its text', async () => {
      service.setConfig({ enabled: true, agentWrites: 'direct' });
      const first = applied(
        await service.save(
          AGENT,
          { title: 'Plan', whenToRead: 'W.', body: 'agent text', reason: 'r' },
          NOWHERE,
        ),
      );
      const second = applied(
        await service.edit(first.id, {
          rev: first.rev,
          title: first.title,
          whenToRead: first.whenToRead,
          body: 'other text',
        }),
      );
      const third = applied(
        await service.save(
          AGENT,
          {
            handle: first.handle,
            rev: second.rev,
            edits: [{ find: 'other', replace: 'third' }],
            reason: 'r',
          },
          NOWHERE,
        ),
      );
      const { revisions } = await service.revisions(first.id);
      const idOf = (rev: number): string => {
        const found = revisions.find((row) => row.rev === rev);
        if (!found) {
          throw new Error(`no version ${rev}`);
        }
        return found.id;
      };

      const restoredUnseen = applied(
        await service.restoreRevision(idOf(first.rev), third.rev),
      );
      expect(restoredUnseen.approvedAt).toBeNull();
      expect(restoredUnseen.source.actor).toBe('agent');
      const restoredSeen = applied(
        await service.restoreRevision(idOf(second.rev), restoredUnseen.rev),
      );
      expect(restoredSeen.approvedAt).not.toBeNull();
      expect(restoredSeen.source.actor).toBe('user');
    });

    it('ranks the page’s search like the agent’s, with the any-word retry', async () => {
      const inBody = applied(
        await service.create(
          doc({ handle: 'in-body', title: 'Plain', body: 'word quokka here' }),
        ),
      );
      const inTitle = applied(
        await service.create(
          doc({ handle: 'in-title', title: 'Quokka guide', body: 'Other.' }),
        ),
      );
      await service.edit(inBody.id, {
        rev: inBody.rev,
        title: inBody.title,
        whenToRead: inBody.whenToRead,
        body: 'word quokka again',
      });

      const handles = async (q: string): Promise<string[]> =>
        (await service.list({ q })).documents.map((row) => row.handle);

      expect(await handles('quokka')).toEqual([inTitle.handle, inBody.handle]);
      expect(await handles('quokka zzznosuchword')).toEqual([
        inTitle.handle,
        inBody.handle,
      ]);
    });

    it('keeps the page’s search inside its place and status filters', async () => {
      applied(
        await service.create(doc({ handle: 'here', place: 'project:p1' })),
      );
      applied(await service.create(doc({ handle: 'there', place: 'global' })));

      const { documents, next } = await service.list({
        q: 'release',
        place: 'project:p1',
      });

      expect(documents.map((row) => row.handle)).toEqual(['here']);
      expect(next).toBeNull();
    });

    describe('a run’s own search, as the transcript asks it', () => {
      beforeEach(async () => {
        const em = orm.em.fork();
        em.persist(
          make(Run, {
            id: 'run-p1',
            projectId: 'p1',
            projectSource: 'explicit',
          }),
        );
        await em.flush();
      });

      const handlesFound = async (query?: string): Promise<string[]> =>
        (await service.runSearch('run-p1', query)).documents.map(
          (row) => row.handle,
        );

      it('falls back to any word, as the agent’s search does', async () => {
        applied(
          await service.create(
            doc({ handle: 'tag', place: 'project:p1', title: 'Tag a release' }),
          ),
        );

        expect(await handlesFound('release zebraqq')).toEqual(['tag']);
        expect(
          (await service.search(IN_P1, 'release zebraqq')).hits.map(
            (hit) => hit.handle,
          ),
        ).toEqual(['tag']);
      });

      it('never finds a document the run’s nearer one shadows', async () => {
        applied(
          await service.create(
            doc({
              handle: 'shared',
              place: 'project:p1',
              title: 'Near',
              body: 'plain words',
            }),
          ),
        );
        applied(
          await service.create(
            doc({
              handle: 'shared',
              place: 'global',
              title: 'Far',
              body: 'hidden marker',
            }),
          ),
        );

        expect(await handlesFound('marker')).toEqual([]);
      });

      it('lists what the run sees when there is no query', async () => {
        applied(
          await service.create(doc({ handle: 'near', place: 'project:p1' })),
        );
        applied(await service.create(doc({ handle: 'far', place: 'global' })));

        expect(await handlesFound()).toEqual(['near', 'far']);
      });
    });

    it('lists a handle only in a run’s own places, nearest first', async () => {
      const em = orm.em.fork();
      em.persist([
        make(Project, { id: 'p2', name: 'Other', folder: '/other' }),
        make(Run, { id: 'run-p1', projectId: 'p1', projectSource: 'explicit' }),
      ]);
      await em.flush();
      const near = applied(
        await service.create(doc({ handle: 'deploy', place: 'project:p1' })),
      );
      applied(await service.create(doc({ handle: 'deploy', place: 'global' })));
      applied(
        await service.create(doc({ handle: 'deploy', place: 'project:p2' })),
      );
      const { documents } = await service.list({
        handle: 'deploy',
        runId: 'run-p1',
      });
      expect(documents.map((row) => row.place)).toEqual([near.place, 'global']);
    });

    it('counts a pending change on an active document as one waiting document', async () => {
      const live = applied(await service.create(doc({ handle: 'live' })));
      const old = applied(await service.create(doc({ handle: 'old' })));
      await service.setStatus(old.id, 'archived');
      proposed(
        await service.save(
          AGENT,
          {
            handle: live.handle,
            rev: live.rev,
            edits: [{ find: 'green', replace: 'red' }],
            reason: 'r',
          },
          NOWHERE,
        ),
      );
      expect(await service.counts()).toEqual({
        places: [{ place: 'global', active: 1, waiting: 1, documents: 2 }],
        active: 1,
        waiting: 1,
      });
    });

    it('lists a handle in every status when the status is left out', async () => {
      const waiting = proposed(
        await service.save(
          AGENT,
          { title: 'Same', whenToRead: 'W.', body: 'B', reason: 'r' },
          IN_P1,
        ),
      );
      applied(await service.create(doc({ handle: 'same' })));
      const retired = applied(
        await service.create(doc({ handle: 'same', place: 'team:t1' })),
      );
      await service.setStatus(retired.id, 'archived');
      expect(waiting.handle).toBe('same');
      const { documents } = await service.list({ handle: 'same' });
      expect(documents.map((row) => row.status).sort()).toEqual([
        'active',
        'archived',
        'proposed',
      ]);
    });

    it('says a change is kept while the version it was made against is', async () => {
      const live = applied(await service.create(doc({ body: 'v0' })));
      proposed(
        await service.save(
          AGENT,
          {
            handle: live.handle,
            rev: live.rev,
            edits: [{ find: 'v0', replace: 'w' }],
            reason: 'r',
          },
          NOWHERE,
        ),
      );
      expect(
        (await service.revision((await pendingOf(live.id)).id))?.baseKept,
      ).toBe(true);
      const made = proposed(
        await service.save(
          AGENT,
          { title: 'Plan', whenToRead: 'W.', body: 'B', reason: 'r' },
          NOWHERE,
        ),
      );
      expect(
        (await service.revision((await pendingOf(made.id)).id))?.baseKept,
      ).toBe(true);
    });

    it('says a change is not kept once the version it was made against is dropped', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const start = Date.parse('2026-01-01T00:00:00Z');
        vi.setSystemTime(start);
        const live = applied(await service.create(doc({ body: 'v0' })));
        proposed(
          await service.save(
            AGENT,
            {
              handle: live.handle,
              rev: live.rev,
              edits: [{ find: 'v0', replace: 'w' }],
              reason: 'r',
            },
            NOWHERE,
          ),
        );
        let rev = live.rev;
        for (let i = 1; i <= KNOWLEDGE_REVISIONS_KEPT + 3; i += 1) {
          vi.setSystemTime(start + i * 1000);
          rev = applied(
            await service.edit(live.id, {
              rev,
              title: live.title,
              whenToRead: live.whenToRead,
              body: `v${i}`,
            }),
          ).rev;
        }
        const detail = await service.revision((await pendingOf(live.id)).id);
        expect(detail?.baseKept).toBe(false);
        expect(detail?.diff).toBe('');
        expect(detail?.stale).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('exports one document and one place as Markdown', async () => {
      const live = applied(await service.create(doc()));
      const one = await service.exportMarkdown({ id: live.id });
      expect(one?.name).toBe('release-checklist.md');
      expect(one?.markdown).toContain('> When to read: Cutting a release.');
      expect((await service.exportMarkdown({ place: 'global' }))?.count).toBe(
        1,
      );
      expect(await service.exportMarkdown({ place: 'project:p1' })).toBeNull();
    });
  });

  describe('a deleted place', () => {
    const moved: KnowledgeChangedEvent[] = [];

    beforeEach(() => {
      moved.length = 0;
      events.allChanges().subscribe((event) => moved.push(event));
    });

    it('renames a colliding handle on a move to Global', async () => {
      applied(await service.create(doc({ handle: 'same' })));
      applied(
        await service.create(doc({ handle: 'same', place: 'project:p1' })),
      );
      applied(
        await service.create(doc({ handle: 'other', place: 'project:p1' })),
      );
      const settled = await orm.em
        .fork()
        .transactional((tx) =>
          service.settleRemovedProject('p1', 'global', tx),
        );
      expect(settled.moved).toBe(2);
      expect(settled.renamed).toEqual([{ from: 'same', to: 'same-2' }]);
      settled.announce();
      expect(moved.at(-1)?.change).toBe('bulk');
      const { documents } = await service.list({ place: 'global' });
      expect(documents.map((row) => row.handle).sort()).toEqual([
        'other',
        'same',
        'same-2',
      ]);
    });

    it('announces a removed project once, after its transaction has committed', async () => {
      applied(
        await service.create(doc({ handle: 'in-p1', place: 'project:p1' })),
      );
      const order: string[] = [];
      orm.em.getEventManager().registerSubscriber({
        afterTransactionCommit: () => {
          order.push('commit');
        },
      });
      events.allChanges().subscribe(() => order.push('announce'));
      const settled = await orm.em
        .fork()
        .transactional((tx) =>
          service.settleRemovedProject('p1', 'global', tx),
        );
      expect(settled.moved).toBe(1);
      expect(order).toEqual(['commit']);
      settled.announce();
      expect(order).toEqual(['commit', 'announce']);
    });

    it('refuses a new document in a team that is gone, from the agent and the user alike', async () => {
      service.useTeamLookup(async () => true);
      applied(await service.create(doc({ handle: 'kept', place: 'team:t1' })));
      service.useTeamLookup(async () => false);
      expect(
        refusalOf(
          await service.save(
            AGENT,
            {
              title: 'Late',
              whenToRead: 'W.',
              body: 'B',
              reason: 'r',
              place: 'team',
            },
            P1_T1,
          ),
        ),
      ).toBe('NO_TEAM');
      expect(
        refusalOf(
          await service.create(doc({ handle: 'late', place: 'team:t1' })),
        ),
      ).toBe('NO_TEAM');
    });

    it('keeps no project document after delete', async () => {
      const live = applied(await service.create(doc({ place: 'project:p1' })));
      await orm.em
        .fork()
        .transactional((tx) =>
          service.settleRemovedProject('p1', 'delete', tx),
        );
      expect(await service.get(live.id)).toBeNull();
      expect(await ftsRows(live.id)).toBe(0);
      expect((await service.revisions(live.id)).revisions).toEqual([]);
    });

    it('settles a deleted team either way', async () => {
      applied(await service.create(doc({ handle: 'a', place: 'team:t1' })));
      applied(await service.create(doc({ handle: 'b', place: 'team:t2' })));
      expect((await service.settleDeletedTeam('t1', 'global')).moved).toBe(1);
      expect((await service.settleDeletedTeam('t2', 'delete')).deleted).toBe(1);
      const { documents } = await service.list({});
      expect(documents.map((row) => row.handle)).toEqual(['a']);
      expect(documents[0]?.place).toBe('global');
    });
  });

  describe('a place a chat names', () => {
    const OTHER = { projectId: 'p2', teamSlug: null };
    const ACTOR = {
      kind: 'agent' as const,
      runId: 'r',
      memberId: 'm',
      agentKind: null,
      model: null,
    };

    beforeEach(async () => {
      const em = orm.em.fork();
      em.persist(make(Project, { id: 'p2', name: 'Docs', folder: '/docs' }));
      await em.flush();
      service.setConfig({ enabled: true, agentWrites: 'direct' });
    });

    it('answers the place, or why there is no such place', async () => {
      await expect(service.placeNamed(OTHER)).resolves.toEqual(OTHER);
      await expect(
        service.placeNamed({ projectId: 'ghost', teamSlug: null }),
      ).resolves.toMatchObject({ kind: 'refused', code: 'NO_PROJECT' });
      service.useTeamLookup(async () => false);
      await expect(
        service.placeNamed({ projectId: null, teamSlug: 'ghost' }),
      ).resolves.toMatchObject({ kind: 'refused', code: 'NO_TEAM' });
    });

    it('files, finds, reads and edits a document there, out of reach of the run’s own place', async () => {
      const IN_P1 = { projectId: 'p1', teamSlug: null };
      const created = applied(
        await service.save(
          ACTOR,
          {
            title: 'Stand',
            whenToRead: 'Starting the stand.',
            body: 'Start it first.',
            reason: 'r',
          },
          OTHER,
        ),
      );

      expect(created.place).toBe('project:p2');
      expect((await service.search(IN_P1, 'stand')).total).toBe(0);
      expect((await service.search(OTHER, 'stand')).total).toBe(1);
      expect(await service.read(IN_P1, created.handle)).toMatchObject({
        kind: 'missing',
      });
      expect(await service.read(OTHER, created.handle)).toMatchObject({
        kind: 'found',
      });
      expect(
        refusalOf(
          await service.save(
            ACTOR,
            {
              handle: created.handle,
              rev: created.rev,
              edits: [{ find: 'first', replace: 'last' }],
              reason: 'r',
            },
            IN_P1,
          ),
        ),
      ).toBe('NOT_FOUND');
      const edited = applied(
        await service.save(
          ACTOR,
          {
            handle: created.handle,
            rev: created.rev,
            edits: [{ find: 'first', replace: 'last' }],
            reason: 'r',
          },
          OTHER,
        ),
      );
      expect(edited.body).toBe('Start it last.');
    });
  });

  describe('a recommendation the user applied', () => {
    const ADD: KnowledgeItemWrite = {
      kind: 'add',
      place: 'project:p1',
      title: 'Stand',
      whenToRead: 'Starting the stand.',
      body: 'Start it first.',
      reason: 'K-1: Keep the guide as a document',
    };
    const added = async () =>
      applied(
        (await service.applyRecommended(AGENT, ADD)) as KnowledgeSaveOutcome,
      );

    it('is live and approved at once under review, written by the agent that filed it', async () => {
      const document = await added();

      expect(document).toMatchObject({
        status: 'active',
        rev: 1,
        place: 'project:p1',
        body: 'Start it first.',
        source: { actor: 'agent' },
      });
      expect(document.approvedAt).not.toBeNull();
      const { revisions } = await service.revisions(document.id);
      expect(revisions[0]).toMatchObject({
        status: 'applied',
        reason: 'K-1: Keep the guide as a document',
      });
      const stored = await orm.em
        .fork()
        .findOneOrFail(KnowledgeRevision, { id: revisions[0]?.id });
      expect(stored.approvedAt).not.toBeNull();
      expect(
        (await service.search({ projectId: 'p1', teamSlug: null }, 'stand'))
          .total,
      ).toBe(1);
    });

    it('replaces a document’s whole text at the rev read, and stays approved', async () => {
      const { handle, rev } = await added();

      const updated = applied(
        (await service.applyRecommended(AGENT, {
          kind: 'update',
          place: 'project:p1',
          handle,
          rev,
          body: 'Start it last.',
          reason: 'K-2',
        })) as KnowledgeSaveOutcome,
      );

      expect(updated.body).toBe('Start it last.');
      expect(updated.rev).toBe(rev + 1);
      expect(updated.approvedAt).not.toBeNull();
    });

    it('archives a retired document, which only an Apply lets an agent do', async () => {
      const { handle, rev } = await added();

      const retired = await service.applyRecommended(AGENT, {
        kind: 'retire',
        place: 'project:p1',
        handle,
        rev,
        body: 'It moved into the instructions.',
        reason: 'K-3',
      });

      expect(retired).toMatchObject({
        kind: 'archived',
        document: { handle, status: 'archived' },
      });
      expect(
        await service.read({ projectId: 'p1', teamSlug: null }, handle),
      ).toMatchObject({ kind: 'missing' });
    });

    it('refuses a moved rev, a document that is not there, an unknown place and invalid text, writing nothing', async () => {
      const { handle, rev } = await added();
      const update: KnowledgeItemWrite = {
        kind: 'update',
        place: 'project:p1',
        handle,
        rev,
        body: 'x',
        reason: 'r',
      };

      for (const [write, code] of [
        [{ ...update, rev: rev + 5 }, 'INVALID_DOCUMENT'],
        [{ ...update, handle: 'ghost' }, 'NOT_FOUND'],
        [{ ...update, place: 'global' }, 'NOT_FOUND'],
        [{ ...ADD, place: 'project:ghost' }, 'NO_PROJECT'],
        [{ ...ADD, place: 'nowhere' }, 'INVALID_DOCUMENT'],
        [{ ...ADD, title: '' }, 'INVALID_DOCUMENT'],
        [{ ...ADD, body: '' }, 'INVALID_DOCUMENT'],
      ] as const) {
        await expect(service.checkRecommended(write)).resolves.toMatchObject({
          code,
        });
        await expect(
          service.applyRecommended(AGENT, write),
        ).resolves.toMatchObject({ kind: 'refused', code });
      }
      expect(
        (await service.read({ projectId: 'p1', teamSlug: null }, handle))
          .kind === 'found',
      ).toBe(true);
    });

    it('is refused once the user made knowledge read-only', async () => {
      service.setConfig({ enabled: true, agentWrites: 'off' });

      await expect(service.checkRecommended(ADD)).resolves.toMatchObject({
        code: 'KNOWLEDGE_READ_ONLY',
      });
      await expect(service.applyRecommended(AGENT, ADD)).resolves.toMatchObject(
        { code: 'KNOWLEDGE_READ_ONLY' },
      );
    });
  });

  describe('the run index', () => {
    const facts = { taskId: null, cwd: null, projectId: 'p1' };

    it('caps the index on whole lines, and an unreviewed document never appears', async () => {
      for (let i = 0; i < 40; i += 1) {
        applied(await service.create(doc({ title: `Document number ${i}` })));
      }
      service.setConfig({ enabled: true, agentWrites: 'direct' });
      applied(
        await service.save(
          AGENT,
          { title: 'Unreviewed', whenToRead: 'W.', body: 'B', reason: 'r' },
          NOWHERE,
        ),
      );
      const { knowledgeIndex } = await service.runSnapshot(facts);
      expect(knowledgeIndex).toContain('more — knowledge_search)');
      expect(knowledgeIndex).not.toContain('Unreviewed');
      expect(Buffer.byteLength(knowledgeIndex ?? '')).toBeLessThanOrEqual(
        KNOWLEDGE_INDEX_MAX_BYTES,
      );
      expect(knowledgeIndex?.split('\n').at(-2)).toMatch(/KB\)$/);
    });

    it('lists the project first, then Global, and is null with nothing to list', async () => {
      expect((await service.runSnapshot(facts)).knowledgeIndex).toBeNull();
      applied(await service.create(doc({ title: 'Global one' })));
      applied(
        await service.create(
          doc({ title: 'Project one', place: 'project:p1' }),
        ),
      );
      const lines = (await service.runSnapshot(facts)).knowledgeIndex?.split(
        '\n',
      );
      expect(lines?.[1]).toMatch(
        /^- project-one — Project one\. When: Cutting a release\. \(project, 0\.1 KB\)$/,
      );
      expect(lines?.[2]).toContain('(global,');
    });

    it('gives a run no index before the user pushes a config', async () => {
      const bare = await knowledgeDb({ configured: false });
      const bareFacts = { taskId: null, cwd: null, projectId: null };
      try {
        applied(await bare.service.create(doc()));
        expect(
          (await bare.service.runSnapshot(bareFacts)).knowledgeIndex,
        ).toBeNull();
        bare.service.setConfig({ enabled: true, agentWrites: 'review' });
        expect(
          (await bare.service.runSnapshot(bareFacts)).knowledgeIndex,
        ).toContain('- release-checklist —');
      } finally {
        await bare.orm.close();
      }
    });

    it('gives a run no index while knowledge is off or unconfigured', async () => {
      applied(await service.create(doc()));
      service.setConfig({ enabled: false, agentWrites: 'review' });
      expect((await service.runSnapshot(facts)).knowledgeIndex).toBeNull();
    });
  });

  describe('a tool call', () => {
    it('resolves the run place and the agent that makes the call', async () => {
      const em = orm.em.fork();
      em.persist(
        make(Run, { id: 'run-1', projectId: 'p1', projectSource: 'explicit' }),
      );
      await em.flush();
      expect(await service.callScope('run-1', 'senior')).toEqual({
        place: { projectId: 'p1', teamSlug: null },
        actor: {
          kind: 'agent',
          runId: 'run-1',
          agentKind: null,
          model: null,
          memberId: 'senior',
        },
      });
    });

    it('refuses a call that does not come from an agent', async () => {
      vi.spyOn(memory, 'actorOf').mockResolvedValueOnce({ kind: 'user' });
      await expect(service.callScope('run-1', 'senior')).rejects.toMatchObject({
        errorCode: 'KNOWLEDGE_ACTOR',
      });
    });
  });

  it('keeps the rank setting through a rebuild', async () => {
    const connection = orm.em.getConnection();
    await connection.execute('drop table knowledge_fts', [], 'run');
    await connection.execute(
      'drop trigger knowledge_fts_v1_after_insert',
      [],
      'run',
    );
    await index().ensure();
    const rows = await connection.execute(
      "select v from knowledge_fts_config where k = 'rank'",
    );
    expect(rows).toEqual([{ v: 'bm25(0, 8.0, 4.0, 1.0)' }]);
  });
});

async function snapshot(service: KnowledgeService): Promise<string> {
  const { knowledgeIndex } = await service.runSnapshot({
    taskId: null,
    cwd: null,
    projectId: null,
  });
  return knowledgeIndex ?? '';
}
