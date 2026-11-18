import { createContext, useContext, useEffect, useState } from 'react';

import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import { formatTokens } from './agent-activity';
import { ComposingCard, formatComposedBytes } from './composing-card';
import type { GeniroCardKind } from './geniro-tool';
import { THINKING_WORDS, useLiveWord, WORKING_WORDS } from './live-words';
import { MessageBubble } from './message-bubble';
import { NestedThreadContext } from './subagent-context';
import { ThinkingScroller } from './thinking-block';
import type { RunSettleAt } from './transcript-groups';

/**
 * What the active run is doing right now — the daemon's own `run_status`
 * activity, the same sentence the sidebar badge carries.
 *
 * A context rather than a prop, for the reason `AttachmentLoaderContext` is
 * one: the shells between `Chats` and this row are memoized on referentially
 * stable props, and threading a string that changes mid-turn through every one
 * of them would defeat that memoization. Null outside a provider, and null
 * while the daemon has not said — the row then names the state alone.
 */
export const RunActivityContext = createContext<string | null>(null);

/**
 * Whether the active run has reached a terminal status — nothing more is
 * coming for it.
 *
 * The transcript alone cannot answer this, and that gap is the bug it exists to
 * close: a tool row spins while its `tool_result` is missing, and a result the
 * daemon dropped between turns never arrives, so a run whose header read
 * `completed` kept a sub-agent row spinning indefinitely. Authoritative run
 * state is the only thing that can retire it — the same rule the live rows
 * already follow.
 *
 * A context for the reason {@link RunActivityContext} is one: the shells
 * between `Chats` and a tool group are memoized, and a prop that flips once at
 * the end of a run would defeat that for every row. Null outside a provider,
 * which is the safe reading — a group with no run behind it keeps whatever its
 * own pairs say.
 *
 * It carries WHEN the run settled ({@link RunSettleAt}) rather than merely THAT
 * it did, because a reader has to be able to ask whether a given piece of
 * nested work has spoken SINCE. A delegate producing rows after the run row went `completed`
 * is still working, however plainly that row says otherwise, and a bare boolean
 * could not express the difference: it painted every unreturned delegate in the
 * chat `stopped` at once. Measured on the author's own `geniro.db` — run
 * `f42bfe2d` took 1346 further delegate rows after the item that settled it.
 * A reader that only needs the fact asks `!== null`.
 */
export const RunSettledContext = createContext<RunSettleAt>(null);

/**
 * The two synthetic transcript rows that describe what an agent is doing RIGHT
 * NOW: a reasoning stretch, and the silence between one thing and the next.
 *
 * They own their own clock rather than being handed an elapsed number, and that
 * is the whole reason they are components at all. The elapsed time used to be
 * computed inside the transcript fold, from `Date.now()` at render — so it only
 * advanced when a delta happened to arrive, which is why the counter visibly
 * jumped (30s → 34s) instead of counting seconds. A row that ticks itself
 * advances every second, and re-renders nothing but itself.
 */

/**
 * Marks a synthetic transcript row as one of the two LIVE-state rows rather
 * than words on their way to becoming durable.
 *
 * Both ride the `reasoning` item kind — already styled as the muted aside they
 * are — and this field is what tells them apart at the render site, so neither
 * needed a new entry type threading through every switch of the fold. The
 * numbers ride raw for the same reason the rows tick themselves: an elapsed
 * time baked into the fold only advances when a delta happens to arrive.
 *
 * It lives HERE rather than beside the fold that writes it so the writer and
 * the reader can both depend on it without depending on each other.
 */
export type LiveRowKind = 'thinking' | 'working' | 'composing';

/** Read the live-row marker off a synthetic item's payload, or null. */
export function liveRowKind(payload: unknown): LiveRowKind | null {
  if (payload && typeof payload === 'object' && 'live' in payload) {
    const value = (payload as { live: unknown }).live;
    if (value === 'thinking' || value === 'working' || value === 'composing') {
      return value;
    }
  }
  return null;
}

/**
 * Re-render once a second, so an elapsed readout counts real seconds.
 *
 * Exported for the agents panel's running-shell rows, which own their clock for
 * the same reason these rows do (see below): a ticking number handed down as a
 * prop re-renders whatever holds it, and the panel's holder is the whole run.
 */
