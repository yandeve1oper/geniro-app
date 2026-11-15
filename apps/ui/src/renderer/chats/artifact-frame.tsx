import { useContext, useEffect, useRef, useState } from 'react';

import { EXTERNAL_LINK_SCHEMES } from '../../shared/link-schemes';
import { closeTopEscapeLayer } from '../components/ui/escape-layers';
import { ImageViewer } from '../components/ui/image-viewer';
import { cn } from '../components/ui/utils';
import { useLatestCallback } from '../components/use-latest-callback';
import { useThemeAppearance } from '../theme/apply-theme';
import { themeVars } from './artifact-theme';
import { useBrowserPane } from './browser/browser-pane-context';
import { openInChatBrowserByDefault } from './browser/chat-link';
import {
  ArtifactUrlContext,
  type PublishedArtifact,
} from './published-artifact';

/**
 * The message `source` tags, and the messages either side sends.
 *
 * TWIN PARSER: apps/daemon/src/v1/agents/utils/artifact-page.ts — the page half of
 * this channel. The frame sends `ready`, `height`, `link`, `picture` and `escape`;
 * the host sends `theme`. There is no generated type for a `postMessage` payload, so
 * the two files are the whole contract.
 */
const HOST_SOURCE = 'geniro-host';
const FRAME_SOURCE = 'geniro-artifact';

/**
 * One of the page's own pictures, which a click on a link to it opens in the image
 * viewer.
 *
 * TWIN PARSER: `ARTIFACT_PICTURE_SOURCE` in
 * apps/daemon/src/v1/agents/utils/artifact-page.ts.
 */
const PICTURE_SOURCE =
  /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/;

interface FramePicture {
  src: string;
  alt: string;
}

function pictureToShow(src: unknown, alt: unknown): FramePicture | null {
  if (typeof src !== 'string' || !PICTURE_SOURCE.test(src)) {
    return null;
  }
  return { src, alt: typeof alt === 'string' ? alt : '' };
}

/**
 * The address a page's link asks to open, as the URL parser reads it, or null when
 * its scheme is not one a link may open.
 *
 * It is opened at once, with no confirmation: asked for in those words ("all links
 * should be opened without confirmation"). What still bounds it is the scheme — only
 * a web or mail address reaches the browser, here and again at main's window-open
 * handler.
 */
function linkToOpen(href: unknown): string | null {
  if (typeof href !== 'string') {
    return null;
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  return EXTERNAL_LINK_SCHEMES.has(url.protocol) ? url.href : null;
}

/** Where a frame starts before its page has reported anything. */
const INITIAL_HEIGHT = 240;

/**
 * How tall an INLINE frame may grow. The popup lets the page fill the dialog
 * instead, so one artifact can never take over the transcript.
 */
const MAX_INLINE_HEIGHT = 520;

/**
 * One published artifact, rendered in a sandbox.
 *
 * **The `sandbox` attribute is the whole security model, and what it OMITS is
 * the load-bearing part.** `allow-scripts` without `allow-same-origin` puts the
 * document in an opaque origin: it cannot read this app's DOM, its storage, or
 * the loopback token the renderer holds, and `document.domain` games get it
 * nowhere. The two flags must never appear together — a frame granted both can
 * reach into its own `sandbox` attribute and remove it, which is the documented
 * way this protection is undone. The page's own response then adds its CSP,
 * which admits library scripts, styles and fonts from the fixed CDNs and no
 * other network (see `ARTIFACT_PAGE_CSP`).
 *
 * A link in the page never navigates the frame. The page posts the link to the
 * host, which opens a web or mail address in the system browser. No window is
 * created for the page, so the sandbox grants no popups. A link to one of the
 * page's own pictures arrives as `picture` and opens in the app's image viewer.
 *
 * An Escape pressed inside the frame never reaches this document, so the page
 * posts the ones it did not act on as `escape`, which closes the overlay on top —
 * the full-screen view the frame sits in, when it does.
 *
 * It is a `src` rather than an `srcdoc` because a srcdoc document inherits the
 * embedder's CSP — see {@link ARTIFACT_PAGE_CSP} in the daemon's
 * `utils/artifact-page.ts` for what that would cost.
 *
 * The frame SIZES ITSELF from the height its page reports, because an artifact
 * is a document of unknown length and a fixed box would put a scrollbar inside
 * a scrollbar. `contentWindow` identity is what messages are filtered on —
 * the frame's origin is the string `"null"` for every opaque-origin document,
 * so it identifies nothing.
 */
export function ArtifactFrame({
  artifact,
  className,
  fill = false,
}: {
  artifact: PublishedArtifact;
  className?: string;
  /** Take the room the container gives, rather than sizing to the content. */
  fill?: boolean;
}): React.JSX.Element {
  const urlFor = useContext(ArtifactUrlContext);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const [picture, setPicture] = useState<FramePicture | null>(null);
  // Re-sent on a theme change: the page holds whatever it was last given, so
  // without this an artifact stays in the palette it was opened under.
  const appearance = useThemeAppearance();
  const pane = useBrowserPane();

  const postTheme = useLatestCallback(() => {
    frame.current?.contentWindow?.postMessage(
      { source: HOST_SOURCE, type: 'theme', vars: themeVars() },
      // The frame is an opaque origin, which has no origin string to target.
      // Nothing secret travels — colours out, a pixel height back.
      '*',
    );
  }, []);

  const openLink = useLatestCallback(
    (link: string): void => {
      if (!openInChatBrowserByDefault(pane, link)) {
        window.open(link, '_blank', 'noopener');
      }
    },
    [pane],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) {
        return;
      }
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) {
        return;
      }
      const message = data as {
        source?: unknown;
        type?: unknown;
        height?: unknown;
        href?: unknown;
        src?: unknown;
        alt?: unknown;
      };
      if (message.source !== FRAME_SOURCE) {
        return;
      }
      if (message.type === 'ready') {
        postTheme();
        return;
      }
      if (message.type === 'link') {
        const link = linkToOpen(message.href);
        if (link !== null) {
          openLink(link);
        }
        return;
      }
      const userIsInFrame = document.activeElement === frame.current;
      if (message.type === 'picture') {
        if (!userIsInFrame) {
          return;
        }
        const shown = pictureToShow(message.src, message.alt);
        if (shown !== null) {
          setPicture(shown);
        }
        return;
      }
      if (message.type === 'escape') {
        if (userIsInFrame) {
          closeTopEscapeLayer();
        }
        return;
      }
      if (message.type === 'height' && typeof message.height === 'number') {
        // A page that measures itself as nothing is a page mid-layout, not a
        // page of zero height — collapsing the frame there makes it vanish.
        if (message.height > 0) {
          setHeight(message.height);
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [postTheme, openLink]);

  useEffect(() => {
    postTheme();
  }, [appearance, postTheme]);

  if (urlFor === null) {
    return (
      <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        This artifact cannot be opened here.
      </p>
    );
  }

  return (
    <>
      <iframe
        ref={frame}
        // Keyed by the exact version so a republish loads the new page rather
        // than leaving React to reuse the element with a stale document.
        key={`${artifact.artifactId}:${artifact.version}`}
        src={urlFor(artifact)}
        title={artifact.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={postTheme}
        className={cn(
          'w-full rounded-lg border border-border bg-transparent',
          className,
        )}
        style={
          fill ? undefined : { height: Math.min(height, MAX_INLINE_HEIGHT) }
        }
      />
      {picture !== null && (
        <ImageViewer
          open
          onClose={() => setPicture(null)}
          src={picture.src}
          alt={picture.alt}
          title={picture.alt || artifact.title}
        />
      )}
    </>
  );
}
