import { Bot, Maximize2 } from 'lucide-react';
import { memo, useContext, useEffect } from 'react';

import { MemberAvatar } from '../components/member-avatar';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { formatExactUsd, formatTokens } from './agent-activity';
import {
  BlockRequest,
  BlockResult,
  BlockShell,
  type BlockStatus,
  BlockStatusIcon,
  blockStatusLabel,
  BlockTitle,
} from './block-shell';
import { formatElapsed, WorkingRow } from './live-row';
import { OlderMessagesControl } from './older-messages-control';
import { untrackedExplanation, untrackedSummary } from './run-status';
import { NestedThreadContext, SubagentDetailContext } from './subagent-context';
import {
  type SubagentFiguresView,
  subagentFiguresView,
  useSubagentLiveFigures,
} from './subagent-figures';
import { plural, shownMessages, SubagentMetaChips } from './subagent-meta';
import { taskProgress } from './task-payload';
import { TranscriptEntryView } from './transcript-entry';
import {
  type CardEntry,
  countTools,
  isCardEntry,
  type SubagentBlockEntry,
  subagentBlockStatus,
  subagentTitle,
  type TaskListEntry,
} from './transcript-groups';
import type { TranscriptNodeMeta } from './transcript-item';
import { DelegateConversationContext } from './use-delegate-pages';

function shellStatusOf(block: SubagentBlockEntry): BlockStatus {
  switch (subagentBlockStatus(block)) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    case 'stopped':
      return 'stopped';
    case 'untracked':
      return 'untracked';
    case 'running':
      return 'running';
  }
}

/**
 * Which cards a delegate's block must not hide.
 *
 * A render card — a findings report, a chart, a scorecard, a comparison, a
 * gallery — is the ONLY copy of what it says: the result the agent gets back
 * from those tools is a receipt, by design. A delegate's block is shut by
 * default, which is right for a conversation and wrong for this — shut, the
 * report becomes work the reader has to go looking for, a worse answer than the
 * unattributed row that filing it under the delegate replaced.
 *
 * A TASK LIST does not open one: nearly every delegate keeps a list, so
 * counting it would open every block and cost the fold its meaning. A WORKFLOW
 * card cannot reach a block's entries at all today (`buildWorkflowCards` runs
 * after `buildSubagentBlocks`), so its row states what it would mean rather
 * than what happens.
 *
 * A TABLE over `CardEntry['type']` rather than a switch, and that is the whole
 * point: `satisfies` makes a card kind added to the union fail HERE instead of
 * shipping a block that silently stays shut. Hand-spelling the kinds again is
 * exactly what {@link isCardEntry} was written to end — its own doc block
 * records the six readers that each used to spell them, where "every miss was
 * SILENT".
 */
const OPENS_BLOCK = {
  'task-list': false,
  findings: true,
  recommendations: true,
  chart: true,
  metrics: true,
  comparison: true,
  gallery: true,
  'browser-screenshot': true,
  artifact: true,
  // Never filed under a delegate — see the `action` arm of `groupTranscript`.
  action: false,
  workflow: true,
} as const satisfies Record<CardEntry['type'], boolean>;

/**
 * Which of those this delegate drew, in the order it drew them.
 *
 * Recursive on the same two nesting kinds {@link subagentTaskProgress} walks —
 * a card inside a nested block is hidden by THIS one being shut just as
 * thoroughly.
 *
 * The CARDS rather than a yes/no, because the block needs both answers from one
 * walk: whether to open, and — for the reader who shuts it again — what to say
 * on the closed header instead of nothing.
 */
function renderCards(entries: SubagentBlockEntry['entries']): CardEntry[] {
  const found: CardEntry[] = [];
  const walk = (list: SubagentBlockEntry['entries']): void => {
    for (const entry of list) {
      if (isCardEntry(entry)) {
        if (OPENS_BLOCK[entry.type]) {
          found.push(entry);
        }
        continue;
      }
      if (entry.type === 'turn-block' || entry.type === 'call-block') {
        walk(entry.entries);
      }
    }
  };
  walk(entries);
  return found;
}

/** What each card is called, where a sentence has to name one. */
const CARD_NOUN = {
  'task-list': 'a task list',
  findings: 'findings',
  recommendations: 'recommendations',
  chart: 'a chart',
  metrics: 'a scorecard',
  comparison: 'a comparison',
  gallery: 'a gallery',
  'browser-screenshot': 'a screenshot',
  artifact: 'a page',
  action: 'a button',
  workflow: 'a workflow',
} as const satisfies Record<CardEntry['type'], string>;

