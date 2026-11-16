import { memo } from 'react';
import ReactMarkdown, {
  type Components,
  defaultUrlTransform,
} from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { CodeBlock } from '../components/ui/code-block';
import { languageForFence } from '../components/ui/code-language';
import { cn } from '../components/ui/utils';
import { ChatLink } from './browser/chat-link';
import { MarkdownImage } from './markdown-image';
import { type HastNode, markdownImageBlocks } from './markdown-image-blocks';
import { wrapSpacedImagePaths } from './markdown-paths';

/**
 * A fenced code block's source and language, read off the `pre`'s hast node.
 *
 * Read from the NODE rather than from the rendered `code` child's props,
 * because a fence with no info string (```` ``` ```` on its own) gives that
 * child no `className` at all — probe-verified — so a className-based
 * "is this a block?" test silently mistakes every language-less fence for
 * inline code. The node says plainly that a `code` element sits inside a
 * `pre`, which is exactly what a fence is.
 *
 * Returns null for anything that is not a single `code` child, leaving the
 * ordinary `<pre>` rendering to handle it.
 */
function readFence(
  node: HastNode | undefined,
): { code: string; language: string | null } | null {
  const child = node?.children?.length === 1 ? node.children[0] : undefined;
  if (child?.tagName !== 'code') {
    return null;
  }
  const classes = child.properties?.className;
  const language = (Array.isArray(classes) ? classes : [])
    .map((entry) => (typeof entry === 'string' ? entry : ''))
    .map((entry) => /^language-([\w+-]+)$/.exec(entry)?.[1])
    .find((entry): entry is string => entry !== undefined);
  // The newline before the closing fence is part of the text and would render
  // as a blank last line. Nothing else is trimmed — leading indentation is
  // meaningful in the code being shown.
  const code = (child.children ?? [])
    .map((text) => text.value ?? '')
    .join('')
    .replace(/\n$/, '');
  return { code, language: languageForFence(language) };
}

/**
 * Elements that ARE content while having no text of their own.
 *
 * A void or replaced element has no text node underneath it, so a text-only
 * test reads a header of `| ![chart](a.png) |` as empty and — because the
 * `thead` renderer returns null rather than restyling — deletes the images
 * along with the row. The header the reader loses there is one somebody wrote.
 */
const VOID_CONTENT_TAGS = new Set(['img', 'input', 'br', 'hr', 'svg', 'video']);

/**
 * Whether a table's header row renders anything at all.
 *
 * A table written with an empty header — `| | |` above the `|---|---|`
 * separator — is still a valid GFM table, and remark-gfm still emits a full
 * `<thead><tr><th></th><th></th></tr></thead>` for it. The `th` renderer below
 * fills its cells with `bg-muted/50`, so an empty header paints a grey band
 * across the table with nothing written in it. That band is not a style
 * decision anyone made; it is a header nobody wrote.
 *
 * The question is "does this render anything", NOT "does this have text" — the
 * difference is a header cell holding only an image, which has no text node
 * anywhere beneath it and would otherwise be dropped along with its row.
 *
 * Read off the hast NODE rather than the rendered children, for the same
 * reason {@link readFence} does: `children` is already React elements by then,
 * and a cell holding an empty string is indistinguishable from one holding
 * markup this renderer maps to nothing. The node says plainly what is
 * underneath.
 */
function rendersContent(node: HastNode | undefined): boolean {
  if (node === undefined) {
    return false;
  }
  if (typeof node.value === 'string' && node.value.trim() !== '') {
    return true;
  }
  if (node.tagName !== undefined && VOID_CONTENT_TAGS.has(node.tagName)) {
    return true;
  }
  return (node.children ?? []).some(rendersContent);
}

/**
 * A GFM column's alignment (`:---`, `:---:`, `---:`) as a utility class.
 *
 * PROBE-VERIFIED against this stack, and NOT what the plan predicted:
 * `mdast-util-to-hast` does emit the deprecated `align` PROPERTY on the hast
 * node, but react-markdown converts it to a `style={{ textAlign }}` object
 * before the component sees it — the `align` prop is `undefined`. Both are
 * read here anyway, so a future version that stops translating still works.
 * Left is the default for an unaligned column, matching prior behaviour.
 */
export function alignClass(
  style: React.CSSProperties | undefined,
  align: string | undefined,
): string {
  switch (style?.textAlign ?? align) {
    case 'center':
      return 'text-center';
    case 'right':
      return 'text-right';
    default:
      return 'text-left';
  }
}

/**
 * A transcript link, with the chat's link rules (`chats/browser/chat-link.tsx`).
 */
