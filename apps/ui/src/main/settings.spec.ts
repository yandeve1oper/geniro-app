import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, MAX_FAST_ACTIONS } from '../shared/contracts';

const mocks = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mocks.userData) },
}));

import { onSettingsWritten, readSettings, updateSettings } from './settings';
import { SETTINGS_VERSION } from './settings-migrations';

beforeEach(() => {
  mocks.userData = mkdtempSync(join(tmpdir(), 'geniro-settings-spec-'));
});

afterEach(() => {
  rmSync(mocks.userData, { recursive: true, force: true });
});

function writeRaw(value: unknown): void {
  mkdirSync(mocks.userData, { recursive: true });
  writeFileSync(
    join(mocks.userData, 'settings.json'),
    JSON.stringify(value),
    'utf8',
  );
}

describe('readSettings', () => {
  it('merges a validated older partial file over defaults', () => {
    writeRaw({ onboardingComplete: true });

    expect(readSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      onboardingComplete: true,
    });
  });

  it('an invalid key costs only that key — valid siblings survive', () => {
    // Version skew is normal under the notify-only brew flow: a downgraded
    // build must not reset EVERY setting (and have the next write make the
    // loss permanent) because one key fails its parse.
    writeRaw({
      cliPaths: null,
      checkForUpdates: 'yes',
      onboardingComplete: true,
    });

    expect(readSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      onboardingComplete: true,
    });
  });

  it('an unknown persisted key is ignored — never cast into Settings, never a reset', () => {
    writeRaw({ unexpected: 'value', onboardingComplete: true });

    const settings = readSettings();
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, onboardingComplete: true });
    expect('unexpected' in settings).toBe(false);
  });

  it('a non-object file still falls back to full defaults', () => {
    writeRaw(['not', 'an', 'object']);

    expect(readSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      settingsVersion: SETTINGS_VERSION,
    });
  });

  it('a stored theme survives a read', () => {
    writeRaw({ theme: 'dark' });

    expect(readSettings().theme).toBe('dark');
  });

  it('a theme this build no longer ships costs only that key, and falls back to System', () => {
    // Version skew is normal under the notify-only brew flow, so a settings.json
    // written by a newer build can name a theme whose CSS file this one does not
    // have. Painting nothing is not an option; System is.
    writeRaw({ theme: 'solarized', onboardingComplete: true });

    const settings = readSettings();
    expect(settings.theme).toBe('system');
    expect(settings.onboardingComplete).toBe(true);
  });

  it('a page size the screen never offered costs only that key, and falls back to the default', () => {
    writeRaw({ historyPageSize: 3000, onboardingComplete: true });

    const settings = readSettings();
    expect(settings.historyPageSize).toBe(1000);
    expect(settings.onboardingComplete).toBe(true);
  });

  it('a stored page size survives a read', () => {
    writeRaw({ historyPageSize: 250 });

    expect(readSettings().historyPageSize).toBe(250);
  });

  it('an analysis choice saved before it carried a mode still reads, as auto-approve', () => {
    const choice = {
      agent: 'claude',
      configDir: null,
      model: 'opus',
      effort: null,
    };
    writeRaw({ lastAnalysisConfig: choice });

    expect(readSettings().lastAnalysisConfig).toEqual({
      ...choice,
      contextWindow: null,
      autoCompactPercent: null,
      modelParameters: {},
      approval: null,
    });

    writeRaw({ lastAnalysisConfig: { ...choice, approval: 'ask' } });

    expect(readSettings().lastAnalysisConfig?.approval).toBe('ask');
  });

  it('a remembered setup keeps its window, threshold and model parameters', () => {
    const setup = {
      agent: 'claude',
      configDir: null,
      model: 'opus',
      effort: null,
      contextWindow: '1m',
      autoCompactPercent: 80,
      modelParameters: { fast: 'on' },
      approval: 'auto',
    };
    writeRaw({ lastAnalysisConfig: setup });

    expect(readSettings().lastAnalysisConfig).toEqual(setup);
  });

  it('a change chat’s approval mode survives a read', () => {
    expect(readSettings().lastChangeChatApproval).toBeNull();

    writeRaw({ lastChangeChatApproval: 'ask' });

    expect(readSettings().lastChangeChatApproval).toBe('ask');
  });

  it('a memory sort’s choice survives a read, and a malformed one costs only that key', () => {
    const choice = {
      agent: 'codex',
      configDir: null,
      model: 'gpt-5.4',
      effort: 'high',
      contextWindow: '272k',
      modelParameters: { fast: 'on' },
    };
    writeRaw({ lastMemoryTriage: choice });

    expect(readSettings().lastMemoryTriage).toEqual(choice);

    writeRaw({
      lastMemoryTriage: { ...choice, agent: 'gemini' },
      onboardingComplete: true,
    });

    const settings = readSettings();
    expect(settings.lastMemoryTriage).toBeNull();
    expect(settings.onboardingComplete).toBe(true);
  });

  it('keeps a run’s CLI for an hour by default, and a stored window survives a read', () => {
    expect(readSettings().keptSessionIdleMinutes).toBe(60);

    writeRaw({ keptSessionIdleMinutes: 5 });

    expect(readSettings().keptSessionIdleMinutes).toBe(5);
  });

  it('keeps the Mac awake while agents work by default, and a stored off survives a read', () => {
    expect(readSettings().preventSleepWhileWorking).toBe(true);

    writeRaw({ preventSleepWhileWorking: false });
    expect(readSettings().preventSleepWhileWorking).toBe(false);

    writeRaw({ preventSleepWhileWorking: 'no', onboardingComplete: true });
    const settings = readSettings();
    expect(settings.preventSleepWhileWorking).toBe(true);
    expect(settings.onboardingComplete).toBe(true);
  });

  it('an idle window outside 5–180 whole minutes costs only that key', () => {
    for (const keptSessionIdleMinutes of [4, 181, 12.5, '30']) {
      writeRaw({ keptSessionIdleMinutes, onboardingComplete: true });

      const settings = readSettings();
      expect(settings.keptSessionIdleMinutes).toBe(60);
      expect(settings.onboardingComplete).toBe(true);
    }
  });

  it("a future agent kind inside cliPaths costs only that entry — this build's known CLI paths survive", () => {
    // The salvage exists for version skew (a settings.json written by a NEWER
    // build under the notify-only brew flow). The most likely schema growth is
    // a new CLI agent kind, which lands as an extra cliPaths entry — that
    // unknown entry must not take the user's still-valid claude/cursor paths
    // down with it: cliPaths values are execFile targets the user configured
    // by hand, and the next updateSettings() write makes any loss permanent.
    writeRaw({
      onboardingComplete: true,
      cliPaths: {
        claude: '/usr/local/bin/claude',
        'future-agent': '/opt/future/bin/future-agent',
      },
    });

    const settings = readSettings();
    expect(settings.cliPaths).toEqual({ claude: '/usr/local/bin/claude' });
    expect(settings.onboardingComplete).toBe(true);
  });

  it('a bad agent-options entry costs only that CLI — the others’ switches survive', () => {
    // Keyed by CLI like cliPaths, so it takes the same version skew: a newer
    // build's extra agent, or one option value this build cannot read, must
    // not reset every CLI's switches to their defaults.
    writeRaw({
      agentOptions: {
        'cursor-agent': { maxMode: false },
        claude: { browserTools: 'yes' },
        'future-agent': { turbo: true },
      },
    });

    expect(readSettings().agentOptions).toEqual({
      'cursor-agent': { maxMode: false },
    });
  });

  it('a saved fast action round-trips every field', () => {
    const fa = {
      id: 'fa-1',
      name: 'Review the branch',
      description: 'Review what changed on this branch and report findings.',
    };
    writeRaw({ fastActions: [fa] });

    expect(readSettings().fastActions).toEqual([fa]);
  });

  it('one unparseable fast action costs only that entry — the others survive in order', () => {
    // An action is HAND-WRITTEN and unrecoverable. Rejecting the array
    // wholesale (zod's default on one bad element) would wipe every one of them
    // over a single row written by a newer build, and the next updateSettings()
    // write would make that permanent.
    writeRaw({
      fastActions: [
        { id: 'fa-1', name: 'First', description: 'Do the first thing.' },
        { id: 'fa-2', name: 'Corrupt', description: '' },
        { id: 'fa-3', name: 'Third', description: 'Do the third thing.' },
      ],
    });

    const kept = readSettings().fastActions;
    expect(kept.map((a) => a.id)).toEqual(['fa-1', 'fa-3']);
  });

  it('a list longer than the cap is truncated on read, not loaded whole', () => {
    // The cap lives on the ARRAY schema, which the per-entry salvage skips.
    // Unre-applied, an over-long hand-edited file loads in full and then makes
    // every later write fail its own schema — locking the user out of saving.
    writeRaw({
      fastActions: Array.from({ length: MAX_FAST_ACTIONS + 5 }, (_, i) => ({
        id: `fa-${i}`,
        name: `Action ${i}`,
        description: `Do thing ${i}.`,
      })),
    });

    const kept = readSettings().fastActions;
    expect(kept).toHaveLength(MAX_FAST_ACTIONS);
    // Truncated from the END, not the start: the order is the user's own
    // arrangement of their buttons, so slicing the other way would silently
    // delete their FIRST actions rather than the overflow.
    expect(kept[0]?.id).toBe('fa-0');
    expect(kept[kept.length - 1]?.id).toBe(`fa-${MAX_FAST_ACTIONS - 1}`);
  });

  it('a duplicated id costs the later entry — ids are unique after a read', () => {
    // `id` carries no uniqueness constraint and settings.json is hand-editable.
    // Downstream, edit and delete both key on id across the WHOLE list — so a
    // duplicate makes renaming one action silently rewrite another, and
    // deleting one remove two. Enforcing it here keeps that in one place rather
    // than making every consumer defensive.
    writeRaw({
      fastActions: [
        { id: 'dup', name: 'First', description: 'One.' },
        { id: 'dup', name: 'Second', description: 'Two.' },
      ],
    });

    const kept = readSettings().fastActions;
    expect(kept).toHaveLength(1);
    // The FIRST wins, matching the order-preserving rule the sibling tests pin.
    expect(kept[0]?.name).toBe('First');
  });

  it('a non-array fastActions falls back to the default empty list', () => {
    writeRaw({ fastActions: { not: 'an array' }, onboardingComplete: true });

    const settings = readSettings();
    expect(settings.fastActions).toEqual([]);
    expect(settings.onboardingComplete).toBe(true);
  });

  it('a saved run configuration round-trips every field', () => {
    const config = {
      id: 'rc-1',
      name: 'Geniro app',
      cwd: '/Users/dev/geniro-app',
      branch: 'feat/some-branch',
      target: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
      contextWindow: '1m',
      modelParameters: { optimize_for: 'intelligence' },
      approval: 'acceptEdits',
      configDir: '/Users/dev/.config/work',
    };
    writeRaw({ runConfigs: [config] });

    expect(readSettings().runConfigs).toEqual([config]);
  });

  it('a run configuration whose branch is argv-hostile is dropped, not stored', () => {
    // `branch` becomes an argv entry of `git switch`. A leading dash would be
    // read as a flag, so the refname guard is what keeps a hand-edited
    // settings.json from reaching that call — this pins that the settings read
    // applies it, not merely that the IPC write does. Nothing on the fast-action
    // side can cover this: an action reaches no privileged sink.
    writeRaw({
      runConfigs: [
        {
          id: 'rc-bad',
          name: 'Hostile',
          cwd: '/Users/dev/one',
          branch: '--upload-pack=touch /tmp/pwned',
          target: 'claude',
          model: null,
          effort: null,
          approval: null,
          configDir: null,
        },
      ],
    });

    expect(readSettings().runConfigs).toEqual([]);
  });

  it('salvages named configurations entry-by-entry, on the same one function', () => {
    // The THIRD hand-managed list to go through `salvageList`, and this is what
    // stops it being the one that silently loses the fix the other two have. A
    // configuration is a name and a colour the user typed onto a directory —
    // unrecoverable, like an action, so one bad row written by a newer build
    // must not take the rest with it.
    writeRaw({
      configProfiles: [
        {
          id: 'cp-1',
          agent: 'claude',
          name: 'Work',
          dir: '/Users/x/.claude-work',
          color: 'blue',
        },
        // Colour outside the palette: the one field here that is ENUMERATED
        // rather than a bounded string, because the palette is the app's own.
        {
          id: 'cp-2',
          agent: 'claude',
          name: 'Broken',
          dir: '/Users/x/.claude-b',
          color: 'chartreuse',
        },
        // A relative directory — `absolutePath` refuses it, and a run pointed
        // at one would resolve against whatever cwd the daemon happened to have.
        {
          id: 'cp-3',
          agent: 'claude',
          name: 'Relative',
          dir: '.claude-rel',
          color: 'green',
        },
        {
          id: 'cp-4',
          agent: 'claude',
          name: 'Lab',
          dir: '/Users/x/.claude-lab',
          color: 'teal',
        },
      ],
    });

    const kept = readSettings().configProfiles;
    expect(kept.map((p) => p.id)).toEqual(['cp-1', 'cp-4']);
  });

  it('drops a DUPLICATE configuration id rather than letting one row shadow another', () => {
    // Ids must be unique across every hand-managed list, and only the read path
    // can guarantee it: every consumer keys on the id, so a duplicate in a
    // hand-edited file makes renaming one entry rewrite another and deleting
    // one remove two.
    writeRaw({
      configProfiles: [
        {
          id: 'cp-1',
          agent: 'claude',
          name: 'Work',
          dir: '/Users/x/.claude-work',
          color: 'blue',
        },
        {
          id: 'cp-1',
          agent: 'claude',
          name: 'Shadow',
          dir: '/Users/x/.claude-two',
          color: 'red',
        },
      ],
    });

    const kept = readSettings().configProfiles;
    expect(kept).toHaveLength(1);
    expect(kept[0]!.name).toBe('Work');
  });

  it('reads the per-agent shape as written, and a bad entry costs only itself', () => {
    writeRaw({
      configDirs: { codex: '/Users/x/.codex-work', claude: 'relative' },
      recentConfigDirs: {
        codex: ['/Users/x/.codex-work'],
        claude: ['/Users/x/.claude-a'],
      },
    });

    const settings = readSettings();
    expect(settings.configDirs).toEqual({ codex: '/Users/x/.codex-work' });
    expect(settings.recentConfigDirs).toEqual({
      codex: ['/Users/x/.codex-work'],
      claude: ['/Users/x/.claude-a'],
    });
  });

  it('salvages run configurations entry-by-entry, exactly as it does actions', () => {
    // The two lists share ONE salvage function, so this is what stops that
    // function from being fixed for one list and left broken for the other —
    // and a configuration is hand-made and unrecoverable, which is the whole
    // reason the salvage is per entry rather than per array.
    writeRaw({
      runConfigs: [
        {
          id: 'rc-1',
          name: 'First',
          cwd: '/Users/dev/one',
          branch: null,
          target: 'claude',
          model: null,
          effort: null,
          contextWindow: null,
          modelParameters: {},
          approval: null,
          configDir: null,
        },
        { id: 'rc-2', name: 'Corrupt', cwd: 'not-absolute' },
        {
          id: 'rc-3',
          name: 'Third',
          cwd: '/Users/dev/three',
          branch: null,
          target: 'cursor-agent',
          model: null,
          effort: null,
          contextWindow: null,
          modelParameters: {},
          approval: null,
          configDir: null,
        },
      ],
    });

    expect(readSettings().runConfigs.map((c) => c.id)).toEqual([
      'rc-1',
      'rc-3',
    ]);
  });

  it('one invalid cliPaths entry (relative path) costs only that entry — the valid sibling survives', () => {
    // Same blast-radius rule one level down: a corrupted or hand-edited
    // relative path under one agent kind must not silently drop the OTHER
    // agent's valid absolute path (which then never spawns from its
    // configured binary again after the next settings write).
    writeRaw({
      cliPaths: {
        claude: '/usr/local/bin/claude',
        'cursor-agent': 'not-an-absolute-path',
      },
    });

    expect(readSettings().cliPaths).toEqual({
      claude: '/usr/local/bin/claude',
    });
  });
});

