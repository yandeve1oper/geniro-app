---
description: Question cards — standing ask_user_question cards and deferred questions for team members
paths:
  - "apps/daemon/src/v1/agents/**/standing-questions*"
  - "apps/daemon/src/v1/agents/**/host-question*"
  - "apps/daemon/src/v1/agents/**/pending-question*"
  - "apps/daemon/src/v1/agents/**/card-questions*"
  - "apps/daemon/src/v1/agents/**/team-member-questions*"
  - "apps/daemon/src/v1/agents/**/unanswerable*"
  - "apps/daemon/src/v1/agents/**/user-question*"
  - "apps/daemon/src/v1/agents/**/approval-*"
  - "apps/daemon/src/v1/agents/adapters/**/*question*"
  - "apps/daemon/src/v1/mcp/tools/ask-user-question/**"
---

# Question cards

- A standing `ask_user_question` card belongs to the TURN, not the MCP call (`utils/standing-questions.ts`). An abandoned call DETACHES, an identical re-ask ADOPTS, an early answer is HELD for the next ask, and a reworded question is a new card.
- For a CLI whose client will not hold a call open (`AdapterConfig.hostQuestionDeferredReason`, cursor): the tool answers `posted` at once and the answer arrives as the next message. Do not reintroduce polling.
  - The card outlives the turn (`sweepNode` skips `deferred`) and is retired by a new turn (`sweepDeferred` → `unanswerable`).
  - Write the verdict row and clear `Run.pendingQuestion` BEFORE the answer message goes out.
  - One per run, rehydrated at boot (`rehydrateDeferredQuestions`); a different second question is refused. Every row names its `kind` (`question`, `plan`, `patch`, `project`); a row that names none is unreadable and cleared at boot. No compatibility readers.
  - `propose_plan`, `propose_patch` and `save_project_instructions` take the same deferral, column and one-card rule (`PendingCardSnapshot`); a project card's Apply runs `ProjectInstructionsChangeService.write`, and its failures after Apply are `stale` too. Approve or Reject starts a turn whose message is the verdict, a plan's note included. Apply runs `applyHostPatch` from `resolveValidCwd(run.cwd)` when that message is sent, after a restart too. A missing folder, or an `old_string` no longer matching exactly once, comes back `stale` and nothing is written. Whole-file patches capture the contained target's byte SHA-256 or absence before raising the card, carried in the blocking closure or `PendingPatchSnapshot.fingerprint`; Apply checks the opened file before truncation, and an absent target is created exclusively. Changed, created or deleted targets are `stale`. A stored patch without the fingerprint field is unreadable and cleared at boot; null records that no fingerprint could be taken, so whole-file Apply refuses it. Every failure after Apply is `stale`, never `unavailable` (the user did see the card). Their listing says the call returns at once (`register(…, { answersAtOnce })`, read by `PlanBroker` / `PatchBroker` / `ProjectInstructionsBroker.answersAtOnce`).
- cursor's own `cursor/ask_question` is not used for `ask_user_question` (option ids only).
- **Team runs.** Every member turn whose CLI hands its model no question tool (`hostQuestionToolReason`) is offered `ask_user_question`: `beginAgentTurn` registers the sink under `callerKey(member, conversation)` and drops it with the turn (the tool keys its listing and call the same way, so a chat's bare member id is unchanged); claude keeps its own AskUserQuestion, so one question never draws two cards.
  - Own conversation, a CLI that holds the call open: one card in the member's flow, tracked as a question and closed with the turn like the turn's other cards (`openCards`).
  - Own conversation, `hostQuestionDeferredReason`: answered `posted`; `TeamCardsService` keeps the card in `Run.pendingMemberQuestions` (one per member, same words adopt, others `QUESTION_ALREADY_STANDING`), rehydrates it at boot, retires it on a user message (`TeamExecutorService.sendMessage`, not awaited, so the message still beats a scheduled wake) and on archive (`ChatService.retireStandingCard`); its verdict leaves the column first, then wakes that member's own conversation with `deferredAnswerMessage` (`StageWakeService.wakeLead` with the member).
  - Callee conversation: parked on its caller (`CallBroker.parkQuestion`), as a claude callee's is. A deferred one (`deferred: true`) blocks nobody, holds the call once the callee's turn ends (`owesHold`, `answerOwed`) and continues the callee inside it with the caller's answer — or, past the TTL or with no caller turn left, with word that none came, never failing the call.
