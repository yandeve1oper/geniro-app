import { Controller, Get, Headers, Param, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { ArtifactPageService } from '../services/artifact-page.service';
import {
  ARTIFACT_PAGE_CSP,
  ARTIFACT_RESPONSE_HEADERS,
  ARTIFACT_SERVED_PAGE_CSP,
} from '../utils/artifact-page';

/**
 * The page one published artifact IS — the URL the renderer frames — and the
 * audio and video that page plays, under the same key.
 *
 * Kept OUT of the OpenAPI document, like `McpController`: it answers with an
 * HTML document rather than a wire shape, so there is nothing for the generated
 * client to describe and no reason for the renderer to reach it except as an
 * `<iframe src>`. That is also why the generated client needs no regeneration
 * for this feature — the descriptor the renderer needs rides the transcript row
 * it already receives.
 *
 * **Why the key is a QUERY parameter and not a bearer header.** An `<iframe
 * src>` cannot set a request header; there is no API for it. So this one route
 * sits outside the global bearer gate (`PUBLIC_PREFIXES` in
 * `auth/token.guard.ts`) and authenticates on a per-artifact capability minted
 * by the store — 256 bits, handed to the renderer inside the transcript row it
 * already receives over the authenticated channel, and never written to argv or
 * a log. The check is not skippable by a mistake here: the only way to read a
 * page is {@link ArtifactStoreService.read}, which TAKES the key as an argument
 * and compares it in constant time, so there is no code path that reads a
 * document without presenting one.
 *
 * The launch token is deliberately NOT accepted as an alternative: it would
 * have to travel in the frame's URL to be usable, and the master credential of
 * the whole daemon does not belong in a URL handed to a page an agent wrote.
 */
@ApiExcludeController()
@Controller('v1/artifacts')
export class ArtifactsController {
  constructor(private readonly pages: ArtifactPageService) {}

  @Get(':runId/:artifactId')
  page(
    @Param('runId') runId: string,
    @Param('artifactId') artifactId: string,
    @Query('key') key: string | undefined,
    @Query('v') version: string | undefined,
    @Query('raw') raw: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    // `raw` asks for the agent's own document instead of the framed page — the
    // app saving it as a file to share. Read as PRESENCE rather than parsed as
    // a boolean: every other value here is a string the route coerces itself,
    // and `raw=false` meaning true is the kind of trap a zod-less query invites,
    // so only the one literal turns it on.
    const wantsRaw = raw === '1';
    const html = wantsRaw
      ? this.pages.document(
          runId,
          artifactId,
          Number(version ?? '1'),
          key ?? '',
        )
      : this.pages.page(runId, artifactId, Number(version ?? '1'), key ?? '');
    if (html === null) {
      // Plain text, and the same answer for every way this can fail — see
      // `ArtifactPageService.page`.
      void reply.code(404).type('text/plain; charset=utf-8').send('not found');
      return;
    }
    // Helmet sets these for every route, and both stop the app from framing
    // this page at all — the renderer is a `file:` document in a packaged
    // build and a dev-server URL under `pnpm dev`, so it is cross-origin to
    // the daemon either way. MEASURED against the running app before this
    // override: the route answered 200 with the right body and the frame
    // rendered blank.
    //
    // Neither is the protection being given up. `X-Frame-Options` is the
    // legacy of `frame-ancestors`, which this response deliberately does not
    // set (see ARTIFACT_PAGE_CSP for why naming an origin would break one of
    // the two builds); what keeps a page private is the per-artifact key,
    // since an address nobody can guess cannot be framed by anybody. And CORP
    // governs who may EMBED the bytes, which is exactly what this route is
    // for — the sandbox and the page's own CSP are what contain them.
    // On `reply.raw`, not `reply`. `@packages/http-server` installs the EXPRESS
    // `helmet` as Nest middleware (`serverApp.use(helmet(...))`), which calls
    // `res.setHeader` on the raw Node response — a header Fastify's own
    // `removeHeader` does not know about and cannot clear. Measured: clearing
    // it on the reply left `X-Frame-Options: SAMEORIGIN` on the wire and the
    // frame still blank.
    reply.raw.removeHeader('X-Frame-Options');
    void reply
      .code(200)
      .headers(ARTIFACT_RESPONSE_HEADERS)
      .header('content-type', 'text/html; charset=utf-8')
      // The page's OWN policy, which is what makes agent-authored script safe
      // to run: it does not inherit the embedder's. See ARTIFACT_PAGE_CSP; the
      // framed page adds its media route (ARTIFACT_SERVED_PAGE_CSP).
      .header(
        'content-security-policy',
        wantsRaw ? ARTIFACT_PAGE_CSP : ARTIFACT_SERVED_PAGE_CSP,
      )
      .send(html);
  }

  /**
   * One audio or video file a page plays, a range at a time — see
   * `ArtifactPageService.mediaResponse` for what is sent.
   */
  @Get(':runId/:artifactId/media/:file')
  media(
    @Param('runId') runId: string,
    @Param('artifactId') artifactId: string,
    @Param('file') file: string,
    @Query('key') key: string | undefined,
    @Headers('range') range: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    const { status, headers, body } = this.pages.mediaResponse(
      runId,
      artifactId,
      key ?? '',
      file,
      range,
    );
    void reply.code(status).headers(headers).send(body);
  }
}