/**
 * What a SHUT block says it is holding.
 *
 * `defaultOpen` opens a block that drew a card, but the reader's own press
 * outranks it — and a reader who opened a running delegate and folded it away
 * again is the likeliest one to be looking for what it later reported. Without
 * this the closed header says only that some nested work exists, which is the
 * silence the whole change exists to end.
 *
 * Findings carry their COUNT because that is the figure a reader acts on; the
 * other four name themselves and a count of one chart says nothing.
 */
function renderCardSummary(cards: CardEntry[]): string | null {
  if (cards.length > 1) {
    return `drew ${cards.length} cards`;
  }
  const card = cards[0];
  if (card === undefined) {
    return null;
  }
  if (card.type === 'findings') {
    const found = card.report.findings.length;
    return `reported ${found === 1 ? '1 finding' : `${found} findings`}`;
  }
  return `drew ${CARD_NOUN[card.type]}`;
}

/**
 * How far the delegate is through its OWN task list, or null when it kept none.
 *
 * Read off the block's folded entries rather than the transcript, so it can only
 * ever describe rows this delegate actually produced — the same rule
 * {@link subagentSteps} follows, and the reason a delegate's list cannot leak
 * into the main agent's count or the other way round.
 */
function subagentTaskProgress(
  block: SubagentBlockEntry,
): { done: number; total: number } | null {
  const cards: TaskListEntry[] = [];
  const walk = (entries: SubagentBlockEntry['entries']): void => {
    for (const entry of entries) {
      if (entry.type === 'task-list') {
        cards.push(entry);
        continue;
      }
      if (entry.type === 'turn-block' || entry.type === 'call-block') {
        walk(entry.entries);
      }
    }
  };
  walk(block.entries);
  // The LAST card is the current list: each one already carries the fold of
  // every announcement before it.
  const tasks = cards.at(-1)?.tasks;
  if (tasks === undefined || tasks.length === 0) {
    return null;
  }
  const { done, total } = taskProgress(tasks);
  return { done, total };
}

/**
 * What is known about a delegate APART from what it said — the model it ran,
 * what it spent, and how long it took, as its CLI reports them.
 *
 * `factsStated` is the caller saying it has ALREADY printed them. The block
 * has: they sit on its header, where they are legible with the block still
 * shut, so repeating them under it is one reading printed twice a couple of
 * inches apart — the complaint this surface already has on record about its
 * context meter. The detail DIALOG has no header of its own, so there they are
 * the only statement of what this delegate ran on and what it cost, and are
 * always drawn.
 */
function SubagentFacts({
  block,
  factsStated,
}: {
  block: SubagentBlockEntry;
  factsStated: boolean;
}): React.JSX.Element | null {
  const view = subagentFiguresView(block, useSubagentLiveFigures(block.id));
  const facts = factsStated
    ? []
    : [
        ...(block.model === null ? [] : [block.model]),
        ...subagentSpendParts(
          view,
          subagentBlockStatus(block) === 'running' ? null : block.durationMs,
        ),
      ];
  if (facts.length === 0) {
    return null;
  }
  return (
    <p
      data-role="subagent-facts"
      className="m-0 text-[11px] text-muted-foreground">
      {facts.join(' · ')}
    </p>
  );
}

/**
 * What this delegate COST, as the words the header prints — its money, its
 * tokens and how long it ran.
 *
 * REPORTED as "in front of each agent i wanna see amount of tokens/costs/time",
 * against a transcript of collapsed delegate rows that said only
 * `general-purpose · 49 tools`, and then a second time when the tokens were
 * there but the money was not.
 *
 * **The money is APPROXIMATE and says so.** No CLI states a delegate's cost —
 * re-probed on claude 2.1.251, every channel describing a delegate carries
 * tokens and no dollars, and the turn's own price covers the main thread and
 * all of its delegates together. The daemon derives it instead, calibrating a
 * list-price table against what the CLI charged for that very turn; the `≈` is
 * the whole of what distinguishes it from the exact per-turn figures elsewhere
 * in this app, so it never renders without one.
 *
 * An empty list renders nothing at all: every CLI but claude reports none of
 * this, and a `— tokens` placeholder on every delegate row would be noise about
 * a blind spot the reader can do nothing with. A null cost drops out the same
 * way, which is the required reading — a delegate whose model this build cannot
 * price has an unknown cost, not a zero one.
 */
