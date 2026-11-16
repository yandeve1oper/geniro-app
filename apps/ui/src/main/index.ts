import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  app,
  BrowserWindow,
  nativeImage,
  powerSaveBlocker,
  session,
  shell,
} from 'electron';

import { browserWindowHash } from '../shared/browser-window-route';
import { type DaemonHandle, TRAFFIC_LIGHT_INSET } from '../shared/contracts';
import { EXTERNAL_LINK_SCHEMES } from '../shared/link-schemes';
import { themeWindowBackground } from '../shared/themes';
import { installApplicationMenu } from './app-menu';
import { guardArtifactFrameNavigations } from './artifact-frame-navigation';
import { AutopilotConductor } from './autopilot-conductor';
import { BrowserService } from './browser/browser-service';
import {
  chatPartitionDir,
  runStillExists,
  sweepOrphanedBrowserPartitions,
} from './browser/browser-sessions';
import { type EgressProxy, startEgressProxy } from './browser/egress-proxy';
import { installContextMenu } from './context-menu';
import { DaemonKeepAlive } from './daemon-keepalive';
import type { DaemonQuitCause } from './daemon-pidfile';
import {
  notifyDaemonMigrating,
  notifyDaemonReady,
} from './daemon-ready-notify';
import { DaemonSupervisor } from './daemon-supervisor';
import { installFetchDispatcher } from './fetch-dispatcher';
import { readFinishedTasks } from './finished-tasks';
import { readGitStamp } from './git-info';
import { registerIpc } from './ipc';
import { KeepAwake } from './keep-awake';
import { KeptSessionConfigPush } from './kept-session-config-push';
import { KnowledgeConfigPush } from './knowledge-config-push';
import { LessonsConfigPush } from './lessons-config-push';
import { flushWindowsThen } from './line-measurement-flush';
import { memoryConfigOf, MemoryConfigPush } from './memory-config-push';
import {
  applyTheme,
  resolvedTheme,
  watchSystemAppearance,
} from './native-appearance';
import { isAllowedTopFrameNavigation } from './navigation-policy';
import {
  applyNetworkLockdownSwitches,
  blackHoleProxy,
  installWebContentsLockdown,
} from './network-lockdown';
import { adoptLoginShellPath } from './process-path';
import { PullRequestMergeWatcher } from './pull-request-merge-watcher';
import { teardownThenQuit } from './quit-teardown';
import { RemoteAccess } from './remote/remote-access';
import { ResourceAlertsConfigPush } from './resource-alerts-config-push';
import { onSettingsWritten, readSettings } from './settings';
import { notifySettingsChanged } from './settings-changed-notify';
import { migrateSettingsFile } from './settings-migrations';
import { ShareConfigPush } from './share-config-push';
import { TerminalSessions } from './terminal-sessions';
import { reportUncaughtErrors } from './uncaught-error-report';
import { createUpdateService } from './update-service';
import {
  describeLoadFailure,
  flushMainLogs,
  isRealLoadFailure,
  reportMainLog,
  shouldReloadAfterRendererGone,
} from './window-diagnostics';
import {
  prepareWorktree,
  pruneWorktreeForTask,
  reapFinishedWorktrees,
} from './worktree-service';

/**
 * Product display name. Set before anything reads it: it drives
 * `app.getPath('userData')` (settings.json, the daemon pidfile, and the DB all
 * live under `…/Application Support/Geniro`), default menu-item strings, and
 * the About panel. It does NOT rename the dev Dock tile / bold menu-bar title —
 * macOS reads those from the running bundle's Info.plist, so under
 * `electron-vite dev` they say "Electron" until the M4 packaged build
 * (electron-builder `productName`) ships a real Geniro.app.
 */
app.setName('Geniro');
app.setAboutPanelOptions({
  applicationName: 'Geniro',
  applicationVersion: app.getVersion(),
});

/**
 * Run this build against a userData directory of its OWN.
 *
 * `app.setName` above is what makes every build — dev and installed alike —
 * resolve the SAME `…/Application Support/Geniro`, which is normally right:
 * a developer wants their real chats. It is exactly wrong when both are meant
 * to run at once. The daemon allows one instance per userData directory, so
 * the second launch cannot start its own; and `DaemonSupervisor` deliberately
 * leaves a daemon started from a different entry path alone, so the dev shell
 * ADOPTS the installed app's daemon and every daemon-side change under test
 * silently is not the code being exercised.
 *
 * Naming a directory here separates the two completely — settings, database,
 * pidfile, instance lock, attachments and logs — so a dev build can be driven
 * beside an installed one without either noticing. Unset, nothing changes.
 *
 * It must be applied BEFORE anything reads a path, which is why it sits here
 * rather than in `main()`: `readSettings` and the supervisor both resolve
 * `userData` at their first call.
 */
