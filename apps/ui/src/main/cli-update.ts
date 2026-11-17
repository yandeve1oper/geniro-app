import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, sep } from 'node:path';
import { promisify } from 'node:util';

import type {
  CliDetection,
  CliKind,
  CliUpdateResult,
  CliUpdateState,
  Settings,
} from '../shared/contracts';
import type { RecordedLatestProbe } from './agents/agent-descriptor';
import { descriptorFor } from './agents/agent-descriptors';
import { probeVersion } from './cli-version';
import { probeEnv } from './probe-env';
import { resolveBinary } from './resolve-binary';

const execFileAsync = promisify(execFile);

/**
 * Nothing is known, and nothing is claimed — the state for a CLI that was not
 * found at all. `checkUnavailableReason` stays null there deliberately: the
 * card already says "not found on PATH", and explaining why an absent binary
 * cannot be asked about updates would be the second answer to a question the
 * user is not asking.
 */
export const UNKNOWN_CLI_UPDATE: CliUpdateState = {
  available: null,
  latestVersion: null,
  checkUnavailableReason: null,
};

/**
 * The same 5s budget the version and login probes use, and a network call
 * inside it (measured 1188ms). Exceeding it yields `null` — "not known" — which
 * is the safe direction: a slow link costs the user the readout, never a wrong
 * claim about their install.
 */
const PROBE_TIMEOUT_MS = 5000;

/**
 * An update DOWNLOADS AND INSTALLS a whole CLI — claude's native build is
 * ~200MB — so this is minutes, not seconds, and shares no budget with the
 * probes above.
 */
const UPDATE_TIMEOUT_MS = 10 * 60_000;

/** How much of a failed updater's output travels back for the user to read. */
const MAX_OUTPUT_CHARS = 2000;

/**
 * Ask one CLI whether a newer version of it exists, through its own
 * descriptor's probe (`agents/`). Never installs anything.
 *
 * Every failure — a command that failed, unparseable output, a status word the
 * CLI does not vouch for — lands on `available: null`. Guessing `false` would hide a real update behind a screen that says
 * there is none; guessing `true` would offer an install with nothing behind it.
 */
export async function probeUpdate(
  kind: CliKind,
  path: string,
  context: UpdateProbeContext,
): Promise<CliUpdateState> {
  const probe = descriptorFor(kind).latestProbe;
  if ('unavailableReason' in probe) {
    return {
      ...UNKNOWN_CLI_UPDATE,
      checkUnavailableReason: probe.unavailableReason,
    };
  }
  if ('recordPath' in probe) {
    return readRecordedUpdate(kind, probe, context);
  }
  try {
    const { stdout } = await execFileAsync(path, [...probe.args], {
      timeout: PROBE_TIMEOUT_MS,
      env: probeEnv(kind),
    });
    return { ...probe.read(stdout), checkUnavailableReason: null };
  } catch {
    return UNKNOWN_CLI_UPDATE;
  }
}

/** What a probe may need beyond the binary itself. */
export interface UpdateProbeContext {
  /**
   * The installed `--version` line — a promise, so a probe that does not need
   * it never waits on it and `detectClis` still runs every probe at once.
   */
  version: Promise<string | null>;
  /** The config homes the user runs this CLI under, besides its default. */
  configDirs: readonly string[];
  /** Injected for specs; the real clock otherwise. */
  now?: number;
}

/**
 * The CLI's own last check, read from the freshest record across its config
 * homes. A record that says "nothing newer" is believed only within the CLI's
 * own re-check interval; past it — or with no record at all — the card says
 * how to get one rather than claiming either answer.
 */
async function readRecordedUpdate(
  kind: CliKind,
  probe: RecordedLatestProbe,
  context: UpdateProbeContext,
): Promise<CliUpdateState> {
  const unanswered: CliUpdateState = {
    ...UNKNOWN_CLI_UPDATE,
    checkUnavailableReason: probe.unansweredReason,
  };
  const installed = await context.version;
  if (installed === null) {
    return unanswered;
  }
  const env = probeEnv(kind);
  const paths = new Set(
    [null, ...context.configDirs].map((dir) =>
      probe.recordPath(dir, env, homedir()),
    ),
  );
  const answers = await Promise.all(
    [...paths].map(async (file) => {
      try {
        return probe.read(await readFile(file, 'utf8'), installed);
      } catch {
        return null;
      }
    }),
  );
  const freshest = answers
    .filter((answer) => answer !== null)
    .sort((a, b) => b.checkedAt - a.checkedAt)[0];
  if (!freshest || freshest.available === null) {
    return unanswered;
  }
  const now = context.now ?? Date.now();
  if (!freshest.available && now - freshest.checkedAt > probe.freshForMs) {
    return unanswered;
  }
  return {
    available: freshest.available,
    latestVersion: freshest.latestVersion,
    checkUnavailableReason: null,
  };
}