function subagentSpendParts(
  view: SubagentFiguresView,
  durationMs: number | null,
): string[] {
  const parts: string[] = [];
  if (view.requests !== null) {
    parts.push(plural(view.requests, 'request'));
  }
  const messages = shownMessages(view.messages);
  if (messages !== null) {
    parts.push(plural(messages, 'message'));
  }
  if (view.tokensProcessed !== null) {
    parts.push(`${formatTokens(view.tokensProcessed)} tokens processed`);
  }
  if (view.costUsd !== null) {
    parts.push(`≈${formatExactUsd(view.costUsd)}`);
  }
  if (durationMs !== null) {
    // `took` stays on the word, header included. A bare `2s` on a row that
    // already reads `3 requests · 26.1k tokens` is as easily read as an age —
    // "this happened 2s ago" — which is the one thing it does not mean, and it
    // is the same wording the detail dialog has always used.
    parts.push(`took ${formatElapsed(durationMs)}`);
  }
  return parts;
}

/**
 * Why a delegate's conversation is absent, when the daemon said why.
 *
 * Only for a block with NOTHING in it: a delegate that reported one line and
 * then stopped streaming is a different case, and pinning a caveat under real
 * content would call working output incomplete.
 */
function SubagentStepsMissing({
  block,
}: {
  block: SubagentBlockEntry;
}): React.JSX.Element | null {
  if (block.entries.length > 0) {
    return null;
  }
  // The daemon's own sentence when there is one, and it outranks the generic
  // line: "has not done anything yet" is a claim about the DELEGATE, and saying
  // it about one whose steps this CLI never streams reports geniro's blind spot
  // as the sub-agent sitting idle — which is how it read for a cursor delegate
  // that had just spent thirteen seconds working.
  //
  // The generic line is only for a delegate that has genuinely not spoken YET,
  // so it is withheld from one whose OWN result is here: a block carrying that
  // has demonstrably done something, and beside it the sentence is simply
  // false. It used to sit under a `Timeline` heading, where it read as "no
  // steps recorded"; the heading is gone (see {@link SubagentDetail}) and a
  // bare sentence has to be true on its own.
  //
  // `resultIsOwn` rather than `returned || result !== null`, which is what it
  // was: a backgrounded delegate's launch is acknowledged within the second,
  // so both of those are true before it has done anything at all — and the one
  // line explaining why the thread below is empty was suppressed on precisely
  // the delegates whose thread is empty for that reason.
  const line =
    block.stepsUnavailableReason ??
    (block.resultIsOwn ? null : 'This sub-agent has not done anything yet.');
  if (line === null) {
    return null;
  }
  return (
    <p
      data-role="subagent-steps-missing"
      className="m-0 text-[11px] text-muted-foreground">
      {line}
    </p>
  );
}

/**
 * That the delegate ENDED, for a block where nothing else would say so.
 *
 * REPORTED against a finished cursor delegate as "cursor agent doesn't seem to
 * have success message". Its body is the brief, the model, and the sentence
 * explaining that this CLI streams none of the delegate's steps — and not one
 * of those three changes when the work finishes, so a delegate that ran for a
 * minute and came back reads exactly like one that did nothing. What marks the
 * ending is a 14px check in the header, which is not where a reader who has
 * opened the block is looking.
 *
 * Deliberately narrow, and the condition is the whole argument: only a body
 * with NO entries and no result that is the delegate's OWN.
 * {@link SubagentBlockEntry.resultIsOwn} and not merely `result`, on that
 * field's own reading: a launch acknowledgement is the CLI answering the
 * launching call, not the delegate reporting, so a block showing one under
 * `Reply to the launching call` still has nothing in it that says the work
 * ended. A delegate that streamed its work
 * ends on that work, and one whose answer is printed ends on the answer —
 * stating it a second time there is the footer this thread already removed
 * once, for repeating what the header says better. This states what neither
 * says: nothing else in the body reports the outcome.
 *
 * The word comes from the block vocabulary's own table
 * ({@link blockStatusLabel}), never a literal here, so a delegate cut off by
 * Stop reads `cancelled` in the same sentence its header, its panel row and
 * the run badge use.
 */
