---
description: Agent caches and MCP configuration — vocabulary cache invalidation and writes to each CLI's own MCP config
paths:
  - "apps/daemon/src/v1/agents/**/model-vocabulary*"
  - "apps/daemon/src/v1/agents/**/cache-reset*"
  - "apps/daemon/src/v1/agents/**/agent-mcp*"
  - "apps/daemon/src/v1/agents/**/mcp-mismatch*"
  - "apps/daemon/src/v1/agents/adapters/**/*mcp*"
  - "apps/daemon/src/v1/agents/adapters/**/*.adapter.ts"
---

# Agent caches and MCP configuration

- `ModelVocabularyStore` (`model-vocabularies.json`) is invalidated by `--version` in the entry, `forgetAgent` on account sign-in/out (with an epoch so in-flight answers are discarded), stale-after-1h refresh, and a 7-day expiry. Never file an answer that could not be obtained (empty list).
- **MCP config writes** — one of the two exceptions to "geniro writes only its own files" (the other: deleting an archived run's own CLI transcripts, under `run-teardown` in `.claude/rules/daemon-agents-adapters.md`). Always through the CLI's own key, lock or mechanism:
  - claude toggle: `projects[<claudeProjectKey>].disabledMcpServers` in `~/.claude.json`, under `proper-lockfile` at `~/.claude.json.lock`. Atomic, mode-preserving, fsynced (`rewriteHomeConfig`); refuse an unparseable file.
  - cursor toggle: the CLI's own `mcp enable|disable` in the folder.
  - codex toggle: `config/value/write`, only for servers its user `config.toml` defines.
  - Plugin copy (cursor, `~/.cursor/mcp.json`): strict re-read, refuse unparseable or conflicting names, atomic fsynced write. No credential; nothing host-bound may read `${env:…}`.
  - Server definitions (`/v1/agents/mcp/config`, `/servers`): user scope of the listing's profile only. claude touches only top-level `mcpServers`; codex through `config/batchWrite` (HTTP servers) or its own `codex mcp add` (stdio servers), never TOML by hand. Saves carry the read version and are refused if it moved. Add values are registered with `registerSecret` before the CLI runs; nothing in a body is logged. `codex mcp add` is refused when the name exists.
  - claude's `mcp-needs-auth-cache.json` is the one CLI cache geniro edits: delete a server's key once it is seen connected; leave an unreadable record alone.
- An MCP change MARKS the kept sessions it reaches stale (`markStaleWhere`, scope per `mcp.changeReach`); never close them mid-turn.
  - A stale mark has a cause (`mcp` / `account` / `conversation`, merged by `mergeStale`). Only `mcp` waits while the process `holdsWork` (a detached command, a parked card, off-turn work): the turn runs on the old process with an `info` row and a prompt note (once per set of reasons) saying the change applies later and that switched-off servers are still loaded (user decision). An account change, a compaction or a pool hand-off never waits, and outranks an `mcp` mark.
- A server sign-in is `succeeded` only once the server is seen connected (`verifying` until then).
- The toggle's profile is part of the address; the write lands in the file the read came from.
- Clear Agent Cache (`POST /v1/agents/caches/clear`) forgets cached answers only: never the harvest stores or `ContextWindowStore` (measurements nobody can re-take), and it never re-probes a CLI.
- codex MCP config is read from the USER layer of `config/read {includeLayers: true}`, never the effective config (which adds defaults and plugin servers that would then be written into the user's `config.toml`).
