import {
  type BranchCarryResult,
  type BranchPullResult,
  type BranchSwitchResult,
  CLI_KINDS,
  type CliDetection,
  type CliInstallResult,
  type CliUpdateResult,
  type DaemonHandle,
  DEFAULT_SETTINGS,
  type FileSaveResult,
  type GeniroApi,
  type GitInfo,
  type PullRequestRefResult,
  type Settings,
  type TaskWorktreeResult,
  type TaskWorktreeSettleResult,
  type UpdateState,
} from '../../shared/contracts';
import { type RemoteAccessState, TUNNEL_OFF } from '../../shared/remote';

/**
 * A `window.geniro` that answers without Electron.
 *
 * Typed as {@link GeniroApi} rather than cast to it, which is the point: a
 * channel added to that interface stops this file compiling, so the catalog
 * cannot silently fall behind the preload bridge it is standing in for.
 *
 * Every answer here is a plausible EMPTY state — no folder chosen, no CLI
 * detected, no pull requests — so a caller sees a zero state rather than
 * fabricated data it might mistake for real behaviour.
 *
 * ONE double for the whole app: the Storybook catalog installs it whole, and a
 * spec passes `overrides` for the handful of channels it actually asserts on.
 * Before this existed each spec built its own bag of spies and reached the
 * bridge through `as unknown as Partial<GeniroApi>` — a double cast that
 * defeats exactly the guarantee the type here provides, so a channel added to
 * the interface broke nothing and every spec kept passing against a bridge that
 * no longer matched.
 *
 * Lives under `src/` rather than beside the Storybook config precisely so the
 * specs can reach it; nothing in production code imports it.
 */

const warned = new Set<string>();

/** Names the channel a story reached for, once, so the log stays readable. */
function note(channel: string): void {
  if (warned.has(channel)) {
    return;
  }
  warned.add(channel);
  console.info(`[storybook] window.geniro.${channel}() — stub answered`);
}

/** Subscriptions hand back a no-op unsubscribe; nothing ever pushes here. */
function noSubscription(channel: string): () => void {
  note(channel);
  return () => undefined;
}

const IDLE_UPDATE: UpdateState = {
  phase: 'idle',
  version: null,
  progress: null,
  message: null,
  failedPhase: null,
  currentVersion: '0.0.0-storybook',
  canInstall: false,
};

const NO_GIT: GitInfo = {
  isRepo: false,
  branch: null,
  branches: [],
  dirty: false,
  worktrees: [],
  worktreeOf: null,
};

/** The switch-off zero state: nothing listening, nothing to show. */
const REMOTE_ACCESS_OFF: RemoteAccessState = {
  enabled: false,
  listening: false,
  port: null,
  hostUrl: null,
  addressUrl: null,
  pairingCode: null,
  pairingCodeExpiresAt: null,
  devices: [],
  unavailableReason: null,
  tunnel: TUNNEL_OFF,
};

