import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { Button } from './ui/button';
import { cn } from './ui/utils';

/**
 * The first `limit` of a list that grows with use, and whether the rest are
 * shown. A `limit` of 0 hides the whole list until it is asked for.
 */
export function useShowAll<T>(
  items: readonly T[],
  limit: number,
): {
  shown: readonly T[];
  expanded: boolean;
  setExpanded: (next: boolean) => void;
} {
  const [expanded, setExpanded] = useState(false);
  return {
    shown: expanded || items.length <= limit ? items : items.slice(0, limit),
    expanded,
    setExpanded,
  };
}

/**
 * The press that unfolds the rest of a list, or folds it back. Draws nothing
 * when the list already fits.
 *
 * With `limit` 0 the list is hidden whole and the button reads "Show 12
 * entries"; otherwise it reads "Show all 12 entries". A `total` of null is a
 * list whose size nobody counted: the button reads "Show entries" and is
 * always drawn.
 */
export function ShowAllButton({
  total,
  limit,
  expanded,
  onToggle,
  noun,
  nounOne = noun,
  className,
}: {
  total: number | null;
  limit: number;
  expanded: boolean;
  onToggle: () => void;
  /** Plural noun for what the list holds ("entries", "devices"). */
  noun: string;
  /** The noun for a list of one ("entry"). */
  nounOne?: string;
  className?: string;
}): React.JSX.Element | null {
  if (total !== null && total <= limit) {
    return null;
  }
  const count = total === null ? '' : `${total.toLocaleString()} `;
  const label = expanded
    ? limit === 0
      ? `Hide ${noun}`
      : 'Show fewer'
    : limit === 0
      ? `Show ${count}${total === 1 ? nounOne : noun}`
      : `Show all ${count}${noun}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-slot="show-all"
      aria-expanded={expanded}
      className={cn('gap-1.5 self-start text-muted-foreground', className)}
      onClick={onToggle}>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          'size-3.5 transition-transform',
          expanded && 'rotate-180',
        )}
      />
      {label}
    </Button>
  );
}
