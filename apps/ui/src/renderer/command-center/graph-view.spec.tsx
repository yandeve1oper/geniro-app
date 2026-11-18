// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import type { ContactState } from './contact-edge';
import { FIXTURE_NOW, graphThreadsOf } from './graph-fixtures';
import type { GraphThread } from './graph-view';
import {
  GraphView,
  MAX_THREAD_NODES,
  shownThreads,
  wholeFit,
  widthFit,
} from './graph-view';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MINUTE = 60_000;

const MANAGER = {
  agentLabel: 'Claude',
  model: 'opus',
  working: false,
  lastActivityAt: new Date(FIXTURE_NOW - 3 * MINUTE).toISOString(),
};

const settle = async (): Promise<void> => {
  for (let round = 0; round < 40; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
};

describe('wholeFit', () => {
  it('fits the whole graph, the taller side deciding, centred, never past 1', () => {
    expect(
      wholeFit({ width: 800, height: 1200 }, { width: 1000, height: 632 }),
    ).toEqual({ x: 300, y: 16, zoom: 0.5 });
    expect(
      wholeFit({ width: 400, height: 300 }, { width: 1000, height: 632 }),
    ).toEqual({ x: 300, y: 166, zoom: 1 });
  });
});

describe('widthFit', () => {
  it('shrinks a wide graph to the canvas width, from the top, never under the minimum zoom', () => {
    expect(widthFit({ width: 2000 }, { width: 1016 })).toEqual({
      x: 16,
      y: 16,
      zoom: 0.492,
    });
    expect(widthFit({ width: 40_000 }, { width: 1016 }).zoom).toBe(0.25);
  });

  it('centres a narrow graph at its own size rather than zooming it in', () => {
    expect(widthFit({ width: 400 }, { width: 1000 })).toEqual({
      x: 300,
      y: 16,
      zoom: 1,
    });
  });
});

describe('GraphView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    stubResizeObserver();
    vi.stubGlobal(
      'DOMMatrixReadOnly',
      class {
        m22 = 1;
      },
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function draw(
    overrides: Partial<React.ComponentProps<typeof GraphView>> = {},
  ): Promise<void> {
    act(() => {
      root.render(
        <GraphView
          manager={MANAGER}
          pendingStarts={0}
          threads={[]}
          contacts={{}}
          pulses={[]}
          now={FIXTURE_NOW}
          narrow={false}
          onOpen={() => undefined}
          asking={new Map()}
          onAnswer={() => undefined}
          {...overrides}
        />,
      );
    });
    await settle();
  }

  const all = (slot: string): HTMLElement[] =>
    Array.from(
      container.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`),
    );

  function threadCard(threadId: string): HTMLElement {
    const card = container.querySelector<HTMLElement>(
      `[data-slot="graph-thread"][data-thread-id="${threadId}"] [data-slot="thread-card"]`,
    );
    if (card === null) {
      throw new Error(`no thread card for ${threadId}`);
    }
    return card;
  }

  function nodeY(slot: string, id?: string): number {
    const inner = container.querySelector<HTMLElement>(
      id === undefined
        ? `[data-slot="${slot}"]`
        : `[data-slot="${slot}"][data-thread-id="${id}"]`,
    )!;
    const wrapper = inner.closest<HTMLElement>('.react-flow__node')!;
    return Number(
      /translate\(\s*[-\d.]+px,\s*([-\d.]+)px\)/.exec(
        wrapper.style.transform,
      )![1],
    );
  }

  it('heads the tree with the manager and hangs every thread under it as a card, wires going down', async () => {
    await draw({ threads: graphThreadsOf(4) });

    expect(all('graph-manager')).toHaveLength(1);
    expect(all('graph-thread')).toHaveLength(4);
    expect(all('contact-edge')).toHaveLength(4);
    const managerY = nodeY('graph-manager');
    for (const id of ['thread-1', 'thread-2', 'thread-3', 'thread-4']) {
      expect(nodeY('graph-thread', id)).toBeGreaterThan(managerY);
    }
  });

  it('stands the threads in bands by attention: blocked on top, then working, questions, quiet, inactive last', async () => {
    const threads = graphThreadsOf(10);
    await draw({ threads });

    const graph = all('command-center-graph')[0]!;
    expect(graph.dataset.layout).toBe('bands');
    const order = [
      'blocked',
      'working',
      'question',
      'quiet',
      'inactive',
    ] as const;
    const bandY = (attention: (typeof order)[number]): number[] =>
      threads
        .filter((thread) => thread.view.attention === attention)
        .map((thread) => nodeY('graph-thread', thread.id));
    for (let band = 1; band < order.length; band += 1) {
      expect(Math.min(...bandY(order[band]!))).toBeGreaterThan(
        Math.max(...bandY(order[band - 1]!)),
      );
    }
  });

  it('sizes each card to what it shows, with no padding to a common height', async () => {
    await draw({ threads: graphThreadsOf(6) });

    expect(
      new Set(all('thread-card').map((card) => card.style.height)).size,
    ).toBeGreaterThan(1);
  });

  it('keys the colours in a legend, with how many threads stand in each band', async () => {
    await draw({ threads: graphThreadsOf(10) });

    const items = all('graph-legend-item').map((item) => item.textContent);
    expect(items).toEqual([
      'Blocked2',
      'Working2',
      'Question2',
      'Quiet2',
      'Inactive a day+2',
    ]);
  });

  it('shows on the manager what it runs: its agent, threads, working, awaiting replies and starts waiting', async () => {
    const contacts: Record<string, ContactState> = {
      'thread-2': {
        lastAt: new Date(FIXTURE_NOW - 40 * MINUTE).toISOString(),
        awaitingReply: true,
      },
    };
    await draw({
      threads: graphThreadsOf(5),
      contacts,
      pendingStarts: 2,
      manager: { ...MANAGER, working: true },
    });

    const manager = all('graph-manager')[0]!;
    expect(
      manager.querySelector('[data-slot="graph-manager-state"]')!.textContent,
    ).toBe('Working');
    expect(
      manager.querySelector('[data-slot="graph-manager-line"]')!.textContent,
    ).toBe('Claude · opus · active 3m ago');
    expect(all('graph-manager-threads')[0]!.textContent).toBe('5threads');
    expect(all('graph-manager-working')[0]!.textContent).toBe('2working');
    expect(all('graph-manager-awaiting')[0]!.textContent).toBe(
      '1awaiting reply',
    );
    expect(all('graph-manager-starts')[0]!.textContent).toBe('2Starts waiting');
  });

  it('keeps the manager on top before its chat exists', async () => {
    await draw({ manager: null, threads: graphThreadsOf(2) });
    const manager = all('graph-manager')[0]!;

    expect(manager.dataset.started).toBe('false');
    expect(manager.textContent).toContain('Not started');
  });

  it('opens nothing from the manager node: it is a summary, not a button', async () => {
    await draw({ threads: graphThreadsOf(2) });
    const manager = all('graph-manager')[0]!;

    expect(manager.tagName).toBe('SECTION');
    expect(manager.querySelector('button')).toBeNull();
  });

  it('draws at most 24 thread cards and one "+N more" node for the rest', async () => {
    await draw({ threads: graphThreadsOf(30) });

    expect(all('graph-thread')).toHaveLength(MAX_THREAD_NODES);
    expect(all('graph-more')[0]?.textContent).toBe('+6 more threads');
  });

  it('draws the 24 that need the user most, the still ones left to "+N more"', () => {
    const shown = shownThreads(graphThreadsOf(30));
    const rank = (thread: GraphThread): number =>
      ['blocked', 'working', 'question', 'quiet', 'inactive'].indexOf(
        thread.view.attention,
      );

    expect(shown).toHaveLength(MAX_THREAD_NODES);
    expect(shown.map(rank)).toEqual([...shown.map(rank)].sort((a, b) => a - b));
    expect(
      shown.filter((thread) => thread.view.attention === 'inactive').length,
    ).toBeLessThan(
      graphThreadsOf(30).filter(
        (thread) => thread.view.attention === 'inactive',
      ).length,
    );
  });

  it('opens a thread only from its Go to thread button, never from a click on the card', async () => {
    const onOpen = vi.fn();
    await draw({ threads: graphThreadsOf(3), onOpen });

    act(() => threadCard('thread-2').click());
    expect(onOpen).not.toHaveBeenCalled();

    act(() =>
      threadCard('thread-2')
        .querySelector<HTMLButtonElement>('[data-slot="thread-card-go"]')!
        .click(),
    );
    expect(onOpen).toHaveBeenCalledWith('thread-2');
  });

  it('offers Answer only on a thread holding a card for the user, and answers it here rather than opening it', async () => {
    const onAnswer = vi.fn();
    const onOpen = vi.fn();
    await draw({
      threads: graphThreadsOf(3),
      asking: new Map([['thread-2', 'approval' as const]]),
      onAnswer,
      onOpen,
    });

    expect(
      threadCard('thread-1').querySelector('[data-slot="thread-card-answer"]'),
    ).toBeNull();
    expect(
      threadCard('thread-2').querySelector('[data-slot="thread-card-answer"]')!
        .textContent,
    ).toBe('Review');
    act(() =>
      threadCard('thread-2')
        .querySelector<HTMLButtonElement>('[data-slot="thread-card-answer"]')!
        .click(),
    );
    expect(onAnswer).toHaveBeenCalledWith('thread-2');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows a thread’s board card as a label on its node, with no node of its own', async () => {
    await draw({ threads: graphThreadsOf(3) });

    expect(
      threadCard('thread-1').querySelector(
        '[data-slot="thread-card-board-card"]',
      )!.textContent,
    ).toContain('QA-1');
    expect(
      threadCard('thread-2').querySelector(
        '[data-slot="thread-card-board-card"]',
      ),
    ).toBeNull();
    expect(all('graph-task')).toHaveLength(0);
  });

  it('names each card’s contact state for a screen reader, and paints its wire to match', async () => {
    const contacts: Record<string, ContactState> = {
      'thread-1': {
        lastAt: new Date(FIXTURE_NOW - 2 * MINUTE).toISOString(),
        awaitingReply: false,
      },
      'thread-2': {
        lastAt: new Date(FIXTURE_NOW - 40 * MINUTE).toISOString(),
        awaitingReply: true,
      },
    };
    await draw({ threads: graphThreadsOf(3), contacts });
    const state = (id: string) =>
      container
        .querySelector(`[data-edge="contact:${id}"]`)
        ?.getAttribute('data-state');

    expect(threadCard('thread-2').getAttribute('aria-label')).toBe(
      'Rebase billing on main, Waiting on you, Question, awaiting a reply, last contact 40m ago',
    );
    expect(state('thread-1')).toBe('lit');
    expect(state('thread-2')).toBe('awaiting');
    expect(state('thread-3')).toBe('idle');
  });

  it('keeps every wire drawn when a reply rebuilds the cards, its state moving from awaiting to lit', async () => {
    const threads = graphThreadsOf(3);
    const sentAt = new Date(FIXTURE_NOW - MINUTE).toISOString();
    await draw({
      threads,
      contacts: { 'thread-1': { lastAt: sentAt, awaitingReply: true } },
    });
    expect(all('contact-edge')).toHaveLength(3);

    await draw({
      threads: threads.map((thread) => ({ ...thread })),
      contacts: {
        'thread-1': {
          lastAt: new Date(FIXTURE_NOW).toISOString(),
          awaitingReply: false,
        },
      },
    });

    expect(all('contact-edge')).toHaveLength(3);
    expect(
      container
        .querySelector('[data-edge="contact:thread-1"]')
        ?.getAttribute('data-state'),
    ).toBe('lit');
  });

  it('lets the pointer reach every node, so a card answers the mouse', async () => {
    await draw({ threads: graphThreadsOf(2) });

    const wrappers = Array.from(
      container.querySelectorAll<HTMLElement>('.react-flow__node'),
    );
    expect(wrappers.length).toBeGreaterThan(0);
    for (const wrapper of wrappers) {
      expect(wrapper.style.pointerEvents).toBe('all');
    }
  });

  it('lays a phone out as one column it scrolls, every card under the manager in attention order', async () => {
    const threads = graphThreadsOf(4);
    await draw({ threads, narrow: true });

    const graph = all('command-center-graph')[0]!;
    expect(graph.dataset.layout).toBe('column');
    const ys = shownThreads(threads).map((thread) =>
      nodeY('graph-thread', thread.id),
    );
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(ys[0]).toBeGreaterThan(nodeY('graph-manager'));
    expect(all('contact-edge')).toHaveLength(4);
  });
});
