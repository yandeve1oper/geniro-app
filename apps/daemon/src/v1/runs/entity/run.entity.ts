import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type {
  ChatApprovalMode,
  PromptCacheTtlReason,
  RunGroupColor,
} from '../../agents/chat.types';
import { PAYLOAD_REFS_VERSION } from '../../agents/utils/payload-refs';
import type {
  AgentKind,
  AnalysisPurpose,
  ProjectSource,
  RunStatus,
} from '../runs.types';

/** One execution of a team or a single-agent chat. */
@Entity({ tableName: 'runs' })
@Index({ properties: ['projectId'] })
export class Run extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  /** Team id this run executed; null for an ad-hoc single agent. */
  @Property({ type: 'string', nullable: true })
  teamId: string | null = null;

  @Property({ type: 'string' })
  status: RunStatus = 'pending';

  @Property({ type: 'string', nullable: true })
  title: string | null = null;

  /**
   * Working directory of the run — the user's chosen project folder, which
   * the adapter spawns the CLI in; a team run is refused without one
   * (`RUN_NOT_CONFIGURED`). The daemon validates this path before spawning so
   * the headless agent is scoped to the user's project and never the daemon's
   * own cwd (the app repo).
   */
  @Property({ type: 'string', nullable: true })
  cwd: string | null = null;

  /**
   * The commit {@link cwd} had checked out when this chat was created — the
   * fixed point "what has changed since this conversation started" is measured
   * against.
   *
   * Null for a team run (whose `cwd` is null for the reason above), for a
   * folder that is not a repository, for a checkout with no commits yet, and
   * for every row predating the stamp. Read by the ELECTRON process at
   * creation and sent, like `configDir` and `customInstructions`: the daemon
   * runs no git of its own.
   *
   * A moment rather than a range, and that is what makes it durable — a branch
   * moves, a checkout is switched, the folder is reused by another chat, and
   * this still names the commit this conversation began at. TEXT so the
   * `safe: true` schema sync adds it additively, no migration.
   */
  @Property({ type: 'string', nullable: true })
  startSha: string | null = null;

  /**
   * Whether {@link cwd} already had uncommitted changes at that same moment.
   *
   * Beside the commit because the diff needs both to be honest: measured from
   * `startSha` alone, work the user had in flight before the chat opened is
   * presented as the agent's. Null means never measured — a team run, a
   * non-repository, a row predating the stamp — and is NOT read as clean, since
   * a false there would make exactly the claim that cannot be checked.
   */
  @Property({ type: 'boolean', nullable: true })
  startDirty: boolean | null = null;

  /** Which CLI agent drives a single-agent chat run; null for team runs. */
  @Property({ type: 'string', nullable: true })
  agentKind: AgentKind | null = null;

  /** Model alias for a single-agent run; null = adapter default. */
  @Property({ type: 'string', nullable: true })
  model: string | null = null;

  /**
   * Chat approval mode for a single-agent run; null for team runs (their
   * modes live in the team YAML).
   */
  @Property({ type: 'string', nullable: true })
  approval: ChatApprovalMode | null = null;

  /**
   * Reasoning effort for a single-agent run's next turn, spelled as its CLI
   * spells it; null = the CLI's own default (no `--effort` flag), which is
   * also every row that predates the chip and every CLI without the control.
   * A plain string, not an enum: the vocabulary is the adapter's, and the
   * value is validated by `EffortsService.accepts` before it lands — against
   * `AgentAdapter.listEfforts()` only for a CLI whose list is the whole
   * vocabulary, since one whose levels belong to the MODEL has a union there.
   * TEXT so the `safe: true` schema sync adds it additively, no migration.
   */
  @Property({ type: 'string', nullable: true })
  effort: string | null = null;

  /**
   * Which of the model's context-window sizes this run's next turn asks for,
   * spelled as its CLI spells it (`300k`, `1m`); null = the model's own
   * default, which is also every row predating the chip and every CLI with no
   * such control.
   *
   * A plain string for the reason `effort` is one, and NOT validated up front
   * for the reason it partly is: the sizes belong to the MODEL, so there is no
   * CLI-wide list to check against — a value the chosen model does not offer is
   * reported by the turn's own driver, against the live agent.
   *
   * TEXT so the `safe: true` schema sync adds it additively, no migration.
   */
  @Property({ type: 'string', nullable: true })
  contextWindow: string | null = null;

  /**
   * Compact the conversation once a settled turn leaves its context at or above
   * this percentage of the window; null = never, leaving the CLI's own
   * behaviour alone.
   *
   * The DAEMON performs it, between turns, with the adapter's own `/compact`
   * rather than handing the CLI a threshold: claude's
   * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is read by the binary but measured to
   * compact nothing in headless mode (2.1.270 — a haiku session at 155k tokens
   * with the override at 20% never compacted), and cursor has no such knob.
   */
  @Property({ type: 'integer', nullable: true })
  autoCompactPercent: number | null = null;

  /**
   * Every OTHER model setting this run's next turn asks for, as a JSON object
   * of `{parameterId: value}` — `{"optimize_for":"intelligence"}`.
   *
   * ONE column rather than one per axis, and that is the point of it: the ids
   * belong to the CLI, not to this app (measured on cursor — `optimize_for`,
   * `thinking`, `fast`, and whichever it adds next), so a column per axis would
   * mean a schema change every time another product ships a setting. `effort`
   * and `contextWindow` keep theirs because those two have a control, a
   * vocabulary endpoint and a meaning geniro states in its own words.
   *
   * TEXT holding JSON rather than a `json` column, for the reason the two above
   * are TEXT: the `safe: true` schema sync adds it additively, no migration.
   * Read and written only through `utils/model-parameters.ts`.
   */
  @Property({ type: 'text', nullable: true })
  modelParameters: string | null = null;

  /**
   * How full this conversation's context window was the LAST time the CLI said
   * — the durable half of the composer's ring, and the only half a window that
   * has just loaded has.
   *
   * Runtime state, not a setting: written from every `context_progress` the CLI
   * reports, which is once per main-thread model response, so it tracks a
   * running turn rather than a finished one. That is the whole reason it exists.
   * The transcript already carries a figure per SETTLED turn, and on the work
   * this app is for a turn runs for an hour and grows the window by half a
   * million tokens — so a client with no live reading (a reload, a reconnect, a
   * chat opened for the first time this session) drew the ring from a figure
   * that could be a whole turn old. Worst directly after a `/compact`, which is
   * where it was REPORTED: the last settled turn said 16.7k of 1M and the panel
   * beside the ring, which asks the live agent, said 462.3k.
   *
   * INTEGER so the `safe: true` schema sync adds it additively, no migration.
   */
  @Property({ type: 'integer', nullable: true })
  contextTokens: number | null = null;

  /**
   * Whether {@link contextTokens} is geniro's stand-in rather than an
   * occupancy the CLI stated (`AgentUsage.contextEstimated`). Written with
   * every count and cleared with it; null reads as stated.
   */
  @Property({ type: 'boolean', nullable: true })
  contextEstimated: boolean | null = null;

  /**
   * The last reading taken from this run's own agent process before it was
   * closed — the context breakdown and the plan limits, as JSON, with the
   * moment and the transcript position they were taken at.
   *
   * Both figures are answerable only by a RUNNING agent (claude asks its live
   * stdin dialogue), so a chat whose process has been reaped for idleness had
   * nothing to show at all — which is the reported "wrong popup withoput data".
   * The reading is taken on the way out (`AgentSessionRegistry.onIdleFarewell`)
   * and served while no process exists, labelled with when it was taken.
   *
   * TEXT and opaque here: the shape belongs to `ChatMetricsService`, which
   * parses it through the same schemas the wire uses and discards a reading it
   * can no longer read. `atSeq` is what keeps it honest — a transcript that has
   * moved since makes the figures describe a conversation that no longer
   * exists, and they are dropped rather than shown with a timestamp nobody
   * reads.
   */
  @Property({ type: 'text', nullable: true })
  lastMetricsReading: string | null = null;

  /**
   * The window {@link contextTokens} is measured against, as the CLI reported
   * it — null until one has been reported.
   *
   * Never overwritten with null, on the rule the renderer's own fold follows: a
   * turn that reports no window has said nothing about the model's, and wiping
   * a real denominator leaves a numerator with nothing to divide by.
   */
  @Property({ type: 'integer', nullable: true })
  contextWindowTokens: number | null = null;

  /**
   * How long this chat's agent has WORKED and how many tool calls it has made,
   * totalled across every turn — the chat twin of `NodeState.workedMs` /
   * `toolCalls`, on the RUN for the reason {@link contextTokens} is on it.
   *
   * The pair above is a LEVEL, so `rememberContext` replaces it and a missed
   * write costs nothing. These are TOTALS, so `RunDao.rememberWork` SUMS and a
   * missed write is a figure permanently short.
   *
   * They exist because the alternative — folding the transcript the client
   * happens to hold — can only ever describe the loaded window: `HISTORY_PAGE`
   * is 1,000 items, so on a long chat that fold is a fraction of the answer
   * presented as the whole of it, with nothing on screen marking the difference.
   *
   * Null means never measured, never zero, and the two are independently
   * nullable: every ACP agent reports no timing while still using tools.
   *
   * WHAT IS COUNTED, precisely, because "totalled across every turn" is the
   * kind of claim that quietly stops being true. Every turn geniro STARTED,
   * however it ended — a `turn_complete` contributes both figures, while a Stop
   * or a failure contributes the tools it had already called and no duration,
   * neither terminal carrying a `usage`. What is NOT counted is what the CLI
   * does OFF-TURN: a claude process routinely opens a continuation turn of its
   * own when a delegate reports back, and `handleBetweenTurnEvent` has no
   * terminal arm, so that work reaches the transcript and not these columns.
   * The renderer's fold still covers it inside the loaded window; past
   * `HISTORY_PAGE` items it is simply missing, and a delegate-heavy chat is
   * where that is largest. Closing it needs a per-RUN counter rather than the
   * per-turn one in `sendMessage`'s closure — deliberately not built here.
   */
  @Property({ type: 'integer', nullable: true })
  workedMs: number | null = null;

  @Property({ type: 'integer', nullable: true })
  toolCalls: number | null = null;

  /**
   * How long the provider keeps this chat's prompt cache after a request, as
   * the CLI last reported it (`AgentUsage.promptCacheTtlMs`) — null until a
   * turn has reported one, which on a CLI that states no cache is forever.
   *
   * Kept beside {@link promptCacheExpiresAt} rather than folded into it,
   * because a turn that is STOPPED or FAILS reports no usage while its requests
   * still refreshed the cache: the expiry is moved on by the lifetime the
   * conversation last stated.
   */
  @Property({ type: 'integer', nullable: true })
  promptCacheTtlMs: number | null = null;

  /**
   * Why {@link promptCacheTtlMs} is what it is, when the CLI said so
   * (`AgentUsage.promptCacheTtlReason`) — written with the lifetime and kept
   * with it, so a turn that reports no lifetime keeps both. Null when the CLI
   * gave no reason, the ordinary case.
   */
  @Property({ type: 'text', nullable: true })
  promptCacheTtlReason: PromptCacheTtlReason | null = null;

  /**
   * When this chat's prompt cache lapses: the end of its newest turn plus
   * {@link promptCacheTtlMs}. Past it, the next message re-writes the whole
   * conversation to the cache at full price instead of reading it — which is
   * what the composer warns about. Null while no lifetime is known.
   *
   * Measured from when the turn ENDED rather than when its last request
   * began, so it can run late by the length of that request — seconds against
   * a lifetime of minutes or an hour.
   */
  @Property({ type: DateTimeType, nullable: true })
  promptCacheExpiresAt: Date | null = null;

  /**
   * Plugin directory a single-agent run's turns load, CANONICAL (the path
   * `resolveValidConfigDir` returned when the chat was created); null = none,
   * which is every row predating the chip and every CLI with no plugin
   * mechanism. A team run's plugin directories live per member in the team
   * YAML instead.
   *
   * Part of the run's IDENTITY, like `cwd`, rather than a per-turn setting: it
   * is chosen once when the chat is created and the settings PATCH does not
   * carry it. TEXT so the `safe: true` schema sync adds it additively.
   */
  @Property({ type: 'string', nullable: true })
  configDir: string | null = null;

  /**
   * The user's global custom instructions AS THEY STOOD when this run was
   * created; null when they had typed none, and for every row predating the
   * setting.
   *
   * A SNAPSHOT rather than a live read of `settings.json`, and the difference
   * is visible to the user: editing the box changes the next chat, never the
   * one already open. That is the deliberate half — `AgentAdapter.sessionKey`
   * hashes this value, so a live read would invalidate the kept CLI process
   * mid-conversation and respawn it, taking the user's MCP servers (and
   * whatever one of them owns, up to a browser they are logged into) down
   * between two messages.
   *
   * Part of the run's IDENTITY like `configDir` above, so the settings PATCH
   * does not carry it either. TEXT so the `safe: true` schema sync adds it
   * additively, no migration.
   */
  @Property({ type: 'text', nullable: true })
  customInstructions: string | null = null;

  /**
   * What the run's project told its agents when the run was created
   * (`ProjectScopeService.placeNewRun`: the name, description and
   * instructions), composed right after {@link customInstructions}; null when
   * the run is in no project or its project says nothing. A snapshot for
   * {@link customInstructions}' reason: editing the project must not respawn a
   * kept CLI.
   */
  @Property({ type: 'text', nullable: true })
  projectInstructions: string | null = null;

  /**
   * The language the user wanted replies in when this run was created
   * (`Settings.replyLanguage`); null when none was set, and for every row
   * predating the setting. A snapshot for {@link customInstructions}' reason:
   * it is argv (the composed block, and claude's `--settings`), so a live read
   * would respawn the kept CLI mid-conversation.
   */
  @Property({ type: 'text', nullable: true })
  replyLanguage: string | null = null;

  /**
   * The shared memory's title index this run's agents were given
   * (`MemoryService.runSnapshot`), composed right after
   * {@link projectInstructions}; null when memory was off or held nothing the
   * run may see. A snapshot for {@link customInstructions}' reason: a live read
   * would respawn the kept CLI whenever any agent saved a note.
   */
  @Property({ type: 'text', nullable: true })
  memoryIndex: string | null = null;

  /**
   * The knowledge index this run's agents are given: the documents the user
   * wrote or approved that it may see. A snapshot for
   * {@link customInstructions}' reason: a live read would respawn the kept CLI
   * whenever a document changed. Bodies are read live through `knowledge_read`.
   */
  @Property({ type: 'text', nullable: true })
  knowledgeIndex: string | null = null;

  /**
   * Whether each CLI's own memory is switched off for this run, decided when
   * it was created (`MemoryService.runSnapshot`). Null for every row predating
   * it, read as not switched off.
   */
  @Property({ type: 'boolean', nullable: true })
  nativeMemoryOff: boolean | null = null;

  /**
   * What the board card this run works asks of its agent — the card's LABEL
   * instructions and geniro's own report ask, already composed; null for every
   * run no card started.
   *
   * Its own column rather than joined into {@link customInstructions}, because
   * the two have different owners and different lifetimes. That column is the
   * USER's standing text, and `POST /v1/chats/forget-custom-instructions`
   * exists to purge it — a purge that must not take a task run's label block
   * and report ask with it. And this one is REFRESHED when a card is continued
   * in its existing thread (`TaskRunsService.resume`), so a label instruction
   * edited or added since the first press reaches the next turn; the user's own
   * snapshot is never re-read that way.
   *
   * Composed onto the turn right after {@link customInstructions}
   * (`turnInstructionParts`), and hashed by `AgentAdapter.sessionKey` on the
   * same terms. TEXT so the `safe: true` schema sync adds it additively.
   */
  @Property({ type: 'text', nullable: true })
  taskInstructions: string | null = null;

  /**
   * The DEFERRED card this run is parked on, as JSON
   * (`PendingCardSnapshot` — a question, a plan or a patch), or null when it
   * is parked on none. Every row names its `kind`; one that does not is
   * cleared at boot.
   *
   * It is the one card that OUTLIVES its turn — put up for a CLI whose MCP
   * client will not hold a call open for a person, answered by starting a new
   * turn rather than by resolving a parked promise. Everything else about such
   * a card lives in `ApprovalRegistry`, which is in memory, and the whole point
   * of the feature is that a person may take an hour: the daemon's own idle
   * shutdown fires after ten minutes with no window and no turn in flight — and
   * a deferred card is exactly that state — so the process that raised the card
   * is routinely gone before the answer arrives.
   *
   * So the durable copy is what makes it answerable at all: `rehydrateDeferredQuestions`
   * reads these rows at boot and puts each one back in the registry. A COLUMN
   * rather than a scan for an unanswered `approval_request` in the transcript,
   * because the alternative is one whole-transcript read per run at every
   * launch, unbounded in the number of chats the user has ever had.
   *
   * It is a POINTER into the transcript rather than a second copy of the card:
   * the row the user is looking at is the `approval_request` item, and this
   * carries only what re-tracking needs. TEXT so the `safe: true` schema sync
   * adds it additively.
   */
  @Property({ type: 'text', nullable: true })
  pendingQuestion: string | null = null;

  /**
   * The standing `propose_team` card, as JSON (`PendingTeamProposal`:
   * the card's id and the team it would write), or null.
   *
   * Durable for the reason {@link pendingQuestion} is — the card waits on a
   * person, and the daemon routinely exits before they answer — and a column of
   * its own because the two cards stand independently: a typed message retires
   * a question but not a proposal. Cleared BEFORE an approved proposal is
   * written, so a crash between the press and the write reads as an expired
   * card at the next boot, never as a second write.
   */
  @Property({ type: 'text', nullable: true })
  pendingTeamProposal: string | null = null;

  /**
   * A team run's standing `save_project_instructions` card, raised by its
   * lead (`TeamCardsService`), or null. A team run never uses
   * {@link pendingQuestion}, whose boot rehydration treats every row as a
   * chat's card. Cleared BEFORE an applied change is written, on
   * {@link pendingTeamProposal}'s terms.
   */
  @Property({ type: 'text', nullable: true })
  pendingTeamProjectCard: string | null = null;

  /**
   * A team run's standing `ask_user_question` cards, one per member's own
   * conversation, raised for a CLI that will not hold the call open
   * (`TeamCardsService`), or null. A card leaves it BEFORE its answer is sent,
   * on {@link pendingTeamProposal}'s terms.
   */
  @Property({ type: 'text', nullable: true })
  pendingMemberQuestions: string | null = null;

  /**
   * The library team this chat EDITS — the slug of a `*.team.yaml` file
   * the builder's chat panel opened a conversation about; null for every other
   * run.
   *
   * Not to be confused with {@link teamId}, which names the team a run
   * IS. This run is an ordinary chat that happens to be pointed at a team
   * file, the same way a task run is an ordinary chat pointed at a worktree.
   *
   * It exists so the panel can find its conversation again: the builder holds
   * a slug and nothing else, so without a column the only way back to the
   * chat would be matching on its title. Deleting the team deletes the
   * chat with it, unlike {@link taskId} — a conversation about a file that no
   * longer exists has no subject left.
   */
  @Property({ type: 'string', nullable: true })
  editsTeamSlug: string | null = null;

  /**
   * With {@link editsTeamSlug} null, the project this run is the own chat of
   * (`ProjectChatService`), hidden from the sidebar like a builder chat. With
   * a slug, the project a builder chat was bound to before project chats
   * existed; a builder chat opened since is bound to none.
   */
  @Property({ type: 'string', nullable: true })
  editsProjectId: string | null = null;

  /**
   * What geniro tells that chat's agent about the file it owns — where it is,
   * and what a team document may contain; null for every run outside the
   * builder's panel.
   *
   * Its own column beside {@link taskInstructions} rather than folded into it,
   * because the two describe different jobs and a run is only ever one of
   * them; and NOT folded into {@link customInstructions} for that field's own
   * reason — `POST /v1/chats/forget-custom-instructions` purges the user's
   * text, and a purge that also erased which file this agent edits would leave
   * it editing nothing.
   *
   * SNAPSHOTTED rather than re-derived per turn, on `customInstructions`'
   * terms: `AgentAdapter.sessionKey` hashes it, so a brief that changed under
   * a live conversation would respawn its CLI between two messages.
   */
  @Property({ type: 'text', nullable: true })
  teamInstructions: string | null = null;

  /**
   * The user's per-CLI switches (`AdapterConfig.options` — cursor's Max Mode,
   * claude's browser tools) as this run SNAPSHOTTED them at creation: JSON
   * text `{agentKind: {optionId: boolean}}`, read and written only through
   * `utils/agent-options.ts`.
   *
   * A snapshot on the same terms as {@link customInstructions} above: flipping
   * a switch changes the next run rather than the one already open, so a
   * conversation keeps the window and the toolbelt it was started with. A live
   * read would move a thread between a 200k and a 1M window between two
   * messages, which is the one thing a context meter must not do.
   *
   * NULL — and any id a snapshot does not carry — reads as each option's
   * declared default, never as off.
   */
  @Property({ type: 'text', nullable: true })
  agentOptions: string | null = null;

  /**
   * The sidebar group this run is filed under ({@link RunGroup.id}), or null
   * for one sitting loose at the bottom of the list.
   *
   * A plain id column rather than a MikroORM relation, the same shape
   * `teamId` uses: the group owns nothing about the run, and the direction
   * that matters is the one this column already expresses. Deleting a group
   * nulls this on its runs (`RunDao.clearGroup`) instead of cascading, because
   * a folder disappearing must never take a conversation with it. TEXT so the
   * `safe: true` schema sync adds it additively, no migration.
   */
  @Property({ type: 'string', nullable: true })
  groupId: string | null = null;

  /**
   * The board task this run was started for, or null for a run nobody started
   * from a card — every chat and every team run.
   *
   * A plain nullable id on `groupId`'s shape and for its reasons, with one
   * more: `v1/runs` is the substrate feature modules OBSERVE, so it may not
   * name the tasks module. Deleting a card — or the project holding it — NULLS
   * this on every run that names it (`releaseTaskRuns` in
   * `v1/tasks/utils/release-task-runs.ts`), the way deleting a group nulls
   * `groupId`, and never deletes the run: a conversation must outlive the card
   * that opened it, but as an ordinary chat rather than one presenting itself
   * as a card that no longer exists.
   *
   * The other end, `Task.runId`, is written by the same operation. Two
   * independently writable ends of one edge can only disagree if something
   * writes them apart; nothing does.
   */
  @Property({ type: 'string', nullable: true })
  taskId: string | null = null;

  /**
   * What that card is CALLED — `GEN-12` — or null for a run no card started.
   *
   * DENORMALIZED, and the module graph is what forces it rather than a
   * performance argument: the identifier is two rows away (the card's `number`
   * and its project's `taskKey`), and `v1/agents` — which projects this row
   * onto the wire — may never import the tasks module, the dependency running
   * one way only (`TasksModule`'s own note). So the one place that already
   * holds both halves writes the answer down: `TaskRunsService`, in the same
   * operation that writes {@link taskId}.
   *
   * It is a DISPLAY identity and never RE-WRITTEN while the card exists — a
   * card's number is handed out once and never reissued, and nothing edits a
   * project's key — so there is no copy here to drift out of date. It is
   * CLEARED, together with {@link taskId}, when the card or its project is
   * deleted (`releaseTaskRuns`): a label for a card that is gone describes
   * nothing. A run started before this column existed carries null and simply
   * draws no label, which is the same answer as a chat nobody started from a
   * card; it is deliberately not backfilled, the alternative being a one-time
   * sweep over the two rows in existence.
   */
  @Property({ type: 'string', nullable: true })
  taskIdentifier: string | null = null;

  /**
   * The project this run belongs to, settled once at creation
   * (`ProjectScopeService.placeNewRun`) and never moved: its instructions and
   * its shared memory follow it for the run's whole life. A plain id like
   * {@link groupId}: a deleted project leaves the id here, and every reader
   * asks for the LIVE project, so it then reads as none.
   */
  @Property({ type: 'string', nullable: true })
  projectId: string | null = null;

  /**
   * How {@link projectId} was settled; null for a run created before the
   * column, or whose project could not be read, which is resolved again
   * wherever it is asked (card, then exact folder).
   */
  @Property({ type: 'string', nullable: true })
  projectSource: ProjectSource | null = null;

  /**
   * The run this chat was started to ANALYSE ("Analyze thread"), or null for
   * every other chat.
   *
   * Its presence is what makes a chat an analysis chat: the analysis tools
   * (`read_analyzed_thread` and its siblings) are installed for a turn only
   * when it is set, and they read this one run and no other. Not a foreign
   * key — deleting the source leaves the analysis readable, and its tools
   * answer `SOURCE_GONE`.
   */
  @Property({ type: 'string', nullable: true })
  analysisSourceRunId: string | null = null;

  /**
   * The source's highest seq at the moment the analysis started — the
   * snapshot every read stops at, so a source still running when it was
   * clicked is analysed as it stood then.
   */
  @Property({ type: 'integer', nullable: true })
  analysisSourceSeq: number | null = null;

  /**
   * Whether the source was still working at that snapshot. Recorded at the
   * start rather than read later, so the same snapshot always folds the same:
   * a source continued afterwards would otherwise turn every span it left
   * unclosed at the snapshot into one still running.
   */
  @Property({ type: 'boolean', nullable: true })
  analysisSourceWorking: boolean | null = null;

  /**
   * What an analysis of {@link analysisSourceRunId} is for: null or `review`
   * is the user's own "Analyze thread", `lessons` a hidden lessons
   * reflection, which never replaces, hides or is read as that review.
   */
  @Property({ type: 'string', nullable: true })
  analysisPurpose: AnalysisPurpose | null = null;

  /**
   * The highest seq of this run a lessons reflection has finished reading;
   * the next reflection starts after it. Moves only when a reflection files
   * its lessons, and only to the snapshot that reflection read up to.
   */
  @Property({ type: 'integer', nullable: true })
  reflectedThroughSeq: number | null = null;

  /**
   * Set when the user deleted this run with "Extract lessons first": it is
   * archived, hidden from every listing, and deleted through the ordinary
   * delete once its reflection settles, after `LESSON_PENDING_DELETE_MAX_MS`,
   * or at the next daemon start.
   */
  @Property({ type: DateTimeType, nullable: true })
  pendingDeleteAt: Date | null = null;

  /**
   * The library team this chat was started to ANALYSE across its recent
   * runs ("Analyze & improve"), or null for every other chat. A team
   * analysis carries no {@link analysisSourceRunId}: it reads the runs named
   * in {@link analysisRuns} instead, and belongs to the team — deleting
   * one of those runs leaves it, deleting the team takes it.
   */
  @Property({ type: 'string', nullable: true })
  analysisTeamSlug: string | null = null;

  /**
   * The runs a team analysis reads, newest first, each with the seq its
   * reads stop at and whether it was working then — JSON
   * (`utils/analysed-runs.ts`). Null for every chat that is not one.
   */
  @Property({ type: 'text', nullable: true })
  analysisRuns: string | null = null;

  /**
   * Where this run sits in the PINNED band at the top of its own scope, or
   * null for one that is not pinned at all.
   *
   * The scope is {@link groupId}: a pinned run leads the group it is filed
   * under, and a pinned loose run leads the sidebar. So the column is a
   * position WITHIN a scope rather than a global one, and two runs in
   * different groups holding position 0 is the normal case.
   *
   * Kept CONTIGUOUS from 0 within each scope by every write that pins,
   * unpins, archives or re-files, exactly as `RunGroup.position` is — so "the
   * one above this" is always `position - 1` and no gap can accumulate into
   * an ordering two clients disagree about.
   *
   * Nullable INTEGER so the `safe: true` schema sync adds it additively, no
   * migration — and so that "not pinned" is a value rather than a sentinel
   * number a sort would have to know about.
   */
  @Property({ type: 'integer', nullable: true })
  pinnedPosition: number | null = null;

  /**
   * The colour the user tinted this thread's sidebar row with — a palette
   * NAME (`RUN_GROUP_COLORS`), never a hex, so the renderer maps it to a token
   * — or null for an untinted row.
   *
   * Written without touching `updatedAt`, like {@link pinnedPosition}: it is
   * how the sidebar draws the thread, not activity in it.
   */
  @Property({ type: 'string', nullable: true })
  color: RunGroupColor | null = null;

  /**
   * A summary of everything this conversation held BEFORE geniro compacted it,
   * waiting to be handed to the next turn — null whenever nothing is owed.
   *
   * Only a CLI whose compaction geniro performs itself
   * (`AgentGeniroCommand.replacesSession`) ever writes here. Such a compaction
   * drops the agent's own session, which is the entire point and also the
   * entire risk: the new session starts knowing nothing, so the summary the
   * compaction just produced is the ONLY thing standing between the user and a
   * conversation that has forgotten itself. It is therefore durable rather than
   * held in memory — a daemon restarted between the compaction and the next
   * message would otherwise lose exactly the thing the compaction was for.
   *
   * Consumed once: the next turn prepends it and clears the column in the same
   * write, so it cannot ride a second prompt. A CLI that compacts its own
   * history never touches this, and neither does a team run.
   *
   * TEXT so the `safe: true` schema sync adds it additively, no migration.
   */
  @Property({ type: 'text', nullable: true })
  pendingContext: string | null = null;

  /**
   * The pull requests this run opened, as a JSON array of
   * `{owner, repo, number, url, seq}` — see `agents/utils/pull-request-capture.ts`.
   *
   * On the RUN because it is the only place the answer survives: the pull
   * request is opened by the agent's own `gh` in a checkout that then moves on,
   * and often in a sibling repository the run's `cwd` never names. The
   * transcript holds the evidence, but re-deriving it on every read means
   * scanning the whole conversation (14k items on a real thread here), so it is
   * scanned once and kept.
   *
   * TEXT so the `safe: true` schema sync adds it additively, no migration —
   * the same rule {@link pendingContext} follows.
   */
  @Property({ type: 'text', nullable: true })
  pullRequests: string | null = null;

  /**
   * The usage-limit continues geniro has PROMISED this run and not yet made —
   * JSON `PersistedResetWake[]` (see `utils/run-reset-wakes.ts`), null when
   * none is waiting.
   *
   * A column rather than only a daemon timer: a caller is told "geniro starts
   * you again when it resets" and waits hours for it, and a restart in those
   * hours must not drop it without a word. The boot
   * rehydration reads this and arms the timer again; the renderer reads it to
   * say when the continue happens, with a way to call it off. TEXT so the
   * `safe: true` schema sync adds it additively.
   */
  @Property({ type: 'text', nullable: true })
  resetWakes: string | null = null;

  /**
   * How far {@link pullRequests} has been scanned — the highest item `seq` the
   * capture pass has looked at, or null when it never ran.
   *
   * This is what makes the scan INCREMENTAL and the backfill free: a run whose
   * marker is null is scanned whole (recovering every pull request opened
   * before this feature existed), and after that each pass only reads items
   * newer than the marker, which the `(run_id, seq)` index serves directly.
   *
   * NULL rather than -1 as the "never scanned" value: a run genuinely scanned
   * when it had no items records -1, and the two mean different things to a
   * later pass that has to decide whether history still needs recovering.
   */
  @Property({ type: 'integer', nullable: true })
  pullRequestsScannedSeq: number | null = null;

  /**
   * Pull requests the run's CLI conversations only TOUCHED, by their own
   * record (`AgentAdapter.readSessionPullRequests`: checked out, commented on,
   * pushed to, merged) — JSON `RunPullRequest[]`, null when none. Kept apart
   * from {@link pullRequests} because they are shown beside the opened ones
   * and nothing else: a merge of one must not end the card, and Stats must not
   * count it as opened. TEXT so the `safe: true` schema sync adds it.
   */
  @Property({ type: 'text', nullable: true })
  touchedPullRequests: string | null = null;

  /**
   * The newest `record_outcome` per pull request — JSON keyed by
   * `pullRequestKey` (see `agents/utils/run-outcomes.ts`), null when none was
   * recorded. A column beside the pull-request lists because the run's wire
   * projection is synchronous over its columns, and the outcome rides each
   * displayed pull request; the `run_outcome` rows stay the record. TEXT so the
   * `safe: true` schema sync adds it.
   */
  @Property({ type: 'text', nullable: true })
  runOutcomes: string | null = null;

  @Property({ type: 'text', nullable: true })
  stageProgress: string | null = null;

  /**
   * The team member a team run's messages go to now (`currentLeadOf`): the
   * trigger's member in `lead` mode, the current stage's lead in `relay`
   * mode. Written at run start and with every stage progress write; null for
   * a chat and for a run started before it was recorded.
   */
  @Property({ type: 'text', nullable: true })
  currentLead: string | null = null;

  /**
   * The run's goals as `run_goals` holds them, JSON, rewritten after every
   * goals write: the wire projection is synchronous over the row's columns.
   * The table is the record and outlives the run; null when none was set.
   */
  @Property({ type: 'text', nullable: true })
  goals: string | null = null;

  /**
   * The newest `thread_outcome` row's outcome, JSON; the rows stay the
   * record. Null when no agent recorded one.
   */
  @Property({ type: 'text', nullable: true })
  threadOutcome: string | null = null;

  /**
   * Which capture rule {@link pullRequestsScannedSeq} was reached under
   * (`PULL_REQUEST_SCAN_VERSION`), or null for a run scanned before rules were
   * versioned. A marker reached under another rule says nothing about what the
   * current rule would find behind it, so such a run is read again from the
   * start, once.
   */
  @Property({ type: 'integer', nullable: true })
  pullRequestsScanVersion: number | null = null;

  /**
   * The `PAYLOAD_REFS_VERSION` every row of this run carries its payload
   * columns under (`Item.payloadId` …), or null for a run whose older rows the
   * boot sweep has not stamped yet — its lookups read the payload instead. A
   * run created by this build is stamped from its first row.
   *
   * Set by `onCreate`, never an initializer: MikroORM writes an initializer
   * into the column's DDL default, which would mark every run that existed
   * before the column as stamped.
   */
  @Property({
    type: 'integer',
    nullable: true,
    onCreate: () => PAYLOAD_REFS_VERSION,
  })
  payloadRefsVersion: number | null = null;

  /**
   * The newest item seq through which the boot reconcile of stranded work
   * (`main.ts`) last found nothing of this run left open, or null for a run it
   * has not read since the column existed. A launch reads only the runs whose
   * newest seq differs from it: anything left open was written since.
   */
  @Property({ type: 'integer', nullable: true })
  reconciledThroughSeq: number | null = null;

  /**
   * When this run was ARCHIVED — shelved out of the chat list but destroyed in
   * no way — or null while it is not.
   *
   * Its OWN column rather than {@link TimestampsEntity.deletedAt}, and that is
   * the load-bearing part: `softDelete` is a `@Filter` declared `default: true`
   * on the base entity, so a row carrying `deletedAt` disappears from every
   * read at once — `getById`, cancel, history, metrics and the teardown alike.
   * An archived run has to stay fully reachable (that is what makes archiving
   * reversible), and one hidden by that filter could not even be unarchived,
   * since the write would have nothing to find.
   *
   * `datetime` and nullable so the `safe: true` schema sync adds it
   * additively, no migration.
   */
  @Property({ type: DateTimeType, nullable: true })
  archivedAt: Date | null = null;

  /**
   * The user's own notes on this thread — free text they keep for themselves,
   * or null while there are none.
   *
   * Never composed into a turn: unlike {@link customInstructions} this is not
   * addressed to the agent, and reaching it would turn a private scratchpad
   * into a prompt the user did not mean to send. TEXT and nullable so the
   * `safe: true` schema sync adds it additively, no migration.
   */
  @Property({ type: 'text', nullable: true })
  notes: string | null = null;

  /**
   * When this run last did something the user has not necessarily looked at —
   * a turn that finished or failed, or a card that went up asking them
   * something — or null while it never has.
   *
   * Half of the UNREAD mark; {@link seenAt} is the other. The mark used to be
   * the renderer's own per-window bookkeeping, so a thread opened on the phone
   * stayed bold on the desktop, and every reload forgot every mark. Stamped by
   * the daemon (`RunAttentionService`) off the same status broadcast every
   * client reads, so all of them agree on WHEN it happened, on one clock.
   *
   * Written without touching `updatedAt`: the turn that earned it already
   * moved the row. `datetime` and nullable so the `safe: true` schema sync adds
   * it additively — and null on every row from before it, which reads as
   * nothing unread rather than as a whole history of unread threads.
   */
  @Property({ type: DateTimeType, nullable: true })
  attentionAt: Date | null = null;

  /**
   * When the user last LOOKED at this run, on any device, or null while they
   * never have since {@link attentionAt} began being kept.
   *
   * The run is unread exactly while `attentionAt` is later than this. A moment
   * rather than a flag so the two halves cannot race: a turn that settles
   * after the user opened the thread is unread again, and one that settled
   * before is not — whichever device asked, in whatever order the writes land.
   */
  @Property({ type: DateTimeType, nullable: true })
  seenAt: Date | null = null;

  /**
   * Each agent's own task list as it stands now, as a JSON array of
   * `{nodeId, tasks}` — see `agents/utils/task-list-fold.ts`.
   *
   * On the RUN for the reason {@link contextTokens} is on it: the transcript
   * carries the list only as the announcements that MOVED it, and neither
   * shipped CLI re-states the whole thing. Measured 2026-08-31 on real turns —
   * claude wrote fifteen patches naming one task each and no snapshot at all,
   * cursor wrote one snapshot then patches naming one or two rows — so the
   * complete list exists only in the earliest announcements. A client folds the
   * window it loaded (`HISTORY_PAGE` items), and past that the opening
   * announcement has fallen out: folding that cursor run's tail alone yields
   * `3/3` where the truth is `2/6`, a total that SHRANK rather than an obviously
   * missing one. Folding once here is what makes the answer independent of how
   * much transcript any given window happens to hold.
   *
   * TEXT so the `safe: true` schema sync adds it additively, no migration — the
   * rule {@link pullRequests} and {@link pendingContext} follow.
   */
  @Property({ type: 'text', nullable: true })
  taskList: string | null = null;

  /**
   * The team this run RAN, as JSON — a copy taken when the run started, so
   * editing the library team afterwards changes neither what the run's
   * agents panel draws nor what a follow-up message runs. Asked for as "old
   * teams chats should not be changed if i change current team. They
   * should use snapshots".
   *
   * Null on a chat run, and on a team run created before this column
   * existed until something first reads it: that read takes the library copy
   * as it is at that moment and keeps it (`RunTeamService`), so an old run
   * is frozen from then on rather than refused.
   *
   * TEXT so the `safe: true` schema sync adds it additively — the rule
   * {@link taskList} follows.
   */
  @Property({ type: 'text', nullable: true })
  teamSnapshot: string | null = null;

  /**
   * The SHARED team this run started from, before its project's overlay —
   * what every team version, version restore and drift reader reads
   * (`baseTeamSnapshotOf`), so a project's overrides never mint a version of
   * their own. {@link teamSnapshot} holds the effective team the run runs.
   * Null on a run started before overlays, whose snapshot is its base.
   */
  @Property({ type: 'text', nullable: true })
  teamBaseSnapshot: string | null = null;

  /**
   * JSON `{projectId, hash, overlay}` of the project overlay applied at start
   * (`TeamOverlaySnapshot`); null when the run's project does not default to
   * its team or holds no overlay.
   */
  @Property({ type: 'text', nullable: true })
  teamOverlaySnapshot: string | null = null;

  /**
   * What this run's POLLED conversations have cost, in CENTS, as the account
   * behind their CLI reports it — for a CLI whose turns carry no price
   * (`AdapterConfig.usage.polledSpend`). Null for every run nothing has
   * priced, which is every run of a self-pricing CLI and every polled run
   * before its first poll.
   *
   * On the run because such a CLI reports no cost on the wire, so the figure is
   * fetched for the ACCOUNT in one batched poll (`PolledSpendService`) and
   * attributed here by conversation id. Cents rather than dollars because that
   * is the unit an account reports, and `float` because a charge is fractional
   * cents — rounding on the way in would make a thread's total drift from the
   * bill it is checked against.
   */
  @Property({ type: 'float', nullable: true })
  polledCostCents: number | null = null;

  /**
   * How many billable events {@link polledCostCents} was summed from — a price
   * with no count cannot say what it covers, and a thread whose events have not
   * been fetched yet must stay distinguishable from one that cost nothing.
   */
  @Property({ type: 'integer', nullable: true })
  polledCostEvents: number | null = null;

  /**
   * {@link polledCostCents} split by local calendar day and model — JSON,
   * `"YYYY-MM-DD|model"` → cents, summed over the run's members' polled ledgers
   * (`spendBucket` in `utils/polled-spend-ledger.ts`). What lets the Stats page
   * place a polled bill on the days it was spent and under the models that
   * served it, where one figure per run filed the whole bill under the run's
   * last day and no model at all. Rewritten whole by every poll that moves it.
   */
  @Property({ type: 'text', nullable: true })
  polledSpendBuckets: string | null = null;

  /**
   * What this run's agents have SPENT that no durable row records yet — JSON,
   * live-plane owner key → dollars, or `{costUsd, estimatedCostUsd}` when part
   * of them was priced by geniro (`agents/utils/unrecorded-spend.ts`), null
   * when nothing is outstanding.
   *
   * A turn's cost reaches `items` only with its `turn_complete`, so a callee
   * an hour into one turn has spent money no row carries. That figure was held
   * in the daemon's memory alone, and a client that missed the moment it moved
   * — a thread reopened, a restart — drew the recorded total as the whole bill:
   * REPORTED as a team header falling from ~$40 to $1.71 on a thread
   * switch. Kept here, written by `PartialStreamService` on every change and
   * cleared in step with it, so it survives a restart and seeds the live plane
   * at boot (`rehydrateUnrecordedSpend`).
   *
   * TEXT so the `safe: true` schema sync adds it additively — the rule
   * {@link polledSpendBuckets} follows.
   */
  @Property({ type: 'text', nullable: true })
  unrecordedSpend: string | null = null;

  /**
   * JSON: launching tool call id → that delegate's figures over every model
   * request it made (`agents/utils/delegate-spend.ts`), null when none was
   * counted. The live plane carries them while the daemon runs; this copy is
   * what the run-state read and a restarted daemon see. TEXT for the same
   * additive schema sync as {@link unrecordedSpend}.
   */
  @Property({ type: 'text', nullable: true })
  delegateSpend: string | null = null;
}
