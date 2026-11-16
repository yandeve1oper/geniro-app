# apps/ui

The Electron app: main process, preload and React renderer (electron-vite). Project-wide commands, conventions and constraints are in the root `AGENTS.md`. Renderer styling and reuse rules are in `.claude/rules/renderer-*.md`.

The chats, teams and settings pages are rules in `.claude/rules/` (table below), loaded when a file under their `paths:` is touched; on Codex (skill `rule-<name>`), and on Cursor when one is not in context, open it before editing that page. This file keeps what holds for every change to the app.

**Contents**: [Renderer shell](#renderer-shell) · [Design system](#design-system) · [Settings](#settings) (_Settings keys_) · [System notifications](#system-notifications) · [Sidebar](#sidebar) · [Page rules](#page-rules)

---

Main process (git, task worktrees, **Daemon supervision**, **Terminal panel**, **LAN gateway**), app updates and security: `apps/ui/src/main/AGENTS.md`. macOS packaging: `.claude/rules/packaging-config.md`.

### Page rules

<!-- prettier-ignore -->
| Area | Rule |
| --- | --- |
| Chats | `ui-chats.md` |
| Teams | `ui-teams.md` |
| Settings pages (Storage, Lessons, Knowledge, Memory, …) | `ui-settings.md` |

### Renderer shell

- The phone page is not a secure context: the gateway serves plain http. Use `renderer/random-id.ts`, never `crypto.randomUUID`, and `renderer/clipboard.ts`, never `navigator.clipboard`. eslint bans both direct uses.
- A new secure-context-only API passes every test and fails only on the phone.
- Stale bundle: `renderer/stale-bundle.ts` → `reloadForNewBundle` reloads once, from whichever of three places sees a chunk-load failure first: `vite:preloadError`, the root `ErrorBoundary`, or `boot-app.tsx`. A second page failing within 30s shows the error instead of looping.
- Phone layout (below `sm`) is pages under `components/bottom-tab-bar.tsx`.
  - Each detail page holds one marked browser-history entry (`components/use-phone-back-entry.ts`). Every way back goes through `history.back()`.
  - The shell's hash sync must pass `history.state` through `replaceState`, never `null`.
- The window never scrolls (`html, body, #root { overflow: clip }`). A full-screen view scrolls an outer pane and caps width with a separate inner column, never with one element.
- jsdom computes no layout. Specs pin the DOM fact that decides a layout (which element scrolls, the class, document order), never a measured position.
- Title bar (`components/title-bar.tsx`, one band above all columns):
  - `TRAFFIC_LIGHT_*` and `TITLEBAR_CONTENT_INSET` live in `shared/contracts.ts`, because main positions the buttons and the renderer reserves room for them. Re-measure before changing them.
  - `trafficLightPosition.y` and the bar's `h-11` move together.
  - The title bar is the only drag region (`.app-drag`). Any control inside it needs `.app-no-drag`.
  - The title is centred on the window, never measured from a column's width. Never put a flex `gap` on the bar row. The title bar is the one header band: no per-column header rows and no divider.
  - The debug log is ⌥⌘L only.
  - `chats/waiting-status.tsx` counts what waits on the user (asking, failed, unread); a press or ⌘J (`chats/use-next-waiting-shortcut.ts`) opens the next one. Window-wide chords go through `components/use-global-chord.ts`.
- A Settings note under a control is one line: what flipping it does, plus the one consequence nobody would guess.

**Projects (`projects/`, `#/projects[/<id>]`):** a gallery of cards (`projects-library.tsx`, `project-card.tsx`; a card opens the page) and one project's page (`project-detail.tsx`: a hero, then `ProjectSection` cards) — name (renamed from the hero's pencil), folder and card key, the description and the instruction blocks (`project-instructions-form.tsx` over the shared `components/instruction-blocks.tsx` the team's Instructions card uses too, with no audience; a block a daemon refusal would meet holds the save, `project-instruction-blocks.ts`; autosaved through `useDebouncedPersist`, each write quoting `instructionsRevision`; a `409 PROJECT_INSTRUCTIONS_DRIFT` keeps the typed text and offers a reload), its run configurations (created, edited, ordered and deleted there), its default agent or team (a section of its own: the board's cards and autopilot run as it, and picking the project in the new-chat composer preselects it — `projects/project-composer-target.ts`, a manual pick only) with a Team section when it is a team (`project-team-overrides.tsx`, `.claude/rules/ui-teams.md` → **Project overrides**), the overrides it kept of other teams (`listProjectTeamOverlays`, Remove), the autopilot, and the instruction size a run there carries per CLI (`POST /v1/projects/:projectId/instruction-sizes` over `use-project-instruction-sizes.ts`: the preamble, the user's custom instructions and reply language, the project's text and the memory index a run there would snapshot, read again on a saved name or text change and a settings write). A card's and the page's running and waiting counts are the daemon's queue read (`use-project-queues.ts` over `readProjectQueue`): a project is re-read after its own task changes (the daemon also announces a card whose own run starts or settles where it stands) and any change to it but a text edit; every project after a reconnect; the page reads only its own project's queue. A queue not read yet draws no figure. The list is the daemon's, re-read on `projects_changed` (`daemon-client.ts` `onProjectsChanged`) and after a reconnect; the page also re-reads after its own name, run-settings and autopilot writes. Pickers read `useProjectRefs` (id, name, folder), which skips a `textsOnly` event and keeps its value while those three are equal, so an autosave of a project's texts neither re-reads nor re-renders Chats. The new-chat composer holds its project as `{projectId, source}` (`config` from an applied configuration, `manual` from its chip, `folder` from `GET /v1/projects/of-folder`): a chosen one outlives a folder change and is sent as chosen (the daemon passes over an id it no longer has), falls back to `folder` once the loaded list no longer holds it, the chip shows only when a project applies, `folder` sends nothing (the daemon resolves it the same way), a cleared chip sends an explicit null. A started thread's project is the run wire's `project`, drawn as a static shelf chip.