const userDataOverride = process.env.GENIRO_UI_USER_DATA?.trim();
if (userDataOverride) {
  app.setPath('userData', userDataOverride);
  // Session storage (cookies, cache, DevTools state) follows userData, so a
  // second shell would otherwise still share the installed app's — and Chromium
  // takes a lock on it, which is a launch failure rather than a subtle one.
  app.setPath('sessionData', userDataOverride);
}

/**
 * Keep a page this app frames — an agent's artifact — off the network where
 * its CSP cannot: WebRTC. The resolver rules are a Chromium switch, read when
 * the network service starts, so they are appended here, before `ready`; the
 * WebRTC policy is per WebContents and goes onto each one as it is created.
 * See `network-lockdown.ts` for what each piece was measured to stop.
 */
applyNetworkLockdownSwitches(app.commandLine);
installWebContentsLockdown(app);

/** Absolute path to the app icon (the lightbulb-robot mascot). */
const ICON_PATH = join(app.getAppPath(), 'resources', 'icon.png');

/** True under `electron-vite dev` (renderer served from a URL, not a file). */
const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

const supervisor = new DaemonSupervisor({
  // Every daemon a start brought up — at launch, from the Dock, from the
  // banner's Retry, or respawned after one this app owned died — is announced
  // from here, so no caller of `start()` has to remember to.
  onStarted: (handle) => daemonCameUp(handle),
  onMigrating: (migration) => notifyDaemonMigrating(mainWindow, migration),
  // Buffered until a daemon exists, which is exactly when these matter: a
  // daemon that died is reported to the one that replaces it.
  log: (level, message) => {
    void reportMainLog(supervisor.getHandle(), level, message, {
      source: 'daemon-supervisor',
    });
  },
});
// Before anything here calls `fetch`: see fetch-dispatcher.ts for the crash
// it prevents. Said in the log when skipped, so a later crash can be told
// apart from one this should have stopped.
const fetchDispatcherSkipped = installFetchDispatcher();
if (fetchDispatcherSkipped !== null) {
  void reportMainLog(
    null,
    'warn',
    `fetch dispatcher left as it is: ${fetchDispatcherSkipped}`,
    { source: 'fetch-dispatcher' },
  );
}
reportUncaughtErrors((message, context) => {
  void reportMainLog(supervisor.getHandle(), 'error', message, {
    ...context,
    source: 'main-process',
  });
});
/**
 * The sharing settings live in settings.json and the daemon holds them in
 * memory only, so every daemon is told on start, after a restart from
 * Settings, and after any write that changed them.
 */
const shareConfigPush = new ShareConfigPush((message) => {
  void reportMainLog(supervisor.getHandle(), 'warn', message, {
    source: 'share-config',
  });
});
/**
 * The kept-session idle window, the same way: the daemon holds it in memory
 * (an hour until the first push), so every daemon is told on start, after a
 * restart from Settings, and after any write that changed it.
 */
const keptSessionConfigPush = new KeptSessionConfigPush((message) => {
  void reportMainLog(supervisor.getHandle(), 'warn', message, {
    source: 'kept-session-config',
  });
});
/**
 * The memory settings, the same way: the daemon holds them in memory (memory
 * on, agent writes active until the first push), so every daemon is told on
 * start, after a restart from Settings, and after any write that changed them.
 */
const memoryConfigPush = new MemoryConfigPush((message) => {
  void reportMainLog(supervisor.getHandle(), 'warn', message, {
    source: 'memory-config',
  });
});
const lessonsConfigPush = new LessonsConfigPush((message) => {
  void reportMainLog(supervisor.getHandle(), 'warn', message, {
    source: 'lessons-config',
  });
});
const knowledgeConfigPush = new KnowledgeConfigPush((message) => {
  void reportMainLog(supervisor.getHandle(), 'warn', message, {
    source: 'knowledge-config',
  });
});
const resourceAlertsConfigPush = new ResourceAlertsConfigPush((message) => {
  void reportMainLog(supervisor.getHandle(), 'warn', message, {
    source: 'resource-alerts-config',
  });
});
onSettingsWritten((settings) => {
  notifySettingsChanged(BrowserWindow.getAllWindows());
  void shareConfigPush.pushIfChanged(supervisor.getHandle(), settings.sharing);
  void keptSessionConfigPush.pushIfChanged(supervisor.getHandle(), {
    idleMinutes: settings.keptSessionIdleMinutes,
  });
  void memoryConfigPush.pushIfChanged(
    supervisor.getHandle(),
    memoryConfigOf(settings),
  );
  void lessonsConfigPush.pushIfChanged(
    supervisor.getHandle(),
    settings.lessons,
  );
  void knowledgeConfigPush.pushIfChanged(
    supervisor.getHandle(),
    settings.knowledge,
  );
  void resourceAlertsConfigPush.pushIfChanged(
    supervisor.getHandle(),
    settings.resourceAlerts,
  );
  keepAwake.setEnabled(settings.preventSleepWhileWorking);
});

