import {
  ARTIFACT_IMAGE_FILE,
  ARTIFACT_IMAGES_DIR,
  type ArtifactImageMediaType,
  mapImageSources,
} from './artifact-html-images';
import {
  ARTIFACT_THEME_EVENT,
  themeVar,
  withArtifactRuntime,
} from './artifact-runtime';

/**
 * The Content-Security-Policy the artifact page carries as its OWN response
 * header — the thing that makes agent-authored script safe to run at all.
 *
 * This is NOT the renderer's policy and does not inherit from it. A framed
 * document's policy comes from its own response headers, which is precisely why
 * the page is served over loopback rather than put in an `<iframe srcdoc>`: a
 * srcdoc document INHERITS the embedder's policy, and the app's is
 * `default-src 'self'` with no `script-src`, so the agent's script would simply
 * never run.
 *
 * `default-src 'none'` is the base: no fetch, no XHR, no WebSocket, no remote
 * image, no beacon, no frame. The two `'unsafe-inline'` grants are what the
 * feature IS — an agent writes one file, so its style and script are inline by
 * construction.
 *
 * The one way OUT is a fixed list of public library CDNs — scripts,
 * stylesheets and fonts only — plus Google Fonts. That is what lets a page draw
 * with ECharts, Mermaid or Tailwind instead of hand-rolled SVG, and it is the
 * list Claude Code's own artifacts allow, so an agent's habits carry over. The
 * price is that such a page does not work offline, which is the user's call.
 * It opens no channel to talk BACK: script still cannot `fetch`, and a library
 * from a CDN runs under the same `connect-src` silence as the page's own code.
 * The page URL carries the per-artifact key, which is why the route also sends
 * `Referrer-Policy: no-referrer` — without it every CDN request would log it.
 * The hosts are spelled out in each directive rather than shared through a
 * constant because the twin parser reads string literals.
 *
 * `frame-ancestors` is deliberately ABSENT. The embedder is this app's own
 * renderer, whose origin is `file://` in a packaged build and a dev-server URL
 * under `pnpm dev`; naming either would break the other, and a wrong value
 * breaks the feature outright rather than degrading. What actually keeps the
 * page private is the per-artifact key — 256 bits, minted by the store, never
 * in argv or a log — so a page that cannot be addressed cannot be framed.
 *
 * `base-uri` and `form-action` are pinned to `'none'` because `default-src`
 * does not cover them: without the first, a `<base>` tag could re-point every
 * relative URL in the document, and without the second a form could POST the
 * page's contents somewhere even though script cannot.
 *
 * TWIN PARSER: `ARTIFACT_FILE_CSP` in
 * `apps/ui/src/renderer/chats/artifact-export.ts` restates this policy as the
 * `<meta>` a SAVED copy of the page carries — a file has no response header,
 * and the renderer cannot import daemon source. A directive changed here must
 * change there; `artifact-export.spec.ts` reads this array out of this file
 * and fails when the two disagree, so keep it one string literal per line.
 *
 * TWIN PARSER: `ARTIFACT_CDN_HOSTS` in `apps/ui/src/main/network-lockdown.ts`
 * — the Electron main process refuses every other host at the resolver and
 * the proxy, so a host added here and not there never loads in the app.
 * `network-lockdown.spec.ts` reads this array too.
 */
export const ARTIFACT_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com",
  'img-src data:',
  'font-src data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com',
  'media-src data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** The relative form a stored page refers to one of its images by. */
const STORED_IMAGE_PREFIX = `${ARTIFACT_IMAGES_DIR}/`;

/**
 * A stored page with each picture it refers to written into it as a `data:`
 * URI, so the page needs nothing from the network to show them.
 *
 * `image` reads one picture by its file name and answers null for one the store
 * does not hold, which leaves that reference as written. Only a reference naming
 * one of this store's image files is touched; the rest of the page is written
 * back exactly as the agent wrote it.
 *
 * The pictures travel inside the page rather than from a route of their own on
 * purpose. A route would need its own origin in the page's policy, and that
 * origin would be the daemon's loopback address — a place the page could then
 * reach its other routes from. The page's policy admits no such origin.
 */
