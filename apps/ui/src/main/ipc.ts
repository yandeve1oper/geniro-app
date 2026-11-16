import { realpath } from 'node:fs/promises';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  shell,
  type WebContents,
} from 'electron';
import { z } from 'zod';

import { type DaemonHandle, IPC } from '../shared/contracts';
import type { RemoteAccessState } from '../shared/remote';
import { clearBrowserCache, readAppStorage } from './app-storage';
import { runBrowserAgentRequest } from './browser/browser-agent';
import { type BrowserService, resolveAddress } from './browser/browser-service';
import { detectClisCached } from './cli-detect';
import { runCliInstall } from './cli-install';
import { runCliUpdate } from './cli-update';
import type { DaemonSupervisor } from './daemon-supervisor';
import { readFinishedTasks } from './finished-tasks';
import {
  readChangesSince,
  readChangesTotals,
  readLinkedWorktrees,
} from './git-changes';
import { gitFailureLine } from './git-failure';
import {
  carryChangesToBranch,
  pullBranch,
  readGitHead,
  readGitInfo,
  readGitStamp,
  switchBranch,
} from './git-info';
import { readPullRequestsByRef } from './github-prs';
import {
  ALLOW_REMOTELY,
  allowRemotelyExceptFields,
  allowRemotelyRedacted,
  denyRemotely,
  type IpcChannelHandler,
  IpcRegistry,
  type RemotePolicy,
} from './ipc-registry';
import {
  artifactSaveSchema,
  branchNameSchema,
  browserAddressSchema,
  browserBoundsSchema,
  browserCredentialsSchema,
  browserHistoryActionSchema,
  browserOpenUrlSchema,
  browserPopOutTitleSchema,
  browserRunIdSchema,
  browserTabActionSchema,
  browserTabIdSchema,
  browserTabLabelSchema,
  changesPullRequestsSchema,
  chatExportSaveSchema,
  cliKindSchema,
  commitShaSchema,
  detectClisOptionsSchema,
  epochMsSchema,
  gitDirSchema,
  knowledgeExportSaveSchema,
  lineFlushRequestIdSchema,
  memoryExportSaveSchema,
  notificationSchema,
  onboardingInputSchema,
  openTerminalSchema,
  pickFolderStartSchema,
  pullRequestRefsSchema,
  retractNotificationSchema,
  revealPathSchema,
  settingsPatchSchema,
  storageEntryNameSchema,
  storageEntryNamesSchema,
  taskIdSchema,
  taskWorktreeSchema,
  terminalAckCharsSchema,
  terminalColsSchema,
  terminalCreateSchema,
  terminalIdSchema,
  terminalRowsSchema,
  terminalWriteDataSchema,
  workFolderFlagSchema,
} from './ipc-schemas';
import {
  flushWindowsThen,
  LINE_FLUSH_RESTART_TIMEOUT_MS,
  lineMeasurementFlush,
} from './line-measurement-flush';
import { applyTheme } from './native-appearance';
import { openNotificationSettings } from './notifications/notification-settings';
import { NotificationService } from './notifications/notifications.service';
import { openInTerminal } from './open-terminal';
import type { RemoteAccess } from './remote/remote-access';
import { revealPath } from './reveal-path';
import { saveArtifact } from './save-artifact';
import { saveChatExport } from './save-chat-export';
import { saveKnowledgeExport } from './save-knowledge-export';
import { saveMemoryExport } from './save-memory-export';
import { readSettings, updateSettings } from './settings';
import type { TerminalSessions } from './terminal-sessions';
import type { UpdateService } from './update-service';
import { reportMainLog } from './window-diagnostics';
import {
  prepareWorktree,
  pruneWorktreeForTask,
  removeWorktreeOnRequest,
  settleWorktreeForTask,
  worktreesRoot,
} from './worktree-service';

/**
 * A paired device's id, minted by `DeviceRegistry.add` via `node:crypto`'s
 * `randomUUID()`. No schema in `ipc-schemas.ts` names this shape BY INTENT —
 * `taskIdSchema` is a git-ref/path-segment alphabet for a different id, and
 * `terminalIdSchema` happens to also be `z.uuid()` but is documented and
 * named for terminal tabs — so borrowing either would import a schema whose
 * name lies about what it is validating. A narrow one local to this channel
 * is the honest answer.
 */
const remoteDeviceIdSchema = z.uuid();

/**
 * Register every privileged channel the renderer can invoke. The renderer has
 * no Node/Electron access; each handler here is one entry in the GeniroApi
 * contract exposed via the preload. Returns the built {@link IpcRegistry} so
 * a caller that also runs the LAN gateway can answer the same channels over
 * HTTP through the identical handlers, rather than a second dispatch table
 * that could drift from this one.
 *
 * `remoteAccess` is a GETTER rather than the instance itself: `RemoteAccess`
 * is built from the very `IpcRegistry` this function returns (see
 * `index.ts`), so passing the instance directly would be circular. Every
 * existing caller — both specs — omits it, which is why it is optional; the
 * three channels below are the only thing that needs it, and nothing else
 * here ever exercises them without it wired.
 */
