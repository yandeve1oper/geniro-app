import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { BadRequestException, NotFoundException } from '@packages/common';

import {
  ARTIFACT_MEDIA_DIR,
  ARTIFACT_MEDIA_FILE,
  type ArtifactMediaExtension,
  isLocalSource,
  mapMediaSources,
  mediaTagsAreWhole,
} from './artifact-html-images';
import { localPathOf, megabytes } from './artifact-image-policy';
import {
  MAX_ARTIFACT_PAGE_MEDIA,
  MAX_ARTIFACT_PAGE_MEDIA_BYTES,
  openArtifactMedia,
  type OpenedArtifactMedia,
} from './artifact-media-policy';
import { fsErrorCode } from './fs-error-code';

/** What a revision may keep from the version it edits: its folder and its path → stored name map. */
export interface MediaBase {
  dir: string;
  media: ReadonlyMap<string, string>;
}

/** One audio or video source of a page: a local file opened for copying, or a copy the artifact already holds. */
type PageMediaSource =
  { kind: 'open'; media: OpenedArtifactMedia } | { kind: 'kept'; name: string };

/**
 * The local audio and video a page plays, judged and opened, not yet copied.
 *
 * Opened before anything is written, so a refused file refuses the page with nothing
 * left behind; every descriptor it holds is closed by {@link copyPageMedia} or
 * {@link PageMedia.close}, whichever comes first.
 */
export interface PageMedia {
  readonly sources: ReadonlyMap<string, PageMediaSource>;
  close(): void;
}

/**
 * Opens every local audio and video file a page names, or refuses the page.
 *
 * A revision keeps a source that names one of its version's stored copies
 * (`media/<name>`), and falls back to the copy stored for a path whose file is
 * gone, as pictures do. The caps refuse rather than truncate.
 */
export function openPageMedia(
  html: string,
  roots: string[],
  base: MediaBase | null,
): PageMedia {
  if (!mediaTagsAreWhole(html)) {
    throw new BadRequestException(
      'ARTIFACT_MEDIA_TAG_UNCLOSED',
      'an <audio>, <video> or <source> tag in this page does not close — close every tag, and write a > inside an attribute value as &gt;',
    );
  }
  const sources = new Map<string, PageMediaSource>();
  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const source of sources.values()) {
      if (source.kind === 'open') {
        closeSync(source.media.fd);
      }
    }
  };
  let bytes = 0;
  try {
    mapMediaSources(html, (src) => {
      if (!isLocalSource(src)) {
        return src;
      }
      const stored = base === null ? null : storedMediaName(src);
      const path = localPathOf(src);
      if (sources.has(path)) {
        return src;
      }
      if (sources.size >= MAX_ARTIFACT_PAGE_MEDIA) {
        throw new BadRequestException(
          'ARTIFACT_TOO_MANY_MEDIA',
          `this page plays more than ${MAX_ARTIFACT_PAGE_MEDIA} audio or video files — publish fewer, or split the page`,
        );
      }
      const source =
        stored !== null && base !== null
          ? keptSource(base, stored)
          : openSource(path, roots, base);
      sources.set(path, source);
      if (source.kind === 'open') {
        bytes += source.media.size;
        if (bytes > MAX_ARTIFACT_PAGE_MEDIA_BYTES) {
          throw new BadRequestException(
            'ARTIFACT_MEDIA_TOO_LARGE',
            `this page plays more than ${megabytes(MAX_ARTIFACT_PAGE_MEDIA_BYTES)} MB of audio and video — make the files smaller or play fewer`,
          );
        }
      }
      return src;
    });
  } catch (error) {
    close();
    throw error;
  }
  return { sources, close };
}

function openSource(
  path: string,
  roots: string[],
  base: MediaBase | null,
): PageMediaSource {
  try {
    return { kind: 'open', media: openArtifactMedia(path, roots) };
  } catch (error) {
    const kept = base?.media.get(path);
    if (
      !(error instanceof NotFoundException) ||
      base === null ||
      kept === undefined
    ) {
      throw error;
    }
    return keptSource(base, kept);
  }
}

