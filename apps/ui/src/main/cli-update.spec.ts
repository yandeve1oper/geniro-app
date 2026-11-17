import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliDetection, CliKind } from '../shared/contracts';
import { DEFAULT_SETTINGS } from '../shared/contracts';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  /** Every (path, args) pair execFile was invoked with, in order. */
  calls: [] as { path: string; args: string[] }[],
  /** What `resolveBinary` answers — null stands for "not on PATH". */
  binary: null as string | null,
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('./resolve-binary', () => ({
  resolveBinary: () => mocks.binary,
}));

import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { CLAUDE_DESCRIPTOR } from './agents/claude';
import { CODEX_DESCRIPTOR } from './agents/codex';
import {
  detectionExpectsNewer,
  probeUpdate,
  runCliUpdate,
  updateFailureReason,
} from './cli-update';

/** A probe context for the probes that read neither the version nor a profile. */
const NO_CONTEXT = { version: Promise.resolve(null), configDirs: [] };

/** codex's own words for a card no record answers. */
const CODEX_UNANSWERED =
  'recordPath' in CODEX_DESCRIPTOR.latestProbe
    ? CODEX_DESCRIPTOR.latestProbe.unansweredReason
    : null;

/** claude's own measured reason it cannot be asked about updates. */
const CLAUDE_CHECK_UNAVAILABLE =
  'unavailableReason' in CLAUDE_DESCRIPTOR.latestProbe
    ? CLAUDE_DESCRIPTOR.latestProbe.unavailableReason
    : null;

type ExecFileCallback = (
  err: Error | null,
  result?: { stdout: string; stderr: string },
) => void;

/**
 * Drive every promisified `execFile` this module makes, keyed on `args` — the
 * version read and the update run go to the same binary and are told apart the
 * same way `cli-detect.spec.ts` tells its two probes apart.
 */
function stubExec(
  handler: (
    file: string,
    args: string[],
  ) => { stdout: string; stderr?: string } | Error,
): void {
  mocks.execFile.mockImplementation(
    (
      file: string,
      args: string[],
      _opts: unknown,
      cb: ExecFileCallback,
    ): void => {
      mocks.calls.push({ path: file, args });
      const outcome = handler(file, args);
      if (outcome instanceof Error) {
        cb(outcome);
        return;
      }
      cb(null, { stdout: outcome.stdout, stderr: outcome.stderr ?? '' });
    },
  );
}

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.execFile.mockReset();
  mocks.binary = '/bin/cursor-agent';
});

describe('probeUpdate', () => {
  /** cursor's own reply shape, verbatim from `about --format json`. */
  const about = (status: string, latest: string): string =>
    JSON.stringify({
      cliVersion: '2026.08.31-4057e58',
      latestStatus: status,
      latestVersion: latest,
      model: 'Composer 2.5',
    });

  it('reads the CLI’s structured answer, not its prose', async () => {
    stubExec(() => ({
      stdout: about('update_available', '2026.09.02-c22c1a3'),
    }));

    await expect(
      probeUpdate('cursor-agent', '/bin/cursor-agent', NO_CONTEXT),
    ).resolves.toEqual({
      available: true,
      latestVersion: '2026.09.02-c22c1a3',
      checkUnavailableReason: null,
    });
    // `about --format json` and nothing else — the human `about` prints the
    // same two facts inside a parenthetical no parser should be reading.
    expect(mocks.calls).toEqual([
      { path: '/bin/cursor-agent', args: ['about', '--format', 'json'] },
    ]);
  });

  it('reports up-to-date as an ANSWER, not as an absence', async () => {
    // The card draws no button on this, so it has to be distinguishable from
    // "nobody asked" — which is the whole reason `available` is three-state.
    stubExec(() => ({ stdout: about('up_to_date', '2026.08.31-4057e58') }));

    await expect(
      probeUpdate('cursor-agent', '/bin/cursor-agent', NO_CONTEXT),
    ).resolves.toMatchObject({ available: false });
  });

  it('claims nothing on a status word the CLI does not vouch for', async () => {
    // Its bundle switches on exactly two — `case"up_to_date":case"update_available":`
    // — so a third value is a vocabulary this app has not measured. Reading an
    // unknown word as either answer would nag about an update that may not
    // exist, or hide one that does.
    stubExec(() => ({ stdout: about('checking', '2026.09.02-c22c1a3') }));

    await expect(
      probeUpdate('cursor-agent', '/bin/cursor-agent', NO_CONTEXT),
    ).resolves.toMatchObject({ available: null });
  });

  it('survives every shape the reply could take', async () => {
    for (const stdout of ['{ not json', '"a string"', '{}', '[]']) {
      stubExec(() => ({ stdout }));
      await expect(
        probeUpdate('cursor-agent', '/bin/cursor-agent', NO_CONTEXT),
      ).resolves.toEqual({
        available: null,
        latestVersion: null,
        checkUnavailableReason: null,
      });
    }

    stubExec(() => new Error('spawn ETIMEDOUT'));
    await expect(
      probeUpdate('cursor-agent', '/bin/cursor-agent', NO_CONTEXT),
    ).resolves.toMatchObject({ available: null });
  });

  it('spawns NOTHING for a CLI with no check, and says why instead', async () => {
    stubExec(() => ({ stdout: 'never reached' }));

    await expect(
      probeUpdate('claude', '/bin/claude', NO_CONTEXT),
    ).resolves.toEqual({
      available: null,
      latestVersion: null,
      checkUnavailableReason: CLAUDE_CHECK_UNAVAILABLE,
    });
    // Not merely "answered null": asking claude for a check would mean running
    // its updater, which installs.
    expect(mocks.calls).toEqual([]);
  });
});

