// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';

// The shell's heavy children are not what this spec is about. Chats is a
// stand-in whose buttons fire the callbacks the shell hands it, so the shell's
// own reaction to them is what a spec observes.
const chatsMock = vi.hoisted(() => ({
  waits: [] as readonly WaitReading[],
  opened: [] as string[],
  /** The thread the stand-in's "open by hand" button opens, as a sidebar click would. */
  byHand: '',
}));
vi.mock('./chats/Chats', async () => {
  const { useEffect } = await import('react');
  return {
    Chats: (props: {
      phoneHomeSignal?: number;
      onPhoneDetailChange?: (detail: boolean) => void;
      onOpenSettings?: (section: 'fast-actions') => void;
      openRunId?: string | null;
      onRunOpened?: () => void;
      onActiveRunChange?: (runId: string | null) => void;
      onWaitingChange?: (readings: readonly WaitReading[]) => void;
      transcriptPageCap?: number;
    }) => {
      // Honours a thread request the way the real screen does: opens it,
      // reports it open, and clears the request.
      const { openRunId, onActiveRunChange, onRunOpened } = props;
      useEffect(() => {
        if (openRunId) {
          chatsMock.opened.push(openRunId);
          onActiveRunChange?.(openRunId);
          onRunOpened?.();
        }
      }, [openRunId, onActiveRunChange, onRunOpened]);
      return (
        <>
          <output data-slot="home-signal">{props.phoneHomeSignal ?? 0}</output>
          <output data-slot="page-cap">
            {props.transcriptPageCap ?? 'none'}
          </output>
          <button
            type="button"
            onClick={() => props.onPhoneDetailChange?.(true)}>
            open a thread
          </button>
          <button
            type="button"
            onClick={() => props.onPhoneDetailChange?.(false)}>
            back to the list
          </button>
          <button
            type="button"
            onClick={() => props.onOpenSettings?.('fast-actions')}>
            manage fast actions
          </button>
          <button
            type="button"
            onClick={() => props.onWaitingChange?.(chatsMock.waits)}>
            report waits
          </button>
          <button
            type="button"
            onClick={() => props.onActiveRunChange?.(chatsMock.byHand)}>
            open by hand
          </button>
        </>
      );
    },
  };
});
vi.mock('./daemon-client', () => ({
  DaemonClient: class {
    connect(): void {}
    close(): void {}
    // The Stats page subscribes on mount, and the tab-bar test opens it.
    onUsageRecorded(): () => void {
      return () => {};
    }
    onProjectsChanged(): () => void {
      return () => {};
    }
    onKnowledgeChanged(): () => void {
      return () => {};
    }
    onTaskChanged(): () => void {
      return () => {};
    }
    onReconnect(): () => void {
      return () => {};
    }
    onMemoryChanged(): () => void {
      return () => {};
    }
    onLessonsChanged(): () => void {
      return () => {};
    }
    onResourceAlertsChanged(): () => void {
      return () => {};
    }
  },
}));
vi.mock('./terminal/terminal-panel', () => ({ TerminalPanel: () => null }));
vi.mock('./debug/debug-panel', () => ({ DebugPanel: () => null }));

import { CLI_KINDS, type DaemonHandle } from '../shared/contracts';
import { createPreloadStub } from './__fixtures__/preload-stub';
import { afterPopstate } from './__tests__/after-popstate';
import { App } from './App';
import { REMOTE_HISTORY_PAGE } from './chats/use-chat-run';
import type { WaitReading } from './chats/waiting';
import { DaemonClient } from './daemon-client';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/**
 * The running test's body, and whether vitest has finished with it. A test
 * that times out is abandoned, not stopped: its body goes on pressing buttons
 * in `container`, which by then holds the NEXT test's App, and that test finds
 * what it looks for gone. `afterEach` lets the body end first.
 */
let body: Promise<void> | null = null;
let testOver = false;
/** This file's `it`, which keeps hold of the body for `afterEach`. */
const it = (name: string, fn: () => Promise<void>): void => {
  test(name, () => (body = fn()));
};

// The first import of the Settings chunk compiles its whole module tree: 1.3s
// on an idle machine and 5–7s at load average 30–80, which a test paying it
// inside its own 5s budget ran out of. Paid once here, where the work is real
// and bounded; App's own lazy import then finds the module loaded.
beforeAll(async () => {
  await import('./settings/Settings');
}, 60_000);