function SubagentEnded({
  block,
  status,
}: {
  block: SubagentBlockEntry;
  status: BlockStatus;
}): React.JSX.Element | null {
  if (status === 'running' || block.entries.length > 0 || block.resultIsOwn) {
    return null;
  }
  return (
    <p
      data-role="subagent-ended"
      className="m-0 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <BlockStatusIcon status={status} className="size-3" />
      <span>Sub-agent {blockStatusLabel(status)}</span>
    </p>
  );
}

/**
 * One sub-agent's conversation, for the detail dialog the panel row and the
 * block's own control open.
 *
 * **There is no timeline half any more.** It was a second reading of the very
 * entries below it — one line per tool call, message and task move — sitting
 * above the thread it was derived from, and it is the first thing a reader had
 * to scroll past to reach the conversation they opened the dialog for. The
 * report was blunt about which of the two answers the question: "we dont need
 * timeline - we can check messages instead". With it went `subagentSteps` and
 * its step type: nothing else built one, and a folder left behind for a surface
 * that no longer exists is how a codebase grows a second, drifting truth.
 *
 * What remains is one section, so it carries no heading: `Conversation` over
 * the only thing in the dialog is a heading repeated as its own content, and
 * the dialog's title already names what this is.
 */
export function SubagentDetail({
  block,
  nodes,
  chatAgentName,
}: {
  block: SubagentBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <SubagentThread
        block={block}
        nodes={nodes}
        chatAgentName={chatAgentName}
      />
    </div>
  );
}

/**
 * The BODY of a sub-agent block — its request, its thread, its result.
 *
 * Exported because the detail dialog shows exactly this: the whole point of
 * the popup is that the delegate's conversation reads identically wherever it
 * is opened, and two renderings of one thread is how they come to differ.
 */
export function SubagentThread({
  block,
  nodes,
  chatAgentName,
  factsStated = false,
}: {
  block: SubagentBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
  /**
   * The caller's own chrome already states the model, the tokens and the
   * duration.
   */
  factsStated?: boolean;
}): React.JSX.Element {
  const title = subagentTitle(block);
  // ONE reading for both the live row and the ending below it, so the thread
  // can never show a spinner and a "completed" line at once — and the same
  // reading the header's own status uses.
  const status = shellStatusOf(block);
  const working = status === 'running';
  return (
    <NestedThreadContext.Provider value={true}>
      <DelegateWindow block={block} />
      {block.prompt ? (
        <BlockRequest
          label={`Task for ${title}`}
          text={block.prompt}
          memoryKey={`subagent:${block.id}:request`}
        />
      ) : null}
      <SubagentFacts block={block} factsStated={factsStated} />
      {/* Above the (empty) thread rather than below the result: it explains why
          there is nothing between here and there, and a caveat placed after the
          result reads as a caveat ABOUT the result. */}
      {status !== 'untracked' || block.stepsUnavailableReason !== null ? (
        <SubagentStepsMissing block={block} />
      ) : null}
      {block.entries.map((entry) => (
        <TranscriptEntryView
          key={entry.type === 'item' ? entry.item.id : entry.id}
          entry={entry}
          nodes={nodes}
          chatAgentName={chatAgentName}
        />
      ))}
      {/*
        The same live row the main flow ends on, for a delegate that is still
        going. Without it a sub-agent's thread — and the popup that shows the
        same thread at full width — simply stopped at whatever it last said,
        with nothing telling a delegate that is thinking apart from one that has
        wedged. The header's spinner says it is running; this says the same
        thing where the reader is actually looking, and carries the clock.

        `lastRowAt` rather than mount time, exactly as the main flow's does:
        reopening the popup would otherwise restart the count and report a
        four-minute wait as one second.

        It carries no PHRASE — see `WorkingRow`, which stands the activity down
        inside a nested thread because the run's phrase belongs to the parent.
      */}
      {working ? <WorkingRow since={block.lastRowAt} /> : null}
      {block.result ? (
        <BlockResult
          memoryKey={`subagent:${block.id}:result`}
          // Whose answer this is, said in the heading — see
          // `SubagentBlockEntry.resultIsOwn`. A backgrounded delegate's call is
          // answered with a launch acknowledgement while the work is still to
          // come, and calling that "Result from X" beside a spinner reporting X
          // as working is the card contradicting itself in two inches.
          label={
            block.resultIsOwn
              ? `Result from ${title}`
              : 'Reply to the launching call'
          }
          text={block.result}
        />
      ) : null}
      {status === 'untracked' ? (
        <p
          data-role="subagent-untracked"
          className="m-0 flex items-center gap-1.5 text-[11px] text-warning">
          <BlockStatusIcon status={status} className="size-3" />
          <span>{untrackedExplanation(block.processEnded)}</span>
        </p>
      ) : (
        <SubagentEnded block={block} status={status} />
      )}
      {/*
        No footer beyond that one line. It used to close every delegate's
        thread with `<title> is
        working...` and `N tools` — both of which the header directly above
        already says, and says better: the status is a spinner and a chip, the
        tool count is a chip, and both are legible with the block still closed.
        Repeating them under the thread put the delegate's NAME back on screen a
        third time, in the place a reader is looking for what it produced. The
        call block keeps its own footer, which heads no such header.
      */}
    </NestedThreadContext.Provider>
  );
}