describe('updateSettings over a file that does not parse', () => {
  function settingsFile(): string {
    return join(mocks.userData, 'settings.json');
  }

  function backups(): string[] {
    return readdirSync(mocks.userData).filter((name) =>
      name.startsWith('settings.json.corrupt-'),
    );
  }

  // A truncated write (a crash mid-save by an older build, a disk that filled)
  // and a file that parses but is not an object. The read answers both with
  // DEFAULTS, so the next write — defaults plus one field — was renamed over
  // the only copy of every hand-written list and the custom instructions.
  it.each([
    [
      'truncated JSON',
      '{"customInstructions":"always write tests","runConfigs":[{"id":"rc-1"',
    ],
    ['a non-object', '["not", "an", "object"]'],
  ])(
    'keeps the original bytes of %s in a 0600 backup before the first write replaces it',
    (_label, original) => {
      mkdirSync(mocks.userData, { recursive: true });
      writeFileSync(settingsFile(), original, 'utf8');

      updateSettings({ onboardingComplete: true });

      const [backup, ...extra] = backups();
      expect(extra).toEqual([]);
      if (backup === undefined) {
        throw new Error('expected a settings.json.corrupt-* backup');
      }
      const backupPath = join(mocks.userData, backup);
      expect(readFileSync(backupPath, 'utf8')).toBe(original);
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
      // The write itself still lands: the app keeps working on defaults.
      expect(readSettings().onboardingComplete).toBe(true);

      // ONCE per corruption: the file parses after that write, so a second
      // write has nothing to preserve and must not pile up copies.
      updateSettings({ checkForUpdates: false });
      expect(backups()).toEqual([backup]);
    },
  );

  it('never copies aside a file that parses', () => {
    writeRaw({ onboardingComplete: true, customInstructions: 'keep me' });

    updateSettings({ checkForUpdates: false });

    expect(backups()).toEqual([]);
    expect(readSettings().customInstructions).toBe('keep me');
  });

  it('refuses the write outright when the existing file cannot even be read', () => {
    // Its bytes cannot be preserved, so replacing them is the very loss the
    // backup exists to prevent — the write fails instead, and the file stays.
    const original = '{"customInstructions":"unreadable but mine"';
    mkdirSync(mocks.userData, { recursive: true });
    writeFileSync(settingsFile(), original, 'utf8');
    chmodSync(settingsFile(), 0o000);

    try {
      expect(() => updateSettings({ onboardingComplete: true })).toThrow(
        /EACCES/,
      );
    } finally {
      chmodSync(settingsFile(), 0o600);
    }
    expect(readFileSync(settingsFile(), 'utf8')).toBe(original);
  });
});