export function useSecondsTick(): void {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);
}

/**
 * `12s`, `1m 5s`, `2h 8m 57s` — the elapsed form both rows read.
 *
 * The hours tier is the whole of a report, and the header is where it showed:
 * `worked 128m 57s / 14 turns`. Minutes were unbounded, so a thread's summed
 * working time — and a long thinking stretch, and a delegate's `took` — kept
 * counting past the point where anyone reads a minute count as a duration.
 * Nobody divides 128 by 60 to find out they have spent two hours.
 *
 * `stats/stats-format.ts` has had an hours-aware `formatDuration` since the
 * Stats page shipped, which is what made this one's absence a genuine
 * inconsistency rather than a missing feature: the same span read `2h 8m` on
 * one screen and `128m 57s` on another. The two do NOT merge, and the reason is
 * their precision: that one rounds to whole minutes, for totals nobody reads to
 * the second, while this one drives a clock that reticks every second and would
 * visibly freeze without them.
 *
 * There is deliberately no DAY tier. Hours stay unbounded, so a thread that
 * worked a full day reads `25h 3m 40s` — long, legible, and one unit rather
 * than a fourth case nothing in the app has yet produced.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

/**
 * One reasoning stretch: what the agent is thinking, or — where its CLI will
 * not say — how much that thinking has cost, and for how long either way.
 *
 * Everything here is per STRETCH. A turn that thinks, runs tools, then thinks
 * again is two separate waits, and each gets its own row — the daemon's
 * stretch id is what keys them apart, so a new stretch mounts a fresh
 * component with a clock starting at zero.
 *
 * TWO SHAPES, because the CLIs genuinely differ and neither reading can stand
 * in for the other. Where the CLI sends only a running token total (claude
 * until its first summary chunk lands), the row is a one-line note. Where it
 * sends the words, showing them is the whole point: the row is then the
 * same muted italic bubble the durable `reasoning` item becomes, so the text a
 * user watches appear and the text that lands are one thing rendered one way.
 *
 * Reported as a chat that sat on `Working…` for three minutes with nothing
 * happening — while thought chunks were arriving the entire time, buffered by
 * the driver and shown only when the block closed.
 */
export function ThinkingRow({
  since,
  tokens,
  text = null,
}: {
  /** Epoch ms this stretch began. */
  since: number;
  /** Reasoning tokens spent in this stretch so far. */
  tokens: number;
  /** What the agent is thinking, when its CLI discloses it. */
  text?: string | null;
}): React.JSX.Element {
  useSecondsTick();
  const elapsed = formatElapsed(Date.now() - since);
  // The rotating vocabulary — see `live-words.ts`. It opens on the plain
  // `Thinking`, so a short stretch and every existing spec read exactly as
  // before, and only a wait long enough to be worth watching wanders.
  const word = useLiveWord(THINKING_WORDS);
  if (text === null) {
    return (
      <LiveRow
        text={`${word}… ${formatTokens(tokens)} tokens`}
        word={word}
        elapsed={elapsed}
      />
    );
  }
  return (
    <MessageBubble variant="reasoning" role="thinking">
      {/* BOUNDED and following its own tail — see `ThinkingScroller`. A cursor
          stretch runs to thousands of words, and unbounded it pushed the
          answer, the tool rows and the composer off the screen while it was
          still being written. */}
      <ThinkingScroller text={text} />
      {/* The state line the durable row does not need: this text is still
          being written, and without the spinner and the clock a stretch that
          goes quiet is indistinguishable from one that finished. */}
      <div className="text-muted-foreground mt-1.5 flex items-center gap-1.5 text-xs not-italic">
        <Spinner />
        <span>
          <span key={word} className="live-word">
            {word}…
          </span>{' '}
          · {elapsed}
        </span>
      </div>
    </MessageBubble>
  );
}

