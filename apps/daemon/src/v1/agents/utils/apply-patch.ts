import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { type FileHandle, mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import type {
  HostPatch,
  HostPatchFingerprint,
  HostPatchOutcome,
} from '../chat.types';
import { fsErrorCode } from './fs-error-code';
import { writeContainment } from './write-containment';

/** Null means no fingerprint could be taken; a whole-file write must refuse it. */
export async function captureHostPatchFingerprint(
  cwd: string,
  patch: HostPatch,
): Promise<HostPatchFingerprint | null> {
  const target = resolve(cwd, patch.filePath);
  if (
    patch.oldString !== undefined ||
    containmentRefusal(cwd, target) !== null
  ) {
    return null;
  }
  let handle: FileHandle;
  try {
    handle = await open(realPathOrSelf(target), constants.O_RDONLY | NO_FOLLOW);
  } catch (err) {
    return fsErrorCode(err) === 'ENOENT' ? 'absent' : null;
  }
  try {
    return (await handle.stat()).isFile()
      ? { sha256: await hashFile(handle) }
      : null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Write a patch the user has ACCEPTED, or say why it could not be written.
 *
 * This is the only place in the render family that touches the user's disk, so
 * it is written to be boring and suspicious in equal measure. Two rules do the
 * real work:
 *
 * **The write must land inside the run's own cwd.** That is the folder the user
 * pointed this chat at, and it is the whole scope they consented to. Checked by
 * `writeContainment` — lexically AND on real paths, because a lexical check
 * alone is satisfied by a symlink that sits inside the folder and points
 * anywhere at all — and handed the path this function actually WRITES, which
 * `resolve` has already collapsed, so a `link/..` is judged where it lands.
 *
 * **A patch with an `oldString` must match EXACTLY ONCE.** Zero matches means
 * the file moved on since the agent read it. More than one means the agent
 * named a fragment that appears again elsewhere, and picking the first is a
 * coin flip on which of them the user actually saw in the diff. Both refuse.
 * Whole-file writes instead require the byte fingerprint captured when the
 * card was raised, checked through the opened handle before truncation.
 *
 * Never throws: every failure is an outcome, because the caller is answering a
 * model over MCP and a stack trace is not an answer. Filesystem errors are
 * reported by their `code` alone — an `ENOENT` message carries the absolute
 * path, and the string this returns is handed to a model whose provider is off
 * this machine.
 */
export async function applyHostPatch(
  cwd: string,
  patch: HostPatch,
  fingerprint: HostPatchFingerprint | null = null,
): Promise<HostPatchOutcome> {
  const target = resolve(cwd, patch.filePath);
  const refused = containmentRefusal(cwd, target);
  if (refused !== null) {
    return refused;
  }
  const irregular = await notRegularFile(target);
  if (irregular !== null) {
    return irregular;
  }

  if (patch.oldString === undefined) {
    if (fingerprint === null) {
      return {
        status: 'stale',
        reason: 'the file’s original state could not be checked',
      };
    }
    // No search text: this is `Write`'s shape — a new file, or a deliberate
    // whole-file replacement. The user saw the entire body as additions.
    try {
      await mkdir(dirname(target), { recursive: true });
    } catch (err) {
      return {
        status: 'stale',
        reason: `the file could not be written (${fsErrorCode(err)})`,
      };
    }
    return writeContained(
      cwd,
      target,
      patch.newString,
      patch.filePath,
      fingerprint,
    );
  }

  let current: string;
  try {
    current = await readFile(realPathOrSelf(target), {
      encoding: 'utf8',
      flag: constants.O_RDONLY | NO_FOLLOW,
    });
  } catch (err) {
    return {
      status: 'stale',
      reason:
        fsErrorCode(err) === 'ENOENT'
          ? 'the file does not exist'
          : `the file could not be read (${fsErrorCode(err)})`,
    };
  }
  const first = current.indexOf(patch.oldString);
  if (first === -1) {
    return {
      status: 'stale',
      reason: 'the text to replace is no longer in the file',
    };
  }
  if (current.indexOf(patch.oldString, first + 1) !== -1) {
    return {
      status: 'stale',
      reason:
        'the text to replace appears more than once — include enough surrounding lines to name one place',
    };
  }
  const next =
    current.slice(0, first) +
    patch.newString +
    current.slice(first + patch.oldString.length);
  return writeContained(cwd, target, next, patch.filePath);
}

const LINK_OUT = 'the path resolves outside this chat’s folder through a link';
const FILE_CHANGED = 'the file changed after the patch was shown';

/**
 * Open flags shared by the read and the write. `O_NOFOLLOW` closes the window
 * between the containment check and the open: a link planted there fails the
 * open (`ELOOP`) rather than redirecting it. `O_NONBLOCK` does the same for a
 * FIFO swapped in, which would otherwise block the open itself; on a regular
 * file it changes nothing.
 */
const NO_FOLLOW = constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * The refusal for something at `target` that is not a regular file, or null.
 *
 * Refused before anything opens it: a FIFO inside the folder would hang the
 * read waiting for a writer, so the patch would never answer at all. Nothing
 * there is the ordinary case for a new file, and the open's to report for an
 * edit — with the sentence the edit path already says. `stale` rather than
 * `unavailable`, on that arm's own terms: the user said yes and this is a path
 * the app will not write to, so the agent's right move is to look at the path
 * again — not to read the refusal as a missing capability.
 */
async function notRegularFile(
  target: string,
): Promise<HostPatchOutcome | null> {
  try {
    if ((await stat(realPathOrSelf(target))).isFile()) {
      return null;
    }
  } catch (err) {
    return fsErrorCode(err) === 'ENOENT'
      ? null
      : {
          status: 'stale',
          reason: `the path could not be checked (${fsErrorCode(err)})`,
        };
  }
  return { status: 'stale', reason: 'the path is not a regular file' };
}

/** The refusal a path's containment earns, or null when it lands inside. */
function containmentRefusal(
  cwd: string,
  target: string,
): HostPatchOutcome | null {
  const containment = writeContainment(cwd, target);
  if (containment === 'outside') {
    return {
      status: 'stale',
      reason: 'the path is outside this chat’s folder',
    };
  }
  if (containment === 'through-link') {
    return { status: 'stale', reason: LINK_OUT };
  }
  return null;
}

/**
 * Write `content` to `target`, judged again at the moment of the write.
 *
 * The check at the top of `applyHostPatch` is separated from the write by
 * awaits — a directory made, a file read — and a link planted in between (by
 * a background command the agent started, say) would carry an accepted write
 * out of the folder. So containment is judged again here; an existing file is
 * opened at its REAL path, with no link at its own name followed — a link
 * inside the folder is still written through, one planted after this check
 * refuses the open; and a file with other hard links is refused, since every
 * check above reads a hard link as an ordinary file and writing it writes the
 * file it shares.
 */
async function writeContained(
  cwd: string,
  target: string,
  content: string,
  filePath: string,
  fingerprint: HostPatchFingerprint | null = null,
): Promise<HostPatchOutcome> {
  const refused = containmentRefusal(cwd, target);
  if (refused !== null) {
    return refused;
  }
  let handle: FileHandle;
  try {
    handle = await open(
      realPathOrSelf(target),
      NO_FOLLOW |
        (fingerprint === null
          ? constants.O_WRONLY | constants.O_CREAT
          : fingerprint === 'absent'
            ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
            : constants.O_RDWR),
      0o666,
    );
  } catch (err) {
    if (
      (fingerprint === 'absent' && fsErrorCode(err) === 'EEXIST') ||
      (fingerprint !== null &&
        fingerprint !== 'absent' &&
        fsErrorCode(err) === 'ENOENT')
    ) {
      return { status: 'stale', reason: FILE_CHANGED };
    }
    return {
      status: 'stale',
      reason:
        fsErrorCode(err) === 'ELOOP'
          ? LINK_OUT
          : `the file could not be written (${fsErrorCode(err)})`,
    };
  }
  try {
    const written = await handle.stat();
    if (!written.isFile()) {
      // Swapped for a directory or a pipe after the check above.
      return { status: 'stale', reason: 'the path is not a regular file' };
    }
    if (written.nlink > 1) {
      return {
        status: 'stale',
        reason:
          'the file has other hard links, so writing it could change a file outside this chat’s folder',
      };
    }
    if (
      fingerprint !== null &&
      fingerprint !== 'absent' &&
      (await hashFile(handle)) !== fingerprint.sha256
    ) {
      return { status: 'stale', reason: FILE_CHANGED };
    }
    await handle.truncate(0);
    await handle.writeFile(content, 'utf8');
  } catch (err) {
    return {
      status: 'stale',
      reason: `the file could not be written (${fsErrorCode(err)})`,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { status: 'applied', path: relative(cwd, target) || filePath };
}

async function hashFile(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  for (;;) {
    // Positional reads leave the descriptor at zero for the subsequent write.
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      return hash.digest('hex');
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

/** An existing path with every link resolved, or the path itself for a new one. */
function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
