import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import {
  DEFAULT_RESOURCE_ALERTS,
  IPC,
  type Settings,
} from '../shared/contracts';
import { type RemoteAccessState, TUNNEL_OFF } from '../shared/remote';
import type { DaemonSupervisor } from './daemon-supervisor';
import { lineMeasurementFlush } from './line-measurement-flush';
import type { RemoteAccess } from './remote/remote-access';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  // TWO windows, so "told the caller" and "told every window" are
  // distinguishable — with one open they look identical, which is exactly how
  // the caller-only send went unnoticed.
  const sendToWindow = vi.fn();
  const getAllWindows = vi.fn(() => [
    { isDestroyed: () => false, webContents: { id: 1, send: sendToWindow } },
    { isDestroyed: () => false, webContents: { id: 2, send: sendToWindow } },
  ]);
  // Spelled out rather than spread from DEFAULT_SETTINGS: this object is
  // built inside vi.hoisted(), which runs BEFORE module imports initialize —
  // referencing the import there throws at load.
  const settings: Settings = {
    settingsVersion: 0,
    onboardingComplete: false,
    onboardingProgress: null,
    projectFolder: null,
    recentFolders: [],
    configDirs: {},
    recentConfigDirs: {},
    runConfigs: [],
    fastActions: [],
    configProfiles: [],
    lastChatTarget: null,
    lastApprovalMode: null,
    lastModels: {},
    lastEfforts: {},
    lastContextWindows: {},
    lastAutoCompactPercent: null,
    lastAnalysisConfig: null,
    lastChangeChatApproval: null,
    lastMemoryTriage: null,
    lastModelParameters: {},
    cliPaths: {},
    checkForUpdates: true,
    sidebarCollapsed: false,
    notificationsEnabled: true,
    remoteAccessEnabled: true,
    sharing: {
      destinations: [],
      defaultDestinationId: null,
      agentsMayShare: false,
      autoRevokeAfterDays: null,
    },
    memory: { enabled: true, agentWrites: 'active', nativeMemoryOff: false },
    lessons: { mode: 'offer', agentKind: null, model: null, effort: null },
    knowledge: { enabled: true, agentWrites: 'review' },
    resourceAlerts: {
      enabled: true,
      threadMemoryBytes: 8 * 1024 ** 3,
      growthBytesPerMinute: 1024 ** 3,
      minFreeDiskBytes: 10 * 1024 ** 3,
    },
    archiveRetentionDays: null,
    memoryAutoForgetAfterDays: null,
    historyPageSize: 1000,
    keptSessionIdleMinutes: 60,
    preventSleepWhileWorking: true,
    agentOptions: {},
    collapseToolSteps: false,
    daemonInspect: false,
    customInstructions: '',
    replyLanguage: '',
    theme: 'system',
  };
  return {
    handlers,
    settings,
    sendToWindow,
    getAllWindows,
    fromWebContents: vi.fn((sender: unknown) =>
      sender === undefined ? null : { sender },
    ),
    applyTheme: vi.fn(() => 'light' as const),
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    readSettings: vi.fn((): Settings => settings),
    updateSettings: vi.fn((patch: Partial<Settings>): Settings => ({
      ...settings,
      ...patch,
    })),
    readLinkedWorktrees: vi.fn(async (): Promise<string[]> => []),
    readChangesSince: vi.fn(async () => undefined),
    worktreesRoot: vi.fn(() => '/no/such/userData/worktrees'),
  };
});

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  ipcMain: { handle: mocks.handle },
  BrowserWindow: {
    getAllWindows: mocks.getAllWindows,
    fromWebContents: mocks.fromWebContents,
  },
}));
vi.mock('./cli-detect', () => ({ detectClis: vi.fn(() => []) }));
vi.mock('./native-appearance', () => ({ applyTheme: mocks.applyTheme }));
vi.mock('./settings', () => ({
  readSettings: mocks.readSettings,
  updateSettings: mocks.updateSettings,
}));
vi.mock('./git-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./git-changes')>()),
  readLinkedWorktrees: mocks.readLinkedWorktrees,
  readChangesSince: mocks.readChangesSince,
}));
vi.mock('./worktree-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./worktree-service')>()),
  worktreesRoot: mocks.worktreesRoot,
}));