describe('probeUpdate — a CLI that records its own check (codex)', () => {
  const NOW = Date.parse('2026-10-07T12:00:00Z');
  const HOUR = 60 * 60 * 1000;
  const savedHome = process.env.CODEX_HOME;

  /** A config home holding codex's own `version.json`, verbatim in shape. */
  function home(latest: string, checkedAt: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'codex-home-'));
    writeFileSync(
      join(dir, 'version.json'),
      JSON.stringify({
        latest_version: latest,
        last_checked_at: new Date(checkedAt).toISOString(),
        dismissed_version: null,
      }),
    );
    return dir;
  }

  const probe = (configDirs: string[], installed = 'codex-cli 0.157.1') =>
    probeUpdate('codex', '/bin/codex', {
      version: Promise.resolve(installed),
      configDirs,
      now: NOW,
    });

  beforeEach(() => {
    // The default home is an EMPTY directory unless a case fills it, so the
    // developer's own `~/.codex` can never answer a spec.
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'codex-default-'));
    return () => {
      if (savedHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = savedHome;
      }
    };
  });

  it('offers the newer version codex recorded, and runs nothing to learn it', async () => {
    // Five days old and still believed: it is read against the INSTALLED
    // version, so only updating can make it untrue.
    await expect(probe([home('0.160.0', NOW - 120 * HOUR)])).resolves.toEqual({
      available: true,
      latestVersion: '0.160.0',
      checkUnavailableReason: null,
    });
    expect(mocks.calls).toEqual([]);
  });

  it('reads the default home when no profile is named', async () => {
    process.env.CODEX_HOME = home('0.160.0', NOW - HOUR);

    await expect(probe([])).resolves.toMatchObject({ available: true });
  });

  it('says up to date only inside codex’s own 20-hour window', async () => {
    await expect(probe([home('0.157.1', NOW - HOUR)])).resolves.toEqual({
      available: false,
      latestVersion: '0.157.1',
      checkUnavailableReason: null,
    });
    // An installed build NEWER than the record is up to date as well.
    await expect(
      probe([home('0.157.1', NOW - HOUR)], 'codex-cli 0.160.1'),
    ).resolves.toMatchObject({ available: false });

    await expect(probe([home('0.157.1', NOW - 21 * HOUR)])).resolves.toEqual({
      available: null,
      latestVersion: null,
      checkUnavailableReason: CODEX_UNANSWERED,
    });
  });

  it('takes the FRESHEST record across every home', async () => {
    process.env.CODEX_HOME = home('0.158.0', NOW - 72 * HOUR);

    await expect(probe([home('0.160.0', NOW - HOUR)])).resolves.toMatchObject({
      available: true,
      latestVersion: '0.160.0',
    });
  });

  it('claims nothing where codex’s own comparison cannot order the two', async () => {
    // `is_newer("0.161.0-beta.1", …)` is `None` in codex itself.
    await expect(
      probe([home('0.161.0-beta.1', NOW - HOUR)]),
    ).resolves.toMatchObject({ available: null });
  });

  it('says how to get a record when there is none, or no version to read it against', async () => {
    await expect(probe([])).resolves.toEqual({
      available: null,
      latestVersion: null,
      checkUnavailableReason: CODEX_UNANSWERED,
    });

    await expect(
      probeUpdate('codex', '/bin/codex', {
        version: Promise.resolve(null),
        configDirs: [home('0.160.0', NOW - HOUR)],
        now: NOW,
      }),
    ).resolves.toMatchObject({ available: null });
  });
});

