import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { mintToken } from '../../../auth/mint-token';
import { safeEqual } from '../../../auth/safe-equal';
import { environment } from '../../../environments';
import { atomicWriteSync } from '../../../utils/atomic-file';
import { registerSecret } from '../../diagnostics/utils/redact';
import {
  ARTIFACT_ID_PATTERN,
  type ArtifactPatch,
  type HostArtifact,
  MAX_ARTIFACT_HTML_BYTES,
  MAX_ARTIFACT_ID_LENGTH,
} from '../chat.types';
import type { RunDao } from '../dao/run.dao';
import { applyArtifactEdits } from '../utils/artifact-edits';
import {
  ARTIFACT_IMAGE_FILE,
  ARTIFACT_IMAGE_MEDIA_TYPE,
  ARTIFACT_IMAGES_DIR,
  type ArtifactImageMediaType,
  imageTagsAreWhole,
  isArtifactImageExtension,
  isLocalImageSource,
  mapImageSources,
} from '../utils/artifact-html-images';
import {
  localPathOf,
  MAX_ARTIFACT_PAGE_IMAGE_BYTES,
  MAX_ARTIFACT_PAGE_IMAGES,
  megabytes,
  readArtifactImage,
} from '../utils/artifact-image-policy';

/** Constructor options — test seams, not user config. */
export interface ArtifactStoreOptions {
  /** Artifacts root (test seam); default `<userData>/artifacts`. */
  root?: string;
  /**
   * Where a run's working folder is read from, for the images a page may draw
   * from it. Absent in a test that makes no image — and then the only folders an
   * image may come from are the system temp ones.
   */
  runs?: Pick<RunDao, 'getById'>;
}

/** What one published artifact is, once it is on disk. */
export interface StoredArtifact {
  artifactId: string;
  version: number;
  key: string;
}

/** A publish either landed, or was refused for a reason the agent can act on. */
export type ArtifactPublishResult =
  { ok: true; stored: StoredArtifact } | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The folders besides the run's own that an image may come from: `/tmp`, where an
 * agent most often writes a screenshot, and the system temp directory, which on
 * macOS (`$TMPDIR`) is a path of its own. `/tmp` is named literally rather than
 * taken from the system, because on a machine whose temp directory IS `/tmp` the
 * two would be one entry, and the literal admission would go untested. A function,
 * so the directory is read at each publish rather than once when the module loads.
 */
function systemImageRoots(): string[] {
  return ['/tmp', tmpdir()];
}

/** What `meta.json` holds beside an artifact's versions. */
interface ArtifactMeta {
  key: string;
  version: number;
}

/** One distinct image a page references, read and named by the hash of its bytes. */
interface PageImage {
  name: string;
  bytes: Buffer;
}

/** A page with its image references rewritten, and the images it needs stored. */
interface PreparedPage {
  html: string;
  images: PageImage[];
  pictures: Map<string, string>;
}

interface PatchBase {
  artifactId: string;
  dir: string;
  version: number;
  pictures: ReadonlyMap<string, string>;
}

/** `<userData>/` directory published pages live in, one folder per run. */
export const ARTIFACTS_DIR_NAME = 'artifacts';

/**
 * The HTML pages agents publish with `show_artifact`, stored as files under
 * `<userData>/artifacts/<runId>/<artifactId>/`.
 *
 * Files rather than SQLite rows for {@link AttachmentStoreService}'s reason and
 * one of its own. The storage split keeps blobs out of the database; and a page
 * is reached by the renderer as a FRAMED URL, so the bytes have to be something
 * an HTTP route can stream without the row that named it being loaded first.
 *
 * A version is never overwritten and never pruned: a transcript row names the
 * version it published, so an older row in the scrollback goes on opening the
 * page it actually announced instead of silently showing whatever the agent
 * wrote last. Every version lives until the run is deleted.
 *
 * Two shapes are validated before anything is joined into a path, and both are
 * shapes this service or its reader minted: a UUID run id, and an artifact id
 * matching {@link ARTIFACT_ID_PATTERN}. So a `..` segment arriving from a route
 * param or from a model's tool call cannot walk out of the artifacts root.
 */
@Injectable()
export class ArtifactStoreService {
  private readonly logger = new Logger(ArtifactStoreService.name);
  private readonly root: string;
  private readonly runs: Pick<RunDao, 'getById'> | undefined;
  /**
   * Runs this process has removed. A publish that was reading its images when the
   * run went away checks this before it writes, so it cannot recreate the run's
   * directory after the removal.
   */
  private readonly removedRuns = new Set<string>();