import { registerIpc } from './ipc';
import type { TerminalSessions } from './terminal-sessions';
import type { UpdateService } from './update-service';

const noTerminals = {} as TerminalSessions;

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel);
  if (!registered) {
    throw new Error(`missing handler ${channel}`);
  }
  return registered;
}

describe('registerIpc daemon configuration refresh', () => {
  const send = vi.fn();
  const toggleDevTools = vi.fn();
  const event = { sender: { send, toggleDevTools } };
  const restart = vi.fn(async () => ({
    host: '127.0.0.1',
    port: 4823,
    token: 'token',
    version: '1.0.0',
  }));
  const supervisor = {
    getHandle: vi.fn(() => null),
    isConnected: vi.fn(() => false),
    restart,
  } as unknown as DaemonSupervisor;
  const updateStart = vi.fn();
  const updates = {
    start: updateStart,
    getState: vi.fn(),
    check: vi.fn(),
    install: vi.fn(),
  } as unknown as UpdateService;

  /** Each window's answer to a flush, held back while a test wants a flush to stay open. */
  const flushAnswers = { hold: false, requests: [] as string[] };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    flushAnswers.hold = false;
    flushAnswers.requests = [];
    // A window answers a flush at once, as a window holding nothing does, unless a test holds it.
    mocks.sendToWindow.mockImplementation((channel: string, value: unknown) => {
      if (channel !== IPC.onFlushLineMeasurements) {
        return;
      }
      flushAnswers.requests.push(String(value));
      if (!flushAnswers.hold) {
        queueMicrotask(() => {
          lineMeasurementFlush.acknowledge(1, String(value));
          lineMeasurementFlush.acknowledge(2, String(value));
        });
      }
    });
    registerIpc(supervisor, updates, noTerminals);
  });

  it('asks every window to post its line measurements before it restarts the daemon', async () => {
    flushAnswers.hold = true;
    const changed = handler(IPC.updateSettings)(event, { daemonInspect: true });
    await vi.waitFor(() => {
      expect(flushAnswers.requests).toHaveLength(2);
    });
    // The windows have not answered, so the daemon they post to is still the one running.
    await Promise.resolve();
    expect(restart).not.toHaveBeenCalled();

    const [requestId] = flushAnswers.requests;
    lineMeasurementFlush.acknowledge(1, requestId!);
    lineMeasurementFlush.acknowledge(2, requestId!);
    await changed;

    expect(restart).toHaveBeenCalledOnce();
  });

  it('re-arms automatic update checks the moment the toggle is flipped', async () => {
    await handler(IPC.updateSettings)(event, { checkForUpdates: true });

    // Without this the switch only takes effect at the NEXT launch, so a user
    // who turns checking on is told nothing until they quit and reopen.
    expect(updateStart).toHaveBeenCalledWith(true);

    updateStart.mockClear();
    await handler(IPC.updateSettings)(event, { checkForUpdates: false });
    expect(updateStart).toHaveBeenCalledWith(false);

    // An unrelated setting must not restart the schedule — that would reset
    // the interval on every keystroke-debounced binary-path save.
    updateStart.mockClear();
    await handler(IPC.updateSettings)(event, { notificationsEnabled: false });
    expect(updateStart).not.toHaveBeenCalled();
  });

  it('tells the caller about a restart from Settings, which the supervisor’s onStarted does not cover', async () => {
    // The daemon keeps the sharing settings in memory only, so whoever pushes
    // them must hear about this restart too.
    const afterRestart = vi.fn();
    mocks.handlers.clear();
    registerIpc(supervisor, updates, noTerminals, undefined, afterRestart);

    await handler(IPC.updateSettings)(event, {
      cliPaths: { claude: '/opt/claude' },
    });

    expect(afterRestart).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'token' }),
    );
  });

  it('restarts after CLI path settings change, but not unrelated settings', async () => {
    await handler(IPC.updateSettings)(event, {
      cliPaths: { claude: '/opt/claude' },
    });
    expect(restart).toHaveBeenCalledOnce();
    expect(mocks.sendToWindow).toHaveBeenCalledWith(
      IPC.onDaemonRestarted,
      expect.objectContaining({ token: 'token' }),
    );

    restart.mockClear();
    await handler(IPC.updateSettings)(event, { checkForUpdates: false });
    expect(restart).not.toHaveBeenCalled();
  });

  it('restarts after the daemon-inspector toggle, which only a new process can honour', async () => {
    await handler(IPC.updateSettings)(event, { daemonInspect: true });

    expect(mocks.updateSettings).toHaveBeenCalledWith({ daemonInspect: true });
    // Without the respawn the switch reads "on" while the running daemon has
    // no inspector — chrome://inspect finds nothing and the setting is a lie.
    expect(restart).toHaveBeenCalledOnce();

    restart.mockClear();
    await handler(IPC.updateSettings)(event, { daemonInspect: false });
    expect(restart).toHaveBeenCalledOnce();
  });

  it('applies a theme change to the OS at once, and does not respawn the daemon for it', async () => {
    await handler(IPC.updateSettings)(event, { theme: 'dark' });

    // Applied in MAIN, because this one write themes the OS chrome the app does
    // not paint AND — through `prefers-color-scheme` — the page itself. A
    // renderer that themed only itself would leave the traffic lights, the
    // context menu and the system dialogs on the other appearance. `applyTheme`
    // specifically: it also repaints the open window's own ground, which is a
    // construction option nothing else re-reads.
    expect(mocks.applyTheme).toHaveBeenCalledWith('dark');
    // Nothing about a theme rides the daemon's env or its launch flags, so a
    // respawn here would cost the user a running turn for a colour.
    expect(restart).not.toHaveBeenCalled();

    mocks.applyTheme.mockClear();
    await handler(IPC.updateSettings)(event, { notificationsEnabled: false });
    expect(mocks.applyTheme).not.toHaveBeenCalled();
  });

  it('refuses a theme the app does not ship', async () => {
    // ENUMERATED, unlike the CLI-vocabulary fields: a theme is a file this repo
    // ships, so a value outside the list names nothing that can be painted.
    await expect(
      handler(IPC.updateSettings)(event, { theme: 'solarized' }),
    ).rejects.toThrow();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it('toggles DevTools on the calling window only', async () => {
    await handler(IPC.toggleDevTools)(event);

    // The SENDER's own WebContents. Resolving a window some other way (a
    // focused-window lookup, an index) is what would let one window open
    // another's inspector.
    expect(toggleDevTools).toHaveBeenCalledOnce();
  });

  it('accepts the composer chips the renderer remembers, and still refuses an unknown key', async () => {
    // The patch schema is a strictObject, so a key it does not name is DROPPED
    // with a throw — a chip whose value silently never persists is exactly the
    // failure this pins. Neither vocabulary is enumerated here: both belong to
    // the CLIs.
    await handler(IPC.updateSettings)(event, {
      lastEfforts: { claude: 'ultracode' },
      lastModels: { claude: 'opus' },
    });
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      lastEfforts: { claude: 'ultracode' },
      lastModels: { claude: 'opus' },
    });
    expect(restart).not.toHaveBeenCalled();

    await expect(
      handler(IPC.updateSettings)(event, { notASetting: 'x' }),
    ).rejects.toThrow();
  });

  // A restart mints a fresh port and token, so a window left holding the
  // previous handle is talking to a daemon that no longer exists. Announcing
  // it to `event.sender` alone told the caller and nobody else — and a remote
  // call over the LAN gateway has no sender at all.
  it('hands a restarted daemon handle to every window, not just the caller', async () => {
    await handler(IPC.completeOnboarding)(event, {
      cliPaths: { 'cursor-agent': '/opt/cursor-agent' },
    });

    expect(mocks.getAllWindows).toHaveBeenCalled();
    // Each window is asked to flush first, then told about the new daemon.
    const restarted = mocks.sendToWindow.mock.calls.filter(
      ([channel]) => channel === IPC.onDaemonRestarted,
    );
    expect(restarted).toHaveLength(2);
  });

  it('restarts only after onboarding settings are committed', async () => {
    const result = await handler(IPC.completeOnboarding)(event, {
      cliPaths: { 'cursor-agent': '/opt/cursor-agent' },
    });

    expect(mocks.updateSettings).toHaveBeenCalledWith({
      onboardingComplete: true,
      onboardingProgress: null,
      cliPaths: { 'cursor-agent': '/opt/cursor-agent' },
    });
    expect(restart).toHaveBeenCalledOnce();
    expect(mocks.updateSettings.mock.invocationCallOrder[0]).toBeLessThan(
      restart.mock.invocationCallOrder[0]!,
    );
    expect(result).toMatchObject({ onboardingComplete: true });
  });
});

