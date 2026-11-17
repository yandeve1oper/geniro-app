/**
 * The folder, under an artifact, that holds its pictures. A stored page points at
 * a picture as `images/<name>`, and the store that writes the pictures and the
 * renderer that inlines them both need that spelling, so it is named once here.
 */
export const ARTIFACT_IMAGES_DIR = 'images';

/**
 * The formats a stored picture may be in, by file extension. Named beside the
 * reference grammar so the store, the policy that sniffs the bytes and the page
 * renderer that recognises a stored reference all draw from one list.
 */
export const ARTIFACT_IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'webp',
  'gif',
  'avif',
] as const;

export type ArtifactImageExtension = (typeof ARTIFACT_IMAGE_EXTENSIONS)[number];

export type ArtifactImageMediaType =
  'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/avif';

/** The media type each stored image is served under, by its extension. */
export const ARTIFACT_IMAGE_MEDIA_TYPE: Record<
  ArtifactImageExtension,
  ArtifactImageMediaType
> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

/** Whether a file extension is one of the formats a stored picture may be in. */
export function isArtifactImageExtension(
  value: string,
): value is ArtifactImageExtension {
  return (ARTIFACT_IMAGE_EXTENSIONS as readonly string[]).includes(value);
}

/**
 * The file name a stored picture is kept under: the hash of its bytes, then its
 * extension. Anything else is not one of the store's pictures, which is what keeps
 * the image route from being a way to name an arbitrary file.
 */
export const ARTIFACT_IMAGE_FILE = new RegExp(
  `^[0-9a-f]{64}\\.(${ARTIFACT_IMAGE_EXTENSIONS.join('|')})$`,
);

/**
 * The folder, under an artifact, that holds its audio and video. A stored page
 * points at one as `media/<name>`, which the served page turns into the media route.
 */
export const ARTIFACT_MEDIA_DIR = 'media';

/** The formats a stored audio or video file may be in, by file extension. */
export const ARTIFACT_MEDIA_EXTENSIONS = [
  'mp3',
  'aac',
  'm4a',
  'mp4',
  'mov',
  'wav',
  'ogg',
  'flac',
  'webm',
] as const;

export type ArtifactMediaExtension = (typeof ARTIFACT_MEDIA_EXTENSIONS)[number];

/** The media type each stored audio or video file is served under, by its extension. */
export const ARTIFACT_MEDIA_TYPE: Record<ArtifactMediaExtension, string> = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'video/webm',
};

/** Whether a file extension is one of the formats a stored media file may be in. */
export function isArtifactMediaExtension(
  value: string,
): value is ArtifactMediaExtension {
  return (ARTIFACT_MEDIA_EXTENSIONS as readonly string[]).includes(value);
}

/** The file name a stored media file is kept under, as {@link ARTIFACT_IMAGE_FILE} is for a picture. */
export const ARTIFACT_MEDIA_FILE = new RegExp(
  `^[0-9a-f]{64}\\.(${ARTIFACT_MEDIA_EXTENSIONS.join('|')})$`,
);

/**
 * An `<img>` tag, from its `<img` to the first `>` after it. The name ends at
 * whitespace, `/` or `>`, so `<imgx` and `<img-x` are other tags. A `>` inside a
 * quoted value ends the match early, which is why imageTagsAreWhole refuses such a
 * page rather than rewriting half a tag.
 */
const IMG_TAG = /<img(?=[\s/>])[^>]*>/gi;
const IMG_OPENING = /<img(?=[\s/]|$)/i;

/**
 * An `<audio>`, `<video>` or `<source>` tag, read as {@link IMG_TAG} reads an
 * image. A `<source>` inside a `<picture>` names its pictures with `srcset`, so the
 * `src` this rewrites is a media element's.
 */
const MEDIA_TAG = /<(?:audio|video|source)(?=[\s/>])[^>]*>/gi;
const MEDIA_OPENING = /<(?:audio|video|source)(?=[\s/]|$)/i;

/**
 * The first `src` attribute of a tag that has a value. The leading `(^|\s)` keeps
 * `data-src` out. The attribute's own spelling and the spacing round its `=` are
 * captured so they are written back as they were. An unquoted value runs to
 * whitespace or `>`, as a browser reads it, so an apostrophe inside it is part of the
 * path. A `src=` inside another attribute's quoted text is taken for the attribute:
 * the picture then fails to show, and the policy still judges the path.
 */
const SRC = /(^|\s)(src)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * Whether a tag's quotes close before its `>`. A quote opens a value only where one
 * begins, straight after the `=`, so `alt="don't"` is one value, and `src=it's.png`
 * is an unquoted value with an apostrophe in it. Only the quote that opened a value
 * closes it.
 */