export function withInlineImages(
  html: string,
  image: (
    file: string,
  ) => { mediaType: ArtifactImageMediaType; bytes: Buffer } | null,
): string {
  // Each file is asked for once per page, however many references name it. Every
  // reference still carries its own copy of the data URI in the served page.
  const inlined = new Map<string, string | null>();
  return mapImageSources(html, (src) => {
    if (!src.startsWith(STORED_IMAGE_PREFIX)) {
      return src;
    }
    const file = src.slice(STORED_IMAGE_PREFIX.length);
    if (!ARTIFACT_IMAGE_FILE.test(file)) {
      return src;
    }
    let uri = inlined.get(file);
    if (uri === undefined) {
      const found = image(file);
      uri =
        found === null
          ? null
          : `data:${found.mediaType};base64,${found.bytes.toString('base64')}`;
      inlined.set(file, uri);
    }
    return uri ?? src;
  });
}

/**
 * The message `source` tags on this channel.
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/artifact-frame.tsx — the host half of
 * the same channel. The frame sends `ready`, `height`, `link`, `picture` and
 * `escape`; the host sends `theme`. There is no generated type for a
 * `postMessage` payload, so these two files are the whole contract; a message or
 * field added to one must be added to the other.
 */
export const ARTIFACT_HOST_SOURCE = 'geniro-host';
export const ARTIFACT_FRAME_SOURCE = 'geniro-artifact';

/**
 * A link target that is one of the page's own pictures, as the store inlines it
 * (`withInlineImages`) and the page runtime repoints a click-to-enlarge link to.
 *
 * TWIN PARSER: `PICTURE_SOURCE` in apps/ui/src/renderer/chats/artifact-frame.tsx.
 */
export const ARTIFACT_PICTURE_SOURCE =
  '^data:image/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/=]+$';

/**
 * How long after an Escape the wrapper watches the page for a reaction before
 * it hands the key to the host. Long enough for a page's own handler, run in
 * the same task, to close what it opened.
 */
export const ARTIFACT_ESCAPE_SETTLE_MS = 50;

/**
 * geniro's own script inside the page — the only code here the agent did not
 * write, and it does five things: it applies the theme, reports the height, relays
 * link clicks, hands over an Escape the page ignored, and announces itself to the
 * host once it runs.
 *
 * It APPLIES the theme: the host posts the resolved values of its own tokens
 * and this writes them onto `documentElement`, so a page that reached for
 * `var(--geniro-fg)` is painted in the user's actual theme and follows it when
 * they switch. The values have to arrive by message rather than be baked into
 * the response, because the daemon cannot read the renderer's stylesheets —
 * the token VALUES live in CSS files that only the renderer has parsed.
 *
 * And it REPORTS its height, so the frame can be sized to its content instead
 * of scrolling inside a box. `ResizeObserver` covers the case a load event
 * cannot: a page whose own script draws after first paint, which is most of
 * the interesting ones.
 *
 * Once the theme is written it fires `ARTIFACT_THEME_EVENT` on `window`, which
 * is how the page runtime (`artifact-runtime.ts`) knows to re-theme the charts
 * and diagrams it drew with the previous values.
 *
 * And it RELAYS a link click to the host, which opens it on a click it saw. The
 * sandbox grants the page no popups, so this is the only way a link leaves the
 * frame. A link to one of the page's own pictures ({@link ARTIFACT_PICTURE_SOURCE})
 * is sent as `picture` instead, which the host opens in its image viewer: no
 * browser opens a `data:` address, so as a link it went nowhere.
 *
 * And it HANDS the host an Escape the page did not act on. A key pressed while
 * focus is inside the frame never reaches the host's document, so without this
 * Escape could not close the full-screen view once the page was clicked. A page
 * that acts on Escape itself (closing its own lightbox) either cancels the event
 * or changes its DOM within {@link ARTIFACT_ESCAPE_SETTLE_MS}; either keeps the
 * key in the page.
 *
 * It accepts a message only from its own parent (`event.source === parent`).
 * Nothing secret travels either way — colours out, a pixel height back — so
 * this is about a stray message from another frame confusing the page, not
 * about secrecy.
 */