describe('registerIpc terminal channels', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const terminals = {
    create: vi.fn(async () => undefined),
    write: vi.fn(),
    resize: vi.fn(),
    ack: vi.fn(),
    kill: vi.fn(),
    disposeOwner: vi.fn(),
  };
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const mainFrame = { name: 'top' };
  const sender = {
    id: 7,
    mainFrame,
    once: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    }),
    on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    }),
  };
  const event = { sender, senderFrame: mainFrame };
  const fromSubframe = { sender, senderFrame: { name: 'iframe' } };
  const fire = (name: string, ...args: unknown[]): void =>
    (listeners.get(name) ?? []).forEach((listener) => listener(...args));

  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    mocks.handlers.clear();
    registerIpc(
      {} as DaemonSupervisor,
      {} as UpdateService,
      terminals as unknown as TerminalSessions,
    );
  });

  it('starts a shell for the SENDER, validated, and watches that window once', async () => {
    const input = { id: ID, cwd: '/proj', cols: 80, rows: 24 };
    await handler(IPC.terminalCreate)(event, input);
    await handler(IPC.terminalCreate)(event, {
      ...input,
      id: crypto.randomUUID(),
    });

    expect(terminals.create).toHaveBeenCalledWith(sender, input);
    expect(listeners.get('destroyed')).toHaveLength(1);
    expect(listeners.get('did-navigate')).toHaveLength(1);
  });

  it('refuses a relative folder, an unknown key and a malformed id before anything spawns', () => {
    expect(() =>
      handler(IPC.terminalCreate)(event, {
        id: ID,
        cwd: 'proj',
        cols: 80,
        rows: 24,
      }),
    ).toThrow();
    expect(() =>
      handler(IPC.terminalCreate)(event, {
        id: ID,
        cols: 80,
        rows: 24,
        shell: '/bin/evil',
      }),
    ).toThrow();
    expect(() => handler(IPC.terminalWrite)(event, '../x', 'ls\r')).toThrow();
    expect(terminals.create).not.toHaveBeenCalled();
    expect(terminals.write).not.toHaveBeenCalled();
  });

  it('answers the top-level page only, never a subframe', () => {
    expect(() =>
      handler(IPC.terminalCreate)(fromSubframe, { id: ID, cols: 80, rows: 24 }),
    ).toThrow(/top-level page/);
    expect(() => handler(IPC.terminalWrite)(fromSubframe, ID, 'ls\r')).toThrow(
      /top-level page/,
    );
    expect(() => handler(IPC.terminalResize)(fromSubframe, ID, 80, 24)).toThrow(
      /top-level page/,
    );
    expect(() => handler(IPC.terminalKill)(fromSubframe, ID)).toThrow(
      /top-level page/,
    );
    expect(() => handler(IPC.terminalAck)(fromSubframe, ID, 10)).toThrow(
      /top-level page/,
    );
    expect(terminals.ack).not.toHaveBeenCalled();
    expect(terminals.create).not.toHaveBeenCalled();
    expect(terminals.write).not.toHaveBeenCalled();
    expect(terminals.resize).not.toHaveBeenCalled();
    expect(terminals.kill).not.toHaveBeenCalled();
  });

  it('routes keystrokes, sizes and kills to the sender’s own shells', async () => {
    await handler(IPC.terminalWrite)(event, ID, 'ls\r');
    await handler(IPC.terminalResize)(event, ID, 120, 40);
    await handler(IPC.terminalKill)(event, ID);
    await handler(IPC.terminalAck)(event, ID, 42);
    expect(() => handler(IPC.terminalAck)(event, ID, -1)).toThrow();

    expect(terminals.write).toHaveBeenCalledWith(sender, ID, 'ls\r');
    expect(terminals.resize).toHaveBeenCalledWith(sender, ID, 120, 40);
    expect(terminals.kill).toHaveBeenCalledWith(sender, ID);
    expect(terminals.ack.mock.calls).toEqual([[sender, ID, 42]]);
  });

  it('ends a window’s shells on close, crash and a COMMITTED navigation — never on one that was only started', async () => {
    await handler(IPC.terminalCreate)(event, { id: ID, cols: 80, rows: 24 });

    // A navigation `will-navigate` goes on to block still fires this one.
    fire('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(terminals.disposeOwner).not.toHaveBeenCalled();

    fire('did-navigate');
    fire('render-process-gone');
    fire('destroyed');
    expect(terminals.disposeOwner.mock.calls).toEqual([[7], [7], [7]]);
  });
});

