import { cva, type VariantProps } from 'class-variance-authority';
import type React from 'react';

import { HelpHint } from './help-hint';
import { cn } from './ui/utils';

const settingsGroup = cva('grid min-w-0 grid-cols-1 gap-x-10 gap-y-4', {
  variants: {
    /**
     * `aside` puts the group's name, note and actions in a column of their own
     * beside its rows once the page is wide enough, so a long page reads as
     * named blocks rather than one run of cards. `stacked` keeps the heading
     * above, for content that needs the whole width (a list of entries).
     */
    layout: {
      aside: '@[52rem]:grid-cols-[15rem_minmax(0,1fr)]',
      stacked: '',
    },
  },
  defaultVariants: { layout: 'aside' },
});

const settingsGroupHeader = cva('flex min-w-0 items-start gap-3', {
  variants: {
    layout: {
      aside: '@[52rem]:flex-col @[52rem]:gap-2',
      stacked: '',
    },
  },
  defaultVariants: { layout: 'aside' },
});

/**
 * One named group of a settings page: an icon, a title with its "?"
 * explanation, a one-line note, the group's own actions, then its rows.
 *
 * Its parent carries `@container` ({@link SettingsGroups}), so the heading
 * moves beside the rows at the page's width rather than the window's.
 */
export function SettingsGroup({
  icon,
  title,
  description,
  hint,
  actions,
  layout,
  className,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  /** One line: what this group is for. */
  description?: React.ReactNode;
  /** The plain-language explanation behind the "?" after the title. */
  hint?: React.ReactNode;
  /** Buttons that act on the whole group (Re-check, New entry). */
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
} & VariantProps<typeof settingsGroup>): React.JSX.Element {
  return (
    <section
      data-slot="settings-group"
      aria-label={title}
      className={cn(settingsGroup({ layout }), className)}>
      <header className={cn(settingsGroupHeader({ layout }))}>
        {icon === undefined ? null : (
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&>svg]:size-4">
            {icon}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-1.5">
            <h2 className="text-base font-semibold">{title}</h2>
            {hint === undefined ? null : (
              <HelpHint subject={title}>{hint}</HelpHint>
            )}
          </span>
          {description === undefined ? null : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
          {actions === undefined ? null : (
            <div
              data-slot="settings-group-actions"
              className="flex flex-wrap items-center gap-2 pt-1">
              {actions}
            </div>
          )}
        </div>
      </header>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
    </section>
  );
}

/**
 * The column a settings page's groups stand in, each separated from the next
 * by a rule so the eye finds where one ends.
 */
export function SettingsGroups({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-slot="settings-groups"
      className={cn(
        '@container flex flex-col gap-8 [&>[data-slot=settings-group]+[data-slot=settings-group]]:border-t [&>[data-slot=settings-group]+[data-slot=settings-group]]:border-border [&>[data-slot=settings-group]+[data-slot=settings-group]]:pt-8',
        className,
      )}>
      {children}
    </div>
  );
}