/**
 * The sentence naming how many of the delegate's tool calls the card holds, or
 * null once it holds all the daemon counts. Held rows include the calls a card
 * hides, so a finished delegate with a report card never reads as truncated.
 */
function windowNoteOf(block: SubagentBlockEntry): string | null {
  const daemon = block.durableToolCalls;
  const held = block.heldToolCalls;
  if (daemon === undefined || held === undefined || daemon <= held) {
    return null;
  }
  return `Showing the last ${held} of ${daemon} tool calls`;
}

/**
 * The delegate's own earlier steps, read on demand — see `useDelegatePages`.
 *
 * Mounted in the thread, so the card reads the delegate's rows when it opens and
 * the panel when it opens; both name the same loader entry, which is read once.
 */
function DelegateStepsPager({
  delegateId,
}: {
  delegateId: string;
}): React.JSX.Element | null {
  const loader = useContext(DelegateConversationContext);
  useEffect(() => {
    loader?.load(delegateId, false);
  }, [loader, delegateId]);
  const state = loader?.stateOf(delegateId) ?? null;
  if (loader === null || state === null) {
    return null;
  }
  if (state.failed) {
    return (
      <div
        role="status"
        data-slot="delegate-steps-failed"
        className="flex h-6 items-center gap-1.5 text-xs text-muted-foreground">
        Couldn’t load this sub-agent’s steps.
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => loader.retry(delegateId)}>
          Retry
        </Button>
      </div>
    );
  }
  if (state.loading && !state.hasOlder) {
    return (
      <div
        role="status"
        data-slot="delegate-steps-loading"
        className="flex h-6 items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner />
        Loading steps…
      </div>
    );
  }
  if (!state.hasOlder) {
    return null;
  }
  return (
    <OlderMessagesControl
      slot="delegate-steps-older"
      loading={state.loading}
      label="Show earlier steps"
      loadingLabel="Loading earlier steps…"
      onLoad={() => loader.load(delegateId, true)}
    />
  );
}

/**
 * The note naming the calls the delegate's rows hold, and the pager that reads
 * the rest. Drawn by {@link SubagentThread}, so the card and the detail panel
 * show the same two rows over the same loader.
 */
function DelegateWindow({
  block,
}: {
  block: SubagentBlockEntry;
}): React.JSX.Element {
  const windowNote = windowNoteOf(block);
  return (
    <>
      {windowNote === null ? null : (
        <p
          data-slot="subagent-window-note"
          className="m-0 rounded-md border border-dashed border-border px-2 py-1 text-[11px] text-muted-foreground">
          {windowNote}
        </p>
      )}
      <DelegateStepsPager delegateId={block.id} />
    </>
  );
}

/**
 * One background sub-agent as a collapsed aside in the conversation.
 *
 * Drawn on the same {@link BlockShell} as the agent-call block, and closed by
 * default unless it holds a card {@link OPENS_BLOCK} names — which is the
 * difference that matters. A delegate's run of work is
 * not part of the conversation the reader is having; it is a thing that
 * happened underneath it. Open, it shows exactly the thread the detail dialog
 * shows, which is exactly the thread the main flow renders — one
 * {@link TranscriptEntryView} pass, so a delegate's messages, tool groups and
 * reasoning look the way they look anywhere else.
 */