/** The longest failure sentence the card shows; the whole output stays on hover. */
const MAX_REASON_CHARS = 240;

/**
 * A path the OS refused to write, in the two shapes updaters print it: node's
 * `EACCES: permission denied, mkdir '/usr/local/lib/…'` (npm repeats it), and a
 * shell-style `permission denied: /usr/local/bin`.
 */
const DENIED_PATH =
  /\b(?:EACCES|EPERM)\b[^\n']*'(\/[^'\n]+)'|permission denied[^\n/']*'?(\/[^'\s]+)/i;

/** `path` with the home directory written as `~`, the way a user reads it. */
function tilde(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}${sep}`)
    ? `~${path.slice(home.length)}`
    : path;
}

/**
 * Whether `a` and `b` share nothing more specific than the root or a directory
 * that holds the home directory — i.e. they belong to two different installs.
 *
 * A same-install denial shares far more: claude's native updater writes beside
 * its own `~/.local/share/claude/versions`, a Homebrew binary beside its own
 * `/opt/homebrew`. Only the mismatched case — the updater writing to a place
 * the running binary is not even under — is worth calling out.
 */
function unrelated(a: string, b: string): boolean {
  const left = a.split(sep);
  const right = b.split(sep);
  let shared = 0;
  while (shared < left.length && left[shared] === right[shared]) {
    shared += 1;
  }
  const common = left.slice(0, shared).join(sep) || sep;
  const home = homedir();
  return (
    common === sep || home === common || home.startsWith(`${common}${sep}`)
  );
}

/**
 * One sentence on why an update failed, for the card to SHOW rather than hide
 * behind a hover.
 *
 * A refused write is the case worth recognising, because it is the common one
 * and the raw output buries it: npm prints the path once in forty lines. When
 * the refused path has nothing to do with where the binary actually runs from,
 * that is the real news — the updater is installing a second copy somewhere
 * else (codex's `npm install -g` against npm's own global prefix rather than
 * the one codex was installed under) and no amount of retrying will reach the
 * copy in use. Anything else is the output's last line, which is where every
 * updater measured so far states its own verdict.
 */
export function updateFailureReason(
  kind: CliKind,
  output: string,
  binaryPath: string,
): string {
  const denied = DENIED_PATH.exec(output);
  const path = denied?.[1] ?? denied?.[2];
  if (path) {
    const runsFrom = dirname(binaryPath);
    return unrelated(path, runsFrom)
      ? `${kind}'s updater could not write ${tilde(path)} — but this ${kind} runs from ${tilde(runsFrom)}, so its updater is installing to a different place than the copy in use.`
      : `${kind}'s updater has no permission to write ${tilde(path)}.`;
  }
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1] ?? output.trim();
  return last.length > MAX_REASON_CHARS
    ? `${last.slice(0, MAX_REASON_CHARS - 1)}…`
    : last;
}

/** The tail of whatever a failed updater said, bounded and trimmed. */
function outputTail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  if (text.length === 0) {
    return null;
  }
  return text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text;
}

/**
 * Run one CLI's own updater, and report what it did in GENIRO's terms.
 *
 * The report is built from two `--version` reads taken either side of the run
 * rather than from the updater's output, and that is the whole design: the two
 * CLIs word their outcome differently and may reword it in any release, while
 * "what does the binary answer now" is a measurement this app takes for itself.
 * The updater's own words survive only for a FAILURE, where geniro has nothing
 * better to offer than what the tool said.
 *
 * The binary is resolved TWICE for the same reason. claude's native install is
 * a symlink into `~/.local/share/claude/versions/<v>` that its updater
 * repoints, so re-resolving after the run reads whatever is installed now
 * instead of trusting a path captured before it moved.
 */
export async function runCliUpdate(
  kind: CliKind,
  settings: Settings,
  verification: CliUpdateVerification = NO_VERIFICATION,
): Promise<CliUpdateResult> {
  const path = resolveBinary(kind, settings.cliPaths[kind]);
  if (!path) {
    return {
      kind,
      ok: false,
      previousVersion: null,
      version: null,
      output: `${kind} was not found on PATH.`,
      reason: `${kind} was not found on PATH.`,
    };
  }
  const previousVersion = await probeVersion(kind, path);
  try {
    await execFileAsync(path, [...descriptorFor(kind).updateArgs], {
      timeout: UPDATE_TIMEOUT_MS,
      env: probeEnv(kind),
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    const failure = err as { stderr?: unknown; stdout?: unknown };
    const said =
      outputTail(failure.stderr) ??
      outputTail(failure.stdout) ??
      (err instanceof Error ? err.message : String(err));
    // The WHOLE output, not the tail the card carries: npm names the refused
    // path near the top and spends the rest of its output on a stack trace.
    const full = [failure.stderr, failure.stdout]
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
    return {
      kind,
      ok: false,
      previousVersion,
      // Read back even on a failure: an updater that swapped the binary and
      // then exited non-zero has still changed what the next turn will run, and
      // a card reporting the pre-run version would be describing a binary that
      // is no longer there.
      version: await probeVersion(
        kind,
        resolveBinary(kind, settings.cliPaths[kind]) ?? path,
      ),
      output: said,
      reason: updateFailureReason(
        kind,
        full.trim().length > 0 ? full : said,
        // The REAL path: an npm install is a symlink in `bin/` into the package
        // it belongs to, and the link's own directory says nothing about that.
        await realpath(path).catch(() => path),
      ),
    };
  }
  const readVersion = (): Promise<string | null> =>
    probeVersion(kind, resolveBinary(kind, settings.cliPaths[kind]) ?? path);
  const settled = await settledVersion(
    previousVersion,
    readVersion,
    verification,
  );
  if (settled.unchanged) {
    const reason = `${kind}'s updater finished, but ${kind} still answers ${settled.version}.`;
    return {
      kind,
      ok: false,
      previousVersion,
      version: settled.version,
      output: reason,
      reason,
    };
  }
  return {
    kind,
    ok: true,
    previousVersion,
    version: settled.version,
    output: null,
    reason: null,
  };
}

/**
 * How long to keep reading `--version` after an updater exited cleanly on the
 * same version while a newer one was known to exist. Some updaters hand the
 * install to a process of their own and exit before it lands.
 */
export interface CliUpdateVerification {
  /** The check before the press said a newer version exists. */
  expectsNewer: Promise<boolean>;
  settleTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Whether the last detection, when there is one, said `kind` has a newer version. */
export async function detectionExpectsNewer(
  kind: CliKind,
  detection: Promise<readonly CliDetection[]> | null,
): Promise<boolean> {
  if (detection === null) {
    return false;
  }
  const detections = await detection.catch(() => []);
  return (
    detections.find((entry) => entry.kind === kind)?.update.available === true
  );
}

const NO_VERIFICATION: CliUpdateVerification = {
  expectsNewer: Promise.resolve(false),
};

const SETTLE_TIMEOUT_MS = 3 * 60_000;
const SETTLE_POLL_MS = 2000;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The version the binary answers once the update has landed. `unchanged` means
 * a newer version was known and the binary still answered the old one at the
 * deadline: the updater exited cleanly without installing it.
 */
async function settledVersion(
  previousVersion: string | null,
  readVersion: () => Promise<string | null>,
  verification: CliUpdateVerification,
): Promise<{ version: string | null; unchanged: boolean }> {
  const first = await readVersion();
  if (
    first === null ||
    first !== previousVersion ||
    !(await verification.expectsNewer.catch(() => false))
  ) {
    return { version: first, unchanged: false };
  }
  const sleep = verification.sleep ?? wait;
  const pollMs = verification.pollMs ?? SETTLE_POLL_MS;
  let waited = 0;
  while (waited < (verification.settleTimeoutMs ?? SETTLE_TIMEOUT_MS)) {
    await sleep(pollMs);
    waited += pollMs;
    const next = await readVersion();
    if (next !== null && next !== previousVersion) {
      return { version: next, unchanged: false };
    }
  }
  return { version: first, unchanged: true };
}