export const ARTIFACT_WRAPPER_SCRIPT = `
(function () {
  var root = document.documentElement;
  var last = -1;
  var picture = new RegExp(${JSON.stringify(ARTIFACT_PICTURE_SOURCE)});
  function post(message) {
    message.source = ${JSON.stringify(ARTIFACT_FRAME_SOURCE)};
    parent.postMessage(message, '*');
  }
  function report() {
    var body = document.body;
    var height = Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      root.scrollHeight
    );
    if (height === last) return;
    last = height;
    post({ type: 'height', height: height });
  }
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.source !== ${JSON.stringify(ARTIFACT_HOST_SOURCE)}) return;
    if (data.type === 'theme' && data.vars) {
      for (var name in data.vars) {
        try {
          root.style.setProperty(name, String(data.vars[name]));
        } catch (err) {
          /* a token the page cannot take is not worth failing the page over */
        }
      }
      window.dispatchEvent(new Event(${JSON.stringify(ARTIFACT_THEME_EVENT)}));
      report();
    }
  });
  window.addEventListener('load', report);
  window.addEventListener('resize', report);
  // A link never navigates the frame, which has no history to come back to. The
  // host opens it, and only for a click it saw. A same-page anchor keeps
  // scrolling as it always did.
  document.addEventListener('click', function (event) {
    var node = event.target;
    var anchor = node && node.closest ? node.closest('a[href], area[href]') : null;
    if (!anchor || event.button !== 0) return;
    var href = (anchor.getAttribute('href') || '').trim();
    if (href.charAt(0) === '#') return;
    event.preventDefault();
    if (picture.test(href)) {
      var shown = anchor.querySelector('img');
      post({ type: 'picture', src: href, alt: shown ? shown.getAttribute('alt') || '' : '' });
      return;
    }
    post({ type: 'link', href: href });
  }, true);
  window.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || typeof MutationObserver !== 'function') return;
    var changed = false;
    // A lightbox already closed still rewrites its class on Escape: an unchanged value is no reaction.
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        if (
          record.type !== 'attributes' ||
          record.oldValue !== record.target.getAttribute(record.attributeName)
        ) {
          changed = true;
        }
      }
    });
    observer.observe(root, {
      attributes: true,
      attributeOldValue: true,
      childList: true,
      subtree: true
    });
    setTimeout(function () {
      observer.disconnect();
      if (!changed && !event.defaultPrevented) post({ type: 'escape' });
    }, ${ARTIFACT_ESCAPE_SETTLE_MS});
  }, true);
  if (typeof ResizeObserver === 'function') {
    var observe = function () {
      if (document.body) new ResizeObserver(report).observe(document.body);
      report();
    };
    if (document.body) observe();
    else window.addEventListener('DOMContentLoaded', observe);
  }
  post({ type: 'ready' });
})();
`.trim();

/**
 * The base styling every artifact starts from — in the app's frame AND in the
 * file the user saves, so the two look the same.
 *
 * Every value is a `var(--geniro-*)` with a fallback, so the page is legible
 * before the host's theme message arrives and if it never does.
 *
 * The two RESET lines are floors against the two ways an agent's page routinely
 * overflows its frame: a width plus padding measured content-box, and an image
 * wider than the column. Both are what every modern stylesheet already
 * declares, so a page that sets them itself sets the same values; a page that
 * forgot them is the one this catches.
 *
 * The CENTRING lines are the third floor. An agent routinely caps its reading
 * column on `body` (`max-width: 880px`) while also writing `margin: 0`, which
 * pins the column to the left edge once the frame is wider than the cap — the
 * full-screen view, every time. A `margin-inline: auto` here would lose to that
 * `margin: 0`, so the centring lives on `html`, which pages leave alone: a flex
 * row that centres its one child. `flex: 1` keeps an uncapped body exactly as
 * wide as before, and `min-width: 0` keeps a wide table from stretching the body
 * past the frame, as block layout never did. A page that styles `html` or
 * `body` itself still wins.
 *
 * How a bare element looks is {@link ELEMENT_STYLE}'s, one layer lower.
 * Everything else about how a page LOOKS is the agent's, and is asked for where
 * the agent can act on it — the `show_artifact` tool's own description — rather
 * than legislated here, since a page's own CSS wins by construction and a floor
 * cannot reach inside its markup.
 *
 * The GROUND is not here, because the two readings need different ones: see
 * {@link FRAME_GROUND}.
 */
const BASE_STYLE = `
*, *::before, *::after { box-sizing: border-box; }
img, svg, video, canvas { max-width: 100%; }
html { display: flex; justify-content: center; }
body {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  padding: 16px;
  color: ${themeVar('fg')};
  font-family: ${themeVar('font')};
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
:root { color-scheme: light dark; }
a { color: ${themeVar('primary')}; }
`.trim();