/**
 * The model is WRITING one of geniro's own card tools — the wait between
 * deciding to draw something and the card arriving.
 *
 * A component of its own rather than another `LiveRow` shape, because what it
 * shows is not a line of text: it is the silhouette of the card that is coming
 * (`ComposingCard`). Its whole body lives there; this is only the placement.
 *
 * It carries NO CLOCK, unlike its two siblings, and that is deliberate rather
 * than an omission. Those rows count a silence nobody can otherwise see; this
 * one has a better reading — how many bytes of the call have been written,
 * which climbs, is specific to the work, and is the only thing on screen that
 * can distinguish a model still producing from one that has stopped.
 */
export function ComposingRow({
  kind,
  bytes = null,
}: {
  kind: GeniroCardKind;
  bytes?: number | null;
}): React.JSX.Element {
  return (
    <MessageBubble variant="live" className="w-full">
      <ComposingCard kind={kind} bytes={bytes} />
    </MessageBubble>
  );
}

/**
 * The agent is working but has nothing to show for it yet — between a tool
 * batch finishing and the next words or reasoning delta arriving.
 *
 * Without this the transcript went silent for those stretches and the only
 * signal left was the status in the chat header, which is not where the user is
 * looking.
 *
 * It NAMES what the agent is doing whenever the daemon has said. "Working…"
 * and an elapsed clock describe a state without describing the work, which is
 * the complaint this answers: an abstract label leaves the user unable to tell
 * a long compaction from a hung tool. The clock stays either way — it is the
 * half of the row the daemon cannot supply.
 *
 * {@link since} is read out of the TRANSCRIPT (the last row this agent put on
 * screen), not from this component's mount. The clock used to start at mount, on
 * the reasoning that "how long this has been quiet" needs no state threaded
 * through the fold — true of the number, false of the ANSWER: every remount
 * restarted it, so switching to another chat and back reported a four-minute
 * wait as one second. Same defect, and the same fix, as the header's own clock
 * (`ChatHeader`'s `turnStartedAt`), which is why both now take a timestamp their
 * caller derived from durable rows. Mount time remains the fallback for an agent
 * with no durable row yet, where it is the only anchor there is and is right.
 */
export function WorkingRow({
  since = null,
  spend = null,
  writing = null,
}: {
  /** Epoch ms this agent last showed something, or null if it never has. */
  since?: number | null;
  /** This turn's running token bill, formatted, or null when unmeasured. */
  spend?: string | null;
  /**
   * The tool call the agent is WRITING right now and how many argument bytes
   * have arrived, or null when it is not writing one worth naming.
   */
  writing?: { tool: string; bytes: number } | null;
}): React.JSX.Element {
  const [mountedAt] = useState(() => Date.now());
  const runActivity = useContext(RunActivityContext);
  // A delegate's own thread does NOT get the run's activity phrase. The run's
  // is the PARENT's — "running Agent" for the very delegation this block is —
  // so printing it inside the block would have the delegate report its own
  // launch as the work it is doing. Nested, the honest reading is the state and
  // the clock, which is what the row said before any phrase existed.
  const nested = useContext(NestedThreadContext);
  const activity = nested ? null : runActivity;
  useSecondsTick();
  // The rotating vocabulary stands in ONLY for the standing fallback. The
  // daemon's own activity is a real answer, and a real answer always beats a
  // decorative one: the whole reason the activity announce exists is that an
  // abstract label leaves a reader unable to tell a long compaction from a hung
  // tool.
  const word = useLiveWord(WORKING_WORDS);
  // A call being written outranks the daemon's activity: that phrase names a
  // tool that already RAN, while this is the work happening now, and its byte
  // count is the one figure on the row that shows the model still producing.
  const phrase = writing === null ? activity : `Writing ${writing.tool}`;
  return (
    <LiveRow
      text={phrase ?? `${word}…`}
      // Named only when the row IS the word, so the fade is played on a change
      // of vocabulary and never on a tool name the daemon happened to update.
      word={phrase === null ? word : null}
      progress={writing === null ? null : formatComposedBytes(writing.bytes)}
      elapsed={formatElapsed(Date.now() - (since ?? mountedAt))}
      spend={spend}
    />
  );
}

