// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserPaneContext } from './browser/browser-pane-context';
import { alignClass, MarkdownContent } from './markdown-content';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

/** A real GFM table, parsed by the real remark-gfm the component uses. */
const ALIGNED_TABLE = [
  '| left | middle | right |',
  '| :--- | :----: | ----: |',
  '| a | b | c |',
].join('\n');

describe('MarkdownContent — prose takes the whole width', () => {
  // A `max-w-[72ch]` cap used to sit on every element below, and it was
  // REPORTED as a gap: the paragraph column ended around 530px inside an
  // 1150px pane, under a full-width composer. Reverting it — on the prose
  // elements or on any ancestor — fails here. jsdom lays nothing out, so the
  // utility IS the observable, and it is also the entire mechanism rather than
  // a proxy for one.
  //
  // `max-w-[` catches the arbitrary-value form the cap took (and any other
  // hand-written width ceiling); `max-w-full` is not a cap and is left alone —
  // the table wrapper carries one deliberately, to keep its own overflow.
  const isCap = (className: string): boolean => className.includes('max-w-[');

  it('caps no kind of PROSE block', () => {
    const el = render(
      <MarkdownContent
        content={[
          'A paragraph.',
          '',
          '# A heading',
          '',
          '- a list item',
          '',
          '> a quote',
        ].join('\n')}
      />,
    );
    // Headings render as `p` here (the component maps h1-h4 to sized
    // paragraphs), so both paragraphs are covered by this sweep.
    for (const selector of ['p', 'ul', 'blockquote']) {
      const nodes = [...el.querySelectorAll(selector)];
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) {
        expect(isCap(node.className)).toBe(false);
        // …and no ancestor smuggled a cap in from above either.
        for (let up = node.parentElement; up; up = up.parentElement) {
          expect(isCap(up.className)).toBe(false);
        }
      }
    }
  });

  it('leaves CODE BLOCKS and TABLES at full width', () => {
    // These were never capped and must stay uncapped: a wrapped 100-column
    // diff is unreadable in a way a wide paragraph merely was tiring.
    const el = render(
      <MarkdownContent
        content={['```ts', 'const wide = 1;', '```', '', ALIGNED_TABLE].join(
          '\n',
        )}
      />,
    );
    const block = el.querySelector('[data-slot="code-block"]')!;
    const table = el.querySelector('table')!;
    for (const start of [block, table]) {
      expect(isCap(start.className)).toBe(false);
      for (let node = start.parentElement; node; node = node.parentElement) {
        expect(isCap(node.className)).toBe(false);
      }
    }
  });
});

