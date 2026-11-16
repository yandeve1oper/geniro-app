import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { tempDir } from '../../../__tests__/temp-dir';
import {
  removeCursorProfile,
  seedCursorProfile,
  sweepStaleCursorProfiles,
} from './cursor-profile.utils';

const fsFaults = vi.hoisted(() => ({ failWrites: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsFaults.failWrites) {
        throw Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        });
      }
      actual.writeFileSync(...args);
    },
  };
});

/** A fake user home whose `.cursor` holds the two files a real one does. */
function fakeHome(config = '{"model":{"modelId":"claude-opus-5"}}'): string {
  const home = tempDir('cursor-home-');
  const dir = join(home, '.cursor');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cli-config.json'), config);
  // Present so the "not copied" assertion below is about a file that EXISTS —
  // otherwise it would pass for the wrong reason.
  writeFileSync(
    join(dir, 'mcp.json'),
    '{"mcpServers":{"x":{"url":"http://x"}}}',
  );
  return home;
}

describe('seedCursorProfile', () => {
  it("copies the user's cli-config.json, so the turn keeps their settings", () => {
    // The copy is what makes a run that names no model still open on the model
    // the user chose, and keeps their permissions.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome('{"approvalMode":"allowlist"}');

    const dir = seedCursorProfile({ baseDir: base, homeDir: home });

    expect(readFileSync(join(dir, 'cli-config.json'), 'utf8')).toBe(
      '{"approvalMode":"allowlist"}',
    );
  });

  it('opens the handshake on the model the caller named', () => {
    // Not a saving but a correctness fix: a `session/new` reply describes the
    // CURRENT model, so a session opened on the user's default and switched
    // afterwards describes the model being switched away FROM — and nothing
    // downstream can then check the effort against the model the turn will
    // actually run on. Seeded, the first reply already describes it (probed
    // 2026-08-19 on 2026.08.11-e8db854).
    const base = tempDir('cursor-profiles-');
    const home = fakeHome(
      '{"approvalMode":"allowlist","model":{"modelId":"composer-2.5"}}',
    );

    const dir = seedCursorProfile({
      baseDir: base,
      homeDir: home,
      model: 'grok-4.6',
    });

    const written = JSON.parse(
      readFileSync(join(dir, 'cli-config.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(written.model).toEqual({ modelId: 'grok-4.6' });
    // …and the SELECTED form too, which is the one the parameterized handshake
    // resolves. Writing only the first leaves the CLI opening on the other.
    expect(written.selectedModel).toEqual({
      modelId: 'grok-4.6',
      parameters: [],
    });
    // Everything else the user set survives — the seed edits two keys, it does
    // not replace their config.
    expect(written.approvalMode).toBe('allowlist');
  });

  it('leaves the config untouched when no model is named', () => {
    // A turn on "default model" must open on the user's own, which is what the
    // copy is for. Stamping anything here would take that away.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome('{"model":{"modelId":"composer-2.5"}}');

    const dir = seedCursorProfile({ baseDir: base, homeDir: home });

    expect(readFileSync(join(dir, 'cli-config.json'), 'utf8')).toBe(
      '{"model":{"modelId":"composer-2.5"}}',
    );
  });

  it('writes Max Mode ON — the window a model with no `context` parameter runs at', () => {
    // Measured on 2026.08.11-e8db854 with this flag as the ONLY difference
    // between two ACP turns: kimi-k3 reports 200,000 with it off and 1,048,576
    // with it on. See CURSOR_MAX_MODE_CONFIG_KEY.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome('{"approvalMode":"allowlist"}');

    const dir = seedCursorProfile({
      baseDir: base,
      homeDir: home,
      maxMode: true,
    });

    const config: unknown = JSON.parse(
      readFileSync(join(dir, 'cli-config.json'), 'utf8'),
    );
    expect(config).toMatchObject({ maxMode: true, approvalMode: 'allowlist' });
  });

  it('writes Max Mode OFF over a user whose own config leaves it ON', () => {
    // The half that has to be written explicitly. The profile is a COPY of the
    // user's config, so "off" cannot be expressed by leaving the key alone —
    // before this, a geniro chat's window silently followed a switch flipped in
    // the user's own terminal.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome('{"maxMode":true}');

    const dir = seedCursorProfile({
      baseDir: base,
      homeDir: home,
      maxMode: false,
    });

    expect(
      (
        JSON.parse(readFileSync(join(dir, 'cli-config.json'), 'utf8')) as {
          maxMode: unknown;
        }
      ).maxMode,
    ).toBe(false);
  });

  it('leaves an inherited Max Mode alone when the seed names none', () => {
    // The third state, which the PROBE profiles take: a handshake asking what
    // parameters a model offers gets the same answer either way, so it states
    // nothing — and stating `false` there would write a setting nobody chose
    // into a directory that is about to ask a question.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome('{"maxMode":true}');

    const dir = seedCursorProfile({ baseDir: base, homeDir: home });

    expect(readFileSync(join(dir, 'cli-config.json'), 'utf8')).toBe(
      '{"maxMode":true}',
    );
  });

  it('writes the asking approval mode over a user who runs everything', () => {
    // Measured on 2026.10.01-e373342 over ACP: under `unrestricted` a shell
    // command ran with no `session/request_permission`, so geniro's ask/plan
    // turn never got to show a card. See CURSOR_APPROVAL_MODE_CONFIG_KEY.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome(
      '{"approvalMode":"unrestricted","permissions":{"allow":["Shell(ls)"]}}',
    );

    const dir = seedCursorProfile({
      baseDir: base,
      homeDir: home,
      askForApprovals: true,
    });

    expect(
      JSON.parse(readFileSync(join(dir, 'cli-config.json'), 'utf8')),
    ).toEqual({
      approvalMode: 'allowlist',
      autoAcceptWebSearch: false,
      // The user's own allowlist still applies — they chose those commands.
      permissions: { allow: ['Shell(ls)'] },
    });
  });

  it('turns off the user’s web-search auto-accept for an asking turn', () => {
    // Measured on the same build: with it on, a web search ran with no
    // `session/request_permission` even under `allowlist`.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome(
      '{"approvalMode":"allowlist","autoAcceptWebSearch":true}',
    );

    const dir = seedCursorProfile({
      baseDir: base,
      homeDir: home,
      askForApprovals: true,
    });

    expect(
      JSON.parse(readFileSync(join(dir, 'cli-config.json'), 'utf8')),
    ).toEqual({ approvalMode: 'allowlist', autoAcceptWebSearch: false });
  });

  it('writes the asking approval mode over a READ-ONLY user config', () => {
    // `copyFileSync` keeps the source's mode, so writing through the copy
    // would be refused and leave the user's "run everything" in place.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome('{"approvalMode":"unrestricted"}');
    chmodSync(join(home, '.cursor', 'cli-config.json'), 0o444);

    const dir = seedCursorProfile({
      baseDir: base,
      homeDir: home,
      askForApprovals: true,
    });

    expect(
      JSON.parse(readFileSync(join(dir, 'cli-config.json'), 'utf8')),
    ).toMatchObject({ approvalMode: 'allowlist' });
  });

  it('fails an asking turn whose profile cannot be written, and leaves no profile', () => {
    // The copy may still say "run everything", so running the turn would show
    // no card at all. A model-only patch stays best-effort.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome('{"approvalMode":"unrestricted"}');
    fsFaults.failWrites = true;
    try {
      const modelOnly = seedCursorProfile({
        baseDir: base,
        homeDir: home,
        model: 'grok-4.6',
      });
      // …and its failed write leaves the copy as it was, never no config.
      expect(readFileSync(join(modelOnly, 'cli-config.json'), 'utf8')).toBe(
        '{"approvalMode":"unrestricted"}',
      );
      const before = readdirSync(base).length;

      expect(() =>
        seedCursorProfile({
          baseDir: base,
          homeDir: home,
          askForApprovals: true,
        }),
      ).toThrow(/ask before running tools/);
      expect(readdirSync(base).length).toBe(before);
    } finally {
      fsFaults.failWrites = false;
    }
  });

  it('replaces the user’s permissions with a hard deny on shell and writes for a read-only turn', () => {
    const base = tempDir('cursor-profiles-');
    const home = fakeHome(
      '{"approvalMode":"unrestricted","permissions":{"allow":["Shell(ls)","Mcp(github:*)"]}}',
    );

    const dir = seedCursorProfile({
      baseDir: base,
      homeDir: home,
      askForApprovals: true,
      readOnly: true,
    });

    expect(
      JSON.parse(readFileSync(join(dir, 'cli-config.json'), 'utf8')),
    ).toEqual({
      approvalMode: 'allowlist',
      autoAcceptWebSearch: false,
      permissions: { allow: [], deny: ['Shell(*)', 'Write(**)'] },
    });
  });

  it('fails a read-only turn whose profile cannot be written', () => {
    const base = tempDir('cursor-profiles-');
    const home = fakeHome('{"approvalMode":"allowlist"}');
    fsFaults.failWrites = true;
    try {
      expect(() =>
        seedCursorProfile({ baseDir: base, homeDir: home, readOnly: true }),
      ).toThrow(/could not write the turn profile/);
    } finally {
      fsFaults.failWrites = false;
    }
  });

  it('keeps the user’s own approval mode when the turn does not ask', () => {
    // An `auto` turn approves every request in the driver, and a probe runs no
    // tools — neither has a reason to rewrite the user's setting.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome('{"approvalMode":"unrestricted"}');

    for (const askForApprovals of [false, undefined]) {
      const dir = seedCursorProfile({
        baseDir: base,
        homeDir: home,
        askForApprovals,
      });

      expect(
        readFileSync(join(dir, 'cli-config.json'), 'utf8'),
        String(askForApprovals),
      ).toBe('{"approvalMode":"unrestricted"}');
    }
  });

  it('still names the model when the user has no config to merge into', () => {
    // The defensive branch: an absent or unreadable source config must not cost
    // the turn its model, or a fresh machine silently runs every chat on the
    // CLI's default while the composer says otherwise.
    const base = tempDir('cursor-profiles-');
    const home = tempDir('cursor-home-empty-');

    const dir = seedCursorProfile({
      baseDir: base,
      homeDir: home,
      model: 'grok-4.6',
    });

    expect(
      (
        JSON.parse(readFileSync(join(dir, 'cli-config.json'), 'utf8')) as {
          model?: unknown;
        }
      ).model,
    ).toEqual({ modelId: 'grok-4.6' });
  });

  it('never copies mcp.json — a 0600 file holding the user’s own tokens', () => {
    // Measured to be unnecessary: under a directory holding only cli-config.json
    // an ACP session still loads the folder's MCP servers, because the CLI
    // resolves that file from the user's home either way. So copying it would
    // duplicate credentials into a temp dir for nothing.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome();

    const dir = seedCursorProfile({ baseDir: base, homeDir: home });

    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(true);
    expect(readdirSync(dir)).toEqual(['cli-config.json']);
  });

  it('gives each turn its own directory', () => {
    // Two turns of one run can be in flight together under team fan-out, and
    // they apply DIFFERENT models — sharing a directory is the same race the
    // per-turn profile exists to remove, moved one level in.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome();

    const first = seedCursorProfile({ baseDir: base, homeDir: home });
    const second = seedCursorProfile({ baseDir: base, homeDir: home });

    expect(first).not.toBe(second);
  });

  it('still yields a usable directory when the user has no config at all', () => {
    // A fresh install, or an unreadable file. The CLI writes its own defaults, so
    // a missing source must not fail the turn over a file we merely wanted.
    const base = tempDir('cursor-profiles-');

    const dir = seedCursorProfile({
      baseDir: base,
      homeDir: tempDir('empty-home-'),
    });

    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('seedCursorProfile — the conversation store', () => {
  it('links acp-sessions at the shared store, not at a directory of its own', () => {
    // The CLI keeps each ACP conversation at `<configDir>/acp-sessions/<id>/`,
    // so a store INSIDE the throwaway profile is deleted with it — which is
    // exactly what shipped, and every cursor chat's second message then died at
    // `session/load` with "Session not found". Drop the link and this fails.
    const base = tempDir('cursor-profiles-');
    const store = join(tempDir('cursor-store-'), 'cursor-sessions');

    const dir = seedCursorProfile({
      baseDir: base,
      sessionStoreDir: store,
      homeDir: fakeHome(),
    });

    const link = join(dir, 'acp-sessions');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(store));
  });

  it('creates the store when it does not exist yet — the first ever turn', () => {
    const base = tempDir('cursor-profiles-');
    const store = join(tempDir('cursor-store-'), 'nested', 'cursor-sessions');
    expect(existsSync(store)).toBe(false);

    seedCursorProfile({
      baseDir: base,
      sessionStoreDir: store,
      homeDir: fakeHome(),
    });

    expect(existsSync(store)).toBe(true);
  });

  it('lets a LATER turn’s profile reach the session the first one wrote', () => {
    // The whole point, asserted on the observable rather than on the link: turn
    // 2 runs under a different profile and must still find turn 1's session
    // directory, because that is what `session/load` reads.
    const base = tempDir('cursor-profiles-');
    const store = join(tempDir('cursor-store-'), 'cursor-sessions');
    const home = fakeHome();

    const first = seedCursorProfile({
      baseDir: base,
      sessionStoreDir: store,
      homeDir: home,
    });
    // Stand in for the CLI writing a session through the link.
    mkdirSync(join(first, 'acp-sessions', 'session-1'), { recursive: true });
    removeCursorProfile(first);

    const second = seedCursorProfile({
      baseDir: base,
      sessionStoreDir: store,
      homeDir: home,
    });

    expect(existsSync(join(second, 'acp-sessions', 'session-1'))).toBe(true);
  });

  it('leaves the store out when the caller names none — a probe’s own session', () => {
    // `listModels` opens a real `session/new`, and a throwaway handshake's
    // conversation has no business in the store a chat resumes from. Absent
    // means the CLI writes acp-sessions INSIDE the profile, which dies with it.
    const base = tempDir('cursor-profiles-');

    const dir = seedCursorProfile({ baseDir: base, homeDir: fakeHome() });

    expect(existsSync(join(dir, 'acp-sessions'))).toBe(false);
  });
});

describe('removeCursorProfile / sweepStaleCursorProfiles', () => {
  it('removes one turn’s directory and everything the CLI wrote into it', () => {
    const base = tempDir('cursor-profiles-');
    const dir = seedCursorProfile({
      baseDir: base,
      homeDir: fakeHome(),
    });
    // The CLI's own ~690KB cache lands here; the disposer has to take it too.
    writeFileSync(join(dir, 'statsig-cache.json'), '{}');

    removeCursorProfile(dir);

    expect(existsSync(dir)).toBe(false);
  });

  it('unlinks the store rather than deleting the conversations behind it', () => {
    // `node:fs` removes a tree by `lstat`, so the symlink is unlinked instead of
    // descended into. Asserted because the whole scheme rests on it: follow the
    // link and the disposer would delete every cursor thread on every turn.
    const base = tempDir('cursor-profiles-');
    const store = join(tempDir('cursor-store-'), 'cursor-sessions');
    const dir = seedCursorProfile({
      baseDir: base,
      sessionStoreDir: store,
      homeDir: fakeHome(),
    });
    mkdirSync(join(store, 'session-1'), { recursive: true });

    removeCursorProfile(dir);

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(store, 'session-1'))).toBe(true);
  });

  it('does not throw on a directory that is already gone', () => {
    // The disposer runs on exactly one settle path, but a boot sweep may have
    // taken the whole base directory first.
    expect(() =>
      removeCursorProfile(join(tempDir('cursor-profiles-'), 'nope')),
    ).not.toThrow();
  });

  it('sweeps what a SIGKILLed daemon left behind', () => {
    // The only way a leftover exists: a killed daemon runs no disposer at all.
    const base = tempDir('cursor-profiles-');
    seedCursorProfile({ baseDir: base, homeDir: fakeHome() });
    seedCursorProfile({ baseDir: base, homeDir: fakeHome() });
    expect(readdirSync(base).length).toBe(2);

    sweepStaleCursorProfiles(base);

    expect(existsSync(base)).toBe(false);
  });

  it('the boot sweep keeps the conversations — it takes the profiles only', () => {
    // The sweep removes its base WHOLESALE, so a store nested inside it would be
    // deleted on every launch: every cursor thread unresumable after a restart,
    // the same failure the per-turn profile caused, moved to boot. This is what
    // holds the two directories apart.
    const base = tempDir('cursor-profiles-');
    const store = join(tempDir('cursor-store-'), 'cursor-sessions');
    const dir = seedCursorProfile({
      baseDir: base,
      sessionStoreDir: store,
      homeDir: fakeHome(),
    });
    mkdirSync(join(dir, 'acp-sessions', 'session-1'), { recursive: true });

    sweepStaleCursorProfiles(base);

    expect(existsSync(base)).toBe(false);
    expect(existsSync(join(store, 'session-1'))).toBe(true);
  });
});