export const SubagentBlock = memo(function SubagentBlock({
  block,
  nodes,
  chatAgentName,
}: {
  block: SubagentBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
}): React.JSX.Element {
  const openDetail = useContext(SubagentDetailContext);
  const view = subagentFiguresView(block, useSubagentLiveFigures(block.id));
  const title = subagentTitle(block);
  const toolCount = block.durableToolCalls ?? countTools(block.entries);
  const tasks = subagentTaskProgress(block);
  const cards = renderCards(block.entries);
  const cardSummary = renderCardSummary(cards);
  const status = shellStatusOf(block);
  const untracked = status === 'untracked';
  const running = status === 'running';
  return (
    <div data-role="subagent-block" data-subagent={block.id} className="w-full">
      <BlockShell
        eyebrow="Sub-agent"
        eyebrowIcon={<Bot aria-hidden="true" className="size-3" />}
        status={status}
        statusTitle={
          untracked ? untrackedExplanation(block.processEnded) : undefined
        }
        collapsible
        memoryKey={`subagent:${block.id}`}
        defaultOpen={cards.length > 0}
        summary={
          cardSummary !== null ? (
            <span data-slot="subagent-card-summary">{cardSummary}</span>
          ) : untracked ? (
            <span data-slot="subagent-untracked-summary">
              {untrackedSummary(block.processEnded)}
            </span>
          ) : undefined
        }
        toggleLabel={`Show ${title}'s conversation`}
        header={
          <>
            {/* `sm` — a 20px disc rather than 32px. At the old size the avatar
                set the height of the whole header, so a closed delegate was a
                44px band for one line of text. It is still the thing that tells
                two parallel delegates apart at a glance, which is why it is
                shrunk rather than dropped. */}
            <MemberAvatar name={title} colorKey={block.id} size={20} />
            <BlockTitle>{title}</BlockTitle>
            {/* Every fact about the delegate as ONE run of text with middots,
                not a span per fact that the header's `gap-2` pushes apart. They
                answer one question — what this delegate is and what it did —
                and spaced out they read as unrelated chips.

                Interleaved from a LIST rather than by a separator condition per
                pair: at three facts that was already three conditions naming
                each other, and adding the tokens and the duration would have
                made it six, each of which is a place for a leading or doubled
                middot to appear on some combination nobody thought to check. */}
            {/* SHRINKABLE, and capped, which the title's own `flex-1 basis-0`
                cannot do for itself: every other child of this row is
                unshrinkable, so an unshrinkable fact run left `BlockTitle` the
                only thing that could give way — and the name is the one thing
                that tells two parallel delegates apart, so it was the first to
                go. The run has grown to six facts, and past the cap it clips
                its own tail (the task progress, which the card's
                `overflow-hidden` was clipping anyway) instead of taking the
                name with it. */}
            {/* WHAT KIND of delegate, and nothing else.
                The run used to carry six facts — kind, model, tools, cost,
                tokens, duration, task progress — and REPORTED as breaking the
                header, because on a card this narrow they do not fit one line
                and the only thing that could give way was the delegate's own
                name. Every measured figure has moved to `SubagentMetaChips` in
                `headerAction`, which is outside this shrinkable run entirely;
                the model went with them, as asked. What stays is the one fact
                that IDENTIFIES this delegate rather than measuring it.

                A real KIND still wins. The MODEL is the fallback for a row
                with no kind — an untyped delegation still names a model, and
                that is the only identity such a row has left; the model is
                otherwise held back for `headerAction`'s popover alone, so this
                is deliberately the one place it is shown unhovered. */}
            {(block.kind ?? block.model) && block.label ? (
              <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden text-[10px] text-muted-foreground">
                {block.kind ?? block.model}
              </span>
            ) : null}
          </>
        }
        // A real <button>, and it sits BESIDE the disclosure rather than
        // inside it: interactive content nested in a <button> is invalid HTML
        // whatever role it carries, and a control there also swallows presses
        // meant for the toggle.
        headerAction={
          <span className="flex items-center gap-1.5">
            {/* The figures, as one small block with the long form behind a
                hover. HERE rather than in the header run because that run is
                the disclosure's own <button>, and a popover trigger inside one
                is invalid HTML — the same rule this slot exists for. */}
            <SubagentMetaChips
              title={title}
              model={block.model}
              view={view}
              durationMs={block.durationMs}
              running={running}
              toolCount={toolCount}
              tasks={tasks}
            />
            {openDetail ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0 text-muted-foreground"
                aria-label={`Open ${title} in a panel`}
                title="Open this sub-agent's conversation"
                onClick={() => openDetail(block)}>
                <Maximize2 className="size-3 shrink-0" />
              </Button>
            ) : null}
          </span>
        }>
        <SubagentThread
          block={block}
          nodes={nodes}
          chatAgentName={chatAgentName}
          // The header above states them — see {@link SubagentFacts}.
          factsStated
        />
      </BlockShell>
    </div>
  );
});