**Board (`tasks/`):**

- A card's Agent settings carry the model parameters the CLI offers (`TaskRunConfigRows`), each inherited from the project while the card names no model of its own (`resolveRunTarget`). A change of model or target clears them.
- Card edits are optimistic (`useBoard.updateTask`). Never build the panel's fields from the saved card alone.
  - In-flight edits are re-applied over reloads.
  - An answer older than a newer edit is ignored.
  - A refused edit is undone only in fields that still hold what it wrote.
- The New task dialog stages pictures and files. `useBoard.createTask` creates the card without the staged references, writes the pictures, repoints the references, then binds files.
- The dialog is hidden, not unmounted, so its reset on open must also clear staged phone uploads.
- A paused autopilot (`autopilotIsPaused`: its breaker tripped, or `autopilotResumesAt` while a usage limit stands) draws its `AutopilotControl` on the every-project board too, one `named` chip per project. A limit's lapse announces nothing, so the board and `useProjects` re-read the list at the soonest `autopilotLimitUntil` (`use-autopilot-limit-lapse.ts`), re-armed on every answer.
- The "cannot start" popover offers the board's run settings only for a blocked `kind` they can answer (`FIXED_IN_RUN_SETTINGS`); the board re-reads the queue after the soonest blocked `retryInMs` (`soonestRetryInMs`), re-armed on every queue answer, since nothing announces a hold lapsing.

**Stats (`stats/`):**

- Chart colours come from `stats/charts/chart-theme.tsx` only. The transcript's chart card reuses it.
- Line counts are measured in the renderer per repository root and branch (`use-line-snapshots.ts`), against a daemon-held baseline.
  - The reads (`getGitHead`, `getChangesTotals`) are `denyRemotely`, and the hook is silent on a phone.
  - A git check that merely failed answers `null`. Never replace a baseline over a timeout.
  - Before the daemon stops, main asks windows to flush in-flight measurements (`line-measurement-flush.ts`).
