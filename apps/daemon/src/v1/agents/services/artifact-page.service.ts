import { createReadStream } from 'node:fs';

import { Injectable } from '@nestjs/common';

import type { ArtifactMediaResponse } from '../chat.types';
import {
  ARTIFACT_RESPONSE_HEADERS,
  renderArtifactDocument,
  renderArtifactPage,
  withInlineImages,
  withMediaRoute,
} from '../utils/artifact-page';
import { parseByteRange } from '../utils/byte-range';
import { ArtifactStoreService } from './artifact-store.service';

/**
 * One published artifact as the document that is actually served: the agent's
 * page with geniro's page runtime in front of it and its theme-and-height
 * wrapper appended.
 *
 * Its own service rather than two calls from the controller, on the module
 * rule that a controller makes ONE call into a service — and it earns the
 * seat, because "which page" and "what the page is wrapped in" are the two
 * halves of this route and neither belongs in a route handler.
 */
@Injectable()
export class ArtifactPageService {
  constructor(private readonly store: ArtifactStoreService) {}

  /**
   * The document to serve, or null when the request names nothing this daemon
   * holds or presents the wrong key — ONE null for every failure, inherited
   * from {@link ArtifactStoreService.read}, which says why.
   */
  page(
    runId: string,
    artifactId: string,
    version: number,
    key: string,
  ): string | null {
    const html = this.store.read(runId, artifactId, version, key);
    return html === null
      ? null
      : renderArtifactPage(
          withMediaRoute(
            this.inline(runId, artifactId, key, html),
            runId,
            artifactId,
            key,
          ),
        );
  }

  /**
   * What the media route answers for one audio or video file a page plays.
   *
   * Under the page's own key, with the page's single 404 for every failure. A
   * media element asks for a byte range to start playing and another for every
   * seek, so a range is answered `206` and a span past the end `416`; no range
   * gets the whole file, all under {@link ARTIFACT_RESPONSE_HEADERS}.
   */
  mediaResponse(
    runId: string,
    artifactId: string,
    key: string,
    file: string,
    range: string | undefined,
  ): ArtifactMediaResponse {
    const found = this.store.locateMedia(runId, artifactId, key, file);
    if (found === null) {
      return {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'not found',
      };
    }
    const headers: Record<string, string> = {
      ...ARTIFACT_RESPONSE_HEADERS,
      'accept-ranges': 'bytes',
    };
    const span = parseByteRange(range, found.size);
    if (span === 'unsatisfiable') {
      return {
        status: 416,
        headers: { ...headers, 'content-range': `bytes */${found.size}` },
        body: '',
      };
    }
    const { start, end } = span ?? { start: 0, end: found.size - 1 };
    return {
      status: span === null ? 200 : 206,
      headers: {
        ...headers,
        ...(span === null
          ? {}
          : { 'content-range': `bytes ${start}-${end}/${found.size}` }),
        'content-type': found.mediaType,
        'content-length': String(Math.max(0, end - start + 1)),
      },
      body:
        found.size === 0 ? '' : createReadStream(found.path, { start, end }),
    };
  }

  /**
   * The page with its stored pictures written into it. Each picture is read
   * under the same key the page was, so the pictures are no more reachable than
   * the page is.
   */
  private inline(
    runId: string,
    artifactId: string,
    key: string,
    html: string,
  ): string {
    return withInlineImages(html, (file) =>
      this.store.readImage(runId, artifactId, key, file),
    );
  }

  /**
   * The agent's stored document without the frame wrapper — what the
   * app saves when the user asks for the page as a file to share.
   *
   * A second reading rather than a flag on {@link page}, because the two answer
   * different questions: that one is "what does this app frame", this one is
   * "what did the agent actually author". The wrapper is geniro's own plumbing
   * — a `postMessage` handshake with an embedder — so a file carrying it would
   * ship this app's internals to whoever the page is sent to, and would sit
   * there listening for a parent that is never going to speak. The page
   * RUNTIME does ride along: the agent's own script calls `geniro.chart`, and
   * a saved page without it would throw on its first line.
   *
   * It is NOT a weaker door. The key is checked by the same
   * {@link ArtifactStoreService.read}, and what comes back is strictly LESS
   * than the framed route already serves.
   */
  document(
    runId: string,
    artifactId: string,
    version: number,
    key: string,
  ): string | null {
    const html = this.store.read(runId, artifactId, version, key);
    return html === null
      ? null
      : renderArtifactDocument(this.inline(runId, artifactId, key, html));
  }
}
