import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BadRequestException, NotFoundException } from '@packages/common';

import {
  ARTIFACT_IMAGE_MEDIA_TYPE,
  type ArtifactImageExtension,
  type ArtifactImageMediaType,
} from './artifact-html-images';
import { fsErrorCode } from './fs-error-code';
import { isWithinDirectory } from './path-within';

/** The largest single image one published page may reference. */
export const MAX_ARTIFACT_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * The most image bytes one published page may show in total. A picture counts
 * each time the page shows it: the served page carries every reference in full,
 * so this is what bounds the frame, however many references there are.
 */
export const MAX_ARTIFACT_PAGE_IMAGE_BYTES = 64 * 1024 * 1024;

/** The most distinct images one published page may hold. */
export const MAX_ARTIFACT_PAGE_IMAGES = 64;

/** One image a page may show, as read from disk and identified by its bytes. */
export interface ArtifactImage {
  readonly extension: ArtifactImageExtension;
  readonly mediaType: ArtifactImageMediaType;
  readonly bytes: Buffer;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** A size in megabytes, to one decimal place, as it reads in a message. */
export function megabytes(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(1));
}

/**
 * The path a page's image source names on this machine: a `file:` address as the
 * path it stands for, anything else as written, trimmed. An address that does not
 * parse is kept as written, and then fails the absolute-path check.
 */
export function localPathOf(src: string): string {
  const trimmed = src.trim();
  if (!/^file:/i.test(trimmed)) {
    return trimmed;
  }
  try {
    return fileURLToPath(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Reads one local image a page refers to, or refuses it with the reason.
 *
 * The type is decided by the file's first bytes, never its name. The path is judged
 * as written before the disk is touched, so a refusal for a path outside the folders
 * is the same whether or not the file exists. It is judged again on the real path,
 * since a link inside a folder can lead out of it. The file is opened without
 * following a link and without blocking, so a FIFO cannot stall the daemon, and a
 * hard link is refused, because its contents can live outside the folders even when
 * its name does not.
 *
 * Node has no `openat`, so the open takes the real path rather than a directory handle
 * from the check. O_NOFOLLOW refuses a link at the final component only: a directory
 * component swapped for a link between the realpath and the open is not caught. That
 * takes a process running as the user, which can already read the same files, so the
 * window is accepted rather than closed.
 *
 * The folders are the allowed roots, each as written and in its canonical form.
 */
export function readArtifactImage(
  path: string,
  allowedRoots: readonly string[],
): ArtifactImage {
  const { fd, size } = openArtifactFile(path, allowedRoots, IMAGE_FILES);
  try {
    if (size > MAX_ARTIFACT_IMAGE_BYTES) {
      throw tooLarge(path, size);
    }
    const bytes = readFileSync(fd);
    const extension = sniffImageExtension(bytes);
    if (extension === null) {
      throw new BadRequestException(
        'IMAGE_TYPE_UNSUPPORTED',
        `${path} is not a png, jpeg, webp, gif or avif image`,
      );
    }
    return {
      extension,
      mediaType: ARTIFACT_IMAGE_MEDIA_TYPE[extension],
      bytes,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Which files a refusal is about: the prefix of its code and the words its message
 * names them by.
 */
export interface ArtifactFileKind {
  readonly code: 'IMAGE' | 'MEDIA';
  readonly noun: string;
  readonly plural: string;
}

const IMAGE_FILES: ArtifactFileKind = {
  code: 'IMAGE',
  noun: 'image',
  plural: 'images',
};

/** A local file a page names, open for reading; the caller closes `fd`. */
export interface OpenedArtifactFile {
  readonly fd: number;
  readonly size: number;
}

/**
 * Opens one local file a page refers to, or refuses it with the reason, by the rules
 * {@link readArtifactImage} describes: judged as written, then on its real path,
 * opened without following a link or blocking, a regular file with one link. The
 * caller owns the descriptor it gets back.
 */
export function openArtifactFile(
  path: string,
  allowedRoots: readonly string[],
  kind: ArtifactFileKind,
): OpenedArtifactFile {
  if (!isAbsolute(path)) {
    throw new BadRequestException(
      `${kind.code}_PATH_NOT_ABSOLUTE`,
      `${path} is not an absolute path, and an artifact cannot resolve a relative ${kind.noun} path`,
    );
  }
  const folders = allowedFolders(allowedRoots);
  if (!folders.some((folder) => isWithinDirectory(resolve(path), folder))) {
    throw outsideFolders(path, kind);
  }
  const real = resolveOrRefuse(path, kind, () => realpathSync(path));
  if (!folders.some((folder) => isWithinDirectory(real, folder))) {
    throw outsideFolders(path, kind);
  }
  const fd = resolveOrRefuse(path, kind, () =>
    openSync(
      real,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    ),
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new BadRequestException(
        `${kind.code}_NOT_A_FILE`,
        `${path} is not a file`,
      );
    }
    if (stat.nlink > 1) {
      throw new BadRequestException(
        `${kind.code}_SHARED_FILE`,
        `${path} is a hard link, so its contents may live outside the allowed folders`,
      );
    }
    return { fd, size: stat.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Each allowed root as written and in its canonical form, normalised. */
function allowedFolders(roots: readonly string[]): string[] {
  return roots.flatMap((root) => {
    const canonical = realOrNull(root);
    return canonical === null ? [resolve(root)] : [resolve(root), canonical];
  });
}

/**
 * Runs a file-system call, and turns its failure into the refusal the agent can act
 * on: a path that names no file is `<KIND>_NOT_FOUND`, and any other failure is
 * `<KIND>_UNREADABLE` with the system's code, so the cause is not reported as "no file".
 */
function resolveOrRefuse<T>(
  path: string,
  kind: ArtifactFileKind,
  call: () => T,
): T {
  try {
    return call();
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new NotFoundException(
        `${kind.code}_NOT_FOUND`,
        `no file at ${path}`,
      );
    }
    throw new BadRequestException(
      `${kind.code}_UNREADABLE`,
      `${path} cannot be read (${code})`,
    );
  }
}

function outsideFolders(
  path: string,
  kind: ArtifactFileKind,
): BadRequestException {
  return new BadRequestException(
    `${kind.code}_OUTSIDE_ALLOWED_FOLDERS`,
    `${path} is outside the folders an artifact may draw ${kind.plural} from`,
  );
}

function tooLarge(path: string, bytes: number): BadRequestException {
  return new BadRequestException(
    'IMAGE_TOO_LARGE',
    `${path} is ${megabytes(bytes)} MB, over the ${megabytes(MAX_ARTIFACT_IMAGE_BYTES)} MB per-image limit`,
  );
}

/** The real path a file resolves to, or null when there is none. */
function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * The format a file's leading bytes declare, or null for anything else. WebP and
 * AVIF are RIFF and ISO-BMFF containers, so their brand sits at a fixed offset
 * rather than at the start.
 */
export function sniffImageExtension(
  bytes: Buffer,
): ArtifactImageExtension | null {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  const head = bytes.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) {
    return 'gif';
  }
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') {
    return 'webp';
  }
  if (
    head.slice(4, 8) === 'ftyp' &&
    (head.slice(8, 12) === 'avif' || head.slice(8, 12) === 'avis')
  ) {
    return 'avif';
  }
  return null;
}