/**
 * Why the coming quit stops the daemon: an update's relaunch says so first, and
 * every other quit is the user's. The next daemon writes it onto any turn the
 * stop cuts off.
 */
let quitCause: DaemonQuitCause = 'quit';
// The update service's own reporting channel. Everything it knew used to go to
// `console`, and a packaged Finder launch discards main's stdout — so a wedged
// or failed update left no record anywhere. `reportMainLog` buffers until the
// daemon exists, which covers the launch sweep below firing before it does.
const updates = createUpdateService(
  (level, message, context) => {
    void reportMainLog(supervisor.getHandle(), level, message, context);
  },
  () => {
    quitCause = 'self-update';
  },
);
/**
 * The autopilot's two halves, both owned by main.
 *
 * The keep-alive holds one authenticated client so the daemon cannot idle out
 * between two tasks; the conductor is the recurring tick that starts them.
 * Neither needs an IPC channel of its own: arming a project is an ordinary
 * PATCH the renderer already has a generated client for, and the tick reads it
 * back from the daemon — so the two windows and the timer all learn the same
 * answer from the same row.
 */
const keepAlive = new DaemonKeepAlive((message) => {
  void reportMainLog(supervisor.getHandle(), 'info', message, {
    source: 'autopilot-keepalive',
  });
});

const keepAwake = new KeepAwake({
  blocker: powerSaveBlocker,
  getHandle: () => supervisor.getHandle(),
  report: (message) => {
    void reportMainLog(supervisor.getHandle(), 'info', message, {
      source: 'keep-awake',
    });
  },
});

const autopilot = new AutopilotConductor({
  handle: () => supervisor.getHandle(),
  armedProjects: readArmedProjects,
  prepareWorktree: (input) =>
    prepareWorktree(input, {
      log: (level, message) => {
        void reportMainLog(supervisor.getHandle(), level, message, {
          source: 'worktree',
        });
      },
    }),
  discardWorktree: pruneWorktreeForTask,
  gitStamp: readGitStamp,
  agentOptions: () => readSettings().agentOptions,
  customInstructions: () => readSettings().customInstructions,
  replyLanguage: () => readSettings().replyLanguage,
  log: (message) => {
    void reportMainLog(supervisor.getHandle(), 'info', message, {
      source: 'autopilot',
    });
  },
});

/**
 * The board's OTHER unattended timer, and the counterpart of the conductor
 * above: that one starts the work, this one ends it.
 *
 * It belongs to main for the same reasons and one sharper — `gh` runs here.
 * The daemon knows which pull requests a card's agent opened and cannot ask
 * GitHub what became of them, because it holds no login and shells out to
 * nothing; this process holds both. Like the conductor it needs no IPC channel:
 * it reads its cards from the daemon and reports a merge back to it, so a
 * window being open changes nothing about what it does.
 */
const mergeWatcher = new PullRequestMergeWatcher({
  handle: () => supervisor.getHandle(),
  log: (message) => {
    void reportMainLog(supervisor.getHandle(), 'info', message, {
      source: 'merge-watcher',
    });
  },
});

/** The shells behind the terminal panel, across every window. */
const terminals = new TerminalSessions();

/**
 * Which projects are armed, and — as a side effect the name says out loud —
 * whether the daemon must be held open for them.
 *
 * One read answers both questions, and doing it here rather than on a timer of
 * the keep-alive's own is what keeps them from disagreeing: the socket is
 * released in the same pass that finds nothing armed.
 */
