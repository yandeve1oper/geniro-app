import { cva, type VariantProps } from 'class-variance-authority';
import type React from 'react';

import { cn } from './utils';

/**
 * A small run of mutually exclusive options, all of them always visible.
 *
 * Not `select`, which is the app's one DROPDOWN: there are two to four
 * choices, they are worth showing at rest, and switching between them is a
 * thing the reader does constantly — a dropdown hides them behind a click
 * each time. Not `chip` either: a chip states one value, this states a set
 * and which of them is current.
 *
 * `aria-pressed` toggles rather than `role="tab"`: nothing here owns a tab
 * panel — the region below changes CONTENTS — and calling them tabs would
 * promise arrow-key roving this does not implement.
 */
const segmentVariants = cva(
  'inline-flex items-center gap-1.5 font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
  {
    variants: {
      size: {
        /** The Stats page's page-level control. */
        // A little tighter below `sm`: Stats' five periods then fit a phone's
        // column outright instead of scrolling their last one half out of view.
        default: 'rounded-sm px-2.5 py-1 text-sm sm:px-3',
        /** Tucked into a narrow column header — the chat sidebar's. */
        sm: 'h-7 rounded-sm px-2 text-xs [&>svg]:size-3 [&>svg]:shrink-0',
      },
      selected: {
        true: 'bg-card text-foreground shadow-panel-sm',
        false: 'text-muted-foreground hover:text-foreground',
      },
    },
    defaultVariants: { size: 'default', selected: false },
  },
);

export function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onSelect,
  size,
  disabled = false,
  className,
}: {
  ariaLabel: string;
  /** `icon` is optional — the Stats page's options are words alone. */
  options: readonly { id: T; label: React.ReactNode; icon?: React.ReactNode }[];
  value: T;
  onSelect: (id: T) => void;
  /** Every option stays drawn with its current value, and none can be picked. */
  disabled?: boolean;
  className?: string;
} & Pick<VariantProps<typeof segmentVariants>, 'size'>): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-slot="segmented-control"
      // `w-fit`: the track hugs its options. Stretched to its container it
      // leaves dead box to the right of the last segment, which reads as a
      // half-drawn control rather than a chosen width.
      className={cn(
        // `max-w-full` + its own horizontal scroll: `w-fit` of options that
        // never wrap outgrew a phone's column — Stats' five periods ran 13px
        // past the cards under them — so a set too wide for its column now
        // scrolls inside itself instead of pushing past it.
        'flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-md border border-border bg-muted p-1 [scrollbar-width:none]',
        className,
      )}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          disabled={disabled}
          onClick={() => onSelect(option.id)}
          className={cn(
            'shrink-0',
            segmentVariants({ size, selected: option.id === value }),
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}>
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}
