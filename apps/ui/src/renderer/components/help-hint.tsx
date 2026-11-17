import { HelpCircle } from 'lucide-react';

import { HoverPopover } from './hover-popover';

/**
 * A "?" beside a setting or a button, with the longer explanation behind it:
 * shown on hover or keyboard focus, pinned by a press.
 */
export function HelpHint({
  subject,
  align = 'start',
  slot = 'help-hint',
  children,
}: {
  /** What is explained; the trigger reads "About <subject>". */
  subject: string;
  align?: 'start' | 'end';
  slot?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <HoverPopover
      slot={slot}
      label={`About ${subject}`}
      panelLabel={subject}
      side="bottom"
      align={align}
      triggerClassName="text-muted-foreground hover:text-foreground"
      panelClassName="w-80 p-3"
      trigger={<HelpCircle aria-hidden="true" className="size-3.5 shrink-0" />}>
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-popover-foreground">
        {children}
      </div>
    </HoverPopover>
  );
}

/** One titled part of a {@link HelpHint}'s explanation. */
export function HelpHintPart({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium">{title}</span>
      <p className="text-muted-foreground">{children}</p>
    </div>
  );
}