describe('registerIpc line-measurement flush', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    registerIpc({} as DaemonSupervisor, {} as UpdateService, noTerminals);
  });

  it('takes the answer of the window that was asked, and no other answer for that request', async () => {
    // The quit waits on this answer before it stops the daemon, so the answer is the channel's whole job.
    const asked: string[] = [];
    let settled = false;
    void lineMeasurementFlush
      .request(
        [
          {
            id: 7,
            send: (requestId: string) => {
              asked.push(requestId);
            },
          },
        ],
        () => undefined,
      )
      .then(() => {
        settled = true;
      });
    const [requestId = ''] = asked;

    // Another window's answer, and an answer to a request nobody made, do not settle the quit.
    handler(IPC.lineMeasurementsFlushed)({ sender: { id: 8 } }, requestId);
    handler(IPC.lineMeasurementsFlushed)(
      { sender: { id: 7 } },
      'no-such-request',
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    handler(IPC.lineMeasurementsFlushed)({ sender: { id: 7 } }, requestId);
    await vi.waitFor(() => {
      expect(settled).toBe(true);
    });

    // An empty id is refused by the schema before it reaches the flush.
    expect(() =>
      handler(IPC.lineMeasurementsFlushed)({ sender: { id: 7 } }, ''),
    ).toThrow(ZodError);
  });
});

