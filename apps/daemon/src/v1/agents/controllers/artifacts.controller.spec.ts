import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { FastifyReply } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactPageService } from '../services/artifact-page.service';
import { ArtifactStoreService } from '../services/artifact-store.service';
import {
  ARTIFACT_PAGE_CSP,
  ARTIFACT_SERVED_PAGE_CSP,
} from '../utils/artifact-page';
import { ArtifactsController } from './artifacts.controller';

/** What the controller wrote, in the order it wrote it. */
interface Written {
  code: number | null;
  type: string | null;
  headers: Record<string, string>;
  removed: string[];
  body: string | null;
}

function setup(page: string | null): {
  controller: ArtifactsController;
  reply: FastifyReply;
  written: Written;
  pageFor: ReturnType<typeof vi.fn>;
  documentFor: ReturnType<typeof vi.fn>;
} {
  const written: Written = {
    code: null,
    type: null,
    headers: {},
    removed: [],
    body: null,
  };
  // Chainable, like the real `FastifyReply` — the controller composes its
  // response as one chain, so a double that does not return itself would fail
  // for a reason that has nothing to do with the behaviour under test.
  const reply = {
    code(value: number) {
      written.code = value;
      return this;
    },
    type(value: string) {
      written.type = value;
      return this;
    },
    header(name: string, value: string) {
      written.headers[name] = value;
      return this;
    },
    headers(values: Record<string, string>) {
      Object.assign(written.headers, values);
      return this;
    },
    // The RAW Node response, because that is where the express `helmet`
    // middleware sets the headers this route has to clear.
    raw: {
      removeHeader(name: string) {
        written.removed.push(name);
      },
    },
    send(value: string) {
      written.body = value;
      return this;
    },
  } as unknown as FastifyReply;
  const pageFor = vi.fn(() => page);
  // A DIFFERENT body, so a test can tell which reading the route took rather
  // than asserting on a spy call alone.
  const documentFor = vi.fn(() => (page === null ? null : RAW_BODY));
  const controller = new ArtifactsController({
    page: pageFor,
    document: documentFor,
  } as unknown as ArtifactPageService);
  return { controller, reply, written, pageFor, documentFor };
}

const KEY = 'k'.repeat(64);
/** What the store holds, as distinct from what the framed route wraps it in. */
const RAW_BODY = '<p>the agent&rsquo;s own document</p>';