function TranscriptLink({
  href,
  children,
}: {
  href: string | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    // `break-all` for the same reason as inline code, and this one was
    // measured as the widest offender in a real transcript: an autolinked
    // URL is a single unbreakable token whose link TEXT is the URL, and one
    // of them pushed the transcript 139px past its pane.
    <ChatLink
      href={href}
      className="text-primary underline underline-offset-2 break-all">
      {children}
    </ChatLink>
  );
}

/**
 * PROSE TAKES THE WHOLE TRANSCRIPT WIDTH — there is no reading measure here,
 * and its removal is the point rather than an oversight.
 *
 * A `max-w-[72ch]` cap used to sit on every text element, on the typographic
 * argument that long lines are tiring to return from. Measured against the
 * running app, what it actually produced was a paragraph column ending around
 * 530px inside an 1150px pane — REPORTED as "still have current thread with
 * big gap from right side. Content should take all space", with the composer
 * directly beneath it spanning the full width and the bubble around it doing
 * the same. In a chat transcript the cap has no ground to stand on: the pane
 * is already narrowed by the chat list on one side and the agents panel on the
 * other, the bubble's own padding insets it further, and the user resizes
 * those columns to decide how wide the reading column should be. A second,
 * invisible cap inside them only ever contradicts that choice.
 *
 * So the elements below carry spacing and type alone. `pre`/`table` were never
 * capped and still are not; they scroll inside their own containers.
 *
 * Token-styled markdown renderers — the compact mirror of geniro web's
 * MarkdownContent (react-markdown + remark-gfm), trimmed to what the
 * transcript needs: paragraphs, emphasis, lists, code, links, tables,
 * quotes, headings. Colours come from the design tokens only.
 */
const COMPONENTS: Components = {
  p: ({ children }) => (
    <p className="m-0 whitespace-pre-wrap not-first:mt-2">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="m-0 list-disc pl-5 not-first:mt-2">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="m-0 list-decimal pl-5 not-first:mt-2">{children}</ol>
  ),
  li: ({ children }) => <li className="mt-0.5">{children}</li>,
  h1: ({ children }) => (
    <p className="m-0 font-bold not-first:mt-2.5">{children}</p>
  ),
  h2: ({ children }) => (
    <p className="m-0 font-bold not-first:mt-2.5">{children}</p>
  ),
  h3: ({ children }) => (
    <p className="m-0 font-semibold not-first:mt-2">{children}</p>
  ),
  h4: ({ children }) => (
    <p className="m-0 font-semibold not-first:mt-2">{children}</p>
  ),
  // Only INLINE code reaches here: a fenced block is intercepted by `pre`
  // below, which renders CodeBlock instead of these children.
  //
  // `break-all`, not `break-words`. What inline code holds in this transcript
  // is overwhelmingly an absolute path, a branch name or a hash — one token
  // with no space in it and, for a path, no break opportunity a browser will
  // take either (it will break after `/` but not before, so a long leading
  // directory still overhangs). `break-words` only breaks a word that cannot
  // fit ON ITS OWN LINE, which is why a 60-character path in the middle of a
  // paragraph ran straight out of the pane. Ugly mid-token wrapping is the
  // right trade here: the alternative was text the reader could not see.
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] break-all">
      {children}
    </code>
  ),
  pre: ({ children, node }) => {
    const fence = readFence(node);
    if (!fence) {
      return (
        <pre className="m-0 overflow-x-auto rounded-md bg-muted p-0 not-first:mt-2">
          {children}
        </pre>
      );
    }
    // Fenced blocks go through the app's ONE code surface — highlighting and
    // the copy affordance a tool payload already gets — rather than a second,
    // plainer rendering of the same thing. CodeBlock brings its own <pre>, and
    // a <pre> inside a <pre> is invalid, so this wrapper only adds the margin.
    return (
      <div className="not-first:mt-2">
        <CodeBlock code={fence.code} language={fence.language} />
      </div>
    );
  },
  a: ({ children, href }) => (
    <TranscriptLink href={href}>{children}</TranscriptLink>
  ),
  blockquote: ({ children }) => (
    <blockquote className="m-0 border-l-2 border-border pl-3 text-muted-foreground not-first:mt-2">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    // `min-w-0` + `max-w-full`: this wrapper is a flex ITEM, whose min-width
    // defaults to its content — so it grew to the table's full width and
    // `overflow-x-auto` had nothing left to clip, handing the overflow to the
    // transcript instead. Measured: a 4-column file table reached 239px past
    // the pane.
    //
    // `scroll-x-visible` is what stops the FALLBACK from lying. macOS overlay
    // scrollbars are invisible at rest, so a table wider than the pane looked
    // cut off rather than scrollable — 229px hidden with nothing on screen
    // saying so. The utility opts this element out of overlay scrollbars, so
    // the track appears exactly when there is something to scroll.
    <div className="max-w-full min-w-0 overflow-x-auto not-first:mt-2 scroll-x-visible">
      {/*
        `w-full` so the table FITS the pane by default and its cells wrap,
        rather than sizing to its content and scrolling. An earlier pass here
        argued the opposite — that a table which never overflows never scrolls
        — which optimised for the wrong thing: the reader wants to SEE the
        table, and scrolling is the fallback for one too wide to fit even
        wrapped, not the goal.
      */}
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  // Dropped entirely when the header row is blank, rather than restyled: a
  // header with no text is not a header the reader is missing the styling of,
  // it is a row that says nothing and costs a band of colour plus a line of
  // height to say it. Keeping the element and only dropping its fill would
  // leave an empty bordered stripe, which reads as a rendering fault too.
  thead: ({ children, node }) =>
    rendersContent(node) ? <thead>{children}</thead> : null,
  // `min-w-24` is the readability floor that makes the fallback meaningful.
  // Without it `w-full` divides the pane by the column count, so a 20-column
  // table squeezes each cell to a vertical stack of single letters — fitting,
  // and unreadable. With it, a table stops shrinking at ~96px per column and
  // scrolls beyond that, which is the point where scrolling genuinely beats
  // wrapping.
  th: ({ children, style, align }) => (
    <th
      className={cn(
        'min-w-24 border border-border bg-muted/50 px-2 py-1 font-semibold',
        alignClass(style, align),
      )}>
      {children}
    </th>
  ),
  td: ({ children, style, align }) => (
    <td
      className={cn(
        'min-w-24 border border-border px-2 py-1 align-top',
        alignClass(style, align),
      )}>
      {children}
    </td>
  ),
  hr: () => <hr className="my-2 border-border" />,
  // Left to the default renderer for two milestones, which produced a broken
  // box every time: the CSP forbids a `file:` source and a relative one
  // resolves against the app's origin. See {@link MarkdownImage}.
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
};

