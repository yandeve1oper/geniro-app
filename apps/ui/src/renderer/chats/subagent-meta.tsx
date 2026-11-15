import {
  ArrowLeftRight,
  CircleDollarSign,
  Coins,
  ListChecks,
  MessageSquare,
  Timer,
} from 'lucide-react';

import { HoverPopover } from '../components/hover-popover';
import { formatExactUsd, formatTokens } from './agent-activity';
import { formatElapsed } from './live-row';
import type { SubagentFiguresView } from './subagent-figures';
import { TaskCount } from './task-list';

function MetaChip({
  icon,
  children,
  slot,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  slot: string;
}): React.JSX.Element {
  return (
    <span
      data-slot={slot}
      className="flex shrink-0 items-center gap-0.5 tabular-nums">
      {icon}
      {children}
    </span>
  );
}

function DetailRow({
  label,
  value,
  indent = false,
}: {
  label: string;
  value: React.ReactNode;
  indent?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={
        indent
          ? 'flex items-baseline justify-between gap-4 pl-3'
          : 'flex items-baseline justify-between gap-4'
      }>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Zero is no figure: a delegate that measured no messages states none. */
export function shownMessages(messages: number | null): number | null {
  return messages === null || messages === 0 ? null : messages;
}

/** The line under the popover's figures that says what they are, when one is needed. */
function figureHint({
  legacy,
  running,
  costUsd,
  tokensProcessed,
}: {
  legacy: boolean;
  running: boolean;
  costUsd: number | null;
  tokensProcessed: number | null;
}): string | null {
  if (legacy) {
    return 'Recorded before requests and tokens were counted for sub-agents.';
  }
  if (costUsd === null && tokensProcessed !== null) {
    return 'No price is known for this model.';
  }
  if (running && costUsd !== null) {
    return 'Cost is an estimate at list price; corrected when the turn ends.';
  }
  return null;
}

/**
 * What a delegate spent, as icon chips with the long form behind a hover.
 *
 * Every figure comes from {@link SubagentFiguresView}; a figure nothing measured
 * is absent, never zero. It sits in `headerAction`, never inside the disclosure
 * button, which is itself a `<button>`.
 */
export function SubagentMetaChips({
  title,
  model,
  view,
  durationMs,
  running,
  toolCount,
  tasks,
}: {
  /** The delegate's own name, so the popover says what it is describing. */
  title: string;
  model: string | null;
  view: SubagentFiguresView;
  /** How long it took; the plate states it once the delegate has finished. */
  durationMs: number | null;
  running: boolean;
  toolCount: number;
  tasks: { done: number; total: number } | null;
}): React.JSX.Element | null {
  const { requests, tokensProcessed, costUsd, contextTokens } = view;
  const messages = shownMessages(view.messages);
  // An old row's one token figure is the last request's, never a total.
  const legacy = view.contextAtEnd !== null;
  const took = running ? null : durationMs;
  const hasAny =
    requests !== null ||
    messages !== null ||
    tokensProcessed !== null ||
    costUsd !== null ||
    took !== null ||
    tasks !== null;
  if (!hasAny) {
    return null;
  }
  const hint = figureHint({ legacy, running, costUsd, tokensProcessed });
  // The accessible name carries the whole reading, so nothing here is reachable
  // only by opening the panel — the rule `HoverPopover`'s own `label` states.
  // Live ticks are not announced: nothing on the plate is an `aria-live` region.
  const spoken = [
    model === null ? null : `model ${model}`,
    requests === null ? null : plural(requests, 'request'),
    messages === null ? null : plural(messages, 'message'),
    tokensProcessed === null
      ? null
      : `${formatTokens(tokensProcessed)} tokens processed`,
    costUsd === null ? null : `about ${formatExactUsd(costUsd)}`,
    took === null ? null : `took ${formatElapsed(took)}`,
    tasks === null ? null : `${tasks.done} of ${tasks.total} tasks done`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
  return (
    <HoverPopover
      slot="subagent-meta"
      label={`${title}: ${spoken}`}
      panelLabel={`What ${title} spent`}
      side="bottom"
      align="end"
      triggerClassName="rounded-md"
      panelClassName="min-w-56"
      trigger={
        <span
          data-slot="subagent-meta-chips"
          className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {requests === null ? null : (
            <MetaChip
              slot="subagent-meta-requests"
              icon={<ArrowLeftRight aria-hidden="true" className="size-3" />}>
              {requests}
            </MetaChip>
          )}
          {messages === null ? null : (
            <MetaChip
              slot="subagent-meta-messages"
              icon={<MessageSquare aria-hidden="true" className="size-3" />}>
              {messages}
            </MetaChip>
          )}
          {tokensProcessed === null ? null : (
            <MetaChip
              slot="subagent-meta-tokens"
              icon={<Coins aria-hidden="true" className="size-3" />}>
              {formatTokens(tokensProcessed)}
            </MetaChip>
          )}
          {costUsd === null ? null : (
            <MetaChip
              slot="subagent-meta-cost"
              icon={<CircleDollarSign aria-hidden="true" className="size-3" />}>
              {/* The `≈` survives the compaction. It is the whole of what marks
                this figure as DERIVED rather than reported, so a glyph that
                dropped it would upgrade an estimate to a measurement. */}
              {`≈${formatExactUsd(costUsd)}`}
            </MetaChip>
          )}
          {took === null ? null : (
            <MetaChip
              slot="subagent-meta-duration"
              icon={<Timer aria-hidden="true" className="size-3" />}>
              {formatElapsed(took)}
            </MetaChip>
          )}
          {tasks === null ? null : (
            <MetaChip
              slot="subagent-meta-tasks"
              icon={<ListChecks aria-hidden="true" className="size-3" />}>
              <TaskCount done={tasks.done} total={tasks.total} />
            </MetaChip>
          )}
        </span>
      }>
      <div
        data-slot="subagent-meta-detail"
        className="flex flex-col gap-1 text-xs">
        {model === null ? null : <DetailRow label="Model" value={model} />}
        {requests === null ? null : (
          <DetailRow label="Requests (model calls)" value={requests} />
        )}
        {messages === null ? null : (
          <DetailRow label="Messages" value={messages} />
        )}
        {tokensProcessed === null ? null : (
          <>
            <DetailRow
              label="Tokens processed"
              value={formatTokens(tokensProcessed)}
            />
            {view.inputTokens === null ? null : (
              <DetailRow
                label="input"
                value={formatTokens(view.inputTokens)}
                indent
              />
            )}
            {view.outputTokens === null ? null : (
              <DetailRow
                label="output"
                value={formatTokens(view.outputTokens)}
                indent
              />
            )}
            {view.cacheCreationTokens === null ? null : (
              <DetailRow
                label="cache write"
                value={formatTokens(view.cacheCreationTokens)}
                indent
              />
            )}
            {view.cacheReadTokens === null ? null : (
              <DetailRow
                label="cache read"
                value={formatTokens(view.cacheReadTokens)}
                indent
              />
            )}
          </>
        )}
        {contextTokens === null ? null : (
          <DetailRow label="Context now" value={formatTokens(contextTokens)} />
        )}
        {view.contextAtEnd === null ? null : (
          <DetailRow
            label="Context at end"
            value={formatTokens(view.contextAtEnd)}
          />
        )}
        {costUsd === null ? null : (
          <DetailRow label="Cost" value={`≈${formatExactUsd(costUsd)}`} />
        )}
        {toolCount > 0 ? <DetailRow label="Tools" value={toolCount} /> : null}
        {took === null ? null : (
          <DetailRow label="Took" value={formatElapsed(took)} />
        )}
        {tasks === null ? null : (
          <DetailRow
            label="Tasks"
            value={`${tasks.done} of ${tasks.total} done`}
          />
        )}
        {hint === null ? null : (
          <p
            data-slot="subagent-meta-hint"
            className="m-0 text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
    </HoverPopover>
  );
}