describe('sharing settings', () => {
  const GCS = {
    kind: 'gcs',
    id: 'company',
    name: 'Company',
    linkBase: 'https://artifacts.example.com',
    bucket: 'company-share',
  };

  it('defaults to nowhere to share and agents not allowed', () => {
    expect(readSettings().sharing).toEqual({
      destinations: [],
      defaultDestinationId: null,
      agentsMayShare: false,
      autoRevokeAfterDays: null,
    });
  });

  it('one broken destination costs only itself — the others and the switch survive', () => {
    writeRaw({
      sharing: {
        destinations: [
          GCS,
          { ...GCS, id: 'plain-http', linkBase: 'http://insecure.example' },
          { ...GCS, name: 'Duplicate id' },
          {
            kind: 'command',
            id: 'shell',
            name: 'Shell',
            linkBase: 'https://x.example',
            upload: ['/bin/sh', '-c', 'put {file}'],
            remove: ['/bin/rm'],
          },
        ],
        defaultDestinationId: 'company',
        agentsMayShare: true,
        autoRevokeAfterDays: 30,
      },
    });

    expect(readSettings().sharing).toEqual({
      destinations: [GCS],
      defaultDestinationId: 'company',
      agentsMayShare: true,
      autoRevokeAfterDays: 30,
    });
  });

  it('a broken sign-in field costs only that field, never the destination agents share to', () => {
    const COMMAND = {
      kind: 'command',
      id: 'team',
      name: 'Team bucket',
      linkBase: 'https://x.example',
      upload: ['gcloud', 'storage', 'cp', '{file}', 'gs://b/{object}'],
      remove: ['gcloud', 'storage', 'rm', 'gs://b/{object}'],
    };
    writeRaw({
      sharing: {
        destinations: [
          {
            ...COMMAND,
            signIn: {
              login: ['/bin/sh', '-c', 'login'],
              patterns: ['expired'],
            },
          },
          { ...COMMAND, id: 'whole', signIn: 'not an object' },
        ],
        defaultDestinationId: 'team',
        agentsMayShare: true,
      },
    });

    expect(readSettings().sharing.destinations).toEqual([
      { ...COMMAND, signIn: { patterns: ['expired'] } },
      { ...COMMAND, id: 'whole' },
    ]);
  });

  it('a default naming a dropped destination falls back to none', () => {
    writeRaw({
      sharing: {
        destinations: [GCS],
        defaultDestinationId: 'gone',
        agentsMayShare: 'yes',
      },
    });

    expect(readSettings().sharing).toEqual({
      destinations: [GCS],
      defaultDestinationId: null,
      agentsMayShare: false,
      autoRevokeAfterDays: null,
    });
  });

  it.each([0, 2.5, '30', 3651])(
    'an auto-revoke window of %j reads as never, keeping the rest',
    (days) => {
      writeRaw({
        sharing: {
          destinations: [GCS],
          defaultDestinationId: 'company',
          agentsMayShare: true,
          autoRevokeAfterDays: days,
        },
      });

      expect(readSettings().sharing).toEqual({
        destinations: [GCS],
        defaultDestinationId: 'company',
        agentsMayShare: true,
        autoRevokeAfterDays: null,
      });
    },
  );
});