async function readArmedProjects(): Promise<{ id: string }[]> {
  const handle = supervisor.getHandle();
  if (handle === null) {
    return [];
  }
  keepAlive.useDaemon(handle);
  const res = await fetch(`http://${handle.host}:${handle.port}/v1/projects`, {
    headers: { authorization: `Bearer ${handle.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GET /v1/projects answered ${res.status}`);
  }
  const projects = (await res.json()) as {
    id: string;
    autopilotEnabled?: boolean;
  }[];
  const armed = projects.filter((project) => project.autopilotEnabled === true);
  keepAlive.setArmed(armed.length > 0);
  // The FOLDER is deliberately not read here: a card may name a checkout of
  // its own, so where a run is cut from is a per-task answer the queue handout
  // already carries, resolved against the project's default by the daemon.
  return armed.map((project) => ({ id: project.id }));
}

let mainWindow: BrowserWindow | null = null;
/**
 * Set the moment a real quit begins (⌘Q, the update relaunch), so the window's
 * `close` handler can tell a quit from a ⌘W — see `createWindow`.
 */
let isQuitting = false;
let teardownDone = false;
/**
 * Built inside `whenReady`, once `registerIpc` has returned the `IpcRegistry`
 * it needs — but referenced from `before-quit`, in this function's outer
 * scope, so it is declared out here rather than as a local of the `then`
 * callback. Null until then, and NOT asserted otherwise: `before-quit` can
 * fire before it exists — a quit during launch, or after anything earlier in
 * that callback threw — and a TypeError there would take the quit down with
 * it (see `teardownThenQuit`).
 */
let remoteAccess: RemoteAccess | null = null;

let egressProxy: EgressProxy | null = null;
let browser: BrowserService | null = null;
let browserSweepStarted = false;
let releaseBrowserReady: () => void = () => undefined;
/** Resolves once the launch sweep of orphaned browser jars is done, so no session precedes it. */
const browserReady = new Promise<void>((resolve) => {
  releaseBrowserReady = resolve;
});

/** URL scheme (e.g. 'https:'), or '' when `url` doesn't parse. */
function schemeOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

/**
 * The daemon's origin, spelled as the renderer builds it (`daemonBaseUrl`), or
 * null while no daemon is up. Read per call: a respawned daemon can come back
 * on another port.
 */
function daemonOriginNow(): string | null {
  const handle = supervisor.getHandle();
  return handle === null ? null : `http://${handle.host}:${handle.port}`;
}

/** The unpacked DevTools extension that adds the "Geniro" panel. */
const DEVTOOLS_EXTENSION_PATH = join(
  app.getAppPath(),
  'resources',
  'devtools-extension',
);

/**
 * Register the Geniro panel inside Chrome DevTools.
 *
 * This is what makes the daemon's log a REAL DevTools tab — beside Elements,
 * Console and Network, following the user's DevTools theme — rather than a
 * panel of ours that merely resembles one. The renderer's own drawer stays: it
 * is the surface you consult while USING the app, and it is the only one
 * available when DevTools is closed.
 *
 * Loaded on every boot by design — Electron stopped remembering extensions
 * across runs — and into the DEFAULT session, which is the one the window
 * uses. A failure is logged and swallowed: an absent debug tab must never be
 * the reason the app does not start, and Electron supports only a subset of
 * the extension APIs, so this is the kind of thing that can break under an
 * Electron upgrade.
 */
async function loadDevToolsExtension(): Promise<void> {
  if (!existsSync(DEVTOOLS_EXTENSION_PATH)) {
    return;
  }
  try {
    await session.defaultSession.extensions.loadExtension(
      DEVTOOLS_EXTENSION_PATH,
    );
  } catch (err) {
    console.error('failed to load the Geniro DevTools panel', err);
  }
}

const RENDERER_WEB_PREFERENCES = {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  // Renderer runs sandboxed; the preload only uses `electron`, so nothing
  // here needs an unsandboxed context.
  sandbox: true,
};

const BROWSER_POPOUT_SIZE = {
  width: 1100,
  height: 760,
  minWidth: 480,
  minHeight: 360,
};

function loadRenderer(win: BrowserWindow, hash?: string): void {
  // electron-vite sets ELECTRON_RENDERER_URL in dev; otherwise load the build.
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void win.loadURL(
      hash === undefined ? rendererUrl : `${rendererUrl}#${hash}`,
    );
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash });
  }
}

function guardRendererWindow(win: BrowserWindow): void {
  // Electron ships no right-click menu of its own, so without this every
  // right-click in the app does nothing — see `context-menu.ts`.
  installContextMenu(win.webContents);

  // Open external links in the user's browser, never in-app — and only for
  // web/mail schemes, so a compromised renderer can't hand file:// or a custom
  // app scheme to the OS opener.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_LINK_SCHEMES.has(schemeOf(url))) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Pin the top frame to its own origin. The renderer is a local SPA (its
  // client-side routing uses history/hash, which doesn't fire these events), so
  // any full navigation to another origin is unexpected and refused.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedTopFrameNavigation(url, win.webContents.getURL())) {
      event.preventDefault();
    }
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedTopFrameNavigation(url, win.webContents.getURL())) {
      event.preventDefault();
    }
  });
}

