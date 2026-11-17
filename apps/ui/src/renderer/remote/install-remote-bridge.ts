import type { DaemonHandle } from '../../shared/contracts';
import { type GeniroApi, IPC } from '../../shared/contracts';
import {
  REMOTE_CSRF_HEADER,
  REMOTE_ROUTE_BRIDGE,
  type RemoteBridgeRequest,
  type RemoteBridgeResponse,
  type RemoteRefusal,
} from '../../shared/remote';

/**
 * A bridge call refused because the channel is native-only — see
 * `RemoteRefusal` in `shared/remote.ts`.
 *
 * Its own error class rather than a plain `Error` with the sentence baked in,
 * so a caller can tell a PERMANENT refusal (grey the control out, never
 * retry) from a TRANSIENT transport failure (a network hiccup, worth a
 * retry) by `instanceof` rather than by parsing a message string.
 */
export class RemoteChannelDeniedError extends Error {
  readonly channel: string;
  readonly reason: string;

  constructor(refusal: RemoteRefusal) {
    super(`'${refusal.channel}' has no remote answer: ${refusal.reason}`);
    this.name = 'RemoteChannelDeniedError';
    this.channel = refusal.channel;
    this.reason = refusal.reason;
  }
}

/**
 * One round trip to `REMOTE_ROUTE_BRIDGE`: post `{channel, args}`, unwrap the
 * reply. Exactly one of `value` / `error` / `refusal` is set on a
 * `RemoteBridgeResponse` (see `remote.types.ts`), so the three are checked in
 * that order and the first present one decides the outcome.
 */
async function callBridge(channel: string, args: unknown[]): Promise<unknown> {
  const request: RemoteBridgeRequest = { channel, args };
  const response = await fetch(REMOTE_ROUTE_BRIDGE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      [REMOTE_CSRF_HEADER]: '1',
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(
      `remote bridge call '${channel}' failed with HTTP ${response.status}`,
    );
  }
  const reply = (await response.json()) as RemoteBridgeResponse;
  if (reply.refusal) {
    throw new RemoteChannelDeniedError(reply.refusal);
  }
  if (reply.error !== undefined) {
    throw new Error(reply.error);
  }
  return reply.value;
}

/** One channel's call, with `args` defaulting to none. */
function invoke(channel: string, args: unknown[] = []): Promise<unknown> {
  return callBridge(channel, args);
}

/**
 * The daemon coordinates a BROWSER must use: this page's own origin, and no
 * token.
 *
 * Both halves are load-bearing and neither is what the desktop gets. The
 * ADDRESS, because the real handle names `127.0.0.1` — the daemon binds
 * loopback and always will — which on a phone is the PHONE's loopback, so a
 * renderer handed the true handle talks to itself and the whole feature is
 * dead. Everything must go to the gateway that serves this page, which then
 * proxies to the daemon over its own loopback.
 *
 * And no TOKEN, because the gateway supplies the daemon's own credential
 * server-side on every proxied call (`daemon-proxy.ts`). Sending one from
 * here would be strictly worse than useless: it would mean the phone held
 * the master key to the daemon, over plain HTTP on a shared network. The
 * empty string is what the `/ws` handshake needs too — the daemon reads the
 * `auth` token first and falls through to the query when it is empty, and
 * the query is the carrier the gateway rewrites.
 *
 * The SCHEME and the PORT follow the page too. Behind a tunnel the page is
 * `https://<name>.trycloudflare.com` — the default port, so `location.port`
 * is the EMPTY string, and `Number('')` is 0: every request went to
 * `http://<name>:0`, which is both a port nothing listens on and plain http
 * from an https page, refused as mixed content. On the Wi-Fi the page carries
 * the gateway's own port and http, so that path is unchanged.
 */
