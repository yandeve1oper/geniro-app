/**
 * One artifact page's audio or video file: `/v1/artifacts/<run>/<page>/media/<sha256>.<ext>`.
 *
 * TWIN PARSER: the daemon's run id (a UUID), `ARTIFACT_ID_PATTERN` and
 * `MAX_ARTIFACT_ID_LENGTH` (`apps/daemon/src/v1/agents/chat.types.ts`) and
 * `ARTIFACT_MEDIA_FILE` (`apps/daemon/src/v1/agents/utils/artifact-html-images.ts`),
 * the names the daemon's media route answers to. A shape added there that is
 * missing here is refused on a paired device's page.
 */
const ARTIFACT_MEDIA_PATH =
  /^\/v1\/artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-z0-9][a-z0-9-]{0,63}\/media\/[0-9a-f]{64}\.(?:mp3|aac|m4a|mp4|mov|wav|ogg|flac|webm)$/;

/** The per-artifact key the daemon mints: 256 bits, as hex. */
const ARTIFACT_KEY = /^[0-9a-f]{64}$/;

/**
 * Whether a request is a page's own audio or video, which the gateway lets
 * through without the paired cookie (user decision).
 *
 * The page plays it from a sandboxed frame in an opaque origin, so the browser
 * sends no `SameSite` cookie with it — measured in Chromium: the frame's own
 * load carries the paired cookie, its media request none. What gates it instead
 * is the page's 256-bit key, which the daemon checks as it does on the Mac; only a
 * read of exactly that shape passes, and it reaches the daemon without the launch
 * token.
 */
export function isArtifactMediaRequest(
  method: string | undefined,
  url: URL,
): boolean {
  if (method !== 'GET' && method !== 'HEAD') {
    return false;
  }
  const names = [...url.searchParams.keys()];
  return (
    ARTIFACT_MEDIA_PATH.test(url.pathname) &&
    names.length === 1 &&
    names[0] === 'key' &&
    ARTIFACT_KEY.test(url.searchParams.get('key') ?? '')
  );
}