function recoverRendererLoads(
  win: BrowserWindow,
  load: () => void,
): { failures: () => number } {
  /**
   * Say what this window actually loaded, and retry ONCE if it loaded nothing.
   *
   * A user reopened the app through the Dock and got a window rendering raw
   * bytes in the browser's default serif — no app, no stylesheet, nothing to
   * click. It could not be diagnosed afterwards, and the reason is structural:
   * the `ui` log channel is fed only by the RENDERER's own error handlers, so a
   * window where the renderer never ran reports nothing by construction, and
   * the main process — the one party that can see a load commit — had no path
   * into the log at all. Across every log file on that machine the channel held
   * zero entries.
   *
   * `did-finish-load` records the URL the window COMMITTED rather than the one
   * it was asked for, which is the question a reader actually has. It is
   * deliberately not a health check on the document: from here that would need
   * `executeJavaScript` against the page's own CSP, and a wrong answer would
   * reload a working app under the user.
   *
   * The retry is only for a REAL failure — `ERR_ABORTED` is what an ordinary
   * redirect or an HMR reload looks like — and only once, because a second
   * identical failure is a broken install rather than a transient, and a window
   * that reloads forever is worse than one that stops with a line in the log.
   */
  let failures = 0;
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, url, isMainFrame) => {
      const failure = { errorCode, errorDescription, url, isMainFrame };
      if (!isRealLoadFailure(failure)) {
        return;
      }
      const retrying = failures === 0;
      failures += 1;
      void reportMainLog(
        supervisor.getHandle(),
        'error',
        describeLoadFailure(failure),
        { kind: 'renderer-load-failed', retrying: String(retrying) },
      );
      if (retrying) {
        load();
      }
    },
  );
  let lastRendererReloadAt: number | null = null;
  win.webContents.on('render-process-gone', (_event, details) => {
    const reloading =
      !isQuitting &&
      shouldReloadAfterRendererGone(
        details.reason,
        lastRendererReloadAt,
        Date.now(),
      );
    void reportMainLog(
      supervisor.getHandle(),
      'error',
      `the renderer process is gone: ${details.reason}`,
      {
        kind: 'render-process-gone',
        exitCode: String(details.exitCode),
        reloading: String(reloading),
      },
    );
    if (reloading) {
      lastRendererReloadAt = Date.now();
      win.webContents.reload();
    }
  });
  return { failures: () => failures };
}

function createBrowserPopout(runId: string, title: string): BrowserWindow {
  const win = new BrowserWindow({
    ...BROWSER_POPOUT_SIZE,
    title: `Browser — ${title}`,
    backgroundColor: themeWindowBackground(resolvedTheme(readSettings().theme)),
    icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: RENDERER_WEB_PREFERENCES,
  });
  win.on('page-title-updated', (event) => event.preventDefault());
  guardRendererWindow(win);
  const load = (): void =>
    loadRenderer(win, browserWindowHash({ runId, title }));
  recoverRendererLoads(win, load);
  load();
  return win;
}