describe('ArtifactsController', () => {
  it('serves the page with 200 and an HTML content type', () => {
    const { controller, reply, written } = setup('<p>the page</p>');

    controller.page('run-1', 'plan', KEY, '2', undefined, reply);

    expect(written.code).toBe(200);
    expect(written.body).toBe('<p>the page</p>');
    expect(written.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('carries the page’s OWN Content-Security-Policy', () => {
    // The whole of what makes agent-authored script safe to run: the framed
    // document does not inherit the embedder's policy, so this header is the
    // only thing giving it `default-src 'none'`. Deleting the `.header(...)`
    // call reddens here and nowhere else — nothing in this daemon boots the
    // HTTP app, so no other spec can observe a response header.
    const { controller, reply, written } = setup('<p>x</p>');

    controller.page('run-1', 'plan', KEY, '1', undefined, reply);

    expect(written.headers['content-security-policy']).toBe(
      ARTIFACT_SERVED_PAGE_CSP,
    );
  });

  it('serves the raw document for saving under the portable policy, with no media origin', () => {
    const { controller, reply, written } = setup('<p>x</p>');

    controller.page('run-1', 'plan', KEY, '1', '1', reply);

    expect(written.headers['content-security-policy']).toBe(ARTIFACT_PAGE_CSP);
  });

  it('refuses content sniffing on a document an agent wrote', () => {
    const { controller, reply, written } = setup('<p>x</p>');

    controller.page('run-1', 'plan', KEY, '1', undefined, reply);

    expect(written.headers['x-content-type-options']).toBe('nosniff');
  });

  it('clears the framing headers helmet sets for every other route', () => {
    // MEASURED against the running app: the route answered 200 with the right
    // body and the frame rendered BLANK, because helmet's global
    // `X-Frame-Options: SAMEORIGIN` and `Cross-Origin-Resource-Policy:
    // same-origin` refuse an embed from the renderer — which is a `file:`
    // document in a packaged build and a dev-server URL under `pnpm dev`, so
    // cross-origin to the daemon either way. Nothing else in the suite can see
    // this: the headers come from middleware, not from the controller.
    const { controller, reply, written } = setup('<p>x</p>');

    controller.page('run-1', 'plan', KEY, '1', undefined, reply);

    // Cleared on the RAW response: the express `helmet` middleware sets it
    // with `res.setHeader`, which Fastify's own `removeHeader` cannot reach —
    // measured on the wire before this was corrected.
    expect(written.removed).toContain('X-Frame-Options');
    expect(written.headers['cross-origin-resource-policy']).toBe(
      'cross-origin',
    );
  });

  it('sends no referrer, so the key in its URL never reaches a CDN', () => {
    // The page may load libraries from public CDNs, and its own URL carries
    // the per-artifact key. Set on the route itself rather than left to
    // helmet's default, which nothing in this file can observe.
    const { controller, reply, written } = setup('<p>x</p>');

    controller.page('run-1', 'plan', KEY, '1', undefined, reply);

    expect(written.headers['referrer-policy']).toBe('no-referrer');
  });

  it('does not let the page be cached', () => {
    const { controller, reply, written } = setup('<p>x</p>');

    controller.page('run-1', 'plan', KEY, '1', undefined, reply);

    expect(written.headers['cache-control']).toBe('no-store');
  });

  it('asks the service for the version the query names', () => {
    const { controller, reply, pageFor } = setup('<p>x</p>');

    controller.page('run-1', 'plan', KEY, '4', undefined, reply);

    expect(pageFor).toHaveBeenCalledWith('run-1', 'plan', 4, KEY);
  });

  it('reads an omitted version as the first one', () => {
    const { controller, reply, pageFor } = setup('<p>x</p>');

    controller.page('run-1', 'plan', KEY, undefined, undefined, reply);

    expect(pageFor).toHaveBeenCalledWith('run-1', 'plan', 1, KEY);
  });

  it('passes an omitted key through as empty rather than as undefined', () => {
    // The store takes the key as a required argument and compares it in
    // constant time; handing it `undefined` would be a different code path
    // than the one that refuses a wrong key.
    const { controller, reply, pageFor } = setup(null);

    controller.page('run-1', 'plan', undefined, '1', undefined, reply);

    expect(pageFor).toHaveBeenCalledWith('run-1', 'plan', 1, '');
  });

  describe('?raw=1 — the document the agent wrote', () => {
    it('serves the stored document instead of the framed page', () => {
      // What the SAVE path fetches. The wrapper is this app's own plumbing — a
      // postMessage handshake with an embedder — so a file the user sends to a
      // colleague must not carry it.
      const { controller, reply, written, pageFor, documentFor } =
        setup('<p>wrapped</p>');

      controller.page('run-1', 'plan', KEY, '2', '1', reply);

      expect(written.body).toBe(RAW_BODY);
      expect(documentFor).toHaveBeenCalledWith('run-1', 'plan', 2, KEY);
      expect(pageFor).not.toHaveBeenCalled();
    });

    it('is the framed page for every other value of raw', () => {
      // Read as the one literal rather than parsed as a boolean: this query is
      // unvalidated strings, and `raw=false` meaning true is exactly the trap
      // a loose truthiness check invites.
      for (const raw of ['0', 'false', 'true', 'yes', '']) {
        const { controller, reply, written, documentFor } =
          setup('<p>wrapped</p>');

        controller.page('run-1', 'plan', KEY, '1', raw, reply);

        expect(written.body).toBe('<p>wrapped</p>');
        expect(documentFor).not.toHaveBeenCalled();
      }
    });

    it('still refuses a wrong key, with the same one answer', () => {
      // It is not a weaker door: the key goes through the same store read, and
      // what it returns is strictly less than the framed route already serves.
      const raw = setup(null);
      raw.controller.page('run-1', 'plan', 'wrong', '1', '1', raw.reply);

      const framed = setup(null);
      framed.controller.page(
        'run-1',
        'plan',
        'wrong',
        '1',
        undefined,
        framed.reply,
      );

      expect(raw.written.code).toBe(404);
      expect(raw.written).toEqual(framed.written);
    });
  });

  describe('when the page cannot be served', () => {
    it('answers 404 with a plain-text body and no page bytes', () => {
      const { controller, reply, written } = setup(null);

      controller.page('run-1', 'plan', 'wrong', '1', undefined, reply);

      expect(written.code).toBe(404);
      expect(written.type).toBe('text/plain; charset=utf-8');
      expect(written.body).toBe('not found');
    });

    it('sends ONE identical answer whatever the reason', () => {
      // The non-enumeration property this route rests on: the caller is
      // unauthenticated, so a wrong key and an artifact that does not exist
      // must be indistinguishable. The store already answers one null for
      // both; this is the route not undoing that.
      const wrongKey = setup(null);
      wrongKey.controller.page(
        'run-1',
        'plan',
        'wrong',
        '1',
        undefined,
        wrongKey.reply,
      );

      const noSuchArtifact = setup(null);
      noSuchArtifact.controller.page(
        'run-1',
        'nothing-here',
        KEY,
        '1',
        undefined,
        noSuchArtifact.reply,
      );

      expect(wrongKey.written).toEqual(noSuchArtifact.written);
    });

    it('writes no CSP header on the refusal — there is no page to police', () => {
      const { controller, reply, written } = setup(null);

      controller.page('run-1', 'plan', 'wrong', '1', undefined, reply);

      expect(written.headers).toEqual({});
    });
  });
});

describe('ArtifactsController media', () => {
  const RUN = '11111111-2222-4333-8444-555555555555';
  const SONG = Buffer.concat([
    Buffer.from('ID3\u0004', 'latin1'),
    Buffer.from('0123456789abcdefghij'),
  ]);
  let root: string;
  let controller: ArtifactsController;
  let key: string;
  let file: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'geniro-artifact-media-route-'));
    const store = new ArtifactStoreService({ root: join(root, 'store') });
    controller = new ArtifactsController(new ArtifactPageService(store));
    const song = join(root, 'song.mp3');
    writeFileSync(song, SONG);
    const published = await store.publish(RUN, {
      id: 'tour',
      title: 'Tour',
      html: `<audio controls src="${song}"></audio>`,
    });
    if (!published.ok) {
      throw new Error(published.reason);
    }
    key = published.stored.key;
    file = `${createHash('sha256').update(SONG).digest('hex')}.mp3`;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A reply double that collects what is sent, reading a stream to its end. */
  function streamingReply(): {
    reply: FastifyReply;
    written: {
      code: number;
      headers: Record<string, string>;
      body: Promise<Buffer>;
    };
  } {
    let resolveBody: (body: Buffer) => void = () => undefined;
    const written = {
      code: 200,
      headers: {} as Record<string, string>,
      body: new Promise<Buffer>((resolve) => {
        resolveBody = resolve;
      }),
    };
    const reply = {
      code(value: number) {
        written.code = value;
        return this;
      },
      type(value: string) {
        written.headers['content-type'] = value;
        return this;
      },
      header(name: string, value: string) {
        written.headers[name] = value;
        return this;
      },
      headers(values: Record<string, string>) {
        Object.assign(written.headers, values);
        return this;
      },
      send(value: unknown) {
        if (value instanceof Readable) {
          const chunks: Buffer[] = [];
          value.on('data', (chunk: Buffer) => chunks.push(chunk));
          value.on('end', () => resolveBody(Buffer.concat(chunks)));
        } else {
          resolveBody(Buffer.from(typeof value === 'string' ? value : ''));
        }
        return this;
      },
    } as unknown as FastifyReply;
    return { reply, written };
  }

  it('points the served page at the media route under the page key', () => {
    const page = new ArtifactPageService(
      new ArtifactStoreService({ root: join(root, 'store') }),
    ).page(RUN, 'tour', 1, key);

    expect(page).toContain(
      `<audio controls src="/v1/artifacts/${RUN}/tour/media/${file}?key=${key}"></audio>`,
    );
  });

  it('streams the whole file with its type when no range is asked for', async () => {
    const { reply, written } = streamingReply();

    controller.media(RUN, 'tour', file, key, undefined, reply);

    expect(written.code).toBe(200);
    expect(written.headers['content-type']).toBe('audio/mpeg');
    expect(written.headers['content-length']).toBe(String(SONG.length));
    expect(written.headers['accept-ranges']).toBe('bytes');
    expect(written.headers['cross-origin-resource-policy']).toBe(
      'cross-origin',
    );
    expect((await written.body).equals(SONG)).toBe(true);
  });

  it('answers a range with 206 and exactly those bytes', async () => {
    const { reply, written } = streamingReply();

    controller.media(RUN, 'tour', file, key, 'bytes=4-9', reply);

    expect(written.code).toBe(206);
    expect(written.headers['content-range']).toBe(`bytes 4-9/${SONG.length}`);
    expect(written.headers['content-length']).toBe('6');
    expect((await written.body).equals(SONG.subarray(4, 10))).toBe(true);
  });

  it('answers a span past the end with 416', () => {
    const { reply, written } = streamingReply();

    controller.media(RUN, 'tour', file, key, `bytes=${SONG.length}-`, reply);

    expect(written.code).toBe(416);
    expect(written.headers['content-range']).toBe(`bytes */${SONG.length}`);
  });

  it('keeps the key out of the document a saved file or a share is made from', () => {
    const document = new ArtifactPageService(
      new ArtifactStoreService({ root: join(root, 'store') }),
    ).document(RUN, 'tour', 1, key);

    expect(document).toContain(`<audio controls src="media/${file}"></audio>`);
    expect(document).not.toContain(key);
  });

  it('answers 404 for a wrong key', async () => {
    const { reply, written } = streamingReply();

    controller.media(RUN, 'tour', file, 'wrong', 'bytes=0-', reply);

    expect(written.code).toBe(404);
    expect((await written.body).toString()).toBe('not found');
  });
});
