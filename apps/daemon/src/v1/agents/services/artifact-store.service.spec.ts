import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_ARTIFACT_HTML_BYTES } from '../chat.types';
import {
  MAX_ARTIFACT_IMAGE_BYTES,
  MAX_ARTIFACT_PAGE_IMAGES,
} from '../utils/artifact-image-policy';
import {
  MAX_ARTIFACT_MEDIA_BYTES,
  MAX_ARTIFACT_PAGE_MEDIA,
  MAX_ARTIFACT_PAGE_MEDIA_BYTES,
} from '../utils/artifact-media-policy';
import {
  type ArtifactStoreOptions,
  ArtifactStoreService,
} from './artifact-store.service';

const RUN = '11111111-2222-4333-8444-555555555555';
const OTHER_RUN = '99999999-8888-4777-8666-555555555555';
const PAGE = '<!doctype html><title>Plan</title><p>step one';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** A PNG whose bytes depend on `tag`, so each tag is a different image. */
function pngNamed(tag: string): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(tag)]);
}

const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

describe('ArtifactStoreService', () => {
  let root: string;
  let store: ArtifactStoreService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'geniro-artifacts-'));
    store = new ArtifactStoreService({ root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const publish = (
    artifact: { id?: string; title?: string; html?: string },
    runId = RUN,
  ) =>
    store.publish(runId, {
      title: artifact.title ?? 'Plan',
      html: artifact.html ?? PAGE,
      ...(artifact.id === undefined ? {} : { id: artifact.id }),
    });

  /** Write an image file somewhere the page may draw from, and return its path. */
  const imageFile = (name: string, bytes: Buffer): string => {
    const dir = join(root, 'shots');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  };

  describe('publish', () => {
    it('stores the page and hands back the row the transcript needs', async () => {
      const result = await publish({ id: 'plan' });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.stored.artifactId).toBe('plan');
      expect(result.stored.version).toBe(1);
      expect(result.stored.key).toMatch(/^[0-9a-f]{64}$/);
      expect(store.read(RUN, 'plan', 1, result.stored.key)).toBe(PAGE);
    });

    it('mints an id when the agent named none, so nothing is overwritten', async () => {
      const first = await publish({});
      const second = await publish({});
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        return;
      }
      expect(first.stored.artifactId).not.toBe(second.stored.artifactId);
      expect(first.stored.version).toBe(1);
      expect(second.stored.version).toBe(1);
    });

    it('bumps the version and KEEPS the key when the same id is republished', async () => {
      const first = await publish({ id: 'plan' });
      const second = await publish({ id: 'plan', html: '<p>step two' });
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        return;
      }
      expect(second.stored.version).toBe(2);
      // A rotated key would silently break every card already in the
      // scrollback, each of which carries the key it was published with.
      expect(second.stored.key).toBe(first.stored.key);
    });

    it('keeps the OLD version readable, so an older card still opens what it announced', async () => {
      const first = await publish({ id: 'plan' });
      await publish({ id: 'plan', html: '<p>step two' });
      expect(first.ok).toBe(true);
      if (!first.ok) {
        return;
      }
      expect(store.read(RUN, 'plan', 1, first.stored.key)).toBe(PAGE);
      expect(store.read(RUN, 'plan', 2, first.stored.key)).toBe('<p>step two');
    });

    it('never prunes a version, however often the page is republished', async () => {
      // Every version stays readable, however many revisions follow it.
      let key = '';
      for (let i = 1; i <= 25; i += 1) {
        const result = await publish({ id: 'plan', html: `<p>v${i}` });
        expect(result.ok).toBe(true);
        if (result.ok) {
          key = result.stored.key;
        }
      }

      const kept = readdirSync(join(root, RUN, 'plan')).filter((n) =>
        n.endsWith('.html'),
      );
      expect(kept).toHaveLength(25);
      expect(store.read(RUN, 'plan', 1, key)).toBe('<p>v1');
      expect(store.read(RUN, 'plan', 25, key)).toBe('<p>v25');
    });

    it('keeps two runs’ artifacts of the same id apart', async () => {
      const mine = await publish({ id: 'plan', html: '<p>mine' });
      const theirs = await publish(
        { id: 'plan', html: '<p>theirs' },
        OTHER_RUN,
      );
      expect(mine.ok && theirs.ok).toBe(true);
      if (!mine.ok || !theirs.ok) {
        return;
      }
      expect(store.read(RUN, 'plan', 1, mine.stored.key)).toBe('<p>mine');
      expect(store.read(OTHER_RUN, 'plan', 1, theirs.stored.key)).toBe(
        '<p>theirs',
      );
    });

    it('refuses an oversize page, naming the limit so the retry can be smaller', async () => {
      const result = await publish({
        html: 'x'.repeat(MAX_ARTIFACT_HTML_BYTES + 1),
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain('512KB limit');
    });

    it('measures ENCODED bytes, not characters', async () => {
      // Three bytes per character: a page well under the character count is
      // still over the byte ceiling, which is what actually reaches the disk.
      const chars = Math.floor(MAX_ARTIFACT_HTML_BYTES / 2);
      const result = await publish({ html: '∎'.repeat(chars) });
      expect(chars).toBeLessThan(MAX_ARTIFACT_HTML_BYTES);
      expect(result.ok).toBe(false);
    });

    it('refuses a page whose run is removed while its pictures are read, and writes nothing', async () => {
      // The run row is read before the pictures are, and a teardown can remove the
      // run's folder in between. A page written after that would recreate it.
      const shot = imageFile('race.png', pngNamed('race'));
      const racing: ArtifactStoreService = new ArtifactStoreService({
        root,
        runs: {
          getById: async () => {
            racing.removeRun(RUN);
            return null;
          },
        } as unknown as ArtifactStoreOptions['runs'],
      });

      const result = await racing.publish(RUN, {
        title: 'Plan',
        html: `<img src="${shot}">`,
        id: 'plan',
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain('deleted');
      expect(existsSync(join(root, RUN, 'plan'))).toBe(false);
    });

    it('refuses a run id that is not one this app mints', async () => {
      expect((await publish({ id: 'plan' }, '../../etc')).ok).toBe(false);
    });

    it('stores the page under <root>/<runId>/<artifactId>/v1.html', async () => {
      await publish({ id: 'plan' });
      expect(existsSync(join(root, RUN, 'plan', 'v1.html'))).toBe(true);
    });

    it('writes nothing outside the artifacts root, whatever the id', async () => {
      // After each hostile id, the root holds the run's directory and nothing
      // else: no id may climb out of the root.
      for (const hostile of ['../escape', '../../etc', 'a/b', '..']) {
        await publish({ id: hostile });
      }
      expect(readdirSync(root)).toEqual([RUN]);
    });
  });

  describe('images', () => {
    it('copies a local image into the artifact and points the page at the copy', async () => {
      const bytes = pngNamed('after');
      const shot = imageFile('after.png', bytes);

      const result = await publish({
        id: 'plan',
        html: `<p>see</p><img src="${shot}">`,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const name = `${sha256(bytes)}.png`;
      const html = store.read(RUN, 'plan', 1, result.stored.key);
      expect(html).toBe(`<p>see</p><img src="images/${name}">`);
      expect(readFileSync(join(root, RUN, 'plan', 'images', name))).toEqual(
        bytes,
      );
    });

    it('names a copy by the hash of its bytes, so the same picture is stored once', async () => {
      const bytes = pngNamed('same');
      const first = imageFile('a.png', bytes);
      const second = imageFile('b.png', bytes);

      await publish({
        id: 'plan',
        html: `<img src="${first}"><img src="${second}">`,
      });

      expect(readdirSync(join(root, RUN, 'plan', 'images'))).toEqual([
        `${sha256(bytes)}.png`,
      ]);
    });

    it('leaves remote, data and protocol-relative sources exactly as written', async () => {
      const html =
        '<img src="https://example.com/a.png"><img src="data:image/png;base64,AAAA"><img src="//cdn.example.com/b.png">';

      const result = await publish({ id: 'plan', html });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(store.read(RUN, 'plan', 1, result.stored.key)).toBe(html);
      expect(existsSync(join(root, RUN, 'plan', 'images'))).toBe(false);
    });

    it('refuses a relative image path, naming why, so the agent can fix it', async () => {
      const result = await publish({
        id: 'plan',
        html: '<img src="shots/after.png">',
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain('not an absolute path');
    });

    it('refuses the whole page when one image is outside the allowed folders, and writes nothing', async () => {
      // /etc is outside both the temp folders and the run's folder, and it is
      // refused on where it sits before its contents are ever read.
      const result = await publish({
        id: 'plan',
        html: '<img src="/etc/hosts">',
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain('outside the folders');
      expect(existsSync(join(root, RUN, 'plan'))).toBe(false);
    });

    it('refuses a page whose image tag never closes, and writes nothing', async () => {
      // The picture sits in a tag that has no `>`, so a browser would not show it.
      // The page is refused rather than stored without the picture and no word of why.
      const picture = imageFile('open.png', pngNamed('open'));
      const result = await publish({
        id: 'plan',
        html: `<p>before</p><img src="${picture}"`,
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain('does not close');
      expect(existsSync(join(root, RUN, 'plan'))).toBe(false);
    });

    it('copies a picture named by an unquoted path with an apostrophe in it, as a browser reads it', async () => {
      const picture = imageFile("it's.png", pngNamed('apostrophe'));
      const result = await publish({
        id: 'plan',
        html: `<img src=${picture}>`,
      });
      expect(result.ok).toBe(true);
      expect(readFileSync(join(root, RUN, 'plan', 'v1.html'), 'utf8')).toBe(
        `<img src=images/${sha256(pngNamed('apostrophe'))}.png>`,
      );
    });

    it('refuses a page showing more images than the per-page limit, and does not truncate it', async () => {
      const sources: string[] = [];
      for (let i = 0; i <= MAX_ARTIFACT_PAGE_IMAGES; i += 1) {
        sources.push(`<img src="${imageFile(`${i}.png`, pngNamed(`n${i}`))}">`);
      }

      const result = await publish({ id: 'plan', html: sources.join('') });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain(
        `more than ${MAX_ARTIFACT_PAGE_IMAGES} images`,
      );
      expect(existsSync(join(root, RUN, 'plan'))).toBe(false);
    });

    it('refuses a page whose images total more than the per-page byte limit', async () => {
      // Seven images at the per-image ceiling is past the 64MB page limit, and
      // the seventh is the one refused: the page is refused, not cut to six.
      const sources: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        // Each one differs after the signature, so each is its own image.
        const bytes = Buffer.concat([
          PNG_SIGNATURE,
          Buffer.from([i]),
          Buffer.alloc(MAX_ARTIFACT_IMAGE_BYTES - PNG_SIGNATURE.length - 1),
        ]);
        sources.push(`<img src="${imageFile(`big-${i}.png`, bytes)}">`);
      }

      const result = await publish({ id: 'plan', html: sources.join('') });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain('64 MB');
    });

    it('rewrites every reference to one image to the same copy', async () => {
      const shot = imageFile('again.png', pngNamed('again'));
      const result = await publish({
        id: 'plan',
        html: `<img src="${shot}"><img src="${shot}">`,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const name = `${sha256(pngNamed('again'))}.png`;
      expect(store.read(RUN, 'plan', 1, result.stored.key)).toBe(
        `<img src="images/${name}"><img src="images/${name}">`,
      );
    });

    it('admits a picture under /tmp even where the temp directory is somewhere else', async () => {
      // An agent most often writes its screenshot to /tmp. On Linux the system temp
      // directory IS /tmp, so the literal admission is pinned by moving the temp
      // directory away from it here: a root lost from the list fails this test.
      const elsewhere = mkdtempSync(join(homedir(), 'geniro-artifact-tmpdir-'));
      vi.stubEnv('TMPDIR', elsewhere);
      const dir = mkdtempSync('/tmp/geniro-artifact-shot-');
      try {
        const shot = join(dir, 'shot.png');
        writeFileSync(shot, pngNamed('tmp'));

        const result = await publish({
          id: 'plan',
          html: `<img src="${shot}">`,
        });

        expect(result.ok).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('admits a picture in the run’s own folder, and not one in another run’s folder', async () => {
      // Neither folder is under /tmp or the system temp folder, so only the run's
      // own folder can admit the picture.
      const mine = mkdtempSync(join(homedir(), 'geniro-artifact-run-'));
      const theirs = mkdtempSync(join(homedir(), 'geniro-artifact-other-'));
      try {
        const shot = join(mine, 'shot.png');
        writeFileSync(shot, pngNamed('folder'));
        const folders: Record<string, string> = {
          [RUN]: mine,
          [OTHER_RUN]: theirs,
        };
        const withFolders = new ArtifactStoreService({
          root,
          runs: {
            getById: async (runId: string) => ({
              cwd: folders[runId] ?? null,
            }),
          } as unknown as ArtifactStoreOptions['runs'],
        });
        const html = `<img src="${shot}">`;

        const own = await withFolders.publish(RUN, {
          title: 'Plan',
          html,
          id: 'mine',
        });
        const foreign = await withFolders.publish(OTHER_RUN, {
          title: 'Plan',
          html,
          id: 'theirs',
        });

        expect(own.ok).toBe(true);
        expect(foreign.ok).toBe(false);
        if (foreign.ok) {
          return;
        }
        expect(foreign.reason).toContain('outside the folders');
      } finally {
        rmSync(mine, { recursive: true, force: true });
        rmSync(theirs, { recursive: true, force: true });
      }
    });

    it('counts every reference against the page byte limit, so one large picture cannot be shown past it', async () => {
      // One 10MB picture shown 39 times is about 390MB of served page. The byte cap
      // counts each showing, not each distinct file, so the page is refused first.
      const big = Buffer.concat([
        PNG_SIGNATURE,
        Buffer.alloc(MAX_ARTIFACT_IMAGE_BYTES - PNG_SIGNATURE.length),
      ]);
      const shot = imageFile('big-repeated.png', big);

      const result = await publish({
        id: 'plan',
        html: `<img src="${shot}">`.repeat(39),
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain('64 MB of pictures');
      expect(existsSync(join(root, RUN, 'plan'))).toBe(false);
    });

    it('stores one picture named under several spellings once, and shows it at each', async () => {
      const bytes = pngNamed('spellings');
      const shot = imageFile('spelled.png', bytes);
      const dir = join(root, 'shots');

      const result = await publish({
        id: 'plan',
        html: `<img src="${shot}"><img src="${dir}/./spelled.png"><img src="${dir}//spelled.png">`,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const name = `${sha256(bytes)}.png`;
      expect(readdirSync(join(root, RUN, 'plan', 'images'))).toEqual([name]);
      expect(store.read(RUN, 'plan', 1, result.stored.key)).toBe(
        `<img src="images/${name}"><img src="images/${name}"><img src="images/${name}">`,
      );
    });
  });

  describe('the checks a repeated picture still passes', () => {
    it('refuses a link from outside the folders even when its target was admitted earlier on the page', async () => {
      // The picture is read once per real file, so a memo keyed by that file would
      // admit the link after its target: the order of the references must not matter.
      const shot = imageFile('admitted.png', pngNamed('admitted'));
      const outsideDir = mkdtempSync(join(homedir(), 'geniro-artifact-link-'));
      const link = join(outsideDir, 'alias.png');
      try {
        symlinkSync(shot, link);

        const result = await publish({
          id: 'plan',
          html: `<img src="${shot}"><img src="${link}">`,
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        expect(result.reason).toContain('outside the folders');
        expect(existsSync(join(root, RUN, 'plan'))).toBe(false);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('refuses a page whose stored form is over the HTML limit, though the text the agent sent was under it', async () => {
      // Each reference is rewritten from the path the agent wrote to a stored name,
      // which is longer than a short path. The limit is on the stored page.
      const dir = mkdtempSync('/tmp/geniro-artifact-short-');
      try {
        const shot = join(dir, 'a.png');
        writeFileSync(shot, pngNamed('short'));
        const reference = `<img src="${shot}">`;
        const html = reference.repeat(
          Math.floor((MAX_ARTIFACT_HTML_BYTES - 1) / reference.length),
        );
        expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(
          MAX_ARTIFACT_HTML_BYTES,
        );

        const result = await publish({ id: 'plan', html });

        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        expect(result.reason).toContain(
          'once its pictures and media are referenced',
        );
        expect(existsSync(join(root, RUN, 'plan'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('media', () => {
    const MP3 = Buffer.concat([
      Buffer.from('ID3\u0004', 'latin1'),
      Buffer.from('a song'),
    ]);
    const MP4 = Buffer.concat([
      Buffer.from('\u0000\u0000\u0000\u0018ftypisom', 'latin1'),
      Buffer.from('a clip'),
    ]);

    const keyOf = (result: Awaited<ReturnType<typeof publish>>): string => {
      if (!result.ok) {
        throw new Error(`not published: ${result.reason}`);
      }
      return result.stored.key;
    };

    it('copies local audio and video into the artifact, named by their bytes, and points the page at the copies', async () => {
      const song = imageFile('song.dat', MP3);
      const clip = imageFile('clip.mov', MP4);
      const html = `<audio controls src="${song}"></audio><video><source src='${clip}'></video>`;

      const key = keyOf(await publish({ id: 'tour', html }));

      const songName = `${sha256(MP3)}.mp3`;
      const clipName = `${sha256(MP4)}.mp4`;
      expect(readFileSync(join(root, RUN, 'tour', 'v1.html'), 'utf8')).toBe(
        `<audio controls src="media/${songName}"></audio><video><source src='media/${clipName}'></video>`,
      );
      expect(
        readFileSync(join(root, RUN, 'tour', 'media', songName)).equals(MP3),
      ).toBe(true);
      expect(
        readFileSync(join(root, RUN, 'tour', 'v1.source.html'), 'utf8'),
      ).toBe(html);
      expect(
        JSON.parse(
          readFileSync(join(root, RUN, 'tour', 'v1.media.json'), 'utf8'),
        ),
      ).toEqual({ [song]: songName, [clip]: clipName });
      expect(readdirSync(join(root, RUN, 'tour', 'media')).sort()).toEqual(
        [clipName, songName].sort(),
      );
      expect(store.locateMedia(RUN, 'tour', key, clipName)).toEqual({
        path: join(root, RUN, 'tour', 'media', clipName),
        size: MP4.length,
        mediaType: 'video/mp4',
      });
    });

    it('refuses the whole page over one file that is not audio or video, and writes nothing', async () => {
      const song = imageFile('song.mp3', MP3);
      const fake = imageFile('fake.mp4', Buffer.from('not a movie'));

      const result = await publish({
        id: 'tour',
        html: `<audio src="${song}"></audio><video src="${fake}"></video>`,
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain('is not an mp3');
      expect(existsSync(join(root, RUN, 'tour'))).toBe(false);
    });

    it('refuses a media tag that does not close', async () => {
      const result = await publish({ html: '<p>x</p><video src="/tmp/a.mp4' });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain('<video>');
    });

    it('keeps the stored copy for an edit after the file it came from is gone', async () => {
      const song = imageFile('song.mp3', MP3);
      await publish({
        id: 'tour',
        html: `<audio src="${song}"></audio><p>one</p>`,
      });
      rmSync(song);

      const result = await store.publish(RUN, {
        id: 'tour',
        title: 'Plan',
        patch: {
          baseVersion: 1,
          edits: [{ oldString: 'one', newString: 'two', replaceAll: false }],
        },
      });

      expect(result.ok).toBe(true);
      expect(readFileSync(join(root, RUN, 'tour', 'v2.html'), 'utf8')).toBe(
        `<audio src="media/${sha256(MP3)}.mp3"></audio><p>two</p>`,
      );
    });

    type Copying = {
      copyMedia: (...args: unknown[]) => Promise<unknown>;
    };

    /** Runs `during` once, after the next publish copies its media and before its writes. */
    const whileCopying = (during: () => Promise<unknown> | void): void => {
      const copying = store as unknown as Copying;
      const copy = copying.copyMedia.bind(store);
      let pending = true;
      vi.spyOn(copying, 'copyMedia').mockImplementation(async (...args) => {
        const copied = await copy(...args);
        if (pending) {
          pending = false;
          await during();
        }
        return copied;
      });
    };

    it('refuses a page whose run is deleted while its media is copied, and leaves nothing of the run', async () => {
      const song = imageFile('song.mp3', MP3);
      whileCopying(() => store.removeRun(RUN));

      const result = await publish({
        id: 'tour',
        html: `<audio src="${song}">`,
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain('deleted');
      expect(existsSync(join(root, RUN))).toBe(false);
    });

    it('refuses edits whose page another publish replaced while their media was copied', async () => {
      const song = imageFile('song.mp3', MP3);
      await publish({
        id: 'tour',
        html: `<audio src="${song}"></audio><p>one</p>`,
      });
      whileCopying(() => publish({ id: 'tour', html: '<p>rewritten</p>' }));

      const result = await store.publish(RUN, {
        id: 'tour',
        title: 'Plan',
        patch: {
          baseVersion: 1,
          edits: [{ oldString: 'one', newString: 'two', replaceAll: false }],
        },
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain('version 2');
      expect(
        readdirSync(join(root, RUN, 'tour'))
          .filter((name) => /^v\d+\.html$/.test(name))
          .sort(),
      ).toEqual(['v1.html', 'v2.html']);
    });

    it('refuses a page that plays more distinct files than the per-page count', async () => {
      const tags = Array.from(
        { length: MAX_ARTIFACT_PAGE_MEDIA + 1 },
        (_, i) => {
          const file = imageFile(
            `s${i}.mp3`,
            Buffer.concat([MP3, Buffer.from(String(i))]),
          );
          return `<audio src="${file}"></audio>`;
        },
      );

      const result = await publish({ id: 'tour', html: tags.join('') });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain(
        `more than ${MAX_ARTIFACT_PAGE_MEDIA} audio or video files`,
      );
      expect(existsSync(join(root, RUN, 'tour'))).toBe(false);
    });

    it('refuses a page whose files together pass the per-page size, before copying any', async () => {
      const count =
        Math.floor(MAX_ARTIFACT_PAGE_MEDIA_BYTES / MAX_ARTIFACT_MEDIA_BYTES) +
        1;
      const tags = Array.from({ length: count }, (_, i) => {
        const file = imageFile(
          `big${i}.webm`,
          Buffer.from([0x1a, 0x45, 0xdf, 0xa3, i]),
        );
        truncateSync(file, MAX_ARTIFACT_MEDIA_BYTES);
        return `<video src="${file}"></video>`;
      });

      const result = await publish({ id: 'tour', html: tags.join('') });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain('of audio and video');
      expect(existsSync(join(root, RUN, 'tour'))).toBe(false);
    });

    it('refuses an edit whose kept copy is gone along with the file it came from', async () => {
      const song = imageFile('song.mp3', MP3);
      await publish({
        id: 'tour',
        html: `<audio src="${song}"></audio><p>one</p>`,
      });
      rmSync(song);
      rmSync(join(root, RUN, 'tour', 'media', `${sha256(MP3)}.mp3`));

      const result = await store.publish(RUN, {
        id: 'tour',
        title: 'Plan',
        patch: {
          baseVersion: 1,
          edits: [{ oldString: 'one', newString: 'two', replaceAll: false }],
        },
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain('no longer stored with this page');
    });

    it('answers no file for a wrong key, a name it does not write, or a file it does not hold', async () => {
      const song = imageFile('song.mp3', MP3);
      const key = keyOf(
        await publish({ id: 'tour', html: `<audio src="${song}">` }),
      );
      const name = `${sha256(MP3)}.mp3`;

      expect(store.locateMedia(RUN, 'tour', 'wrong', name)).toBeNull();
      expect(store.locateMedia(RUN, 'tour', key, '../meta.json')).toBeNull();
      expect(
        store.locateMedia(RUN, 'tour', key, `${'a'.repeat(64)}.mp3`),
      ).toBeNull();
      expect(store.locateMedia(RUN, 'tour', key, name)).not.toBeNull();
    });
  });

  describe('latest', () => {
    it('names the newest version and the key that reads it', async () => {
      await publish({ id: 'plan', html: '<p>one</p>' });
      const second = await publish({ id: 'plan', html: '<p>two</p>' });
      if (!second.ok) {
        throw new Error('publish failed');
      }

      const latest = store.latest(RUN, 'plan');

      expect(latest).toEqual({ version: 2, key: second.stored.key });
      expect(store.read(RUN, 'plan', 2, latest?.key ?? '')).toContain('two');
    });

    it('answers null for an artifact the run never published, or a hostile id', async () => {
      await publish({ id: 'plan' });
      expect(store.latest(RUN, 'other')).toBeNull();
      expect(store.latest(OTHER_RUN, 'plan')).toBeNull();
      expect(store.latest(RUN, '../plan')).toBeNull();
    });
  });

  describe('read', () => {
    it('refuses the wrong key', async () => {
      const result = await publish({ id: 'plan' });
      expect(result.ok).toBe(true);
      expect(store.read(RUN, 'plan', 1, 'f'.repeat(64))).toBeNull();
    });

    it('refuses an empty key, which is what an omitted query param arrives as', async () => {
      await publish({ id: 'plan' });
      expect(store.read(RUN, 'plan', 1, '')).toBeNull();
    });

    it('answers null rather than reading a file outside the root', async () => {
      const secret = join(root, 'secret.html');
      writeFileSync(secret, '<p>not an artifact', 'utf8');
      const result = await publish({ id: 'plan' });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      for (const hostile of ['../..', '../secret', '..', 'a/b']) {
        expect(store.read(RUN, hostile, 1, result.stored.key)).toBeNull();
      }
      // The decoy is still where it was — nothing walked out to it.
      expect(readFileSync(secret, 'utf8')).toBe('<p>not an artifact');
    });

    it('refuses a version that was never published', async () => {
      const result = await publish({ id: 'plan' });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(store.read(RUN, 'plan', 2, result.stored.key)).toBeNull();
      expect(store.read(RUN, 'plan', 0, result.stored.key)).toBeNull();
      expect(store.read(RUN, 'plan', -1, result.stored.key)).toBeNull();
      expect(store.read(RUN, 'plan', 1.5, result.stored.key)).toBeNull();
    });

    it('answers null for an artifact nobody published', () => {
      expect(store.read(RUN, 'nothing-here', 1, 'f'.repeat(64))).toBeNull();
    });

    it('answers null rather than throwing on an unreadable meta', async () => {
      const result = await publish({ id: 'plan' });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      writeFileSync(join(root, RUN, 'plan', 'meta.json'), 'not json', 'utf8');
      expect(() => store.read(RUN, 'plan', 1, result.stored.key)).not.toThrow();
      expect(store.read(RUN, 'plan', 1, result.stored.key)).toBeNull();
    });
  });

  describe('revisions and restarts', () => {
    it('keeps an earlier version’s image and shows the new one beside it', async () => {
      const a = pngNamed('first');
      const b = pngNamed('second');
      const shotA = imageFile('a.png', a);
      const shotB = imageFile('b.png', b);
      const first = await publish({
        id: 'plan',
        html: `<img src="${shotA}">`,
      });
      const second = await publish({
        id: 'plan',
        html: `<img src="${shotB}">`,
      });
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        return;
      }
      expect(store.read(RUN, 'plan', 1, first.stored.key)).toBe(
        `<img src="images/${sha256(a)}.png">`,
      );
      expect(store.read(RUN, 'plan', 2, first.stored.key)).toBe(
        `<img src="images/${sha256(b)}.png">`,
      );
      expect(readdirSync(join(root, RUN, 'plan', 'images')).sort()).toEqual(
        [`${sha256(a)}.png`, `${sha256(b)}.png`].sort(),
      );
    });

    it('does not rewrite a picture a revision keeps', async () => {
      // A rewrite replaces the file, which gives it a new inode, so the inode
      // says whether the copy was touched even when its bytes are unchanged.
      const kept = pngNamed('kept');
      const shot = imageFile('kept.png', kept);
      await publish({ id: 'plan', html: `<img src="${shot}">` });
      const imagePath = join(
        root,
        RUN,
        'plan',
        'images',
        `${sha256(kept)}.png`,
      );
      const inodeBefore = statSync(imagePath).ino;

      const revision = await publish({
        id: 'plan',
        html: `<p>again</p><img src="${shot}">`,
      });

      expect(revision.ok).toBe(true);
      expect(statSync(imagePath).ino).toBe(inodeBefore);
      expect(readdirSync(join(root, RUN, 'plan', 'images'))).toHaveLength(1);
    });

    it('serves a page and its picture after a restart, with nothing kept in memory', async () => {
      const bytes = pngNamed('restart');
      const shot = imageFile('restart.png', bytes);
      const result = await publish({
        id: 'plan',
        html: `<img src="${shot}">`,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      // A fresh store over the same folder is what a restarted daemon has.
      const restarted = new ArtifactStoreService({ root });
      expect(restarted.read(RUN, 'plan', 1, result.stored.key)).toBe(
        `<img src="images/${sha256(bytes)}.png">`,
      );
      expect(
        restarted.readImage(
          RUN,
          'plan',
          result.stored.key,
          `${sha256(bytes)}.png`,
        ),
      ).toEqual({ mediaType: 'image/png', bytes });
    });
  });

  describe('readImage', () => {
    it('returns the picture and its media type to the key of its artifact', async () => {
      const bytes = pngNamed('served');
      const shot = imageFile('served.png', bytes);
      const result = await publish({ id: 'plan', html: `<img src="${shot}">` });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(
        store.readImage(RUN, 'plan', result.stored.key, `${sha256(bytes)}.png`),
      ).toEqual({ mediaType: 'image/png', bytes });
    });

    it('refuses the wrong key, and the empty key an omitted query param arrives as', async () => {
      const bytes = pngNamed('guarded');
      const shot = imageFile('guarded.png', bytes);
      await publish({ id: 'plan', html: `<img src="${shot}">` });
      const file = `${sha256(bytes)}.png`;
      expect(store.readImage(RUN, 'plan', 'f'.repeat(64), file)).toBeNull();
      expect(store.readImage(RUN, 'plan', '', file)).toBeNull();
    });

    it('refuses any file name this store does not write, before a path is joined', async () => {
      const bytes = pngNamed('names');
      const shot = imageFile('names.png', bytes);
      const result = await publish({ id: 'plan', html: `<img src="${shot}">` });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const hash = sha256(bytes);
      // These names EXIST in the images folder, so only the name check can refuse
      // them: a missing file would refuse them whether or not the check ran.
      const images = join(root, RUN, 'plan', 'images');
      for (const name of [
        'meta.json',
        `${hash}.txt`,
        `${hash.toUpperCase()}.png`,
      ]) {
        writeFileSync(join(images, name), 'not a stored picture');
      }
      // `../v1.html` and `../meta.json` name files that EXIST in the artifact's
      // folder: a join without the name check would read them as pictures.
      for (const hostile of [
        '../v1.html',
        '../meta.json',
        'meta.json',
        `${hash}.txt`,
        `${hash.toUpperCase()}.png`,
        `${hash}.png/../../meta`,
      ]) {
        expect(
          store.readImage(RUN, 'plan', result.stored.key, hostile),
        ).toBeNull();
      }
    });

    it('answers null for a picture the artifact does not hold', async () => {
      const result = await publish({ id: 'plan' });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(
        store.readImage(
          RUN,
          'plan',
          result.stored.key,
          `${'a'.repeat(64)}.png`,
        ),
      ).toBeNull();
    });
  });

  describe('patch', () => {
    const edit = (
      oldString: string,
      newString: string,
      replaceAll = false,
    ) => ({ oldString, newString, replaceAll });

    const patch = (
      baseVersion: number,
      edits: ReturnType<typeof edit>[],
      on: ArtifactStoreService = store,
      id = 'plan',
    ) =>
      on.publish(RUN, {
        title: 'Plan',
        id,
        patch: { baseVersion, edits },
      });

    const files = () => readdirSync(join(root, RUN, 'plan')).sort();

    const keyOf = async (html: string) => {
      const first = await publish({ id: 'plan', html });
      if (!first.ok) {
        throw new Error(first.reason);
      }
      return first.stored.key;
    };

    it('publishes the edited latest version as the next one, under the same key', async () => {
      const key = await keyOf('<h1>Plan</h1><p>step one</p>');

      const result = await patch(1, [edit('step one', 'step two')]);

      expect(result).toEqual({
        ok: true,
        stored: { artifactId: 'plan', version: 2, key },
      });
      expect(store.read(RUN, 'plan', 2, key)).toBe(
        '<h1>Plan</h1><p>step two</p>',
      );
      expect(store.read(RUN, 'plan', 1, key)).toBe(
        '<h1>Plan</h1><p>step one</p>',
      );
      expect(files()).toEqual(['meta.json', 'v1.html', 'v2.html']);
    });

    it('applies the edits in order, each to the result of the ones before it', async () => {
      const key = await keyOf('<p>a</p>');

      await patch(1, [
        edit('<p>a</p>', '<p>b</p>'),
        edit('<p>b</p>', '<p>c</p>'),
      ]);

      expect(store.read(RUN, 'plan', 2, key)).toBe('<p>c</p>');
    });

    it('takes a replacement literally, never as a pattern', async () => {
      const key = await keyOf('<p>price</p>');

      await patch(1, [edit('price', '$& $1 $$')]);

      expect(store.read(RUN, 'plan', 2, key)).toBe('<p>$& $1 $$</p>');
    });

    it('replaces every occurrence only when replace_all is set', async () => {
      const key = await keyOf('<li>x</li><li>x</li>');

      const refused = await patch(1, [edit('x', 'y')]);
      expect(refused).toEqual({
        ok: false,
        reason: expect.stringMatching(/^edit 1: old_string occurs 2 times/),
      });
      expect(files()).toEqual(['meta.json', 'v1.html']);

      await patch(1, [edit('x', 'y', true)]);
      expect(store.read(RUN, 'plan', 2, key)).toBe('<li>y</li><li>y</li>');
    });

    it('refuses edits whose text is not on the page, naming the edit, and writes nothing', async () => {
      await keyOf('<p>a</p>');

      const result = await patch(1, [
        edit('<p>a</p>', '<p>b</p>'),
        edit('<p>a</p>', '<p>c</p>'),
      ]);

      expect(result).toEqual({
        ok: false,
        reason: expect.stringMatching(
          /^edit 2: old_string was not found in version 1 once the edits before it were applied/,
        ),
      });
      expect(files()).toEqual(['meta.json', 'v1.html']);
    });

    it('refuses edits written against an older version, naming the latest, and writes nothing', async () => {
      await keyOf('<p>a</p>');
      await publish({ id: 'plan', html: '<p>b</p>' });

      const result = await patch(1, [edit('<p>a</p>', '<p>c</p>')]);

      expect(result).toEqual({
        ok: false,
        reason: expect.stringContaining(
          'written against version 1, but the page is at version 2 now',
        ),
      });
      expect(files()).toEqual(['meta.json', 'v1.html', 'v2.html']);
    });

    it('refuses edits when a revision lands while the patched page is being prepared', async () => {
      let raced = true;
      const racing: ArtifactStoreService = new ArtifactStoreService({
        root,
        runs: {
          getById: async () => {
            if (!raced) {
              raced = true;
              await racing.publish(RUN, {
                title: 'Plan',
                id: 'plan',
                html: '<p>theirs</p>',
              });
            }
            return null;
          },
        } as unknown as ArtifactStoreOptions['runs'],
      });
      const first = await racing.publish(RUN, {
        title: 'Plan',
        id: 'plan',
        html: '<p>a</p>',
      });
      expect(first.ok).toBe(true);
      raced = false;

      const result = await patch(1, [edit('<p>a</p>', '<p>mine</p>')], racing);

      expect(result).toEqual({
        ok: false,
        reason: expect.stringContaining('the page is at version 2 now'),
      });
      expect(files()).toEqual(['meta.json', 'v1.html', 'v2.html']);
    });

    it('refuses edits to an artifact this run never published', async () => {
      const result = await patch(1, [edit('a', 'b')], store, 'nothing');
      expect(result).toEqual({
        ok: false,
        reason: expect.stringContaining('no artifact "nothing" to edit'),
      });
      expect(existsSync(join(root, RUN, 'nothing'))).toBe(false);
    });

    it('refuses a patched page over the HTML limit', async () => {
      await keyOf('<p>a</p>');

      const result = await patch(1, [
        edit('a', 'x'.repeat(MAX_ARTIFACT_HTML_BYTES)),
      ]);

      expect(result).toEqual({
        ok: false,
        reason: expect.stringContaining('over the 512KB limit'),
      });
      expect(files()).toEqual(['meta.json', 'v1.html']);
    });

    it('refuses a patched page whose image tag no longer closes', async () => {
      await keyOf('<p>a</p>');

      const result = await patch(1, [
        edit('<p>a</p>', '<img src="/tmp/x.png"'),
      ]);

      expect(result).toEqual({
        ok: false,
        reason: expect.stringContaining('does not close'),
      });
      expect(files()).toEqual(['meta.json', 'v1.html']);
    });

    it('refuses a replace_all that would grow the page past the limit before building it', async () => {
      await keyOf(`<p>${'a'.repeat(1000)}</p>`);

      const result = await patch(1, [edit('a', 'x'.repeat(1000), true)]);

      expect(result).toEqual({
        ok: false,
        reason: expect.stringMatching(
          /^edit 1: the page would be over the 512KB limit/,
        ),
      });
      expect(files()).toEqual(['meta.json', 'v1.html']);
    });

    it('refuses edits when the page vanishes while the patched page is being prepared', async () => {
      let vanish = false;
      const racing = new ArtifactStoreService({
        root,
        runs: {
          getById: async () => {
            if (vanish) {
              rmSync(join(root, RUN, 'plan'), { recursive: true, force: true });
            }
            return null;
          },
        } as unknown as ArtifactStoreOptions['runs'],
      });
      await racing.publish(RUN, {
        title: 'Plan',
        id: 'plan',
        html: '<p>a</p>',
      });
      vanish = true;

      const result = await patch(1, [edit('<p>a</p>', '<p>b</p>')], racing);

      expect(result).toEqual({
        ok: false,
        reason: expect.stringContaining('is gone'),
      });
      expect(existsSync(join(root, RUN, 'plan'))).toBe(false);
    });

    it('edits the page a version holds, not a source left behind by a publish that never landed', async () => {
      const key = await keyOf('<p>a</p>');
      writeFileSync(join(root, RUN, 'plan', 'v2.source.html'), '<p>stale</p>');
      writeFileSync(
        join(root, RUN, 'plan', 'v2.images.json'),
        JSON.stringify({ '/tmp/x.png': `${'a'.repeat(64)}.png` }),
      );
      await publish({ id: 'plan', html: '<p>b</p>' });

      const result = await patch(2, [edit('<p>b</p>', '<p>c</p>')]);

      expect(result.ok).toBe(true);
      expect(store.read(RUN, 'plan', 3, key)).toBe('<p>c</p>');
      expect(files()).toEqual(['meta.json', 'v1.html', 'v2.html', 'v3.html']);
    });

    it('matches edits against the picture path the agent wrote, not the stored copy’s name', async () => {
      const before = pngNamed('before');
      const after = pngNamed('after');
      const shotBefore = imageFile('before.png', before);
      const shotAfter = imageFile('after.png', after);
      const key = await keyOf(`<p>see</p><img src="${shotBefore}">`);

      const result = await patch(1, [
        edit(`<img src="${shotBefore}">`, `<img src="${shotAfter}">`),
      ]);

      expect(result.ok).toBe(true);
      expect(store.read(RUN, 'plan', 2, key)).toBe(
        `<p>see</p><img src="images/${sha256(after)}.png">`,
      );
    });

    it('keeps a picture whose file is gone, from the copy stored with the page', async () => {
      const bytes = pngNamed('gone');
      const shot = imageFile('gone.png', bytes);
      const key = await keyOf(`<p>see</p><img src="${shot}">`);
      rmSync(shot);

      const first = await patch(1, [edit('see', 'look')]);
      const second = await patch(2, [edit('look', 'watch')]);

      expect(first.ok && second.ok).toBe(true);
      const name = `${sha256(bytes)}.png`;
      expect(store.read(RUN, 'plan', 3, key)).toBe(
        `<p>watch</p><img src="images/${name}">`,
      );
      expect(store.readImage(RUN, 'plan', key, name)?.bytes).toEqual(bytes);
    });

    it('reads a picture whose file is still there again, so a re-shot screenshot shows', async () => {
      const shot = imageFile('shot.png', pngNamed('old'));
      const key = await keyOf(`<p>see</p><img src="${shot}">`);
      const fresh = pngNamed('new');
      writeFileSync(shot, fresh);

      await patch(1, [edit('see', 'look')]);

      expect(store.read(RUN, 'plan', 2, key)).toBe(
        `<p>look</p><img src="images/${sha256(fresh)}.png">`,
      );
    });

    it('refuses a gone picture a patch names that the page never stored', async () => {
      const key = await keyOf('<p>see</p>');
      const missing = join(root, 'shots', 'never.png');

      const result = await patch(1, [
        edit('<p>see</p>', `<p>see</p><img src="${missing}">`),
      ]);

      expect(result).toEqual({
        ok: false,
        reason: expect.stringContaining(`no file at ${missing}`),
      });
      expect(store.read(RUN, 'plan', 1, key)).toBe('<p>see</p>');
      expect(files()).toEqual(['meta.json', 'v1.html']);
    });

    it('patches a page stored before sources were kept against its served text, keeping its pictures', async () => {
      const bytes = pngNamed('legacy');
      const shot = imageFile('legacy.png', bytes);
      const key = await keyOf(`<p>see</p><img src="${shot}">`);
      rmSync(join(root, RUN, 'plan', 'v1.source.html'));
      rmSync(join(root, RUN, 'plan', 'v1.images.json'));
      rmSync(shot);
      const name = `${sha256(bytes)}.png`;

      const result = await patch(1, [edit('see', 'look')]);

      expect(result.ok).toBe(true);
      expect(store.read(RUN, 'plan', 2, key)).toBe(
        `<p>look</p><img src="images/${name}">`,
      );
    });

    it('still refuses a stored picture name in a whole page sent with html', async () => {
      const bytes = pngNamed('kept');
      const shot = imageFile('kept.png', bytes);
      await keyOf(`<img src="${shot}">`);

      const result = await publish({
        id: 'plan',
        html: `<img src="images/${sha256(bytes)}.png">`,
      });

      expect(result).toEqual({
        ok: false,
        reason: expect.stringContaining('not an absolute path'),
      });
      expect(files()).toEqual([
        'images',
        'meta.json',
        'v1.html',
        'v1.images.json',
        'v1.source.html',
      ]);
    });

    it('refuses a kept picture whose stored copy is gone too, naming it', async () => {
      const bytes = pngNamed('lost');
      const shot = imageFile('lost.png', bytes);
      await keyOf(`<p>see</p><img src="${shot}">`);
      const name = `${sha256(bytes)}.png`;
      rmSync(shot);
      rmSync(join(root, RUN, 'plan', 'images', name));

      const result = await patch(1, [edit('see', 'look')]);

      expect(result).toEqual({
        ok: false,
        reason: expect.stringContaining(
          `images/${name} is no longer stored with this page`,
        ),
      });
    });

    it('ignores a picture map entry that is not a stored picture name', async () => {
      const bytes = pngNamed('tampered');
      const shot = imageFile('tampered.png', bytes);
      await keyOf(`<p>see</p><img src="${shot}">`);
      rmSync(shot);
      writeFileSync(
        join(root, RUN, 'plan', 'v1.images.json'),
        JSON.stringify({ [shot]: '../../meta.json' }),
      );

      const result = await patch(1, [edit('see', 'look')]);

      expect(result).toEqual({
        ok: false,
        reason: expect.stringContaining(`no file at ${shot}`),
      });
    });
  });

  describe('removeRun', () => {
    it('drops the run’s artifacts and leaves other runs alone', async () => {
      const mine = await publish({ id: 'plan' });
      const theirs = await publish({ id: 'plan' }, OTHER_RUN);
      expect(mine.ok && theirs.ok).toBe(true);
      if (!mine.ok || !theirs.ok) {
        return;
      }
      store.removeRun(RUN);
      expect(store.read(RUN, 'plan', 1, mine.stored.key)).toBeNull();
      expect(store.read(OTHER_RUN, 'plan', 1, theirs.stored.key)).toBe(PAGE);
    });

    it('is idempotent, and a no-op for a run that never published', () => {
      expect(() => store.removeRun(RUN)).not.toThrow();
      expect(() => store.removeRun(RUN)).not.toThrow();
    });

    it('refuses to recurse out of the root on a run id it did not mint', () => {
      const keep = join(root, 'keep.html');
      writeFileSync(keep, 'x', 'utf8');
      store.removeRun('../..');
      expect(existsSync(keep)).toBe(true);
    });
  });
});