describe('memory settings', () => {
  it('settings salvage keeps the key and a corrupt value reads as null', () => {
    expect(readSettings().memoryAutoForgetAfterDays).toBeNull();

    writeRaw({ memoryAutoForgetAfterDays: 30, onboardingComplete: true });
    expect(readSettings().memoryAutoForgetAfterDays).toBe(30);

    for (const memoryAutoForgetAfterDays of ['x', 0, 5000]) {
      writeRaw({ memoryAutoForgetAfterDays, onboardingComplete: true });

      const settings = readSettings();
      expect(settings.memoryAutoForgetAfterDays).toBeNull();
      expect(settings.onboardingComplete).toBe(true);
    }

    writeRaw({ onboardingComplete: true });
    expect(readSettings().memoryAutoForgetAfterDays).toBeNull();
  });

  it('removing entries agents mark not useful is on by default and keeps a saved off', () => {
    expect(readSettings().memoryRemoveNotUseful).toBe(true);

    writeRaw({ memoryRemoveNotUseful: false, onboardingComplete: true });
    expect(readSettings().memoryRemoveNotUseful).toBe(false);

    for (const memoryRemoveNotUseful of ['no', 0, null]) {
      writeRaw({ memoryRemoveNotUseful, onboardingComplete: true });

      const settings = readSettings();
      expect(settings.memoryRemoveNotUseful).toBe(true);
      expect(settings.onboardingComplete).toBe(true);
    }
  });

  it('a half-valid memory object keeps its valid field and defaults the other', () => {
    writeRaw({ memory: { enabled: false, agentWrites: 'bogus' } });

    expect(readSettings().memory).toEqual({
      enabled: false,
      agentWrites: 'active',
      nativeMemoryOff: false,
    });
  });
});

