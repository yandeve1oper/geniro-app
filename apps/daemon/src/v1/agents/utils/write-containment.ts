import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { fsErrorCode } from './fs-error-code';
import { isWithinDirectory } from './path-within';

/**
 * Where a write to `target` would land relative to `root`: `inside` it,
 * `outside` it by its path alone, or outside it only once links are followed
 * (`through-link`). A path relative to `root` is read against it.
 *
 * The ONE answer for every write geniro lets through without the user looking —
 * a patch the user accepted (`applyHostPatch`) and a codex file change
 * `acceptEdits` takes unasked — so a hardening lands in both at once. What no
 * judgement of a PATH can see is a hard link, which is {@link hasOtherHardLinks}'s
 * to answer.
 *
 * A path is followed the way the kernel follows it ({@link landing}), and it is
 * followed TWICE, because a writer may take either of two readings of one
 * string: AS WRITTEN, where a `..` after a link steps out of the link's target,
 * and RESOLVED first, where `..` is collapsed before the kernel sees the path —
 * what `path.resolve` does, and what codex's own patch applier was measured to
 * do. `inside` only when both land inside. A caller that knows its writer
 * resolves first passes the resolved path, which makes the two one reading
 * (`applyHostPatch`); a CLI's writer is not ours to know, so its raw path must
 * pass both.
 */
export function writeContainment(
  root: string,
  target: string,
): 'inside' | 'outside' | 'through-link' {
  const { base, written, resolved } = readingsOf(root, target);
  if (!isWithinDirectory(resolved, base)) {
    return 'outside';
  }
  const home = landing(base);
  const asWritten = landing(written);
  const asResolved = landing(resolved);
  return home !== null &&
    asWritten !== null &&
    asResolved !== null &&
    isWithinDirectory(asWritten, home) &&
    isWithinDirectory(asResolved, home)
    ? 'inside'
    : 'through-link';
}

/**
 * Whether the existing file `target` names, read against `root`, shares its
 * contents with another name — under EITHER reading of the path, and at the
 * place {@link landing} puts a write to each, which is what
 * {@link writeContainment} judged: a `link/..` lands on one file as written and
 * on another once collapsed, and a directory that does not exist yet before a
 * `..` is walked there, where a stat of the raw string would stop at the gap.
 *
 * A hard link reads as an ordinary file inside the folder, yet writing it
 * writes whatever else shares its inode — possibly a file outside. Nothing in
 * the path says so, which is why {@link writeContainment} cannot. A link at the
 * name is followed, since the file it lands on is the one written; a path that
 * names nothing, or a directory, is not one. A link that leads nowhere, or a
 * path that cannot be examined at all, is answered as if it were: this guards a
 * write nobody looks at, so it fails toward a card.
 *
 * Synchronous for `writeContainment`'s reason. `applyHostPatch` asks the same
 * question of the file it has open; a caller that only decides beforehand, as
 * codex's auto-accept must, can only ask it of the path.
 */
export function hasOtherHardLinks(root: string, target: string): boolean {
  const { written, resolved } = readingsOf(root, target);
  return [landing(written), landing(resolved)].some(
    (path) => path === null || sharesItsFile(path),
  );
}

/** Errors that mean "there is no file at this path" rather than "cannot tell". */
const NOTHING_THERE = new Set(['ENOENT', 'ENOTDIR']);

function sharesItsFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.nlink > 1;
  } catch (error) {
    return !NOTHING_THERE.has(fsErrorCode(error));
  }
}

/**
 * The two ways a writer may read `target` against `root`: as written, and
 * resolved first. Every judgement of a write's path takes both from here, so
 * they cannot come to read one path differently.
 */
function readingsOf(
  root: string,
  target: string,
): { base: string; written: string; resolved: string } {
  const base = resolve(root);
  return {
    base,
    written: isAbsolute(target) ? target : `${base}${sep}${target}`,
    resolved: resolve(base, target),
  };
}

/**
 * Where the kernel would put a write to `path`, following it one component at
 * a time exactly as given: a link is replaced by its real target when it is
 * reached, so a `..` after it steps out of that TARGET, and whatever does not
 * exist yet is appended as written — nothing that is not there can redirect.
 * `null` when a link on the way leads nowhere: a write through a dangling link
 * creates whatever it points at, and a loop has no answer.
 *
 * Component by component rather than one `realpath` of the whole, which cannot
 * answer for a file that does not exist yet: its existing prefix comes back
 * real here — a temp dir under `/var`, itself a link to `/private/var`, still
 * compares equal to its resolved root — with the new part appended to it.
 *
 * Synchronous because one caller decides inside a synchronous protocol handler
 * (codex's file-change auto-accept); the walk is an `lstat` per component.
 */
function landing(path: string): string | null {
  let current: string = sep;
  for (const part of path.split(sep)) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch {
      current = next;
      continue;
    }
    if (!isLink) {
      current = next;
      continue;
    }
    try {
      current = realpathSync(next);
    } catch {
      return null;
    }
  }
  return current;
}