/** jsdom ships no `matchMedia`; the shell asks it for the narrow layout. */
function stubMatchMedia(narrow: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: narrow,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  testOver = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stubMatchMedia(false);
});

afterEach(async () => {
  testOver = true;
  // Its outcome was the test's to report; here it only has to have ended.
  await body?.catch(() => undefined);
  body = null;
  act(() => root.unmount());
  container.remove();
  delete (window as { geniro?: unknown }).geniro;
  // A test that navigates leaves its hash behind, and the next App would open
  // on that screen rather than the one its test is about.
  history.replaceState(null, '', '/');
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const HANDLE: DaemonHandle = {
  host: '127.0.0.1',
  port: 1,
  token: 't',
  version: '0.0.0',
  startedAt: '2026-01-01T00:00:00.000Z',
};

const startupScreen = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-slot="startup-screen"]');

const buttonNamed = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label,
  );

describe('App — while the daemon starts', () => {
  it('shows the startup screen, not the red "not connected" strip, while the launch’s start is in flight', async () => {
    // The launch's start takes seconds on a large profile. Reading the handle
    // mid-boot answered "none", and the shell drew that as a failure banner on
    // every launch.
    let finish: (handle: DaemonHandle) => void = () => undefined;
    const ensureDaemon = vi.fn(
      () =>
        new Promise<DaemonHandle>((resolve) => {
          finish = resolve;
        }),
    );
    window.geniro = createPreloadStub({ ensureDaemon });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no daemon in this spec'))),
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    await act(async () => {
      root.render(<App />);
    });
    await flush();

    // Mount JOINS the start rather than reading a handle it does not have yet.
    expect(ensureDaemon).toHaveBeenCalledTimes(1);
    expect(startupScreen()?.dataset.state).toBe('starting');
    expect(container.textContent).not.toContain('Not connected');

    await act(async () => {
      finish(HANDLE);
    });
    await flush();

    expect(startupScreen()).toBeNull();
  });

  it('shows the supervisor’s reason when the start fails, and Retry starts it again', async () => {
    const ensureDaemon = vi
      .fn((): Promise<DaemonHandle> =>
        Promise.reject(new Error('daemon exited during startup (code 1)')),
      )
      .mockImplementationOnce(() =>
        Promise.reject(
          new Error(
            'daemon pid 7 is running but not answering its health check',
          ),
        ),
      );
    window.geniro = createPreloadStub({ ensureDaemon });

    await act(async () => {
      root.render(<App />);
    });
    await flush();

    expect(startupScreen()?.dataset.state).toBe('failed');
    expect(startupScreen()?.textContent).toContain(
      'not answering its health check',
    );

    await act(async () => {
      buttonNamed('Retry')!.click();
    });
    await flush();

    expect(ensureDaemon).toHaveBeenCalledTimes(2);
    // The second attempt's own reason, not the first one left standing.
    expect(startupScreen()?.textContent).toContain('exited during startup');
  });

  it('attaches once when the start answers through both the push and the joined ensure', async () => {
    const restarted: ((handle: DaemonHandle) => void)[] = [];
    window.geniro = createPreloadStub({
      ensureDaemon: () => Promise.resolve(HANDLE),
      onDaemonRestarted: (listener) => {
        restarted.push(listener);
        return () => undefined;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no daemon in this spec'))),
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const connects = vi.spyOn(DaemonClient.prototype, 'connect');

    await act(async () => {
      root.render(<App />);
    });
    await flush();
    await act(async () => {
      restarted.forEach((listener) => listener({ ...HANDLE }));
    });
    await flush();

    expect(connects).toHaveBeenCalledTimes(1);
  });
});

describe('App — the connection banner’s Retry', () => {
  it('asks main to START the daemon again once a held daemon stops answering', async () => {
    const ensureDaemon = vi
      .fn((): Promise<DaemonHandle> =>
        Promise.reject(
          new Error(
            'daemon pid 7 is running but not answering its health check',
          ),
        ),
      )
      .mockImplementationOnce(() => Promise.resolve(HANDLE));
    window.geniro = createPreloadStub({ ensureDaemon });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no daemon in this spec'))),
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    await act(async () => {
      root.render(<App />);
    });
    await flush();
    // The socket never opened (the client is a stand-in), so the strip is up.
    const retry = buttonNamed('Retry');
    expect(retry).toBeDefined();
    expect(startupScreen()).toBeNull();

    await act(async () => {
      retry!.click();
    });
    await flush();

    expect(ensureDaemon).toHaveBeenCalledTimes(2);
    // The supervisor's own reason reaches the banner.
    expect(container.textContent).toContain('not answering its health check');
  });
});

describe('App — the Projects address', () => {
  const backToGallery = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="Back to projects"]',
    );

  it('shows the gallery when #/projects arrives while a project page is open', async () => {
    history.replaceState(null, '', '#/projects/p1');
    window.geniro = createPreloadStub({
      ensureDaemon: () => Promise.resolve(HANDLE),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no daemon in this spec'))),
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    await act(async () => {
      root.render(<App />);
    });
    for (
      let tries = 0;
      tries < 100 && !testOver && !backToGallery();
      tries += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(backToGallery()).not.toBeNull();

    await act(async () => {
      location.hash = '#/projects';
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await flush();

    expect(backToGallery()).toBeNull();
    expect(location.hash).toBe('#/projects');
  });
});

describe('App — the phone’s navigation', () => {
  it('navigates from a bottom tab bar, with the rail and its old drawer button gone below `sm`', async () => {
    stubMatchMedia(true);
    window.geniro = createPreloadStub();

    await act(async () => {
      root.render(<App />);
    });
    await flush();

    const bar = container.querySelector<HTMLElement>(
      '[data-slot="bottom-tab-bar"]',
    )!;
    const current = (): string | null | undefined =>
      bar
        .querySelector('button[aria-current="page"]')
        ?.getAttribute('aria-label');
    expect(current()).toBe('Chats');
    // The rail stays for wider widths only, and the hamburger is gone.
    const rail = container.querySelector('button[aria-label="Collapse menu"]');
    expect(rail).not.toBeNull();
    expect(rail!.closest('.max-sm\\:hidden')).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Open navigation"]'),
    ).toBeNull();

    await act(async () => {
      bar
        .querySelector<HTMLButtonElement>('button[aria-label="Stats"]')!
        .click();
    });
    await flush();
    expect(current()).toBe('Stats');
  });

  it('leaves the usage glyph out of a phone’s title bar, whose trailing edge is the run-details opener’s', async () => {
    const usage = (): Element | null =>
      container.querySelector('[data-slot="app-usage-trigger"]');
    // The glyph needs a daemon to read; none answers here.
    const handle: DaemonHandle = {
      host: '127.0.0.1',
      port: 1,
      token: 't',
      version: '0.0.0',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    window.geniro = createPreloadStub({
      ensureDaemon: () => Promise.resolve(handle),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no daemon in this spec'))),
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    stubMatchMedia(false);
    await act(async () => {
      root.render(<App />);
    });
    await flush();
    expect(usage()).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    stubMatchMedia(true);
    await act(async () => {
      root.render(<App />);
    });
    await flush();
    expect(usage()).toBeNull();
  });
});

describe('App — phone pages and the tab bar', () => {
  const press = async (label: string): Promise<void> => {
    const button = [...container.querySelectorAll('button')].find(
      (node) =>
        node.textContent?.trim() === label ||
        node.getAttribute('aria-label') === label,
    )!;
    await act(async () => {
      button.click();
    });
    await flush();
  };
  const tabBar = (): Element | null =>
    container.querySelector('[data-slot="bottom-tab-bar"]');
  const title = (): string | null | undefined =>
    container.querySelector('[data-slot="titlebar-title"]')?.textContent;
  const sectionsNav = (): Element | null =>
    container.querySelector('nav[aria-label="Settings sections"]');
  /** Whether the phone shows a Settings SECTION rather than the list of them. */
  const sectionOpen = (): boolean =>
    sectionsNav()?.classList.contains('max-sm:hidden') ?? false;
  /** Settings is a lazy chunk: wait for it to replace the Suspense fallback. */
  const waitForSettings = async (): Promise<void> => {
    for (
      let tries = 0;
      tries < 100 && !testOver && !sectionsNav();
      tries += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    if (!sectionsNav()) {
      throw new Error('Settings never replaced its Suspense fallback');
    }
  };
  const afterPop = async (go: () => void): Promise<void> => {
    await afterPopstate(go);
    await flush();
  };

  beforeEach(async () => {
    // App opens on the view the address names, and an earlier spec leaves
    // its own there.
    history.replaceState(null, '', '#/chats');
    stubMatchMedia(true);
    const handle: DaemonHandle = {
      host: '127.0.0.1',
      port: 1,
      token: 't',
      version: '0.0.0',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    window.geniro = createPreloadStub({
      ensureDaemon: () => Promise.resolve(handle),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no daemon in this spec'))),
    );
    await act(async () => {
      root.render(<App />);
    });
    await flush();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the tab bar on every phone page — a chat detail page too — and names the list page after the tab', async () => {
    expect(tabBar()).not.toBeNull();
    expect(title()).toBe('Chats');

    await press('open a thread');
    expect(tabBar()).not.toBeNull();
    expect(title()).toBe('New chat');

    await press('back to the list');
    expect(tabBar()).not.toBeNull();
    expect(title()).toBe('Chats');
  });

  it('caps the transcript page in a browser, which parses and draws every row it holds', async () => {
    // This suite's runtime has no preload, so `isRemoteRuntime()` reads as the
    // phone's page.
    expect(container.querySelector('[data-slot="page-cap"]')?.textContent).toBe(
      String(REMOTE_HISTORY_PAGE),
    );
  });

  it('sends Chats home when its tab is pressed again — the phone’s way back to the list', async () => {
    const signal = (): string | null | undefined =>
      container.querySelector('[data-slot="home-signal"]')?.textContent;
    expect(signal()).toBe('0');

    await act(async () => {
      tabBar()!
        .querySelector<HTMLButtonElement>('button[aria-label="Chats"]')!
        .click();
    });

    expect(signal()).toBe('1');
  });

  it('answers the phone’s own back gesture in a Settings section by returning to the list of sections', async () => {
    await act(async () => {
      tabBar()!
        .querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
        .click();
    });
    await waitForSettings();
    await press('Fast actions');
    expect(sectionOpen()).toBe(true);

    // The real traversal, so the shell's `hashchange` handling runs too.
    await afterPop(() => history.back());

    expect(sectionOpen()).toBe(false);
    expect(sectionsNav()).not.toBeNull();
    expect(location.hash).toBe('#/settings');
  });

  it('draws no back button of its own — the tab bar is the navigation', async () => {
    await act(async () => {
      tabBar()!
        .querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
        .click();
    });
    await waitForSettings();
    await press('Fast actions');
    expect(sectionOpen()).toBe(true);

    expect(container.querySelector('button[aria-label^="Back to"]')).toBeNull();
  });

  it('reuses the section’s entry after a hop to another tab and back, so one back still reaches the list', async () => {
    const push = vi.spyOn(history, 'pushState');
    await act(async () => {
      tabBar()!
        .querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
        .click();
    });
    await waitForSettings();
    await press('Fast actions');
    // The hop rewrites the section's entry to the other tab's hash — which
    // must keep the entry's mark, or the section cannot recognise it again.
    await act(async () => {
      tabBar()!
        .querySelector<HTMLButtonElement>('button[aria-label="Chats"]')!
        .click();
    });
    await flush();
    await act(async () => {
      tabBar()!
        .querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
        .click();
    });
    await waitForSettings();
    expect(sectionOpen()).toBe(true);

    expect(push).toHaveBeenCalledTimes(1);
    await afterPop(() => history.back());
    expect(sectionOpen()).toBe(false);
    expect(location.hash).toBe('#/settings');
  });

  it('pushes no history entry for a Settings section on a WIDE window, where sections are not pages', async () => {
    act(() => root.unmount());
    root = createRoot(container);
    history.replaceState(null, '', '#/settings');
    stubMatchMedia(false);
    const push = vi.spyOn(history, 'pushState');
    await act(async () => {
      root.render(<App />);
    });
    await flush();
    await waitForSettings();

    await press('Fast actions');

    expect(push).not.toHaveBeenCalled();
  });

  it('lands a jump from the composer page INSIDE the Settings section, with the tab bar back, and back from it stays in Settings', async () => {
    // The real jump ("Manage fast actions") is pressed on the composer — a
    // DETAIL page, which has hidden the tab bar — and flips the view and the
    // section open in ONE commit.
    await press('open a thread');
    await press('manage fast actions');
    await waitForSettings();
    expect(sectionOpen()).toBe(true);
    expect(tabBar()).not.toBeNull();

    // Re-pressing the Settings tab pops the section's entry. The entry under
    // it must name Settings, not the Chats screen the jump came from.
    await afterPop(() =>
      tabBar()!
        .querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
        .click(),
    );

    expect(sectionOpen()).toBe(false);
    expect(sectionsNav()).not.toBeNull();
    expect(location.hash).toBe('#/settings');
  });
});

describe('App — ⌘J to what waits on the user', () => {
  const approval: WaitReading = {
    runId: 'approval',
    state: 'asking',
    since: '2026-10-21T10:01:00.000Z',
  };
  const reply: WaitReading = {
    runId: 'reply',
    state: 'unseen',
    since: '2026-10-21T10:02:00.000Z',
  };

  async function boot(): Promise<void> {
    chatsMock.opened = [];
    window.geniro = createPreloadStub({
      ensureDaemon: () => Promise.resolve(HANDLE),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no daemon in this spec'))),
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    await act(async () => {
      root.render(<App />);
    });
    await flush();
  }

  async function report(waits: readonly WaitReading[]): Promise<void> {
    chatsMock.waits = waits;
    await act(async () => {
      buttonNamed('report waits')!.click();
    });
  }

  async function pressJump(): Promise<void> {
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          metaKey: true,
          code: 'KeyJ',
          key: 'j',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flush();
  }

  it('opens the approval first, then the unread reply, and counts both in the title bar', async () => {
    await boot();
    await report([approval, reply]);

    expect(
      container
        .querySelector('[data-slot="waiting-status"]')
        ?.getAttribute('aria-label'),
    ).toContain('1 asking, 1 unread');

    await pressJump();
    expect(chatsMock.opened).toEqual(['approval']);

    await pressJump();
    expect(chatsMock.opened).toEqual(['approval', 'reply']);

    // Opening the reply saw it, so the screen reports it gone; the next press
    // wraps to the approval rather than standing still.
    await report([approval]);
    await pressJump();
    expect(chatsMock.opened).toEqual(['approval', 'reply', 'approval']);
  });

  it('carries on down the queue past a thread the jump opened and the user then dealt with', async () => {
    const second: WaitReading = {
      runId: 'second',
      state: 'asking',
      since: '2026-10-21T10:01:30.000Z',
    };
    await boot();
    await report([approval, second, reply]);

    await pressJump();
    await pressJump();
    expect(chatsMock.opened).toEqual(['approval', 'second']);

    // Answered: the thread on show is working now, and leaves the queue.
    await report([approval, reply, { ...second, state: 'working' }]);
    await pressJump();
    expect(chatsMock.opened).toEqual(['approval', 'second', 'reply']);
  });

  it('starts again at the longest wait once a thread was opened some other way', async () => {
    const later: WaitReading = {
      runId: 'later',
      state: 'unseen',
      since: '2026-10-21T10:03:00.000Z',
    };
    await boot();
    await report([approval, reply, later]);
    await pressJump();
    await pressJump();
    expect(chatsMock.opened).toEqual(['approval', 'reply']);
    await report([approval, later]);

    const openByHand = async (runId: string): Promise<void> => {
      chatsMock.byHand = runId;
      await act(async () => {
        buttonNamed('open by hand')!.click();
      });
    };
    await openByHand('elsewhere');
    await openByHand('reply');
    await pressJump();

    expect(chatsMock.opened).toEqual(['approval', 'reply', 'approval']);
  });

  it('does not re-open the thread on show when it is the only wait', async () => {
    await boot();
    await report([approval]);

    await pressJump();
    await pressJump();

    expect(chatsMock.opened).toEqual(['approval']);
  });
});

describe('App — the menu counts what waits on you', () => {
  const since = '2026-10-21T10:01:00.000Z';
  const waits: readonly WaitReading[] = [
    { runId: 'chat-ask', state: 'asking', since },
    { runId: 'card-ask', state: 'asking', since },
    { runId: 'card-reply', state: 'unseen', since },
    { runId: 'card-busy', state: 'working', since },
  ];

  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });

  async function bootWithCounts(counts: {
    pending: number;
    knowledgeWaiting: number;
    cliUpdates?: number;
    lessonsWaiting?: number;
  }): Promise<void> {
    chatsMock.waits = [];
    window.geniro = createPreloadStub({
      ensureDaemon: () => Promise.resolve(HANDLE),
      detectClis: () =>
        Promise.resolve(
          CLI_KINDS.map((kind, index) => ({
            kind,
            found: true,
            path: `/bin/${kind}`,
            version: '1.0.0',
            loggedIn: null,
            update: {
              available: index < (counts.cliUpdates ?? 0),
              latestVersion: null,
              checkUnavailableReason: null,
            },
          })),
        ),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/v1/memories/review/summary')) {
          return Promise.resolve(jsonResponse({ pending: counts.pending }));
        }
        if (url.includes('/v1/lessons/proposals')) {
          return Promise.resolve(
            jsonResponse({
              proposals: Array.from(
                { length: counts.lessonsWaiting ?? 0 },
                () => ({}),
              ),
            }),
          );
        }
        if (url.includes('/v1/knowledge/counts')) {
          return Promise.resolve(
            jsonResponse({
              places: [],
              active: 0,
              waiting: counts.knowledgeWaiting,
            }),
          );
        }
        return Promise.reject(new Error('no daemon in this spec'));
      }),
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    await act(async () => {
      root.render(<App />);
    });
    await flush();
  }

  async function report(readings: readonly WaitReading[]): Promise<void> {
    chatsMock.waits = readings;
    await act(async () => {
      buttonNamed('report waits')!.click();
    });
    await flush();
  }

  function railCount(label: string): string | null {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>('nav button'),
    ].find((candidate) => candidate.textContent?.startsWith(label));
    expect(button, `${label} in the rail`).toBeDefined();
    return (
      button!.querySelector('[data-slot="nav-count"]')?.textContent ?? null
    );
  }

  function tabLabel(label: string): string | null {
    const tab = container.querySelector<HTMLButtonElement>(
      `[data-slot="bottom-tab-bar"] button[title="${label}"]`,
    );
    expect(tab, `${label} in the tab bar`).not.toBeNull();
    return tab!.getAttribute('aria-label');
  }

  it('counts beside the rail what waits on you for Chats, Knowledge and Settings, and nothing on Tasks or elsewhere', async () => {
    await bootWithCounts({ pending: 4, knowledgeWaiting: 5 });
    await report(waits);

    expect(railCount('Chats')).toBe('3');
    expect(railCount('Tasks')).toBeNull();
    expect(railCount('Knowledge')).toBe('5');
    expect(railCount('Settings')).toBe('4');
    expect(railCount('Projects')).toBeNull();
    expect(railCount('Teams')).toBeNull();
    expect(railCount('Stats')).toBeNull();
  });

  it('adds the agent CLIs with an update waiting to the Settings count', async () => {
    await bootWithCounts({ pending: 4, knowledgeWaiting: 0, cliUpdates: 2 });

    expect(railCount('Settings')).toBe('6');
  });

  it('adds the lessons waiting on a decision to the Settings count', async () => {
    await bootWithCounts({
      pending: 4,
      knowledgeWaiting: 0,
      lessonsWaiting: 3,
    });

    expect(railCount('Settings')).toBe('7');
  });

  it('draws no count at zero', async () => {
    await bootWithCounts({ pending: 0, knowledgeWaiting: 0 });
    await report([waits[3]!]);

    expect(railCount('Chats')).toBeNull();
    expect(railCount('Tasks')).toBeNull();
    expect(railCount('Knowledge')).toBeNull();
    expect(railCount('Settings')).toBeNull();
  });

  it('gives the phone’s tab bar the same counts', async () => {
    stubMatchMedia(true);
    await bootWithCounts({ pending: 4, knowledgeWaiting: 5 });
    await report(waits);

    expect(tabLabel('Chats')).toBe('Chats, 3 waiting');
    expect(tabLabel('Tasks')).toBe('Tasks');
    expect(tabLabel('Knowledge')).toBe('Knowledge, 5 waiting');
    expect(tabLabel('Settings')).toBe('Settings, 4 waiting');
    expect(tabLabel('Projects')).toBe('Projects');
    expect(tabLabel('Stats')).toBe('Stats');
  });
});
