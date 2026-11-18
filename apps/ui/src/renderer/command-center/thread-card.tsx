import { cva } from 'class-variance-authority';
import {
  ArrowRight,
  Bot,
  Folder,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
  MessageCircleQuestion,
  MessageSquareText,
  Moon,
  ShieldCheck,
  Users,
} from 'lucide-react';

import { plainPreview } from '../chats/brief-text';
import { formatDateTime, formatRelativeTime } from '../chats/relative-time';
import { type AvatarPerson, AvatarStack } from '../components/member-avatar';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { taskStatusMeta } from '../tasks/task-status';

export type ThreadCardStatus =
  'working' | 'waiting' | 'idle' | 'failed' | 'done';

/** Where a thread stands for the user, which colours its card and places it on the graph. */
export type ThreadAttention =
  'blocked' | 'working' | 'question' | 'quiet' | 'inactive';

export type ThreadCardPullRequestState = 'open' | 'merged' | 'closed' | 'draft';

/** The board card a thread works, shown on it as a label. */
export interface ThreadCardBoardCard {
  identifier: string | null;
  title: string;
  status: string;
}

export interface ThreadCardProps {
  title: string;
  status: ThreadCardStatus;
  /** The status chip's words, which say why the card stands in its band. */
  statusText: string;
  attention: ThreadAttention;
  project: string | null;
  /** The agent's short name, or the team's name for a team run. */
  agentLabel: string | null;
  isTeam: boolean;
  /** A team run's members, for the faces on its card; null for one agent. */
  crew: { people: readonly AvatarPerson[]; total: number } | null;
  pullRequest: { number: number; state: ThreadCardPullRequestState } | null;
  note: string | null;
  /** The thread's latest message, as the thread list previews it. */
  lastMessage: string | null;
  boardCard: ThreadCardBoardCard | null;
  /** Whole days nobody has touched it, once it counts as idle; else null. */
  idleDays: number | null;
  /** When the thread last moved. */
  lastAt: string;
  now: number;
  /** What a screen reader hears for the whole card. */
  summary?: string;
  /** A taller height to stand in; never shorter than its content. */
  height?: number;
  onGo: () => void;
  /** Open the thread's waiting question or approval in the command center; absent when it holds none. */
  onAnswer?: () => void;
  /** What the thread holds for the user, which names that button. */
  answerKind?: 'question' | 'approval' | null;
}

export const THREAD_CARD_WIDTH = 272;

const PAD_PX = 10;
const GAP_PX = 6;
const BORDER_PX = 1;
const LINE_PX = 16;
const ROW_PX = { header: 20, labels: 20, note: 20, footer: 24 } as const;

const MESSAGE_WIDTH_PX = THREAD_CARD_WIDTH - PAD_PX * 2 - BORDER_PX * 2;

/** About how many characters fit one line where text cannot be measured. */
const MESSAGE_LINE_CHARS = 44;

let measureContext: CanvasRenderingContext2D | null | undefined;

/** How wide `text` runs in the card's preview font, or null where nothing can measure it. */
function textWidth(text: string): number | null {
  if (measureContext === undefined) {
    try {
      measureContext =
        typeof document === 'undefined'
          ? null
          : document.createElement('canvas').getContext('2d');
    } catch {
      measureContext = null;
    }
    if (measureContext !== null && measureContext !== undefined) {
      const family = getComputedStyle(document.body).fontFamily;
      measureContext.font = `12px ${family === '' ? 'sans-serif' : family}`;
    }
  }
  return measureContext === null || measureContext === undefined
    ? null
    : measureContext.measureText(text).width;
}