- `dayRangeTitle` reads local days. Never take the day from `iso.slice(0, 10)`.
- `formatUsd` is pinned to `en-US`.
- `formatPercent` never rounds up to a whole the value did not reach.

### Design system

The rules live in `.claude/rules/renderer-*.md`; start from `renderer-components.md`, which also holds the catalog-coverage rule. Main-process and tooling facts they do not cover:

- The theme is applied by main, with no IPC channel. `Settings.theme` is read by `main/native-appearance.ts`, which sets `nativeTheme.themeSource`. That one write themes the OS chrome and drives the renderer's `prefers-color-scheme`.
- `applyTheme` is the only exported way to apply a theme, because it also repaints the window `backgroundColor` (`watchSystemAppearance`). Never export the bare OS write.
- `createWindow` reads `resolvedTheme` → `ThemeDescriptor.windowBackground` from `shared/themes.ts` before any stylesheet exists.
- Storybook is dev-only and binds `127.0.0.1` explicitly (its default would serve the workspace over the LAN).
- `.storybook/preview.tsx` drives `theme/apply-theme.ts` and never sets `data-theme` itself. It installs the `window.geniro` stub before any other import.
- xterm and ANSI output are themed from tokens (`terminal-theme.ts`, `--ansi-*`). `ESC[90m` means dim and must never map onto `--ansi-black`. A copy of command output hands over `stripAnsi(text)`.

### Settings

**Settings keys (`settings.json`).** `main/settings.ts` owns the file, and `shared/contracts.ts` holds `Settings`. Values whose vocabulary is the daemon's stay opaque strings here. The renderer validates them against the generated enum. `interface Settings` in `shared/contracts.ts` is the authoritative key list; this list covers the keys with special rules.

- `settingsVersion`: the last settings migration the file was brought up to (`main/settings-migrations.ts`), 0 for a file that predates it; a file written by a newer build keeps its higher number. Main's alone: `settingsPatchSchema` does not carry it, and `readSettings` reads it outside the salvage loop. A key rename or reshape is a step in `SETTINGS_MIGRATIONS`, applied to the raw JSON at launch before the first `readSettings` (the salvage drops a key this build does not know), after copying the file to `<userData>/backups/<id>-<ISO>/`. A step that throws leaves the file and its version as they were (the launch logs the failure), `readSettings` reads it with the steps before the failed one applied in memory (`withPendingMigrations`), and while the file is below the current version a write replaces only the keys it changes (`unmigratedFile`), so the next launch can retry; a step therefore leaves a key already in the new shape alone and never overwrites a target key already present.
- Composer memory: `lastChatTarget`, `lastApprovalMode`, `lastAutoCompactPercent`, `projectFolder`/`recentFolders`. The setup last used in a chat that improves something — a thread's or team's analysis, a team's or project's chat (`chats/improvement-chat-setup.ts`): `lastAnalysisConfig` (agent, profile, model, effort, context window, auto-compact, model parameters, approval), written when the analysis dialog starts one and when `HostedThread.onRunSettingsChanged` reports a chip change in the chat; a key a choice saved earlier lacks reads as unset. Its `approval` is the analysis's alone (null reads as auto-approve, never the composer's mode, and `plan` is never recorded); a team's or project's chat keeps its own in `lastChangeChatApproval` (null reads as `acceptEdits`), so an analysis's auto-approve never reaches a chat whose changes wait on the user's press. Such a chat has no agent picker, so its agent is the one remembered, unless a new team's first chat was given one (then the setup applies only if it is that CLI's); a setup the daemon refuses opens it on defaults, since nothing else there could correct it. The last choice of the memory import's Sort with AI and of the cleanup's Conflicts check, which share it: `lastMemoryTriage` (agent, profile, model, effort, context window, model parameters). `lastModels`, `lastEfforts`, `lastContextWindows`, `lastModelParameters` (`{parameterId: value}`), `configDirs` and `recentConfigDirs` are keyed per CLI.
- Hand-managed lists, three different features: `fastActions`, `runConfigs` and `configProfiles`. Never fold any two together, or into `recentConfigDirs`.
  - Nothing adds or evicts an entry, and order is preserved.
  - `readSettings` salvages each list entry by entry (`salvageList`, twin of `salvageCliRecord`) and re-applies the cap.
