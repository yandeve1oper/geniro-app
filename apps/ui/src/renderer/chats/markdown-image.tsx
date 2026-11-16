import { useContext, useEffect, useState } from 'react';

import { ZoomableImage } from '../components/ui/image-viewer';
import { LocalImageLoaderContext, refusalFor } from './local-image-loader';
import { localPathOf } from './markdown-paths';

/**
 * One image an agent referenced from its own markdown.
 *
 * The reported defect was "i dont see images", and the reason was two
 * independent walls. The renderer's CSP is `img-src 'self' data:`, so a
 * `file:` source is refused outright; and a bare relative reference —
 * `![](a.png)`, one of the two forms measured in the author's own history —
 * resolves against the app's own origin, which has nothing to do with the
 * folder the agent was working in. Both are answered the same way the pasted
 * attachments already are: fetch the bytes over the token-gated daemon route
 * and hand the tag a `data:` URL.
 *
 * A failure shows the REFERENCE, not a broken-image box. "geniro could not read
 * /tmp/shots/x.png" is a fact the user can act on; a grey placeholder is the
 * bug being reported again.
 */
export function MarkdownImage({
  src,
  alt,
}: {
  src?: string | Blob;
  alt?: string;
}): React.JSX.Element {
  const load = useContext(LocalImageLoaderContext);
  // `src` is typed loosely by the markdown renderer's HTML props; only a string
  // is a reference we can do anything with.
  const reference = typeof src === 'string' ? localPathOf(src.trim()) : '';
  const refusal = reference === '' ? 'no image source' : refusalFor(reference);
  const inline = reference.startsWith('data:');
  const [resolved, setResolved] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!load || refusal !== null || inline || reference === '') {
      return;
    }
    let live = true;
    setFailed(null);
    void load(reference)
      .then((url) => {
        if (live) {
          setResolved(url);
        }
      })
      .catch((err: unknown) => {
        if (live) {
          setFailed(err instanceof Error ? err.message : 'could not be read');
        }
      });
    return () => {
      live = false;
    };
  }, [load, reference, refusal, inline]);

  if (refusal !== null) {
    return (
      <span
        data-slot="markdown-image-unavailable"
        className="my-1 block w-fit rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
        {alt ? `${alt} — ` : ''}
        {refusal}
        {reference && !reference.startsWith('data:') ? ` (${reference})` : ''}
      </span>
    );
  }
  if (failed !== null) {
    return (
      <span
        data-slot="markdown-image-unavailable"
        className="my-1 block w-fit rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
        could not read {reference}
      </span>
    );
  }
  const url = inline ? reference : resolved;
  if (url === null) {
    // Nothing yet — a bare box would be indistinguishable from the failure
    // above, so the reference itself stands in until the bytes land.
    return (
      <span
        data-slot="markdown-image-loading"
        className="my-1 block w-fit text-xs text-muted-foreground">
        {alt || reference}
      </span>
    );
  }
  return (
    <ZoomableImage
      imgSlot="markdown-image"
      src={url}
      alt={alt}
      // The reference the agent wrote, not the resolved `data:` URL — a
      // 200KB base64 string is not a caption. `alt` is preferred where the
      // agent supplied one, and the inline case has no path to fall back on.
      title={alt || (inline ? undefined : reference)}
      className="my-1 block w-fit max-w-full"
      imgClassName="max-h-96 max-w-full rounded-lg border border-border object-contain"
    />
  );
}