export function createPreloadStub(
  overrides: Partial<GeniroApi> = {},
): GeniroApi {
  // Settings are the one piece of state the stub keeps: `useSidebarCollapsed`
  // writes then re-reads, and a stub that forgot would make the rail's toggle
  // appear not to work.
  let settings: Settings = { ...DEFAULT_SETTINGS, onboardingComplete: true };

  return {
    getStatus: () => {
      note('getStatus');
      return Promise.resolve({
        onboardingComplete: settings.onboardingComplete,
        daemon: { connected: false, handle: null, migrating: null },
        isPackaged: false,
      });
    },
    getDaemonHandle: (): Promise<DaemonHandle | null> => {
      note('getDaemonHandle');
      return Promise.resolve(null);
    },
    // Rejects rather than inventing a handle: the catalog runs no daemon, and
    // a made-up address would send a Retry dialling nothing.
    ensureDaemon: (): Promise<DaemonHandle> => {
      note('ensureDaemon');
      return Promise.reject(new Error('the component catalog runs no daemon'));
    },
    onDaemonRestarted: () => noSubscription('onDaemonRestarted'),
    onDaemonMigrating: () => noSubscription('onDaemonMigrating'),
    onClearAgentCaches: () => noSubscription('onClearAgentCaches'),
    onFlushLineMeasurements: () => noSubscription('onFlushLineMeasurements'),
    onSettingsChanged: () => noSubscription('onSettingsChanged'),

    pickProjectFolder: () => {
      note('pickProjectFolder');
      return Promise.resolve(null);
    },
    pickAgentBinary: () => {
      note('pickAgentBinary');
      return Promise.resolve(null);
    },
    pickTaskFiles: () => {
      note('pickTaskFiles');
      return Promise.resolve([]);
    },
    pickTeamImport: () => {
      note('pickTeamImport');
      return Promise.resolve(null);
    },
    pickTeamExport: () => {
      note('pickTeamExport');
      return Promise.resolve(null);
    },

    getSettings: () => {
      note('getSettings');
      return Promise.resolve(settings);
    },
    updateSettings: (patch: Partial<Settings>) => {
      note('updateSettings');
      settings = { ...settings, ...patch };
      return Promise.resolve(settings);
    },
    completeOnboarding: () => {
      note('completeOnboarding');
      settings = { ...settings, onboardingComplete: true };
      return Promise.resolve(settings);
    },

    detectClis: (_options?: { maxAgeMs?: number }): Promise<CliDetection[]> => {
      note('detectClis');
      return Promise.resolve(
        CLI_KINDS.map((kind) => ({
          kind,
          found: false,
          path: null,
          version: null,
          loggedIn: null,
          update: {
            available: null,
            latestVersion: null,
            checkUnavailableReason: null,
          },
        })),
      );
    },

    updateCli: (kind): Promise<CliUpdateResult> => {
      note('updateCli');
      // The zero answer for a CLI this stub has already said is not installed —
      // populated outcomes come through props, like everything else here.
      return Promise.resolve({
        kind,
        ok: false,
        previousVersion: null,
        version: null,
        output: null,
        reason: null,
      });
    },

    installCli: (kind): Promise<CliInstallResult> => {
      note('installCli');
      return Promise.resolve({
        kind,
        ok: false,
        version: null,
        path: null,
        output: null,
        reason: null,
      });
    },

    getUpdateState: () => {
      note('getUpdateState');
      return Promise.resolve(IDLE_UPDATE);
    },
    checkForUpdates: () => {
      note('checkForUpdates');
      return Promise.resolve(IDLE_UPDATE);
    },
    installUpdate: () => {
      note('installUpdate');
      return Promise.resolve(IDLE_UPDATE);
    },
    relaunchForUpdate: () => {
      note('relaunchForUpdate');
      return Promise.resolve(IDLE_UPDATE);
    },
    onUpdateState: () => noSubscription('onUpdateState'),

    getGitInfo: () => {
      note('getGitInfo');
      return Promise.resolve(NO_GIT);
    },
    getGitStamp: () => {
      note('getGitStamp');
      // All null, matching NO_GIT beside it: the fixture's folder is not a
      // repository, so there is no commit to stamp and nothing was measured.
      return Promise.resolve({ sha: null, dirty: null });
    },
    getGitHead: () => {
      note('getGitHead');
      // Null for the reason `getGitStamp` is all null: the fixture's folder is not a repository.
      return Promise.resolve(null);
    },
    getChangesSince: () => {
      note('getChangesSince');
      // The reason a non-repository gives, so the view shows its own explained
      // empty state rather than an unexplained blank list.
      return Promise.resolve({
        changes: [],
        truncated: false,
        unavailableReason: 'Not a git repository.',
        movedOffStart: false,
        upstreamBase: null,
      });
    },
    listWorktrees: () => {
      note('listWorktrees');
      return Promise.resolve([]);
    },
    getChangesTotals: () => {
      note('getChangesTotals');
      // Null, as a folder that is not a repository gives nothing to measure
      // from — the same answer `getGitStamp` gives beside it.
      return Promise.resolve(null);
    },
    lineMeasurementsFlushed: () => {
      note('lineMeasurementsFlushed');
      return Promise.resolve();
    },
    prepareTaskWorktree: (input: {
      taskId: string;
      folder: string;
    }): Promise<TaskWorktreeResult> => {
      note('prepareTaskWorktree');
      return Promise.resolve({
        ok: true,
        path: `/tmp/geniro-worktrees/${input.taskId}`,
        branch: `geniro/task-${input.taskId}`,
        reused: false,
        error: null,
      });
    },
    pruneTaskWorktree: (): Promise<boolean> => {
      note('pruneTaskWorktree');
      return Promise.resolve(true);
    },
    settleTaskWorktree: (): Promise<TaskWorktreeSettleResult> => {
      note('settleTaskWorktree');
      return Promise.resolve({ removed: true, committed: true });
    },
    switchBranch: (
      _dir: string,
      branch: string,
    ): Promise<BranchSwitchResult> => {
      note('switchBranch');
      return Promise.resolve({
        ok: true,
        branch,
        error: null,
        dirty: false,
        worktree: null,
      });
    },
    pullBranch: (): Promise<BranchPullResult> => {
      note('pullBranch');
      return Promise.resolve({
        ok: true,
        branch: null,
        error: null,
        stashLeft: null,
      });
    },
    carryChangesToBranch: (
      _dir: string,
      branch: string,
    ): Promise<BranchCarryResult> => {
      note('carryChangesToBranch');
      return Promise.resolve({
        ok: true,
        branch,
        error: null,
        stashLeft: null,
      });
    },
    getPullRequestsByRef: (refs): Promise<PullRequestRefResult[]> => {
      note('getPullRequestsByRef');
      // The ref always comes back with a null state — the same shape a
      // logged-out `gh` produces, rather than dropping the row.
      return Promise.resolve(refs.map((ref) => ({ ref, pullRequest: null })));
    },

    openInTerminal: () => {
      note('openInTerminal');
      return Promise.resolve();
    },
    terminalCreate: () => {
      note('terminalCreate');
      return Promise.resolve();
    },
    terminalWrite: () => {
      note('terminalWrite');
      return Promise.resolve();
    },
    terminalResize: () => {
      note('terminalResize');
      return Promise.resolve();
    },
    terminalAck: () => {
      note('terminalAck');
      return Promise.resolve();
    },
    terminalKill: () => {
      note('terminalKill');
      return Promise.resolve();
    },
    onTerminalData: () => noSubscription('onTerminalData'),
    onTerminalExit: () => noSubscription('onTerminalExit'),
    saveChatExport: (): Promise<FileSaveResult> => {
      note('saveChatExport');
      // The cancel outcome: nothing here can write a file.
      return Promise.resolve({ saved: false, path: null });
    },
    saveArtifact: (): Promise<FileSaveResult> => {
      note('saveArtifact');
      // The cancel outcome, for `saveChatExport`'s reason.
      return Promise.resolve({ saved: false, path: null });
    },
    saveMemoryExport: (): Promise<FileSaveResult> => {
      note('saveMemoryExport');
      return Promise.resolve({ saved: false, path: null });
    },
    saveKnowledgeExport: (): Promise<FileSaveResult> => {
      note('saveKnowledgeExport');
      return Promise.resolve({ saved: false, path: null });
    },
    getAppStorage: () => {
      note('getAppStorage');
      return Promise.resolve({ worktrees: [], browserCache: [], appData: [] });
    },
    removeStorageWorktree: () => {
      note('removeStorageWorktree');
      return Promise.resolve({ removed: true, reason: null });
    },
    clearBrowserCache: () => {
      note('clearBrowserCache');
      return Promise.resolve({ freedBytes: 0 });
    },
    restartDaemon: () => {
      note('restartDaemon');
      return Promise.resolve();
    },
    revealPath: () => {
      note('revealPath');
      return Promise.resolve({
        revealed: false,
        reason: 'Storybook has no file manager to reveal in.',
      });
    },
    openArtifactPath: () => {
      note('openArtifactPath');
      return Promise.resolve({
        shown: null,
        reason: 'Storybook has no file manager to open.',
      });
    },
    toggleDevTools: () => {
      note('toggleDevTools');
      return Promise.resolve();
    },

    notify: () => {
      note('notify');
      return Promise.resolve();
    },
    retractNotification: () => {
      note('retractNotification');
      return Promise.resolve();
    },
    testNotification: () => {
      note('testNotification');
      return Promise.resolve({
        posted: false,
        shown: null,
        reason: 'Storybook cannot post a system notification.',
      });
    },
    openNotificationSettings: () => {
      note('openNotificationSettings');
      return Promise.resolve();
    },
    onNotificationActivated: () => noSubscription('onNotificationActivated'),

    getRemoteAccess: (): Promise<RemoteAccessState> => {
      note('getRemoteAccess');
      return Promise.resolve(REMOTE_ACCESS_OFF);
    },
    regenerateRemotePairingCode: (): Promise<RemoteAccessState> => {
      note('regenerateRemotePairingCode');
      return Promise.resolve(REMOTE_ACCESS_OFF);
    },
    revokeRemoteDevice: (): Promise<RemoteAccessState> => {
      note('revokeRemoteDevice');
      return Promise.resolve(REMOTE_ACCESS_OFF);
    },
    startRemoteTunnel: (): Promise<RemoteAccessState> => {
      note('startRemoteTunnel');
      return Promise.resolve(REMOTE_ACCESS_OFF);
    },
    stopRemoteTunnel: (): Promise<RemoteAccessState> => {
      note('stopRemoteTunnel');
      return Promise.resolve(REMOTE_ACCESS_OFF);
    },

    browserState: (runId) => {
      note('browserState');
      return Promise.resolve({
        runId,
        tabs: [],
        activeTabId: null,
        poppedOut: false,
        recent: [],
      });
    },
    browserOpenTab: () => {
      note('browserOpenTab');
      return Promise.resolve('t1');
    },
    browserNavigate: () => {
      note('browserNavigate');
      return Promise.resolve();
    },
    browserHistory: () => {
      note('browserHistory');
      return Promise.resolve();
    },
    browserCloseTab: () => {
      note('browserCloseTab');
      return Promise.resolve();
    },
    browserSelectTab: () => {
      note('browserSelectTab');
      return Promise.resolve();
    },
    browserSetBounds: () => {
      note('browserSetBounds');
      return Promise.resolve();
    },
    browserPopOut: () => {
      note('browserPopOut');
      return Promise.resolve();
    },
    browserDock: () => {
      note('browserDock');
      return Promise.resolve();
    },
    browserTabAction: () => {
      note('browserTabAction');
      return Promise.resolve();
    },
    browserContinueInsecure: () => {
      note('browserContinueInsecure');
      return Promise.resolve();
    },
    browserAnswerAuth: () => {
      note('browserAnswerAuth');
      return Promise.resolve();
    },
    browserCapture: () => {
      note('browserCapture');
      return Promise.resolve(null);
    },
    browserForgetRun: () => {
      note('browserForgetRun');
      return Promise.resolve();
    },
    browserStopAgent: () => {
      note('browserStopAgent');
      return Promise.resolve();
    },
    browserLabelTab: () => {
      note('browserLabelTab');
      return Promise.resolve();
    },
    browserAgentRequest: () => {
      note('browserAgentRequest');
      return Promise.resolve({ ok: false, error: 'Storybook has no browser.' });
    },
    onBrowserState: () => noSubscription('onBrowserState'),

    filePath: () => {
      note('filePath');
      return null;
    },
    ...overrides,
  };
}
