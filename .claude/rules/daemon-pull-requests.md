---
description: Pull requests and task lists captured from the transcript, and named paths
paths:
  - "apps/daemon/src/v1/agents/**/pull-request-capture*"
  - "apps/daemon/src/v1/agents/**/named-paths*"
  - "apps/daemon/src/v1/agents/**/run-named-paths*"
  - "apps/daemon/src/v1/agents/**/task-list-*"
  - "apps/daemon/src/v1/tasks/**/task-merge*"
---

# Pull requests and task lists

- A thread's pull requests are read from its own transcript (`pull-request-capture`). Never key them by branch.
  - `Run.pullRequests` holds the ones it OPENED. Only these end a card on merge (`TaskMergeService`), count in Stats (`announceOpened`, the backfill) and stand as a card's result.
  - `Run.touchedPullRequests` holds the ones a conversation's CLI record names (`AgentAdapter.readSessionPullRequests`: claude's `pr-link` lines — created, pushed to, checked out, commented on, merged). Shown on the chat surfaces only: `readDisplayedPullRequests` merges both for the run wire and the run-status announce, marking each `opened`. A task card and `get_task` show the opened ones (`RunDao.pullRequestsOf`; the board reads them with each card's stage line in one read, `RunDao.boardFactsOf`).
  - A CLI record is kept only when the run opened that pull request or its own rows name it (`textNamesPullRequest` over `ItemDao.pullRequestNamingCandidates`: its URL or API path, or a `gh pr <verb>` naming its number). claude answers every push with `gh pr view` in its own folder, so in a shared checkout its record names whatever pull request that folder's branch has. An unnamed record is re-checked only over rows written since (`unnamed`, in memory); a from-start pass re-checks the carried ones too, and a list that shrinks is announced (empty included).
  - Transcript signal: a `…/pull/\d+` URL that ENDS a line (alone, or after whitespace or `=`; never a bare `:`, which is `grep -n`) in a `tool_result` whose paired call ran `gh pr create` in command position (prefix words walked back). A URL mid-line is a quotation.
  - A record has no row of ours: it takes the seq of the tool result its time falls on (`ItemDao.toolResultSeqAt`), so ordering stays seq-based.
  - Incremental: the marker advances even when nothing was captured. Errors are swallowed per run. No repeating re-scan sweep; a rule change bumps `PULL_REQUEST_SCAN_VERSION`, and a run scanned under another version is re-read from the start once, by the boot sweep (`rescanOutdatedQuietly`) or its own turn end, never by a listing (a listing's re-read announced every run it re-read, and the renderer re-listed for each).
  - One pass per run at a time (`syncSerialized`), each over the row as this service last wrote it, so overlapping listings and a turn end never announce one change twice. A listing never waits on a pass in flight.
  - The marker stops at `ItemSeqAllocator.writtenThrough` (a reserved seq is not on disk yet); a pass reads candidates in seq windows with a yield between them and looks up their calls in one `rowsByPayloadId`, never a per-result `LIKE` over the history.
  - Store identity only (owner, repo, number, url), never title or state.
  - Every list the run wire or a run-status announce carries attaches each pull request's newest recorded outcome (`Run.runOutcomes`, read fresh by the capture pass), since the renderer replaces the whole list from each announce.
- Worktrees a thread worked in (`RunNamedPathsService`, `POST /v1/chats/:runId/named-paths`): of the candidate folders the desktop app lists, the ones a `tool_call` of the run names — the path or its run-folder-relative form (two segments or more), followed by a path boundary; a relative form must also begin one (a shell word boundary, a quote, an escaped newline or tab, or `./`), so it is never found inside another repository's path. Never the run's folder or one holding it. Each run's reading is remembered in memory (scanned seq, clamped to `writtenThrough`, + verdicts), so a later ask reads only newer rows — a folder asked about for the first time reads the whole history once, in seq windows that yield the event loop. Asks for one run are serialized.
- `task_list` rows: `mode` says snapshot vs patch and is never inferred; absent means patch. The run fold is keyed by member AND `callId` and skips delegate rows (`parentToolUseId`).