export function gatewayHandle(
  base: DaemonHandle,
  location: Pick<Location, 'hostname' | 'port' | 'protocol'> = window.location,
): DaemonHandle {
  const secure = location.protocol === 'https:';
  return {
    ...base,
    host: location.hostname,
    port: location.port ? Number(location.port) : secure ? 443 : 80,
    token: '',
    secure,
  };
}

/**
 * The remote runtime's answer to both handle-shaped channels.
 *
 * Derived from `getStatus` rather than `getDaemonHandle`, which is refused
 * remotely precisely because it is nothing but the credential: what is left
 * that a client legitimately needs — the daemon's version and when it
 * started — rides the status reply, whose own token the gateway has already
 * blanked.
 */
async function remoteDaemonHandle(): Promise<DaemonHandle | null> {
  const status = (await invoke(IPC.getStatus)) as Awaited<
    ReturnType<GeniroApi['getStatus']>
  >;
  return status.daemon?.handle ? gatewayHandle(status.daemon.handle) : null;
}

/**
 * A subscription with nothing to subscribe TO, for this slice.
 *
 * The `on*` members of {@link GeniroApi} are a PUSH from main over Electron
 * IPC — there is no request/response call that could stand in for one. A real
 * push channel over the gateway (SSE on `REMOTE_ROUTE_EVENTS`, or a second
 * WebSocket) is a later slice; until then a no-op that unsubscribes cleanly
 * is strictly better than a throw that would break the first render of every
 * screen that mounts one of these listeners (several do, unconditionally).
 */
function noSubscription(): () => void {
  return () => undefined;
}

/** The in-app browser runs only on the Mac; a paired device never reaches it. */
function browserOnTheMac(): Promise<never> {
  return Promise.reject(new Error('The browser runs on your Mac'));
}

/**
 * Install `window.geniro` over HTTP when there is no preload to provide it.
 *
 * Typed as {@link GeniroApi} rather than cast to it — the same discipline
 * `__fixtures__/preload-stub.ts` follows for the Storybook double — so a
 * channel added to that interface stops THIS file compiling instead of
 * silently answering `undefined` to a phone in production. Every method
 * proxies to {@link invoke} under the SAME channel name the real preload
 * dispatches on (`IPC.*`): the gateway's own handler registry is what maps a
 * channel to a handler, and giving the bridge its own parallel vocabulary of
 * channel names would be a second place for the two to drift apart.
 */
