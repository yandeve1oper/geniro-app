import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent,
  webUtils,
} from 'electron';

import { type GeniroApi, IPC } from '../shared/contracts';

/**
 * The only bridge between the sandboxed renderer and the privileged main
 * process. Request methods forward to ipcMain.handle channels; daemon restart
 * notifications subscribe to a main-process event. The renderer never sees
 * Node or Electron directly.
 */
const api: GeniroApi = {
  getStatus: () =>
    ipcRenderer.invoke(IPC.getStatus) as ReturnType<GeniroApi['getStatus']>,
  getDaemonHandle: () =>
    ipcRenderer.invoke(IPC.getDaemonHandle) as ReturnType<
      GeniroApi['getDaemonHandle']
    >,
  ensureDaemon: () =>
    ipcRenderer.invoke(IPC.ensureDaemon) as ReturnType<
      GeniroApi['ensureDaemon']
    >,
  onDaemonRestarted: (listener) => {
    const handler = (_event: IpcRendererEvent, handle: unknown): void => {
      listener(handle as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(IPC.onDaemonRestarted, handler);
    return () => ipcRenderer.removeListener(IPC.onDaemonRestarted, handler);
  },
  onDaemonMigrating: (listener) => {
    const handler = (_event: IpcRendererEvent, migration: unknown): void => {
      listener(migration as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(IPC.onDaemonMigrating, handler);
    return () => ipcRenderer.removeListener(IPC.onDaemonMigrating, handler);
  },
  onClearAgentCaches: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on(IPC.onClearAgentCaches, handler);
    return () => ipcRenderer.removeListener(IPC.onClearAgentCaches, handler);
  },
  onSettingsChanged: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on(IPC.onSettingsChanged, handler);
    return () => ipcRenderer.removeListener(IPC.onSettingsChanged, handler);
  },
  onFlushLineMeasurements: (listener) => {
    const handler = (_event: IpcRendererEvent, requestId: string): void =>
      listener(requestId);
    ipcRenderer.on(IPC.onFlushLineMeasurements, handler);
    return () =>
      ipcRenderer.removeListener(IPC.onFlushLineMeasurements, handler);
  },
  pickProjectFolder: (defaultPath?: string) =>
    ipcRenderer.invoke(IPC.pickProjectFolder, defaultPath) as ReturnType<
      GeniroApi['pickProjectFolder']
    >,
  pickAgentBinary: () =>
    ipcRenderer.invoke(IPC.pickAgentBinary) as ReturnType<
      GeniroApi['pickAgentBinary']
    >,
  pickTaskFiles: () =>
    ipcRenderer.invoke(IPC.pickTaskFiles) as ReturnType<
      GeniroApi['pickTaskFiles']
    >,
  getSettings: () =>
    ipcRenderer.invoke(IPC.getSettings) as ReturnType<GeniroApi['getSettings']>,
  updateSettings: (patch) =>
    ipcRenderer.invoke(IPC.updateSettings, patch) as ReturnType<
      GeniroApi['updateSettings']
    >,
  detectClis: (options) =>
    ipcRenderer.invoke(IPC.detectClis, options) as ReturnType<
      GeniroApi['detectClis']
    >,
  updateCli: (kind) =>
    ipcRenderer.invoke(IPC.updateCli, kind) as ReturnType<
      GeniroApi['updateCli']
    >,
  getCliUpdates: () =>
    ipcRenderer.invoke(IPC.getCliUpdates) as ReturnType<
      GeniroApi['getCliUpdates']
    >,
  forgetCliUpdateResults: () =>
    ipcRenderer.invoke(IPC.forgetCliUpdateResults) as ReturnType<
      GeniroApi['forgetCliUpdateResults']
    >,
  onCliUpdates: (listener) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      listener(state as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(IPC.onCliUpdates, handler);
    return () => ipcRenderer.removeListener(IPC.onCliUpdates, handler);
  },
  createConfigProfileDir: (agent, name) =>
    ipcRenderer.invoke(IPC.createConfigProfileDir, agent, name) as ReturnType<
      GeniroApi['createConfigProfileDir']
    >,
  installCli: (kind) =>
    ipcRenderer.invoke(IPC.installCli, kind) as ReturnType<
      GeniroApi['installCli']
    >,
  completeOnboarding: (input) =>
    ipcRenderer.invoke(IPC.completeOnboarding, input) as ReturnType<
      GeniroApi['completeOnboarding']
    >,
  pickTeamImport: () =>
    ipcRenderer.invoke(IPC.pickTeamImport) as ReturnType<
      GeniroApi['pickTeamImport']
    >,
  pickTeamExport: (defaultName) =>
    ipcRenderer.invoke(IPC.pickTeamExport, defaultName) as ReturnType<
      GeniroApi['pickTeamExport']
    >,
  getUpdateState: () =>
    ipcRenderer.invoke(IPC.getUpdateState) as ReturnType<
      GeniroApi['getUpdateState']
    >,
  checkForUpdates: () =>
    ipcRenderer.invoke(IPC.checkForUpdates) as ReturnType<
      GeniroApi['checkForUpdates']
    >,
  installUpdate: () =>
    ipcRenderer.invoke(IPC.installUpdate) as ReturnType<
      GeniroApi['installUpdate']
    >,
  relaunchForUpdate: () =>
    ipcRenderer.invoke(IPC.relaunchForUpdate) as ReturnType<
      GeniroApi['relaunchForUpdate']
    >,
  onUpdateState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      listener(state as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(IPC.onUpdateState, handler);
    return () => ipcRenderer.removeListener(IPC.onUpdateState, handler);
  },
  getGitInfo: (dir) =>
    ipcRenderer.invoke(IPC.getGitInfo, dir) as ReturnType<
      GeniroApi['getGitInfo']
    >,
  getGitStamp: (dir) =>
    ipcRenderer.invoke(IPC.getGitStamp, dir) as ReturnType<
      GeniroApi['getGitStamp']
    >,
  getGitHead: (dir) =>
    ipcRenderer.invoke(IPC.getGitHead, dir) as ReturnType<
      GeniroApi['getGitHead']
    >,
  getChangesSince: (dir, sha, workFolder, pullRequests) =>
    ipcRenderer.invoke(
      IPC.getChangesSince,
      dir,
      sha,
      workFolder,
      pullRequests,
    ) as ReturnType<GeniroApi['getChangesSince']>,
  listWorktrees: (dir, startedAtMs) =>
    ipcRenderer.invoke(IPC.listWorktrees, dir, startedAtMs) as ReturnType<
      GeniroApi['listWorktrees']
    >,
  getChangesTotals: (dir, sha) =>
    ipcRenderer.invoke(IPC.getChangesTotals, dir, sha) as ReturnType<
      GeniroApi['getChangesTotals']
    >,
  lineMeasurementsFlushed: (requestId) =>
    ipcRenderer.invoke(IPC.lineMeasurementsFlushed, requestId) as ReturnType<
      GeniroApi['lineMeasurementsFlushed']
    >,
  getPullRequestsByRef: (refs) =>
    ipcRenderer.invoke(IPC.getPullRequestsByRef, refs) as ReturnType<
      GeniroApi['getPullRequestsByRef']
    >,
  openInTerminal: (input) =>
    ipcRenderer.invoke(IPC.openInTerminal, input) as ReturnType<
      GeniroApi['openInTerminal']
    >,
  terminalCreate: (input) =>
    ipcRenderer.invoke(IPC.terminalCreate, input) as ReturnType<
      GeniroApi['terminalCreate']
    >,
  terminalWrite: (id, data) =>
    ipcRenderer.invoke(IPC.terminalWrite, id, data) as ReturnType<
      GeniroApi['terminalWrite']
    >,
  terminalResize: (id, cols, rows) =>
    ipcRenderer.invoke(IPC.terminalResize, id, cols, rows) as ReturnType<
      GeniroApi['terminalResize']
    >,
  terminalAck: (id, chars) =>
    ipcRenderer.invoke(IPC.terminalAck, id, chars) as ReturnType<
      GeniroApi['terminalAck']
    >,
  terminalKill: (id) =>
    ipcRenderer.invoke(IPC.terminalKill, id) as ReturnType<
      GeniroApi['terminalKill']
    >,
  onTerminalData: (listener) => {
    const handler = (_event: IpcRendererEvent, event: unknown): void => {
      listener(event as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(IPC.onTerminalData, handler);
    return () => ipcRenderer.removeListener(IPC.onTerminalData, handler);
  },
  onTerminalExit: (listener) => {
    const handler = (_event: IpcRendererEvent, event: unknown): void => {
      listener(event as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(IPC.onTerminalExit, handler);
    return () => ipcRenderer.removeListener(IPC.onTerminalExit, handler);
  },
  saveChatExport: (input) =>
    ipcRenderer.invoke(IPC.saveChatExport, input) as ReturnType<
      GeniroApi['saveChatExport']
    >,
  saveArtifact: (input) =>
    ipcRenderer.invoke(IPC.saveArtifact, input) as ReturnType<
      GeniroApi['saveArtifact']
    >,
  saveMemoryExport: (markdown) =>
    ipcRenderer.invoke(IPC.saveMemoryExport, markdown) as ReturnType<
      GeniroApi['saveMemoryExport']
    >,
  saveKnowledgeExport: (input) =>
    ipcRenderer.invoke(IPC.saveKnowledgeExport, input) as ReturnType<
      GeniroApi['saveKnowledgeExport']
    >,
  prepareTaskWorktree: (input) =>
    ipcRenderer.invoke(IPC.prepareTaskWorktree, input) as ReturnType<
      GeniroApi['prepareTaskWorktree']
    >,
  pruneTaskWorktree: (taskId) =>
    ipcRenderer.invoke(IPC.pruneTaskWorktree, taskId) as ReturnType<
      GeniroApi['pruneTaskWorktree']
    >,
  settleTaskWorktree: (taskId) =>
    ipcRenderer.invoke(IPC.settleTaskWorktree, taskId) as ReturnType<
      GeniroApi['settleTaskWorktree']
    >,
  switchBranch: (dir, branch) =>
    ipcRenderer.invoke(IPC.switchBranch, dir, branch) as ReturnType<
      GeniroApi['switchBranch']
    >,
  pullBranch: (dir) =>
    ipcRenderer.invoke(IPC.pullBranch, dir) as ReturnType<
      GeniroApi['pullBranch']
    >,
  carryChangesToBranch: (dir, branch) =>
    ipcRenderer.invoke(IPC.carryChangesToBranch, dir, branch) as ReturnType<
      GeniroApi['carryChangesToBranch']
    >,
  revealPath: (path) =>
    ipcRenderer.invoke(IPC.revealPath, path) as ReturnType<
      GeniroApi['revealPath']
    >,
  openArtifactPath: (path) =>
    ipcRenderer.invoke(IPC.openArtifactPath, path) as ReturnType<
      GeniroApi['openArtifactPath']
    >,
  getAppStorage: (unclaimed) =>
    ipcRenderer.invoke(IPC.getAppStorage, unclaimed) as ReturnType<
      GeniroApi['getAppStorage']
    >,
  removeStorageWorktree: (name) =>
    ipcRenderer.invoke(IPC.removeStorageWorktree, name) as ReturnType<
      GeniroApi['removeStorageWorktree']
    >,
  clearBrowserCache: () =>
    ipcRenderer.invoke(IPC.clearBrowserCache) as ReturnType<
      GeniroApi['clearBrowserCache']
    >,
  restartDaemon: () =>
    ipcRenderer.invoke(IPC.restartDaemon) as ReturnType<
      GeniroApi['restartDaemon']
    >,
  toggleDevTools: () =>
    ipcRenderer.invoke(IPC.toggleDevTools) as ReturnType<
      GeniroApi['toggleDevTools']
    >,
  notify: (notification) =>
    ipcRenderer.invoke(IPC.notify, notification) as ReturnType<
      GeniroApi['notify']
    >,
  retractNotification: (runId) =>
    ipcRenderer.invoke(IPC.retractNotification, runId) as ReturnType<
      GeniroApi['retractNotification']
    >,
  testNotification: () =>
    ipcRenderer.invoke(IPC.testNotification) as ReturnType<
      GeniroApi['testNotification']
    >,
  openNotificationSettings: () =>
    ipcRenderer.invoke(IPC.openNotificationSettings) as ReturnType<
      GeniroApi['openNotificationSettings']
    >,
  onNotificationActivated: (listener) => {
    const handler = (_event: IpcRendererEvent, runId: unknown): void => {
      listener(runId as string);
    };
    ipcRenderer.on(IPC.onNotificationActivated, handler);
    return () =>
      ipcRenderer.removeListener(IPC.onNotificationActivated, handler);
  },
  getRemoteAccess: () =>
    ipcRenderer.invoke(IPC.getRemoteAccess) as ReturnType<
      GeniroApi['getRemoteAccess']
    >,
  regenerateRemotePairingCode: () =>
    ipcRenderer.invoke(IPC.regenerateRemotePairingCode) as ReturnType<
      GeniroApi['regenerateRemotePairingCode']
    >,
  revokeRemoteDevice: (deviceId) =>
    ipcRenderer.invoke(IPC.revokeRemoteDevice, deviceId) as ReturnType<
      GeniroApi['revokeRemoteDevice']
    >,
  startRemoteTunnel: () =>
    ipcRenderer.invoke(IPC.startRemoteTunnel) as ReturnType<
      GeniroApi['startRemoteTunnel']
    >,
  stopRemoteTunnel: () =>
    ipcRenderer.invoke(IPC.stopRemoteTunnel) as ReturnType<
      GeniroApi['stopRemoteTunnel']
    >,
  browserState: (runId) =>
    ipcRenderer.invoke(IPC.browserState, runId) as ReturnType<
      GeniroApi['browserState']
    >,
  browserOpenTab: (runId, url) =>
    ipcRenderer.invoke(IPC.browserOpenTab, runId, url) as ReturnType<
      GeniroApi['browserOpenTab']
    >,
  browserNavigate: (runId, tabId, input) =>
    ipcRenderer.invoke(IPC.browserNavigate, runId, tabId, input) as ReturnType<
      GeniroApi['browserNavigate']
    >,
  browserHistory: (runId, tabId, action) =>
    ipcRenderer.invoke(IPC.browserHistory, runId, tabId, action) as ReturnType<
      GeniroApi['browserHistory']
    >,
  browserCloseTab: (runId, tabId) =>
    ipcRenderer.invoke(IPC.browserCloseTab, runId, tabId) as ReturnType<
      GeniroApi['browserCloseTab']
    >,
  browserSelectTab: (runId, tabId) =>
    ipcRenderer.invoke(IPC.browserSelectTab, runId, tabId) as ReturnType<
      GeniroApi['browserSelectTab']
    >,
  browserSetBounds: (runId, bounds) =>
    ipcRenderer.invoke(IPC.browserSetBounds, runId, bounds) as ReturnType<
      GeniroApi['browserSetBounds']
    >,
  browserPopOut: (runId, title) =>
    ipcRenderer.invoke(IPC.browserPopOut, runId, title) as ReturnType<
      GeniroApi['browserPopOut']
    >,
  browserDock: (runId) =>
    ipcRenderer.invoke(IPC.browserDock, runId) as ReturnType<
      GeniroApi['browserDock']
    >,
  browserTabAction: (runId, tabId, action) =>
    ipcRenderer.invoke(
      IPC.browserTabAction,
      runId,
      tabId,
      action,
    ) as ReturnType<GeniroApi['browserTabAction']>,
  browserContinueInsecure: (runId, tabId) =>
    ipcRenderer.invoke(IPC.browserContinueInsecure, runId, tabId) as ReturnType<
      GeniroApi['browserContinueInsecure']
    >,
  browserAnswerAuth: (runId, tabId, credentials) =>
    ipcRenderer.invoke(
      IPC.browserAnswerAuth,
      runId,
      tabId,
      credentials,
    ) as ReturnType<GeniroApi['browserAnswerAuth']>,
  browserCapture: (runId) =>
    ipcRenderer.invoke(IPC.browserCapture, runId) as ReturnType<
      GeniroApi['browserCapture']
    >,
  browserForgetRun: (runId) =>
    ipcRenderer.invoke(IPC.browserForgetRun, runId) as ReturnType<
      GeniroApi['browserForgetRun']
    >,
  browserStopAgent: (runId, tabId) =>
    ipcRenderer.invoke(IPC.browserStopAgent, runId, tabId) as ReturnType<
      GeniroApi['browserStopAgent']
    >,
  browserLabelTab: (runId, tabId, label) =>
    ipcRenderer.invoke(IPC.browserLabelTab, runId, tabId, label) as ReturnType<
      GeniroApi['browserLabelTab']
    >,
  browserAgentRequest: (request) =>
    ipcRenderer.invoke(IPC.browserAgentRequest, request) as ReturnType<
      GeniroApi['browserAgentRequest']
    >,
  onBrowserState: (listener) => {
    const handler = (_event: IpcRendererEvent, event: unknown): void => {
      listener(event as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(IPC.onBrowserState, handler);
    return () => ipcRenderer.removeListener(IPC.onBrowserState, handler);
  },
  // No `ipcRenderer.invoke` here: `webUtils` is a RENDERER-side module, and a
  // `File` could not cross to main anyway. Electron returns '' for a file with
  // no path on disk; the renderer wants that as an absence.
  filePath: (file) => webUtils.getPathForFile(file) || null,
};

contextBridge.exposeInMainWorld('geniro', api);