describe('runCliUpdate', () => {
  const settings = { ...DEFAULT_SETTINGS };

  /** Answer `--version` with `versions.shift()`, and the update run with ok. */
  function stubUpdate(versions: string[], update?: Error): void {
    stubExec((_file, args) => {
      if (args[0] === '--version') {
        return { stdout: `${versions.shift() ?? 'gone'}\n` };
      }
      return update ?? { stdout: 'Updated.' };
    });
  }

  it('reports the two version reads it took itself, around the CLI’s updater', async () => {
    mocks.binary = '/bin/claude';
    stubUpdate(['2.1.251', '2.1.255']);

    await expect(runCliUpdate('claude', settings)).resolves.toEqual({
      kind: 'claude',
      ok: true,
      previousVersion: '2.1.251',
      version: '2.1.255',
      output: null,
      reason: null,
    });
    // Read, update, read — in that order. Drop either read and the card can
    // only repeat whatever prose the updater happened to print.
    expect(mocks.calls.map((c) => c.args)).toEqual([
      ['--version'],
      ['update'],
      ['--version'],
    ]);
  });

  it('keeps reading the version until a handed-off install lands, when a newer one was known', async () => {
    mocks.binary = '/bin/codex';
    stubUpdate(['0.166.0', '0.166.0', '0.166.0', '0.169.0']);
    const sleep = vi.fn(() => Promise.resolve());

    const result = await runCliUpdate('codex', settings, {
      expectsNewer: Promise.resolve(true),
      pollMs: 10,
      settleTimeoutMs: 1000,
      sleep,
    });

    expect(result.version).toBe('0.169.0');
    expect(result.previousVersion).toBe('0.166.0');
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not wait when nothing newer was known, so "already on the latest" stays immediate', async () => {
    mocks.binary = '/bin/claude';
    stubUpdate(['2.1.255', '2.1.255', '2.1.256']);
    const sleep = vi.fn(() => Promise.resolve());

    const result = await runCliUpdate('claude', settings, {
      expectsNewer: Promise.resolve(false),
      sleep,
    });

    expect(result.version).toBe('2.1.255');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('reports a failure at the deadline when the binary never left the old version', async () => {
    mocks.binary = '/bin/codex';
    stubUpdate(['0.166.0', '0.166.0', '0.166.0', '0.166.0', '0.166.0']);
    const sleep = vi.fn(() => Promise.resolve());

    const result = await runCliUpdate('codex', settings, {
      expectsNewer: Promise.resolve(true),
      pollMs: 10,
      settleTimeoutMs: 30,
      sleep,
    });

    expect(result).toEqual({
      kind: 'codex',
      ok: false,
      previousVersion: '0.166.0',
      version: '0.166.0',
      output: "codex's updater finished, but codex still answers 0.166.0.",
      reason: "codex's updater finished, but codex still answers 0.166.0.",
    });
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('re-reads the version even when the updater FAILED', async () => {
    // An updater that swapped the binary and then exited non-zero has still
    // changed what the next turn runs, so reporting the pre-run figure would
    // describe a binary that is no longer there.
    mocks.binary = '/bin/claude';
    stubUpdate(
      ['2.1.251', '2.1.255'],
      Object.assign(new Error('boom'), {
        stderr: 'error: permission denied\n',
      }),
    );

    await expect(runCliUpdate('claude', settings)).resolves.toEqual({
      kind: 'claude',
      ok: false,
      previousVersion: '2.1.251',
      version: '2.1.255',
      // The tool's own words, trimmed — the one state this app cannot explain.
      output: 'error: permission denied',
      reason: 'error: permission denied',
    });
  });

  it('falls back to stdout when a failing updater wrote nothing to stderr', async () => {
    mocks.binary = '/bin/claude';
    stubUpdate(
      ['2.1.251', '2.1.251'],
      Object.assign(new Error('exit 1'), {
        stderr: '   ',
        stdout: 'could not reach the release server',
      }),
    );

    await expect(runCliUpdate('claude', settings)).resolves.toMatchObject({
      ok: false,
      output: 'could not reach the release server',
    });
  });

  it('never runs anything for a binary that is not there', async () => {
    mocks.binary = null;
    stubExec(() => ({ stdout: 'never reached' }));

    await expect(runCliUpdate('claude', settings)).resolves.toEqual({
      kind: 'claude',
      ok: false,
      previousVersion: null,
      version: null,
      output: 'claude was not found on PATH.',
      reason: 'claude was not found on PATH.',
    });
    expect(mocks.calls).toEqual([]);
  });

  it('runs each CLI’s own update argv', async () => {
    for (const kind of ['claude', 'cursor-agent'] as CliKind[]) {
      mocks.calls.length = 0;
      mocks.binary = `/bin/${kind}`;
      stubUpdate(['1', '1']);

      await runCliUpdate(kind, settings);

      expect(mocks.calls.map((c) => c.path)).toEqual([
        `/bin/${kind}`,
        `/bin/${kind}`,
        `/bin/${kind}`,
      ]);
    }
  });
});

describe('detectionExpectsNewer', () => {
  const detection = (
    kind: CliKind,
    available: boolean | null,
  ): CliDetection => ({
    kind,
    found: true,
    path: `/bin/${kind}`,
    version: '1.0.0',
    loggedIn: null,
    update: { available, latestVersion: null, checkUnavailableReason: null },
  });

  it('reads the pressed CLI’s own answer from the last detection', async () => {
    const last = Promise.resolve([
      detection('claude', true),
      detection('codex', null),
    ]);

    await expect(detectionExpectsNewer('claude', last)).resolves.toBe(true);
    await expect(detectionExpectsNewer('codex', last)).resolves.toBe(false);
  });

  it('expects nothing without a detection, or from one that failed', async () => {
    await expect(detectionExpectsNewer('claude', null)).resolves.toBe(false);
    await expect(
      detectionExpectsNewer('claude', Promise.reject(new Error('probe'))),
    ).resolves.toBe(false);
  });
});

describe('updateFailureReason', () => {
  /** codex 0.157.1's `codex update`, verbatim up to the stack trace. */
  const NPM_EACCES = [
    'Updating Codex via `npm install -g @openai/codex`...',
    'npm error code EACCES',
    'npm error syscall mkdir',
    'npm error path /usr/local/lib/node_modules/@openai',
    'npm error errno -13',
    "npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@openai'",
    'npm error     at async mkdir (node:internal/fs/promises:856:10)',
    'Error: `npm install -g @openai/codex` failed with status exit status: 243',
  ].join('\n');

  it('names the other install when the updater writes somewhere the binary is not', () => {
    // REPORTED: codex lived under ~/.local while npm's global prefix was
    // /usr/local, so every retry failed the same way and the card said only
    // "Update failed".
    const binary = join(
      homedir(),
      '.local/lib/node_modules/@openai/codex/bin/codex.js',
    );

    expect(updateFailureReason('codex', NPM_EACCES, binary)).toBe(
      "codex's updater could not write /usr/local/lib/node_modules/@openai — " +
        'but this codex runs from ~/.local/lib/node_modules/@openai/codex/bin, ' +
        'so its updater is installing to a different place than the copy in use.',
    );
  });

  it('says only "no permission" when the refused path is the binary’s own install', () => {
    const binary = '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js';
    const output =
      "Error: EACCES: permission denied, rename '/opt/homebrew/lib/node_modules/@openai/codex'";

    expect(updateFailureReason('codex', output, binary)).toBe(
      "codex's updater has no permission to write /opt/homebrew/lib/node_modules/@openai/codex.",
    );
  });

  it('reads a shell-style denial too', () => {
    expect(
      updateFailureReason(
        'cursor-agent',
        'install: permission denied: /usr/local/bin/cursor-agent',
        '/usr/local/bin/cursor-agent',
      ),
    ).toBe(
      "cursor-agent's updater has no permission to write /usr/local/bin/cursor-agent.",
    );
  });

  it('falls back to the updater’s last line, where every updater states its verdict', () => {
    expect(
      updateFailureReason(
        'claude',
        'Checking for updates…\n\nerror: could not reach the release server\n',
        '/bin/claude',
      ),
    ).toBe('error: could not reach the release server');
  });

  it('bounds a runaway last line', () => {
    const reason = updateFailureReason(
      'claude',
      'x'.repeat(5000),
      '/bin/claude',
    );

    expect(reason).toHaveLength(240);
    expect(reason.endsWith('…')).toBe(true);
  });
});
