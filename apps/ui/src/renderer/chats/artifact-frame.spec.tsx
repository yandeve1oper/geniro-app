// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import { pushEscapeLayer } from '../components/ui/escape-layers';
import { ArtifactFrame } from './artifact-frame';
import {
  BrowserPaneContext,
  type BrowserPaneControls,
} from './browser/browser-pane-context';
import {
  ArtifactUrlContext,
  type PublishedArtifact,
} from './published-artifact';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

stubResizeObserver();

const ARTIFACT: PublishedArtifact = {
  artifactId: 'plan',
  version: 2,
  title: 'Migration plan',
  summary: null,
  key: 'k'.repeat(64),
};

const URL = 'http://127.0.0.1:47615/v1/artifacts/run-1/plan?key=kkk&v=2';

let container: HTMLDivElement;
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

async function render(
  artifact: PublishedArtifact = ARTIFACT,
  url: string | null = URL,
  pane: BrowserPaneControls | null = null,
): Promise<void> {
  await act(async () => {
    root.render(
      <ArtifactUrlContext.Provider value={url === null ? null : () => url}>
        <BrowserPaneContext.Provider value={pane}>
          <ArtifactFrame artifact={artifact} />
        </BrowserPaneContext.Provider>
      </ArtifactUrlContext.Provider>,
    );
  });
}

const frame = (): HTMLIFrameElement | null => container.querySelector('iframe');

describe('ArtifactFrame', () => {
  it('frames the page the url builder names', async () => {
    await render();
    expect(frame()?.getAttribute('src')).toBe(URL);
    expect(frame()?.getAttribute('title')).toBe('Migration plan');
  });

  it('sandboxes with allow-scripts alone, and grants NOTHING else', async () => {
    // Exact equality, so ANY added flag reddens this — `allow-same-origin`
    // above all, since a frame granted it alongside `allow-scripts` can reach
    // its own `sandbox` attribute and remove it, and would then sit in this
    // app's origin beside the loopback token. allow-popups is NOT granted: a
    // link reaches the browser as a message to the host, so the page never
    // opens a window. Also refused: allow-popups-to-escape-sandbox,
    // allow-top-navigation(-by-user-activation), allow-modals, allow-downloads,
    // allow-forms, allow-pointer-lock, allow-presentation.
    await render();
    expect(frame()?.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('sends no referrer to the page', async () => {
    await render();
    expect(frame()?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('says so plainly when there is no way to address the page', async () => {
    // Outside a provider the builder is null. A frame pointed at a URL the
    // component had to invent would be worse than a sentence.
    await render(ARTIFACT, null);
    expect(frame()).toBeNull();
    expect(container.textContent).toContain('cannot be opened');
  });

  it('reloads on a republish rather than reusing the element', async () => {
    // Keyed by version: React would otherwise keep the same iframe, which goes
    // on showing the document it has already loaded.
    await render();
    const first = frame();
    expect(first).not.toBeNull();

    await render({ ...ARTIFACT, version: 3 }, 'http://127.0.0.1:47615/a?v=3');

    expect(frame()).not.toBe(first);
    expect(frame()?.getAttribute('src')).toBe('http://127.0.0.1:47615/a?v=3');
  });

  it('grows to the height its page reports', async () => {
    await render();
    const target = frame();
    expect(target).not.toBeNull();
    // The real page posts this from inside the sandbox; jsdom gives the frame
    // a contentWindow, which is what the listener filters on.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'geniro-artifact', type: 'height', height: 400 },
          source: target!.contentWindow,
        }),
      );
    });
    expect(frame()?.style.height).toBe('400px');
  });

  it('ignores a height from anything that is not its own frame', async () => {
    // Another artifact's frame, or any other embedded document, must not be
    // able to resize this one.
    await render();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'geniro-artifact', type: 'height', height: 999 },
          source: window,
        }),
      );
    });
    expect(frame()?.style.height).not.toBe('999px');
  });

  it('ignores a message that is not tagged as an artifact’s', async () => {
    await render();
    const target = frame();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'something-else', type: 'height', height: 999 },
          source: target!.contentWindow,
        }),
      );
    });
    expect(frame()?.style.height).not.toBe('999px');
  });

  it('does not collapse on a page that measures itself as nothing', async () => {
    // Zero is a page mid-layout, not a page of no height — collapsing there
    // makes the artifact vanish.
    await render();
    const target = frame();
    const before = frame()?.style.height;
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'geniro-artifact', type: 'height', height: 0 },
          source: target!.contentWindow,
        }),
      );
    });
    expect(frame()?.style.height).toBe(before);
  });

  it('caps its own growth so one artifact cannot own the transcript', async () => {
    await render();
    const target = frame();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'geniro-artifact', type: 'height', height: 99_000 },
          source: target!.contentWindow,
        }),
      );
    });
    expect(frame()?.style.height).toBe('520px');
  });
});