/**
 * `getStatus`'s answer with the daemon handle's token blanked.
 *
 * A remote caller needs the rest of that reply — whether onboarding is done,
 * whether the daemon is connected — and must not be handed the credential
 * riding in the same object. Blanked rather than removed so the shape the
 * renderer is typed against is unchanged; the browser shim replaces the whole
 * handle with the gateway's own coordinates anyway, so nothing downstream
 * reads this field remotely.
 */
function redactDaemonToken(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const status = value as { daemon?: { handle?: DaemonHandle | null } };
  if (!status.daemon?.handle) {
    return value;
  }
  return {
    ...status,
    daemon: {
      ...status.daemon,
      // The ADDRESS goes with the token. It is the daemon's loopback
      // coordinates, which on the device reading this reply name that
      // device's own machine — so it is both useless to a remote client and
      // a fact about this Mac's internals it was never meant to need. The
      // browser shim substitutes the gateway's own origin regardless.
      handle: { ...status.daemon.handle, host: '', port: 0, token: '' },
    },
  };
}

/**
 * A bare `DaemonHandle` with its token and loopback address blanked — the
 * `ensureDaemon` reply, for the reason {@link redactDaemonToken} gives for
 * `getStatus`'s. Anything that is not a handle passes through untouched.
 */
function redactHandleCredential(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('token' in value)) {
    return value;
  }
  return { ...(value as DaemonHandle), host: '', port: 0, token: '' };
}

/**
 * A `RemoteAccessState` with the live pairing code blanked.
 *
 * A paired device is trusted to use this app, not to enrol OTHER devices —
 * and the whole point of the code is that it is read off the Mac's own
 * screen. Handing it back over the bridge to an already-paired caller would
 * let it read the code once and pass it on, silently defeating the "type
 * what you see on the Mac" model. Applied to all three remote-access
 * channels, since `regenerateRemotePairingCode`/`revokeRemoteDevice` answer
 * the same shape. The desktop Settings pane reaches `RemoteAccess` directly
 * rather than through this bridge, so it keeps both fields.
 */
function redactRemoteAccessForRemote(value: unknown): unknown {
  const state = value as RemoteAccessState;
  return {
    ...state,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    // Every device's `tokenHash` rode this reply to the untrusted side. A
    // sha256 of 256 random bits is not going to be reversed, so this is not
    // a live credential — but it is a credential DIGEST, it buys a remote
    // reader nothing the device list does not already show, and the Settings
    // panel never renders it. Blanked rather than argued about.
    devices: state.devices.map((device) => ({ ...device, tokenHash: '' })),
  };
}

