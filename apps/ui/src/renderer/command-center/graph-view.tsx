import '@xyflow/react/dist/style.css';

import {
  type Edge,
  type EdgeProps,
  Handle,
  type Node,
  type NodeHandle,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { cva } from 'class-variance-authority';
import { Maximize, Minus, Plus, RadioTower } from 'lucide-react';
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { type Point, roundedPath } from '../components/stage-graph-layout';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { useLatestCallback } from '../components/use-latest-callback';
import { formatUpdated } from '../teams/format-updated';
import {
  ATTENTION_ORDER,
  orderByAttention,
  type ThreadCardView,
} from './card-view';
import {
  ContactEdge,
  type ContactFlowEdge,
  type ContactPulse,
  type ContactState,
  type EdgeState,
  edgeStateOf,
  pathStyle,
  usePrefersReducedMotion,
} from './contact-edge';
import {
  bandRows,
  type GraphBox,
  type GraphGeometry,
  layoutColumn,
  layoutRows,
  perLineFor,
} from './graph-layout';
import {
  ATTENTION_TEXT,
  attentionDotVariants,
  THREAD_CARD_WIDTH,
  type ThreadAttention,
  ThreadCard,
  threadCardHeight,
} from './thread-card';

export const MAX_THREAD_NODES = 24;

export interface GraphThread {
  id: string;
  createdAt: string;
  view: ThreadCardView;
}

/** The manager's own chat, as its node shows it; null while there is none. */
export interface GraphManager {
  agentLabel: string | null;
  model: string | null;
  working: boolean;
  lastActivityAt: string | null;
}

export interface GraphViewProps {
  manager: GraphManager | null;
  /** Threads the manager asked to start that wait on the user's Start. */
  pendingStarts: number;
  /** Every thread; drawn by attention, the first {@link MAX_THREAD_NODES} of that order. */
  threads: readonly GraphThread[];
  contacts: Readonly<Record<string, ContactState>>;
  pulses: readonly ContactPulse[];
  now: number;
  /** One column for a narrow screen, scrolled rather than panned. */
  narrow: boolean;
  onOpen: (threadId: string) => void;
  /** Threads holding a question or an approval the user can answer here, by what they hold. */
  asking: ReadonlyMap<string, 'question' | 'approval'>;
  onAnswer: (threadId: string) => void;
  className?: string;
}

const MANAGER_ID = 'manager';
const MORE_ID = 'more';
const MANAGER_WIDTH = 380;
const MANAGER_WIDTH_NARROW = THREAD_CARD_WIDTH;
const MANAGER_HEIGHT = 84;
const MANAGER_HEIGHT_NARROW = 112;
const MORE_WIDTH = 160;
const MORE_HEIGHT = 32;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;
const FIT_MARGIN = 16;
const FIT_MS = 400;
const PAN_ROOM = 160;
const PRO_OPTIONS = { hideAttribution: true };

/** Wires share their trunk, so the louder states are painted last, on top. */
const EDGE_PAINT_ORDER: Record<EdgeState, number> = {
  idle: 0,
  lit: 1,
  awaiting: 2,
};

const NODE_CLASS =
  'transition-transform duration-300 ease-out motion-reduce:transition-none';

/** Nodes answer the pointer only when React Flow sees a handler on them; the cards handle their own presses. */
const POINTER_ON_NODES = (): void => undefined;

interface ManagerNodeData extends Record<string, unknown> {
  manager: GraphManager | null;
  threads: number;
  working: number;
  awaiting: number;
  pendingStarts: number;
  now: number;
}

interface ThreadNodeData extends Record<string, unknown> {
  thread: GraphThread;
  summary: string;
  asking: 'question' | 'approval' | null;
}

interface MoreNodeData extends Record<string, unknown> {
  count: number;
}

interface LinkEdgeData extends Record<string, unknown> {
  route: readonly Point[];
}

type ManagerFlowNode = Node<ManagerNodeData, 'manager'>;
type ThreadFlowNode = Node<ThreadNodeData, 'thread'>;
type MoreFlowNode = Node<MoreNodeData, 'more'>;
type GraphFlowNode = ManagerFlowNode | ThreadFlowNode | MoreFlowNode;
type LinkFlowEdge = Edge<LinkEdgeData, 'link'>;

interface GraphActions {
  open: (threadId: string) => void;
  answer: (threadId: string) => void;
}

const GraphActionsContext = createContext<GraphActions>({
  open: () => undefined,
  answer: () => undefined,
});

const HIDDEN_HANDLE = { opacity: 0, pointerEvents: 'none' } as const;

/**
 * The node's two wire ends, in the DOM as well as on the node: once React Flow
 * measures a drawn node it reads its handles from here, and a node without
 * them loses every wire.
 */
function WireEnds(): React.JSX.Element {
  return (
    <>
      <Handle
        id="in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={HIDDEN_HANDLE}
      />
      <Handle
        id="out"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={HIDDEN_HANDLE}
      />
    </>
  );
}

const statVariants = cva(
  'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs tabular-nums',
  {
    variants: {
      tone: {
        plain: 'bg-muted text-foreground',
        working: 'bg-primary/12 text-primary',
        awaiting: 'bg-warning/15 text-warning',
        start: 'bg-accent text-accent-foreground',
      },
    },
  },
);

function Stat({
  slot,
  tone,
  count,
  word,
}: {
  slot: string;
  tone: 'plain' | 'working' | 'awaiting' | 'start';
  count: number;
  word: string;
}): React.JSX.Element {
  return (
    <span data-slot={slot} className={statVariants({ tone })}>
      <span className="font-semibold">{count}</span>
      {word}
    </span>
  );
}

function ManagerNode({ data }: NodeProps<ManagerFlowNode>): React.JSX.Element {
  const { manager, threads, working, awaiting, pendingStarts, now } = data;
  const started = manager !== null;
  const line = started
    ? [
        manager.agentLabel,
        manager.model,
        manager.lastActivityAt === null
          ? null
          : `active ${formatUpdated(manager.lastActivityAt, now)}`,
      ]
        .filter((part) => part !== null && part !== '')
        .join(' · ')
    : 'Not started — write to it to run your threads in plain words';
  const state = !started ? 'Not started' : manager.working ? 'Working' : 'Idle';
  return (
    <>
      <WireEnds />
      <section
        data-slot="graph-manager"
        data-started={started}
        aria-label={`Manager, ${state}: ${threads} threads, ${working} working, ${awaiting} awaiting a reply, ${pendingStarts} waiting to start`}
        className={cn(
          'flex size-full flex-col gap-2.5 rounded-card border border-primary/50 bg-linear-to-b from-primary/10 to-card px-3 py-2.5 text-left shadow-md',
          started && manager.working && 'cc-breathe-primary',
        )}>
        <span className="flex min-w-0 items-center gap-3">
          <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <RadioTower aria-hidden="true" className="size-4.5" />
            {started && manager.working ? (
              <span className="absolute -top-0.5 -right-0.5 size-2.5 animate-pulse rounded-full bg-primary ring-2 ring-card motion-reduce:animate-none" />
            ) : null}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2">
              <span className="text-sm font-semibold">Manager</span>
              <span
                data-slot="graph-manager-state"
                className={cn(
                  'rounded-pill px-1.5 text-xs',
                  started && manager.working
                    ? 'bg-primary/15 text-primary'
                    : 'bg-muted text-foreground/80',
                )}>
                {state}
              </span>
            </span>
            <span
              data-slot="graph-manager-line"
              className="truncate text-xs text-muted-foreground">
              {line}
            </span>
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Stat
            slot="graph-manager-threads"
            tone="plain"
            count={threads}
            word={threads === 1 ? 'thread' : 'threads'}
          />
          {working > 0 ? (
            <Stat
              slot="graph-manager-working"
              tone="working"
              count={working}
              word="working"
            />
          ) : null}
          {awaiting > 0 ? (
            <Stat
              slot="graph-manager-awaiting"
              tone="awaiting"
              count={awaiting}
              word="awaiting reply"
            />
          ) : null}
          {pendingStarts > 0 ? (
            <Stat
              slot="graph-manager-starts"
              tone="start"
              count={pendingStarts}
              word={pendingStarts === 1 ? 'Start waiting' : 'Starts waiting'}
            />
          ) : null}
        </span>
      </section>
    </>
  );
}

function ThreadNode({ data }: NodeProps<ThreadFlowNode>): React.JSX.Element {
  const { open, answer } = useContext(GraphActionsContext);
  const { thread, summary, asking } = data;
  return (
    <div
      data-slot="graph-thread"
      data-thread-id={thread.id}
      className="cc-node-in">
      <WireEnds />
      <ThreadCard
        {...thread.view}
        summary={summary}
        onGo={() => open(thread.id)}
        answerKind={asking}
        onAnswer={asking === null ? undefined : () => answer(thread.id)}
      />
    </div>
  );
}

function MoreNode({ data }: NodeProps<MoreFlowNode>): React.JSX.Element {
  return (
    <>
      <WireEnds />
      <span
        data-slot="graph-more"
        className="flex size-full items-center justify-center rounded-pill border border-dashed border-border-strong bg-card text-xs text-muted-foreground">
        +{data.count} more {data.count === 1 ? 'thread' : 'threads'}
      </span>
    </>
  );
}

function LinkEdge({ id, data }: EdgeProps<LinkFlowEdge>): React.JSX.Element {
  const path = roundedPath(data!.route, 10);
  return (
    <path
      aria-hidden="true"
      data-slot="graph-link"
      data-edge={id}
      d={path}
      style={pathStyle(path)}
      className="fill-none stroke-border-strong transition-[d] duration-300 ease-out motion-reduce:transition-none"
      strokeWidth={1.25}
      strokeDasharray="4 4"
      strokeLinecap="round"
    />
  );
}

const NODE_TYPES = {
  manager: ManagerNode,
  thread: ThreadNode,
  more: MoreNode,
};
const EDGE_TYPES = { contact: ContactEdge, link: LinkEdge };

function handlesFor(width: number, height: number): NodeHandle[] {
  return [
    { id: 'in', type: 'target', position: Position.Top, x: width / 2, y: 0 },
    {
      id: 'out',
      type: 'source',
      position: Position.Bottom,
      x: width / 2,
      y: height,
    },
  ];
}

function summaryOf(
  view: ThreadCardView,
  state: EdgeState,
  lastAt: string | null,
  now: number,
): string {
  return [
    view.title,
    view.statusText,
    ATTENTION_TEXT[view.attention],
    ...(view.idleDays === null ? [] : [`idle ${view.idleDays} days`]),
    ...(state === 'awaiting' ? ['awaiting a reply'] : []),
    lastAt === null
      ? 'no contact yet'
      : `last contact ${formatUpdated(lastAt, now)}`,
  ].join(', ');
}

/** The threads in bands by attention, each band on lines of its own, then "+N more" alone. */
export function graphRows(
  shown: readonly GraphThread[],
  hidden: number,
  canvasWidth = 0,
): GraphBox[][] {
  const boxOf = (thread: GraphThread): GraphBox => ({
    id: `thread:${thread.id}`,
    width: THREAD_CARD_WIDTH,
    height: threadCardHeight(thread.view),
  });
  const bands = ATTENTION_ORDER.map((attention) =>
    shown.filter((thread) => thread.view.attention === attention).map(boxOf),
  );
  return [
    ...bandRows(
      bands,
      perLineFor(shown.length, canvasWidth, THREAD_CARD_WIDTH),
    ),
    ...(hidden > 0
      ? [[{ id: MORE_ID, width: MORE_WIDTH, height: MORE_HEIGHT }]]
      : []),
  ];
}

/** Which threads get a node: the first {@link MAX_THREAD_NODES} by attention. */
export function shownThreads(threads: readonly GraphThread[]): GraphThread[] {
  return orderByAttention(threads).slice(0, MAX_THREAD_NODES);
}

/** How many threads stand in each attention band. */
export function attentionCounts(
  threads: readonly GraphThread[],
): ReadonlyMap<ThreadAttention, number> {
  const counts = new Map<ThreadAttention, number>();
  for (const thread of threads) {
    counts.set(
      thread.view.attention,
      (counts.get(thread.view.attention) ?? 0) + 1,
    );
  }
  return counts;
}

function AttentionLegend({
  threads,
}: {
  threads: readonly GraphThread[];
}): React.JSX.Element {
  const counts = attentionCounts(threads);
  return (
    <ul
      aria-label="Threads by attention"
      data-slot="graph-legend"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 text-xs">
      {ATTENTION_ORDER.filter(
        (attention) => (counts.get(attention) ?? 0) > 0,
      ).map((attention) => (
        <li
          key={attention}
          data-slot="graph-legend-item"
          data-attention={attention}
          className="flex items-center gap-1.5 text-muted-foreground">
          <span
            aria-hidden="true"
            className={attentionDotVariants({ attention })}
          />
          {ATTENTION_TEXT[attention]}
          <span className="font-semibold text-foreground tabular-nums">
            {counts.get(attention)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The view that shows the graph across the canvas's width from its top, never
 * zoomed past 1: a card stays readable and a tall graph scrolls down, where a
 * whole-graph fit would shrink the cards to nothing.
 */
export function widthFit(
  graph: { width: number },
  canvas: { width: number },
): { x: number; y: number; zoom: number } {
  const zoom = Math.max(
    MIN_ZOOM,
    Math.min(1, (canvas.width - FIT_MARGIN * 2) / Math.max(1, graph.width)),
  );
  return {
    x: Math.max(FIT_MARGIN, (canvas.width - graph.width * zoom) / 2),
    y: FIT_MARGIN,
    zoom,
  };
}

/** The view that shows the WHOLE graph in the canvas, centred, never zoomed past 1 — the Fit button's. */
export function wholeFit(
  graph: { width: number; height: number },
  canvas: { width: number; height: number },
): { x: number; y: number; zoom: number } {
  const zoom = Math.max(
    MIN_ZOOM,
    Math.min(
      1,
      (canvas.width - FIT_MARGIN * 2) / Math.max(1, graph.width),
      (canvas.height - FIT_MARGIN * 2) / Math.max(1, graph.height),
    ),
  );
  return {
    x: Math.max(FIT_MARGIN, (canvas.width - graph.width * zoom) / 2),
    y: Math.max(FIT_MARGIN, (canvas.height - graph.height * zoom) / 2),
    zoom,
  };
}

function useElementSize(): [
  (el: HTMLDivElement | null) => void,
  { width: number; height: number },
] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (element === null) {
      return;
    }
    setSize({ width: element.clientWidth, height: element.clientHeight });
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries.at(-1)?.contentRect;
      if (rect !== undefined) {
        setSize({ width: rect.width, height: rect.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size];
}

export function GraphView(props: GraphViewProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

function ZoomControls({ onFit }: { onFit: () => void }): React.JSX.Element {
  const flow = useReactFlow();
  const reduced = usePrefersReducedMotion();
  const duration = reduced ? 0 : 200;
  return (
    <div
      role="group"
      aria-label="Zoom"
      className="absolute right-3 bottom-3 z-10 flex flex-col gap-1 rounded-control border border-border bg-card p-1 shadow-sm">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Zoom in"
        onClick={() => void flow.zoomIn({ duration })}>
        <Plus aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Zoom out"
        onClick={() => void flow.zoomOut({ duration })}>
        <Minus aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Fit the graph"
        onClick={onFit}>
        <Maximize aria-hidden="true" />
      </Button>
    </div>
  );
}

function GraphCanvas({
  manager,
  pendingStarts,
  threads,
  contacts,
  pulses,
  now,
  narrow,
  onOpen,
  asking,
  onAnswer,
  className,
}: GraphViewProps): React.JSX.Element {
  const flow = useReactFlow();
  const reduced = usePrefersReducedMotion();
  const [measure, size] = useElementSize();
  const fitted = useRef<string | null>(null);

  const shown = shownThreads(threads);
  const hidden = threads.length - shown.length;
  const rows = graphRows(shown, hidden, narrow ? 0 : size.width);
  const root: GraphBox = {
    id: MANAGER_ID,
    width: narrow ? MANAGER_WIDTH_NARROW : MANAGER_WIDTH,
    height: narrow ? MANAGER_HEIGHT_NARROW : MANAGER_HEIGHT,
  };
  const drawn: GraphGeometry = narrow
    ? layoutColumn(root, rows.flat())
    : layoutRows(root, rows);

  const fit = useLatestCallback((animate: boolean) => {
    void flow.setViewport(widthFit(drawn, size), {
      duration: animate && !reduced ? FIT_MS : 0,
    });
  }, []);
  const fitKey = `${Math.round(drawn.width)}#${Math.round(size.width)}x${Math.round(size.height)}`;
  useLayoutEffect(() => {
    if (narrow || size.width === 0 || fitted.current === fitKey) {
      return;
    }
    const first = fitted.current === null;
    fitted.current = fitKey;
    fit(!first);
  }, [fitKey, narrow, size.width, fit]);

  const open = useLatestCallback(onOpen, []);
  const answer = useLatestCallback(onAnswer, []);

  const states = new Map(
    shown.map((thread) => {
      const contact = contacts[thread.id];
      const threadPulses = pulses.filter(
        (pulse) => pulse.threadId === thread.id,
      );
      return [
        thread.id,
        {
          contact,
          pulses: threadPulses,
          state: edgeStateOf(contact, threadPulses, now),
        },
      ] as const;
    }),
  );
  const awaiting = [...states.values()].filter(
    (entry) => entry.state === 'awaiting',
  ).length;
  const working = threads.filter(
    (thread) => thread.view.status === 'working',
  ).length;

  const base = (id: string) => {
    const box = drawn.boxes.get(id)!;
    return {
      id,
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      handles: handlesFor(box.width, box.height),
      className: NODE_CLASS,
      selectable: false,
      draggable: false,
      focusable: false,
    };
  };
  const nodes: GraphFlowNode[] = [
    {
      ...base(MANAGER_ID),
      type: 'manager',
      data: {
        manager,
        threads: threads.length,
        working,
        awaiting,
        pendingStarts,
        now,
      },
    },
  ];
  const contactEdges: ContactFlowEdge[] = [];
  const linkEdges: LinkFlowEdge[] = [];
  for (const thread of shown) {
    const id = `thread:${thread.id}`;
    const entry = states.get(thread.id)!;
    nodes.push({
      ...base(id),
      type: 'thread',
      data: {
        thread,
        asking: asking.get(thread.id) ?? null,
        summary: summaryOf(
          thread.view,
          entry.state,
          entry.contact?.lastAt ?? null,
          now,
        ),
      },
    });
    const wire = drawn.routes.get(id);
    if (wire !== undefined) {
      contactEdges.push({
        id: `contact:${thread.id}`,
        type: 'contact',
        source: MANAGER_ID,
        sourceHandle: 'out',
        target: id,
        targetHandle: 'in',
        focusable: false,
        selectable: false,
        data: { route: wire, state: entry.state, pulses: entry.pulses, now },
      });
    }
  }
  if (hidden > 0) {
    nodes.push({ ...base(MORE_ID), type: 'more', data: { count: hidden } });
    const route = drawn.routes.get(MORE_ID);
    if (route !== undefined) {
      linkEdges.push({
        id: `link:${MORE_ID}`,
        type: 'link',
        source: MANAGER_ID,
        sourceHandle: 'out',
        target: MORE_ID,
        targetHandle: 'in',
        focusable: false,
        selectable: false,
        data: { route },
      });
    }
  }
  const edges: (ContactFlowEdge | LinkFlowEdge)[] = [
    ...linkEdges,
    ...contactEdges.sort(
      (a, b) =>
        EDGE_PAINT_ORDER[a.data!.state] - EDGE_PAINT_ORDER[b.data!.state],
    ),
  ];

  const label = `Manager and ${shown.length} ${shown.length === 1 ? 'thread' : 'threads'}`;
  const flowProps = {
    nodes,
    edges,
    nodeTypes: NODE_TYPES,
    edgeTypes: EDGE_TYPES,
    onNodeClick: POINTER_ON_NODES,
    nodesDraggable: false,
    nodesConnectable: false,
    nodesFocusable: false,
    edgesFocusable: false,
    elementsSelectable: false,
    disableKeyboardA11y: true,
    deleteKeyCode: null,
    selectionKeyCode: null,
    multiSelectionKeyCode: null,
    panActivationKeyCode: null,
    zoomActivationKeyCode: null,
    proOptions: PRO_OPTIONS,
  };

  return (
    <GraphActionsContext.Provider value={{ open, answer }}>
      {narrow ? (
        <div
          role="group"
          aria-label={label}
          data-slot="command-center-graph"
          data-layout="column"
          className={cn('overflow-y-auto', className)}>
          <AttentionLegend threads={threads} />
          <div
            className="mx-auto"
            style={{ width: drawn.width, height: drawn.height }}>
            <ReactFlow
              {...flowProps}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
              panOnDrag={false}
              panOnScroll={false}
              zoomOnScroll={false}
              zoomOnPinch={false}
              zoomOnDoubleClick={false}
              preventScrolling={false}
            />
          </div>
        </div>
      ) : (
        <div
          role="group"
          aria-label={label}
          data-slot="command-center-graph"
          data-layout="bands"
          data-rows={rows.length}
          className={cn('flex flex-col', className)}>
          <AttentionLegend threads={threads} />
          <div ref={measure} className="relative min-h-0 flex-1">
            {size.width === 0 ? null : (
              <>
                <ReactFlow
                  {...flowProps}
                  defaultViewport={widthFit(drawn, size)}
                  minZoom={MIN_ZOOM}
                  maxZoom={MAX_ZOOM}
                  translateExtent={[
                    [-PAN_ROOM, -PAN_ROOM],
                    [drawn.width + PAN_ROOM, drawn.height + PAN_ROOM],
                  ]}
                  panOnDrag
                  panOnScroll
                  zoomOnScroll={false}
                  zoomOnPinch
                  zoomOnDoubleClick={false}
                />
                <ZoomControls
                  onFit={() =>
                    void flow.setViewport(wholeFit(drawn, size), {
                      duration: reduced ? 0 : FIT_MS,
                    })
                  }
                />
              </>
            )}
          </div>
        </div>
      )}
    </GraphActionsContext.Provider>
  );
}