describe('knowledge settings', () => {
  it('a half-valid knowledge object keeps its valid field and defaults the other', () => {
    writeRaw({ knowledge: { enabled: false, agentWrites: 'bogus' } });

    expect(readSettings().knowledge).toEqual({
      enabled: false,
      agentWrites: 'direct',
    });
  });

  it('a file from before the setting reads it on, with agent writes saved at once', () => {
    writeRaw({});

    expect(readSettings().knowledge).toEqual({
      enabled: true,
      agentWrites: 'direct',
    });
  });

  it('keeps an agent-writes choice the file already holds', () => {
    writeRaw({ knowledge: { enabled: true, agentWrites: 'review' } });

    expect(readSettings().knowledge).toEqual({
      enabled: true,
      agentWrites: 'review',
    });
  });
});

describe('lessons settings', () => {
  it('a half-valid lessons object keeps its valid fields and defaults the rest', () => {
    writeRaw({
      lessons: {
        mode: 'off',
        reflector: {
          agent: 'codex',
          configDir: 'relative/profile',
          model: 'gpt-6-luna',
          effort: 'low',
          contextWindow: null,
          modelParameters: { speed: 'fast' },
        },
        checker: { agent: 'not-a-cli', configDir: null },
      },
    });

    expect(readSettings().lessons).toEqual({
      mode: 'off',
      reflector: {
        agent: 'codex',
        configDir: null,
        model: 'gpt-6-luna',
        effort: 'low',
        contextWindow: null,
        modelParameters: { speed: 'fast' },
      },
      checker: null,
    });
  });

  it('a bad mode reads as automatic reflections', () => {
    writeRaw({
      lessons: { mode: 'sometimes', reflector: null, checker: null },
    });

    expect(readSettings().lessons).toEqual({
      mode: 'auto',
      reflector: null,
      checker: null,
    });
  });

  it('a dev-stand file in the old shape reads offer as automatic and its agent as the reflector', () => {
    writeRaw({
      lessons: {
        mode: 'offer',
        agentKind: 'codex',
        model: 'gpt-6-luna',
        effort: 'low',
        quietWindowHours: 6,
      },
    });

    expect(readSettings().lessons).toEqual({
      mode: 'auto',
      reflector: {
        agent: 'codex',
        configDir: null,
        model: 'gpt-6-luna',
        effort: 'low',
        contextWindow: null,
        modelParameters: {},
      },
      checker: null,
    });
  });

  it('a dev-stand file with no agent reads the thread’s own CLI, and a model with no agent is dropped', () => {
    writeRaw({
      lessons: {
        mode: 'off',
        agentKind: null,
        model: 'opus',
        effort: null,
        quietWindowHours: 3,
      },
    });

    expect(readSettings().lessons).toEqual({
      mode: 'off',
      reflector: null,
      checker: null,
    });
  });

  it('a dev-stand agent field that is not text leaves the reflector on the thread’s own CLI', () => {
    writeRaw({
      lessons: {
        mode: 'offer',
        agentKind: 42,
        model: 'opus',
        effort: 'high',
        quietWindowHours: 3,
      },
    });

    expect(readSettings().lessons).toEqual({
      mode: 'auto',
      reflector: null,
      checker: null,
    });
  });

  it('a file from before the setting reflects automatically on the thread’s own CLI', () => {
    writeRaw({});

    expect(readSettings().lessons).toEqual({
      mode: 'auto',
      reflector: null,
      checker: null,
    });
  });
});