/**
 * The shell both rows share — bubble, spinner, label. Split out so a change to
 * the chrome cannot land on one live row and not the other.
 *
 * It wears the `live` variant: small and quiet like the transcript's `note`
 * chrome, and LEFT-ALIGNED like the agent's own column. Neither row is the
 * agent speaking — both are geniro narrating the state of a turn — which is
 * why they are not a filled assistant bubble; but they are the agent's column
 * still filling, followed by the very bubble they turn into, and centring them
 * detached that. REPORTED against exactly this: the progress of a turn was the
 * one thing on screen not aligned with the turn. The spinner is what the
 * typography alone cannot say: this line is about work still running, so it
 * will change.
 *
 * Deliberately WITHOUT `MessageBubble`'s `role` caption. These two rows are the
 * only ones whose body already names the state they are in, so the caption
 * printed the word a second time — a row reading "THINKING" over
 * "Thinking… 250 tokens · 12s". Every other bubble needs the caption because
 * its body is the agent's own words and says nothing about what kind of row it
 * is.
 *
 * The two halves are SEPARATE spans because only one of them can be truncated.
 * {@link text} is whatever the daemon says the run is doing, and that phrase is
 * `running <tool name>` — where a shell tool's "name" is the WHOLE command the
 * agent is running. Reported verbatim: a `cd … && git checkout --ours <60 paths>`
 * filled eight wrapped lines of the transcript, and even a one-line one ran the
 * full width of the column. So the phrase is capped and ellipsized (the full
 * text stays on the `title`), while the clock beside it — the half nothing can
 * make long — is never cut, which is exactly what a single truncated label
 * could not express.
 */
function LiveRow({
  text,
  word = null,
  progress = null,
  elapsed,
  spend = null,
}: {
  /** What is happening — arbitrary length, so this is the half that gives way. */
  text: string;
  /**
   * The rotating word, when {@link text} IS one — the key the fade is played
   * on.
   *
   * Null whenever the row is showing a real phrase instead (the daemon's
   * activity, a call being waited on), so re-keying can never re-animate a
   * line that merely had its tool name updated.
   */
  word?: string | null;
  /**
   * How far the work {@link text} names has got (`84.2 KB`), or null. Never
   * cut, like the clock: it is the half of the phrase that moves.
   */
  progress?: string | null;
  /** The clock, always shown in full. */
  elapsed: string;
  /**
   * What this turn has spent so far, already formatted, or null when nothing
   * has reported.
   *
   * NULL IS THE COMMON CASE and must draw nothing: cursor reports no token
   * accounting a client can reach, so half the app's agents will never fill
   * this. A `0` in its place would be a figure nobody measured, on the row
   * whose whole job is to say what is happening right now.
   */
  spend?: string | null;
}): React.JSX.Element {
  return (
    // `w-full` so the cap below has a definite width to be a fraction OF: the
    // bubble is otherwise shrink-to-fit, against which a percentage max-width
    // resolves to nothing at all.
    <MessageBubble variant="live" className="live-row-in w-full">
      {/* No italic: the row it must look like is the plain note beside it
          ("✓ done · $1.3306"), and an italic of its own made it a different
          kind of thing. The spinner is the only difference the state earns. */}
      <div className="flex min-w-0 items-center justify-start gap-1.5">
        <Spinner />
        <span
          // Half the row was the cap while the row was CENTRED, where the
          // phrase had the clock and the spend crowding it from both sides.
          // Left-aligned it has the rest of the column, and a tool name is the
          // thing a reader most wants to see in full — so it gives way later,
          // and only to keep the figures on the line.
          key={word ?? undefined}
          className={cn(
            'max-w-[70%] truncate',
            word === null ? undefined : 'live-word',
          )}
          title={text}>
          {text}
        </span>
        {progress === null ? null : (
          <span data-slot="live-row-progress" className="shrink-0 tabular-nums">
            · {progress}
          </span>
        )}
        <span className="shrink-0">· {elapsed}</span>
        {/* AFTER the clock, and `shrink-0` like it: the phrase is the only
            part of this row allowed to give way, so a long activity name
            truncates rather than pushing the figures off. */}
        {spend === null ? null : (
          <span data-slot="live-row-spend" className="shrink-0 tabular-nums">
            · {spend}
          </span>
        )}
      </div>
    </MessageBubble>
  );
}