  constructor(options: ArtifactStoreOptions = {}) {
    this.root =
      options.root ?? join(environment.userDataDir, ARTIFACTS_DIR_NAME);
    this.runs = options.runs;
  }

  /**
   * Write one page and return what the transcript row should carry.
   *
   * The size is measured on the ENCODED bytes, which is the only honest limit:
   * a page of mostly non-ASCII text is up to three times its character count,
   * and the ceiling exists to bound what reaches the disk and the frame.
   *
   * An `<img>` source naming a file on this machine is copied into the artifact
   * and the page refers to the copy, so the page keeps working after the file
   * it was read from is gone. Every such image is checked BEFORE anything is
   * written: a refused image refuses the whole page, and nothing of a refused
   * page is left behind to be mistaken for a published one.
   *
   * Republishing under an existing id BUMPS the version and KEEPS the key, so
   * every row ever written for this artifact goes on resolving — a rotated key
   * would silently break the open cards above it in the same transcript.
   */
  async publish(
    runId: string,
    artifact: HostArtifact,
  ): Promise<ArtifactPublishResult> {
    if (!UUID.test(runId)) {
      return {
        ok: false,
        reason: 'the run is not one artifacts can be stored for',
      };
    }
    let source: string;
    let base: PatchBase | null = null;
    if ('patch' in artifact) {
      const resolved = this.resolvePatch(runId, artifact.id, artifact.patch);
      if (!resolved.ok) {
        return resolved;
      }
      base = resolved.base;
      source = resolved.source;
    } else {
      source = artifact.html;
    }
    const bytes = Buffer.byteLength(source, 'utf8');
    if (bytes > MAX_ARTIFACT_HTML_BYTES) {
      const limit = Math.floor(MAX_ARTIFACT_HTML_BYTES / 1024);
      return {
        ok: false,
        reason: `the page is ${Math.floor(bytes / 1024)}KB, over the ${limit}KB limit — publish a smaller one`,
      };
    }
    let page: PreparedPage;
    try {
      page = await this.preparePage(runId, source, base);
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        return { ok: false, reason: error.message };
      }
      throw error;
    }
    // The cap is on the page the frame and the download carry, and that is the
    // stored form: each reference has grown from the path the agent wrote to the
    // name the page now holds, so the limit is checked again on the rewritten text.
    const storedBytes = Buffer.byteLength(page.html, 'utf8');
    if (storedBytes > MAX_ARTIFACT_HTML_BYTES) {
      const limit = Math.floor(MAX_ARTIFACT_HTML_BYTES / 1024);
      return {
        ok: false,
        reason: `the page is ${Math.floor(storedBytes / 1024)}KB once its pictures are referenced, over the ${limit}KB limit — publish fewer pictures, or a smaller page`,
      };
    }
    // Nothing below awaits, so the run cannot be removed between this check and
    // the writes that follow it.
    if (this.removedRuns.has(runId)) {
      return {
        ok: false,
        reason: 'the run was deleted while its page was being published',
      };
    }
    const artifactId = base?.artifactId ?? this.resolveId(artifact.id);
    const dir = join(this.root, runId, artifactId);
    const previous = this.readMeta(dir);
    if (base !== null && previous?.version !== base.version) {
      return {
        ok: false,
        reason: staleBaseReason(base.version, previous?.version ?? null),
      };
    }
    mkdirSync(dir, { recursive: true });
    if (page.images.length > 0) {
      mkdirSync(join(dir, ARTIFACT_IMAGES_DIR), { recursive: true });
    }
    for (const image of page.images) {
      const file = join(dir, ARTIFACT_IMAGES_DIR, image.name);
      // Named by the hash of its bytes, so a file already there IS this image:
      // a revision that keeps a picture writes nothing for it.
      if (!existsSync(file)) {
        atomicWriteSync(file, image.bytes);
      }
    }
    const meta: ArtifactMeta = {
      key: previous?.key ?? mintToken(),
      version: (previous?.version ?? 0) + 1,
    };
    // Registered at the one place this credential comes into existence, which
    // is the rule `CallTokenRegistry.issue` follows for the same reason: the
    // key rides the item payload, and the debug sink writes a preview of every
    // payload into a log the user is invited to paste into a bug report. A
    // reused key is registered again — idempotent per (value, label) — because
    // the first read after a restart is the only chance this process gets.
    registerSecret(meta.key, 'artifact key');
    writeFileSync(join(dir, `v${meta.version}.html`), page.html, 'utf8');
    const sourcePath = join(dir, sourceFile(meta.version));
    const picturesPath = join(dir, picturesFile(meta.version));
    if (page.html !== source) {
      writeFileSync(sourcePath, source, 'utf8');
    } else {
      rmSync(sourcePath, { force: true });
    }
    if (page.pictures.size > 0) {
      writeFileSync(
        picturesPath,
        JSON.stringify(Object.fromEntries(page.pictures)),
        'utf8',
      );
    } else {
      rmSync(picturesPath, { force: true });
    }
    // The page lands BEFORE the meta that advertises it: a crash between the
    // two leaves an unreferenced file, where the reverse order would leave a
    // meta pointing at a version that does not exist.
    //
    // ATOMIC, unlike the page beside it: this file is read back to decide the
    // next version and the key, so a half-written one reads as absent, which
    // would mint a fresh key and restart at v1 — orphaning every transcript
    // row of that artifact, since each carries the old key.
    atomicWriteSync(join(dir, 'meta.json'), JSON.stringify(meta));
    return {
      ok: true,
      stored: { artifactId, version: meta.version, key: meta.key },
    };
  }

  /**
   * One stored page's HTML, or null when the request names nothing this store
   * holds or presents the wrong key.
   *
   * ONE null for every failure, deliberately: the caller is an HTTP route with
   * no session, so distinguishing "no such artifact" from "wrong key" would let
   * an unauthenticated prober enumerate which artifacts a run holds.
   */
  read(
    runId: string,
    artifactId: string,
    version: number,
    key: string,
  ): string | null {
    if (!Number.isInteger(version) || version < 1) {
      return null;
    }
    const dir = this.locate(runId, artifactId, key);
    if (dir === null) {
      return null;
    }
    try {
      return readFileSync(join(dir, `v${version}.html`), 'utf8');
    } catch (error) {
      this.logger.warn(
        `could not read version ${version} of artifact ${artifactId}: ${codeOf(error)}`,
      );
      return null;
    }
  }

  /**
   * The newest stored version of an artifact and its serving key, or null when
   * the run holds no such artifact.
   *
   * For an in-process caller that already has the right to the page — the
   * share path, acting on the user's press or a switch the user turned on. No
   * route may hand this out: the key is the only thing guarding the page.
   */
  latest(
    runId: string,
    artifactId: string,
  ): { version: number; key: string } | null {
    if (
      !UUID.test(runId) ||
      !ARTIFACT_ID_PATTERN.test(artifactId) ||
      artifactId.length > MAX_ARTIFACT_ID_LENGTH
    ) {
      return null;
    }
    const meta = this.readMeta(join(this.root, runId, artifactId));
    if (meta !== null) {
      registerSecret(meta.key, 'artifact key');
    }
    return meta;
  }

  /**
   * One image a stored page refers to, or null when the request names nothing
   * this store holds or presents the wrong key.
   *
   * The same single null as {@link read}, for the same reason: the key is the
   * only thing that authorizes a read. The file name must be one this store
   * writes — a hash and an extension — before anything is joined into a path,
   * so a read cannot be walked to any other file in the folder.
   */
  readImage(
    runId: string,
    artifactId: string,
    key: string,
    file: string,
  ): { mediaType: ArtifactImageMediaType; bytes: Buffer } | null {
    if (!ARTIFACT_IMAGE_FILE.test(file)) {
      return null;
    }
    const dir = this.locate(runId, artifactId, key);
    if (dir === null) {
      return null;
    }
    const extension = file.slice(file.lastIndexOf('.') + 1);
    if (!isArtifactImageExtension(extension)) {
      return null;
    }
    try {
      return {
        mediaType: ARTIFACT_IMAGE_MEDIA_TYPE[extension],
        bytes: readFileSync(join(dir, ARTIFACT_IMAGES_DIR, file)),
      };
    } catch (error) {
      this.logger.warn(
        `could not read picture ${file} of artifact ${artifactId}: ${codeOf(error)}`,
      );
      return null;
    }
  }

  /**
   * Delete every artifact of one run, and the run's directory with them.
   *
   * Lives here beside `publish` for {@link AttachmentStoreService.removeRun}'s
   * reason — this service is the only thing that knows the layout. Best-effort
   * and idempotent: a run that never published has no directory, and that is a
   * success rather than an error.
   */
  removeRun(runId: string): void {
    if (!UUID.test(runId)) {
      return;
    }
    this.removedRuns.add(runId);
    rmSync(join(this.root, runId), { recursive: true, force: true });
  }

  /**
   * The artifact's directory when the request names a well-formed artifact and
   * presents its key, else null. The one check both reads of a page share: the key
   * is the only authorization either of them has.
   */
  private locate(
    runId: string,
    artifactId: string,
    key: string,
  ): string | null {
    if (
      !UUID.test(runId) ||
      !ARTIFACT_ID_PATTERN.test(artifactId) ||
      artifactId.length > MAX_ARTIFACT_ID_LENGTH
    ) {
      return null;
    }
    const dir = join(this.root, runId, artifactId);
    const meta = this.readMeta(dir);
    if (meta === null || !safeEqual(meta.key, key)) {
      return null;
    }
    return dir;
  }

  /**
   * Read every local image a page references, rewrite the references to the
   * copies, and refuse the page if its tags do not close or its images break a cap.
   *
   * A tag that does not close is refused rather than skipped: a picture inside one
   * would otherwise go missing with nothing said. The caps REFUSE rather than
   * truncate: a page that shows the first forty of its fifty pictures is a wrong
   * page, which is worse than no page. The picture cap counts DISTINCT images; the
   * byte cap counts every reference, because the served page carries each one in
   * full. A spelling repeated on the page is read once; two spellings of one file
   * store one copy, since a copy is named by its bytes.
   */
  private async preparePage(
    runId: string,
    html: string,
    base: PatchBase | null,
  ): Promise<PreparedPage> {
    if (!imageTagsAreWhole(html)) {
      throw new BadRequestException(
        'ARTIFACT_IMAGE_TAG_UNCLOSED',
        'an <img> tag in this page does not close, so a picture in it cannot be read — close every tag, and write a > inside an attribute value as &gt;',
      );
    }
    const folder = await this.folderOf(runId);
    const roots =
      folder === null ? systemImageRoots() : [...systemImageRoots(), folder];
    const byPath = new Map<string, PageImage>();
    const images = new Map<string, PageImage>();
    const pictures = new Map<string, string>();
    let shown = 0;
    const rewritten = mapImageSources(html, (src) => {
      if (!isLocalImageSource(src)) {
        return src;
      }
      const stored = base === null ? null : storedImageName(src);
      const path = stored === null ? localPathOf(src) : src;
      let picture = byPath.get(path);
      if (picture === undefined) {
        const image =
          stored === null || base === null
            ? this.readPageImage(path, roots, base)
            : this.readKeptImage(base, stored);
        const { name } = image;
        picture = images.get(name);
        if (picture === undefined) {
          if (images.size >= MAX_ARTIFACT_PAGE_IMAGES) {
            throw new BadRequestException(
              'ARTIFACT_TOO_MANY_IMAGES',
              `this page shows more than ${MAX_ARTIFACT_PAGE_IMAGES} images — publish fewer, or split the page`,
            );
          }
          picture = { name, bytes: image.bytes };
          images.set(name, picture);
        }
        byPath.set(path, picture);
        if (stored === null) {
          pictures.set(path, picture.name);
        }
      }
      shown += picture.bytes.byteLength;
      if (shown > MAX_ARTIFACT_PAGE_IMAGE_BYTES) {
        throw new BadRequestException(
          'ARTIFACT_IMAGES_TOO_LARGE',
          `this page shows more than ${megabytes(MAX_ARTIFACT_PAGE_IMAGE_BYTES)} MB of pictures — a picture counts each time the page shows it, so make the screenshots smaller or show fewer`,
        );
      }
      return `${ARTIFACT_IMAGES_DIR}/${picture.name}`;
    });
    return { html: rewritten, images: [...images.values()], pictures };
  }

  /**
   * A local picture a page names, read from disk; for a patch, a file that is gone
   * falls back to the copy stored for that same path, so a text-only edit never
   * fails because a screenshot was cleaned up. A file still there is read again.
   */
  private readPageImage(
    path: string,
    roots: string[],
    base: PatchBase | null,
  ): PageImage {
    try {
      const image = readArtifactImage(path, roots);
      return {
        name: `${createHash('sha256').update(image.bytes).digest('hex')}.${image.extension}`,
        bytes: image.bytes,
      };
    } catch (error) {
      if (!(error instanceof NotFoundException) || base === null) {
        throw error;
      }
      const kept = base.pictures.get(path);
      if (kept === undefined) {
        throw error;
      }
      return this.readKeptImage(base, kept);
    }
  }

  private readKeptImage(base: PatchBase, name: string): PageImage {
    try {
      return {
        name,
        bytes: readFileSync(join(base.dir, ARTIFACT_IMAGES_DIR, name)),
      };
    } catch {
      throw new NotFoundException(
        'IMAGE_NOT_FOUND',
        `the picture ${ARTIFACT_IMAGES_DIR}/${name} is no longer stored with this page — name the picture by its path again`,
      );
    }
  }

  /**
   * The full source a patch produces: the edits applied, in order, to the text the
   * agent published as `baseVersion`, which must be the artifact's latest version.
   * A version stored before sources were kept is its served page.
   */
  private resolvePatch(
    runId: string,
    requested: string | undefined,
    patch: ArtifactPatch,
  ):
    | { ok: true; base: PatchBase; source: string }
    | { ok: false; reason: string } {
    if (
      requested === undefined ||
      requested.length > MAX_ARTIFACT_ID_LENGTH ||
      !ARTIFACT_ID_PATTERN.test(requested)
    ) {
      return {
        ok: false,
        reason: 'edits need the artifact_id of a page this run published',
      };
    }
    const dir = join(this.root, runId, requested);
    const meta = this.readMeta(dir);
    if (meta === null) {
      return {
        ok: false,
        reason: `this run has no artifact "${requested}" to edit — publish the whole page with html`,
      };
    }
    if (meta.version !== patch.baseVersion) {
      return {
        ok: false,
        reason: staleBaseReason(patch.baseVersion, meta.version),
      };
    }
    const text = this.readVersionSource(dir, meta.version);
    if (text === null) {
      return {
        ok: false,
        reason: `version ${meta.version} of this page could not be read — publish the whole page with html`,
      };
    }
    const edited = applyArtifactEdits(
      text,
      patch.edits,
      meta.version,
      MAX_ARTIFACT_HTML_BYTES,
    );
    if (!edited.ok) {
      return edited;
    }
    return {
      ok: true,
      base: {
        artifactId: requested,
        dir,
        version: meta.version,
        pictures: this.readPictures(dir, meta.version),
      },
      source: edited.text,
    };
  }

  private readVersionSource(dir: string, version: number): string | null {
    for (const file of [sourceFile(version), `v${version}.html`]) {
      try {
        return readFileSync(join(dir, file), 'utf8');
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') {
          this.logger.warn(
            `could not read ${file} of an artifact: ${codeOf(error)}`,
          );
          return null;
        }
      }
    }
    return null;
  }

  private readPictures(dir: string, version: number): Map<string, string> {
    const pictures = new Map<string, string>();
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        readFileSync(join(dir, picturesFile(version)), 'utf8'),
      );
    } catch {
      return pictures;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return pictures;
    }
    for (const [path, name] of Object.entries(parsed)) {
      if (typeof name === 'string' && ARTIFACT_IMAGE_FILE.test(name)) {
        pictures.set(path, name);
      }
    }
    return pictures;
  }

  /** The run's working folder, or null when the run has none (or no run source). */
  private async folderOf(runId: string): Promise<string | null> {
    if (this.runs === undefined) {
      return null;
    }
    const run = await this.runs.getById(runId);
    return run?.cwd ?? null;
  }

  /**
   * The id to store under: the agent's own when it named a usable one, else a
   * fresh one nothing can collide with.
   *
   * Re-checked here rather than trusted from the reader, because this is the
   * value that becomes a directory name and the check belongs where the join
   * happens. A minted id is a bare UUID, which already matches the pattern.
   */
  private resolveId(requested: string | undefined): string {
    if (
      requested !== undefined &&
      requested.length <= MAX_ARTIFACT_ID_LENGTH &&
      ARTIFACT_ID_PATTERN.test(requested)
    ) {
      return requested;
    }
    return randomUUID();
  }

  /** The stored meta, or null when there is none or it cannot be read. */
  private readMeta(dir: string): ArtifactMeta | null {
    let raw: string;
    try {
      raw = readFileSync(join(dir, 'meta.json'), 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      const { key, version } = parsed as Record<string, unknown>;
      if (typeof key !== 'string' || key.length === 0) {
        return null;
      }
      if (!Number.isInteger(version) || (version as number) < 1) {
        return null;
      }
      return { key, version: version as number };
    } catch {
      return null;
    }
  }
}

function sourceFile(version: number): string {
  return `v${version}.source.html`;
}

function picturesFile(version: number): string {
  return `v${version}.images.json`;
}

function storedImageName(src: string): string | null {
  const prefix = `${ARTIFACT_IMAGES_DIR}/`;
  const trimmed = src.trim();
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const name = trimmed.slice(prefix.length);
  return ARTIFACT_IMAGE_FILE.test(name) ? name : null;
}

function staleBaseReason(base: number, latest: number | null): string {
  return latest === null
    ? `the page these edits were written against is gone — publish the whole page with html`
    : `these edits were written against version ${base}, but the page is at version ${latest} now — publish the whole page with html, or send edits against version ${latest}`;
}

/** The system error code behind a failed read, for a log line. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'unknown error';
}
