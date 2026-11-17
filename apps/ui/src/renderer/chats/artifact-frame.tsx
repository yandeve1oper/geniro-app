import { useContext, useEffect, useRef, useState } from 'react';

import { EXTERNAL_LINK_SCHEMES } from '../../shared/link-schemes';
import { ErrorBanner } from '../components/error-banner';
import { closeTopEscapeLayer } from '../components/ui/escape-layers';
import { ImageViewer } from '../components/ui/image-viewer';
import { cn } from '../components/ui/utils';
import { useLatestCallback } from '../components/use-latest-callback';
import { useThemeAppearance } from '../theme/apply-theme';
import { themeVars } from './artifact-theme';
import { useBrowserPane } from './browser/browser-pane-context';
import { openInChatBrowserByDefault } from './browser/chat-link';
import {
  ArtifactAnswersContext,
  type ArtifactAnswersStore,
  ArtifactUrlContext,
  type PublishedArtifact,
} from './published-artifact';

/**
 * The message `source` tags, and the messages either side sends.
 *
 * TWIN PARSER: apps/daemon/src/v1/agents/utils/artifact-page.ts — the page half of
 * this channel. The frame sends `ready`, `height`, `link`, `picture`, `escape`,
 * `open-path` and `answer`; the host sends `theme` and `answers`. There is no
 * generated type for a `postMessage` payload, so the two files are the whole
 * contract.
 */
const HOST_SOURCE = 'geniro-host';
const FRAME_SOURCE = 'geniro-artifact';

/**
 * One of the page's own pictures: a click on it, or on a link to it, opens it in
 * the image viewer.
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

/** The longest path a page's folder button may name, as main's schema bounds it. */
const MAX_OPEN_PATH = 1024;

/** The absolute path a page's folder button names, or null when it names none. */
function pathToOpen(path: unknown): string | null {
  return typeof path === 'string' &&
    path.startsWith('/') &&
    path.length <= MAX_OPEN_PATH &&
    !path.includes('\u0000')
    ? path
    : null;
}

/**
 * The longest name one answer is saved under.
 *
 * TWIN PARSER: `MAX_ARTIFACT_ANSWER_NAME_LENGTH` in the daemon's `chat.types.ts`,
 * which refuses a longer one; `artifact-frame.spec.tsx` reads that file and fails
 * when the two disagree.
 */
export const MAX_ANSWER_NAME = 200;

/** Whether a page's answer name is one the daemon takes. */
function isAnswerName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_ANSWER_NAME &&
    name !== '__proto__'
  );
}

/** How long a page's answers settle before they are kept, so typing saves once. */
export const ANSWERS_SAVE_DELAY_MS = 400;

/** How long a refused save waits before it is sent again. */
export const ANSWERS_RETRY_MS = 2000;

/** How many times one batch of answers is sent before the frame says it was not kept. */
const ANSWERS_SAVE_ATTEMPTS = 3;

/**
 * The shortest gap between two folder buttons acted on: as long as a click stays
 * fresh in Chromium (`navigator.userActivation`, 5 s), so one click opens at most
 * one Finder window.
 */
export const OPEN_PATH_GAP_MS = 5000;

/** Whether the user's click (or key) that this message follows is still fresh. */
function userJustActed(): boolean {
  return (
    (navigator as { userActivation?: { isActive: boolean } }).userActivation
      ?.isActive === true
  );
}

/**
 * Answers the page changed and not yet kept, with the page they belong to, the
 * page's save count each reached (handed back once they are kept, so the page lets
 * a newer pick from another frame show) and how many sends they have had.
 */
interface PendingAnswers {
  store: ArtifactAnswersStore;
  artifactId: string;
  changes: Record<string, unknown>;
  confirms: Record<string, number>;
  attempts: number;
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
 * page's own pictures, or a click on one, arrives as `picture` and opens in the
 * app's image viewer.
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
  const answersStore = useContext(ArtifactAnswersContext);
  const frame = useRef<HTMLIFrameElement>(null);
  const pendingAnswers = useRef<PendingAnswers | null>(null);
  const answersTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameToken = useRef(Symbol('artifact frame'));
  const lastOpenedAt = useRef(0);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const [picture, setPicture] = useState<FramePicture | null>(null);
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
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

  const postAnswers = useLatestCallback(
    (
      values: Record<string, unknown>,
      confirmed: Record<string, number> | null = null,
    ): void => {
      frame.current?.contentWindow?.postMessage(
        { source: HOST_SOURCE, type: 'answers', values, confirmed },
        '*',
      );
    },
    [],
  );

  // The kept answers go back into the page each time it announces itself, to the
  // document that asked: a frame reloaded meanwhile asks again.
  const restoreAnswers = useLatestCallback((): void => {
    const page = frame.current?.contentWindow;
    if (answersStore === null || page === null || page === undefined) {
      return;
    }
    answersStore
      .read(artifact.artifactId)
      .then((values) => {
        if (frame.current?.contentWindow === page) {
          postAnswers(values);
        }
      })
      .catch(() => undefined);
  }, [answersStore, artifact.artifactId, postAnswers]);

