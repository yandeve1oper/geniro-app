import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
  type Settings,
} from '../shared/contracts';
import { descriptorFor } from './agents/agent-descriptors';
import { probeUpdate, UNKNOWN_CLI_UPDATE } from './cli-update';
import { probeVersion } from './cli-version';
import { probeEnv } from './probe-env';
import { loginShellPathSettled } from './process-path';
import { resolveBinary } from './resolve-binary';

const execFileAsync = promisify(execFile);

/**
 * Ask one CLI whether it is signed in, through its own descriptor's probe
 * (`agents/`). `null` on anything that is not a clear answer — no probe for
 * this kind, a command that could not run, unparseable output. Never guess
 * `false`: the readiness chip would tell a signed-in user to sign in.
 *
 * A non-zero exit is handed to the reader rather than read as signed-out here:
 * whether a CLI's non-zero exit is an ANSWER is a fact about that CLI. codex
 * answers "signed out" by exiting 1, and claude 2.1.280 exits 1 for a
 * signed-out profile with the same well-formed `{"loggedIn": false, …}` body it
 * exits 0 with when signed in (2.1.227 exited 0 for both) — so discarding the
 * output of a failed exit would turn every signed-out account into UNKNOWN, and
 * the card would offer nothing to fix it. A throw that carries no readable body
 * (a timeout, a missing binary) is still `null`.
 *
 * THE DAEMON HAS ITS OWN HOME for this CLI's auth facts — `AdapterConfig.auth`
 * in its adapter. This side exists because `detectClis` runs over IPC during
 * onboarding, before any daemon.
 *
 * `configDir` points the probe at one named configuration; omitted, the CLI
 * answers for its own default profile.
 */
async function probeLogin(
  kind: CliKind,
  path: string,
  configDir?: string,
): Promise<boolean | null> {
  const probe = descriptorFor(kind).loginProbe;
  if (!probe) {
    return null;
  }
  const env = {
    ...probeEnv(kind),
    ...(configDir !== undefined && probe.profileEnv !== undefined
      ? probe.profileEnv(configDir)
      : {}),
  };
  try {
    const { stdout, stderr } = await execFileAsync(path, [...probe.args], {
      timeout: 5000,
      env,
    });
    return probe.read({ stdout, stderr, exitCode: 0 });
  } catch (error) {
    const failure = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    // A numeric `code` is the binary's own exit status — it ran and answered.
    // Anything else (ENOENT, a timeout's kill) is a question that failed.
    return typeof failure.code === 'number'
      ? probe.read({
          stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
          stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
          exitCode: failure.code,
        })
      : null;
  }
}

/**
 * Whether each named configuration's ACCOUNT is signed in, keyed by directory.
 *
 * Empty for a CLI whose config directory does not carry the account, which is
 * the honest answer rather than N copies of the default profile's. It is what
 * lets a configuration row offer ONE verb — Sign in or Sign out — instead of
 * both side by side, which is what got reported ("why do we need two login
 * buttons"): with nothing able to say whether a profile was signed in, the row
 * drew both and left the user to guess.
 */
async function probeProfileLogins(
  kind: CliKind,
  path: string,
  settings: Settings,
): Promise<Record<string, boolean | null>> {
  if (descriptorFor(kind).loginProbe?.profileEnv === undefined) {
    return {};
  }
  const answers = await Promise.all(
    profileDirs(kind, settings).map(
      async (dir) => [dir, await probeLogin(kind, path, dir)] as const,
    ),
  );
  return Object.fromEntries(answers);
}

/**
 * The named configurations' directories that are THIS CLI's: a directory
 * belongs to one CLI, and another's probed under it would answer for nobody.
 */
function profileDirs(kind: CliKind, settings: Settings): string[] {
  return [
    ...new Set(
      settings.configProfiles
        .filter((profile) => profile.agent === kind)
        .map((profile) => profile.dir),
    ),
  ];
}

interface HeldDetection {
  key: string;
  at: number;
  answer: Promise<CliDetection[]>;
}

let held: HeldDetection | null = null;

/** What decides the answer besides the machine itself. */
function detectionKey(settings: Settings): string {
  return JSON.stringify([settings.cliPaths, settings.configProfiles]);
}

/**
 * {@link detectClis} answered from the last detection while it is younger than
 * `maxAgeMs` and asked under the same paths and profiles, so a page that reads
 * every member's sign-in on open spawns no probe of its own. A detection still
 * running is joined. Without `maxAgeMs` it detects afresh, and that answer is
 * the one later reads are served.
 */
export function detectClisCached(
  settings: Settings,
  maxAgeMs?: number,
  now: () => number = Date.now,
  detect: (settings: Settings) => Promise<CliDetection[]> = detectClis,
): Promise<CliDetection[]> {
  const key = detectionKey(settings);
  if (
    maxAgeMs !== undefined &&
    held !== null &&
    held.key === key &&
    now() - held.at < maxAgeMs
  ) {
    return held.answer;
  }
  const entry: HeldDetection = {
    key,
    at: now(),
    answer: detect(settings),
  };
  held = entry;
  entry.answer.catch(() => {
    if (held === entry) {
      held = null;
    }
  });
  return entry.answer;
}

/** The last detection made, or null when there is none; never starts a probe. */
export function lastDetection(): Promise<CliDetection[]> | null {
  return held?.answer ?? null;
}

/**
 * Probe the host for each supported CLI agent (path, reported version, and
 * whether it reports itself signed in).
 */
export async function detectClis(settings: Settings): Promise<CliDetection[]> {
  // A CLI that is a node script runs only once PATH can find `node`, and the
  // first detection is asked for while launch is still adopting it.
  await loginShellPathSettled();
  return Promise.all(
    CLI_KINDS.map(async (kind): Promise<CliDetection> => {
      const path = resolveBinary(kind, settings.cliPaths[kind]);
      if (!path) {
        return {
          kind,
          found: false,
          path: null,
          version: null,
          loggedIn: null,
          profileLogins: {},
          update: UNKNOWN_CLI_UPDATE,
        };
      }
      // The probes are independent reads of the same binary, so they run
      // together rather than adding another serial 5s worst case to startup.
      // The update probe is handed the version as a PROMISE: only a probe that
      // reads a recorded check against it waits on it.
      const versionRead = probeVersion(kind, path);
      const [version, loggedIn, profileLogins, update] = await Promise.all([
        versionRead,
        probeLogin(kind, path),
        probeProfileLogins(kind, path, settings),
        probeUpdate(kind, path, {
          version: versionRead,
          configDirs: profileDirs(kind, settings),
        }),
      ]);
      return {
        kind,
        found: version !== null,
        path,
        version,
        loggedIn,
        profileLogins,
        update,
      };
    }),
  );
}
