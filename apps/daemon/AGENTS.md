# apps/daemon

The NestJS loopback daemon the Electron UI spawns and supervises: CLI agent execution, teams and the call runtime, geniro's own MCP endpoint, the tasks board, stats and diagnostics. Project-wide commands, conventions and constraints are in the root `AGENTS.md`; the module layout is in `.claude/rules/daemon-module-structure.md`, adapters in `agent-adapters.md`, the codex adapter in `codex-adapter.md`, MCP tools in `mcp-tools.md`, share links in `shares.md`, queries in `database-queries.md`. This file holds only what those do not: the daemon's non-obvious invariants, by area.

Each area's invariants are a rule in `.claude/rules/` (table below), loaded when a file under its `paths:` is touched; on Codex (skill `rule-<name>`), and on Cursor when it is not in context, open it before editing that area. This file keeps what holds for every daemon change.

**Contents**: [Boot, process and storage](#boot-process-and-storage) · [Migrations](#migrations) · [v1/mcp](#v1mcp) · [Shares](#shares) · [Storage](#storage) · [Diagnostics and notifications](#diagnostics-and-notifications) · [Handoff and sign-in](#handoff-and-sign-in) · [Importing CLI conversations](#importing-cli-conversations) · [Daemon endpoints (loopback)](#daemon-endpoints-loopback) · [Area rules](#area-rules)

---

### Area rules

<!-- prettier-ignore -->
| Area | Rule |
| --- | --- |
| Run processes | `daemon-run-processes.md` |
| Runs and runtime columns | `daemon-run-state.md` |
| Agents: adapters | `daemon-agents-adapters.md` |
| Agents: turns and off-turn work | `daemon-agent-turns.md` |
| Host tools | `daemon-host-tools.md` |
| Thread analysis | `daemon-thread-analysis.md` |
| Lessons | `daemon-lessons.md` |
| Question cards | `daemon-question-cards.md` |
| Pull requests and task lists | `daemon-pull-requests.md` |
| Teams and passes | `daemon-teams-passes.md` |
| Team call runtime | `daemon-team-calls.md` |
| Projects and tasks | `daemon-projects-tasks.md` |
| Shared memory | `daemon-memory.md` |
| Knowledge store | `daemon-knowledge.md` |
| Stats | `daemon-stats.md` |
| Agent instructions | `daemon-agent-instructions.md` |
| ACP and cursor transport | `daemon-cursor-acp.md` |
| Auto-compaction | `daemon-auto-compaction.md` |
| Agent caches and MCP configuration | `daemon-mcp-config.md` |
| Plan limits | `daemon-plan-limits.md` |

**Hub files.** These serve many areas, so no rule's `paths:` names them all. Before changing one, also open the rules that name its class:

<!-- prettier-ignore -->
| File | Rules |
| --- | --- |
| `v1/agents/services/chat.service.ts` | `daemon-run-state.md`, `daemon-host-tools.md`, `daemon-thread-analysis.md`, `daemon-lessons.md`, `daemon-question-cards.md`, `daemon-projects-tasks.md`, `daemon-agent-instructions.md` |
| `v1/agents/dao/run.dao.ts` | `daemon-thread-analysis.md`, `daemon-lessons.md`, `daemon-pull-requests.md`, `daemon-teams-passes.md`, `daemon-projects-tasks.md`, `daemon-memory.md` |
| `v1/agents/dao/item.dao.ts` | `daemon-run-processes.md`, `daemon-thread-analysis.md`, `daemon-pull-requests.md` |
| `v1/agents/adapters/agent-adapter.ts` | `daemon-thread-analysis.md`, `daemon-pull-requests.md`, `daemon-projects-tasks.md`, `daemon-memory.md`, `daemon-auto-compaction.md` |
| `v1/teams/services/team-executor.service.ts` | `daemon-host-tools.md`, `daemon-lessons.md`, `daemon-question-cards.md` |
| `v1/teams/services/call-broker.service.ts` | `daemon-host-tools.md`, `daemon-question-cards.md` |
| `v1/teams/services/run-team.service.ts` | `daemon-host-tools.md` |
| `v1/teams/services/team-chat.service.ts` | `daemon-thread-analysis.md`, `daemon-memory.md`, `daemon-knowledge.md` |
| `v1/projects/services/project-scope.service.ts` | `daemon-thread-analysis.md`, `daemon-memory.md`, `daemon-knowledge.md`, `daemon-agent-instructions.md` |
| `v1/projects/services/projects.service.ts` | `daemon-host-tools.md`, `daemon-thread-analysis.md`, `daemon-lessons.md`, `daemon-knowledge.md` |

### Boot, process and storage

- `auth/` holds the launch token, the per-node call tokens (`mint-token.ts` is their one source), `LoopbackTokenGuard` and `enforceWsHandshakeAuth` (the one Socket.IO handshake gate for every gateway).
- A call token is minted once per RUN, only through `CallTokenRegistry.ensure`. A kept CLI process presents the token it spawned with, so a re-mint locks it out of its own endpoint (silent 403s).
- `environments/`: prod is the base, dev spreads prod, test spreads dev; each is one `as const satisfies …` literal. `GENIRO_USER_DATA`, `GENIRO_PORT`, `GENIRO_IDLE_EXIT_MS` and `GENIRO_SPEND_POLL_FLOOR_MS` bypass `getEnv` (it boolean-coerces). `host` is a constant, never an env knob (127.0.0.1-only is a hard rule).
- `utils/process-identity.ts` is the one answer to "is pid N still the process I recorded" (ps start time). Never act on a bare `kill(pid, 0)`; a recycled pid is a stranger.
- One daemon per userData dir (`instance-lock.ts`). Takeover of a stale lock is rename-then-recheck, never delete-then-claim. Release on Nest's shutdown hook (not `process.on('exit')`), and only after `ProcessRegistry.drain` and `AgentSessionRegistry.closeAll`.
- `GET /v1/agents/activity` (`AgentActivityService`, desktop only) answers whether an agent works; Electron main keeps the Mac awake on it (`apps/ui/src/main/AGENTS.md` → *Keep awake*). Deliberately narrower than the idle exit's rule, which counts whatever it must not kill: a run's turn counts unless every turn it has in flight (`AgentSessionRegistry.turnsInFlight`) is blocked — for a team run, the conversations `CallBroker.blockedConversations` counts (waiting on their own calls, or on a card; reported through `TeamLiveWorkSources` → `AgentActivityService.useBlockedConversations`, since `v1/agents` may not import `v1/teams`), else the members with a pending, non-standing card (`ApprovalRegistry.listByRun`) — so one member's card leaves the others working, a caller waiting on a carded callee waits too, and a standing card does not stop the turn the next message opened; a `monitor:` or `action:` entry counts, the daemon's other `ProcessRegistry` errands (probes, listings, sign-ins) do not; and a detached command counts only within `DETACHED_WORK_MS` of its run's last use (`AgentSessionRegistry.worksBetweenTurns`, over `runUsedAt` and the live entries).
- Idle self-exit (`idle-shutdown.lifecycle.ts`) needs no WS client AND no in-flight turn, counting off-turn work (`workingOffTurn`). It SIGTERMs itself so hooks run, and is off unless `GENIRO_IDLE_EXIT_MS` is set (only `DaemonSupervisor` sets it).
- `utils/sleep-watch.ts`: node's timers count through a macOS sleep, so a deadline that ran out with the lid shut fires at the wake. A silence, idle or waiting deadline uses `awakeTimeout`, which restarts it in full from the wake (`retime` changes a pending one's length, keeping its start). `RunProcessSweep` reads the watch too: a run's idle class counts from the last wake as well as its newest row. A deadline that names an instant (a usage-limit reset, a retry) stays on `setTimeout`, as do two windows that may harmlessly fire at the wake: the badge lease (`DELEGATE_ROW_LEASE_MS`, `chat.service`) only decides a word on the run and never abandons work, and `await_agent`'s bound (`untilDeadline`) only returns `pending` early, as the CLI's own tool-call deadline also counts through a sleep. The watch is a module-level singleton (`sleepWatch`); specs rely on its reset in `src/__tests__/setup.ts`.
- `crash-guards.ts` installs before Nest. An uncaught exception writes `<userData>/daemon-crashed` (twin of the UI's `daemon-pidfile.ts`), then SIGTERMs itself. Keep it latched (`shuttingDown`) and keep every handler body non-throwing; Nest runs hooks inside its SIGTERM listener, so a throwing hook re-enters.
- `db/nul-safe-sqlite.driver.ts`: MikroORM 7 inlines values into SQL and SQLite ends a literal at NUL, so the driver renders NUL as `char(0)`. Do not swap back to the stock driver. WAL is on; copying `geniro.db` needs `geniro.db-wal` too.
- better-sqlite3 is synchronous: every statement holds the event loop for its whole length, and awaits resume on microtasks, so a chain of statements holds it too. A request path never reads a whole run's payloads: it reads a kind through its index (ordered on that index's own columns, `KIND_ROWS_ORDER` in `ItemDao`, then by seq in memory: ordered by `seq` alone, SQLite with no `ANALYZE` statistics walks `(run_id, seq)` and visits every row of the run), a promoted column, or `RunKindRowsCache`; a walk over every row (the waterfall's spine, `ItemDao.timelineSpine`) reads a payload-free projection in seq windows with a yield between them. Until the boot sweep stamps an older run, its lookups fall back to the payload (Runs and runtime columns). Every statement, the ORM's and `getKysely()`'s alike, is timed at the Kysely driver (`db/slow-statement-log.ts`, `TimedSqliteConnection`): one at or past `SLOW_STATEMENT_MS` is logged by its shape only (`valueFreeSql`, never a value). `EventLoopWatchdogService` (diagnostics) logs any block of `EVENT_LOOP_BLOCK_WARN_MS` or more. The ORM's own `slowQueryThreshold` never sees a Kysely query; do not move the timing back there.
- **Seeding** (the command is in the root `AGENTS.md` → *Commands*):
  - Fills a database with chats in hard-to-reach UI states. Seeders live in `apps/daemon/src/db/seeders/`.
  - Seeds are idempotent and scoped: every fixture id starts `seed-fixture-`, and a run deletes exactly those before writing. Never `deleteAll`. Keep the `em.clear()` after that delete.
  - Never touch runtime-owned tables (`usage_events`, `node_state`) from a seed.
  - It refuses a real profile (`~/Library/Application Support/Geniro`, `~/.geniro`); `GENIRO_SEED_FORCE=1` overrides.
  - Dev-only: `db/seed.ts` and `db/seeders/` are excluded from the build, and `SeedManager` is registered in the seed entry point, never in `mikro-orm.config.ts` (`@mikro-orm/seeder` is a devDependency stripped from the packaged daemon).
- An adapter spawns only through `start()` / `runCommand()`.
- The boot's close of stranded work (`StrandedWorkReconcileService`: background delegates, detached commands, command actions, monitors, in that order, before listen) reads only the runs whose newest item seq differs from `Run.reconciledThroughSeq` (null for a run it never read), then records each run it left with nothing open through its newest seq. A run any of them failed on, or a chat whose interrupted monitor waits on its delivery after listen, keeps its old mark and is read again next launch.

### Migrations

`v1/migrations` — one journaled runner for what the additive schema sync cannot express.

- `main.ts` calls `MigrationRunnerService.run()` after the stranded-child reaper and BEFORE `orm.schema.update`, explicitly, never from a lifecycle hook (those fire inside `listen()`, after the sync). The boot spec pins it: on a fresh profile `app_migrations` is the first table created.
- The registry (`utils/migration-registry.ts`) is append-only; an id (`NNNN-kebab-name`) is never reused or renamed once shipped. Pending = registry − `app_migrations` (id, applied_at, duration_ms, app_version). The runner creates that table itself through the Kysely schema builder; it is no entity and sits in `schemaGenerator.skipTables` (`APP_MIGRATIONS_TABLES`).
- A `database` step gets the launch's ONE transaction (`em.transactional`, `getKysely()` on the transaction's `EntityManager`): every database step of a launch and its journal row commit or roll back together. Steps are metadata-only DDL through the builder (`renameTo`, `renameColumn`, `addColumn`), and each one does nothing when its source is missing: on a new profile every step runs against a database the sync has not built yet (`main.boot.spec.ts` boots one). Never copy or rewrite the whole database — the live profile is gigabytes and the desktop app gives a start `START_TIMEOUT_MS` between heartbeats. A `files` step (YAML, small JSON under `<userData>`) runs after the commit, is journaled as it finishes, must be idempotent, and copies every file it rewrites first (`backup(path)` → `<userData>/backups/<id>-<ISO>/`). Database steps run first, then file steps, each in registry order.
- A table or column rename leaves every index on it under its old name (SQLite has no index rename), while the sync expects the name MikroORM derives from the table and columns and would drop and rebuild it outside the launch's transaction. The step drops and recreates those indexes under the derived names itself (`0002-workflow-to-team-names`), or — for an index on a table too large to rebuild inside the start deadline — the entity keeps the old name explicitly (`Item`'s index after `0004-team-member-columns` renamed `node_id` to `member_id`); `main.team-rename.boot.spec.ts` and `main.team-model.boot.spec.ts` boot a pre-rename profile and pin that the sync then has nothing to do.
- Before each step the daemon prints `GENIRO_DAEMON_MIGRATING {"id","step","of"}` (twin: `DAEMON_MIGRATING_PREFIX` in the UI's `daemon-pidfile.ts`); the supervisor extends its start deadline on each line and the startup screen says "Updating your data…".
- A failed database step rolls back the launch's transaction; a failed file step stops the run with the database steps and earlier file steps standing. Either writes `<userData>/migration-error.json` (id, step, of, kind, message, backupDir, appVersion, at) and exits `MIGRATION_FAILED_EXIT_CODE` (78); the supervisor surfaces the report and does not respawn. The next clean launch removes the file. Both names are filed `appState` in Settings → Storage.
- `pnpm --filter @geniro/daemon migrate:down <id>` (`db/migrate-down.ts`, dev only, never built) runs one applied migration's `down` against `GENIRO_USER_DATA` and drops its journal row. It holds the daemon's instance lock for its whole length, so it refuses a profile a daemon runs on.
- Existing one-shot boot sweeps keep their versioned marker files (`wall-work-measured` and kin); a new one-shot step goes in the registry. The exception is a pass over every run's rows that cannot fit the start deadline, which runs off the ready path behind a versioned marker instead (`memory-usage-backfill`, `.claude/rules/daemon-memory.md`).

### v1/mcp

- `McpController` serves `/v1/mcp/<runId>/<nodeId>[/<conversationId>]`; tools are composed per request from what that node can use.
- The module sits above `v1/agents` and `v1/teams`; nothing imports it back. Permission predicates stay in `v1/agents/utils/host-*.ts`.
- History tools (`search_chats`, `read_chat_context`): never auto-approved, no `readOnlyHint` (`mcp-tools.md`). Results lead with the data-not-instructions line and pass `redactSecrets`.
  - One recorded exception, `read_analyzed_thread`: see `mcp-tools.md`.
- claude is never offered `ask_user_question` (it has its own).

### Shares

`v1/shares` — encrypted share links (`ShareService`, `/v1/shares/*`, all behind `DesktopOnlyGuard`): `.claude/rules/shares.md`.

### Storage

`v1/storage` (Settings → Storage, `DesktopOnlyGuard`): `GET /v1/storage` measures every top-level name under the data folder it can file (`utils/storage-layout.ts`, plus each adapter's `AdapterConfig.userData`) and hands the rest back as `unclaimed` for Electron main; `POST /v1/storage/clean` starts ONE background clean-up (`STORAGE_BUSY` while one runs), whose progress `GET /v1/storage/job` reads without measuring anything.

- Archived chats are deleted only through `ChatService.sweepArchivedBefore` (the retention `sweepArchived` measures its cutoff from now, with the same `archivedCutoff`) — the one teardown path, transcripts and files included. The cutoff comes from the client, who got it from `GET /v1/storage`'s `chats.archivedPeriods`: each period is chats archived at or before its `archivedBefore`, N days back from the reading's instant, and "all" is the instant itself, so a chat archived after the page read is never taken; a clean with none is refused `STORAGE_CUTOFF_REQUIRED`. Each run is re-read against the cutoff right before its purge. The space returns to the disk only with `compactDatabase`, a `VACUUM` on a connection of its own in a worker thread (`utils/vacuum-database.ts`, the recorded raw-SQL exception). It holds the write lock for its whole length, and every write of a running daemon (turns, monitors, cards, sweeps) gives up after better-sqlite3's 5 s busy timeout, so a running daemon never compacts: the route only writes the `compact-on-start` marker (refused `STORAGE_AGENTS_WORKING` while any turn runs or a kept CLI works between turns, since the page then restarts the daemon), and the next start runs it in `main.ts` before listen (`compactIfScheduled`, marker removed first so a crash is not retried). Both ends refuse a disk with less than twice the database's size free (`STORAGE_NO_ROOM`), and nothing else starts while one is scheduled. Electron main waits up to 30 min for a start while the marker is there (twin `DAEMON_COMPACTION_MARK_NAME`).
- Orphaned folders are `attachments`/`artifacts` named after no run and `task-attachments` named after no card — soft-deleted rows count as existing — and older than `ORPHAN_MIN_AGE_MS`. Logs keep the sink's open file. Leftovers are names nothing in this build writes or reads (a CLI's own through `AdapterConfig.userData.leftovers`). Copies of `settings.json` (`.corrupt-*`, `.bak-*`) are their own group and clean-up, never leftovers: a `.corrupt-*` copy is the only copy of what an unreadable settings file held.
- Every path it deletes is the data folder joined with a name it listed itself; no route takes a path.

### Diagnostics and notifications

- `debug-sink` is a module-scope singleton (predates Nest).
- `payload-preview` masks over a bounded window and masks the whole payload when two windows disagree. Never show a cut secret prefix.
- Debug lines go to the `debug` room, never a broadcast.

### Handoff and sign-in

- `v1/handoff` resolves and never runs. Do not reintroduce a PTY mirror (`TerminalSessionsService` etc.).
- `configDir` travels as env (`HandoffTarget.env`); `shell-line.ts` / `open-terminal.ts` are twins.
- codex uses `fork` while geniro's process may hold the thread (`mayHold`).
- `v1/auth` sign-in runs under `/usr/bin/script`; the reap re-confirms each child and kills that child's own group too.

### Importing CLI conversations

- Every adapter applies the session query itself (`AgentSessionsInput.query`) or declares `contentSearchUnavailableReason`. Search only said text, window the snippet on the term, and state bounds in `partialReason`.
- claude sessions are read off disk through `mapClaudeMessage`. Compare folders canonicalized.
- cursor sessions are listed under a throwaway profile and imported as a COPY. History is read at creation.
- Prepare the import before the run row exists; the happy path writes no system row.
- An imported chat settles `completed`, announced as `restored` with `noTerminalItem`, so it earns no unread mark. A claude history drops an `<ide_*>` text block whole unless it is the last block of the content array (what the user typed; string content is never filtered), and reads each detached launch from `toolUseResult` (`CLAUDE_DETACHED_LAUNCH_KEYS`) as a `shell_open` that does not count against the history cap. `CliSessionsService.importHistory` closes every command still open (`closeImportedShells`) without reading the process table: it was started outside Geniro.

### Daemon endpoints (loopback)

The OpenAPI document at `/swagger-api` (source of `pnpm generate:api`) is authoritative for every route and shape; read the controllers for behaviour.

Bind, shutdown and config:

- Binds `127.0.0.1` only, via the http-server extension's `host` / `portFallback` / `onListening` options. Preferred port `47615` (`DAEMON_PREFERRED_PORT`), falling back to a free port.
- Shutdown is Nest-owned (`enableShutdownHooks`); `utils/pidfile.lifecycle.ts` clears the pidfile. Do not add signal handling to `main.ts`.
- Config env, set by the UI: `GENIRO_USER_DATA` (fallback `~/.geniro`), `GENIRO_PORT`, `GENIRO_IDLE_EXIT_MS` (absent = never exit). The userData dir holds `geniro.db`, `daemon.json`, `daemon.lock`, `children.json` (the agent CLI groups this launch spawned and the command groups their sessions recorded, stopped at the next boot after a daemon death: `.claude/rules/daemon-run-processes.md`).
- `GENIRO_SPEND_POLL_FLOOR_MS` is never set by the UI: start a dev or acceptance stand with it (e.g. `15000`; the supervisor's `...process.env` passes it on) so a thread read prices a cursor turn without the ten-minute floor of `PolledSpendService`. It replaces only the ambient floor, never under 5 s; absent or malformed keeps the ten minutes.

Auth by prefix (`auth/token.guard.ts`): every route needs `Bearer <launch token>` except the public prefixes `/health` and `/v1/artifacts` (`PUBLIC_PREFIXES`, matched at segment boundaries).

- Public: `/health`; `/v1/artifacts` is gated by a per-artifact 256-bit key in the URL (the `key` query), because an `<iframe src>` cannot send a header: one uniform 404 for every failure, `Referrer-Policy: no-referrer`, `?raw=1` matched as the literal `1`, `@ApiExcludeController`. Its `:runId/:artifactId/media/:file` sub-route streams a page's copied audio and video under the same key and the same 404, one byte range at a time (`utils/byte-range.ts`). `ArtifactStoreService.read` requires the key and compares it in constant time. Never put the launch token in a URL.
- Launch token (`LoopbackTokenGuard`): every other `/v1/*`, `/metrics`; `/swagger-api*` stays token-gated through `swagger.guard`.
- `/ws`: one Socket.IO gateway; the token rides the handshake `auth` payload. The handshake bypasses Nest guards, so every gateway authenticates in `handleConnection` through the shared `enforceWsHandshakeAuth` (`auth/ws-auth.ts`); never write a second copy. `LoopbackTokenGuard` lets `ws` message contexts through and refuses any other non-HTTP transport.
- `/v1/mcp/<runId>/<nodeId>[/<conversationId>]`: that node's own call token, keyed by `(runId, nodeId)` and revoked at run teardown, or the launch token. No other route accepts a call token.

Rules when adding or changing routes:

- Declare static segments (`forget-custom-instructions`, `sweep-archived`, `reorder-pinned`, `processes`, `reconcile`, `awaiting-merge`, `reorder`, `instruction-sizes`) before `:param` routes. Team slugs `runs`, `import`, `instruction-sizes` and `avatars` are reserved (`RESERVED_TEAM_SLUGS`).
- Take query filters through a Zod DTO, never a bare `@Query` (an absent value lists everything; `fastify-qs` parses operators). List `scope` is an enum, never a boolean.
- `configDir` is snapshotted onto the run (as are `customInstructions` and `replyLanguage`: `.claude/rules/daemon-agent-instructions.md`), travels as env, never argv, and must exist; a CLI without the mechanism refuses it (`CONFIG_DIR_UNSUPPORTED`). Text reaching a spawned CLI refuses control characters by field: custom instructions, label instructions and an instruction block's text refuse C0 control characters other than tab, LF and CR (`CustomInstructionsSchema`, `hasControlCharacters`, `chat.types.ts`), and `replyLanguage` is one bounded line without control, invisible or bidirectional characters (`ReplyLanguageSchema`); the member text that reaches a spawned CLI (`instructions`, `character`, `role`, `id`, `name`, `model`, `effort`, and `configDir` as env) and a stage's text (`title`, `howToWork`, `goal`, `responsible`, which reach every member's instructions) refuse NUL only, because the same schema also reads saved YAML and every run's own team copy (`argvSafe`, `teams.types.ts`); a server name in `mcpDisabled` refuses every control character (`mcpServerNameIsClean`).
- A mid-turn message is told to the CLI first and written only once delivered; else `409 RUN_BUSY`.
- `archivedAt` is its own column, never `deletedAt` (root `AGENTS.md` → *Storage split*). Archive cancels only a `running` turn; an archived run refuses messages (`RUN_ARCHIVED`).
- `PATCH /v1/tasks/:taskId` never accepts `runId` / `worktreePath` / `branch`. Status moves are a database compare-and-set (`TaskDao.compareAndSetStatus`).
- One live project per folder, enforced in the service, not a unique index (soft delete).
- `GET /v1/chats/:runId/image` stays an image channel: extension checked first, regular file, size cap, canonicalized before stat, URLs refused.
- Retry refuses a working run BEFORE closing its session, and requires a session id.
- `shell-output` names a tool call, never a path.
- Run snapshot (`Run.teamSnapshot`): unreadable is `409 TEAM_SNAPSHOT_UNREADABLE`, never re-frozen.
- Never store merged/open state for pull requests; never date them by capture time.
- `/ws` counts (`holdingFor`, `shellsOpen`, `subagentsOut`) are announced on transitions; every path that ends one must announce. `run_status.status` is nullable (activity announces assert none). `runs_changed` rows carry 0 for `rootsWorking` / `awaitingCalls`. `task_changed` is a twin of the UI's `parseTaskChanged`; the renderer collects worktrees only off `reason: 'work-finished'`.

Destructive or irreversible routes (and one that only looks it — `DELETE /v1/tasks/:taskId/files/:attachmentId` drops a reference, never the file):

- `DELETE /v1/chats/:runId` — hard-deletes a chat run through `RunTeardownService` (chat runs only; reached from the archive).
- `DELETE /v1/shares/:shareId` — revokes one shared page: its remote object, Keychain key and row (a failed remote delete keeps both).
- `POST /v1/shares/revoke-all` — deletes the named shared pages' remote objects, Keychain keys and rows (a failed remote delete keeps both).
- `POST /v1/chats/sweep-archived` — deletes chats archived ≥ `olderThanDays` (1 day–10 years) from `archivedAt`; one at a time, failures logged and skipped. The policy is the client's.
- `DELETE /v1/teams/runs/:runId` — one team run's history (never the library team).
- `DELETE /v1/teams/:slug` — removes the library team's YAML file.
- `POST /v1/stats/team-versions/restore` — replaces a library team's graph with a recorded version's (the file is backed up first).
- `DELETE /v1/teams/:slug/chat` — discards the builder chat.
- `DELETE /v1/projects/:projectId` — the project AND its tasks.
- `DELETE /v1/tasks/:taskId` (soft delete), `DELETE /v1/label-instructions/:instructionId` — remove a card or a label instruction.
- `POST /v1/chats/forget-custom-instructions` — drops the snapshot from every run (leaves `taskInstructions`).
- `POST /v1/chats/:runId/archive` — cancels a running turn and closes its session.
- `POST /v1/chats/:runId/retry` — closes the kept session (refused while working).
- `POST /v1/chats/:runId/shells/kill` — signals the agent's command tree.
- `POST /v1/chats/:runId/processes/stop` — stops the selected detached processes and monitors (explicit pids only; one outside the run's detached set refuses the whole request).
- `PUT /v1/agents/mcp`, `PUT /v1/agents/mcp/config`, `POST /v1/agents/mcp/servers`, `POST /v1/agents/mcp/plugin-servers` — write the user's own CLI config (see MCP config writes).
- `DELETE /v1/groups/:groupId` releases its runs and the projects bound to it; it never deletes chats or boards.
