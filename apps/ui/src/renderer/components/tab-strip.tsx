import { X } from 'lucide-react';
import { Fragment, useLayoutEffect, useRef, useState } from 'react';

import { cn } from './ui/utils';

export interface TabStripTab<T extends string> {
  id: T;
  label: string;
  /** A figure drawn after the label (a count, or one like "200+"), or null for none. */
  count?: number | string | null;
  /** Drawn before the tab, beside it rather than inside it (a colour menu's trigger). */
  leading?: React.ReactNode;
  /** Drawn in place of the tab while set (a rename field). */
  editor?: React.ReactNode;
  /** The tab's tooltip. */
  title?: string;
}

/** The DOM id of a tab's panel, for `aria-controls` / `aria-labelledby`. */
export function tabPanelId(idPrefix: string, tab: string): string {
  return `${idPrefix}-panel-${tab}`;
}

export function tabId(idPrefix: string, tab: string): string {
  return `${idPrefix}-tab-${tab}`;
}

/**
 * A row of page tabs with a sliding underline. Arrow keys move between tabs
 * and Home/End jump to the ends, selecting as they go; the row scrolls
 * sideways when it is wider than its column. Given `onClose`, every tab draws
 * a × beside it and Delete closes the focused tab.
 */
export function TabStrip<T extends string>({
  tabs,
  value,
  onSelect,
  label,
  idPrefix,
  className,
  onClose,
  onDoubleClick,
}: {
  tabs: readonly TabStripTab<T>[];
  value: T;
  onSelect: (id: T) => void;
  label: string;
  idPrefix: string;
  className?: string;
  onClose?: (id: T) => void;
  onDoubleClick?: (id: T) => void;
}): React.JSX.Element {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [underline, setUnderline] = useState<{
    left: number;
    width: number;
  } | null>(null);

  useLayoutEffect(() => {
    const active = refs.current.get(value);
    if (active === undefined || active.offsetWidth === 0) {
      setUnderline(null);
      return;
    }
    const left = active.offsetLeft;
    const width = active.offsetWidth;
    setUnderline((current) =>
      current?.left === left && current.width === width
        ? current
        : { left, width },
    );
  }, [value, tabs]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const active = refs.current.get(value);
    if (strip === null || active === undefined) {
      return;
    }
    const right = active.offsetLeft + active.offsetWidth;
    if (active.offsetLeft < strip.scrollLeft) {
      strip.scrollLeft = active.offsetLeft;
    } else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = right - strip.clientWidth;
    }
  }, [value]);

  const focusTab = (index: number): void => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (tab === undefined) {
      return;
    }
    onSelect(tab.id);
    refs.current.get(tab.id)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number): void => {
    const current = tabs[index];
    if (event.key === 'Delete' && onClose && current !== undefined) {
      event.preventDefault();
      onClose(current.id);
      return;
    }
    const moves: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: tabs.length - 1,
    };
    const to = moves[event.key];
    if (to === undefined) {
      return;
    }
    event.preventDefault();
    focusTab(to);
  };

  return (
    <div
      ref={stripRef}
      data-slot="tab-strip"
      className={cn(
        'relative flex overflow-x-auto [scrollbar-width:none]',
        className,
      )}>
      <div role="tablist" aria-label={label} className="flex gap-6">
        {tabs.map((tab, index) => {
          const selected = tab.id === value;
          const tabButton = tab.editor ?? (
            <button
              ref={(element) => {
                if (element === null) {
                  refs.current.delete(tab.id);
                } else {
                  refs.current.set(tab.id, element);
                }
              }}
              id={tabId(idPrefix, tab.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={tabPanelId(idPrefix, tab.id)}
              tabIndex={selected ? 0 : -1}
              title={tab.title}
              className={cn(
                'relative flex h-10 shrink-0 items-center gap-1.5 text-base font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:rounded-control focus-visible:ring-2 focus-visible:ring-ring',
                selected && 'text-foreground',
                underline === null &&
                  selected &&
                  'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-pill after:bg-primary',
              )}
              onClick={() => onSelect(tab.id)}
              onDoubleClick={
                onDoubleClick === undefined
                  ? undefined
                  : () => onDoubleClick(tab.id)
              }
              onKeyDown={(event) => onKeyDown(event, index)}>
              {tab.label}
              {tab.count === undefined || tab.count === null ? null : (
                <span className="text-sm text-muted-foreground tabular-nums">
                  {tab.count}
                </span>
              )}
            </button>
          );
          return onClose ||
            tab.leading !== undefined ||
            tab.editor !== undefined ? (
            <div
              key={tab.id}
              role="presentation"
              className="flex shrink-0 items-center gap-1">
              {tab.leading}
              {tabButton}
              {onClose === undefined ? null : (
                <button
                  type="button"
                  tabIndex={-1}
                  data-slot="tab-close"
                  aria-label={`Close ${tab.label}`}
                  title="Close tab"
                  onClick={() => onClose(tab.id)}
                  className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground">
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              )}
            </div>
          ) : (
            <Fragment key={tab.id}>{tabButton}</Fragment>
          );
        })}
      </div>
      {underline === null ? null : (
        <span
          aria-hidden="true"
          data-slot="tab-underline"
          className="absolute bottom-0 left-0 h-0.5 rounded-pill bg-primary transition-[transform,width] duration-150 ease-out motion-reduce:transition-none"
          style={{
            width: underline.width,
            transform: `translateX(${underline.left}px)`,
          }}
        />
      )}
    </div>
  );
}
