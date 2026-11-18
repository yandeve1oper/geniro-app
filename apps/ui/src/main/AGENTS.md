# apps/ui — main process

The Electron main process (`apps/ui/src/main/`): IPC, git and worktrees, daemon supervision, the terminal panel, the LAN gateway, app updates and the network lockdown. The preload, renderer, design system and settings keys are in `apps/ui/AGENTS.md`, and the chats, teams and settings pages in `.claude/rules/ui-*.md`; macOS packaging is in `.claude/rules/packaging-config.md`. Project-wide commands, conventions and constraints are in the root `AGENTS.md`.

**Contents**: [Main process](#main-process) (incl. _Git_, _Task worktrees_, **Daemon supervision**, **Terminal panel**, **LAN gateway**) · [App updates](#app-updates) · [Security](#security)

---

### Main process

Where things live:

- `src/main/` is the Electron main process, `src/preload/index.ts` exposes the typed `window.geniro`, and `src/shared/contracts.ts` holds the Electron-internal contracts (IPC, Settings, CLI detection, `DaemonHandle`). Never add a daemon wire type to `shared/contracts.ts`; those are generated. One deliberate exception: `ShareDestination` inside `Settings.sharing`, which main owns in settings.json and pushes to the daemon as a twin (`shareDestinationSchema` in `ipc-schemas.ts` ↔ the daemon's `ShareDestinationSchema`).
- `main/agents/` holds one descriptor per CLI, collected as a total `Record<CliKind, …>`. No other main file names a CLI. The daemon's twin of each fact is that CLI's `AdapterConfig`.
- `main/remote/` is the LAN gateway (below). `main/notifications/` is system notifications. `updater.ts`, `update-installer.ts` and `update-service.ts` are app updates.
- Every git call this app makes belongs to main: `git-info.ts`, `git-changes.ts`, `worktree-service.ts`, `github-prs.ts`. The daemon runs no git.

IPC:

- Every IPC argument is validated against its zod schema in `ipc-schemas.ts` before main acts on it. The renderer is the untrusted side.
- Every channel declares a `RemotePolicy` in `ipc-registry.ts`: `ALLOW_REMOTELY`, `allowRemotelyRedacted` (strip a secret from the answer), `allowRemotelyExceptFields` (refuse fields a phone must never set, such as `updateSettings`' `cliPaths`/`daemonInspect`/`sharing`) or `denyRemotely`.
- Use `allow` only for a handler that never reads its event. The remote bridge hands handlers a Proxy that throws on any read.
- `toggleDevTools` acts on `event.sender` only, so one window cannot open another's devtools.
- `GeniroApi.filePath` is the one preload-local member (`webUtils.getPathForFile`). It is excluded from the IPC exhaustiveness check through `PreloadLocalMethod`.

Child processes and environment:

- `probe-env.ts` is the main-side twin of the daemon's `child-env.ts`. A probe child gets its own agent's credentials and never another's. A non-agent child such as `gh` gets `neutralEnv()`.
- Spawn a binary by bare name only through `resolve-binary.ts`. A Finder launch runs under launchd's minimal PATH, where a Homebrew binary fails with a silent ENOENT.
- `login-shell-path.ts` spawns the interactive shell with stdin on `/dev/null` and SIGKILLs it at its deadline. Otherwise a `.zshrc` that reads stdin hangs daemon start and ⌘Q.
- `cli-detect.ts`: a `loggedIn` of `null` means unknown, never signed-out. Read a CLI's structured reply where it has one (`cursor-agent status --format json`). Otherwise read the exit code and the wording together (codex answers on stderr).
- `cli-install.ts` runs the descriptor's `installer` as `curl -fsSL <url> | <shell>`, and only on the user's press. It reports success only once detection resolves the new binary's `--version`.
- `cli-update-service.ts` owns every CLI update (one run per CLI, a second press joins it) and broadcasts `onCliUpdates`, so a remounted Settings, or a phone polling `getCliUpdates`, still shows one running. `runCliUpdate` keeps reading `--version` after a clean exit while the last detection said a newer version exists (`lastDetection`, never a new probe), and reports a failure when the deadline passes on the old version.
- `config-profile-dir.ts` makes a new configuration's folder under `<userData>/agent-configs/<cli>/<slug>` (0700, never an existing one). `denyRemotely`.
- Main's own failures go to the daemon's log (`reportMainLog`, the `ui` channel), never to stdout. A packaged Finder launch discards main's stdout.
- A window whose renderer dies is reloaded (`shouldReloadAfterRendererGone`), except on `clean-exit`, while quitting, or when it died again within `RENDERER_RELOAD_WINDOW_MS` of the last reload.

Git (the hardening is under _Security_):

- Switch a branch with `git switch` behind a re-read dirty check, never `git checkout` (which treats a branch name as a pathspec and restores a file).
- `pullBranch` is stash, then `git pull --ff-only`, then stash pop. The pop runs on every path, a failed pull included. A failed stash push aborts the pull.
- `pullStashIsOurs` requires both that the stash ref moved and that the tip's subject ends `geniro: pull`.
- Decide which branches are checked out in another worktree from `git worktree list --porcelain`. Never parse git's translated error prose.
- Every `git worktree list` read goes through `worktree-list.ts` (`readWorktreeEntries`: `--porcelain -z`, newline framing only on git < 2.36); never hand-parse the listing. Path and branch are read off one record.
- `github-prs.ts` fails closed. Every failure (no `gh`, signed out, not GitHub, query error) is the empty list, with no "did it work" flag on the wire.

Task worktrees (`worktree-service.ts`):

- A worktree lives at `<userData>/worktrees/<taskId>` on branch `geniro/task-<id>`, derived from the task id and never from its title. Pass `--` before the path.
- `<userData>/worktrees.json` is the only thing that authorizes a recursive delete. A row naming a path outside the worktrees directory (compared segment-wise) is dropped, and nothing is removed for it.
- Before removing a worktree, confirm it against `git worktree list --porcelain`. Leave a row you cannot confirm alone.
- `reapFinishedWorktrees` removes only worktrees whose work the daemon calls finished (`POST /v1/tasks/finished`: Done, no turn running and no live work outside one, such as a monitor). Never remove every clean worktree at launch, because a worktree outlives its run.
- `prepareWorktree` reuses the task's standing worktree (`reused`). If the start is then refused, leave a reused worktree alone. Refuse anything else in the slot that is not empty.
- A worktree just made gets the files the checkout's `.worktreeinclude` lists (`worktree-include.ts`, Claude Code's convention): only untracked files the checkout's `.gitignore` also ignores, never through a symlink, never over a file already there. A reused worktree gets nothing. A failure is logged (`source: worktree`) and never fails the start. Nothing is kept anywhere but in the new worktree.
- `settleWorktreeForTask` is the only path allowed to clear a dirty tree. It runs `git add -A` onto the task's branch first. If the commit fails (hooks refused, no git identity), keep the worktree. Hooks run and are never skipped. The branch is never removed.
- Four IPC channels only: `geniro:prepareTaskWorktree` (returns a shaped `TaskWorktreeResult` and never throws), `geniro:pruneTaskWorktree` (keyed by task and looked up in the registry), `geniro:settleTaskWorktree` and `geniro:removeStorageWorktree` (Settings → Storage, `denyRemotely`).
- `removeWorktreeOnRequest` is the user's Remove press, so it is wider than the reaper: a clean worktree on any branch is removed (its commits stay on that branch), a dirty one only through `settleWorktreeForTask` on its task branch, and never one on a detached HEAD, with an operation stopped half way, whose card is still open, or whose repository is no longer where the registry says (moved, deleted or on a detached disk: nothing can confirm what it holds). A directory the registry does not name is removed only by `git worktree remove` without `--force`, after git lists it; a folder git does not call a worktree is never removed.
- `settleTaskWorktree` fires off the daemon's `work-finished` reason. Never fire it off a card's column (written optimistically on drag) or off its run settling.

Background loops in main (main hosts them because a renderer timer dies with the window and is throttled):

- **Autopilot** (`autopilot-conductor.ts`) is a recurring tick that starts what `GET /v1/projects/:id/queue` hands out, with `approval: 'auto'` and `startedBy: 'autopilot'`. It decides nothing about capacity, because the daemon enforces the cap and the breaker at the route. A refusal is the ordinary case: give the worktree back. A worktree it cannot prepare is reported to `POST /v1/tasks/:taskId/prepare-failed` with `gitFailureLine`'s reason; the daemon then holds the card in `blocked` and decides the retry, never the conductor. One failing project never ends the sweep. The tick is `unref`'d.
- **Command center starts** (`thread-start-conductor.ts`) drain `GET /v1/command-center/starts`: each start the user approved on the manager's Start card (or the manager made in `auto`) gets its worktree prepared and its run started with `startedBy: 'manager'` and the user's default approval, through the same `task-run-start.ts` path autopilot uses. A start it cannot make is reported to `POST /v1/command-center/starts/:taskId/failed`, which ends the request and wakes the manager; a 409 (another start holds the card) is left for the next tick. It holds the daemon keepalive while any approved start waits.
- **Daemon keepalive** (`daemon-keepalive.ts`) holds one authenticated Socket.IO client while any project is armed, so the daemon's idle exit does not fire with every window closed. It must authenticate, because an unauthenticated client is disconnected and not counted. `before-quit` disposes it.
- **Keep awake** (`keep-awake.ts`) polls `GET /v1/agents/activity` every `KEEP_AWAKE_POLL_MS` while `Settings.preventSleepWhileWorking` is on, and holds one `powerSaveBlocker` `prevent-app-suspension` id while the answer is `working`. Never a socket: a WS client would hold the daemon off its idle exit. A daemon without the route (404) is asked `defaultCheckBusy`. It lets go when the setting goes off, the daemon is gone, `KEEP_AWAKE_MAX_FAILED_READINGS` readings fail in a row, or `before-quit` disposes it; a failed reading never starts a hold. `daemonCameUp` pokes it.
- **Merge watcher** (`pull-request-merge-watcher.ts`) reports merges to `POST /v1/tasks/:taskId/pull-request-merged`. The daemon moves the card. Only a merge strictly after the card's `lastDoneAt` counts (`endsCard`, twin of the daemon's `mergedSince`). `readAwaitingMerge` is a twin parser of `TaskAwaitingMergeSchema`.

Smaller rules:

- `app-menu.ts`: **Toggle Developer Tools** is hidden, not deleted, so ⌥⌘I stays bound.
- **Clear Agent Cache** runs in the focused renderer. It reloads only after the daemon has answered, and never on a failure. It acts on the press alone, with no confirmation strip.
- **Component Catalog** appears only when `isDev` (`ELECTRON_RENDERER_URL`) is passed in, and is omitted otherwise. Its port is a twin of `apps/ui/package.json`'s `storybook` script. Main never starts Storybook.
- `reveal-path.ts` reveals in Finder and never opens.
- `open-artifact-path.ts` shows an artifact page's folder button in Finder: a plain folder opens, anything else (a file, a folder whose name has an extension — `.Tool.app` too — or that holds `Contents`, judged on the real path) is only revealed, so nothing launches. `denyRemotely`.
- Settings → Storage (`app-storage.ts`): main sizes only the data-folder names the daemon's `GET /v1/storage` left `unclaimed`, through one `/usr/bin/du -sk` call (hard links counted once, symlinks not followed), and clears only the window's HTTP and code caches (`session.clearCache`, `clearCodeCaches`). Every name arrives through `storageEntryNameSchema` (one path segment). `geniro:restartDaemon` (`denyRemotely`) is the page's restart for a scheduled compaction, the same `restartAndNotify` a settings change uses, refused when `isServingWork` finds a live run (the marker then waits for the next start).
- `open-terminal.ts` hands off to the user's own terminal through a 0700 `.command` file. `renderer/handoff-open.ts` is its one renderer helper, with one call site in `Chats.tsx`.
- `navigation-policy.ts` keeps the top frame on the renderer document. `URL.origin` cannot decide this, because it is `null` for every `file:` URL.

**Daemon supervision** (`daemon-supervisor.ts`):

- `start()` adopts a healthy daemon left by a prior instance only after checking pid, `/health/check`, identity, the bundled `version` and the pidfile's `entry` stamp (`mayAdopt`).
- The `entry` stamp is the only "is this the current build" signal. `version` is identical across rebuilds.
  - Same path with a changed mtime or size means a rebuild: replace it.
  - A different path (`pnpm daemon:dev`): leave it.
- Replace a stale daemon only when it is not busy and its identity is re-confirmed. The busy check fails toward busy, because replacing a daemon kills its agent children.
- A pid that is alive but fails health or identity is refused, never signalled, and no second daemon starts. A recycled pid's pidfile is swept.
- The root `dev` script must stay `turbo run dev --filter=@geniro/ui`. Turbo's `^build` edge, plus the otherwise-unused `@geniro/daemon` dependency in `apps/ui/package.json`, is what rebuilds `dist/` before launch.
- Every spawned daemon gets `GENIRO_IDLE_EXIT_MS`, so a daemon the app no longer owns can stop itself.
- `ensureDaemon()` is the one path that both launch and `activate` take.
- On darwin, ⌘W hides the window rather than destroying it, because notification decisions live in the renderer. `activate` re-shows that window.
- An owned daemon that exits unexpectedly is respawned with a capped backoff (1s → 30s, then Retry). Exits the app asked for are left alone: stop, restart, quit, and idle.
- A crash leaves its pid in `<userData>/daemon-crashed` (`consumeCrashMark`).
- Before signalling a daemon, write the cause to `<userData>/daemon-stop-cause` (`quit`, `self-update`, `restart`, `crash`). The daemon's boot reconcile reads it. Write it only for a daemon seen serving (`handle !== null`): one still booting has not read the previous note, and overwriting an unread `crash` lets the autopilot restart crash-cut cards unattended.
- `start()` joins an in-flight restart rather than racing it.
- A starting daemon prints `GENIRO_DAEMON_MIGRATING {…}` before each data migration step (`parseMigratingLine`, twin of the daemon's `MIGRATING_LINE_PREFIX`). stdout is line-buffered for it (chunks do not follow lines; the echo stays chunk by chunk), each line moves the start deadline to at least `START_TIMEOUT_MS` from now, and the step is pushed to the renderer (`onDaemonMigrating`, also on `getStatus`'s `daemon.migrating`) for the startup screen's "Updating your data…", cleared when the start settles.
- An exit with `DAEMON_MIGRATION_EXIT_CODE` (78) is a failed migration step (rolled back for a database step, stopped after the commit for a file step): the start fails with `DaemonMigrationFailedError` built from `<userData>/migration-error.json`, and the respawn loop stops on it. The startup screen's Retry still starts one.
- A start with `<userData>/compact-on-start` present (`DAEMON_COMPACTION_MARK_NAME`, twin of the daemon's `COMPACTION_MARKER_FILE`) waits `COMPACTING_START_TIMEOUT_MS` instead of `START_TIMEOUT_MS`: the daemon compacts the database before it listens.
- `before-quit` runs each step isolated through `quit-teardown.ts`, with `app.quit()` in a `finally`.

**Terminal panel** (`main/terminal-sessions.ts`, `renderer/terminal/`):

- Main owns the node-pty shells.
- A session belongs to the WebContents that created it. Only that one may write, resize or kill it, or receive its output, and only from its top-level frame (`terminalOwner` refuses when `senderFrame !== sender.mainFrame`).
- A window's shells are hung up on `destroyed`, `render-process-gone` and main-frame `did-navigate`, and all shells at `before-quit`. Use `did-navigate`, never `did-start-navigation`, which also fires for blocked navigations.
- The shell env drops only `GENIRO_`/`ELECTRON_`/`npm_` keys. It is the user's shell, so their own credentials stay.
- Output is flow-controlled. A view acks each batch once xterm has drawn it (`terminalAck`). A hidden window acks on receipt.
- The renderer mints the session id per mount of `terminal-view.tsx`.
- Closing the panel hides it and never unmounts it. Closing a tab ends that shell.
- node-pty is an app `dependency` with an N-API prebuild. Never add it to `rebuild:native`. `spawn-helper` is unpacked from the asar, and `build-mac.mjs` restores its exec bit.
- The in-app terminal is a different feature from the "continue in your terminal" handoff.

**LAN gateway** (`main/remote/`). The hard rules (daemon stays loopback-only, pairing gate, Origin check, injected token, Host guard, tunnel on a press only) are in the root `AGENTS.md` → _Constraints_. In code:

- `gateway.ts` listens on `REMOTE_PREFERRED_PORT` (47616), with a free-port fallback. Routing order: its own routes, then `/v1/*` and `/health` proxied, then `/ws` upgraded, then the bundle, all behind one path-traversal guard.
- The one unpaired `/v1` arm is an artifact page's audio or video (`artifact-media-request.ts`, a twin of the daemon's id and media-file shapes): exact path, `key` the only parameter, GET or HEAD, proxied with `proxyHttp(…, { withToken: false })`.
- Match the upgrade as `/ws` or `/ws/…`. engine.io requests the trailing-slash form, so an exact match breaks live streaming while every unit test still passes.
- `daemon-proxy.ts` drops any client `x-geniro-via` and stamps `x-geniro-via: remote` on every request and upgrade it forwards (twin of the daemon's `auth/remote-marker.ts`).
- `host-guard.ts` matches a `*.suffix` at a label boundary.
- The tunnel mask is derived from the URL the client printed, never stored per provider.
- `tunnel.ts` providers are a table in preference order (cloudflared, then ngrok). The client is spawned with only `PATH` and `HOME`.
- An address is `open` only once it can answer. cloudflared prints its URL before it has a connection and before the name is in DNS, and a lookup that beats the record is cached as NXDOMAIN by the user's router, so reloading does not help. So a provider with a `connected` line stays `starting` until that line (or its `/ready`) and `TUNNEL_NAME_SETTLE_MS` since the URL line, with the client's latest complaint as `detail`, and fails at `TUNNEL_CONNECT_WAIT_MS` in its own words.
- An open tunnel is watched after its address is shown: an exit nobody asked for, or cloudflared's loopback `/ready` failing for `TUNNEL_EXPIRED_AFTER_MS` on the wall clock (a quick tunnel is deleted ~13 min after it disconnects, e.g. through sleep), ends it as `status: 'error'` and reaps the client. A connection counts only when two answers in a row report it (the client reports its pre-sleep connection for seconds after wake), and expiry needs `TUNNEL_EXPIRY_CONFIRM_MS` of failures without a break. The public URL is never probed.
- `pairing.ts` is a constant-time compare.
- `device-registry.ts` stores only a token hash, written atomically with mode 0600.
- Revoking a device, or stopping the gateway, destroys that device's upgraded sockets.
- `remote-routes.ts` answers bridge calls through the same `ipc-registry.ts` table as IPC. `on*` push channels are no-ops remotely, and `filePath` answers `null`.
- `serveStatic` 404s a missing file. Only a navigation (no extension, not under `/assets/`) falls back to `index.html`.
- Cache headers: the page is `no-store`, `/assets/*` are `immutable`, and everything else is `no-cache`.
- Proxied answers and bundle files are compressed for a client that accepts it (`compression.ts`: brotli, else gzip). Only text types and SVG; never an event stream, an already-encoded body or one under `MIN_COMPRESSIBLE_BYTES`. A daemon answer and a bundle file go out through `stream.pipeline`, never `pipe`: a daemon or file failing after the headers went out cuts the answer instead of leaving it open, and nothing is appended to it.

### App updates

**App updates**: `updater.ts` reads the feed, `update-installer.ts` stages and swaps, and `update-service.ts` holds the policy and state. electron-updater is not used.

- Never replace the running bundle. Staging goes to `<bundle>.new-<pid>` beside the app, and `applyStagedUpdate` runs from `will-quit` as two renames.
- The old bundle is moved aside, never deleted first. A failed second rename restores it.
- Every `rm` runs inside the refcounted `withoutAsar`. Under Electron, `fs.rm` walks into an `app.asar` and never returns.
- A release without `SHA256SUMS.txt` is refused.
- `fetchLatestRelease` reads the release list, filters drafts and pre-releases, and orders by parsed version. It answers both `release` (installable) and `published` (newest tag).
- `ready` is an ending: `check()` returns early.
- Automatic checks are silent unless the state changed. `emit` broadcasts only on a real difference. One that fails or times out changes nothing, so a standing offer or status stays; only a pressed check reports an error.
- `canInstall` is asked of the filesystem on each use. A translocated, read-only or other-account install gets the `brew upgrade --cask geniro` sentence instead.
- Main owns the state, and the renderer reports presses. Every non-terminal phase has a deadline. A trip bumps `attempt` and aborts the work.
- `sweepUpdateDebris` runs at launch and matches only the names this code writes.
- `failedPhase` is derived in `emit`. `updateStatusText` is the one composition, joined with a colon. Never capitalise the fragment.
- Failures go to the daemon log through the injected `UpdateLog`.
- Nothing installs unasked. The check runs at launch and every 5 minutes when `checkForUpdates` is on. The download needs a press.

### Security

- `SAFE_CONFIG` (`git-safe-config.ts`) applies to every read-side git call:
  - Empty every repository `filter.*` driver (`clean`, `smudge`, `process`, `required=false`).
  - Pass `--ignore-submodules=dirty`, `core.hooksPath=/dev/null` and `core.fsmonitor=false` (a repository's fsmonitor is a program git runs on any index read).
  - Refuse a driver name `-c` cannot address.
- User-pressed actions (switch, pull, stash, the worktree commit) keep the repository's filters and hooks.
- A task worktree is committed and removed only while HEAD is the task's own branch, with no operation half done. A detached HEAD is kept. The one wider path is the user's Remove press (`removeWorktreeOnRequest`, above), which removes a clean tree on another branch and commits nothing there.
- The renderer has no network beyond loopback and the artifact CDNs, WebRTC included (`network-lockdown.ts`). Three measures, all needed:
  - `disable_non_proxied_udp`.
  - A black-hole SOCKS proxy.
  - `host-resolver-rules` mapping every name to NOTFOUND except `localhost`/`127.0.0.1` and `ARTIFACT_CDN_HOSTS`.
- `ARTIFACT_CDN_HOSTS` is a twin of the daemon's `ARTIFACT_PAGE_CSP`, checked by `network-lockdown.spec.ts`. Anything new that loads a remote host through Chromium will fail to resolve, deliberately.
- The one exception is the in-app browser (`browser/`, root `AGENTS.md` → _Constraints_, item 8). Its tabs run on their own sessions — `persist:geniro-browser-<runId>` per chat, `geniro-browser-own-<id>` in memory for an own-cookie tab — and every one is made by `configureBrowserSession`, which awaits `setProxy` onto the loopback egress proxy (`proxyBypassRules: '<-loopback>'`, so loopback stands go through it too) before anything loads, denies every permission and sends downloads to `~/Downloads`. The resolver rules still map every name to NOTFOUND; the proxy resolves in Node (`localhost` and `*.localhost` to 127.0.0.1 and `::1` itself, since a dev server often listens on `::1` alone), tunnels CONNECT to any port and forwards absolute-form `http://`, and refuses an origin-form request so a page cannot use it as a relay. Never hand the proxy to `session.defaultSession` or the main window, and never create a browser session outside `configureBrowserSession`.
- Browser tabs (`BrowserService`) are `WebContentsView`s placed over the renderer's placeholder (`browserSetBounds`, which main applies to the window that sent it: the main window's docked pane, or the chat's pop-out) and moved into the pop-out with `contentView.addChildView`, which never reloads them. The pop-out (`createBrowserPopout` in `index.ts`) loads the renderer with the main window's preload and guards at `#browser-window?run=…` (`shared/browser-window-route.ts`), which renders only that chat's `BrowserPane`; closing it docks back. A view paints over the renderer, so while a dialog, menu or popover is open the renderer hides it and shows a `browserCapture` still. Agents drive tabs only through `webContents.debugger` (`browser-agent.ts`), handed each request by the renderer from the daemon's `browser_request`; no remote-debugging port is ever opened. Every browser channel is `denyRemotely`.
