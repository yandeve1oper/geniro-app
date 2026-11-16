---
description: Plan limits — the account-keyed plan-limits ledger and each CLI's reader
paths:
  - "apps/daemon/src/v1/agents/**/plan-limits*"
  - "apps/daemon/src/v1/agents/adapters/**/*plan-limits*"
  - "apps/daemon/src/v1/teams/**/pool-cooldowns*"
  - "apps/daemon/src/v1/agents/**/agent-session*"
---

# Plan limits

- cursor's limits are asked of the account (`account` channel, `utils/cursor-plan-limits.utils.ts`): `GetCurrentPeriodUsage.planUsage` gives Included / Auto / API, `GetPlanInfo` the plan's name; a period with no `planUsage` (a spend-based Enterprise seat) is `NO_PLAN_LIMITS`.
- **Plan limits are the ACCOUNT's**: the ledger (`utils/plan-limits-ledger.ts`) is keyed by CLI plus the account's config directory (the folder pin first, else the run's profile). A real reading beats a newer `estimated` one for 5 min (`REAL_READING_PREFERRED_MS`), except on the readout's refresh press, where the agent's live answer stands. An estimate never reads under what the account already reached in the same window (same key and reset), since usage only rises until a reset; a real reading stands. In memory only.
- A conversation whose own process is gone (evicted by the session ceiling, reaped as idle) on a `live-process` plan channel asks the plan of another live kept process of the same CLI on the same account (`AgentSessionRegistry.liveSessions`, matched by `effectiveAccountKey`); the context breakdown is the conversation's own and is never asked of another process.
- With no live process on the account, only the readout's REFRESH press takes a fresh plan reading from a one-shot process, for a CLI whose `planLimits` reading declares `oneShot` (claude: `get_usage` on `CLAUDE_CONTROL_PROBE_ARGS`; codex: `account/rateLimits/read` on a one-shot app-server), through `runCommand`, under the account's effective config directory and only with the caller's `mayProbe`. Refreshes that overlap on one account share the one in flight. An ordinary open, the turn-end prewarm and the idle farewell never spawn one; an empty answer keeps the held reading and logs the "gave no answer" warning.