describe('registerIpc remote-access channels', () => {
  // Annotated, and carrying a real device: with `devices: []` the entries are
  // inferred `never` (which is a type error the moment a field is read) and
  // the redaction loop below runs zero times — so the tokenHash pin would
  // have passed against any redactor at all, including one that blanked
  // nothing.
  const rawState: RemoteAccessState = {
    enabled: true,
    listening: true,
    port: 47616,
    hostUrl: 'http://geniro-mac.local:47616',
    addressUrl: 'http://192.168.1.42:47616',
    pairingCode: '482917',
    pairingCodeExpiresAt: '2026-09-21T12:30:00.000Z',
    devices: [
      {
        id: 'device-1',
        tokenHash: 'a'.repeat(64),
        label: 'iPhone',
        pairedAt: '2026-09-21T12:00:00.000Z',
        lastSeenAt: '2026-09-21T12:25:00.000Z',
      },
      {
        id: 'device-2',
        tokenHash: 'b'.repeat(64),
        label: 'iPad',
        pairedAt: '2026-09-20T09:00:00.000Z',
        lastSeenAt: '2026-09-21T11:00:00.000Z',
      },
    ],
    unavailableReason: null,
    tunnel: TUNNEL_OFF,
  };
  const remoteAccess = {
    state: vi.fn(() => rawState),
    regenerateCode: vi.fn(() => rawState),
    revokeDevice: vi.fn(() => rawState),
  };
  let registry: ReturnType<typeof registerIpc>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    registry = registerIpc(
      {} as DaemonSupervisor,
      {} as UpdateService,
      noTerminals,
      () => remoteAccess as unknown as RemoteAccess,
    );
  });

  // The DESKTOP call — through the plain handler, as `ipc.ts` itself invokes
  // it — must keep both fields; only the REMOTE bridge redacts them.
  it('the handler itself answers the pairing code in full (the desktop path)', async () => {
    expect(await handler(IPC.getRemoteAccess)({})).toEqual(rawState);
    expect(await handler(IPC.regenerateRemotePairingCode)({})).toEqual(
      rawState,
    );
    expect(
      await handler(IPC.revokeRemoteDevice)(
        {},
        '11111111-1111-4111-8111-111111111111',
      ),
    ).toEqual(rawState);
  });

  // A paired phone polling `getRemoteAccess` (or calling the other two) must
  // never learn the live pairing code — otherwise it can hand the code to
  // another device and enrol it without ever touching the Mac. This is what
  // the LAN gateway's bridge applies before a remote reply leaves the
  // process; see `remote-routes.ts`'s `bridge()`.
  it('blanks pairingCode/pairingCodeExpiresAt for all three channels, over the remote policy', () => {
    for (const channel of [
      IPC.getRemoteAccess,
      IPC.regenerateRemotePairingCode,
      IPC.revokeRemoteDevice,
    ]) {
      const entry = registry.get(channel);
      if (
        !entry ||
        entry.policy.remote !== 'allow' ||
        !entry.policy.redactForRemote
      ) {
        throw new Error(`${channel} carries no redactForRemote`);
      }
      const redacted = entry.policy.redactForRemote(
        rawState,
      ) as typeof rawState;
      expect(redacted.pairingCode).toBeNull();
      expect(redacted.pairingCodeExpiresAt).toBeNull();
      // The device LIST still crosses — a paired caller is meant to see which
      // devices are enrolled — but each `tokenHash` is blanked: it is a
      // credential digest, nothing renders it, and it buys a remote reader
      // nothing the rest of the row does not already say.
      expect(redacted.devices).toHaveLength(rawState.devices.length);
      for (const [index, device] of redacted.devices.entries()) {
        const raw = rawState.devices[index]!;
        expect(device.tokenHash).toBe('');
        expect(device.id).toBe(raw.id);
        expect(device.label).toBe(raw.label);
        expect(device.pairedAt).toBe(raw.pairedAt);
        expect(device.lastSeenAt).toBe(raw.lastSeenAt);
      }
      // And nothing else about the state is withheld.
      expect(redacted.hostUrl).toBe(rawState.hostUrl);
    }
  });

  // A phone must not choose what command an upload runs, nor let agents
  // publish pages through the Mac user's own logins.
  it('refuses a remote settings write that touches sharing, and only that', () => {
    const entry = registry.get(IPC.updateSettings);
    if (!entry || entry.policy.remote !== 'allow') {
      throw new Error('updateSettings is not remotely callable');
    }
    expect(
      entry.policy.refuseRemoteArgs?.([
        {
          sharing: {
            destinations: [],
            defaultDestinationId: null,
            agentsMayShare: true,
            autoRevokeAfterDays: null,
          },
        },
      ]),
    ).toContain('sharing');
    expect(
      entry.policy.refuseRemoteArgs?.([{ sidebarCollapsed: true }]),
    ).toBeFalsy();
  });

  it('a paired device cannot arm the sweep', () => {
    const entry = registry.get(IPC.updateSettings);
    if (!entry || entry.policy.remote !== 'allow') {
      throw new Error('updateSettings is not remotely callable');
    }
    expect(
      entry.policy.refuseRemoteArgs?.([{ memoryAutoForgetAfterDays: 30 }]),
    ).toContain('memoryAutoForgetAfterDays');
    expect(
      entry.policy.refuseRemoteArgs?.([{ memoryAutoForgetAfterDays: null }]),
    ).toContain('memoryAutoForgetAfterDays');
  });

  it('a paired device cannot pick what a lessons reflection runs as', () => {
    const entry = registry.get(IPC.updateSettings);
    if (!entry || entry.policy.remote !== 'allow') {
      throw new Error('updateSettings is not remotely callable');
    }
    expect(
      entry.policy.refuseRemoteArgs?.([
        {
          lessons: {
            mode: 'offer',
            agentKind: 'claude',
            model: 'opus',
            effort: null,
          },
        },
      ]),
    ).toContain('lessons');
  });

  it('a paired device cannot change or switch off the resource alerts', () => {
    const entry = registry.get(IPC.updateSettings);
    if (!entry || entry.policy.remote !== 'allow') {
      throw new Error('updateSettings is not remotely callable');
    }
    expect(
      entry.policy.refuseRemoteArgs?.([
        {
          resourceAlerts: {
            ...DEFAULT_RESOURCE_ALERTS,
            enabled: false,
          },
        },
      ]),
    ).toContain('resourceAlerts');
    expect(
      entry.policy.refuseRemoteArgs?.([
        { resourceAlerts: DEFAULT_RESOURCE_ALERTS, sidebarCollapsed: true },
      ]),
    ).toContain('resourceAlerts');
  });
});