export function installRemoteBridge(): void {
  // A LIVE read, deliberately not `isRemoteRuntime()`. The two look like the
  // same question and are not: this one is "is a bridge already here, which I
  // must not clobber", asked at the moment of installing, while
  // `isRemoteRuntime()` answers "was this bundle loaded in a browser" and is
  // captured before this function can change the answer. Asking the captured
  // one here would be harmless today and wrong the first time anything
  // installs a bridge after module evaluation — a spec, or a second call.
  if (typeof window === 'undefined' || window.geniro !== undefined) {
    return;
  }

  const api: GeniroApi = {
    getStatus: async () => {
      const status = (await invoke(IPC.getStatus)) as Awaited<
        ReturnType<GeniroApi['getStatus']>
      >;
      // Guarded rather than assumed: this value came off the wire, and a
      // reply that is not status-shaped should degrade to "no handle" rather
      // than throw a TypeError out of the first call the app makes.
      if (!status.daemon?.handle) {
        return status;
      }
      return {
        ...status,
        daemon: {
          ...status.daemon,
          handle: gatewayHandle(status.daemon.handle),
        },
      };
    },
    getDaemonHandle: () => remoteDaemonHandle(),
    // Main blanks this handle's token and address for a remote caller (as it
    // does `getStatus`'s), so what comes back is pointed at the gateway here.
    ensureDaemon: async () =>
      gatewayHandle((await invoke(IPC.ensureDaemon)) as DaemonHandle),
    onDaemonRestarted: () => noSubscription(),
    onDaemonMigrating: () => noSubscription(),
    onClearAgentCaches: () => noSubscription(),
    onFlushLineMeasurements: () => noSubscription(),
    onSettingsChanged: () => noSubscription(),
    pickProjectFolder: (defaultPath?: string) =>
      invoke(IPC.pickProjectFolder, [defaultPath]) as ReturnType<
        GeniroApi['pickProjectFolder']
      >,
    pickAgentBinary: () =>
      invoke(IPC.pickAgentBinary) as ReturnType<GeniroApi['pickAgentBinary']>,
    pickTaskFiles: () =>
      invoke(IPC.pickTaskFiles) as ReturnType<GeniroApi['pickTaskFiles']>,
    getSettings: () =>
      invoke(IPC.getSettings) as ReturnType<GeniroApi['getSettings']>,
    updateSettings: (patch) =>
      invoke(IPC.updateSettings, [patch]) as ReturnType<
        GeniroApi['updateSettings']
      >,
    detectClis: (options) =>
      invoke(
        IPC.detectClis,
        options === undefined ? [] : [options],
      ) as ReturnType<GeniroApi['detectClis']>,
    updateCli: (kind) =>
      invoke(IPC.updateCli, [kind]) as ReturnType<GeniroApi['updateCli']>,
    getCliUpdates: () =>
      invoke(IPC.getCliUpdates) as ReturnType<GeniroApi['getCliUpdates']>,
    forgetCliUpdateResults: () =>
      invoke(IPC.forgetCliUpdateResults) as ReturnType<
        GeniroApi['forgetCliUpdateResults']
      >,
    onCliUpdates: () => noSubscription(),
    createConfigProfileDir: (agent, name) =>
      invoke(IPC.createConfigProfileDir, [agent, name]) as ReturnType<
        GeniroApi['createConfigProfileDir']
      >,
    installCli: (kind) =>
      invoke(IPC.installCli, [kind]) as ReturnType<GeniroApi['installCli']>,
    completeOnboarding: (input) =>
      invoke(IPC.completeOnboarding, [input]) as ReturnType<
        GeniroApi['completeOnboarding']
      >,
    pickTeamImport: () =>
      invoke(IPC.pickTeamImport) as ReturnType<GeniroApi['pickTeamImport']>,
    pickTeamExport: (defaultName) =>
      invoke(IPC.pickTeamExport, [defaultName]) as ReturnType<
        GeniroApi['pickTeamExport']
      >,
    getUpdateState: () =>
      invoke(IPC.getUpdateState) as ReturnType<GeniroApi['getUpdateState']>,
    checkForUpdates: () =>
      invoke(IPC.checkForUpdates) as ReturnType<GeniroApi['checkForUpdates']>,
    installUpdate: () =>
      invoke(IPC.installUpdate) as ReturnType<GeniroApi['installUpdate']>,
    relaunchForUpdate: () =>
      invoke(IPC.relaunchForUpdate) as ReturnType<
        GeniroApi['relaunchForUpdate']
      >,
    onUpdateState: () => noSubscription(),
    getGitInfo: (dir) =>
      invoke(IPC.getGitInfo, [dir]) as ReturnType<GeniroApi['getGitInfo']>,
    getGitStamp: (dir) =>
      invoke(IPC.getGitStamp, [dir]) as ReturnType<GeniroApi['getGitStamp']>,
    getGitHead: (dir) =>
      invoke(IPC.getGitHead, [dir]) as ReturnType<GeniroApi['getGitHead']>,
    getChangesSince: (dir, sha, workFolder, pullRequests) =>
      invoke(IPC.getChangesSince, [
        dir,
        sha,
        workFolder,
        pullRequests,
      ]) as ReturnType<GeniroApi['getChangesSince']>,
    listWorktrees: (dir, startedAtMs) =>
      invoke(IPC.listWorktrees, [dir, startedAtMs]) as ReturnType<
        GeniroApi['listWorktrees']
      >,
    getChangesTotals: (dir, sha) =>
      invoke(IPC.getChangesTotals, [dir, sha]) as ReturnType<
        GeniroApi['getChangesTotals']
      >,
    lineMeasurementsFlushed: (requestId) =>
      invoke(IPC.lineMeasurementsFlushed, [requestId]) as ReturnType<
        GeniroApi['lineMeasurementsFlushed']
      >,
    getPullRequestsByRef: (refs) =>
      invoke(IPC.getPullRequestsByRef, [refs]) as ReturnType<
        GeniroApi['getPullRequestsByRef']
      >,
    openInTerminal: (input) =>
      invoke(IPC.openInTerminal, [input]) as ReturnType<
        GeniroApi['openInTerminal']
      >,
    terminalCreate: (input) =>
      invoke(IPC.terminalCreate, [input]) as ReturnType<
        GeniroApi['terminalCreate']
      >,
    terminalWrite: (id, data) =>
      invoke(IPC.terminalWrite, [id, data]) as ReturnType<
        GeniroApi['terminalWrite']
      >,
    terminalResize: (id, cols, rows) =>
      invoke(IPC.terminalResize, [id, cols, rows]) as ReturnType<
        GeniroApi['terminalResize']
      >,
    terminalAck: (id, chars) =>
      invoke(IPC.terminalAck, [id, chars]) as ReturnType<
        GeniroApi['terminalAck']
      >,
    terminalKill: (id) =>
      invoke(IPC.terminalKill, [id]) as ReturnType<GeniroApi['terminalKill']>,
    onTerminalData: () => noSubscription(),
    onTerminalExit: () => noSubscription(),
    saveChatExport: (input) =>
      invoke(IPC.saveChatExport, [input]) as ReturnType<
        GeniroApi['saveChatExport']
      >,
    saveArtifact: (input) =>
      invoke(IPC.saveArtifact, [input]) as ReturnType<
        GeniroApi['saveArtifact']
      >,
    saveMemoryExport: (markdown) =>
      invoke(IPC.saveMemoryExport, [markdown]) as ReturnType<
        GeniroApi['saveMemoryExport']
      >,
    saveKnowledgeExport: (input) =>
      invoke(IPC.saveKnowledgeExport, [input]) as ReturnType<
        GeniroApi['saveKnowledgeExport']
      >,
    prepareTaskWorktree: (input) =>
      invoke(IPC.prepareTaskWorktree, [input]) as ReturnType<
        GeniroApi['prepareTaskWorktree']
      >,
    pruneTaskWorktree: (taskId) =>
      invoke(IPC.pruneTaskWorktree, [taskId]) as ReturnType<
        GeniroApi['pruneTaskWorktree']
      >,
    settleTaskWorktree: (taskId) =>
      invoke(IPC.settleTaskWorktree, [taskId]) as ReturnType<
        GeniroApi['settleTaskWorktree']
      >,
    switchBranch: (dir, branch) =>
      invoke(IPC.switchBranch, [dir, branch]) as ReturnType<
        GeniroApi['switchBranch']
      >,
    pullBranch: (dir) =>
      invoke(IPC.pullBranch, [dir]) as ReturnType<GeniroApi['pullBranch']>,
    carryChangesToBranch: (dir, branch) =>
      invoke(IPC.carryChangesToBranch, [dir, branch]) as ReturnType<
        GeniroApi['carryChangesToBranch']
      >,
    revealPath: (path) =>
      invoke(IPC.revealPath, [path]) as ReturnType<GeniroApi['revealPath']>,
    openArtifactPath: (path) =>
      invoke(IPC.openArtifactPath, [path]) as ReturnType<
        GeniroApi['openArtifactPath']
      >,
    getAppStorage: (unclaimed) =>
      invoke(IPC.getAppStorage, [unclaimed]) as ReturnType<
        GeniroApi['getAppStorage']
      >,
    removeStorageWorktree: (name) =>
      invoke(IPC.removeStorageWorktree, [name]) as ReturnType<
        GeniroApi['removeStorageWorktree']
      >,
    clearBrowserCache: () =>
      invoke(IPC.clearBrowserCache) as ReturnType<
        GeniroApi['clearBrowserCache']
      >,
    restartDaemon: () =>
      invoke(IPC.restartDaemon) as ReturnType<GeniroApi['restartDaemon']>,
    toggleDevTools: () =>
      invoke(IPC.toggleDevTools) as ReturnType<GeniroApi['toggleDevTools']>,
    notify: (notification) =>
      invoke(IPC.notify, [notification]) as ReturnType<GeniroApi['notify']>,
    retractNotification: (runId) =>
      invoke(IPC.retractNotification, [runId]) as ReturnType<
        GeniroApi['retractNotification']
      >,
    testNotification: () =>
      invoke(IPC.testNotification) as ReturnType<GeniroApi['testNotification']>,
    openNotificationSettings: () =>
      invoke(IPC.openNotificationSettings) as ReturnType<
        GeniroApi['openNotificationSettings']
      >,
    onNotificationActivated: () => noSubscription(),
    getRemoteAccess: () =>
      invoke(IPC.getRemoteAccess) as ReturnType<GeniroApi['getRemoteAccess']>,
    regenerateRemotePairingCode: () =>
      invoke(IPC.regenerateRemotePairingCode) as ReturnType<
        GeniroApi['regenerateRemotePairingCode']
      >,
    revokeRemoteDevice: (deviceId) =>
      invoke(IPC.revokeRemoteDevice, [deviceId]) as ReturnType<
        GeniroApi['revokeRemoteDevice']
      >,
    // Proxied like every other channel rather than refused here, and that is
    // deliberate: both are `denyRemotely` in `ipc.ts`, so the REGISTRY is what
    // refuses them and the phone gets the typed `RemoteRefusal` the shim
    // already knows how to render. Short-circuiting in the browser would put
    // a second copy of that policy on the untrusted side of the boundary,
    // where it decides nothing and can only come to disagree with the copy
    // that does.
    startRemoteTunnel: () =>
      invoke(IPC.startRemoteTunnel) as ReturnType<
        GeniroApi['startRemoteTunnel']
      >,
    stopRemoteTunnel: () =>
      invoke(IPC.stopRemoteTunnel) as ReturnType<GeniroApi['stopRemoteTunnel']>,
    browserState: () => browserOnTheMac(),
    browserOpenTab: () => browserOnTheMac(),
    browserNavigate: () => browserOnTheMac(),
    browserHistory: () => browserOnTheMac(),
    browserCloseTab: () => browserOnTheMac(),
    browserSelectTab: () => browserOnTheMac(),
    browserSetBounds: () => browserOnTheMac(),
    browserPopOut: () => browserOnTheMac(),
    browserDock: () => browserOnTheMac(),
    browserTabAction: () => browserOnTheMac(),
    browserContinueInsecure: () => browserOnTheMac(),
    browserAnswerAuth: () => browserOnTheMac(),
    browserCapture: () => browserOnTheMac(),
    browserForgetRun: () => browserOnTheMac(),
    browserStopAgent: () => browserOnTheMac(),
    browserLabelTab: () => browserOnTheMac(),
    browserAgentRequest: () => browserOnTheMac(),
    onBrowserState: () => noSubscription(),
    // PRELOAD-LOCAL (`PreloadLocalMethod` in contracts.ts) — the real preload
    // answers this from `webUtils.getPathForFile`, a synchronous RENDERER-side
    // Electron API with no IPC channel at all, because a `File` cannot cross
    // to main. A browser has no such API and, unlike Electron, never exposes a
    // dropped or pasted file's real filesystem path to a page — that is a
    // deliberate browser security boundary, not a gap in this shim. So `null`
    // here is not a stub standing in for missing wiring; it is the honest
    // browser answer, and `chats/paste-file-paths.ts` already treats a null
    // path as "hand the paste back" rather than as a failure.
    filePath: () => null,
  };

  window.geniro = api;
}
