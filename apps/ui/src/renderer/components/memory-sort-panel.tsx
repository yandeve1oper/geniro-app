import { Sparkles } from 'lucide-react';

import { ErrorText } from './error-text';
import { Button } from './ui/button';
import { ProgressBar } from './ui/progress-bar';

export interface MemorySortVerdict {
  keep: boolean;
  reason: string;
}

/** One note an agent is asked to sort, by a key its verdict comes back under. */
export interface MemorySortNote {
  key: string;
  title: string;
  body: string;
  folder: string | null;
}

/** An AI sort run in batches; its verdicts are keyed by note key. */
export interface MemorySort {
  verdicts: ReadonlyMap<string, MemorySortVerdict>;
  running: boolean;
  done: number;
  total: number;
  error: string | null;
  start: (notes: readonly MemorySortNote[]) => void;
  cancel: () => void;
}

/**
 * The Sort with AI box an import or a cleanup draws: what the sort does, the
 * agent picker and a start button at rest, progress and Stop while it runs,
 * and a summary of what it decided.
 */
export function MemorySortPanel({
  sort,
  description,
  settings,
  startLabel,
  startDisabled,
  sorted,
  summary = null,
  moreActions = null,
  onStart,
  slot,
}: {
  sort: MemorySort;
  description: string;
  /** The agent and model picker, or the line saying no agent can sort. */
  settings: React.ReactNode;
  startLabel: string;
  startDisabled: boolean;
  /** Whether some notes already have a verdict, which turns the start button secondary. */
  sorted: boolean;
  summary?: React.ReactNode;
  moreActions?: React.ReactNode;
  onStart: () => void;
  slot: string;
}): React.JSX.Element {
  return (
    <section
      data-slot={slot}
      aria-label="Sort with AI"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
      <div className="flex min-w-0 items-start gap-2">
        <Sparkles
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-primary"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium">Sort with AI</span>
          <span className="text-xs text-muted-foreground">{description}</span>
        </div>
      </div>
      {sort.running ? (
        <div className="flex min-w-0 items-center gap-3 pl-6">
          <ProgressBar
            label="Sorting notes"
            fraction={sort.total === 0 ? null : sort.done / sort.total}
            className="flex-1"
          />
          <span
            role="status"
            className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {sort.done.toLocaleString('en-US')} /{' '}
            {sort.total.toLocaleString('en-US')}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={sort.cancel}>
            Stop
          </Button>
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2 pl-6">
          {settings}
          <Button
            type="button"
            size="sm"
            variant={sorted ? 'outline' : 'default'}
            disabled={startDisabled}
            onClick={onStart}>
            {startLabel}
          </Button>
          {moreActions}
          {summary}
        </div>
      )}
      {sort.error === null ? null : (
        <ErrorText className="pl-6 text-xs">{sort.error}</ErrorText>
      )}
    </section>
  );
}