function createWindow(): void {
  // Asked, not applied: `themeSource` is already current (set at launch and by
  // every theme change), so this path only needs to KNOW what is being painted.
  // It runs on macOS `activate` too, which can reopen a window long after the
  // theme was last changed.
  const theme = resolvedTheme(readSettings().theme);
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    // Keep the builder's palette + canvas + inspector (and the library grid)
    // usable — below this the three-pane layout starts to crowd.
    minWidth: 960,
    minHeight: 640,
    show: false,
    // The ground the window paints where the page has not (yet). Unset it is
    // WHITE — see {@link ThemeDescriptor.windowBackground} for the band that
    // produced, and why it is per-theme.
    backgroundColor: themeWindowBackground(theme),
    title: 'Geniro',
    icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
    /**
     * The app draws its own title bar — the shape Chrome and Cursor use.
     *
     * `hiddenInset` removes the system's strip while KEEPING the traffic
     * lights, which is the whole point: the band the OS drew held nothing but
     * the word "Geniro" directly above a row of ours that already named the
     * open chat, so the window spent ~28px saying something it said again
     * underneath. `frame: false` would take the lights with it and leave the
     * app owing the user three buttons it would have to draw and wire itself.
     *
     * The lights are positioned INTO the nav rail's own top row (see
     * `components/nav-rail.tsx`, which reserves the width) rather than left at
     * the default inset, because that default assumes a title bar's height and
     * ours is the rail's. Both values are macOS-only and ignored elsewhere.
     *
     * The inset is SHARED with the renderer rather than spelled here, because
     * placing the buttons and leaving room for them are two halves of one
     * fact — see `TRAFFIC_LIGHT_INSET` in `shared/contracts.ts`.
     */
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TRAFFIC_LIGHT_INSET,
    webPreferences: RENDERER_WEB_PREFERENCES,
  });
  mainWindow = win;
  guardRendererWindow(win);
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });
  // On macOS ⌘W HIDES the window rather than destroying it. The app stays in
  // the Dock either way, but every notification is decided in the RENDERER
  // (`renderer/notifications/use-run-notifications.ts`) — a destroyed window
  // decides nothing, so closing it silenced every "done" and every question
  // banner until the Dock icon was clicked again. A hidden window keeps its
  // socket and its rules running, and is what ⌘W means in a Mac app anyway. A
  // real quit sets `isQuitting` in `before-quit`, which fires first.
  win.on('close', (event) => {
    if (process.platform === 'darwin' && !isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('ready-to-show', () => win.show());

  // `will-navigate` is the main frame's alone. The one subframe is a sandboxed
  // artifact page, and neither its sandbox nor its CSP stops a link in it from
  // navigating the frame itself, which then goes blank.
  guardArtifactFrameNavigations(win.webContents, daemonOriginNow);

  const load = (): void => loadRenderer(win);

  const loads = recoverRendererLoads(win, load);
  win.webContents.on('did-finish-load', () => {
    // Worded off the failure count rather than reported as a plain success,
    // because this fires for Chromium's ERROR PAGE too — and it keeps the
    // failed URL, so the two are indistinguishable from here. Measured against
    // a dead renderer URL, the naive line read "the window loaded
    // http://127.0.0.1:59999/" directly beneath "ERR_CONNECTION_REFUSED",
    // which is the log contradicting itself about the same load.
    void reportMainLog(
      supervisor.getHandle(),
      'info',
      loads.failures() === 0
        ? `the window loaded ${win.webContents.getURL()}`
        : `the window finished loading ${win.webContents.getURL()} after ${loads.failures()} failed attempt(s) — this may be the browser's error page`,
      { kind: 'renderer-loaded', failures: String(loads.failures()) },
    );
  });

  load();
}

/**
 * Collect the worktrees whose card's work is finished, once a daemon is there
 * to say which those are — see `reapFinishedWorktrees`.
 *
 * On every daemon start rather than once per launch: it acts only on a card
 * the daemon calls finished, so a second pass costs a registry read and a git
 * call per entry, and a window re-opened after a while is exactly when a run
 * that settled under a Done card with nobody watching is waiting to be
 * collected. One pass at a time, so two quick re-ensures cannot both try to
 * commit and remove the same checkout.
 */
let reaping = false;
function reapWorktrees(handle: DaemonHandle): void {
  if (reaping) {
    return;
  }
  reaping = true;
  void reapFinishedWorktrees((taskIds) => readFinishedTasks(handle, taskIds))
    .then(({ removed }) => {
      if (removed.length > 0) {
        void reportMainLog(
          handle,
          'info',
          `worktree reaper cleared ${removed.length} finished or vanished task worktree(s)`,
          { source: 'worktrees' },
        );
      }
    })
    .catch(() => {
      // A reaper that cannot run costs disk and nothing else; a launch that
      // fails because of one would cost the user their app.
    })
    .finally(() => {
      reaping = false;
    });
}

/** Hand a daemon that just came up every setting it holds in memory only. */
function pushDaemonConfig(handle: DaemonHandle): void {
  const settings = readSettings();
  void shareConfigPush.push(handle, settings.sharing);
  void keptSessionConfigPush.push(handle, {
    idleMinutes: settings.keptSessionIdleMinutes,
  });
  void memoryConfigPush.push(handle, memoryConfigOf(settings));
  void lessonsConfigPush.push(handle, settings.lessons);
  void knowledgeConfigPush.push(handle, settings.knowledge);
  void resourceAlertsConfigPush.push(handle, settings.resourceAlerts);
}

/**
 * A daemon came up — hand the renderer its address, and do what waits on one.
 *
 * Called by the supervisor itself (`onStarted`) for EVERY start that brought
 * one up, so the launch, the Dock, the banner's Retry and a respawn after a
 * crash all tell the window the same way, not the launch path alone.
 */
function daemonCameUp(handle: DaemonHandle): void {
  notifyDaemonReady(mainWindow, handle);
  startBrowserSweep(handle);
  pushDaemonConfig(handle);
  // The window is opened BEFORE the first one, so whatever it already reported
  // about its own load has been waiting for an address to send it to.
  void flushMainLogs(handle);
  reapWorktrees(handle);
  keepAwake.poke();
}

/**
 * Removes the browser jars of chats that no longer exist, once per launch and
 * before the browser makes any session; `browserReady` opens when it is done.
 */
function startBrowserSweep(handle: DaemonHandle | null): void {
  if (browserSweepStarted) {
    return;
  }
  browserSweepStarted = true;
  void (async () => {
    try {
      if (handle !== null) {
        const removed = await sweepOrphanedBrowserPartitions(
          app.getPath('userData'),
          (runId) => runStillExists(handle, runId),
        );
        if (removed.length > 0) {
          void reportMainLog(
            supervisor.getHandle(),
            'info',
            `removed ${removed.length} browser jar(s) of chats that no longer exist`,
            { source: 'browser' },
          );
        }
      }
    } catch (err) {
      void reportMainLog(
        supervisor.getHandle(),
        'warn',
        `the browser jar sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        { source: 'browser' },
      );
    } finally {
      releaseBrowserReady();
    }
  })();
}

/**
 * Bring the daemon up if it is not — the launch and a later re-ensure alike.
 * A failure is surfaced but never fatal: the renderer shows a disconnected
 * state, with a Retry, rather than the app failing to open.
 */
function ensureDaemon(): void {
  supervisor.start().catch((err: unknown) => {
    console.error('[ui] daemon failed to start:', err);
    startBrowserSweep(null);
  });
}

function migrateSettingsOnLaunch(): void {
  try {
    const result = migrateSettingsFile(app.getPath('userData'));
    if (result !== null) {
      void reportMainLog(
        null,
        'info',
        `settings.json migrated from version ${result.from} to ${result.to}; the previous file is at ${result.backup}`,
        { source: 'settings-migrations' },
      );
    }
  } catch (err) {
    void reportMainLog(
      null,
      'error',
      `settings.json was not migrated and is read as it stands: ${err instanceof Error ? err.message : String(err)}`,
      { source: 'settings-migrations' },
    );
  }
}

function focusMainWindow(): void {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

function main(): void {
  // The app is the single owner of the daemon and its pidfile. A second launch
  // focuses the existing window instead of double-spawning the daemon and
  // clobbering the shared pidfile. macOS already enforces single-instance for
  // Finder/Dock launches; this lock additionally covers CLI/dev relaunches.
  app.on('second-instance', focusMainWindow);

  void app.whenReady().then(async () => {
    // Before the first `readSettings`, which keeps only the keys this build
    // knows: a key a migration carries over must still be in the raw file.
    migrateSettingsOnLaunch();
    // Started first and never awaited here: CLI detection and the daemon spawn
    // each wait for it themselves, and the window has no reason to.
    if (app.isPackaged) {
      void adoptLoginShellPath();
    }
    // Before the window, and before the menu: it decides how macOS draws every
    // surface this app does not paint itself, the window buttons included —
    // and, through `prefers-color-scheme`, what the renderer paints too, which
    // is what keeps the first frame from flashing the wrong theme.
    applyTheme(readSettings().theme);
    keepAwake.setEnabled(readSettings().preventSleepWhileWorking);
    // The one theme change that arrives through no settings write: the user
    // flips the OS appearance while `system` is selected. The renderer follows
    // on its own (its media query moves); the window's own ground does not.
    watchSystemAppearance(() => readSettings().theme);

    // In dev the Dock shows Electron's default icon; override it with the Geniro
    // mascot. A packaged build gets its icon from the bundled .icns (M4), so this
    // only runs under `electron-vite dev`.
    if (
      isDev &&
      process.platform === 'darwin' &&
      app.dock &&
      existsSync(ICON_PATH)
    ) {
      app.dock.setIcon(nativeImage.createFromPath(ICON_PATH));
    }

    // Before the window, because the menu bar is drawn the moment the app
    // activates and replacing it afterwards shows the default one first.
    installApplicationMenu({ isDev });
    // The closure below is only ever CALLED once a request reaches one of the
    // three remote-access channels, by which time `remoteAccess` has been
    // assigned — `RemoteAccess` needs the very `IpcRegistry` `registerIpc`
    // builds (so the gateway proxies to the SAME handlers this app's own
    // window uses), and that registry does not exist until `registerIpc`
    // returns, so passing the instance directly would be circular.
    const ipcRegistry = registerIpc(
      supervisor,
      updates,
      terminals,
      () => {
        if (remoteAccess === null) {
          throw new Error('remote access is not set up yet');
        }
        return remoteAccess;
      },
      (handle) => {
        if (handle !== null) {
          pushDaemonConfig(handle);
        }
      },
      () => {
        if (browser === null) {
          throw new Error('the browser is not available');
        }
        return browser;
      },
    );
    const access = new RemoteAccess({
      ipcRegistry,
      daemonHandle: () => supervisor.getHandle(),
      // Mirrors `createWindow`'s own `rendererUrl` read below rather than
      // re-deciding dev-vs-packaged a second way — `out/renderer` does not
      // exist at all under `electron-vite dev`.
      devServerUrl: process.env.ELECTRON_RENDERER_URL,
    });
    remoteAccess = access;
    // Never awaited: a listener that cannot bind is a degraded feature, not a
    // reason to delay the window — see `RemoteAccess.sync`'s own doc block.
    void access.sync();
    // Armed here, but the first check is deliberately delayed inside the
    // service — launch is busy enough, and an update banner is worth nothing
    // before the window has painted.
    updates.start(readSettings().checkForUpdates);
    // Debris from previous updates, cleared at the one moment nothing here is
    // running. Not gated on the auto-check setting: a user who switched checks
    // off still has whatever the last update left on their disk.
    void updates.sweepDebris();
    // Worktrees are collected once a daemon is up to say which cards are
    // finished — `reapWorktrees`, from `ensureDaemon`. The autopilot never
    // starts a card whose work is finished, so the two cannot meet over one
    // worktree and neither has to wait for the other.
    autopilot.start();
    mergeWatcher.start();
    // Before the window exists, so no page it loads ever runs without it. A
    // failure is logged and does not hold the window: the resolver rules were
    // measured to refuse a TCP connect to an address literal as well, so this
    // is the second lock on that door, not the only one.
    await blackHoleProxy(session.defaultSession).catch((err: unknown) => {
      void reportMainLog(
        supervisor.getHandle(),
        'error',
        `could not install the black-hole proxy: ${err instanceof Error ? err.message : String(err)}`,
        { source: 'network-lockdown' },
      );
    });
    try {
      egressProxy = await startEgressProxy();
      browser = new BrowserService({
        proxyPort: egressProxy.port,
        ready: browserReady,
        mainWindow: () => mainWindow,
        createPopout: createBrowserPopout,
        hasJarOnDisk: (runId) =>
          existsSync(chatPartitionDir(app.getPath('userData'), runId)),
        log: (message) => {
          void reportMainLog(supervisor.getHandle(), 'warn', message, {
            source: 'browser',
          });
        },
      });
    } catch (err) {
      void reportMainLog(
        supervisor.getHandle(),
        'error',
        `could not start the browser's egress proxy: ${err instanceof Error ? err.message : String(err)}`,
        { source: 'browser' },
      );
    }
    await loadDevToolsExtension();

    // Open the window FIRST and let the daemon boot in parallel: first paint
    // and the renderer bundle load overlap the spawn + health poll instead of
    // trailing them (the renderer shows its startup screen, subscribes to
    // onDaemonRestarted and joins this start through `ensureDaemon`, so both
    // ready-vs-mount orderings deliver the handle — and a failed start its
    // reason).
    createWindow();

    ensureDaemon();

    app.on('activate', () => {
      // A ⌘W left the window HIDDEN (see `createWindow`), so it is shown again
      // rather than a second one created beside it.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
      } else if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
      // The daemon may be gone even though the app is not: on macOS, closing
      // the window leaves the app in the Dock with no client attached, and the
      // daemon exits itself once its idle window passes. Coming back through
      // the Dock has to bring it back, or the reopened window would talk to a
      // handle that no longer answers. Asked unconditionally rather than behind
      // `isConnected()`: an ADOPTED daemon dies without an exit event reaching
      // this process, so its handle goes on reading as connected. `start()`
      // answers a held daemon that still answers with one health check.
      ensureDaemon();
    });
  });

  // Coming back to the window is when a pull request is most likely to have
  // been merged somewhere else — the user was just in their browser. The sweep
  // keeps its own five-minute floor, so a burst of focus changes costs one.
  app.on('browser-window-focus', () => {
    void mergeWatcher.sweepIfStale();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Tear the owned daemon down cleanly before the app exits.
  app.on('before-quit', (event) => {
    // First, and unconditionally: the windows close after this, and each one's
    // `close` handler must see a quit rather than a ⌘W to hide.
    isQuitting = true;
    if (teardownDone) {
      return;
    }
    // Cancelled FIRST, and quit again only by `teardownThenQuit`, which quits
    // whatever any step below does — a step that throws must never be able to
    // swallow the quit.
    event.preventDefault();
    void teardownThenQuit(
      [
        // Nothing should fire a check into a process that is on its way out —
        // including the relaunch an installed update triggers, which quits
        // through exactly this path.
        () => updates.stop(),
        // Quitting is not an armed state — the daemon goes back to its ordinary
        // idle window rather than being held open by a process that is ending.
        () => autopilot.stop(),
        () => mergeWatcher.stop(),
        () => keepAlive.dispose(),
        () => keepAwake.dispose(),
        () => terminals.disposeAll(),
        () => browser?.shutdown(),
        () => egressProxy?.close(),
        // The daemon and the gateway together, not one after the other:
        // neither owns the other, and the app must not quit while either is
        // still tearing down. The daemon stops once every window has posted the
        // line measurements it is still holding.
        () =>
          flushWindowsThen(
            BrowserWindow.getAllWindows(),
            () => supervisor.getHandle(),
            () => supervisor.stop(quitCause),
          ),
        () => remoteAccess?.stop(),
      ],
      () => {
        teardownDone = true;
        app.quit();
      },
    );
  });

  // Put a downloaded update in place — HERE, and nowhere earlier. By now every
  // window is closed and the daemon has stopped, so nothing is reading the
  // bundle while it is replaced; replacing it under a live window left the
  // renderer loading its next screen from the new archive at the old one's
  // offsets (see `stageUpdate`). The Restart button quits through this same
  // path, so its relaunch comes up on the new bundle.
  app.on('will-quit', (event) => {
    if (!updates.hasStagedUpdate()) {
      return;
    }
    event.preventDefault();
    void updates.applyStaged().finally(() => app.quit());
  });
}

if (app.requestSingleInstanceLock()) {
  main();
} else {
  // Another instance already owns the daemon; the running one is focused via
  // its 'second-instance' handler, so this one exits immediately.
  app.quit();
}