describe('ArtifactFrame — a link the page asks the host to open', () => {
  async function postLink(
    href: unknown,
    source: MessageEventSource | null = frame()?.contentWindow ?? null,
  ): Promise<void> {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'geniro-artifact', type: 'link', href },
          source,
        }),
      );
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a web link in the browser at once, with no confirmation to press', async () => {
    await render();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await postLink('https://example.com/a');
    expect(open).toHaveBeenCalledWith(
      'https://example.com/a',
      '_blank',
      'noopener',
    );
    // Nothing is drawn above the frame asking first.
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('would like to open');
  });

  it('opens a mail link the same way', async () => {
    await render();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await postLink('mailto:someone@example.com');
    expect(open).toHaveBeenCalledWith(
      'mailto:someone@example.com',
      '_blank',
      'noopener',
    );
  });

  it('opens the address as the URL parser reads it', async () => {
    await render();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await postLink('HTTPS://Example.com/a');
    expect(open).toHaveBeenCalledWith(
      'https://example.com/a',
      '_blank',
      'noopener',
    );
  });

  it('opens nothing for a scheme the page may not open', async () => {
    await render();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await postLink('javascript:alert(1)');
    await postLink('file:///etc/hosts');
    await postLink('other.html');
    expect(open).not.toHaveBeenCalled();
  });

  it('hands a web link to the chat browser while its pane is open', async () => {
    const openUrl = vi.fn();
    await render(ARTIFACT, URL, {
      openPane: vi.fn(),
      openUrl,
      isOpen: () => true,
    });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await postLink('https://example.com/a');
    expect(openUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/a');
    expect(open).not.toHaveBeenCalled();
  });

  it('opens a web link in the system browser while the chat pane is closed', async () => {
    const openUrl = vi.fn();
    await render(ARTIFACT, URL, {
      openPane: vi.fn(),
      openUrl,
      isOpen: () => false,
    });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await postLink('https://example.com/a');
    expect(open).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/a',
      '_blank',
      'noopener',
    );
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('keeps a mail link in the system browser even with the chat pane open', async () => {
    const openUrl = vi.fn();
    await render(ARTIFACT, URL, {
      openPane: vi.fn(),
      openUrl,
      isOpen: () => true,
    });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await postLink('mailto:someone@example.com');
    expect(open).toHaveBeenCalledExactlyOnceWith(
      'mailto:someone@example.com',
      '_blank',
      'noopener',
    );
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('ignores a link posted from anything that is not its own frame', async () => {
    await render();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await postLink('https://example.com/a', window);
    expect(open).not.toHaveBeenCalled();
  });
});

async function post(
  data: Record<string, unknown>,
  source: MessageEventSource | null = frame()?.contentWindow ?? null,
): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'geniro-artifact', ...data },
        source,
      }),
    );
  });
}

function focusFrame(): void {
  act(() => {
    frame()?.focus();
  });
}

const viewer = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[role="dialog"]');

describe('ArtifactFrame — a picture the page asks the host to show', () => {
  const PICTURE = 'data:image/png;base64,iVBORw0KGgo=';

  it('opens the picture in the image viewer, named by its alt text', async () => {
    await render();
    focusFrame();
    await post({ type: 'picture', src: PICTURE, alt: 'Before' });
    expect(viewer()?.querySelector('img')?.getAttribute('src')).toBe(PICTURE);
    expect(viewer()?.textContent).toContain('Before');
  });

  it('names the page when the picture has no alt text', async () => {
    await render();
    focusFrame();
    await post({ type: 'picture', src: PICTURE });
    expect(viewer()?.textContent).toContain('Migration plan');
  });

  it('closes the viewer on Escape, which this document sees once the viewer has focus', async () => {
    await render();
    focusFrame();
    await post({ type: 'picture', src: PICTURE, alt: 'Before' });
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(viewer()).toBeNull();
  });

  it('shows nothing for a source that is not one of the page’s own pictures', async () => {
    await render();
    focusFrame();
    await post({ type: 'picture', src: 'https://example.com/a.png' });
    await post({ type: 'picture', src: 'data:text/html;base64,PHA+' });
    await post({ type: 'picture', src: 'data:image/svg+xml;base64,PHN2Zz4=' });
    await post({ type: 'picture', src: 42 });
    expect(viewer()).toBeNull();
  });

  it('ignores a picture posted from anything that is not its own frame', async () => {
    await render();
    focusFrame();
    await post({ type: 'picture', src: PICTURE }, window);
    expect(viewer()).toBeNull();
  });

  it('ignores a picture its own frame posts while the user is not in that frame', async () => {
    await render();
    await post({ type: 'picture', src: PICTURE, alt: 'Before' });
    expect(viewer()).toBeNull();
  });
});

describe('ArtifactFrame — an Escape the page hands over', () => {
  let close: ReturnType<typeof vi.fn<() => void>>;
  let release: () => void;

  beforeEach(() => {
    close = vi.fn<() => void>();
    release = pushEscapeLayer({ close });
  });

  afterEach(() => {
    release();
  });

  it('closes the overlay on top, as an Escape pressed in this document would', async () => {
    await render();
    focusFrame();
    await post({ type: 'escape' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('ignores an Escape posted from anything that is not its own frame', async () => {
    await render();
    focusFrame();
    await post({ type: 'escape' }, window);
    expect(close).not.toHaveBeenCalled();
  });

  it('ignores an Escape its own frame posts while the user is not in that frame', async () => {
    await render();
    await post({ type: 'escape' });
    expect(close).not.toHaveBeenCalled();
  });
});
