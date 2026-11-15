import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { make, memoryDb } from '../../memory/__tests__/memory-db';
import { Memory } from '../../memory/entity/memory.entity';
import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryChangedEvent,
  type MemoryImportPreview,
} from '../../memory/memory.types';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { AgentKind } from '../../runs/runs.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CodexAdapter } from '../adapters/codex/codex.adapter';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import type { AgentVersionService } from './agent-version.service';
import { EffortsService } from './efforts.service';
import { MemoryImportService } from './memory-import.service';
import { OneShotAskService } from './one-shot-ask.service';
import type { ProcessRegistry } from './process-registry';

describe('MemoryImportService', () => {
  let db: Awaited<ReturnType<typeof memoryDb>>;
  let home: string;
  let imports: MemoryImportService;
  let adapters: Map<AgentKind, AgentAdapter>;

  beforeEach(async () => {
    db = await memoryDb();
    db.service.setConfig(DEFAULT_MEMORY_CONFIG);
    home = mkdtempSync(join(tmpdir(), 'geniro-import-home-'));
    adapters = new Map<AgentKind, AgentAdapter>([
      [AgentKind.Claude, new ClaudeAdapter({ homeDir: home })],
      [AgentKind.Codex, new CodexAdapter({ homeDir: home })],
    ]);
    const registry = {
      all: () => adapters,
      for: (kind: AgentKind) => adapters.get(kind),
    } as unknown as AgentAdapterRegistry;
    imports = new MemoryImportService(
      db.em,
      registry,
      db.service,
      new ProjectDao(db.em),
      new OneShotAskService(
        registry,
        new EffortsService(
          registry,
          {} as ProcessRegistry,
          {} as AgentVersionService,
        ),
      ),
    );
    const em = db.em.fork();
    em.persist(make(Project, { id: 'app', name: 'App', folder: '/repo/app' }));
    em.persist(make(Project, { id: 'ab1', name: 'AB', folder: '/x/a-b' }));
    em.persist(make(Project, { id: 'ab2', name: 'A/B', folder: '/x/a/b' }));
    await em.flush();
  });

  afterEach(async () => {
    rmSync(home, { recursive: true, force: true });
    await db.orm.close();
  });

  function claudeNote(
    profile: string,
    project: string,
    file: string,
    text: string,
  ): string {
    const dir = join(profile, 'projects', project, 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), text);
    return join(dir, file);
  }

  const defaultProfile = () => join(home, '.claude');

  function codexHandbook(text: string): string {
    const dir = join(home, '.codex', 'memories');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), text);
    return join(dir, 'MEMORY.md');
  }

  /** Every file under `dir` with its bytes and modification time. */
  function tree(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of readdirSync(dir, {
      recursive: true,
      withFileTypes: true,
    })) {
      const path = join(entry.parentPath, entry.name);
      out[path] = entry.isFile()
        ? `${readFileSync(path, 'utf8')}@${statSync(path).mtimeMs}`
        : 'dir';
    }
    return out;
  }

  const preview = (profiles: { agentKind: AgentKind; dir: string }[] = []) =>
    imports.preview({ profiles });

  function keyOf(rows: MemoryImportPreview['rows'], title: string): string {
    const row = rows.find((candidate) => candidate.title === title);
    if (!row) {
      throw new Error(`no row ${title}`);
    }
    return row.key;
  }

  it('previews the fact files of every claude profile, skipping MEMORY.md, each matched to its project or else global, typed from the note', async () => {
    const extra = join(home, 'work-profile');
    claudeNote(
      defaultProfile(),
      '-repo-app',
      'pnpm.md',
      '---\nname: use-pnpm\ndescription: pnpm only.\ntype: Feedback\n---\nNever npm.',
    );
    claudeNote(
      defaultProfile(),
      '-repo-app',
      'loopback.md',
      '---\nname: loopback\n---\n127.0.0.1',
    );
    claudeNote(defaultProfile(), '-repo-app', 'MEMORY.md', '# Memory Index');
    claudeNote(
      extra,
      '-somewhere-else',
      'gh.md',
      '---\nname: gh-login\n---\nUse gh.',
    );

    const { rows, sources } = await preview([
      { agentKind: AgentKind.Claude, dir: extra },
    ]);

    expect(
      rows
        .map((row) => [row.title, row.projectId, row.projectMatch, row.type])
        .sort(),
    ).toEqual([
      ['gh-login', null, 'none', 'reference'],
      ['loopback', 'app', 'matched', 'project'],
      ['use-pnpm', 'app', 'matched', 'feedback'],
    ]);
    expect(sources).toEqual([
      { agentKind: 'claude', path: defaultProfile(), found: 2 },
      { agentKind: 'claude', path: extra, found: 1 },
      {
        agentKind: 'codex',
        path: join(home, '.codex', 'memories', 'MEMORY.md'),
        found: 0,
      },
    ]);
  });

  it('leaves a folder two projects encode alike global, and says so', async () => {
    claudeNote(defaultProfile(), '-x-a-b', 'n.md', '---\nname: shared\n---\nx');

    const [row] = (await preview()).rows;

    expect(row).toMatchObject({ projectId: null, projectMatch: 'ambiguous' });
  });

  it('reports nothing found, with the path it read, for an empty codex memories directory', async () => {
    mkdirSync(join(home, '.codex', 'memories'), { recursive: true });

    const { rows, sources } = await preview();

    expect(rows).toEqual([]);
    expect(sources.at(-1)).toEqual({
      agentKind: 'codex',
      path: join(home, '.codex', 'memories', 'MEMORY.md'),
      found: 0,
    });
  });

  it('reads a codex profile as a home of its own, beside ~/.codex', async () => {
    const other = join(home, 'codex-work');
    mkdirSync(join(other, 'memories'), { recursive: true });
    writeFileSync(
      join(other, 'memories', 'MEMORY.md'),
      '# Task Group: work notes\nbody\n',
    );

    const { rows, sources } = await preview([
      { agentKind: AgentKind.Codex, dir: other },
    ]);

    expect(rows.map((row) => [row.agentKind, row.title])).toEqual([
      ['codex', 'work notes'],
    ]);
    expect(sources.map((source) => source.path)).toContain(
      join(other, 'memories', 'MEMORY.md'),
    );
  });

  it('marks a similar entry, a note already imported and one too long to store', async () => {
    const em = db.em.fork();
    em.persist(
      make(Memory, {
        handle: 1,
        title: 'Release checklist steps',
        body: 'x',
        type: 'reference',
        status: 'active',
        sourceActor: 'user',
      }),
    );
    await em.flush();
    const path = codexHandbook(
      `# Task Group: Release checklist steps\nTag it.\n# Task Group: Big\n${'y'.repeat(9000)}\n`,
    );
    claudeNote(defaultProfile(), '-z', 'done.md', '---\nname: done\n---\nok');
    const first = await preview();
    await imports.apply({
      profiles: [],
      rows: [
        { key: keyOf(first.rows, 'done'), type: 'project', projectId: null },
      ],
    });

    const byTitle = new Map(
      (await preview()).rows.map((row) => [row.title, row]),
    );

    expect(byTitle.get('done')).toMatchObject({ alreadyImported: true });
    expect(byTitle.get('Release checklist steps')).toMatchObject({
      sourcePath: path,
      similarTo: [{ handle: 'm1', status: 'active' }],
      sameAs: null,
      alreadyImported: false,
      problem: null,
    });
    expect(byTitle.get('Big')!.problem).toContain('8192');
  });

  it('marks the second copy of one note across profiles and imports it once', async () => {
    const copy = join(home, 'copied-profile');
    const text = '---\nname: shared-note\n---\nsame body';
    claudeNote(defaultProfile(), '-r', 'n.md', text);
    claudeNote(copy, '-r', 'n.md', text);

    const { rows } = await preview([
      { agentKind: AgentKind.Claude, dir: copy },
    ]);
    const result = await imports.apply({
      profiles: [{ agentKind: AgentKind.Claude, dir: copy }],
      rows: rows.map((row) => ({
        key: row.key,
        type: row.type,
        projectId: null,
      })),
    });

    expect(rows.map((row) => row.sameAs)).toEqual([null, rows[0]!.key]);
    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual([
      { key: rows[1]!.key, reason: 'the same note is already in this import' },
    ]);
  });

  it('imports only the ticked rows, as the user filed them, active and approved, in one bulk change', async () => {
    const kept = claudeNote(
      defaultProfile(),
      '-repo-app',
      'a.md',
      '---\nname: keep-me\n---\nA',
    );
    claudeNote(
      defaultProfile(),
      '-repo-app',
      'b.md',
      '---\nname: leave-me\n---\nB',
    );
    const { rows } = await preview();
    const published: MemoryChangedEvent[] = [];
    db.events.allChanges().subscribe((event) => published.push(event));

    const result = await imports.apply({
      profiles: [],
      rows: [
        { key: keyOf(rows, 'keep-me'), type: 'user', projectId: null },
        { key: 'claude:/nowhere.md#0', type: 'user', projectId: null },
      ],
    });
    const stored = await db.em.fork().find(Memory, {});

    expect(result).toEqual({
      imported: 1,
      skipped: [
        {
          key: 'claude:/nowhere.md#0',
          reason: 'the note changed or is gone since the preview',
        },
      ],
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      title: 'keep-me',
      body: 'A',
      type: 'user',
      projectId: null,
      status: 'active',
      sourceActor: 'import',
      sourceImportedFrom: kept,
    });
    expect(stored[0]!.approvedAt).toBeInstanceOf(Date);
    expect(published).toEqual([
      {
        memoryId: null,
        change: 'bulk',
        status: 'active',
        projectId: null,
        teamSlug: null,
      },
    ]);
  });

  it('imports a note once even when the request ticks its key twice', async () => {
    claudeNote(defaultProfile(), '-r', 'n.md', '---\nname: once\n---\nx');
    const [row] = (await preview()).rows;
    const tick = { key: row!.key, type: 'project' as const, projectId: null };

    const result = await imports.apply({ profiles: [], rows: [tick, tick] });

    expect(result.imported).toBe(1);
    expect(await db.em.fork().count(Memory, {})).toBe(1);
  });

  it('skips a note already imported when the same import is sent again', async () => {
    claudeNote(defaultProfile(), '-r', 'n.md', '---\nname: twice\n---\nx');
    const [row] = (await preview()).rows;
    const request = {
      profiles: [],
      rows: [{ key: row!.key, type: 'project' as const, projectId: null }],
    };
    await imports.apply(request);

    const again = await imports.apply(request);

    expect(again).toEqual({
      imported: 0,
      skipped: [{ key: row!.key, reason: 'already imported' }],
    });
    expect(await db.em.fork().count(Memory, {})).toBe(1);
  });

  it('marks a note already imported from another place by its text, so it is not ticked only to be skipped', async () => {
    claudeNote(defaultProfile(), '-r', 'n.md', '---\nname: moved\n---\nx');
    const [first] = (await preview()).rows;
    await imports.apply({
      profiles: [],
      rows: [{ key: first!.key, type: 'project', projectId: null }],
    });
    const elsewhere = join(home, 'other-profile');
    claudeNote(elsewhere, '-q', 'copy.md', '---\nname: moved\n---\nx');

    const rows = (
      await preview([{ agentKind: AgentKind.Claude, dir: elsewhere }])
    ).rows;

    expect(rows.map((row) => [row.sourcePath, row.alreadyImported])).toEqual([
      [first!.sourcePath, true],
      [join(elsewhere, 'projects', '-q', 'memory', 'copy.md'), true],
    ]);
  });

  it('offers a note edited since its import as new, as the import would write it', async () => {
    const path = claudeNote(
      defaultProfile(),
      '-r',
      'n.md',
      '---\nname: edited\n---\nold',
    );
    const [first] = (await preview()).rows;
    await imports.apply({
      profiles: [],
      rows: [{ key: first!.key, type: 'project', projectId: null }],
    });
    writeFileSync(path, '---\nname: edited\n---\nnew text');

    const [row] = (await preview()).rows;

    expect(row).toMatchObject({ sourcePath: path, alreadyImported: false });
  });

  it('imports a note again once its earlier copy was forgotten', async () => {
    claudeNote(defaultProfile(), '-r', 'n.md', '---\nname: back\n---\nx');
    const [row] = (await preview()).rows;
    const request = {
      profiles: [],
      rows: [{ key: row!.key, type: 'project' as const, projectId: null }],
    };
    await imports.apply(request);
    await db.service.forgetAll();

    const again = await imports.apply(request);

    expect(again).toEqual({ imported: 1, skipped: [] });
    expect(await db.em.fork().count(Memory, { status: 'active' })).toBe(1);
  });

  it('skips a note edited since the preview, and a codex group added since never rides an old key', async () => {
    const path = claudeNote(
      defaultProfile(),
      '-r',
      'n.md',
      '---\nname: first\n---\nold',
    );
    const handbook = codexHandbook('# Task Group: kept\nsteps\n');
    const before = (await preview()).rows;
    writeFileSync(path, '---\nname: first\n---\nnew');
    writeFileSync(
      handbook,
      '# Task Group: inserted\nnever seen\n# Task Group: kept\nsteps\n',
    );

    const result = await imports.apply({
      profiles: [],
      rows: before.map((row) => ({
        key: row.key,
        type: row.type,
        projectId: null,
      })),
    });
    const titles = (await db.em.fork().find(Memory, {})).map(
      (row) => row.title,
    );

    expect(titles).toEqual(['kept']);
    expect(result.skipped).toEqual([
      {
        key: keyOf(before, 'first'),
        reason: 'the note changed or is gone since the preview',
      },
    ]);
  });

  it('skips a ticked note too long to store, or filed under a project that is gone', async () => {
    codexHandbook(`# Task Group: Big\n${'y'.repeat(9000)}\n`);
    claudeNote(defaultProfile(), '-r', 'n.md', '---\nname: elsewhere\n---\nx');
    const { rows } = await preview();

    const result = await imports.apply({
      profiles: [],
      rows: [
        { key: keyOf(rows, 'Big'), type: 'reference', projectId: null },
        { key: keyOf(rows, 'elsewhere'), type: 'project', projectId: 'gone' },
      ],
    });

    expect(result.imported).toBe(0);
    expect(result.skipped.map((skip) => skip.reason)).toEqual([
      expect.stringContaining('8192'),
      'no project gone',
    ]);
    expect(await db.em.fork().count(Memory, {})).toBe(0);
  });

  it('never writes to the source directories', async () => {
    claudeNote(defaultProfile(), '-repo-app', 'a.md', '---\nname: a\n---\nA');
    codexHandbook('# Task Group: g\nbody\n');
    const before = tree(home);

    const { rows } = await preview();
    await imports.apply({
      profiles: [],
      rows: rows.map((row) => ({
        key: row.key,
        type: row.type,
        projectId: row.projectId,
      })),
    });

    expect(rows).toHaveLength(2);
    expect(tree(home)).toEqual(before);
  });

  it('names the profile each note came from and the folder its sessions say it was written for', async () => {
    claudeNote(defaultProfile(), '-repo-app', 'a.md', '---\nname: a\n---\nA');
    writeFileSync(
      join(defaultProfile(), 'projects', '-repo-app', 's1.jsonl'),
      `${JSON.stringify({ type: 'system', cwd: '/repo/app' })}\n`,
    );
    claudeNote(defaultProfile(), '-repo-b', 'b.md', '---\nname: b\n---\nB');
    writeFileSync(
      join(defaultProfile(), 'projects', '-repo-b', 's1.jsonl'),
      `${JSON.stringify({ type: 'system', cwd: '/elsewhere' })}\n`,
    );
    claudeNote(defaultProfile(), '-repo-c', 'c.md', '---\nname: c\n---\nC');
    codexHandbook('# Task Group: g\nbody\n');

    const byTitle = new Map(
      (await preview()).rows.map((row) => [row.title, row]),
    );

    expect(byTitle.get('a')).toMatchObject({
      profile: defaultProfile(),
      folder: '/repo/app',
    });
    expect(byTitle.get('b')!.folder).toBeNull();
    expect(byTitle.get('c')!.folder).toBeNull();
    expect(byTitle.get('g')).toMatchObject({
      profile: join(home, '.codex', 'memories', 'MEMORY.md'),
      folder: null,
    });
  });

  it('offers to sort the notes with every CLI that can answer a one-off question', async () => {
    adapters.set(AgentKind.CursorAgent, {
      getConfig: () => ({ oneShotAskUnavailableReason: 'no print mode' }),
      readNativeMemory: () => Promise.resolve(null),
      nativeMemoryProjectKey: () => null,
    } as unknown as AgentAdapter);

    expect((await preview()).triageAgents).toEqual(['claude', 'codex']);
    expect(imports.triageAgents()).toEqual({ agents: ['claude', 'codex'] });
    await expect(
      imports.triage({
        agentKind: AgentKind.CursorAgent,
        notes: [{ key: 'k', title: 't', body: 'b', folder: null }],
      }),
    ).rejects.toThrow('cannot sort notes');
  });

  it('sorts notes through the CLI asked, keyed back to each note', async () => {
    const ask = vi
      .spyOn(adapters.get(AgentKind.Claude)!, 'askOnce')
      .mockResolvedValue(
        'Sure:\n[{"id":"n2","keep":false,"reason":"task status"},{"id":"n1","keep":true,"reason":"a convention"}]',
      );

    const result = await imports.triage({
      agentKind: AgentKind.Claude,
      notes: [
        { key: 'k1', title: 'use pnpm', body: 'Never npm.', folder: '/repo' },
        { key: 'k2', title: 'PR 12 state', body: 'waiting', folder: null },
      ],
    });

    expect(result.verdicts).toEqual([
      { key: 'k2', keep: false, reason: 'task status' },
      { key: 'k1', keep: true, reason: 'a convention' },
    ]);
    expect(ask.mock.calls[0]![0]).toMatchObject({
      model: null,
      configDir: null,
      prompt: expect.stringContaining('[n2] PR 12 state'),
    });
  });

  it('asks with the model settings chosen, as a chat would run them', async () => {
    const ask = vi
      .spyOn(adapters.get(AgentKind.Claude)!, 'askOnce')
      .mockResolvedValue('[{"id":"n1","keep":true,"reason":"r"}]');
    const notes = [{ key: 'k', title: 't', body: 'b', folder: null }];

    await imports.triage({
      agentKind: AgentKind.Claude,
      model: 'opus',
      effort: 'high',
      modelParameters: { fastMode: 'true', ' ': 'x' },
      configDir: home,
      notes,
    });

    expect(ask.mock.calls[0]![0]).toMatchObject({
      model: 'opus',
      effort: 'high',
      contextWindow: null,
      modelParameters: { fastMode: 'true' },
      configDir: realpathSync(home),
    });
    await expect(
      imports.triage({ agentKind: AgentKind.Claude, effort: 'ultra', notes }),
    ).rejects.toThrow("does not accept the reasoning effort 'ultra'");
    await expect(
      imports.triage({
        agentKind: AgentKind.Claude,
        configDir: join(home, 'missing'),
        notes,
      }),
    ).rejects.toThrow();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('refuses a sort the CLI did not answer, or answered unreadably', async () => {
    const ask = vi.spyOn(adapters.get(AgentKind.Codex)!, 'askOnce');
    const request = {
      agentKind: AgentKind.Codex,
      notes: [{ key: 'k', title: 't', body: 'b', folder: null }],
    };

    ask.mockResolvedValueOnce(null);
    await expect(imports.triage(request)).rejects.toThrow('did not answer');
    ask.mockResolvedValueOnce('I would keep it.');
    await expect(imports.triage(request)).rejects.toThrow('could not be read');
  });

  it('a forgotten imported note is unticked and still imports when ticked', async () => {
    claudeNote(defaultProfile(), '-r', 'n.md', '---\nname: back\n---\nx');
    const [row] = (await preview()).rows;
    const request = {
      profiles: [],
      rows: [{ key: row!.key, type: 'project' as const, projectId: null }],
    };
    await imports.apply(request);
    await db.service.forgetAll();

    const [forgotten] = (await preview()).rows;

    expect(forgotten).toMatchObject({
      alreadyImported: false,
      forgottenEarlier: true,
    });
    expect(await imports.apply(request)).toEqual({ imported: 1, skipped: [] });
    expect(
      await db.em
        .fork()
        .find(Memory, { status: 'active' })
        .then((rows) => rows.map((memory) => memory.sourceActor)),
    ).toEqual(['import']);
  });

  it('a purged imported note is unticked at the next import', async () => {
    claudeNote(defaultProfile(), '-r', 'n.md', '---\nname: back\n---\nx');
    claudeNote(defaultProfile(), '-r', 'o.md', '---\nname: other\n---\ny');
    const rows = (await preview()).rows;
    await imports.apply({
      profiles: [],
      rows: rows.map((row) => ({
        key: row.key,
        type: 'project' as const,
        projectId: null,
      })),
    });
    const back = await db.em
      .fork()
      .findOneOrFail(Memory, { title: 'back', status: 'active' });
    await db.service.forgetAll();

    expect(await db.service.purge(back.id)).toMatchObject({ id: back.id });

    const again = await preview();
    expect(again.rows.map((row) => [row.title, row.forgottenEarlier])).toEqual(
      expect.arrayContaining([
        ['back', true],
        ['other', true],
      ]),
    );
    await db.service.setStatus(
      { kind: 'user' },
      (await db.em.fork().findOneOrFail(Memory, { title: 'other' })).id,
      'active',
    );
    expect(
      (await preview()).rows.map((row) => [row.title, row.forgottenEarlier]),
    ).toEqual(
      expect.arrayContaining([
        ['back', true],
        ['other', false],
      ]),
    );
  });
});