/** The latest message as the card shows it: one line of plain text, or empty. */
export function previewLine(message: string | null): string {
  return message === null ? '' : plainPreview(message).replace(/`/g, '');
}

/** How many lines the preview takes: none, one, or two at most. */
export function previewLines(message: string | null): 0 | 1 | 2 {
  const text = previewLine(message);
  if (text === '') {
    return 0;
  }
  const width = textWidth(text);
  if (width === null) {
    return text.length <= MESSAGE_LINE_CHARS ? 1 : 2;
  }
  return width <= MESSAGE_WIDTH_PX ? 1 : 2;
}

/** The card's height for what it shows, so the graph can lay it out before it is drawn. */
export function threadCardHeight(view: {
  note: string | null;
  lastMessage: string | null;
}): number {
  const lines = previewLines(view.lastMessage);
  const rows = [
    ROW_PX.header,
    ROW_PX.labels,
    ...(view.note === null ? [] : [ROW_PX.note]),
    ...(lines === 0 ? [] : [lines * LINE_PX]),
    ROW_PX.footer,
  ];
  return (
    PAD_PX * 2 +
    BORDER_PX * 2 +
    rows.reduce((sum, row) => sum + row, 0) +
    GAP_PX * (rows.length - 1)
  );
}

export const THREAD_STATUS_TEXT: Record<ThreadCardStatus, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  idle: 'Idle',
  failed: 'Failed',
  done: 'Done',
};

export const ATTENTION_TEXT: Record<ThreadAttention, string> = {
  blocked: 'Blocked',
  working: 'Working',
  question: 'Question',
  quiet: 'Quiet',
  inactive: 'Inactive a day+',
};

const cardVariants = cva(
  'flex flex-col overflow-hidden rounded-card border text-left shadow-sm transition-[border-color,box-shadow,opacity] duration-200 hover:shadow-md motion-reduce:transition-none',
  {
    variants: {
      attention: {
        blocked: 'border-destructive/50 bg-destructive/5',
        working: 'border-success/50 bg-success/5',
        question: 'border-warning/50 bg-warning/10',
        quiet: 'border-border bg-card',
        inactive: 'border-border bg-muted/40 opacity-70 hover:opacity-100',
      } satisfies Record<ThreadAttention, string>,
    },
  },
);

export const attentionDotVariants = cva('size-2 shrink-0 rounded-full', {
  variants: {
    attention: {
      blocked: 'bg-destructive',
      working: 'bg-success',
      question: 'bg-warning',
      quiet: 'bg-muted-foreground/60',
      inactive: 'bg-muted-foreground/30',
    } satisfies Record<ThreadAttention, string>,
  },
});

const statusChipVariants = cva('shrink-0 px-1.5 py-0 font-medium', {
  variants: {
    attention: {
      blocked: 'bg-destructive/10 text-destructive',
      working: 'bg-success/10 text-success',
      question: 'bg-warning/15 text-warning',
      quiet: 'bg-muted text-muted-foreground',
      inactive: 'bg-muted text-muted-foreground',
    } satisfies Record<ThreadAttention, string>,
  },
});

function StatusDot({
  attention,
}: {
  attention: ThreadAttention;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-slot="thread-card-dot"
      className={cn('relative', attentionDotVariants({ attention }))}>
      {attention === 'working' ? (
        <span
          data-slot="thread-card-dot-ping"
          className="absolute inset-0 animate-ping rounded-full bg-success/60 motion-reduce:animate-none"
        />
      ) : null}
    </span>
  );
}

const PULL_REQUEST_META: Record<
  ThreadCardPullRequestState,
  { word: string; icon: LucideIcon; className: string }
> = {
  open: { word: 'open', icon: GitPullRequest, className: 'text-warning' },
  draft: {
    word: 'draft',
    icon: GitPullRequestDraft,
    className: 'text-muted-foreground',
  },
  merged: { word: 'merged', icon: GitMerge, className: 'text-success' },
  closed: {
    word: 'closed',
    icon: GitPullRequestClosed,
    className: 'text-destructive',
  },
};

function PullRequestChip({
  number,
  state,
}: {
  number: number;
  state: ThreadCardPullRequestState;
}): React.JSX.Element {
  const meta = PULL_REQUEST_META[state];
  const Icon = meta.icon;
  return (
    <Badge
      data-slot="thread-card-pull-request"
      variant="muted"
      title={`#${number} · ${meta.word}`}
      className="shrink-0 gap-1 px-1.5 py-0 font-normal">
      <Icon
        aria-hidden="true"
        className={cn('size-3.5 shrink-0', meta.className)}
      />
      <span className="sr-only">{meta.word}</span>
      <span className="tabular-nums">#{number}</span>
    </Badge>
  );
}

function BoardCardLabel({
  card,
}: {
  card: ThreadCardBoardCard;
}): React.JSX.Element {
  const meta = taskStatusMeta(card.status);
  const Icon = meta.icon;
  return (
    <Badge
      data-slot="thread-card-board-card"
      variant="muted"
      title={`${card.identifier ?? 'Board card'} · ${card.title} · ${meta.label}`}
      className="max-w-24 shrink-0 gap-1 px-1.5 py-0 font-normal">
      <Icon
        aria-hidden="true"
        className={cn('size-3.5 shrink-0', meta.className)}
      />
      <span className="truncate font-mono tabular-nums">
        {card.identifier ?? card.title}
      </span>
    </Badge>
  );
}

function LabelChip({
  slot,
  icon,
  text,
  title,
  yields,
}: {
  slot: string;
  icon: LucideIcon;
  text: string;
  title: string;
  /** Gives up its room first when the row runs out of it. */
  yields: boolean;
}): React.JSX.Element {
  const Icon = icon;
  return (
    <Badge
      data-slot={slot}
      variant="muted"
      title={title}
      className={cn(
        'gap-1 px-1.5 py-0 font-normal',
        yields ? 'min-w-14 shrink' : 'max-w-28 shrink-0',
      )}>
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{text}</span>
    </Badge>
  );
}

