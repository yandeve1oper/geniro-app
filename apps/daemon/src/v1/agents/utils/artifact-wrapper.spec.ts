// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARTIFACT_ESCAPE_SETTLE_MS,
  ARTIFACT_FRAME_SOURCE,
  ARTIFACT_PICTURE_SOURCE,
  ARTIFACT_WRAPPER_SCRIPT,
} from './artifact-page';

const PICTURE = 'data:image/png;base64,iVBORw0KGgo=';

let posted: Record<string, unknown>[];
let cleanups: (() => void)[];

function listenWithCleanup(): void {
  const add = window.addEventListener.bind(window);
  const docAdd = document.addEventListener.bind(document);
  vi.spyOn(window, 'addEventListener').mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      add(type, listener, options);
      cleanups.push(() => window.removeEventListener(type, listener, options));
    },
  );
  vi.spyOn(document, 'addEventListener').mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      docAdd(type, listener, options);
      cleanups.push(() =>
        document.removeEventListener(type, listener, options),
      );
    },
  );
}

function runWrapper(body: string): void {
  document.body.innerHTML = body;
  listenWithCleanup();
  new Function(ARTIFACT_WRAPPER_SCRIPT)();
  vi.restoreAllMocks();
  vi.spyOn(window.parent, 'postMessage').mockImplementation(
    (message: unknown) => {
      posted.push(message as Record<string, unknown>);
    },
  );
}

const ofType = (type: string): Record<string, unknown>[] =>
  posted.filter((message) => message.type === type);

function click(target: Element): MouseEvent {
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  target.dispatchEvent(event);
  return event;
}

function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  posted = [];
  cleanups = [];
});

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the frame wrapper — a link to one of the page’s own pictures', () => {
  it('asks the host to show the picture, with its alt text, instead of opening a link', () => {
    runWrapper(
      `<a href="${PICTURE}"><img id="shot" src="${PICTURE}" alt="Before"></a>`,
    );
    const event = click(document.getElementById('shot')!);

    expect(event.defaultPrevented).toBe(true);
    expect(ofType('picture')).toEqual([
      {
        source: ARTIFACT_FRAME_SOURCE,
        type: 'picture',
        src: PICTURE,
        alt: 'Before',
      },
    ]);
    expect(ofType('link')).toEqual([]);
  });

  it('sends an empty alt for a picture that has none', () => {
    runWrapper(`<a id="go" href="${PICTURE}">see the picture</a>`);
    click(document.getElementById('go')!);
    expect(ofType('picture')).toEqual([
      { source: ARTIFACT_FRAME_SOURCE, type: 'picture', src: PICTURE, alt: '' },
    ]);
  });

  it('still relays a web link as a link', () => {
    runWrapper('<a id="go" href="https://example.com/a">site</a>');
    click(document.getElementById('go')!);
    expect(ofType('link')).toEqual([
      {
        source: ARTIFACT_FRAME_SOURCE,
        type: 'link',
        href: 'https://example.com/a',
      },
    ]);
    expect(ofType('picture')).toEqual([]);
  });

  it.each([
    ['a data address that is no picture', 'data:text/html;base64,PHA+'],
    [
      'an svg, which the store never inlines',
      'data:image/svg+xml;base64,PHN2Zz4=',
    ],
    ['a local path the runtime did not repoint', '/tmp/shots/a.png'],
  ])('relays %s as a link, which the host refuses', (_, href) => {
    runWrapper(`<a id="go" href="${href}"><img src="${PICTURE}"></a>`);
    click(document.getElementById('go')!);
    expect(ofType('picture')).toEqual([]);
    expect(ofType('link')).toHaveLength(1);
  });

  it('matches exactly what the host accepts', () => {
    const picture = new RegExp(ARTIFACT_PICTURE_SOURCE);
    expect(picture.test(PICTURE)).toBe(true);
    expect(picture.test(`${PICTURE}"onerror=x`)).toBe(false);
  });
});

describe('the frame wrapper — an Escape pressed inside the frame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('hands the host an Escape the page did not act on', async () => {
    runWrapper('<p>nothing listens</p>');
    pressEscape();
    await vi.advanceTimersByTimeAsync(ARTIFACT_ESCAPE_SETTLE_MS);
    expect(ofType('escape')).toEqual([
      { source: ARTIFACT_FRAME_SOURCE, type: 'escape' },
    ]);
  });

  it('keeps an Escape the page used to close its own lightbox', async () => {
    runWrapper('<div id="zoom" class="zoom on"></div>');
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        document.getElementById('zoom')!.classList.remove('on');
      }
    };
    document.addEventListener('keydown', close);
    cleanups.push(() => document.removeEventListener('keydown', close));

    pressEscape();
    await vi.advanceTimersByTimeAsync(ARTIFACT_ESCAPE_SETTLE_MS);
    expect(ofType('escape')).toEqual([]);
  });

  it('hands over an Escape whose page handler changed nothing, its lightbox already closed', async () => {
    runWrapper('<div id="zoom" class="zoom"></div>');
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        document.getElementById('zoom')!.classList.remove('on');
      }
    };
    document.addEventListener('keydown', close);
    cleanups.push(() => document.removeEventListener('keydown', close));

    pressEscape();
    await vi.advanceTimersByTimeAsync(ARTIFACT_ESCAPE_SETTLE_MS);
    expect(ofType('escape')).toEqual([
      { source: ARTIFACT_FRAME_SOURCE, type: 'escape' },
    ]);
  });

  it('keeps an Escape the page answered by removing an element', async () => {
    runWrapper('<div id="zoom"></div>');
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        document.getElementById('zoom')?.remove();
      }
    };
    document.addEventListener('keydown', close);
    cleanups.push(() => document.removeEventListener('keydown', close));

    pressEscape();
    await vi.advanceTimersByTimeAsync(ARTIFACT_ESCAPE_SETTLE_MS);
    expect(ofType('escape')).toEqual([]);
  });

  it('keeps an Escape the page cancelled', async () => {
    runWrapper('<p>a field that owns Escape</p>');
    const own = (event: KeyboardEvent): void => event.preventDefault();
    document.addEventListener('keydown', own);
    cleanups.push(() => document.removeEventListener('keydown', own));

    pressEscape();
    await vi.advanceTimersByTimeAsync(ARTIFACT_ESCAPE_SETTLE_MS);
    expect(ofType('escape')).toEqual([]);
  });

  it('waits for the page before handing it over', async () => {
    runWrapper('<p>nothing listens</p>');
    pressEscape();
    await vi.advanceTimersByTimeAsync(ARTIFACT_ESCAPE_SETTLE_MS - 1);
    expect(ofType('escape')).toEqual([]);
  });

  it('hands over no other key', async () => {
    runWrapper('<p>nothing listens</p>');
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(ARTIFACT_ESCAPE_SETTLE_MS);
    expect(ofType('escape')).toEqual([]);
  });
});