- `agentOptions`: `{<cli>: {<optionId>: on}}`, from capabilities `options[]`. It is snapshotted onto the run.
- `notificationsEnabled`: one switch for every notification kind.
- `archiveRetentionDays`: `null` by default. It arms a permanent deletion sweep (`POST /v1/chats/sweep-archived`), and the daemon learns the window from the client.
- `customInstructions`: see `.claude/rules/ui-settings.md`.
- `replyLanguage`: the language every agent is told to reply in (`''` = not set), at most 64 characters (twin of the daemon's `REPLY_LANGUAGE_MAX_LENGTH`). Sent at every run start beside `customInstructions`.
- `theme`: read by main before any window exists, and enumerated in `settingsPatchSchema`. An unknown value falls back to `'system'`.
- `historyPageSize`, `checkForUpdates`, `remoteAccessEnabled`, `daemonInspect`, `cliPaths`.
- `keptSessionIdleMinutes`: how long a run's CLI and its MCP servers are kept after the last turn, 5–180, default 60 (a subscription's prompt-cache TTL), the same for chats and cards. The same window ends what the run's agents left running outside the CLI that attribution can reach (dev servers, watchers; not an orphaned system binary), with a note in the transcript (`.claude/rules/daemon-run-processes.md` → Idle). The bounds are twins of the daemon's (`chat.types.ts`). Every write that changes it is pushed to the daemon (`kept-session-config-push.ts`, through `onSettingsWritten`), as is every daemon start; the daemon holds it in memory.
- `keptSessionLimit`: how many run CLI processes the daemon keeps at once, 2–64, or `null` (default) for the daemon's own memory-derived ceiling. Bounds are twins of the daemon's (`chat.types.ts`); pushed with `keptSessionIdleMinutes` in the same body. The Settings row reads `GET /v1/agents/sessions/config` (desktop only, so the row is left off a paired device) for the automatic figure, the per-process cost and total memory, and multiplies only what it is given for the memory estimate.
- `preventSleepWhileWorking`: on by default. While on, main holds `powerSaveBlocker` `prevent-app-suspension` exactly while the daemon answers `GET /v1/agents/activity` `working` (`main/keep-awake.ts`); it never holds the display, and a closed lid still sleeps. Read at launch and applied on every write (`onSettingsWritten`).
- `sharing`: `{destinations, defaultDestinationId, agentsMayShare, autoRevokeAfterDays}` — where pages are shared to, whether agents may share (off by default), and after how many days the daemon revokes a page on its own (`null`, never, by default; counted from the first share). A custom (`command`) destination may carry `signIn: {login?, patterns?}` (login argv, and output phrases meaning signed out). Salvaged destination by destination (`salvageSharing`), and a broken `signIn` field by field, never costing the destination; the shape is a twin of the daemon's `ShareDestinationSchema` (`ipc-schemas.ts` restates its limits). Every write that changes it is pushed to the daemon (`share-config-push.ts` over `daemon-config-push.ts`, through `onSettingsWritten`), as is every daemon start. Desktop only.
- `knowledge`: `{enabled, agentWrites}` — whether agents get the knowledge index and tools (on by default), and whether an agent's write waits for review (`review`), is saved at once (`direct`, default) or refused (`off`, `knowledge_save` unlisted). Pushed by `knowledge-config-push.ts`; a paired device may write it.
- `resourceAlerts`: `{enabled, threadMemoryBytes, growthBytesPerMinute, minFreeDiskBytes}` — whether the daemon watches threads' memory, the system's memory pressure and free disk (on by default), and its lines (8 GB per thread, 1 GB/min of growth, 10 GB free). Its switch is in Settings → Notifications, hidden on a paired phone; the lines are still edited in `settings.json`. Salvaged field by field (`salvageResourceAlerts`); a twin of the daemon's `ResourceAlertConfigSchema`. Every write that changes it is pushed to the daemon (`resource-alerts-config-push.ts`, through `onSettingsWritten`), as is every daemon start; the daemon uses the defaults until the first push. Desktop only: a paired device may not set it (`ipc.ts`, `updateSettingsRemotePolicy`), as the daemon's `PUT /v1/resource-alerts/config` is desktop only.
- `memory`: `{enabled, agentWrites, nativeMemoryOff}` — whether agents get the shared memory's tools (on by default), whether an agent's write is saved at once (`active`, default) or waits for the user's review (`pending`, under which agents can only add entries — their updates and forgets are refused), and whether new runs switch each CLI's own memory off (off by default; a successful import in Settings → Memory turns it on). Salvaged field by field (`salvageMemory`); these three fields are a twin of the daemon's `MemoryConfigSchema`, which also takes `autoForgetAfterDays` and `removeNotUseful` from the keys below. Every write that changes it is pushed to the daemon (`memory-config-push.ts`, through `onSettingsWritten`), as is every daemon start; the daemon holds it in memory and uses the defaults until the first push. Writable from a paired device (the user reads and edits memory from the phone).
- `lessons`: `{mode, reflector, checker}` — whether reflections run by themselves when a thread is archived (`auto`, default, or `off`; Reflect now works either way); `reflector`, the agent a reflection runs as (a `MemoryTriageConfig`: CLI, profile, model, effort, context window, model parameters; null = "Same as the thread": the thread's own CLI and profile on that CLI's light model at high effort); `checker`, the second model that checks found lessons (same shape; null = off). Salvaged field by field (`salvageLessons`; an old `mode: 'offer'` reads as `auto` and an old `agentKind`/`model`/`effort` becomes the reflector); a twin of the daemon's `LessonsConfigSchema`, pushed by `lessons-config-push.ts` on every write that changes it and every daemon start. Desktop only (`ipc.ts`, `updateSettingsRemotePolicy`): it decides what a reflection spends. Edited in Settings → Memory → Lessons (`settings/lessons-settings.tsx`) with the composer's own pickers (`TargetSelect` plus the model settings menu).
- `memoryAutoForgetAfterDays`: a number of days, 1–3650, or `null` (the default, never forget on its own). Desktop only: a paired device may not set it (`ipc.ts`, `updateSettingsRemotePolicy`). It is pushed beside `memory` as `autoForgetAfterDays` (`memoryConfigOf`, `memory-config-push.ts`), and arms the daemon's daily auto-forget sweep, which forgets cold entries and never purges them.
- `memoryRemoveNotUseful`: a boolean, `true` by default. Desktop only, as the key above (`ipc.ts`, `updateSettingsRemotePolicy`). Pushed beside `memory` as `removeNotUseful` (`memoryConfigOf`, `memory-config-push.ts`); the daemon forgets an entry that more threads marked not useful than helped, and deletes its batch for good 30 days later. Settings → Memory → Clean up, under the auto-forget row.