/**
 * URL sanitizer — the library's own, plus `data:` IMAGE sources.
 *
 * `defaultUrlTransform` blanks every scheme outside its allowlist, `data:`
 * included, which is right for a link and wrong for the one source the
 * renderer's CSP (`img-src 'self' data:`) actually permits: an inline image
 * arrived as `src=""` and rendered as nothing. It is also what every local
 * reference is turned INTO once the daemon has read it, so blanking it would
 * defeat {@link MarkdownImage} at the last step.
 *
 * Narrowed to `src` on an image and to the `image/` prefix — a `data:text/html`
 * href is a script in a trench coat, and it still goes to the default.
 */
function urlTransform(url: string, key: string, node: HastNode): string {
  return key === 'src' && node.tagName === 'img' && /^data:image\//i.test(url)
    ? url
    : defaultUrlTransform(url);
}

/**
 * A conversation message's size on a phone: the composer's 16px (iOS zooms
 * into a smaller field), so what is read and what is typed match.
 */
export const MESSAGE_TEXT_CLASS = 'max-sm:text-[16px]';

/** Markdown-rendered message text (geniro web's MarkdownContent). */
export const MarkdownContent = memo(function MarkdownContent({
  content,
  className,
}: {
  content: string;
  className?: string;
}): React.JSX.Element {
  return (
    // `break-words` HERE and not on each renderer below, because
    // `overflow-wrap` is an INHERITED property: one declaration on the root
    // reaches paragraphs, list items, headings, quotes and table cells at
    // once, and a renderer added later is covered without its author knowing
    // it must be. The stronger `break-all` on `code` and `a` still wins where
    // it is set, which is what those two need.
    //
    // Measured, not precautionary: a 170-character token in ordinary prose
    // (`whitespace-pre-wrap` breaks at spaces, and there are none inside one)
    // left a paragraph 643px wide reporting a 1244px scrollWidth — the text
    // past the pane simply could not be read. The earlier pass fixed the
    // markdown that happened to be code or a link and left plain prose, which
    // is what a USER's own message is made of.
    <div
      className={cn('min-w-0 text-sm leading-relaxed break-words', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[markdownImageBlocks]}
        components={COMPONENTS}
        urlTransform={urlTransform}>
        {wrapSpacedImagePaths(content)}
      </ReactMarkdown>
    </div>
  );
});
