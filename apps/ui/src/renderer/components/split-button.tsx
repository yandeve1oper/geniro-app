import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import { Button } from './ui/button';
import { Menu, type MenuGroup } from './ui/menu';
import { cn } from './ui/utils';

/**
 * One primary action whose label names what it does, with a menu beside it
 * that picks what the button does next. Picking an item never runs it: it
 * changes the button, so the press that acts is always the visible label.
 */
export function SplitButton({
  children,
  groups,
  value,
  menuLabel,
  disabled = false,
  menuDisabled = disabled,
  onClick,
  onSelect,
  onMenuOpen,
  className,
}: {
  children: React.ReactNode;
  groups: MenuGroup[];
  /** The item the button currently runs — gets the checkmark. */
  value: string;
  /** Names the menu trigger for assistive technology and tests. */
  menuLabel: string;
  disabled?: boolean;
  menuDisabled?: boolean;
  onClick: () => void;
  onSelect: (value: string) => void;
  /** Called as the menu is about to open, for a caller that reads its items lazily. */
  onMenuOpen?: () => void;
  className?: string;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  return (
    <span
      data-slot="split-button"
      className={cn('relative inline-flex max-w-full min-w-0', className)}>
      <Button
        type="button"
        size="sm"
        className="min-w-0 rounded-r-none"
        disabled={disabled}
        onClick={onClick}>
        <span className="truncate">{children}</span>
      </Button>
      <Button
        ref={triggerRef}
        type="button"
        size="sm"
        data-menu-trigger
        aria-label={menuLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="rounded-l-none border-l border-primary-foreground/25 px-2 has-[>svg]:px-2"
        disabled={menuDisabled}
        onPointerDown={onMenuOpen}
        onFocus={onMenuOpen}
        onClick={() => {
          onMenuOpen?.();
          setOpen((current) => !current);
        }}>
        <ChevronDown aria-hidden="true" />
      </Button>
      <Menu
        open={open && !menuDisabled}
        groups={groups}
        value={value}
        side="bottom"
        align="start"
        triggerRef={triggerRef}
        onSelect={(next) => {
          setOpen(false);
          onSelect(next);
        }}
        onClose={() => setOpen(false)}
      />
    </span>
  );
}