function keptSource(base: MediaBase, name: string): PageMediaSource {
  if (!existsSync(join(base.dir, ARTIFACT_MEDIA_DIR, name))) {
    throw new NotFoundException(
      'MEDIA_NOT_FOUND',
      `the file ${ARTIFACT_MEDIA_DIR}/${name} is no longer stored with this page — name it by its path again`,
    );
  }
  return { kind: 'kept', name };
}

/** The stored copy a `media/<name>` source names, or null when it names none. */
function storedMediaName(src: string): string | null {
  const prefix = `${ARTIFACT_MEDIA_DIR}/`;
  const trimmed = src.trim();
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const name = trimmed.slice(prefix.length);
  return ARTIFACT_MEDIA_FILE.test(name) ? name : null;
}

/** A stored name of the length {@link copyPageMedia} will give the file, before its hash is known. */
function placeholderName(extension: ArtifactMediaExtension): string {
  return `${'0'.repeat(64)}.${extension}`;
}

/**
 * The page as it will be stored, with each local source written as its stored copy.
 * Before the copies exist, `names` is absent and every copy is given a name of the
 * length it will have, which is all a size check needs.
 */
export function withStoredMedia(
  html: string,
  media: PageMedia,
  names?: ReadonlyMap<string, string>,
): string {
  return mapMediaSources(html, (src) => {
    if (!isLocalSource(src)) {
      return src;
    }
    const path = localPathOf(src);
    const source = media.sources.get(path);
    if (source === undefined) {
      return src;
    }
    if (source.kind === 'kept') {
      return `${ARTIFACT_MEDIA_DIR}/${source.name}`;
    }
    const name = names?.get(path) ?? placeholderName(source.media.extension);
    return `${ARTIFACT_MEDIA_DIR}/${name}`;
  });
}

/**
 * Streams each opened file into `<dir>/media/`, named by the hash of its bytes, and
 * answers each path's stored name — the copies the page keeps included. Every
 * descriptor is closed when it returns, whether it copied or failed.
 *
 * Each copy is written beside its final name and renamed into place, so a half-copied
 * file never stands under a name the page refers to, and it stops at the size that
 * was judged, so a file still growing cannot pass the caps.
 */
export async function copyPageMedia(
  media: PageMedia,
  dir: string,
): Promise<Map<string, string>> {
  const folder = join(dir, ARTIFACT_MEDIA_DIR);
  const names = new Map<string, string>();
  const pending = [...media.sources.entries()];
  try {
    for (const [path, source] of pending) {
      if (source.kind === 'kept') {
        names.set(path, source.name);
        continue;
      }
      names.set(path, await copyOne(source.media, folder));
    }
  } finally {
    media.close();
  }
  return names;
}

async function copyOne(
  media: OpenedArtifactMedia,
  folder: string,
): Promise<string> {
  const part = join(folder, `.${randomUUID()}.part`);
  const hash = createHash('sha256');
  try {
    await pipeline(
      media.size === 0
        ? Readable.from([])
        : createReadStream('', {
            fd: media.fd,
            start: 0,
            end: media.size - 1,
            autoClose: false,
          }),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(part, { flags: 'wx' }),
    );
  } catch (error) {
    rmSync(part, { force: true });
    throw new BadRequestException(
      'MEDIA_UNREADABLE',
      `an audio or video file could not be copied into the page (${fsErrorCode(error)})`,
    );
  }
  const name = `${hash.digest('hex')}.${media.extension}`;
  renameSync(part, join(folder, name));
  return name;
}

/**
 * A version's stored path → name map (`v<N>.images.json`, `v<N>.media.json`), keeping
 * only the names `names` admits: those the store itself writes.
 */
export function readStoredNames(
  raw: string | null,
  names: RegExp,
): Map<string, string> {
  const read = new Map<string, string>();
  if (raw === null) {
    return read;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return read;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return read;
  }
  for (const [path, name] of Object.entries(parsed)) {
    if (typeof name === 'string' && names.test(name)) {
      read.set(path, name);
    }
  }
  return read;
}