  const saveAnswers = useLatestCallback((): void => {
    if (answersTimer.current !== null) {
      clearTimeout(answersTimer.current);
      answersTimer.current = null;
    }
    const pending = pendingAnswers.current;
    pendingAnswers.current = null;
    if (pending === null) {
      return;
    }
    pending.store
      .save(pending.artifactId, pending.changes, frameToken.current)
      .then((values) => {
        setSaveFailure(null);
        postAnswers(values, pending.confirms);
      })
      .catch((error: unknown) => {
        const newer = pendingAnswers.current;
        const sameTarget =
          newer === null ||
          (newer.store === pending.store &&
            newer.artifactId === pending.artifactId);
        if (!sameTarget || pending.attempts + 1 >= ANSWERS_SAVE_ATTEMPTS) {
          setSaveFailure(
            `Your picks on this page were not saved: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        pendingAnswers.current = {
          ...pending,
          changes: { ...pending.changes, ...newer?.changes },
          confirms: { ...pending.confirms, ...newer?.confirms },
          attempts: pending.attempts + 1,
        };
        if (answersTimer.current !== null) {
          clearTimeout(answersTimer.current);
        }
        answersTimer.current = setTimeout(saveAnswers, ANSWERS_RETRY_MS);
      });
  }, [postAnswers]);

  const keepAnswer = useLatestCallback(
    (name: string, value: unknown, seq: unknown): void => {
      if (answersStore === null) {
        return;
      }
      const pending = pendingAnswers.current;
      if (
        pending !== null &&
        (pending.store !== answersStore ||
          pending.artifactId !== artifact.artifactId)
      ) {
        saveAnswers();
      }
      const current = pendingAnswers.current;
      pendingAnswers.current = {
        store: answersStore,
        artifactId: artifact.artifactId,
        changes: { ...current?.changes, [name]: value ?? null },
        confirms:
          typeof seq === 'number'
            ? { ...current?.confirms, [name]: seq }
            : { ...current?.confirms },
        attempts: 0,
      };
      if (answersTimer.current !== null) {
        clearTimeout(answersTimer.current);
      }
      answersTimer.current = setTimeout(saveAnswers, ANSWERS_SAVE_DELAY_MS);
    },
    [answersStore, artifact.artifactId, saveAnswers],
  );

  const openPath = useLatestCallback((path: string): void => {
    const now = Date.now();
    if (!userJustActed() || now - lastOpenedAt.current < OPEN_PATH_GAP_MS) {
      return;
    }
    lastOpenedAt.current = now;
    window.geniro
      .openArtifactPath(path)
      .then((outcome) => {
        setOpenFailure(
          outcome.shown === null
            ? `The page's folder could not be shown: ${outcome.reason}`
            : null,
        );
      })
      .catch((error: unknown) => {
        setOpenFailure(
          `The page's folder could not be shown: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
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
        path?: unknown;
        name?: unknown;
        value?: unknown;
        seq?: unknown;
      };
      if (message.source !== FRAME_SOURCE) {
        return;
      }
      if (message.type === 'ready') {
        postTheme();
        restoreAnswers();
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
      if (message.type === 'answer') {
        if (userIsInFrame && isAnswerName(message.name)) {
          keepAnswer(message.name, message.value, message.seq);
        }
        return;
      }
      if (message.type === 'open-path') {
        const path = pathToOpen(message.path);
        if (userIsInFrame && path !== null) {
          openPath(path);
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
  }, [postTheme, openLink, restoreAnswers, keepAnswer, openPath]);

  // Answers still settling when the frame goes are kept, not dropped.
  useEffect(() => saveAnswers, [saveAnswers]);

  // What another frame of this page saves reaches this one too.
  useEffect(
    () =>
      answersStore?.subscribe(
        artifact.artifactId,
        frameToken.current,
        postAnswers,
      ),
    [answersStore, artifact.artifactId, postAnswers],
  );

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

  const notices = [
    { id: 'open', text: openFailure, clear: () => setOpenFailure(null) },
    { id: 'save', text: saveFailure, clear: () => setSaveFailure(null) },
  ].filter((notice) => notice.text !== null);

  return (
    <div className={cn(fill ? 'relative h-full' : 'contents')}>
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
      {notices.length > 0 && (
        <div
          className={cn(
            'flex flex-col gap-2',
            fill ? 'absolute inset-x-2 bottom-2' : 'mt-2',
          )}>
          {notices.map((notice) => (
            <ErrorBanner
              key={notice.id}
              size="sm"
              message={notice.text ?? ''}
              onDismiss={notice.clear}
            />
          ))}
        </div>
      )}
      {picture !== null && (
        <ImageViewer
          open
          onClose={() => setPicture(null)}
          src={picture.src}
          alt={picture.alt}
          title={picture.alt || artifact.title}
        />
      )}
    </div>
  );
}
