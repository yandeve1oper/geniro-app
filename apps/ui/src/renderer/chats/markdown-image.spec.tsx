// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import {
  type LocalImageLoader,
  LocalImageLoaderContext,
} from './local-image-loader';
import { MarkdownContent } from './markdown-content';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// A markdown image renders through the image viewer, whose zoom layer needs one.
stubResizeObserver();

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Render markdown with a loader in context and let its promise settle. */
async function render(
  content: string,
  load: LocalImageLoader | null,
): Promise<void> {
  await act(async () => {
    root.render(
      <LocalImageLoaderContext.Provider value={load}>
        <MarkdownContent content={content} />
      </LocalImageLoaderContext.Provider>,
    );
  });
}

const src = (): string | null =>
  container
    .querySelector('[data-slot="markdown-image"]')
    ?.getAttribute('src') ?? null;
const unavailable = (): string | null =>
  container.querySelector('[data-slot="markdown-image-unavailable"]')
    ?.textContent ?? null;

describe('an image an agent referenced from its own markdown', () => {
  it('renders an ABSOLUTE local path, which never used to appear at all', async () => {
    // The reported defect — "i dont see images". Two independent walls: the
    // renderer's CSP is `img-src 'self' data:`, so a `file:` source is refused
    // outright, and there is no other way for a plain `<img>` to reach a local
    // file. Measured in the author's own history, the references really written
    // were `/tmp/shots/02-transcript.png` and bare names like `a.png`.
    const load = vi.fn(async () => 'data:image/png;base64,AAA');

    await render('![shot](/tmp/shots/02-transcript.png)', load);

    expect(load).toHaveBeenCalledWith('/tmp/shots/02-transcript.png');
    expect(src()).toBe('data:image/png;base64,AAA');
  });

  it('asks for a RELATIVE reference exactly as written, for the daemon to resolve', async () => {
    // `a.png` resolves against the app's own origin in a browser, which has
    // nothing to do with the folder the agent was working in. Only the daemon
    // knows the run's cwd, so the reference must travel unchanged — a renderer
    // that "helpfully" absolutized it would have to guess that base.
    const load = vi.fn(async () => 'data:image/png;base64,BBB');

    await render('![chart](a.png)', load);

    expect(load).toHaveBeenCalledWith('a.png');
    expect(src()).toBe('data:image/png;base64,BBB');
  });

  it('renders a path with a SPACE in it, which used to reach the screen as raw markdown', async () => {
    // Every task worktree and attachment lives under `~/Library/Application
    // Support/`, and CommonMark allows no space in a bare destination — so the
    // whole reference was left as literal text and nothing was ever loaded.
    const load = vi.fn(async () => 'data:image/png;base64,SPC');

    await render('![shot](/Users/me/Library/Application Support/x.png)', load);

    expect(load).toHaveBeenCalledWith(
      '/Users/me/Library/Application Support/x.png',
    );
    expect(src()).toBe('data:image/png;base64,SPC');
  });

  it('asks for a percent-encoded path by the name the file really has', async () => {
    // The pipeline hands `src` over percent-encoded, and the daemon reads the
    // path it is given literally — `%20` names no file.
    const load = vi.fn(async () => 'data:image/png;base64,PCT');

    await render(
      '![shot](/Users/me/Library/Application%20Support/x.png)',
      load,
    );

    expect(load).toHaveBeenCalledWith(
      '/Users/me/Library/Application Support/x.png',
    );
  });

  it('does NOT fetch a remote image, and says so', async () => {
    // Local-first: this app makes no outbound requests, and an agent-authored
    // `![](https://…)` is exactly the beacon `img-src 'self' data:` exists to
    // stop. The point is that it is REFUSED OUT LOUD — silently dropping it
    // leaves the same "i don't see images" with no explanation.
    const load = vi.fn(async () => 'data:image/png;base64,CCC');

    await render('![tracker](https://example.com/pixel.png)', load);

    expect(load).not.toHaveBeenCalled();
    expect(src()).toBeNull();
    expect(unavailable()).toContain('remote images are not loaded');
    // …naming the reference, so the user can see what was skipped.
    expect(unavailable()).toContain('https://example.com/pixel.png');
  });

  it('shows the path when the daemon cannot read it', async () => {
    // "could not read /tmp/shots/x.png" is a fact the user can act on. A
    // broken-image box is the bug being reported a second time.
    const load = vi.fn(async () => {
      throw new Error('no file at /tmp/shots/gone.png');
    });

    await render('![gone](/tmp/shots/gone.png)', load);

    expect(src()).toBeNull();
    expect(unavailable()).toContain('/tmp/shots/gone.png');
  });

  it('renders a data: URL without going near the loader', async () => {
    // The one scheme the CSP already allows, and what every fetched reference
    // is turned INTO — so a round trip for it would be pure cost.
    const load = vi.fn(async () => 'data:image/png;base64,NOPE');

    await render('![dot](data:image/gif;base64,R0lGOD)', load);

    expect(load).not.toHaveBeenCalled();
    expect(src()).toBe('data:image/gif;base64,R0lGOD');
  });

  it('falls back to the reference itself with no loader in context', async () => {
    // Outside a provider — a transcript rendered somewhere with no run behind
    // it. It must not throw, and it must not draw a broken box.
    await render('![chart](a.png)', null);

    expect(src()).toBeNull();
    expect(container.textContent).toContain('chart');
  });

  it('opens to full size when pressed, capped at 24rem in the flow', async () => {
    // REPORTED as "all images should be clickable". In the transcript an image
    // is capped so it cannot take over the thread, which is exactly why there
    // has to be a way to see the rest of it.
    const load = vi.fn(async () => 'data:image/png;base64,AAA');

    await render('![shot](/tmp/shots/02-transcript.png)', load);

    const img = container.querySelector('[data-slot="markdown-image"]')!;
    expect(img.className).toContain('max-h-96');
    const opener = img.closest('[data-slot="zoomable-image"]');
    expect(opener).not.toBeNull();

    act(() => {
      opener!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const full = document.body.querySelector(
      '[data-slot="image-viewer-image"]',
    );
    expect(full?.getAttribute('src')).toBe('data:image/png;base64,AAA');
  });

  it('heads the viewer with the reference, never the base64 it resolved to', async () => {
    // An unlabelled image is the common case — an agent writing `![](x.png)`
    // — and by the time it is on screen its `src` is a data URL. Without the
    // reference the header would carry that string, or nothing.
    const load = vi.fn(async () => 'data:image/png;base64,AAA');

    await render('![](/tmp/shots/02-transcript.png)', load);

    // Not merely the pre-load placeholder still being on screen — that stands
    // in with the reference as its text, and would make the assertion below
    // true with no viewer at all.
    expect(document.body.textContent).not.toContain('/tmp/shots');

    act(() => {
      container
        .querySelector('[data-slot="zoomable-image"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('/tmp/shots/02-transcript.png');
  });
});

describe('a chat image takes a line of its own', () => {
  // jsdom computes no layout, so the classes that decide whether a box sits in
  // the text line or on its own line are the fact pinned here.
  const classTokens = (selector: string): string[] =>
    (container.querySelector(selector)?.getAttribute('class') ?? '').split(
      /\s+/,
    );

  it('draws a loaded image as a block box, never an inline one', async () => {
    const load = vi.fn(async () => 'data:image/png;base64,AAA');

    await render('![shot](/tmp/shots/02-transcript.png)', load);

    const box = classTokens('[data-slot="zoomable-image"]');
    expect(box).toContain('block');
    expect(box).not.toContain('inline-block');
    expect(box).not.toContain('align-middle');
  });

  it('keeps the loading placeholder a block box, so nothing jumps when the bytes land', async () => {
    const load = vi.fn(() => new Promise<string>(() => {}));

    await render('![shot](/tmp/shots/02-transcript.png)', load);

    const placeholder = classTokens('[data-slot="markdown-image-loading"]');
    expect(placeholder).toContain('block');
    expect(placeholder).not.toContain('inline-block');
  });

  it('keeps a refused reference a block box', async () => {
    await render('![tracker](https://example.com/pixel.png)', null);

    const notice = classTokens('[data-slot="markdown-image-unavailable"]');
    expect(notice).toContain('block');
    expect(notice).not.toContain('inline-block');
  });

  it('keeps a read that failed a block box', async () => {
    const load = vi.fn(async () => {
      throw new Error('no file at /tmp/shots/gone.png');
    });

    await render('![gone](/tmp/shots/gone.png)', load);

    const notice = classTokens('[data-slot="markdown-image-unavailable"]');
    expect(notice).toContain('block');
    expect(notice).not.toContain('inline-block');
  });

  it('keeps a lone image at its size caps', async () => {
    const load = vi.fn(async () => 'data:image/png;base64,AAA');

    await render('![shot](/tmp/shots/02-transcript.png)', load);

    expect(classTokens('[data-slot="markdown-image"]')).toEqual(
      expect.arrayContaining([
        'max-h-96',
        'max-w-full',
        'object-contain',
        'rounded-lg',
      ]),
    );
  });
});
