import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { freshVocabularyStore } from '../../agents/adapters/__tests__/fresh-vocabulary-store';
import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import { CodexAdapter } from '../../agents/adapters/codex/codex.adapter';
import { CursorAcpAdapter } from '../../agents/adapters/cursor-acp/cursor-acp.adapter';
import type { ItemDao } from '../../agents/dao/item.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type { ProjectDao } from '../../projects/dao/project.dao';
import { member, teamOf } from '../__tests__/team-builders';
import type { TeamChangeLogDao } from '../dao/team-change-log.dao';
import type { Team, TeamChangeLogRecord } from '../teams.types';
import { configDirToken } from '../utils/config-dir-redaction';
import { TEAM_BACKUP_DIR } from '../utils/team-backup';
import { teamSnapshotOf } from '../utils/team-snapshot';
import { teamVersionOf } from '../utils/team-version';
import { InstructionSizesService } from './instruction-sizes.service';
import {
  type TeamChange,
  type TeamChangeAuthority,
  TeamChangeService,
} from './team-change.service';
import { TeamChangeLogService } from './team-change-log.service';
import { TeamOverlayService } from './team-overlay.service';
import { TeamOverlayStoreService } from './team-overlay-store.service';
import { TeamStoreService } from './team-store.service';

const WF: Team = teamOf([member('builder'), member('reviewer')], {
  name: 'Dev Team',
});

/** The card the Apply in `applies` names, at seq 3. */
const CARD = {
  sourceRunId: 'newest',
  sourceKind: 'team',
  timing: null,
  items: ['W-1', 'W-2'].map((id) => ({
    id,
    target: 'team',
    territory: 'process',
    kind: 'model',
    location: 'reviewer',
    title: `Title of ${id}`,
    change: 'model: sonnet',
    evidence: [{ runId: 'newest', seq: 4, quote: 'slow review' }],
    rootCause: 'the reviewer runs the largest model',
    impact: { minutesSaved: 3, basis: 'turn spans', confidence: 3 },
    risk: { level: 'low', note: 'reviews may miss more' },
  })),
};
CARD.items.push(
  ...['O-1', 'O-2'].map((id, index) => ({
    ...CARD.items[0]!,
    id,
    target: 'overlay',
    location: index === 0 ? 'p1' : 'p2',
    title: `Title of ${id}`,
  })),
);

const FASTER: Team = {
  ...WF,
  members: [WF.members[0]!, { ...WF.members[1]!, model: 'sonnet' }],
};

