import { Injectable, Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type {
  DelegateFigures,
  LiveWordsEvent,
} from '../adapters/adapter.types';
import { type RunDeltaEvent, SINGLE_AGENT_NODE } from '../chat.types';
import { AgentEventBus } from './agent-events.bus';
import { contextWindowKey, ContextWindowStore } from './context-window.store';
import { DelegateSpendStore } from './delegate-spend.store';
import { UnrecordedSpendStore } from './unrecorded-spend.store';

/**
 * Hard cap on one owner's live tail. A runaway block stops growing rather than
 * pushing an unbounded string across the wire on every delta; the durable
 * `message` item that follows carries the full text regardless.
 */
const MAX_TAIL_CHARS = 64 * 1024;

/**
 * How many argument bytes a composition must gain before its progress is
 * re-published. See {@link PartialStreamService.composing}.
 *
 * 2KB is roughly one broadcast per 250 vendor frames at the measured chunk
 * size, and about 25 over a 50KB artifact — often enough that the figure looks
 * live, rare enough that a big payload costs tens of events rather than
 * thousands.
 */
const COMPOSE_PUBLISH_STEP = 2048;

/** What one agent is doing right now — the whole of the ephemeral state. */
interface LiveState {
  /** Words streamed since that agent's last durable item. */
  text: string;
  /**
   * How many reasoning stretches this turn has OPENED, counting from 1.
   *
   * The number itself means nothing to a reader — it exists so a client can
   * tell one stretch from the next. A turn reasons, writes, reasons again;
   * without an identity on the wire those two stretches are indistinguishable
   * from one long one, and a renderer showing "thinking" has no way to know it
   * should start a fresh row with a fresh clock rather than keep growing the
   * old one.
   */
  thinkingStretch: number;
  /** The CURRENT stretch's running total, or null when not reasoning. */
  thinkingCurrent: number | null;
  /**
   * The CURRENT stretch's reasoning text so far, or '' when there is none.
   *
   * Only a CLI that DISCLOSES its thinking ever fills this; a token count is
   * a separate field because claude reports one with or without the words.
   * Either one being present means a stretch is open
   * ({@link PartialStreamService.isReasoning}).
   */
  thinkingText: string;
  /** When the CURRENT stretch began (epoch ms), or null when not reasoning. */
  thinkingSince: number | null;
  /** Prompt-side tokens as of the turn's most recent request, or null. */
  contextTokens: number | null;
  /**
   * What THIS TURN has spent so far, summed over its requests.
   *
   * A RUNNING TOTAL where {@link LiveState.contextTokens} beside it is a level:
   * the window does not grow by what a request cost, and the bill does not
   * shrink when a compaction empties the window. Null until the first request
   * reports, so "not measured" and "spent nothing" stay different readings —
   * the rule every figure on this plane follows.
   *
   * Reset when a turn OPENS ({@link PartialStreamService.startTurn}), not when
   * it ends: the process is kept across turns, so without that the second
   * message of a conversation would open on the first one's total.
   */
  spentInputTokens: number | null;
  spentOutputTokens: number | null;
  spentCacheReadTokens: number | null;
  /**
   * Dollars this owner's process has spent that no durable row carries yet —
   * the `cost_progress` reading, REPLACED on each one rather than summed.
   * Null until a CLI that can say so has said so.
   */
  spentCostUsd: number | null;
  /** Of {@link spentCostUsd}, the part geniro priced itself; null when none. */
  spentEstimatedCostUsd: number | null;
  /**
   * The tool whose arguments the model is writing RIGHT NOW, or null when it
   * is not writing one.
   *
   * A third thing an agent can be doing, beside talking and thinking, and the
   * only one of the three with no signal of its own until now: nothing reaches
   * the transcript between the decision to call a tool and the whole call
   * having been serialized. Fed by the `tool_compose` agent event.
   */
  composingTool: string | null;
  /** Argument bytes written so far in the CURRENT composition. */
  composingBytes: number;
  /**
   * The delegates this owner launched, by launching tool call id, each at its
   * latest figures. REPLACED per delegate, never added: the CLI's own running
   * total already counts what its delegates spent.
   */
  delegates: Map<string, DelegateFigures>;
}

/**
 * The live (non-persisted) text plane behind a growing assistant bubble.
 *
 * Deltas are EPHEMERAL by contract — no `seq`, no row, no replay — so this
 * service holds the only copy of the not-yet-persisted tail. It exists to do
 * three things and nothing else:
 *
 * - **accumulate** each delta into the current tail and publish the whole tail
 *   (REPLACE semantics, never an increment) so a client that missed a delta is
 *   correct again on the very next one;
 * - **retire** the tail the moment the durable `message` item for those same
 *   words is persisted, so nothing is ever rendered twice;
 * - **flush** whatever is left when a turn dies mid-block, as ONE
 *   `partial`-flagged message item, so an `afterSeq` replay shows the user the
 *   text they actually watched being written.
 *
 * Every public method is total: this plane is a nicety layered over the
 * durable one, and a failure here must never fail a turn (its callers run
 * inside the persist chain, where a throw would mark the run failed).
 */
@Injectable()
export class PartialStreamService {
  private readonly logger = new Logger(PartialStreamService.name);
  /** runId -> ownerKey -> what that agent is doing right now. */
  private readonly tails = new Map<string, Map<string, LiveState>>();
  /**
   * (runId, ownerKey) -> the context window the CLI last reported for it.
   *
   * Remembered because the window rides the `result` line ONLY (probe-verified
   * on claude 2.1.220, and again on 2.1.x here:
   * `result.modelUsage[<model>].contextWindow`, absent from every `assistant`
   * line and from `system/init`), while the live context figure arrives
   * mid-turn. Without this the meter could show a token count with nothing to
   * scale it against until the turn finished — and a client reconnecting
   * mid-turn would see an unscaled number for the rest of it.
   *
   * Keyed by OWNER, not by run. A 1:1 chat has exactly one owner so the two are
   * the same thing there — but a team run is N agents that routinely run on
   * DIFFERENT models, and a run-scoped window is whichever member reported last:
   * an opus member's 160k would have been drawn against a haiku member's 200k. The
   * owner is the thing a window belongs to.
   */
  private readonly windows = new Map<string, number>();
  /**
   * model id -> the window that model reported, learned from any run.
   *
   * The per-RUN map above cannot help a run's FIRST turn: the window rides the
   * `result` line only, so until one turn finished there was nothing to scale
   * against and the meter fell back to an assumed 200k — which is how a
   * 1M-window model came to be shown as a fifth full before it had said
   * anything. A window is a property of the MODEL, not of the conversation, so
   * remembering it by model makes every later chat on that model correct from
   * its first request.
   *
   * The hot half of a cache whose cold half is {@link ContextWindowStore}: a
   * miss here consults the store, which survives daemon restarts. It was
   * process-lifetime only, and that was the defect — the window rides the
   * `result` line, so a fresh process had nothing to scale against until a
   * turn COMPLETED, and every chat showed a denominator-less meter for its
   * whole first turn after each app launch.
   *
   * Still never assumed: a model neither this process nor the store has ever
   * seen stays unknown, and the meter renders the count with no ring rather
   * than measuring against a guess.
   */
  private readonly windowsByModel = new Map<string, number>();
  /**
   * (runId, ownerKey) -> the model key its current turn announced, for the
   * lookup above.
   *
   * Also what makes the owner-scoped window above INVALIDATABLE: a chat may
   * switch model between turns (the composer's chips are editable mid-run), and
   * a window learned from the previous model would otherwise be kept for the
   * whole next turn — a 300k request on a 1M model reading "300k / 200k".
   */
  private readonly runModels = new Map<
    string,
    { key: string; agent: AgentKind; model: string }
  >();

  constructor(
    private readonly bus: AgentEventBus,
    private readonly windowStore: ContextWindowStore,
    /**
     * The durable twin of every `spentCostUsd` below — written on each change
     * so a restart, or a client that missed the change, still has the money
     * no row records yet (`Run.unrecordedSpend`).
     */
    private readonly spendStore: UnrecordedSpendStore,
    /** The durable twin of every delegate's figures — `Run.delegateSpend`. */
    private readonly delegateSpend: DelegateSpendStore,
  ) {}

  /** Put one words or reasoning event on its owner's live state. */
  feed(
    runId: string,
    ownerKey: string,
    memberId: string | null,
    event: LiveWordsEvent,
  ): void {
    switch (event.type) {
      case 'text_delta':
        this.append(runId, ownerKey, memberId, event.text);
        return;
      case 'thinking_progress':
        this.thinking(runId, ownerKey, memberId, event.tokens);
        return;
      case 'reasoning_delta':
        this.reasoning(runId, ownerKey, memberId, event.text);
        return;
    }
  }

  /** Extend an owner's tail and publish it. */
  append(
    runId: string,
    ownerKey: string,
    memberId: string | null,
    delta: string,
  ): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      // Words are arriving, so the reasoning STRETCH is over — otherwise the
      // indicator would sit under the growing text for the rest of the turn.
      //
      // Closed BEFORE the cap check, not after: the cap stops the tail from
      // growing, not the turn from progressing. Returning first left the
      // stretch open forever once a turn crossed 64 KB, so the "thinking" row
      // never cleared for that agent again — the exact defect this plane was
      // reworked to fix.
      const endedAStretch =
        this.isReasoning(state) || state.composingTool !== null;
      state.thinkingCurrent = null;
      state.thinkingText = '';
      // Words arriving end a COMPOSITION too, on the same reasoning. The CLI's
      // own `content_block_stop` normally closes it a frame earlier; this is
      // what keeps a CLI that omits that frame from leaving a card skeleton on
      // screen for the rest of the turn.
      state.composingTool = null;
      state.composingBytes = 0;
      if (state.text.length >= MAX_TAIL_CHARS) {
        // Publish ONLY when this delta actually changed something — i.e. it
        // ended a reasoning stretch. Publishing unconditionally here would put
        // a byte-identical 64 KB event on the wire for every remaining delta of
        // the turn, which is the exact traffic the cap exists to stop.
        if (endedAStretch) {
          this.publish(this.eventOf(runId, ownerKey, memberId, state));
        }
        return;
      }
      state.text = (state.text + delta).slice(0, MAX_TAIL_CHARS);
      this.publish(this.eventOf(runId, ownerKey, memberId, state));
    } catch (err) {
      this.warn('append', err);
    }
  }

  /** Report that the model is reasoning, with its running token total. */
  thinking(
    runId: string,
    ownerKey: string,
    memberId: string | null,
    tokens: number,
  ): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      // A null current total means no stretch is open, so this delta OPENS one:
      // new identity, new clock. Both are per stretch rather than per turn
      // because a stretch is what the user is watching — a turn that thinks,
      // runs three tools, then thinks again is two separate waits, and showing
      // the first one's clock still running through the second read as a
      // counter that never resets under rows that kept piling up above it.
      if (!this.isReasoning(state)) {
        state.thinkingStretch += 1;
        state.thinkingSince = Date.now();
      }
      state.thinkingCurrent = tokens;
      this.publish(this.eventOf(runId, ownerKey, memberId, state));
    } catch (err) {
      this.warn('thinking', err);
    }
  }

  /**
   * Extend the CURRENT stretch's reasoning TEXT and publish it — the same
   * REPLACE semantics as {@link append}, for a CLI that discloses what it is
   * thinking rather than only how many tokens it has spent.
   *
   * It OPENS a stretch exactly as {@link thinking} does, and that is what the
   * report this exists for turned on: cursor streams thought chunks and no
   * stretch was ever opened for them, so a turn that thought for minutes drew
   * the generic `Working…` row for the whole wait — the transcript's answer
   * for an agent that has shown nothing, about an agent that was showing
   * something the whole time.
   *
   * Words WIN over thinking on the client, so the two never race for the same
   * row: this only ever fills a stretch that `append` has not already closed.
   */
  reasoning(
    runId: string,
    ownerKey: string,
    memberId: string | null,
    delta: string,
  ): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      const opened = !this.isReasoning(state);
      if (opened) {
        state.thinkingStretch += 1;
        state.thinkingSince = Date.now();
      }
      // Past the cap the stretch is already open and the text cannot grow, so
      // there is nothing new to say — publishing anyway would put a
      // byte-identical event on the wire for every remaining chunk, which is
      // the traffic the cap exists to stop (the same rule `append` follows).
      if (!opened && state.thinkingText.length >= MAX_TAIL_CHARS) {
        return;
      }
      state.thinkingText = (state.thinkingText + delta).slice(
        0,
        MAX_TAIL_CHARS,
      );
      this.publish(this.eventOf(runId, ownerKey, memberId, state));
    } catch (err) {
      this.warn('reasoning', err);
    }
  }

  /**
   * Report that the model is WRITING A TOOL CALL — which tool, and how much of
   * its arguments has arrived.
   *
   * Three frames in one method, because they are three states of one fact and
   * splitting them into three public verbs would let a caller open a
   * composition it never closes. A named `tool` OPENS one (byte count reset to
   * zero, because the count is per call and a turn makes several); `done`
   * CLOSES it; anything else ADDS to the one already open.
   *
   * A byte frame for a composition that is not open is DROPPED rather than
   * opening an anonymous one: the whole value of this plane is the tool's NAME
   * — a client uses it to decide whether to draw an artifact skeleton or
   * nothing at all — so a count with no name to go with it says nothing a
   * reader could act on, and would flicker a nameless placeholder onto the
   * screen for every `Bash` the agent runs.
   */
  composing(
    runId: string,
    ownerKey: string,
    memberId: string | null,
    frame: { tool: string | null; bytes: number; done: boolean },
  ): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      if (frame.done) {
        if (state.composingTool === null) {
          // The close of a text or thinking block — every block sends one. See
          // `mapClaudeStreamEvent`, which cannot tell them apart by index.
          return;
        }
        state.composingTool = null;
        state.composingBytes = 0;
      } else if (frame.tool !== null) {
        state.composingTool = frame.tool;
        state.composingBytes = 0;
        // Writing a call ends a reasoning stretch, on the rule `append`
        // follows for words: the agent has stopped deliberating and started
        // producing. Without this a model that thinks and then calls a tool
        // without saying anything keeps a `Thinking…` row above the loader for
        // the whole composition, which is two rows about one wait.
        state.thinkingCurrent = null;
        state.thinkingText = '';
      } else {
        if (state.composingTool === null) {
          return;
        }
        const before = state.composingBytes;
        state.composingBytes += Math.max(0, frame.bytes);
        // THROTTLED, unlike every other publisher here, because these frames are
        // an order of magnitude finer than a text delta: measured on claude
        // 2.1.x, a 503-byte `Write` argument arrived in 64 frames — about 8
        // bytes each — so a 50KB artifact would be ~6,000 socket broadcasts of a
        // figure nobody can read changing that fast. A step means the count
        // still climbs visibly and the traffic is bounded by the payload's SIZE
        // rather than by how finely the vendor chunks it.
        if (
          Math.floor(before / COMPOSE_PUBLISH_STEP) ===
          Math.floor(state.composingBytes / COMPOSE_PUBLISH_STEP)
        ) {
          return;
        }
      }
      this.publish(this.eventOf(runId, ownerKey, memberId, state));
    } catch (err) {
      this.warn('composing', err);
    }
  }

  /**
   * Whether a reasoning stretch is open — EITHER channel counts.
   *
   * One predicate rather than a check per call site: cursor fills only the
   * words, so a site that asked about only the token total would treat a
   * cursor stretch as closed and open a second one on its next chunk.
   */
  private isReasoning(state: LiveState): boolean {
    return state.thinkingCurrent !== null || state.thinkingText !== '';
  }

  /**
   * Report that the agent is no longer reasoning — anything else it does ends
   * the stretch.
   *
   * `append` closes a stretch too, because words arriving are the commonest way
   * one ends. They are not the only way: a model that thinks and then calls a
   * tool without saying anything first emits no delta at all, so the stretch
   * stayed open for the whole tool call and the transcript claimed the agent
   * was "Thinking… 74 tokens" while it was running Bash — measured at 3.5s on
   * one turn here, and unbounded in general (a `sleep 40` would hold it for the
   * whole command). Worse, the CLI's NEXT stretch then merged into the open one
   * instead of opening a fresh row, so its clock and its token count both
   * carried the previous wait's numbers.
   *
   * Called on every DURABLE event, which is the honest rule: the moment
   * something reaches the transcript, whatever the agent was silently doing
   * before it is over. Idempotent — a stretch that is already closed publishes
   * nothing, so calling it per event costs no traffic.
   */
  endThinking(runId: string, ownerKey: string, memberId: string | null): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      if (!this.isReasoning(state)) {
        return;
      }
      state.thinkingCurrent = null;
      state.thinkingText = '';
      this.publish(this.eventOf(runId, ownerKey, memberId, state));
    } catch (err) {
      this.warn('endThinking', err);
    }
  }

  /**
   * Report how full the window is as of the turn's most recent request.
   *
   * Mid-turn, unlike the `turn_complete` figure the meter used to wait for:
   * every `assistant` line carries its request's prompt-side usage, so the
   * meter can move while the turn runs instead of jumping once at the end.
   */
  context(
    runId: string,
    ownerKey: string,
    memberId: string | null,
    contextTokens: number,
  ): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      state.contextTokens = contextTokens;
      this.publish(this.eventOf(runId, ownerKey, memberId, state));
    } catch (err) {
      this.warn('context', err);
    }
  }

  /**
   * ADD one request's spend to this turn's running total, and publish it.
   *
   * Accumulating here rather than in the adapter is what makes the figure the
   * TURN's: an adapter sees one request at a time and has no memory across
   * them, while this plane is already keyed by the same owner the turn runs
   * under. It also means the reset has exactly one home — {@link startTurn}.
   *
   * Each figure sums independently and a null part adds nothing, on the rule
   * the whole plane follows: a request that reported no output count says
   * nothing about output, and must not turn a real total into a smaller one.
   */
  spend(
    runId: string,
    ownerKey: string,
    memberId: string | null,
    parts: {
      inputTokens?: number | null;
      outputTokens?: number | null;
      cacheReadTokens?: number | null;
    },
  ): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      state.spentInputTokens = addSpend(
        state.spentInputTokens,
        parts.inputTokens,
      );
      state.spentOutputTokens = addSpend(
        state.spentOutputTokens,
        parts.outputTokens,
      );
      state.spentCacheReadTokens = addSpend(
        state.spentCacheReadTokens,
        parts.cacheReadTokens,
      );
      this.publish(this.eventOf(runId, ownerKey, memberId, state));
    } catch (err) {
      this.warn('spend', err);
    }
  }

  /**
   * What this owner's process has spent that is not yet on any durable row —
   * SET, not added, and published.
   *
   * The CLI answers with a running total that it zeroes itself at each
   * `result` line (see the `cost_progress` event), so the only correct thing to
   * do with a reading is to replace the last one. A reader adds it to the
   * recorded totals, which is what turns a running call's card from "the turns
   * that finished" into what the call has actually cost so far.
   */
  cost(
    runId: string,
    ownerKey: string,
    memberId: string | null,
    costUsd: number,
    estimatedCostUsd: number | null = null,
  ): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      if (
        state.spentCostUsd === costUsd &&
        state.spentEstimatedCostUsd === estimatedCostUsd
      ) {
        return;
      }
      state.spentCostUsd = costUsd;
      state.spentEstimatedCostUsd = estimatedCostUsd;
      this.spendStore.set(runId, ownerKey, costUsd, estimatedCostUsd);
      this.publish(this.eventOf(runId, ownerKey, memberId, state));
    } catch (err) {
      this.warn('cost', err);
    }
  }

  /**
   * One delegate's figures over every request it has made so far — REPLACED per
   * delegate id, and never added to the owner's spend, which already includes
   * what its delegates cost.
   *
   * A reading equal to the one held is not published again. A final reading is
   * still handed to the store even when unchanged, so its figures reach the row
   * at once rather than when the coalesced write comes round.
   */
  delegate(
    runId: string,
    ownerKey: string,
    memberId: string | null,
    event: { delegateId: string; figures: DelegateFigures; final: boolean },
  ): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      const held = state.delegates.get(event.delegateId);
      if (event.final) {
        // An ended delegate leaves the live plane: its closing `subagent_info`
        // and the run row carry it from here, and an owner kept on the plane
        // only for finished delegates would read as still at work.
        this.delegateSpend.set(runId, event.delegateId, event.figures, true);
        if (state.delegates.delete(event.delegateId)) {
          this.publish(this.eventOf(runId, ownerKey, memberId, state));
        }
        return;
      }
      if (held !== undefined && sameFigures(held, event.figures)) {
        return;
      }
      state.delegates.set(event.delegateId, event.figures);
      this.delegateSpend.set(
        runId,
        event.delegateId,
        event.figures,
        event.final,
      );
      this.publish(this.eventOf(runId, ownerKey, memberId, state));
    } catch (err) {
      this.warn('delegate', err);
    }
  }

  /**
   * This owner's turn is OVER — nothing it spent is unrecorded any more, or
   * what is will be recorded by a line this owner no longer answers for.
   *
   * A turn can settle with no `result` line of its own (released on idle or on
   * a delegate's report, the silence deadline), and the next `result` on that
   * process then records the money durably — as an off-turn row, or under the
   * next call. A figure left standing on this key would be counted a second
   * time beside it, by every reader that adds the live plane to the recorded
   * totals. Published only when there was a figure to take down.
   */
  retireCost(runId: string, ownerKey: string, memberId: string | null): void {
    try {
      // The row first and unconditionally: a figure seeded at boot for an
      // owner this process never published for is still owed a retirement.
      this.spendStore.set(runId, ownerKey, null);
      const state = this.tails.get(runId)?.get(ownerKey);
      if (!state || state.spentCostUsd === null) {
        return;
      }
      state.spentCostUsd = null;
      state.spentEstimatedCostUsd = null;
      this.publish(this.eventOf(runId, ownerKey, memberId, state));
    } catch (err) {
      this.warn('retireCost', err);
    }
  }

  /**
   * A turn is OPENING for this owner — zero what the last one spent.
   *
   * Only the spend, deliberately: the context is a LEVEL that carries over (a
   * new turn opens on the window the last one left behind, which is what the
   * ring should show before the first request lands), while the bill is
   * per-turn and starting a turn on the previous one's total would show a
   * figure that only ever climbs across a conversation.
   */
  startTurn(runId: string, ownerKey: string): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      state.spentInputTokens = null;
      state.spentOutputTokens = null;
      state.spentCacheReadTokens = null;
      state.spentCostUsd = null;
      state.spentEstimatedCostUsd = null;
      // Whatever the row still owed this owner — a figure a previous process
      // left before a restart — is the CLI's to bill on this turn's `result`
      // (it restores its own running total), so it comes down with the rest.
      this.spendStore.set(runId, ownerKey, null);
    } catch (err) {
      this.warn('startTurn', err);
    }
  }

  /**
   * Remember the window the CLI reported for this owner (from a `result` line).
   *
   * Kept per OWNER rather than per turn: the window belongs to the model, and
   * an owner's next turn is overwhelmingly the same model — so a turn's first
   * `assistant` line, which carries no window of its own, can still be scaled.
   *
   * True when the reading was taken as this owner's window — only when
   * {@link isOwnReading} says it is one.
   */
  rememberWindow(
    runId: string,
    ownerKey: string,
    contextWindowTokens: number | null,
    model: string | null = null,
    contextWindow: string | null = null,
  ): boolean {
    try {
      if (contextWindowTokens === null || contextWindowTokens <= 0) {
        return false;
      }
      if (!this.isOwnReading(runId, ownerKey, model)) {
        return false;
      }
      const owner = this.ownerId(runId, ownerKey);
      const announced = this.runModels.get(owner);
      this.windows.set(owner, contextWindowTokens);
      if (announced && model !== null) {
        this.windowsByModel.set(announced.key, contextWindowTokens);
        // Written through to disk so the NEXT daemon launch already knows this
        // model's window at the turn's first request, instead of relearning it
        // only when a turn finishes.
        this.windowStore.remember(
          announced.agent,
          announced.model,
          contextWindowTokens,
          contextWindow,
        );
      }
      return true;
    } catch (err) {
      this.warn('rememberWindow', err);
      return false;
    }
  }

  /**
   * Whether a reading labelled with `model` describes this owner's OWN
   * conversation. A delegate or a per-request fallback can out-spend the
   * owner's model, and `modelUsage` then names ITS window — which, taken as
   * the owner's, misreports the meter and moves the `--autocompact` threshold
   * that joins `sessionKey`. A reading naming no model, or an owner that has
   * announced none, cannot be told apart and is taken as the owner's.
   */
  isOwnReading(runId: string, ownerKey: string, model: string | null): boolean {
    const announced = this.runModels.get(this.ownerId(runId, ownerKey));
    return (
      model === null || announced === undefined || announced.model === model
    );
  }

  /**
   * The turn named the model it is running as — apply that model's window if
   * one has been seen before, so the meter is scaled from the FIRST request
   * rather than from the first completed turn.
   *
   * A window already remembered for THIS owner wins while the model is
   * unchanged: it came from this owner's own `result` line and so describes the
   * conversation on screen. A model CHANGE drops it — the composer's chips are
   * editable mid-run, so switching model between turns is a first-class flow,
   * and the previous model's window would otherwise scale the whole next turn.
   */
  useModel(
    runId: string,
    ownerKey: string,
    agent: AgentKind,
    model: string,
    contextWindow: string | null = null,
  ): void {
    try {
      const owner = this.ownerId(runId, ownerKey);
      const key = this.modelKey(agent, model, contextWindow);
      if (this.runModels.get(owner)?.key !== key) {
        this.runModels.set(owner, { key, agent, model });
        this.windows.delete(owner);
      }
      const known = this.modelWindow(agent, model, contextWindow);
      if (known !== null && !this.windows.has(owner)) {
        this.windows.set(owner, known);
      }
    } catch (err) {
      this.warn('useModel', err);
    }
  }

  /**
   * The window resolved for this owner — the denominator a DURABLE write needs.
   *
   * The same read {@link eventOf} puts on every live delta, so a conversation
   * reopened after a restart shows the fraction its live plane was already
   * showing rather than a count over nothing.
   *
   * An empty entry means nothing is knowable, and that is why there is no
   * second tier behind this one: {@link useModel} has already resolved cache →
   * store into this map, and falling back to the run's STORED window would
   * resurrect the previous model's during a switch — the same poisoning the
   * guard in {@link rememberWindow} exists to stop, reached from the other end.
   */
  windowFor(runId: string, ownerKey: string): number | null {
    return this.windows.get(this.ownerId(runId, ownerKey)) ?? null;
  }

  /**
   * The window a model id was last measured at, asked BEFORE a turn exists
   * (`firstTurnWindow`). The id is the one the CLI runs, so an alias is
   * resolved by the caller first. Never a figure derived from the window
   * CHOICE (`1m`): the choice is part of the key, and the number is whatever
   * the agent reported at it — codex's `872k` reports 828,400.
   */
  knownWindow(
    agent: AgentKind,
    model: string,
    contextWindow: string | null = null,
  ): number | null {
    return this.modelWindow(agent, model, contextWindow);
  }

  /**
   * A model's window, cache first. A miss falls through to the persisted store
   * — that is what makes the FIRST turn after a daemon launch scaled, rather
   * than the first turn to complete in this process.
   */
  private modelWindow(
    agent: AgentKind,
    model: string,
    contextWindow: string | null,
  ): number | null {
    const key = this.modelKey(agent, model, contextWindow);
    const cached = this.windowsByModel.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const stored = this.windowStore.get(agent, model, contextWindow);
    if (stored !== null) {
      this.windowsByModel.set(key, stored);
    }
    return stored;
  }

  /**
   * The per-model cache key, keyed by AGENT and by the turn's WINDOW CHOICE as
   * well — the exported one, so this in-memory half and the durable store
   * cannot spell it differently. See {@link contextWindowKey} for why all three
   * parts are load-bearing; the short version is that cursor's `kimi-k3` has
   * two real windows (200,000 and 1,048,576) and a key without the choice files
   * both under one entry.
   */
  private modelKey(
    agent: string,
    model: string,
    contextWindow: string | null,
  ): string {
    return contextWindowKey(agent, model, contextWindow);
  }

  /**
   * The (run, owner) key the window and model maps are filed under.
   *
   * NUL-joined like every other composite key in the daemon. A run id is a
   * UUID and an owner key is either the chat sentinel or a team member id, so
   * neither half can contain the byte and the pair cannot be re-partitioned.
   */
  private ownerId(runId: string, ownerKey: string): string {
    return `${runId}\u0000${ownerKey}`;
  }

  private stateOf(runId: string, ownerKey: string): LiveState {
    const byOwner = this.tails.get(runId) ?? new Map<string, LiveState>();
    this.tails.set(runId, byOwner);
    const state = byOwner.get(ownerKey) ?? newLiveState();
    byOwner.set(ownerKey, state);
    return state;
  }

  /**
   * Keep an owner's still-running delegates when its turn ends: a background
   * delegate outlives the turn that launched it, and every event for the owner
   * replaces the whole record it carries.
   */
  private retainDelegates(
    runId: string,
    ownerKey: string,
    state: LiveState,
  ): void {
    if (state.delegates.size === 0) {
      return;
    }
    const kept = newLiveState();
    kept.delegates = state.delegates;
    const byOwner = this.tails.get(runId) ?? new Map<string, LiveState>();
    byOwner.set(ownerKey, kept);
    this.tails.set(runId, byOwner);
  }

  /** Project the internal state onto the wire shape clients actually read. */
  private eventOf(
    runId: string,
    ownerKey: string,
    memberId: string | null,
    state: LiveState,
  ): RunDeltaEvent {
    // EVERY reasoning field is null while NOT reasoning — that is what hides
    // the indicator, and publishing them as one group is what stops a client
    // seeing a stretch id without the clock that belongs to it.
    const reasoning = this.isReasoning(state);
    return {
      runId,
      memberId,
      ownerKey,
      text: state.text,
      thinkingTokens: state.thinkingCurrent,
      // Null rather than '' when there is none, so "this CLI withholds its
      // thinking" and "this stretch has not produced a word yet" are the same
      // reading on the wire — neither has text to show.
      thinkingText: state.thinkingText === '' ? null : state.thinkingText,
      thinkingSince: reasoning ? state.thinkingSince : null,
      thinkingStretch: reasoning ? state.thinkingStretch : null,
      contextTokens: state.contextTokens,
      contextWindowTokens: this.windowFor(runId, ownerKey),
      spentInputTokens: state.spentInputTokens,
      spentOutputTokens: state.spentOutputTokens,
      spentCacheReadTokens: state.spentCacheReadTokens,
      spentCostUsd: state.spentCostUsd,
      spentEstimatedCostUsd: state.spentEstimatedCostUsd,
      composingTool: state.composingTool,
      // Null rather than 0 when nothing is being composed, so the pair reads as
      // one group the way the reasoning fields do: a client that sees a byte
      // count is looking at a live composition, never at the leftovers of one.
      composingBytes:
        state.composingTool === null ? null : state.composingBytes,
      ...(state.delegates.size > 0
        ? { delegates: Object.fromEntries(state.delegates) }
        : {}),
    };
  }

  /**
   * The durable item for this owner's current block has landed — drop the tail
   * and tell clients to stop showing it.
   *
   * ONLY a `message` retires: its caller gates on `mapped.kind === 'message'`
   * precisely so a tool call cannot wipe the tail of words the agent is still
   * writing. (The doc block here used to describe the opposite — a retire for
   * every persisted item — which the caller has never done.)
   *
   * The turn-scoped accounting SURVIVES: the stretch counter and the context
   * figure belong to the turn, not to one block of its text, and a turn
   * routinely lands several messages. `clearRun` is what ends the turn.
   */
  retire(runId: string, ownerKey: string, memberId: string | null): void {
    try {
      const state = this.tails.get(runId)?.get(ownerKey);
      if (!state) {
        return;
      }
      state.text = '';
      state.thinkingCurrent = null;
      state.thinkingText = '';
      state.composingTool = null;
      state.composingBytes = 0;
      this.publish(this.eventOf(runId, ownerKey, memberId, state));
    } catch (err) {
      this.warn('retire', err);
    }
  }

  /**
   * Whatever an owner streamed but never got a durable item for — the text to
   * persist as ONE partial-flagged message when a turn cancels or fails. The
   * tail is consumed, so a second call yields nothing and the flush can never
   * be written twice.
   */
  takeTail(
    runId: string,
    ownerKey: string,
    memberId: string | null,
  ): string | null {
    try {
      const state = this.tails.get(runId)?.get(ownerKey);
      const tail = state?.text ?? '';
      if (!state || !tail) {
        return null;
      }
      this.tails.get(runId)?.delete(ownerKey);
      this.retainDelegates(runId, ownerKey, state);
      this.spendStore.set(runId, ownerKey, null);
      // Announced, not merely forgotten. These words are about to be written as
      // a durable `partial` item; without an event saying the live copy is gone
      // the client keeps rendering it too, and the user reads the same
      // half-sentence twice — once as the tail they watched appear, once as the
      // row written to replace it.
      this.publish(
        this.eventOf(runId, ownerKey, memberId, {
          ...state,
          text: '',
          thinkingCurrent: null,
          thinkingText: '',
          composingTool: null,
          // The turn is over: see `retireCost`.
          spentCostUsd: null,
          spentEstimatedCostUsd: null,
        }),
      );
      return tail;
    } catch (err) {
      this.warn('takeTail', err);
      return null;
    }
  }

  /**
   * Every owner's CURRENT state for one run, as the events a client would
   * have received — what a client that has just joined the run's room is owed.
   *
   * A live event is published only when its figure CHANGES, and a room buffers
   * nothing for an absent member, so a client that opens a thread mid-turn
   * otherwise starts on an empty plane and stays there until the next change.
   * For the running spend that can be a long time: REPORTED as a team
   * header reading $1.71 after switching away and back, where it had read ~$40
   * — the recorded turns summed to exactly $1.71, and the rest was a callee's
   * unrecorded spend that no event repeated. REPLACE semantics make this safe
   * to send at any moment: each event is the whole of its owner's state.
   */
  snapshot(runId: string): RunDeltaEvent[] {
    try {
      const byOwner = this.tails.get(runId);
      if (!byOwner) {
        return [];
      }
      return [...byOwner].map(([ownerKey, state]) =>
        this.eventOf(runId, ownerKey, nodeIdOfOwner(ownerKey), state),
      );
    } catch (err) {
      this.warn('snapshot', err);
      return [];
    }
  }

  /**
   * Forget a whole run's live state (its turn settled, or the run is
   * terminal). This is the TURN boundary, so it is what resets the stretch
   * counter — the next turn starts counting its stretches from one.
   *
   * It ANNOUNCES the clear before forgetting it, one empty event per owner.
   * Deleting the state locally says nothing on the wire, so the client stayed
   * on whatever the last delta claimed: the words `takeTail` just handed to a
   * durable `partial` item rendered a second time as a live tail, and a
   * reasoning stretch that was open when the turn stopped kept a "Thinking…"
   * row whose clock ticked on under a settled chat. The whole point of
   * publishing the WHOLE tail is that the last event is authoritative — so
   * the last event has to be the empty one.
   *
   * The remembered context window deliberately survives: it describes the
   * model, not the turn, and the next turn's first `assistant` line needs it
   * before any `result` line could supply one.
   */
  clearRun(runId: string): void {
    try {
      this.spendStore.clearRun(runId);
      const byOwner = this.tails.get(runId) ?? new Map<string, LiveState>();
      this.tails.delete(runId);
      for (const [ownerKey, state] of byOwner) {
        this.publish(
          this.eventOf(runId, ownerKey, nodeIdOfOwner(ownerKey), {
            ...state,
            text: '',
            thinkingCurrent: null,
            thinkingText: '',
            composingTool: null,
            // The turn is over: see `retireCost`.
            spentCostUsd: null,
            spentEstimatedCostUsd: null,
          }),
        );
        this.retainDelegates(runId, ownerKey, state);
      }
      this.delegateSpend.flushRun(runId);
    } catch (err) {
      this.warn('clearRun', err);
    }
  }

  /**
   * Put back the outstanding spend a previous daemon persisted, so a client
   * opening any of these runs is handed it on join ({@link snapshot}) instead
   * of a header that reads the recorded total as the whole bill.
   *
   * Called once at boot, after the schema sync (`main.ts`), before any turn
   * can run. Nothing is published — no client is connected yet. Each figure
   * stays until its owner's next turn opens or the run's turn or pass ends:
   * the process that spent it is gone, and the CLI bills the money on that
   * session's next `result` if the conversation continues.
   */
  async rehydrateUnrecordedSpend(): Promise<void> {
    try {
      let seeded = 0;
      for (const [
        runId,
        { spend, estimates },
      ] of await this.spendStore.loadAll()) {
        for (const [ownerKey, costUsd] of spend) {
          const state = this.stateOf(runId, ownerKey);
          state.spentCostUsd = costUsd;
          state.spentEstimatedCostUsd = estimates.get(ownerKey) ?? null;
          seeded += 1;
        }
      }
      if (seeded > 0) {
        this.logger.log(`restored the outstanding spend of ${seeded} agent(s)`);
      }
    } catch (err) {
      this.warn('rehydrateUnrecordedSpend', err);
    }
  }

  /**
   * Drop everything remembered for a run — used when the run itself is gone.
   *
   * The per-MODEL windows survive: they describe models, not this run, and a
   * deleted chat is no reason for the next one to start guessing again.
   */
  forgetRun(runId: string): void {
    try {
      this.tails.delete(runId);
      // Swept by PREFIX, because these two are keyed per (run, owner) and a
      // team run has one entry per NODE. Deleting `runId` alone was correct
      // only while every run had exactly one owner; it now leaves a member's
      // window behind for the life of the process, which is a leak that no
      // later call can reach — the run it belongs to no longer exists.
      const prefix = this.ownerId(runId, '');
      for (const key of this.windows.keys()) {
        if (key.startsWith(prefix)) {
          this.windows.delete(key);
        }
      }
      for (const key of this.runModels.keys()) {
        if (key.startsWith(prefix)) {
          this.runModels.delete(key);
        }
      }
    } catch (err) {
      this.warn('forgetRun', err);
    }
  }

  private publish(event: RunDeltaEvent): void {
    this.bus.publishDelta(event);
  }

  private warn(where: string, err: unknown): void {
    this.logger.warn(
      `live stream ${where} failed (the durable transcript is unaffected): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The MEMBER an owner key belongs to — the key itself for a member's own turn, and
 * the part before `::` for a callee turn's per-call key.
 *
 * The two used to be the same string, and that is exactly what made a member's
 * concurrent calls share one reading: the last writer won, so a caller running
 * two of the same callee saw one ring flickering between two unrelated
 * conversations. The key is per CALL now and this is the one place the member is
 * read back out of it.
 */
export function ownerOfKey(ownerKey: string): string {
  const split = ownerKey.indexOf(OWNER_KEY_SEPARATOR);
  return split === -1 ? ownerKey : ownerKey.slice(0, split);
}

/**
 * Separator between a member id and the call id in a per-call owner key.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/live-text.ts` re-implements this
 * constant and both directions around it. The key rides `agent_delta`, which is
 * deliberately outside the generated HTTP contract, so the renderer has no
 * generated type to read it with — a change here MUST be mirrored there, or the
 * call threads' context rings blank with nothing failing to compile.
 */
export const OWNER_KEY_SEPARATOR = '::';

/** The live-plane owner key for one member's turn, or one of its CALL threads. */
export function partialOwnerKey(
  memberId: string,
  callId: string | null,
): string {
  return callId === null
    ? memberId
    : `${memberId}${OWNER_KEY_SEPARATOR}${callId}`;
}

/**
 * The `nodeId` an event for this owner carries: null for the chat's single
 * agent (the sentinel), else the member the key belongs to — a team member's own
 * id, or the member part of a CALLEE turn's `<nodeId>::<callId>`.
 */
function nodeIdOfOwner(ownerKey: string): string | null {
  return ownerKey === SINGLE_AGENT_NODE ? null : ownerOfKey(ownerKey);
}

/**
 * Add one part to a running total, where null means UNMEASURED on both sides.
 *
 * A null addend leaves the total exactly as it was — including null, so a turn
 * whose every request omitted a figure reports "not measured" rather than a
 * zero it never saw. A real number lands on a null total as itself, which is
 * what makes the first request start the count.
 *
 * A negative or non-finite part is DROPPED rather than added: these arrive from
 * another program's JSON, and one bad line must not make a turn's bill
 * decrease — a figure that goes backwards is read as a bug in geniro long
 * before anyone suspects the CLI.
 */
function addSpend(
  total: number | null,
  part: number | null | undefined,
): number | null {
  if (typeof part !== 'number' || !Number.isFinite(part) || part < 0) {
    return total;
  }
  return (total ?? 0) + part;
}

function newLiveState(): LiveState {
  return {
    text: '',
    thinkingStretch: 0,
    thinkingCurrent: null,
    thinkingText: '',
    thinkingSince: null,
    contextTokens: null,
    spentInputTokens: null,
    spentOutputTokens: null,
    spentCacheReadTokens: null,
    spentCostUsd: null,
    spentEstimatedCostUsd: null,
    composingTool: null,
    composingBytes: 0,
    delegates: new Map(),
  };
}

function sameFigures(a: DelegateFigures, b: DelegateFigures): boolean {
  return (Object.keys(a) as (keyof DelegateFigures)[]).every(
    (key) => a[key] === b[key],
  );
}