/**
 * What a bare HTML element looks like before the page styles it — headings,
 * lists, tables, inline code, disclosures, form controls, focus — in the app's
 * tokens instead of the browser's defaults.
 *
 * MEASURED, not imagined: a survey of the agents' own pages found browser
 * defaults leaking through wherever a page's CSS stopped short — the native ▶
 * marker on 22 of 23 pages with a `<details>`, the system checkbox and select,
 * a table with no cell padding. Every page sets SOME of these and not others,
 * so a floor that answers each element on its own is what makes the rest
 * consistent.
 *
 * It sits in `geniro-elements`, the LOWEST layer ({@link ARTIFACT_LAYER_ORDER}):
 * below Tailwind's preflight, so a Tailwind page gets the reset its utilities
 * are written against (`ul` without bullets, `h1` at the body size), and below
 * every rule the page writes, so a page that styles an element keeps its own
 * look. It only fills what nothing else set.
 *
 * The GUARDS at the end are the exception, and are deliberately few:
 * `!important` in the lowest layer outranks every normal rule anywhere, so they
 * hold even against the page's own CSS. Each one undoes a rule the survey found
 * agents writing, and which has no right use on the element it guards:
 *  - `list-style-position: outside` on a `summary` hangs the marker into the
 *    box's padding, on top of its border (the screenshot that opened this);
 *  - `word-break: break-all` reaching a `code` breaks an id or a hash in the
 *    middle ("cw_case_switch_selecti | on") even where it fits its line.
 *    `overflow-wrap` is left to the page: forcing `break-word` stopped a
 *    table column shrinking below its longest token, which overflows a
 *    narrow frame.
 *
 * Controls get the app's chrome only when they carry no class: a page that
 * classed its own tabs or segmented buttons drew them, and a radius or a
 * ground leaking into them bent their underlines and corners.
 */
const ELEMENT_STYLE = `
:root { accent-color: ${themeVar('primary')}; }
h1, h2, h3, h4, h5, h6 { margin: 1.5em 0 0.5em; line-height: 1.3; font-weight: 600; text-wrap: pretty; }
h1 { font-size: 1.6em; margin-top: 0; }
h2 { font-size: 1.3em; }
h3 { font-size: 1.1em; }
h4, h5, h6 { font-size: 1em; }
ul, ol { padding-left: 1.5em; }
li::marker { color: ${themeVar('muted')}; }
hr { border: 0; border-top: 1px solid ${themeVar('border')}; margin: 1.5em 0; }
blockquote { margin: 0 0 1em; padding: 0.5em 1em; border-left: 3px solid ${themeVar('border')}; }
mark { background: color-mix(in srgb, ${themeVar('warning')} 30%, transparent); color: inherit; border-radius: 2px; }
kbd { padding: 0 0.4em; border: 1px solid ${themeVar('border')}; border-bottom-width: 2px; border-radius: 4px; font-size: 0.85em; }
dd { margin: 0 0 0.5em; }
figure { margin: 0 0 1em; }
figcaption { margin-top: 4px; font-size: 0.9em; color: ${themeVar('muted')}; }
img, video { height: auto; }
table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 6px 10px; text-align: left; vertical-align: top; border-top: 1px solid ${themeVar('border')}; }
table > :first-child > tr:first-child > *, table > tr:first-child > * { border-top: 0; }
th { font-weight: 600; }
summary { cursor: pointer; }
summary::marker { color: ${themeVar('muted')}; font-size: 0.8em; }
button, input, select, textarea { font: inherit; color: inherit; }
input:not([class], [type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"], [type="button"], [type="submit"], [type="reset"], [type="image"]), select:not([class]), textarea:not([class]) {
  padding: 5px 8px;
  background-color: ${themeVar('surface')};
  border: 1px solid ${themeVar('border')};
  border-radius: calc(${themeVar('radius')} - 2px);
}
button:not([class]), input:not([class]):is([type="button"], [type="submit"], [type="reset"]) {
  padding: 5px 12px;
  background-color: ${themeVar('surface')};
  border: 1px solid ${themeVar('border')};
  border-radius: calc(${themeVar('radius')} - 2px);
  cursor: pointer;
}
:disabled { opacity: 0.55; cursor: default; }
::placeholder { color: ${themeVar('muted')}; opacity: 1; }
:focus-visible { outline: 2px solid ${themeVar('primary')}; outline-offset: 2px; }
summary { list-style-position: inside !important; }
code { word-break: normal !important; }
`.trim();

