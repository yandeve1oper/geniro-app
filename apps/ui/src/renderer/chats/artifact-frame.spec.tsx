// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import { pushEscapeLayer } from '../components/ui/escape-layers';
import {
  ANSWERS_RETRY_MS,
  ANSWERS_SAVE_DELAY_MS,
  ArtifactFrame,
  MAX_ANSWER_NAME,
  OPEN_PATH_GAP_MS,
} from './artifact-frame';
import {
  BrowserPaneContext,
  type BrowserPaneControls,
} from './browser/browser-pane-context';
import {
  ArtifactAnswersContext,
  type ArtifactAnswersStore,
  artifactAnswersStore,
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

describe('ArtifactFrame — a folder button on the page', () => {
  let openArtifactPath: ReturnType<
    typeof vi.fn<(path: string) => Promise<unknown>>
  >;
  let activation: { isActive: boolean };

  beforeEach(() => {
    openArtifactPath = vi.fn<(path: string) => Promise<unknown>>(() =>
      Promise.resolve({ shown: 'opened' }),
    );
    (window as unknown as { geniro: unknown }).geniro = { openArtifactPath };
    activation = { isActive: true };
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      get: () => activation,
    });
  });

  afterEach(() => {
    delete (window as unknown as { geniro?: unknown }).geniro;
    Reflect.deleteProperty(navigator, 'userActivation');
  });

  it('asks main to show the folder the user just clicked inside the page', async () => {
    await render();
    focusFrame();
    await post({ type: 'open-path', path: '/Users/me/reports' });
    expect(openArtifactPath).toHaveBeenCalledWith('/Users/me/reports');
  });

  it('shows nothing the page asks for without a fresh click, though it holds focus', async () => {
    activation.isActive = false;
    await render();
    focusFrame();
    await post({ type: 'open-path', path: '/Users/me/reports' });
    expect(openArtifactPath).not.toHaveBeenCalled();
  });

  it('acts on one folder while a click stays fresh, so one click cannot open a burst of them', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await render();
    focusFrame();
    await post({ type: 'open-path', path: '/a' });
    now.mockReturnValue(1_000_000 + OPEN_PATH_GAP_MS - 1);
    await post({ type: 'open-path', path: '/b' });
    now.mockReturnValue(1_000_000 + OPEN_PATH_GAP_MS);
    await post({ type: 'open-path', path: '/c' });
    expect(openArtifactPath.mock.calls).toEqual([['/a'], ['/c']]);
  });

  it('shows nothing its own frame asks while the user is not in that frame', async () => {
    await render();
    await post({ type: 'open-path', path: '/Users/me/reports' });
    expect(openArtifactPath).not.toHaveBeenCalled();
  });

  it('shows nothing for a path posted from anything that is not its own frame', async () => {
    await render();
    focusFrame();
    await post({ type: 'open-path', path: '/Users/me/reports' }, window);
    expect(openArtifactPath).not.toHaveBeenCalled();
  });

  it('shows nothing for a relative path, a NUL or something that is not a path', async () => {
    await render();
    focusFrame();
    await post({ type: 'open-path', path: 'reports' });
    await post({ type: 'open-path', path: '/tmp/a\u0000b' });
    await post({ type: 'open-path', path: 42 });
    expect(openArtifactPath).not.toHaveBeenCalled();
  });

  it('says under the page why a folder could not be shown, in its own words, never the page’s', async () => {
    openArtifactPath.mockResolvedValueOnce({
      shown: null,
      reason: 'nothing is at that path',
    });
    await render();
    focusFrame();
    await post({ type: 'open-path', path: '/Users/me/Click here to update' });
    expect(container.textContent).toContain(
      'The page’s folder could not be shown: nothing is at that path'.replace(
        '’',
        "'",
      ),
    );
    expect(container.textContent).not.toContain('Click here to update');
  });
});