describe('resource alert settings', () => {
  const GIB = 1024 ** 3;

  it('a half-valid object keeps its valid fields and defaults the rest', () => {
    writeRaw({
      resourceAlerts: {
        enabled: false,
        threadMemoryBytes: 4 * GIB,
        growthBytesPerMinute: -1,
        minFreeDiskBytes: 'lots',
      },
    });

    expect(readSettings().resourceAlerts).toEqual({
      enabled: false,
      threadMemoryBytes: 4 * GIB,
      growthBytesPerMinute: GIB,
      minFreeDiskBytes: 10 * GIB,
    });
  });

  it('a file from before the setting reads it on, at 8 GB, 1 GB/min and 10 GB free', () => {
    writeRaw({});

    expect(readSettings().resourceAlerts).toEqual({
      enabled: true,
      threadMemoryBytes: 8 * GIB,
      growthBytesPerMinute: GIB,
      minFreeDiskBytes: 10 * GIB,
    });
  });
});

describe('onSettingsWritten', () => {
  it('tells a listener every write, with the settings as written', () => {
    const seen: boolean[] = [];
    const stop = onSettingsWritten((settings) =>
      seen.push(settings.sharing.agentsMayShare),
    );

    updateSettings({
      sharing: {
        destinations: [],
        defaultDestinationId: null,
        agentsMayShare: true,
        autoRevokeAfterDays: null,
      },
    });
    stop();
    updateSettings({ sidebarCollapsed: true });

    expect(seen).toEqual([true]);
  });
});