export function registerIpc(
  supervisor: DaemonSupervisor,
  updates: UpdateService,
  terminals: TerminalSessions,
  remoteAccess?: () => RemoteAccess,
  /** Told after a restart from Settings, which the supervisor's `onStarted` does not cover. */
  afterRestart?: (handle: DaemonHandle | null) => void,
  /** The in-app browser; a getter because it exists only once the egress proxy is up. */
  browser?: () => BrowserService,
): IpcRegistry {
  // One instance for the app's lifetime, reading settings through the same
  // function every other handler here does — so the toggle it consults is
  // always the file's current state, never a value captured at registration.
  const notifications = new NotificationService(readSettings);

  const registry = new IpcRegistry();
  // The one seam every channel below goes through: it registers with Electron
  // exactly as a bare `ipcMain.handle` call would, and records the same
  // handler under the channel's remote policy — so the two can never disagree
  // about what a channel does.
  const handle = (
    channel: string,
    policy: RemotePolicy,
    fn: IpcChannelHandler,
  ): void => {
    ipcMain.handle(channel, fn);
    registry.register(channel, policy, fn);
  };

  // A window's shells die with its document: on close, on a renderer crash, and
  // on a reload — the reloaded page has no tabs left to show them in. The reload
  // is caught on `did-navigate`, never `did-start-navigation`: that one also
  // fires for a navigation `will-navigate` then BLOCKS, which would hang up every
  // shell under a page that never went anywhere.
  const watchedOwners = new WeakSet<WebContents>();
  const watchTerminalOwner = (contents: WebContents): void => {
    if (watchedOwners.has(contents)) {
      return;
    }
    watchedOwners.add(contents);
    const ownerId = contents.id;
    contents.once('destroyed', () => terminals.disposeOwner(ownerId));
    contents.on('render-process-gone', () => terminals.disposeOwner(ownerId));
    contents.on('did-navigate', () => terminals.disposeOwner(ownerId));
  };

  // The shell channels answer the window's own top-level document alone. Nothing
  // else can reach a preload today; this keeps it so should a frame ever appear,
  // since these are the channels that end in an interactive shell.
  const terminalOwner = (event: IpcMainInvokeEvent): WebContents => {
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error('terminals are available to the top-level page only');
    }
    return event.sender;
  };

  /**
   * Restart the daemon and hand the new coordinates to EVERY window, not only
   * the one that asked.
   *
   * A restart mints a fresh port and a fresh token, so a window still holding
   * the previous handle is talking to a daemon that no longer exists — which
   * was already true of a second window before this, and is unconditionally
   * true of a caller that has no window at all. The LAN gateway is that
   * caller: a phone changing a setting arrives over HTTP with no
   * `WebContents` to answer to, and keying the announcement on the sender is
   * the only thing that made these channels desktop-only.
   */
  const restartAndNotify = async (): Promise<void> => {
    // The restart stops the daemon the windows are posting to, so it waits for what they hold first, as a
    // quit does.
    const handle = await flushWindowsThen(
      BrowserWindow.getAllWindows(),
      () => supervisor.getHandle(),
      () => supervisor.restart(),
      LINE_FLUSH_RESTART_TIMEOUT_MS,
    );
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC.onDaemonRestarted, handle);
    }
    afterRestart?.(handle);
  };

  handle(IPC.getStatus, allowRemotelyRedacted(redactDaemonToken), () => {
    const settings = readSettings();
    return {
      onboardingComplete: settings.onboardingComplete,
      daemon: {
        connected: supervisor.isConnected(),
        handle: supervisor.getHandle(),
        migrating: supervisor.getMigration(),
      },
      isPackaged: app.isPackaged,
    };
  });

  // The handle carries the daemon's per-launch bearer token, which is the
  // master key to everything the daemon can do. A remote caller needs no
  // handle at all — the gateway injects that credential itself on every
  // proxied call, and the browser shim synthesises coordinates pointing at
  // the gateway's own origin. So this channel is pure credential delivery
  // over the network, and it is refused rather than merely unused.
  handle(
    IPC.getDaemonHandle,
    denyRemotely(
      "carries the daemon's own bearer token — the gateway supplies that " +
        'server-side and a remote client never needs it',
    ),
    () => supervisor.getHandle(),
  );

  // The connection banner's Retry. `start()` answers with the daemon it holds
  // when that one still answers, adopts or spawns one otherwise, and tells the
  // windows about a NEW one itself (`onStarted` in `index.ts`) — so this only
  // has to hand the caller its handle.
  //
  // ALLOWED remotely, with the credential blanked: a phone whose Mac's daemon
  // died has no other way back, and it can already restart that daemon by
  // changing a setting that needs one (`updateSettings`). This is strictly
  // less — it starts a daemon only where none answers, and never replaces or
  // reconfigures one that does.
  handle(IPC.ensureDaemon, allowRemotelyRedacted(redactHandleCredential), () =>
    supervisor.start(),
  );

  handle(
    IPC.pickProjectFolder,
    denyRemotely('opens a native folder picker on the computer running geniro'),
    async (_event, start: unknown) => {
      const parsed = pickFolderStartSchema.safeParse(start);
      const defaultPath = parsed.success ? parsed.data : undefined;
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        // A DIRECTORY here opens the dialog inside it, which is the point: the
        // folder the field holds is the one a reader is deciding whether to
        // replace, not the last place any dialog happened to be left.
        ...(defaultPath === undefined ? {} : { defaultPath }),
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );

  handle(
    IPC.pickAgentBinary,
    denyRemotely('opens a native file picker on the computer running geniro'),
    async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );

  handle(
    IPC.pickTaskFiles,
    denyRemotely('opens a native file picker on the computer running geniro'),
    async () => {
      const result = await dialog.showOpenDialog({
        // No `filters`: a task's attachment is whatever the work needs — an
        // archive, a spreadsheet, a log, a design file — and a filter list here
        // could only ever be a guess that hides the one the user came for.
        properties: ['openFile', 'multiSelections'],
      });
      return result.canceled ? [] : result.filePaths;
    },
  );

  handle(IPC.getSettings, ALLOW_REMOTELY, () => readSettings());

  // `cliPaths` becomes the spawned agent BINARY, and `daemonInspect` opens
  // the node inspector on loopback — this repo's own words for that are
  // "code execution inside the daemon" (apps/ui/src/main/AGENTS.md → App updates). A
  // pairing code must not buy either, so both are refused on the remote
  // path alone — the desktop keeps them, since `refuseRemoteArgs` is never
  // consulted for a plain `ipcMain.handle` call.
  const updateSettingsRemotePolicy = allowRemotelyExceptFields(
    // `sharing` names the commands an upload runs and lets agents publish
    // pages through the user's own logins: the desktop's call alone.
    // The auto-forget window arms a sweep that forgets memory on its own clock.
    // `resourceAlerts` reaches the daemon's desktop-only config route.
    // `lessons` picks what a reflection spends, through another such route.
    [
      'cliPaths',
      'daemonInspect',
      'lessons',
      'memoryAutoForgetAfterDays',
      'resourceAlerts',
      'sharing',
    ],
    'sets a field the desktop alone may set',
  );
  handle(
    IPC.updateSettings,
    updateSettingsRemotePolicy,
    async (_event, patch: unknown) => {
      const parsed = settingsPatchSchema.parse(patch);
      const settings = updateSettings(parsed);
      // Both are read when the daemon PROCESS is launched — CLI paths ride its
      // env, the inspector is a launch flag — so neither can take effect on the
      // running one. Respawning here is what makes the toggle mean what it
      // says the moment it is flipped.
      if (parsed.cliPaths !== undefined || parsed.daemonInspect !== undefined) {
        await restartAndNotify();
      }
      // Re-armed on the spot rather than at the next launch: switching automatic
      // checks ON and being told nothing until tomorrow is a switch that appears
      // not to work.
      if (parsed.checkForUpdates !== undefined) {
        updates.start(parsed.checkForUpdates);
      }
      // Same shape, same reasoning: a listener bind/unbind, not a daemon
      // respawn, so the switch must take effect on this write rather than at
      // the next launch. Guarded on `remoteAccess` being wired for the SAME
      // reason `getRemoteAccess` above throws instead of no-op-ing — every
      // existing caller of `registerIpc` omits it and never sends this key.
      if (parsed.remoteAccessEnabled !== undefined && remoteAccess) {
        await remoteAccess().sync();
      }
      // Applied on the spot, and applied HERE rather than in the renderer: this
      // one write themes the OS chrome the app does not paint AND, through
      // `prefers-color-scheme`, the page itself — so the renderer needs no push
      // channel to be told, and the two cannot disagree. `applyTheme` rather than
      // `applyNativeAppearance` because a window already open also has its own
      // ground to repaint, which is a construction option nothing else re-reads.
      if (parsed.theme !== undefined) {
        applyTheme(parsed.theme);
      }
      return settings;
    },
  );

  handle(IPC.detectClis, ALLOW_REMOTELY, (_event, options: unknown) =>
    detectClisCached(
      readSettings(),
      detectClisOptionsSchema.parse(options ?? {}).maxAgeMs,
    ),
  );

  // Never rejects: every failure is reported IN the result, because the card
  // has somewhere to say what the updater did and an IPC rejection reaches the
  // renderer as an opaque `Error invoking remote method`.
  handle(IPC.updateCli, ALLOW_REMOTELY, (_event, kind: unknown) =>
    runCliUpdate(cliKindSchema.parse(kind), readSettings()),
  );

  // Allowed remotely for the updater's reason: what runs is the vendor's fixed
  // installer, never anything the caller supplies, and a paired device can
  // already run agents on this machine.
  handle(IPC.installCli, ALLOW_REMOTELY, (_event, kind: unknown) =>
    runCliInstall(cliKindSchema.parse(kind), readSettings()),
  );

  handle(
    IPC.pickTeamImport,
    denyRemotely('opens a native file picker on the computer running geniro'),
    async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Geniro team', extensions: ['yaml', 'yml'] }],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );

  handle(
    IPC.pickTeamExport,
    denyRemotely('opens a native save dialog on the computer running geniro'),
    async (_event, defaultName: unknown) => {
      const result = await dialog.showSaveDialog({
        defaultPath:
          typeof defaultName === 'string' && defaultName.length > 0
            ? defaultName
            : 'team.team.yaml',
        filters: [{ name: 'Geniro team', extensions: ['yaml', 'yml'] }],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
  );

  // No input on any of the three: what to check and what to install are main's
  // own facts (the release feed, this bundle's path), and a renderer that could
  // name either would be a renderer that could point the installer somewhere.
  handle(IPC.getUpdateState, ALLOW_REMOTELY, () => updates.getState());
  handle(IPC.checkForUpdates, ALLOW_REMOTELY, () => updates.check());
  handle(
    IPC.installUpdate,
    denyRemotely(
      'downloads and swaps the app bundle on the computer running geniro',
    ),
    () => updates.install(),
  );
  handle(
    IPC.relaunchForUpdate,
    denyRemotely('quits and relaunches the app on the computer running geniro'),
    () => updates.relaunch(),
  );

  handle(IPC.getGitInfo, ALLOW_REMOTELY, (_event, dir: unknown) =>
    readGitInfo(gitDirSchema.parse(dir)),
  );
  handle(IPC.getGitStamp, ALLOW_REMOTELY, (_event, dir: unknown) =>
    readGitStamp(gitDirSchema.parse(dir)),
  );
  handle(
    IPC.getChangesSince,
    ALLOW_REMOTELY,
    (
      _event,
      dir: unknown,
      sha: unknown,
      workFolder: unknown,
      pullRequests: unknown,
    ) =>
      readChangesSince(
        gitDirSchema.parse(dir),
        commitShaSchema.parse(sha),
        workFolderFlagSchema.parse(workFolder) === true,
        changesPullRequestsSchema.parse(pullRequests),
      ),
  );
  // The candidates `getChangesSince` above is then asked about, so it reaches as far.
  handle(
    IPC.listWorktrees,
    ALLOW_REMOTELY,
    async (_event, dir: unknown, startedAt: unknown) =>
      readLinkedWorktrees(gitDirSchema.parse(dir), {
        createdAfterMs: epochMsSchema.parse(startedAt),
        // Resolved, as git names worktrees by their real path.
        tasksRoot: await realpath(worktreesRoot()).catch(() => worktreesRoot()),
      }),
  );
  // The line measurement's two reads are the desktop window's alone: the hook that makes them
  // is silent on a remote device, and a total reads every untracked file in the tree, which a
  // paired device has no reason to make the Mac do.
  const lineMeasurementDeny = denyRemotely(
    'measures a folder for the desktop window’s line totals — a remote device does not measure',
  );
  handle(IPC.getGitHead, lineMeasurementDeny, (_event, dir: unknown) =>
    readGitHead(gitDirSchema.parse(dir)),
  );
  handle(
    IPC.getChangesTotals,
    lineMeasurementDeny,
    (_event, dir: unknown, sha: unknown) =>
      readChangesTotals(gitDirSchema.parse(dir), commitShaSchema.parse(sha)),
  );

  // Shape-validated for the reason `openInTerminal` below is: every field here
  // becomes argv for `gh`.
  handle(IPC.getPullRequestsByRef, ALLOW_REMOTELY, (_event, refs: unknown) =>
    readPullRequestsByRef(pullRequestRefsSchema.parse(refs)),
  );

  // Shape-validated here rather than trusted: this ends in an executable
  // script the main process writes and hands to LaunchServices.
  handle(
    IPC.openInTerminal,
    denyRemotely(
      "hands the conversation off to the user's own terminal app on the computer running geniro",
    ),
    (_event, input: unknown) => openInTerminal(openTerminalSchema.parse(input)),
  );

  // The in-app terminal panel. Every call acts on the SENDER's own shells, so a
  // window can neither type into nor learn of another's. This does hand the
  // renderer a shell — no new reach: its daemon token can already start an
  // agent with auto-approval in any folder.
  const terminalDeny = denyRemotely(
    "scoped to the calling window's own WebContents — a remote call has none to own a shell with",
  );
  handle(IPC.terminalCreate, terminalDeny, (event, input: unknown) => {
    const owner = terminalOwner(event);
    const parsed = terminalCreateSchema.parse(input);
    watchTerminalOwner(owner);
    return terminals.create(owner, parsed);
  });
  handle(IPC.terminalWrite, terminalDeny, (event, id: unknown, data: unknown) =>
    terminals.write(
      terminalOwner(event),
      terminalIdSchema.parse(id),
      terminalWriteDataSchema.parse(data),
    ),
  );
  handle(
    IPC.terminalResize,
    terminalDeny,
    (event, id: unknown, cols: unknown, rows: unknown) =>
      terminals.resize(
        terminalOwner(event),
        terminalIdSchema.parse(id),
        terminalColsSchema.parse(cols),
        terminalRowsSchema.parse(rows),
      ),
  );
  handle(IPC.terminalAck, terminalDeny, (event, id: unknown, chars: unknown) =>
    terminals.ack(
      terminalOwner(event),
      terminalIdSchema.parse(id),
      terminalAckCharsSchema.parse(chars),
    ),
  );
  handle(IPC.terminalKill, terminalDeny, (event, id: unknown) =>
    terminals.kill(terminalOwner(event), terminalIdSchema.parse(id)),
  );

  // A window's answer to the quit-time flush (`line-measurement-flush.ts`): it has posted what it was
  // holding, so the quit may stop the daemon. Only the desktop window is ever asked, so a remote call has
  // no flush to answer and is refused.
  const lineFlushDeny = denyRemotely(
    'answers a flush main asks of the desktop window — a remote caller has none pending',
  );
  handle(
    IPC.lineMeasurementsFlushed,
    lineFlushDeny,
    (event, requestId: unknown) =>
      lineMeasurementFlush.acknowledge(
        event.sender.id,
        lineFlushRequestIdSchema.parse(requestId),
      ),
  );

  // The name is what reaches a PATH here (the dialog's starting point), so it
  // is validated as a bare filename; the content is only ever written to what
  // the user then picks. See `chatExportSaveSchema`.
  handle(
    IPC.saveChatExport,
    denyRemotely('opens a native save dialog on the computer running geniro'),
    (_event, input: unknown) =>
      saveChatExport(chatExportSaveSchema.parse(input)),
  );

  handle(
    IPC.saveArtifact,
    denyRemotely('opens a native save dialog on the computer running geniro'),
    (_event, input: unknown) => saveArtifact(artifactSaveSchema.parse(input)),
  );

  handle(
    IPC.saveMemoryExport,
    denyRemotely('opens a native save dialog on the computer running geniro'),
    (_event, markdown: unknown) =>
      saveMemoryExport(memoryExportSaveSchema.parse(markdown)),
  );

  handle(
    IPC.saveKnowledgeExport,
    denyRemotely('opens a native save dialog on the computer running geniro'),
    (_event, input: unknown) =>
      saveKnowledgeExport(knowledgeExportSaveSchema.parse(input)),
  );

  // ALLOW_REMOTELY here and on `settleTaskWorktree` below, unlike
  // `switchBranch`/`pullBranch` further down: both act only on a directory
  // THIS APP made under its own userData folder (`worktree-service.ts`),
  // bounded there by path, never on the user's own checkout — the same
  // directory a task's run already works in, whether started from the
  // desktop or from a paired phone.
  handle(
    IPC.prepareTaskWorktree,
    ALLOW_REMOTELY,
    async (_event, input: unknown) => {
      const parsed = taskWorktreeSchema.parse(input);
      try {
        const made = await prepareWorktree(parsed, {
          log: (level, message) => {
            void reportMainLog(supervisor.getHandle(), level, message, {
              source: 'worktree',
            });
          },
        });
        return {
          ok: true,
          path: made.path,
          branch: made.branch,
          reused: made.reused,
          error: null,
        };
      } catch (error) {
        // Shaped rather than rethrown: an exception crossing IPC arrives as a
        // string with its structure gone, and the caller must be able to tell a
        // failed worktree from a made one before it starts a run against it.
        return {
          ok: false,
          path: null,
          branch: null,
          reused: false,
          error: gitFailureLine(
            error,
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    },
  );

  handle(IPC.pruneTaskWorktree, ALLOW_REMOTELY, (_event, taskId: unknown) =>
    pruneWorktreeForTask(taskIdSchema.parse(taskId)),
  );

  handle(IPC.settleTaskWorktree, ALLOW_REMOTELY, (_event, taskId: unknown) =>
    settleWorktreeForTask(taskIdSchema.parse(taskId)),
  );

  // All three mutate the USER's own checkout — not an app-owned worktree — with
  // no one at the Mac to notice files changing under an editor that has that
  // folder open. `prepareTaskWorktree`/`settleTaskWorktree` below are the
  // safe half of this same list: they act on a directory this app made under
  // its own data folder, which is why they stay allowed.
  handle(
    IPC.switchBranch,
    denyRemotely(
      "switches the branch checked out in the user's own working folder on the computer running geniro",
    ),
    (_event, dir: unknown, branch: unknown) =>
      switchBranch(gitDirSchema.parse(dir), branchNameSchema.parse(branch)),
  );
  handle(
    IPC.pullBranch,
    denyRemotely(
      "pulls into the user's own working folder on the computer running geniro",
    ),
    (_event, dir: unknown) => pullBranch(gitDirSchema.parse(dir)),
  );
  handle(
    IPC.carryChangesToBranch,
    denyRemotely(
      "switches the branch checked out in the user's own working folder on the computer running geniro",
    ),
    (_event, dir: unknown, branch: unknown) =>
      carryChangesToBranch(
        gitDirSchema.parse(dir),
        branchNameSchema.parse(branch),
      ),
  );

  // Reveals, never opens, and only inside the daemon's log directory — the
  // confinement lives in `revealPath` beside the reason for it.
  handle(
    IPC.revealPath,
    denyRemotely('opens a Finder window on the computer running geniro'),
    (_event, path: unknown) => revealPath(revealPathSchema.parse(path)),
  );

  // Settings → Storage. Every name is one segment the schema bounds, joined
  // onto the data folder by main; a phone may not delete the Mac's files.
  const finishedCards = (
    taskIds: string[],
  ): Promise<ReadonlySet<string> | null> => {
    const daemon = supervisor.getHandle();
    return daemon === null
      ? Promise.resolve(null)
      : readFinishedTasks(daemon, taskIds);
  };
  handle(
    IPC.getAppStorage,
    denyRemotely("reads the computer running geniro's own files"),
    (_event, unclaimed: unknown) =>
      readAppStorage(
        app.getPath('userData'),
        storageEntryNamesSchema.parse(unclaimed),
        finishedCards,
      ),
  );
  handle(
    IPC.removeStorageWorktree,
    denyRemotely('deletes files on the computer running geniro'),
    (_event, name: unknown) =>
      removeWorktreeOnRequest(
        storageEntryNameSchema.parse(name),
        finishedCards,
      ),
  );
  handle(
    IPC.clearBrowserCache,
    denyRemotely('deletes files on the computer running geniro'),
    () => clearBrowserCache(app.getPath('userData')),
  );
  handle(
    IPC.restartDaemon,
    denyRemotely(
      'restarts the service every chat on the computer running geniro runs in',
    ),
    async () => {
      if (await supervisor.isServingWork()) {
        throw new Error(
          'an agent started working — Geniro compacts the database at its next start instead',
        );
      }
      await restartAndNotify();
    },
  );

  // No schema: there is no input. Acts on the SENDER's own WebContents rather
  // than on a looked-up window, so this cannot be aimed at another window.
  handle(
    IPC.toggleDevTools,
    denyRemotely(
      "toggles DevTools on the calling window's own WebContents — there is no window behind a remote call",
    ),
    (event) => {
      event.sender.toggleDevTools();
    },
  );

  // Whether this becomes a banner is the notifications module's call, reading
  // the setting at the moment of the post — the renderer reports the event and
  // never the verdict. Acts on the SENDER's own window, like toggleDevTools: a
  // notification cannot be aimed at another window, and the click has to raise
  // the window whose renderer asked for it.
  handle(
    IPC.notify,
    denyRemotely(
      "posts a notification owned by the calling window and reports its click back to that window's WebContents",
    ),
    (event, input: unknown) => {
      notifications.post(notificationSchema.parse(input), {
        window: BrowserWindow.fromWebContents(event.sender),
        onActivate: (runId) => {
          // Back into the same renderer, so it can open the thread the banner
          // named. Guarded: the window can be gone by the time a banner posted
          // minutes ago is clicked, and a send into that gap throws.
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC.onNotificationActivated, runId);
          }
        },
      });
    },
  );

  // No gate on the setting: withdrawing a banner the switch never let through
  // finds nothing to withdraw, and one posted before the switch was flipped
  // off is still worth taking back.
  handle(IPC.retractNotification, ALLOW_REMOTELY, (_event, input: unknown) => {
    notifications.retract(retractNotificationSchema.parse(input));
  });

  // No input, and the SENDER's own window for the same reason `notify` uses it:
  // a test banner's click must raise the window that asked for it.
  handle(
    IPC.testNotification,
    denyRemotely(
      "posts a notification owned by the calling window and reports its click back to that window's WebContents",
    ),
    (event) =>
      notifications.testPost({
        window: BrowserWindow.fromWebContents(event.sender),
        onActivate: (runId) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC.onNotificationActivated, runId);
          }
        },
      }),
  );

  // No input at all, and that is the point — see the module's own doc block.
  // The renderer asks for THE notifications pane, not for a URL of its choosing.
  handle(
    IPC.openNotificationSettings,
    denyRemotely(
      'opens the macOS Notifications settings pane on the computer running geniro',
    ),
    () => openNotificationSettings((url) => shell.openExternal(url)),
  );

  // Throws rather than answering a fabricated empty state: a call reaching
  // here before `index.ts` has wired the real `RemoteAccess` is a startup
  // ordering bug, and a plausible-looking zero state would hide it instead
  // of failing the request that exposed it.
  const getRemoteAccess = (): RemoteAccess => {
    if (!remoteAccess) {
      throw new Error('remote access is not wired for this launch');
    }
    return remoteAccess();
  };

  // ALLOW_REMOTELY on all three: a paired phone reads its own gateway's state
  // and may revoke a device (itself or another), and none of the three acts
  // on the calling WebContents the way `toggleDevTools`/`notify` do. Each is
  // redacted, not merely allowed — see `redactRemoteAccessForRemote`.
  const remoteAccessRemotePolicy = allowRemotelyRedacted(
    redactRemoteAccessForRemote,
  );
  handle(IPC.getRemoteAccess, remoteAccessRemotePolicy, () =>
    getRemoteAccess().state(),
  );
  handle(IPC.regenerateRemotePairingCode, remoteAccessRemotePolicy, () =>
    getRemoteAccess().regenerateCode(),
  );
  handle(
    IPC.revokeRemoteDevice,
    remoteAccessRemotePolicy,
    (_event, deviceId: unknown) =>
      getRemoteAccess().revokeDevice(remoteDeviceIdSchema.parse(deviceId)),
  );

  // DENIED REMOTELY, unlike the three above, and the difference is the point.
  // Those read a gateway a caller has already been let into, or evict a device
  // from it. These two change WHERE this machine is reachable from — opening
  // one takes the app off the Wi-Fi and onto the open internet — and that is a
  // decision for somebody sitting at the Mac, not for whoever holds a paired
  // phone's cookie. A stolen phone must not be able to publish its owner's
  // agents.
  const tunnelDenial =
    'opens or closes a PUBLIC address for this machine — a decision for the computer running geniro, never for a device that merely paired with it';
  handle(IPC.startRemoteTunnel, denyRemotely(tunnelDenial), () =>
    getRemoteAccess().startTunnel(),
  );
  handle(IPC.stopRemoteTunnel, denyRemotely(tunnelDenial), () =>
    getRemoteAccess().stopTunnel(),
  );

  const getBrowser = (): BrowserService => {
    if (!browser) {
      throw new Error('the browser is not available for this launch');
    }
    return browser();
  };
  const browserDenial =
    'drives the in-app browser, whose pages and cookies live on the computer running geniro — never for a paired device';
  handle(
    IPC.browserState,
    denyRemotely(browserDenial),
    (_event, runId: unknown) =>
      getBrowser().state(browserRunIdSchema.parse(runId)),
  );
  handle(
    IPC.browserOpenTab,
    denyRemotely(browserDenial),
    (_event, runId: unknown, url: unknown) => {
      const address = browserOpenUrlSchema.parse(url);
      const run = browserRunIdSchema.parse(runId);
      const resolved = address === null ? null : resolveAddress(address);
      if (resolved !== null) {
        getBrowser().noteUserAddress(run, resolved);
      }
      return getBrowser().openTab(run, resolved, { openedBy: null });
    },
  );
  handle(
    IPC.browserNavigate,
    denyRemotely(browserDenial),
    (_event, runId: unknown, tabId: unknown, input: unknown) => {
      getBrowser().navigate(
        browserRunIdSchema.parse(runId),
        browserTabIdSchema.parse(tabId),
        browserAddressSchema.parse(input),
      );
    },
  );
  handle(
    IPC.browserHistory,
    denyRemotely(browserDenial),
    (_event, runId: unknown, tabId: unknown, action: unknown) => {
      getBrowser().history(
        browserRunIdSchema.parse(runId),
        browserTabIdSchema.parse(tabId),
        browserHistoryActionSchema.parse(action),
      );
    },
  );
  handle(
    IPC.browserCloseTab,
    denyRemotely(browserDenial),
    (_event, runId: unknown, tabId: unknown) =>
      getBrowser().closeTab(
        browserRunIdSchema.parse(runId),
        browserTabIdSchema.parse(tabId),
      ),
  );
  handle(
    IPC.browserSelectTab,
    denyRemotely(browserDenial),
    (_event, runId: unknown, tabId: unknown) => {
      getBrowser().selectTab(
        browserRunIdSchema.parse(runId),
        browserTabIdSchema.parse(tabId),
      );
    },
  );
  handle(
    IPC.browserSetBounds,
    denyRemotely(browserDenial),
    (event, runId: unknown, bounds: unknown) => {
      getBrowser().setBounds(
        browserRunIdSchema.parse(runId),
        browserBoundsSchema.parse(bounds),
        BrowserWindow.fromWebContents(event.sender),
      );
    },
  );
  handle(
    IPC.browserPopOut,
    denyRemotely(browserDenial),
    (_event, runId: unknown, title: unknown) => {
      getBrowser().popOut(
        browserRunIdSchema.parse(runId),
        browserPopOutTitleSchema.parse(title),
      );
    },
  );
  handle(
    IPC.browserDock,
    denyRemotely(browserDenial),
    (_event, runId: unknown) => {
      getBrowser().dock(browserRunIdSchema.parse(runId));
    },
  );
  handle(
    IPC.browserTabAction,
    denyRemotely(browserDenial),
    (_event, runId: unknown, tabId: unknown, action: unknown) =>
      getBrowser().tabAction(
        browserRunIdSchema.parse(runId),
        browserTabIdSchema.parse(tabId),
        browserTabActionSchema.parse(action),
      ),
  );
  handle(
    IPC.browserContinueInsecure,
    denyRemotely(browserDenial),
    (_event, runId: unknown, tabId: unknown) => {
      getBrowser().continueInsecure(
        browserRunIdSchema.parse(runId),
        browserTabIdSchema.parse(tabId),
      );
    },
  );
  handle(
    IPC.browserAnswerAuth,
    denyRemotely(browserDenial),
    (_event, runId: unknown, tabId: unknown, credentials: unknown) => {
      getBrowser().answerAuth(
        browserRunIdSchema.parse(runId),
        browserTabIdSchema.parse(tabId),
        browserCredentialsSchema.parse(credentials),
      );
    },
  );
  handle(
    IPC.browserCapture,
    denyRemotely(browserDenial),
    (_event, runId: unknown) =>
      getBrowser().capture(browserRunIdSchema.parse(runId)),
  );
  handle(
    IPC.browserForgetRun,
    denyRemotely(browserDenial),
    (_event, runId: unknown) =>
      getBrowser().forgetRun(browserRunIdSchema.parse(runId)),
  );
  handle(
    IPC.browserStopAgent,
    denyRemotely(browserDenial),
    (_event, runId: unknown, tabId: unknown) => {
      getBrowser().stopAgent(
        browserRunIdSchema.parse(runId),
        browserTabIdSchema.parse(tabId),
      );
    },
  );
  handle(
    IPC.browserLabelTab,
    denyRemotely(browserDenial),
    (_event, runId: unknown, tabId: unknown, label: unknown) => {
      getBrowser().labelTab(
        browserRunIdSchema.parse(runId),
        browserTabIdSchema.parse(tabId),
        browserTabLabelSchema.parse(label),
        'user',
      );
    },
  );
  handle(
    IPC.browserAgentRequest,
    denyRemotely(browserDenial),
    (_event, request: unknown) => runBrowserAgentRequest(getBrowser(), request),
  );

  handle(
    IPC.completeOnboarding,
    denyRemotely(
      'the first-launch setup flow on the computer running geniro — a phone is never the FIRST device to run it',
    ),
    async (_event, input: unknown) => {
      const { cliPaths, lastChatTarget } = onboardingInputSchema.parse(input);
      // Merge over existing overrides so a re-run of onboarding never clears a
      // previously-set agent path the user didn't touch this time.
      const current = readSettings();
      const settings = updateSettings({
        onboardingComplete: true,
        onboardingProgress: null,
        ...(lastChatTarget ? { lastChatTarget } : {}),
        cliPaths: { ...current.cliPaths, ...(cliPaths ?? {}) },
      });
      if (!current.onboardingComplete) {
        try {
          await restartAndNotify();
        } catch (err) {
          updateSettings({
            onboardingComplete: false,
            onboardingProgress: current.onboardingProgress,
          });
          throw err;
        }
      }
      return settings;
    },
  );

  return registry;
}