describe('TeamChangeService', () => {
  let dir: string;
  let store: TeamStoreService;
  let applies: unknown[];
  let logged: TeamChangeLogRecord[];
  let overlayStore: TeamOverlayStoreService;
  let service: TeamChangeService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-change-'));
    store = new TeamStoreService({ teamsDir: dir });
    await store.create(WF, 'dev-team');
    applies = [{ cardSeq: 3, ids: ['W-1', 'W-2'] }];
    logged = [];
    overlayStore = new TeamOverlayStoreService({ teamsDir: dir });
    service = new TeamChangeService(
      { fork: () => ({}) } as unknown as EntityManager,
      store,
      {
        userMessagesInOrder: () =>
          Promise.resolve([
            { seq: 0, payload: JSON.stringify({ text: 'analyse' }) },
            ...applies.map((apply, index) => ({
              seq: index + 1,
              payload: JSON.stringify({ text: 'apply', apply }),
            })),
          ]),
        rowAtSeq: (_runId: string, seq: number) =>
          Promise.resolve(
            seq === 3
              ? {
                  kind: 'recommendations',
                  payload: JSON.stringify(CARD),
                }
              : null,
          ),
      } as unknown as ItemDao,
      {
        for: (agent: string) => ({
          userInstructionsFile: (configDir: string | null) => ({
            path: `${configDir ?? `home-of-${agent}`}/RULES.md`,
          }),
        }),
      } as unknown as AgentAdapterRegistry,
      new InstructionSizesService(
        new AgentAdapterRegistry([
          new ClaudeAdapter(),
          new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore() }),
          new CodexAdapter({ clientVersion: '1.0.0' }),
        ]),
      ),
      new TeamChangeLogService({
        append: (record: TeamChangeLogRecord) => {
          logged.push(record);
          return Promise.resolve();
        },
      } as unknown as TeamChangeLogDao),
      new TeamOverlayService(
        overlayStore,
        store,
        {
          getById: async (id: string) => ({
            id,
            name: id,
            teamSlug: id === 'p2' ? 'other-team' : 'dev-team',
          }),
        } as unknown as ProjectDao,
        { fork: () => ({}) } as never,
      ),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function hash(): Promise<string> {
    return (await service.describe('dev-team', null)).hash as string;
  }

  /**
   * An analysis's save of `ids` (default W-1) against `baseHash` (default the
   * file as it stands), unless `authority` is given.
   */
  async function change(
    overrides: Partial<TeamChange> & {
      ids?: string[];
      baseHash?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const { ids = ['W-1'], baseHash, authority, ...rest } = overrides;
    const asked: TeamChangeAuthority = authority ?? {
      kind: 'apply',
      analysisRunId: 'analysis',
      ids,
      baseHash: baseHash ?? (await hash()),
    };
    return service.save({
      authority: asked,
      slug: 'dev-team',
      edits: [{ path: 'members/reviewer/model', value: 'sonnet' }],
      dryRun: false,
      ...rest,
    });
  }

  /** A builder turn that began now and has not saved yet. */
  const builder = (
    turn: Partial<
      Omit<Extract<TeamChangeAuthority, { kind: 'builder' }>, 'kind'>
    > = {},
  ): TeamChangeAuthority => ({
    kind: 'builder',
    savedHash: null,
    turnStartedAt: Date.now(),
    acceptsAnyVersion: false,
    ...turn,
  });

  it('backs the file up before saving, and the backup is never listed as a team', async () => {
    const before = await readFile(join(dir, 'dev-team.team.yaml'), 'utf8');

    const result = await change();

    expect(result).toMatchObject({ saved: true });
    expect(result.hash).toBe(await hash());
    const backups = await readdir(join(dir, TEAM_BACKUP_DIR));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(
      /^dev-team\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.yaml$/,
    );
    expect(result.backup).toBe(`${TEAM_BACKUP_DIR}/${backups[0]}`);
    expect(
      await readFile(join(dir, TEAM_BACKUP_DIR, backups[0]!), 'utf8'),
    ).toBe(before);
    expect((await store.get('dev-team')).team.members[1]).toMatchObject({
      model: 'sonnet',
    });
    expect((await store.list()).map((entry) => entry.slug)).toEqual([
      'dev-team',
    ]);
  });

  it('logs an applied change under the Apply it carried out: its items, card, versions and backup', async () => {
    const before = teamVersionOf((await store.get('dev-team')).team);

    const result = await change({ ids: ['W-2'] });

    expect(result).toMatchObject({ saved: true });
    const after = teamVersionOf((await store.get('dev-team')).team);
    expect(after).not.toBe(before);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      slug: 'dev-team',
      source: 'analysis',
      fromVersion: before,
      toVersion: after,
      summary: 'W-2 Title of W-2',
      recommendationIds: ['W-2'],
      chatRunId: 'analysis',
      cardSeq: 3,
      backup: result.backup,
    });
  });

  it('logs nothing for a dry run, a refused save or a builder check', async () => {
    await change({ dryRun: true });
    await change({ baseHash: 'stale' });
    await change({ authority: builder({ savedHash: await hash() }) });

    expect(logged).toEqual([]);
  });

  it('still saves, logging the change untitled, when the card can no longer be read', async () => {
    applies = [{ cardSeq: 8, ids: ['W-1'] }];

    expect(await change()).toMatchObject({ saved: true });
    expect(logged[0]).toMatchObject({
      summary: null,
      recommendationIds: ['W-1'],
      cardSeq: 8,
    });
  });

  it('still answers saved when the change log cannot be written', async () => {
    const failing = new TeamChangeService(
      { fork: () => ({}) } as unknown as EntityManager,
      store,
      {
        userMessagesInOrder: () =>
          Promise.resolve([
            { seq: 1, payload: JSON.stringify({ apply: applies[0] }) },
          ]),
        rowAtSeq: () => Promise.resolve(null),
      } as unknown as ItemDao,
      {} as AgentAdapterRegistry,
      {} as InstructionSizesService,
      new TeamChangeLogService({
        append: () => Promise.reject(new Error('SQLITE_BUSY')),
      } as unknown as TeamChangeLogDao),
      {} as TeamOverlayService,
    );

    await expect(
      failing.save({
        authority: {
          kind: 'apply',
          analysisRunId: 'analysis',
          ids: ['W-1'],
          baseHash: await hash(),
        },
        slug: 'dev-team',
        edits: [{ path: 'members/reviewer/model', value: 'sonnet' }],
        dryRun: false,
      }),
    ).resolves.toMatchObject({ saved: true });
    expect((await store.get('dev-team')).team.members[1]).toMatchObject({
      model: 'sonnet',
    });
  });

  it('refuses an id that is not in the latest Apply, even one an earlier Apply named', async () => {
    applies = [
      { cardSeq: 3, ids: ['W-1'] },
      { cardSeq: 3, ids: ['W-2'] },
    ];

    expect(await change({ ids: ['W-1'] })).toMatchObject({
      saved: false,
      error: 'NOT_SELECTED',
    });
    applies = [];
    expect(await change()).toMatchObject({ error: 'NOT_APPLIED' });
  });

  it('refuses a repo or user item even when the user applied it', async () => {
    applies = [{ cardSeq: 3, ids: ['R-1', 'U-1'] }];

    expect(await change({ ids: ['R-1'] })).toMatchObject({
      saved: false,
      error: 'NOT_A_TEAM_ITEM',
    });
    expect(await change({ ids: ['U-1'] })).toMatchObject({
      saved: false,
      error: 'NOT_A_TEAM_ITEM',
    });
  });

  it('refuses a save on a copy that changed since it was read', async () => {
    const baseHash = await hash();
    await store.save('dev-team', { ...WF, description: 'edited by hand' });

    const result = await change({ baseHash });

    expect(result).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
    expect(result.currentHash).toBe(await hash());
  });

  it('refuses with HASH_DRIFT, keeping the other write, when the file changes while saving', async () => {
    const realSave = store.save.bind(store);
    let first = true;
    store.save = async (slug, team, baseHash) => {
      if (first) {
        first = false;
        // A team editor autosave lands between the service's check and its write.
        await realSave(slug, { ...WF, description: 'builder autosave' });
      }
      return realSave(slug, team, baseHash);
    };

    const result = await change();

    expect(result).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
    expect(typeof result.backup).toBe('string');
    expect((await store.get('dev-team')).team.description).toBe(
      'builder autosave',
    );
  });

  it('refuses a team whose file was deleted, rather than re-creating it', async () => {
    const baseHash = await hash();
    await store.delete('dev-team');

    expect(await change({ baseHash })).toMatchObject({
      error: 'TEAM_GONE',
    });
    await expect(readdir(dir)).resolves.not.toContain('dev-team.team.yaml');
  });

  it('refuses an invalid team and writes nothing', async () => {
    const result = await change({
      edits: [{ path: 'members/-', value: member('builder') }],
    });

    expect(result).toMatchObject({
      saved: false,
      error: 'INVALID_TEAM',
      message: expect.stringContaining('Duplicate member id'),
    });
    await expect(readdir(dir)).resolves.not.toContain(TEAM_BACKUP_DIR);
  });

  it('refuses an edit that does not apply and writes nothing', async () => {
    const result = await change({
      edits: [{ find: 'not in the team', replace: 'x' }],
    });

    expect(result).toMatchObject({ saved: false, error: 'INVALID_EDIT' });
    expect(result.message).toMatch(/^edit 1: `find` matches no text/);
    expect((await store.get('dev-team')).team).toEqual(WF);
    await expect(readdir(dir)).resolves.not.toContain(TEAM_BACKUP_DIR);
  });

  it('changes text inside a string value without the agent sending the rest', async () => {
    await store.save('dev-team', {
      ...WF,
      description: 'Builds, then reviews. Slow on purpose.',
    });

    const result = await change({
      edits: [{ find: ' Slow on purpose.', replace: '' }],
    });

    expect(result).toMatchObject({ saved: true });
    expect((await store.get('dev-team')).team).toEqual({
      ...WF,
      description: 'Builds, then reviews.',
    });
  });

  it('answers where each edit landed and the diff on a dry run, and writes nothing', async () => {
    const result = await change({ dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      saved: false,
      landed: ['members/reviewer/model'],
      diff: { changedMembers: [{ id: 'reviewer' }] },
    });
    expect((await store.get('dev-team')).team).toEqual(WF);
    await expect(readdir(dir)).resolves.not.toContain(TEAM_BACKUP_DIR);
  });

  describe('from a builder chat', () => {
    const PROFILE = '/Users/someone/.claude-work';
    const PROFILED: Team = {
      ...WF,
      members: [{ ...WF.members[0]!, configDir: PROFILE }, WF.members[1]!],
    };

    it('saves with no Apply and no hash behind it, and takes no backup of its own', async () => {
      applies = [];

      const result = await change({ authority: builder() });

      expect(result).toMatchObject({ saved: true });
      expect(result.hash).toBe(await hash());
      expect(result).not.toHaveProperty('backup');
      await expect(readdir(dir)).resolves.not.toContain(TEAM_BACKUP_DIR);
      expect((await store.get('dev-team')).team.members[1]).toMatchObject({
        model: 'sonnet',
      });
    });

    it('refuses a file written after its turn began, before its first save', async () => {
      const result = await change({ authority: builder({ turnStartedAt: 0 }) });

      expect(result).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
      expect(result.message).toMatch(/read the team again with read_teams/);
      expect(result.currentHash).toBe(await hash());
      expect((await store.get('dev-team')).team).toEqual(WF);
    });

    it("counts a write in the turn's first millisecond as before it, and one a millisecond later as after", async () => {
      const written = Math.floor(
        (await stat(join(dir, 'dev-team.team.yaml'))).mtimeMs,
      );

      expect(
        await change({
          authority: builder({ turnStartedAt: written - 1 }),
          dryRun: true,
        }),
      ).toMatchObject({ error: 'HASH_DRIFT' });
      expect(
        await change({
          authority: builder({ turnStartedAt: written }),
          dryRun: true,
        }),
      ).toMatchObject({ dryRun: true, saved: false });
    });

    it('reports the version it lost a race to, so the next save can settle', async () => {
      const realSave = store.save.bind(store);
      let first = true;
      store.save = async (slug, team, baseHash) => {
        if (first) {
          first = false;
          await realSave(slug, { ...WF, description: 'team editor edit' });
        }
        return realSave(slug, team, baseHash);
      };

      const result = await change({ authority: builder() });

      expect(result).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
      expect(result.currentHash).toBe(await hash());
    });

    it('stays a refusal when the write it lost to left a file that does not parse', async () => {
      const realSave = store.save.bind(store);
      store.save = async (slug, team, baseHash) => {
        await writeFile(join(dir, 'dev-team.team.yaml'), 'members: [\n');
        return realSave(slug, team, baseHash);
      };

      const result = await change({ authority: builder() });

      expect(result).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
      expect(typeof result.currentHash).toBe('string');
    });

    it('checks a later save against the version the turn last knew, not the turn start', async () => {
      const known = await hash();

      expect(
        await change({
          authority: builder({ savedHash: known, turnStartedAt: 0 }),
        }),
      ).toMatchObject({ saved: true });
      expect(
        await change({
          authority: builder({ savedHash: known }),
          edits: [{ path: 'members/reviewer/model', value: 'opus' }],
        }),
      ).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
    });

    it('points a find that matches nothing at read_teams, not at an analysis view', async () => {
      const result = await change({
        authority: builder(),
        edits: [{ find: 'not in the team', replace: 'x' }],
      });

      expect(result).toMatchObject({ saved: false, error: 'INVALID_EDIT' });
      expect(result.message).toMatch(/copy it exactly from read_teams/);
    });

    it('refuses a file that no longer parses, naming the fault but quoting no line of it', async () => {
      await writeFile(
        join(dir, 'dev-team.team.yaml'),
        'name: Dev Team\nmembers:\n  - id: a\n    configDir: /Users/someone/.claude-work\n      bad: indent\n',
      );

      const result = await change({
        authority: builder({ turnStartedAt: Date.now() + 60_000 }),
      });

      expect(result).toMatchObject({
        saved: false,
        error: 'TEAM_UNREADABLE',
      });
      expect(result.message).toMatch(/fix only what this names/);
      expect(result.message).not.toContain('.claude-work');
    });

    it('names the version it checked on every answer past the check, so a repair is pinned', async () => {
      const repaired = builder({ turnStartedAt: 0, acceptsAnyVersion: true });

      for (const result of [
        await change({ authority: repaired, dryRun: true }),
        await change({
          authority: repaired,
          edits: [{ find: 'not in the team', replace: 'x' }],
        }),
        await change({
          authority: repaired,
          edits: [{ path: 'members/reviewer/model', value: undefined }],
        }),
      ]) {
        expect(result.currentHash).toBe(await hash());
      }
    });

    it('takes the file as it stands after the agent repaired one it could not load', async () => {
      const result = await change({
        authority: builder({
          savedHash: 'before-the-repair',
          turnStartedAt: 0,
          acceptsAnyVersion: true,
        }),
      });

      expect(result).toMatchObject({ saved: true });
    });

    it('refuses an invalid team and writes nothing', async () => {
      const result = await change({
        authority: builder(),
        edits: [{ path: 'members/-', value: member('builder') }],
      });

      expect(result).toMatchObject({
        saved: false,
        error: 'INVALID_TEAM',
        message: expect.stringContaining('Duplicate member id'),
      });
      await expect(readdir(dir)).resolves.not.toContain(TEAM_BACKUP_DIR);
    });

    it('puts back a profile it wrote as the token read_teams showed', async () => {
      await store.save('dev-team', PROFILED);
      const written = {
        ...WF.members[0]!,
        configDir: configDirToken(PROFILE),
        model: 'opus',
      };

      const result = await change({
        authority: builder({ savedHash: await hash() }),
        edits: [{ path: 'members/builder', value: written }],
      });

      expect(result).toMatchObject({ saved: true });
      expect((await store.get('dev-team')).team.members[0]).toMatchObject({
        configDir: PROFILE,
        model: 'opus',
      });
    });

    it('refuses a token that names no profile of this team, and writes nothing', async () => {
      const result = await change({
        authority: builder(),
        edits: [
          {
            path: 'members/builder/configDir',
            value: configDirToken('/elsewhere'),
          },
        ],
      });

      expect(result).toMatchObject({
        saved: false,
        error: 'CONFIG_DIR_UNKNOWN',
      });
      expect((await store.get('dev-team')).team).toEqual(WF);
    });
  });

  it('backs the file up as it stands when asked, and refuses a deleted team', async () => {
    const before = await readFile(join(dir, 'dev-team.team.yaml'), 'utf8');

    const result = await service.backUp('dev-team');

    const backups = await readdir(join(dir, TEAM_BACKUP_DIR));
    expect(result).toEqual({
      backedUp: true,
      backup: `${TEAM_BACKUP_DIR}/${backups[0]}`,
    });
    expect(
      await readFile(join(dir, TEAM_BACKUP_DIR, backups[0]!), 'utf8'),
    ).toBe(before);
    await store.delete('dev-team');
    expect(await service.backUp('dev-team')).toMatchObject({
      error: 'TEAM_GONE',
    });
  });

  it('answers the backup it already has for an unchanged file, and copies a changed one', async () => {
    const first = await service.backUp('dev-team');

    expect(await service.backUp('dev-team')).toEqual({
      backedUp: true,
      backup: first.backup,
      unchangedSinceThatBackup: true,
    });
    expect(await readdir(join(dir, TEAM_BACKUP_DIR))).toHaveLength(1);

    await store.save('dev-team', FASTER);
    const changed = await service.backUp('dev-team');

    expect(changed.backup).not.toBe(first.backup);
    expect(changed).not.toHaveProperty('unchangedSinceThatBackup');
    expect(await readdir(join(dir, TEAM_BACKUP_DIR))).toHaveLength(2);
  });

  describe('a lesson saved into one member', () => {
    const LESSON = {
      slug: 'dev-team',
      memberId: 'builder',
      line: '- Check the cache before rerunning it.',
      proposalId: 'lp-1',
      sourceRunId: 'src',
      summary: 'Lesson for builder: Check the cache',
    };

    it("appends the line after the member's own instructions, backing the file up first", async () => {
      await store.save('dev-team', {
        ...WF,
        members: [
          { ...WF.members[0]!, instructions: 'Review carefully.' },
          WF.members[1]!,
        ],
      });
      const before = await readFile(join(dir, 'dev-team.team.yaml'), 'utf8');

      const result = await service.appendMemberLine(LESSON);

      expect(result).toMatchObject({ saved: true });
      expect((await store.get('dev-team')).team.members[0]).toMatchObject({
        instructions:
          'Review carefully.\n- Check the cache before rerunning it.',
      });
      const backups = await readdir(join(dir, TEAM_BACKUP_DIR));
      expect(backups).toHaveLength(1);
      expect(
        await readFile(join(dir, TEAM_BACKUP_DIR, backups[0]!), 'utf8'),
      ).toBe(before);
    });

    it('writes the line alone when the member had no instructions', async () => {
      await service.appendMemberLine({ ...LESSON, memberId: 'reviewer' });

      expect((await store.get('dev-team')).team.members[1]).toMatchObject({
        instructions: '- Check the cache before rerunning it.',
      });
    });

    it('logs the change under the lesson, naming its thread and its backup', async () => {
      const result = await service.appendMemberLine(LESSON);
      const backups = await readdir(join(dir, TEAM_BACKUP_DIR));

      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        slug: 'dev-team',
        source: 'lesson',
        summary: LESSON.summary,
        chatRunId: 'src',
        backup: `${TEAM_BACKUP_DIR}/${backups[0]}`,
      });
      expect(result).toMatchObject({ saved: true });
    });

    it('refuses with HASH_DRIFT when the file changes while saving, keeping the other write', async () => {
      const realSave = store.save.bind(store);
      let first = true;
      store.save = async (slug, team, baseHash) => {
        if (first) {
          first = false;
          // A team editor autosave lands between the service's check and its write.
          await realSave(slug, { ...WF, description: 'builder autosave' });
        }
        return realSave(slug, team, baseHash);
      };

      const result = await service.appendMemberLine(LESSON);

      expect(result).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
      expect((await store.get('dev-team')).team.description).toBe(
        'builder autosave',
      );
      expect(logged).toEqual([]);
    });

    it('refuses a member the team no longer has, writing nothing', async () => {
      const result = await service.appendMemberLine({
        ...LESSON,
        memberId: 'ghost',
      });

      expect(result).toMatchObject({ saved: false, error: 'MEMBER_GONE' });
      expect((await store.get('dev-team')).team).toEqual(WF);
      await expect(readdir(dir)).resolves.not.toContain(TEAM_BACKUP_DIR);
      expect(logged).toEqual([]);
    });

    it('refuses a team whose file was deleted, rather than re-creating it', async () => {
      await store.delete('dev-team');

      expect(await service.appendMemberLine(LESSON)).toMatchObject({
        saved: false,
        error: 'TEAM_GONE',
      });
      await expect(readdir(dir)).resolves.not.toContain('dev-team.team.yaml');
    });
  });

  describe('an O- item', () => {
    const OVERLAY = { members: { reviewer: { settings: { effort: 'low' } } } };
    const overlaySave = (
      over: Partial<Parameters<TeamChangeService['saveOverlay']>[0]> = {},
    ) =>
      service.saveOverlay({
        analysisRunId: 'analysis',
        ids: ['O-1'],
        slug: 'dev-team',
        projectId: 'p1',
        overlay: OVERLAY,
        baseHash: null,
        dryRun: false,
        ...over,
      });

    it('writes the project overlay for an item the newest Apply selected, and logs it under the project', async () => {
      applies = [{ cardSeq: 3, ids: ['O-1'] }];

      const answer = await overlaySave();

      expect(answer).toMatchObject({ saved: true, hash: expect.any(String) });
      expect((await overlayStore.get('dev-team', 'p1'))?.overlay).toEqual(
        OVERLAY,
      );
      expect(logged).toMatchObject([
        {
          slug: 'dev-team',
          projectId: 'p1',
          source: 'analysis',
          recommendationIds: ['O-1'],
          cardSeq: 3,
        },
      ]);
      expect((await store.get('dev-team')).team).toEqual(WF);
    });

    it('refuses an id not in the newest Apply', async () => {
      await expect(overlaySave()).resolves.toMatchObject({
        error: 'NOT_SELECTED',
      });
      expect(await overlayStore.get('dev-team', 'p1')).toBeNull();
    });

    it('refuses an item filed about another project', async () => {
      applies = [{ cardSeq: 3, ids: ['O-2'] }];

      await expect(overlaySave({ ids: ['O-2'] })).resolves.toMatchObject({
        error: 'WRONG_PROJECT',
      });
    });

    it('refuses an overlay of a project that defaults to another team, where no run would use it', async () => {
      applies = [{ cardSeq: 3, ids: ['O-2'] }];

      await expect(
        overlaySave({ ids: ['O-2'], projectId: 'p2' }),
      ).resolves.toMatchObject({ error: 'OVERLAY_INACTIVE' });
      expect(await overlayStore.get('dev-team', 'p2')).toBeNull();
    });

    it('refuses a stale overlay hash', async () => {
      applies = [{ cardSeq: 3, ids: ['O-1'] }];
      await overlayStore.save('dev-team', 'p1', {});

      await expect(overlaySave()).resolves.toMatchObject({
        error: 'HASH_DRIFT',
      });
    });
  });

  it("describes the library copy against the run's own snapshot", async () => {
    await writeFile(join(dir, 'unrelated.txt'), 'x');
    const described = await service.describe(
      'dev-team',
      teamSnapshotOf(FASTER),
    );

    expect(described).toMatchObject({
      slug: 'dev-team',
      team: WF,
      changedSinceThisRun: { changedMembers: [{ id: 'reviewer' }] },
    });
    expect(typeof described.hash).toBe('string');
  });

  it('reports no drift for values only the run’s project overlay set', async () => {
    const effective: Team = {
      ...WF,
      members: WF.members.map((member) => ({ ...member, effort: 'max' })),
    };

    const described = await service.describe(
      'dev-team',
      teamSnapshotOf(effective),
      null,
      teamSnapshotOf(WF),
    );

    expect(described.changedSinceThisRun).toEqual(
      (await service.describe('dev-team', teamSnapshotOf(WF)))
        .changedSinceThisRun,
    );
    expect(
      (await service.describe('dev-team', teamSnapshotOf(effective)))
        .changedSinceThisRun,
    ).not.toEqual(described.changedSinceThisRun);
  });

  it('lists the instructions file of every agent and pool member the run itself ran', async () => {
    const ran: Team = {
      ...WF,
      members: [
        WF.members[0]!,
        {
          ...WF.members[1]!,
          agent: 'codex',
          pool: [{ agent: 'claude', configDir: '/profiles/work' }],
        },
      ],
    };

    const described = await service.describe('dev-team', teamSnapshotOf(ran));

    const unmeasured = { exists: false, chars: null, approxTokens: null };
    expect(described.userInstructions).toEqual([
      {
        agent: 'claude',
        configDir: null,
        path: 'home-of-claude/RULES.md',
        ...unmeasured,
      },
      {
        agent: 'codex',
        configDir: null,
        path: 'home-of-codex/RULES.md',
        ...unmeasured,
      },
      {
        agent: 'claude',
        configDir: '/profiles/work',
        path: '/profiles/work/RULES.md',
        ...unmeasured,
      },
    ]);
  });

  it("measures every agent's always-on instructions as the library composes them, with the run's own settings and card", async () => {
    const written: Team = {
      ...WF,
      members: [
        { ...WF.members[0]!, instructions: 'Build it.' },
        { ...WF.members[1]!, instructions: 'Review it.' },
      ],
    };
    await store.save('dev-team', written);
    const ran: Team = {
      ...written,
      members: [
        written.members[0]!,
        {
          ...written.members[1]!,
          instructions: `Review it. ${'Be thorough. '.repeat(50)}`,
        },
      ],
    };

    const described = await service.describe('dev-team', teamSnapshotOf(ran), {
      customInstructions: 'MINE',
      replyLanguage: null,
      taskInstructions: 'CARD',
      projectInstructions: 'PROJECT',
      memoryIndex: 'INDEX',
      knowledgeIndex: 'DOCS',
    });
    const sizes = described.instructionSizes as {
      memberId: string;
      totalChars: number;
      approxTokens: number;
      parts: { source: string; chars: number }[];
      inThisRun?: { totalChars: number; approxTokens: number };
    }[];

    expect(sizes.map((size) => size.memberId)).toEqual(['builder', 'reviewer']);
    const [builder, reviewer] = sizes;
    expect(builder!.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'customInstructions', chars: 4 }),
        expect.objectContaining({ source: 'taskInstructions', chars: 4 }),
        expect.objectContaining({ source: 'projectInstructions', chars: 7 }),
        expect.objectContaining({ source: 'memoryIndex', chars: 5 }),
        expect.objectContaining({ source: 'knowledgeIndex', chars: 4 }),
        expect.objectContaining({ source: 'instructions', chars: 9 }),
      ]),
    );
    expect(builder!.parts.map((part) => part.source)).not.toContain(
      'replyLanguage',
    );
    expect(builder).not.toHaveProperty('inThisRun');
    // The run paid for the longer instructions it started with.
    expect(reviewer!.inThisRun!.totalChars).toBe(
      reviewer!.totalChars + 'Be thorough. '.repeat(50).trim().length + 1,
    );
  });

  it('measures each user-instructions file as it stands now', async () => {
    await writeFile(join(dir, 'RULES.md'), 'x'.repeat(41));
    const sized = new TeamChangeService(
      { fork: () => ({}) } as unknown as EntityManager,
      store,
      {} as ItemDao,
      {
        for: () => ({
          userInstructionsFile: () => ({ path: join(dir, 'RULES.md') }),
        }),
      } as unknown as AgentAdapterRegistry,
      new InstructionSizesService(
        new AgentAdapterRegistry([new ClaudeAdapter()]),
      ),
      new TeamChangeLogService({} as TeamChangeLogDao),
      {} as TeamOverlayService,
    );

    const described = await sized.describe('dev-team', null);

    expect(described.userInstructions).toEqual([
      expect.objectContaining({ exists: true, chars: 41, approxTokens: 11 }),
    ]);
  });
});