### System notifications

**System notifications** — the renderer decides when (`renderer/notifications/run-notifications.ts`, mounted from `Chats`), and `main/notifications/` decides whether and posts.

- The rules read display statuses, never the daemon's row.
- `notificationsEnabled` is read at the moment of posting.
- A run seen for the first time never notifies.
- A cancelled turn is not announced. A `failed` turn is.
- The open chat is skipped only while the window has focus and the Chats view is on screen.
- `notifier.ts` is the only file that touches a notification API. It uses Electron's `Notification`, never `node-notifier`.
- A turn ending with a command still running is announced provisionally and withdrawn (`retractNotification`) if the run goes back to work. Never guess with a timer.
- `notify_user` arrives as `RunStatusEvent.notify` and is posted once (`AgentNotice` id).
- `share-sign-in` is posted once per agent share that starts waiting on the user's sign-in (`shares_changed` with `signInRequested`, `useShareSignInNotifications`), never for the user's own press and never carrying the link.
- `resource-alert` is posted once per resource alert the daemon raises while the window watches (`resource_alerts_changed`, `resource-alerts/use-resource-alerts.ts`); what the first read finds is shown in the strip but not announced. An alert that blames no thread posts with an empty `runId`, which the activation path refuses. A growth alert's × is the daemon's (`dismissResourceAlert`), so the thread does not post again under a new id; any other alert put away stays hidden in this window only.
- An open thread's ending is held (`settleOwed`) until its settle arrives, then posted or dropped by that settle's own flag.
- The rules read `runs + offScopeRuns`, because "absent" reads as deleted.

