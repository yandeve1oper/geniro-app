---
description: Agent adapters — static CLI facts, the first-prompt MCP gate, kept sessions, run-teardown of CLI transcripts
paths:
  - "apps/daemon/src/v1/agents/adapters/**"
  - "apps/daemon/src/v1/agents/**/agent-adapter*"
  - "apps/daemon/src/v1/agents/**/agent-session*"
  - "apps/daemon/src/v1/agents/**/session-*"
  - "apps/daemon/src/v1/agents/**/run-teardown*"
  - "apps/daemon/src/v1/teams/utils/parallelism*"
---

# Agents: adapters

- Every static CLI fact is one `AdapterConfig`; see `agent-adapters.md`. Lapsed-account markers are evidence-gated (`[]` until observed).
- claude, first-prompt MCP gate (`claude-turn.driver.ts`, `TurnDriver.awaitPromptReady`): the first prompt of a process waits on `mcp_status` until two identical readings show nothing `pending`. Read `mcpServers`, not `servers`. Only `pending` blocks. Exits: 2s empty grace, `refused` releases, 5s silence (`CLAUDE_MCP_READY_SILENCE_MS`, not timed while hooks run), 15s with no change in the readings (`CLAUDE_MCP_READY_STALL_MS`, restarted on every change and while hooks run) under a 60s hard ceiling (`CLAUDE_MCP_READY_MAX_WAIT_MS`), then a notice naming the servers. A cancel during the hold drops the prompt; a throwing gate sends it anyway.
- claude `reload_skills` is sent only by the command-list probe (`commandListProbe`), never on a live chat.
- `withResponse` picks the AskUserQuestion answer field by question count; no caller picks it.
- cursor-acp's `mapMessage` throws by construction; `AcpSession` is its `TurnDriver`.
- codex (`codex app-server`, one process per conversation): `.claude/rules/codex-adapter.md`.
- `services/agent-session.registry`: kept CLI processes, one per run key, separate from `ProcessRegistry` (which tracks turns). It must subscribe to `session.closed` (a dead session is not idle and would hold a slot).
  - Idle window: the user's `Settings.keptSessionIdleMinutes` (bounds, default and push: `apps/ui/AGENTS.md` → *Settings*), arriving through the desktop-only `PUT /v1/agents/sessions/config` and held in memory only; `SESSION_IDLE_MS` (1 h) until the first push. One window for every run: a card's run is kept like any chat, whatever its column, until its work is finished (`closeFinishedRun`). A change re-times every waiting entry to its last use plus the new window on awake time (`AwakeTimer.retime`); one already past it goes through the ordinary idle close (parked, detached commands and off-turn work still re-arm).
  - The idle close and a finished card's close (`closeFinishedRun`) are the graceful ones (`SessionCloseOptions`): stdin first, then SIGTERM to the CLI's own group when it exits, or 2 s on (`TURN_END_EXIT_GRACE_MS`) for a CLI that ignores EOF, then SIGKILL. Eviction, staleness, teardown and shutdown stay immediate. Until it exits the process sits in the `closing` map: `processRoots` (so `held` and the sweep) still report it, `closeFinishedRun` waits for it (never for a session whose `close()` threw) and takes over an idle close under way (its idle reap and note are replaced by the finished card's), and `closeRun` and `closeAll` escalate it. `closeFinishedRun` closes nothing and answers false while any of the run's processes has a turn in flight (`turnsInFlight`), and its close never counts as interrupting work. The close records its `SessionCloseCause` before it returns, because the exit it waits for is what settles the delegates still out.
  - Ceiling: the user's `Settings.keptSessionLimit` (2–64, pushed with the idle window through the same route, `setLimit`), else `sessionCeilingFor`: total memory / 8 / ~1GB, clamped [2, 16]. A lowered limit closes idle entries at once by the eviction order below. `GET /v1/agents/sessions/config` (desktop only) serves the limit, the automatic one, `SESSION_MEMORY_COST_BYTES` and total memory for the Settings estimate. `v1/teams/utils/parallelism.ts` stays on the automatic curve.
  - Eviction never takes a turn in flight, a parked card, an entry with off-turn activity within `OFF_TURN_ACTIVE_MS`, or a chat's or member's own conversation (any key but a `call:` one) used within `RECENTLY_USED_MS` (10 min); with nothing else to close it goes over the ceiling. It closes entries not used within that window first, callee conversations before own ones, then recently used callees, least recently used first in each. `OFF_TURN_ACTIVE_MS` must equal `DELEGATE_ROW_LEASE_MS`.
  - Off-turn events refresh (never arm) the idle timer (`touchOffTurn`).
  - A close that interrupted work writes one row at the close (`noteInterruptedSession`). A close that stopped detached commands (`detachedRunning`: a command a delegate still waits on is not one) — any close but `closeRun`, `closeFinishedRun` and shutdown, a process ending on its own included (`endedRunning`) — also owes the key's next turn a `warning` row and a `<geniro-note>` after the prompt naming them (`runningCommands`, `utils/session-replacement-notes.ts`); the prompt line waits for a turn that carries a prompt (not a probe, resume-only or slash command) and a live process. Other closes write nothing. What the CLI left running is stopped separately (Run processes → Left commands).
- MCP harvest is age-bounded (it shadows the live listing); skill harvest is keyed `(agent, cwd, configDir)` — the profile is the account. MCP listing cache key includes `configDir`, the read runs under that profile's env, with a keyed single-flight (it launches the user's servers).
- `chat-metrics` composes only: it hands the adapter `{live, sessionId, configDir}` and each adapter answers from its own channel (`UsageReadChannel`; `account` needs neither a process nor a session).
- `chat-title`: writes a title only while it is still exactly what this service derived (manual renames are permanent); checks ownership before any spawn. Do not reintroduce asking cursor for a title. claude's title ask is a throwaway `haiku` turn, MCP withheld, temp cwd, once per conversation.
- `run-teardown` is the ONE delete teardown (cancel, wait, revoke tokens, purge rows with `softDelete` off, drop attachments and artifacts, announce `runDeleted`), shared by chat and team delete.
  - It never touches the tables exempt from teardown (root `AGENTS.md` → *Storage split*).
  - Only an ARCHIVED run's own CLI transcripts are deleted with it (`session-transcripts.service.ts`). It keeps a session another run names, or one that began before the run (an import). It never throws.
- `utils/`: nothing is named after a CLI. `CliSession.ask` must stay additive (control replies and events never consume each other's lines).
