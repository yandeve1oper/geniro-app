import { X } from 'lucide-react';
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';

import { Button } from './ui/button';
import { cn } from './ui/utils';
import { useLatestCallback } from './use-latest-callback';

export const DEFAULT_ACTION_NOTICE_MS = 8_000;

export interface ActionNoticeAction {
  label: string;
  onAction: () => void;
}

/**
 * A compact notice: an icon, a title and a detail line, each on one line, at
 * most one quiet action and a close control. It withdraws itself after
 * `durationMs`, and the countdown pauses while the pointer is over it.
 */
export function ActionNotice({
  icon,
  title,
  detail,
  detailHint,
  action,
  durationMs = DEFAULT_ACTION_NOTICE_MS,
  onDismiss,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
  /** The detail line's tooltip; the line itself when absent. */
  detailHint?: string;
  action?: ActionNoticeAction;
  durationMs?: number;
  onDismiss: () => void;
  className?: string;
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const remaining = useRef(durationMs);
  const dismiss = useLatestCallback(() => onDismiss(), [onDismiss]);

  useEffect(() => {
    if (hovered) {
      return;
    }
    const started = Date.now();
    const timer = setTimeout(dismiss, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(
        0,
        remaining.current - (Date.now() - started),
      );
    };
  }, [hovered, dismiss]);

  return (
    <div
      role="status"
      data-slot="action-notice"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        'flex items-center gap-2.5 rounded-lg border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-panel-md',
        className,
      )}>
      <span
        aria-hidden
        data-slot="action-notice-icon"
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-base">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p
          data-slot="action-notice-title"
          title={title}
          className="m-0 truncate text-sm font-medium">
          {title}
        </p>
        {detail === undefined ? null : (
          <p
            data-slot="action-notice-detail"
            title={detailHint ?? detail}
            className="m-0 truncate text-xs text-muted-foreground">
            {detail}
          </p>
        )}
      </div>
      {action === undefined ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={action.onAction}>
          {action.label}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDismiss}>
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