describe('registerIpc getChangesSince', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    registerIpc({} as DaemonSupervisor, {} as UpdateService, noTerminals);
  });

  it('hands the read only the pull requests git may be told about', async () => {
    const sha = 'a'.repeat(40);
    const pullRequest = {
      repository: 'acme/platform',
      headRefName: 'feature/top',
      baseRefName: 'feature/stack',
    };

    await handler(IPC.getChangesSince)({}, '/repo', sha, true, [
      { ...pullRequest, baseRefName: '--upload-pack=x' },
      pullRequest,
    ]);

    expect(mocks.readChangesSince).toHaveBeenCalledWith('/repo', sha, true, [
      pullRequest,
    ]);
  });
});

describe('registerIpc listWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    registerIpc({} as DaemonSupervisor, {} as UpdateService, noTerminals);
  });

  it('narrows the listing to worktrees made since the thread started, never geniro’s task worktrees', async () => {
    // The user's ownership rule lives here: a candidate must be made during
    // the thread, and a task worktree is another card's however often named.
    await handler(IPC.listWorktrees)({}, '/repo', 1_792_064_959_590);

    expect(mocks.readLinkedWorktrees).toHaveBeenCalledWith('/repo', {
      createdAfterMs: 1_792_064_959_590,
      // Unresolvable here, so it falls back to the root as given.
      tasksRoot: '/no/such/userData/worktrees',
    });
  });

  it('names geniro’s task worktrees by their resolved folder, as git lists them', async () => {
    // userData can sit behind a symlink; git prints real paths, so an
    // unresolved root would match no worktree and exclude nothing.
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-tasks-')));
    const link = `${real}-link`;
    symlinkSync(real, link);
    mocks.worktreesRoot.mockReturnValueOnce(link).mockReturnValueOnce(link);
    try {
      await handler(IPC.listWorktrees)({}, '/repo', 1);

      expect(mocks.readLinkedWorktrees).toHaveBeenCalledWith('/repo', {
        createdAfterMs: 1,
        tasksRoot: real,
      });
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('refuses a thread start that is not an instant', async () => {
    await expect(
      handler(IPC.listWorktrees)({}, '/repo', -1),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      handler(IPC.listWorktrees)({}, '/repo', 1.5),
    ).rejects.toBeInstanceOf(ZodError);
    expect(mocks.readLinkedWorktrees).not.toHaveBeenCalled();
  });
});

describe('registerIpc browser channels', () => {
  const setBounds = vi.fn();
  const openTab = vi.fn(async () => 't1');
  const noteUserAddress = vi.fn();
  const labelTab = vi.fn();
  const browser = { setBounds, openTab, noteUserAddress, labelTab };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    registerIpc(
      {} as unknown as DaemonSupervisor,
      {} as UpdateService,
      noTerminals,
      undefined,
      undefined,
      () => browser as never,
    );
  });

  it('refuses bounds that are negative or not finite before the service hears of them', () => {
    expect(() =>
      handler(IPC.browserSetBounds)({}, 'run-1', {
        x: -1,
        y: 0,
        width: 10,
        height: 10,
      }),
    ).toThrow(ZodError);
    expect(() =>
      handler(IPC.browserSetBounds)({}, 'run-1', {
        x: 0,
        y: 0,
        width: Number.POSITIVE_INFINITY,
        height: 10,
      }),
    ).toThrow(ZodError);
    expect(setBounds).not.toHaveBeenCalled();
  });

  it("passes valid bounds, and null to hide, with the sending window's BrowserWindow", () => {
    const bounds = { x: 1, y: 2, width: 300, height: 200 };
    const sender = { id: 7 };

    handler(IPC.browserSetBounds)({ sender }, 'run-1', bounds);
    handler(IPC.browserSetBounds)({ sender }, 'run-1', null);

    expect(mocks.fromWebContents).toHaveBeenCalledWith(sender);
    expect(setBounds).toHaveBeenNthCalledWith(1, 'run-1', bounds, { sender });
    expect(setBounds).toHaveBeenNthCalledWith(2, 'run-1', null, { sender });
  });

  it('labels a tab as the user and refuses a colour outside the palette', () => {
    handler(IPC.browserLabelTab)({}, 'run-1', 't2', {
      name: 'Docs',
      color: 'teal',
    });

    expect(labelTab).toHaveBeenCalledWith(
      'run-1',
      't2',
      { name: 'Docs', color: 'teal' },
      'user',
    );
    expect(() =>
      handler(IPC.browserLabelTab)({}, 'run-1', 't2', { color: 'magenta' }),
    ).toThrow(ZodError);
    expect(() =>
      handler(IPC.browserLabelTab)({}, 'run-1', 't2', {
        name: 'x'.repeat(61),
      }),
    ).toThrow(ZodError);
    expect(() =>
      handler(IPC.browserLabelTab)({}, 'run-1', 't2', { name: 'a\u202eb' }),
    ).toThrow(ZodError);
  });

  it('opens a typed address as the user, resolving bare words and hosts', async () => {
    await handler(IPC.browserOpenTab)({}, 'run-1', 'localhost:3000');

    expect(openTab).toHaveBeenCalledWith('run-1', 'http://localhost:3000', {
      openedBy: null,
    });
    expect(noteUserAddress).toHaveBeenCalledWith(
      'run-1',
      'http://localhost:3000',
    );
  });

  it('refuses an address over 8192 characters', () => {
    expect(() =>
      handler(IPC.browserNavigate)({}, 'run-1', 't1', 'a'.repeat(8193)),
    ).toThrow(ZodError);
  });
});