/** The way into a thread: a small outlined pill with the thread's glyph and an arrow. */
export function GoToThreadButton({
  onGo,
}: {
  onGo: () => void;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-slot="thread-card-go"
      className="group/go h-6 shrink-0 gap-1 rounded-full px-2.5 text-xs font-medium"
      onClick={onGo}>
      <MessageSquareText aria-hidden="true" className="size-3.5" />
      Go to thread
      <ArrowRight
        aria-hidden="true"
        className="size-3 transition-transform group-hover/go:translate-x-0.5 motion-reduce:transition-none"
      />
    </Button>
  );
}

/**
 * One thread as a card — a node of the command center's graph: its title and
 * pull request, its state and labels, the manager's note, its latest message,
 * and a Go to thread button. The card itself opens nothing.
 */
export function ThreadCard({
  title,
  status,
  statusText,
  attention,
  project,
  agentLabel,
  isTeam,
  crew,
  pullRequest,
  note,
  lastMessage,
  boardCard,
  idleDays,
  lastAt,
  now,
  summary,
  height,
  onGo,
  onAnswer,
  answerKind = null,
}: ThreadCardProps): React.JSX.Element {
  const preview = previewLine(lastMessage);
  const lines = previewLines(lastMessage);
  const ownHeight = threadCardHeight({ note, lastMessage });
  return (
    <article
      aria-label={summary ?? title}
      data-slot="thread-card"
      data-status={status}
      data-attention={attention}
      className={cn(
        cardVariants({ attention }),
        attention === 'working' && 'cc-breathe-success',
        onAnswer !== undefined && 'cc-breathe-warning',
      )}
      style={{
        width: THREAD_CARD_WIDTH,
        height: Math.max(ownHeight, height ?? 0),
        padding: PAD_PX,
        gap: GAP_PX,
      }}>
      <div className="flex h-5 min-w-0 shrink-0 items-center gap-2">
        <StatusDot attention={attention} />
        <span
          data-slot="thread-card-title"
          title={title}
          className="min-w-0 flex-1 truncate text-sm font-semibold">
          {title}
        </span>
        {crew === null || crew.people.length === 0 ? null : (
          <span
            data-slot="thread-card-crew"
            aria-label={`${crew.total} members`}
            className="shrink-0">
            <AvatarStack
              size={20}
              max={4}
              total={crew.total}
              people={crew.people}
              ringClassName="ring-card"
            />
          </span>
        )}
        {pullRequest === null ? null : (
          <PullRequestChip
            number={pullRequest.number}
            state={pullRequest.state}
          />
        )}
      </div>
      <div
        data-slot="thread-card-labels"
        className="flex h-5 min-w-0 shrink-0 items-center gap-1 overflow-hidden">
        <Badge
          data-slot="thread-card-status"
          variant="muted"
          className={statusChipVariants({ attention })}>
          {statusText}
        </Badge>
        {agentLabel === null ? null : (
          <LabelChip
            slot="thread-card-agent"
            icon={isTeam ? Users : Bot}
            text={agentLabel}
            title={isTeam ? `Team ${agentLabel}` : `Agent ${agentLabel}`}
            yields={false}
          />
        )}
        {boardCard === null ? null : <BoardCardLabel card={boardCard} />}
        {project === null ? null : (
          <LabelChip
            slot="thread-card-project"
            icon={Folder}
            text={project}
            title={`Project ${project}`}
            yields
          />
        )}
      </div>
      {note === null ? null : (
        <p
          data-slot="thread-card-note"
          title={note}
          className="h-5 shrink-0 truncate border-l-2 border-primary/50 pl-2 text-xs leading-5 text-foreground/80 italic">
          {note}
        </p>
      )}
      {lines === 0 ? null : (
        <p
          data-slot="thread-card-message"
          title={preview}
          className={cn(
            'shrink-0 text-xs leading-4 text-muted-foreground',
            lines === 1 ? 'h-4 truncate' : 'line-clamp-2 h-8',
          )}>
          {preview}
        </p>
      )}
      <div className="flex h-6 shrink-0 items-center justify-between gap-2">
        <span
          data-slot="thread-card-time"
          title={formatDateTime(lastAt)}
          className="flex min-w-0 shrink-0 items-center gap-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {idleDays === null ? null : (
            <Moon
              aria-label={`Nobody has touched this thread for ${idleDays} days`}
              data-slot="thread-card-idle"
              className="size-3 shrink-0"
            />
          )}
          {formatRelativeTime(lastAt, now)}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {onAnswer === undefined ? null : (
            <Button
              type="button"
              size="sm"
              data-slot="thread-card-answer"
              className="h-6 gap-1 rounded-full px-2.5 text-xs"
              onClick={onAnswer}>
              {answerKind === 'approval' ? (
                <ShieldCheck aria-hidden="true" className="size-3.5" />
              ) : (
                <MessageCircleQuestion
                  aria-hidden="true"
                  className="size-3.5"
                />
              )}
              {answerKind === 'approval' ? 'Review' : 'Answer'}
            </Button>
          )}
          <GoToThreadButton onGo={onGo} />
        </span>
      </div>
    </article>
  );
}
