import { ArrowUpRight, Inbox } from 'lucide-react';
import { createContext, useContext } from 'react';

import { ClampedText } from '../components/clamped-text';
import { cn } from '../components/ui/utils';
import { plainPreview } from './brief-text';
import { MessageBubble } from './message-bubble';
import type { ReceivedThreadMessage } from './thread-message-payload';

/**
 * Opens another thread by its run id, as the sidebar opens one — or null where
 * a thread cannot be opened (a hosted view), so a thread's title is plain text.
 */
export const ThreadOpenContext = createContext<
  ((runId: string) => void) | null
>(null);

const PLAIN_CLASS = 'min-w-0 break-words font-medium';
const LINK_CLASS =
  'min-w-0 cursor-pointer break-words text-left font-medium underline decoration-dotted underline-offset-2 hover:text-primary';
const CHIP_CLASS =
  'inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground';
const CHIP_LINK_CLASS =
  'cursor-pointer text-left hover:bg-accent hover:text-accent-foreground';

/** A thread's title, a press away from that thread where the view can open one. */
export function ThreadTitle({
  runId,
  title,
  chip = false,
}: {
  runId: string;
  title: string;
  chip?: boolean;
}): React.JSX.Element {
  const open = useContext(ThreadOpenContext);
  const label = chip ? (
    <span className="min-w-0 truncate">{title}</span>
  ) : (
    title
  );
  if (open === null) {
    return <span className={chip ? CHIP_CLASS : PLAIN_CLASS}>{label}</span>;
  }
  return (
    <button
      type="button"
      data-slot="thread-title"
      title="Open this thread"
      className={chip ? cn(CHIP_CLASS, CHIP_LINK_CLASS) : LINK_CLASS}
      onClick={() => open(runId)}>
      {label}
      {chip ? (
        <ArrowUpRight aria-hidden="true" className="size-3 shrink-0" />
      ) : null}
    </button>
  );
}

/**
 * The messages another thread sent this one, as the turn that took them shows
 * them: each an incoming bubble of its own, with its sender, the message it
 * answers when there is one, and its text.
 */
export function ThreadMessageCard({
  messages,
}: {
  messages: readonly ReceivedThreadMessage[];
}): React.JSX.Element {
  return (
    <div
      data-slot="thread-message-card"
      className="flex min-w-0 flex-col gap-1.5">
      {messages.map((message) => (
        <div
          key={message.id}
          data-slot="thread-message"
          className="flex min-w-0 flex-col">
          <MessageBubble variant="incoming">
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
              <Inbox aria-hidden="true" className="size-3 shrink-0" />
              <ThreadTitle
                runId={message.fromRunId}
                title={message.fromTitle}
                chip
              />
              {message.fromMember === null ? null : (
                <span>· {message.fromMember}</span>
              )}
            </div>
            {message.inReplyTo === null ? null : (
              <p
                data-slot="thread-message-reply-to"
                title={plainPreview(message.inReplyTo.text)}
                className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground">
                <span className="shrink-0">↳ replying to your message</span>
                <span className="min-w-0 truncate italic">
                  {plainPreview(message.inReplyTo.text)}
                </span>
              </p>
            )}
            <ClampedText
              text={message.text}
              lines={3}
              slot="thread-message-text"
              className="text-sm text-foreground"
            />
          </MessageBubble>
        </div>
      ))}
    </div>
  );
}