describe('MarkdownContent code', () => {
  it('routes a fenced block through the app CodeBlock, with its language', () => {
    const el = render(<MarkdownContent content={'```ts\nconst a = 1;\n```'} />);
    const block = el.querySelector('[data-slot="code-block"]');
    expect(block).not.toBeNull();
    expect(block?.getAttribute('data-language')).toBe('typescript');
    // Routing is the point: a fenced block must get the same surface a tool
    // payload gets, copy affordance included.
    expect(el.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
  });

  it('does not nest a <pre> inside a <pre>', () => {
    // CodeBlock renders its own <pre>; leaving the markdown `pre` renderer in
    // place would produce invalid HTML the browser silently reflows.
    const el = render(<MarkdownContent content={'```ts\nconst a = 1;\n```'} />);
    expect(el.querySelectorAll('pre pre')).toHaveLength(0);
  });

  it('leaves inline code inline — no block, no copy button', () => {
    const el = render(<MarkdownContent content={'use `npm ci` here'} />);
    expect(el.querySelector('[data-slot="code-block"]')).toBeNull();
    expect(el.querySelector('code')?.textContent).toBe('npm ci');
  });

  it('drops the fence-closing newline instead of rendering a blank last line', () => {
    const el = render(<MarkdownContent content={'```\nalpha\nbeta\n```'} />);
    expect(el.querySelector('[data-slot="code-block"] code')?.textContent).toBe(
      'alpha\nbeta',
    );
  });
});

describe('MarkdownContent — nothing overflows the transcript sideways', () => {
  // The transcript pane could be dragged sideways, clipping the conversation
  // off its own edge. Its scroller now states `overflow-x-hidden`, so anything
  // still overflowing would be CLIPPED rather than reachable — which makes
  // these three the load-bearing half of that fix, not cosmetics.

  it('breaks a long inline-code path instead of running past the pane', () => {
    // Inline code in this transcript is overwhelmingly an absolute path or a
    // branch name: one token, and for a path not one a browser breaks on its
    // own (it breaks AFTER `/`, never before, so a long leading directory
    // still overhangs). `break-words` is not enough — it only breaks a word
    // that cannot fit on a line by itself.
    const el = render(
      <MarkdownContent content="see `/Users/someone/Desktop/Projects/Geniro/geniro-app/apps/daemon/src/v1/agents/services/chat.service.ts` for it" />,
    );
    const code = el.querySelector('code');

    expect(code?.className).toContain('break-all');
  });

  it('breaks a long autolinked URL', () => {
    // Measured as the widest single offender in a real transcript: the link
    // TEXT is the URL, so there is nothing shorter to fall back on.
    const el = render(
      <MarkdownContent content="https://ticktick.com/webapp/#p/69981be521481104e25a00d1/tasks/6a744fe9556d915e8f3c2a6d" />,
    );
    const link = el.querySelector('a');

    expect(link?.getAttribute('href')).toContain('ticktick.com');
    expect(link?.className).toContain('break-all');
  });

  it('keeps a wide table’s overflow inside its own wrapper', () => {
    // The wrapper is a flex ITEM, whose min-width defaults to its content — so
    // without `min-w-0` it grew to the table's full width, `overflow-x-auto`
    // had nothing left to clip, and the overflow was handed to the transcript.
    const el = render(<MarkdownContent content={ALIGNED_TABLE} />);
    const wrapper = el.querySelector('table')?.parentElement;

    expect(wrapper?.className).toContain('min-w-0');
    expect(wrapper?.className).toContain('max-w-full');
  });
});

describe('MarkdownContent tables', () => {
  it('fits a table to the pane, and says so when it cannot', () => {
    const el = render(<MarkdownContent content={ALIGNED_TABLE} />);
    const wrapper = el.querySelector('table')?.parentElement;
    const table = el.querySelector('table');

    // `w-full` so the table FITS and its cells wrap. This assertion is the
    // inverse of the one it replaced, deliberately: that version reasoned that
    // a table which never overflows never scrolls, and optimised for having
    // something to scroll rather than for the reader seeing the table.
    expect(table?.className).toContain('w-full');
    // Cells stop shrinking at a readable floor, so a very wide table reaches
    // the scroll fallback instead of becoming vertical letter stacks.
    expect(el.querySelector('th')?.className).toContain('min-w-24');
    expect(el.querySelector('td')?.className).toContain('min-w-24');
    // And when the fallback IS reached it must be visible. macOS overlay
    // scrollbars take no layout space and are invisible at rest — measured,
    // 229px of a 9-column table hidden with a 0px scrollbar — so a scroll
    // container with no forced track reads as simply cut off.
    expect(wrapper?.className).toContain('overflow-x-auto');
    expect(wrapper?.className).toContain('scroll-x-visible');
  });

  it('wraps a long unbroken token in ORDINARY prose, not just in code and links', () => {
    // The earlier pass put `break-all` on inline code and on links and stopped
    // there, which left plain prose — what a USER's own message is entirely
    // made of — overflowing: `whitespace-pre-wrap` breaks at spaces, and a
    // 170-character token has none. Measured in a browser against a real
    // transcript: a 643px paragraph reporting a 1244px scrollWidth.
    //
    // Asserted on the ROOT because `overflow-wrap` is inherited: one
    // declaration there is what covers paragraphs, list items, headings,
    // quotes and table cells at once.
    const token = 'a'.repeat(170);
    const el = render(<MarkdownContent content={`prose ${token} end`} />);

    expect(el.firstElementChild?.className).toContain('break-words');
    expect(el.querySelector('p')?.textContent).toContain(token);
  });

  it('carries GFM column alignment through to th and td', () => {
    const el = render(<MarkdownContent content={ALIGNED_TABLE} />);
    const headers = [...el.querySelectorAll('th')];
    const cells = [...el.querySelectorAll('tbody td')];

    expect(headers.map((h) => h.textContent)).toEqual([
      'left',
      'middle',
      'right',
    ]);
    // `:---:` is centred and `---:` is right-aligned — the alignment the author
    // wrote, not the default the old renderer hardcoded for every column.
    expect(headers[1]?.className).toContain('text-center');
    expect(headers[2]?.className).toContain('text-right');
    expect(cells[1]?.className).toContain('text-center');
    expect(cells[2]?.className).toContain('text-right');
  });

  it('leaves an unaligned column left-aligned, as before', () => {
    const el = render(
      <MarkdownContent
        content={['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')}
      />,
    );
    for (const cell of el.querySelectorAll('th, td')) {
      expect(cell.className).toContain('text-left');
      expect(cell.className).not.toContain('text-center');
      expect(cell.className).not.toContain('text-right');
    }
  });
});

describe('MarkdownContent — a table whose header row is blank', () => {
  /**
   * The shape an agent actually emits when it wants a bare label/value table:
   * a header row of empty cells above the separator. remark-gfm parses this as
   * a real header, so the `th` fill paints a grey band over nothing.
   */
  const HEADERLESS_TABLE = [
    '|  |  |',
    '| --- | --- |',
    '| Fixed | 19 |',
    '| Refuted | F6 |',
  ].join('\n');

  it('renders no header row at all when every header cell is empty', () => {
    const el = render(<MarkdownContent content={HEADERLESS_TABLE} />);
    // The band the user reported IS the thead. Asserting on the element rather
    // than on its class is what makes this pin the behaviour: restyling `th`
    // and leaving the row in place would still show an empty bordered stripe.
    expect(el.querySelector('thead')).toBeNull();
    expect(el.querySelectorAll('th')).toHaveLength(0);
    // The data survives — this drops a blank header, not the table.
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(el.textContent).toContain('Fixed');
    expect(el.textContent).toContain('Refuted');
  });

  it('keeps a header that has text, fill and all', () => {
    const el = render(<MarkdownContent content={ALIGNED_TABLE} />);
    expect(el.querySelector('thead')).not.toBeNull();
    expect(el.querySelectorAll('th')).toHaveLength(3);
    // The fill is correct HERE — it is what separates a real header from the
    // body. Dropping it everywhere would have been the wrong fix.
    expect(el.querySelector('th')?.className).toContain('bg-muted/50');
  });

  it('keeps a header where only one cell has text', () => {
    // Partial headers are common in generated tables and are still headers;
    // the suppression is for a row that says nothing at all.
    const el = render(
      <MarkdownContent
        content={['| name |  |', '| --- | --- |', '| a | b |'].join('\n')}
      />,
    );
    expect(el.querySelector('thead')).not.toBeNull();
    expect(el.querySelector('thead')?.textContent).toContain('name');
  });

  it('KEEPS a header whose cells hold only an image', () => {
    // The suppression drops the whole `thead`, children included — so a
    // text-only test does not merely leave a band on screen, it deletes a
    // header somebody wrote. An image has no text node anywhere beneath it.
    const el = render(
      <MarkdownContent
        content={['| ![chart](a.png) |', '| --- |', '| 1 |'].join('\n')}
      />,
    );
    expect(el.querySelector('thead')).not.toBeNull();
    // The suppression reads the HAST node, where the cell still holds an `img`
    // — so the header survives whether or not the bytes ever arrive. What is
    // rendered in its place is `MarkdownImage`'s business: with no loader in
    // context a local reference stands in for itself rather than becoming a
    // broken box.
    expect(
      el.querySelectorAll('thead [data-slot="markdown-image-loading"]'),
    ).toHaveLength(1);
  });

  it('renders an inline data: image directly, with no loader involved', () => {
    // The one source the CSP already allows (`img-src 'self' data:`), so it
    // needs no daemon round trip — and it is what the fetched path turns every
    // other reference INTO, which makes this the arm that proves the tag is
    // reachable at all.
    const el = render(
      <MarkdownContent
        content={'![dot](data:image/png;base64,iVBORw0KGgo=)'}
      />,
    );
    const img = el.querySelector<HTMLImageElement>(
      '[data-slot="markdown-image"]',
    );
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(img?.getAttribute('alt')).toBe('dot');
  });

  it('treats a whitespace-only header as empty', () => {
    // `|   |   |` differs from `|  |  |` only in spaces, and a reader cannot
    // tell them apart — so neither may produce a band.
    const el = render(
      <MarkdownContent
        content={['|   |   |', '| --- | --- |', '| a | b |'].join('\n')}
      />,
    );
    expect(el.querySelector('thead')).toBeNull();
  });
});

describe('alignClass — the align-PROP fallback', () => {
  it('reads the style react-markdown actually produces today', () => {
    // Probe-verified: react-markdown translates the hast `align` property into
    // `style.textAlign` before the component sees it, so this is the live path
    // and both table tests above go through it.
    expect(alignClass({ textAlign: 'center' }, undefined)).toBe('text-center');
    expect(alignClass({ textAlign: 'right' }, undefined)).toBe('text-right');
    expect(alignClass(undefined, undefined)).toBe('text-left');
  });

  it('still reads a bare align PROP, for a version that stops translating', () => {
    // The branch exists for forward-compatibility, so nothing in the rendered
    // table can reach it — deleting the `?? align` fallback left all UI tests
    // green. A defensive branch worth keeping is worth a test that enters it
    // (.claude/rules/testing.md); this is that test.
    expect(alignClass(undefined, 'center')).toBe('text-center');
    expect(alignClass(undefined, 'right')).toBe('text-right');
    // Style wins when both are present — it is the current, translated form.
    expect(alignClass({ textAlign: 'right' }, 'center')).toBe('text-right');
  });
});

describe('MarkdownContent — links and the chat browser', () => {
  const link = (el: HTMLElement): HTMLAnchorElement => {
    const anchor = el.querySelector('a');
    if (anchor === null) {
      throw new Error('no link rendered');
    }
    return anchor;
  };
  const click = (anchor: HTMLAnchorElement, init: MouseEventInit): boolean => {
    let notPrevented = true;
    act(() => {
      notPrevented = anchor.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, ...init }),
      );
    });
    return notPrevented;
  };
  const withPane = (
    openUrl: (url: string) => void,
    isOpen: boolean,
  ): HTMLAnchorElement =>
    link(
      render(
        <BrowserPaneContext.Provider
          value={{ openPane: vi.fn(), openUrl, isOpen: () => isOpen }}>
          <MarkdownContent content="[docs](https://example.com/a)" />
        </BrowserPaneContext.Provider>,
      ),
    );

  it('opens a transcript link in the pane while the pane is open; ⌘-click opens the system browser', () => {
    const openUrl = vi.fn();
    const anchor = withPane(openUrl, true);

    expect(click(anchor, { button: 0 })).toBe(false);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/a');

    expect(click(anchor, { button: 0, metaKey: true })).toBe(true);
    expect(click(anchor, { button: 0, ctrlKey: true })).toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(anchor.target).toBe('_blank');
  });

  it('leaves a transcript link to the system browser while the pane is closed', () => {
    const openUrl = vi.fn();
    const anchor = withPane(openUrl, false);

    expect(click(anchor, { button: 0 })).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('leaves a link alone where the chat has no pane', () => {
    const anchor = link(
      render(<MarkdownContent content="[docs](https://example.com/a)" />),
    );
    expect(click(anchor, { button: 0 })).toBe(true);
  });

  it('leaves a non-web link to the system', () => {
    const openUrl = vi.fn();
    const anchor = link(
      render(
        <BrowserPaneContext.Provider
          value={{ openPane: vi.fn(), openUrl, isOpen: () => true }}>
          <MarkdownContent content="[mail](mailto:a@b.co)" />
        </BrowserPaneContext.Provider>,
      ),
    );
    click(anchor, { button: 0 });
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe('MarkdownContent — an image sits on a line of its own', () => {
  const PIXEL = '![a](data:image/png;base64,iVBORw0KGgo=)';
  const boxOf = (el: HTMLElement): Element => {
    const box = el.querySelector('[data-slot="zoomable-image"]');
    expect(box).not.toBeNull();
    return box!;
  };

  it('takes the whitespace off the text on either side of an image mid-sentence', () => {
    const el = render(
      <MarkdownContent
        content={`Подписано «Максимум». ${PIXEL} Next sentence.`}
      />,
    );
    const box = boxOf(el);
    expect(box.previousSibling?.textContent).toBe('Подписано «Максимум».');
    expect(box.nextSibling?.textContent).toBe('Next sentence.');
  });

  it('takes the line breaks off a soft break on either side of an image', () => {
    const el = render(<MarkdownContent content={`Text\n${PIXEL}\nMore`} />);
    const box = boxOf(el);
    expect(box.previousSibling?.textContent).toBe('Text');
    expect(box.nextSibling?.textContent).toBe('More');
  });

  it('keeps an image inside a tight list item, with its neighbours trimmed', () => {
    const el = render(
      <MarkdownContent content={`1. **Bold** text ${PIXEL} more`} />,
    );
    const box = boxOf(el);
    expect(box.closest('li')).not.toBeNull();
    expect(box.previousSibling?.textContent).toBe(' text');
    expect(box.nextSibling?.textContent).toBe('more');
  });

  it('keeps an image inside a loose list item, with its neighbours trimmed', () => {
    const el = render(
      <MarkdownContent
        content={`1. **Bold** text ${PIXEL} more\n\n2. second`}
      />,
    );
    const box = boxOf(el);
    expect(box.closest('li')).not.toBeNull();
    expect(box.nextSibling?.textContent).toBe('more');
  });

  it('leaves an image inside inline code as the literal text it is', () => {
    const el = render(<MarkdownContent content={'`![a](x.png)`'} />);
    expect(el.querySelector('[data-slot="zoomable-image"]')).toBeNull();
    expect(el.querySelector('code')?.textContent).toBe('![a](x.png)');
  });

  it('leaves an image inside a fenced block as the literal text it is', () => {
    const el = render(
      <MarkdownContent content={['```', '![a](x.png)', '```'].join('\n')} />,
    );
    expect(el.querySelector('[data-slot="zoomable-image"]')).toBeNull();
    expect(el.textContent).toContain('![a](x.png)');
  });
});