/** {@link ELEMENT_STYLE} as the `<style>` that carries it. */
const ELEMENT_STYLE_BLOCK = `<style data-geniro="elements">@layer geniro-elements {\n${ELEMENT_STYLE}\n}</style>`;

/**
 * The framed page's ground: transparent rather than white, which is the one
 * line that makes an artifact look like part of the app instead of a document
 * pasted into it — the frame shows the app's own background through, so a page
 * that sets none inherits the user's theme. A page that sets its own still wins.
 *
 * The saved file must NOT carry it: a file has nothing behind it, so it would
 * land on the browser's white. Its ground is baked in by the renderer's export
 * (`artifact-export.ts`), with the theme the user was looking at; this block is
 * appended after that one in the same layer, so carrying this line there would
 * win and undo it.
 */
const FRAME_GROUND = 'html, body { background: transparent; }';

/**
 * Where geniro's own block goes, if the document gave it a place to go.
 *
 * The LAST such tag, not the first — the negative lookahead is what makes it
 * last. An agent's page routinely emits markup from its own script, or
 * shows HTML as its subject, so an earlier `</body>` can sit INSIDE a script
 * or a string literal; splicing the block there ends that script element on
 * the block's own closing tag and breaks the page, taking the wrapper down
 * with it.
 */
const BODY_CLOSE = /<\/body\s*>(?![\s\S]*<\/body\s*>)/i;

/**
 * The base style as a `<style>` in the `geniro-base` layer
 * (ARTIFACT_LAYER_ORDER): above Tailwind's reset, below the kit and Tailwind's
 * utilities, so both outrank this floor and the page's own unlayered CSS
 * outranks all of it. The element floor ({@link ELEMENT_STYLE}) travels with
 * it; its layer, not its place in the document, is what ranks it.
 */
function baseStyleBlock(ground: string | null): string {
  const css = ground === null ? BASE_STYLE : `${ground}\n${BASE_STYLE}`;
  return `${ELEMENT_STYLE_BLOCK}<style data-geniro="base">@layer geniro-base {\n${css}\n}</style>`;
}

/** `block` spliced in just before the document's last `</body>`, or appended. */
function appendBlock(html: string, block: string): string {
  // A function replacer, so a `$&` or `$1` occurring in the agent's own styles
  // or script is not read as a replacement pattern.
  return BODY_CLOSE.test(html)
    ? html.replace(BODY_CLOSE, (close) => `${block}${close}`)
    : `${html}\n${block}`;
}

/**
 * One agent-authored document, wrapped for serving.
 *
 * The agent's markup is never parsed, sanitized or rewritten — geniro only
 * splices its own blocks in beside it. That is deliberate and it is what the
 * sandbox is for: trying to clean HTML is a losing game played for decades,
 * while an opaque origin under `ARTIFACT_PAGE_CSP` makes the question moot —
 * the page can load libraries from the fixed CDNs and open no channel of its
 * own, whatever it contains.
 *
 * geniro's block is appended at the END rather than injected into `<head>`, for
 * two reasons. A model's document is frequently a fragment with no `<head>` at
 * all, so there may be nothing to inject into; and the wrapper has to run after
 * the page's own script has defined whatever it draws, or the first height it
 * reports is of an empty body. The base style still lands first in the CASCADE
 * despite being last in the document, because it sits in a cascade layer below
 * everything the page, the kit or Tailwind writes.
 *
 * The page RUNTIME is the exception and goes in FRONT (`withArtifactRuntime`):
 * it defines helpers the page's own script calls, so it has to exist first.
 */
export function renderArtifactPage(html: string): string {
  return appendBlock(
    withArtifactRuntime(html),
    `${baseStyleBlock(FRAME_GROUND)}<script>${ARTIFACT_WRAPPER_SCRIPT}</script>`,
  );
}

/**
 * The agent's document for a saved file: with the page runtime its script
 * calls and the same base style the frame gives it — a saved page must look as
 * it did in the app — but without the frame wrapper, which is a handshake with
 * an embedder a file opened on its own will never have, and without the
 * frame's transparent ground ({@link FRAME_GROUND}).
 */
export function renderArtifactDocument(html: string): string {
  return appendBlock(withArtifactRuntime(html), baseStyleBlock(null));
}