function quotesClose(tag: string): boolean {
  let open: string | null = null;
  let previous = '';
  for (const character of tag) {
    if (open !== null) {
      if (character === open) {
        open = null;
      }
    } else if ((character === '"' || character === "'") && previous === '=') {
      open = character;
    }
    if (!/\s/.test(character)) {
      previous = character;
    }
  }
  return open === null;
}

/**
 * A source value written back in the quote it was read in. A bare value stays bare
 * only while a browser would read it back unchanged; otherwise it is quoted.
 */
function writeSourceValue(value: string, quote: string): string {
  if (quote !== '') {
    return `${quote}${value}${quote}`;
  }
  return /^[^\s"'<>=`]+$/.test(value) ? value : `"${value}"`;
}

/** One tag with its `src` value replaced by what `map` returns for it. */
function rewriteTag(tag: string, map: (src: string) => string): string {
  const found = SRC.exec(tag);
  if (found === null) {
    return tag;
  }
  const value = found[4] ?? found[5] ?? found[6];
  if (value === undefined) {
    return tag;
  }
  const mapped = map(value);
  if (mapped === value) {
    return tag;
  }
  let quote = '';
  if (found[4] !== undefined) {
    quote = '"';
  } else if (found[5] !== undefined) {
    quote = "'";
  }
  const start = found.index + (found[1] ?? '').length;
  const end = found.index + found[0].length;
  return `${tag.slice(0, start)}${found[2]}${found[3]}${writeSourceValue(mapped, quote)}${tag.slice(end)}`;
}

/**
 * Every `<img>` source in a page, passed through `map`, which returns what the
 * source should say instead. Nothing else is touched: the other attributes, the
 * quoting of a source that is not changed, and every byte outside an image tag are
 * written back exactly as they were.
 *
 * Only the part up to the page's last `>` is scanned. Every tag there closes, so each
 * match ends with its own tag and the scan stays linear. What follows is an unclosed
 * tag, which imageTagsAreWhole refuses.
 */
export function mapImageSources(
  html: string,
  map: (src: string) => string,
): string {
  return mapTagSources(html, IMG_TAG, map);
}

/** Every `<audio>`, `<video>` and `<source>` source, as {@link mapImageSources} maps an image's. */
export function mapMediaSources(
  html: string,
  map: (src: string) => string,
): string {
  return mapTagSources(html, MEDIA_TAG, map);
}

function mapTagSources(
  html: string,
  tags: RegExp,
  map: (src: string) => string,
): string {
  const end = html.lastIndexOf('>') + 1;
  return (
    html.slice(0, end).replace(tags, (tag) => rewriteTag(tag, map)) +
    html.slice(end)
  );
}

/**
 * Whether every `<img` in a page closes the way a browser reads it: no unclosed tag
 * at the end, and every tag's quotes close before its `>`. A page that fails is
 * refused with that reason. A `>` inside an attribute value is written as `&gt;`.
 */
export function imageTagsAreWhole(html: string): boolean {
  return tagsAreWhole(html, IMG_OPENING, IMG_TAG);
}

/** Whether every `<audio`, `<video` and `<source` closes, as {@link imageTagsAreWhole} asks of images. */
export function mediaTagsAreWhole(html: string): boolean {
  return tagsAreWhole(html, MEDIA_OPENING, MEDIA_TAG);
}

function tagsAreWhole(html: string, opening: RegExp, tags: RegExp): boolean {
  const end = html.lastIndexOf('>') + 1;
  if (opening.test(html.slice(end))) {
    return false;
  }
  return (html.slice(0, end).match(tags) ?? []).every(quotesClose);
}

/**
 * Whether an image or media source names a file on this machine, and so belongs to
 * the file policy. A source in another scheme (`data:`, `https:`, `blob:`) or a
 * protocol-relative host (`//cdn…`) is left to the browser, and so is an empty one.
 * A `file:` address IS a file on this machine. A bare `#fragment` or `?query`
 * names the page itself, not a file, and is left as written.
 *
 * Any other relative path is local on purpose: it then fails the policy's
 * absolute-path check with a reason the agent can act on, where leaving it alone
 * would ship a broken picture with no word about why.
 */
export function isLocalSource(src: string): boolean {
  const trimmed = src.trim();
  if (
    trimmed === '' ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('?') ||
    trimmed.startsWith('//')
  ) {
    return false;
  }
  if (/^file:/i.test(trimmed)) {
    return true;
  }
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}