### Sidebar

- The unread mark is the daemon's: `attentionAt` later than `seenAt`. Both timestamps only move forward. Never compute it per window.
- Report "seen" only while the thread is actually watched (`useWindowWatched`).
- What a thread waits on the user for (`chats/waiting.ts`: asking > failed > unread > working, longest wait first) is read from the unfocused status and `useUnseenRuns`. An unread team run whose leads ended their turns (`rootsIdle`) is read with the agent-stopped status, so the Manager's reply counts as unread while its calls work on. It drives ⌘J, the title-bar count, the nav rail's Chats count, board-card marks and the agents panel's card order, and never the sidebar order: a waiting thread does not move itself (user decision). ⌘J continues from the reading it last opened, because opening an unread thread drops it from the queue.
- Drafts, the queue and turn-end banners stay per device.
- Archive is the row action. Permanent delete exists only inside the archive. Team rows archive too.
- `refreshRuns` drops a stale generation, and runs one listing per scope at a time plus one queued; only a scope switch supersedes one in flight.
- The archive and `Show all` are paged (`chats/run-list-pages.ts`, `RUN_LIST_PAGE` rows per half, `limit` + `before*` cursor); the desk is never paged. A re-list keeps the depth already read. Rows one half has but the other has not reached yet are held back (`horizonOf`), and the list ends in "Load older chats".
- An unknown run is adopted by fetching that one row (`runId` on both listings), never by re-listing, and only on an announce of it doing something (a status or an activity). A pull-request, title or context announce never adopts.
- `placeRun` re-files a row on archive or unarchive, and `dropRun` is for permanent delete only.
- Row actions read `run.archivedAt`, never the scope.
- A scope switch keeps the open thread only if the new scope lists it.
- An archived chat is inert (`RUN_ARCHIVED`), but it can still be read: its row and the agents panel offer Analyze thread as on a live one. Archiving a running chat asks first, because it cancels the turn.
- Groups: the auto-file rule matches the longest `autoCwd`, segment-wise, and a team claim outranks any folder claim. Adding a rule does not sweep existing chats.
- Deleting a group releases its chats (asked first).
- Dragging reorders; the daemon is told once, at `dragend`. The drop zone is the whole section. A drop that changes nothing writes nothing.
- A group header's state comes from its rows' badges, never from the daemon `status` column. `needsInput` is reported alongside `busy`.
- The sidebar row is one activatable element, so nothing inside it may be a control (labels, not chips).
- A team row previews its root conversation (`previewsThread`, twin of `ItemDao`'s `NOT_IN_A_CALL`).
- A background thread's preview comes from the `run_status` announce, not from items.
