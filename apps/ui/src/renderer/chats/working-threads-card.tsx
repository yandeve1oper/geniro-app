import { HoverPopover } from '../components/hover-popover';
import { StatusDot } from '../components/status-dot';
import { Button } from '../components/ui/button';
import { popoverSurface } from '../components/ui/popover';
import { cn } from '../components/ui/utils';
import { useSecondTick } from '../components/use-second-tick';
import { formatElapsed } from './live-row';
import { CallGlyph } from './shelf-glyphs';
import {
  AgentsTile,
  type AgentsTileFace,
  CONTROL_HOVER,
} from './working-card-parts';

export interface WorkingThread {
  runId: string;
  title: string;
  agentLabel: string | null;
  agentKind: string | null;
  startedAt: string | null;
  status: 'working' | 'waiting';
}

const RIGHT_OF_AGENTS_CARD = 'right-14';
const IN_THE_CORNER = 'right-4';

function threadFace(thread: WorkingThread): AgentsTileFace {
  return {
    name: thread.agentLabel ?? thread.agentKind ?? thread.title,
    colorKey: thread.agentKind ?? thread.runId,
  };
}

function threadsSummary(threads: readonly WorkingThread[]): string {
  const working = threads.filter((thread) => thread.status === 'working');
  const waiting = threads.length - working.length;
  const words: string[] = [];
  if (working.length > 0) {
    words.push(`${working.length} working`);
  }
  if (waiting > 0) {
    words.push(`${waiting} waiting on you`);
  }
  return words.join(' · ');
}

function ThreadStatusDot({
  status,
}: {
  status: WorkingThread['status'];
}): React.JSX.Element {
  if (status === 'waiting') {
    return (
      <span
        data-slot="working-thread-dot"
        data-status={status}
        className="mt-1.5 flex shrink-0">
        <StatusDot tone="warn" className="size-2" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-slot="working-thread-dot"
      data-status={status}
      className="relative mt-1.5 flex size-2 shrink-0">
      <span className="absolute inset-0 animate-ping rounded-full bg-success/60 motion-reduce:animate-none" />
      <span className="relative size-2 rounded-full bg-success" />
    </span>
  );
}

function ThreadElapsed({
  startedAt,
}: {
  startedAt: string | null;
}): React.JSX.Element | null {
  const started = startedAt === null ? Number.NaN : Date.parse(startedAt);
  const known = !Number.isNaN(started);
  useSecondTick(known);
  if (!known) {
    return null;
  }
  return (
    <span
      data-slot="working-thread-elapsed"
      className="ml-auto shrink-0 text-xs text-foreground/80 tabular-nums">
      for {formatElapsed(Date.now() - started)}
    </span>
  );
}

function ThreadRow({
  thread,
  onOpenThread,
}: {
  thread: WorkingThread;
  onOpenThread?: (runId: string) => void;
}): React.JSX.Element {
  return (
    <div
      data-slot="working-thread-row"
      data-run={thread.runId}
      className="flex min-w-0 items-start gap-2.5 rounded-lg bg-accent/40 p-2.5">
      <ThreadStatusDot status={thread.status} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          data-slot="working-thread-title"
          title={thread.title}
          className="truncate text-[13px] font-semibold text-foreground">
          {thread.title}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
          {thread.agentLabel === null ? null : (
            <span data-slot="working-thread-agent">{thread.agentLabel}</span>
          )}
          {thread.status === 'waiting' ? (
            <span
              data-slot="working-thread-waiting"
              className="shrink-0 text-warning">
              waiting on you
            </span>
          ) : null}
          <ThreadElapsed startedAt={thread.startedAt} />
        </span>
      </div>
      {onOpenThread === undefined ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 self-center px-2 text-xs"
          onClick={() => onOpenThread(thread.runId)}>
          Go to thread
        </Button>
      )}
    </div>
  );
}

export function WorkingThreadsCard({
  threads,
  onOpenThread,
  beside,
}: {
  threads: readonly WorkingThread[];
  onOpenThread?: (runId: string) => void;
  beside: boolean;
}): React.JSX.Element | null {
  const lead =
    threads.find((thread) => thread.status === 'working') ?? threads[0];
  if (lead === undefined) {
    return null;
  }
  const summary = threadsSummary(threads);
  const anyWorking = threads.some((thread) => thread.status === 'working');
  return (
    <div className="pointer-events-none relative z-20 h-0 w-full overflow-visible">
      <section
        data-slot="working-threads-card"
        aria-label="Threads working"
        className={cn(
          popoverSurface,
          'pointer-events-auto -bottom-2 z-20 flex flex-col',
          beside ? RIGHT_OF_AGENTS_CARD : IN_THE_CORNER,
        )}>
        <HoverPopover
          slot="working-threads-toggle"
          label={`Threads working · ${summary}`}
          panelLabel="Threads working"
          side="top"
          className="shrink-0"
          triggerClassName={cn(
            'group relative min-w-0 rounded-xl text-left font-normal',
            CONTROL_HOVER,
          )}
          panelClassName="w-96 p-0"
          trigger={
            <span className="flex items-center gap-2 py-1 pr-2 pl-1">
              <AgentsTile
                face={threadFace(lead)}
                others={threads.length - 1}
                activity={anyWorking ? 'working' : 'waiting'}
              />
              <span
                data-slot="working-threads-count"
                className="text-xs whitespace-nowrap text-foreground tabular-nums">
                {summary}
              </span>
            </span>
          }>
          <div className="flex flex-col">
            <div className="flex min-w-0 items-center gap-2 px-3 py-2">
              <CallGlyph
                live={anyWorking}
                className={cn(
                  'size-3.5 shrink-0',
                  anyWorking && 'text-success',
                )}
              />
              <span className="shrink-0 text-sm font-semibold text-foreground">
                Threads working
              </span>
              <span
                data-slot="working-threads-panel-summary"
                className="min-w-0 truncate text-xs text-muted-foreground">
                {summary}
              </span>
            </div>
            <div className="flex flex-col gap-1.5 border-t border-border/60 p-1.5">
              {threads.map((thread) => (
                <ThreadRow
                  key={thread.runId}
                  thread={thread}
                  onOpenThread={onOpenThread}
                />
              ))}
            </div>
          </div>
        </HoverPopover>
      </section>
    </div>
  );
}