describe('ArtifactFrame — the page answers', () => {
  let kept: Record<string, unknown>;
  let chats: {
    readArtifactAnswers: ReturnType<typeof vi.fn>;
    saveArtifactAnswers: ReturnType<typeof vi.fn>;
  };
  let store: ArtifactAnswersStore;

  beforeEach(() => {
    vi.useFakeTimers();
    kept = { 'call-1': 'agree' };
    chats = {
      readArtifactAnswers: vi.fn(() =>
        Promise.resolve({ values: { ...kept }, updatedAt: null }),
      ),
      saveArtifactAnswers: vi.fn(
        ({
          saveArtifactAnswersDto,
        }: {
          saveArtifactAnswersDto: { changes: Record<string, unknown> };
        }) => {
          for (const [name, value] of Object.entries(
            saveArtifactAnswersDto.changes,
          )) {
            if (value === null) {
              delete kept[name];
            } else {
              kept[name] = value;
            }
          }
          return Promise.resolve({ values: { ...kept }, updatedAt: 'now' });
        },
      ),
    };
    store = artifactAnswersStore(
      chats as unknown as Parameters<typeof artifactAnswersStore>[0],
      'run-1',
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function renderWithAnswers(frames = 1): Promise<void> {
    await act(async () => {
      root.render(
        <ArtifactUrlContext.Provider value={() => URL}>
          <ArtifactAnswersContext.Provider value={store}>
            {Array.from({ length: frames }, (_, i) => (
              <ArtifactFrame key={i} artifact={ARTIFACT} />
            ))}
          </ArtifactAnswersContext.Provider>
        </ArtifactUrlContext.Provider>,
      );
    });
  }

  const frames = (): HTMLIFrameElement[] => [
    ...container.querySelectorAll('iframe'),
  ];

  async function settle(ms = ANSWERS_SAVE_DELAY_MS): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('sends the kept answers into the page once it announces itself', async () => {
    await renderWithAnswers();
    const sent = vi.spyOn(frame()!.contentWindow!, 'postMessage');

    await post({ type: 'ready' });
    await settle(0);

    expect(chats.readArtifactAnswers).toHaveBeenCalledWith({
      runId: 'run-1',
      artifactId: 'plan',
    });
    expect(sent).toHaveBeenCalledWith(
      {
        source: 'geniro-host',
        type: 'answers',
        values: { 'call-1': 'agree' },
        confirmed: null,
      },
      '*',
    );
  });

  it('holds answer names to the daemon’s own limit', () => {
    const types = readFileSync(
      join(__dirname, '../../../../daemon/src/v1/agents/chat.types.ts'),
      'utf8',
    );
    expect(
      Number(
        /export const MAX_ARTIFACT_ANSWER_NAME_LENGTH = (\d+);/.exec(
          types,
        )?.[1],
      ),
    ).toBe(MAX_ANSWER_NAME);
  });

  it('saves only the answers the page changed, once they settle, so a pick never replaces the rest', async () => {
    await renderWithAnswers();
    focusFrame();

    await post({ type: 'answer', name: 'call-2', value: 'agree', seq: 1 });
    await post({ type: 'answer', name: 'call-2', value: 'disagree', seq: 2 });
    await post({ type: 'answer', name: 'note', value: null, seq: 3 });
    expect(chats.saveArtifactAnswers).not.toHaveBeenCalled();
    await settle();

    expect(chats.saveArtifactAnswers.mock.calls).toEqual([
      [
        {
          runId: 'run-1',
          artifactId: 'plan',
          saveArtifactAnswersDto: {
            changes: { 'call-2': 'disagree', note: null },
          },
        },
      ],
    ]);
    expect(kept).toEqual({ 'call-1': 'agree', 'call-2': 'disagree' });
  });

  it('hands the saving page the merged set with the save counts it confirmed, so its own picks give way to newer ones', async () => {
    await renderWithAnswers();
    const sent = vi.spyOn(frame()!.contentWindow!, 'postMessage');
    focusFrame();

    await post({ type: 'answer', name: 'call-2', value: 'disagree', seq: 4 });
    await settle();

    expect(sent).toHaveBeenCalledWith(
      {
        source: 'geniro-host',
        type: 'answers',
        values: { 'call-1': 'agree', 'call-2': 'disagree' },
        confirmed: { 'call-2': 4 },
      },
      '*',
    );
  });

  it('sends a refused batch again, with what changed since, and says so under the page once it gives up', async () => {
    chats.saveArtifactAnswers.mockRejectedValueOnce(new Error('daemon gone'));
    await renderWithAnswers();
    focusFrame();

    await post({ type: 'answer', name: 'call-2', value: 'disagree', seq: 1 });
    await settle();
    await post({ type: 'answer', name: 'why', value: 'cost', seq: 2 });
    await settle(ANSWERS_RETRY_MS);

    expect(chats.saveArtifactAnswers.mock.calls.at(-1)?.[0]).toEqual({
      runId: 'run-1',
      artifactId: 'plan',
      saveArtifactAnswersDto: {
        changes: { 'call-2': 'disagree', why: 'cost' },
      },
    });
    expect(kept).toEqual({
      'call-1': 'agree',
      'call-2': 'disagree',
      why: 'cost',
    });

    chats.saveArtifactAnswers.mockRejectedValue(new Error('daemon gone'));
    await post({ type: 'answer', name: 'x', value: 1, seq: 3 });
    await settle();
    await settle(ANSWERS_RETRY_MS);
    await settle(ANSWERS_RETRY_MS);
    expect(container.textContent).toContain(
      'Your picks on this page were not saved: daemon gone',
    );
  });

  it('hands what one frame of a page saved to its other frames, and not back to the one that saved', async () => {
    await renderWithAnswers(2);
    const [saving, other] = frames();
    const toSaving = vi.spyOn(saving!.contentWindow!, 'postMessage');
    const toOther = vi.spyOn(other!.contentWindow!, 'postMessage');
    act(() => {
      saving!.focus();
    });

    await post(
      { type: 'answer', name: 'call-2', value: 'disagree' },
      saving!.contentWindow,
    );
    await settle();

    expect(toOther).toHaveBeenCalledWith(
      {
        source: 'geniro-host',
        type: 'answers',
        values: { 'call-1': 'agree', 'call-2': 'disagree' },
        confirmed: null,
      },
      '*',
    );
    expect(
      toSaving.mock.calls
        .map(([message]) => message as { type?: string; confirmed?: unknown })
        .filter((message) => message.type === 'answers')
        .map((message) => message.confirmed),
    ).toEqual([{}]);
  });

  it('keeps nothing its own frame sends while the user is not in it, or that names no answer', async () => {
    await renderWithAnswers();
    await post({ type: 'answer', name: 'forged', value: true });
    focusFrame();
    await post({ type: 'answer', name: '', value: true });
    await post({
      type: 'answer',
      name: 'x'.repeat(MAX_ANSWER_NAME + 1),
      value: true,
    });
    await post({ type: 'answer', name: '__proto__', value: true });
    await post({ type: 'answer', name: 'other', value: true }, window);
    await settle();

    expect(chats.saveArtifactAnswers).not.toHaveBeenCalled();
  });

  it('keeps answers still settling when the frame goes away', async () => {
    await renderWithAnswers();
    focusFrame();
    await post({ type: 'answer', name: 'why', value: 'fine' });

    act(() => root.render(<p />));

    expect(chats.saveArtifactAnswers).toHaveBeenCalledTimes(1);
    expect(kept).toEqual({ 'call-1': 'agree', why: 'fine' });
  });
});
