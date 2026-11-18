// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type WorkingThread, WorkingThreadsCard } from './working-threads-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-17T12:00:00.000Z');

let container: HTMLElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function thread(over: Partial<WorkingThread>): WorkingThread {
  return {
    runId: 'run-1',
    title: 'Export the CSV',
    agentLabel: 'Senior Engineer',
    agentKind: 'claude',
    startedAt: new Date(NOW - 195_000).toISOString(),
    status: 'working',
    ...over,
  };
}

function render(
  threads: readonly WorkingThread[],
  options: { beside?: boolean; onOpenThread?: (runId: string) => void } = {},
): HTMLElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <WorkingThreadsCard
        threads={threads}
        beside={options.beside ?? false}
        onOpenThread={options.onOpenThread}
      />,
    );
  });
  return container;
}

const slot = (el: Element, name: string): HTMLElement | null =>
  el.querySelector<HTMLElement>(`[data-slot="${name}"]`);

const rowsOf = (el: Element): HTMLElement[] =>
  Array.from(
    el.querySelectorAll<HTMLElement>('[data-slot="working-thread-row"]'),
  );

async function openPanel(el: Element): Promise<void> {
  await act(async () => {
    slot(el, 'working-threads-toggle')!
      .querySelector('button')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('WorkingThreadsCard', () => {
  it('draws nothing with no thread to list', () => {
    const el = render([]);

    expect(slot(el, 'working-threads-card')).toBeNull();
  });

  it('counts the working threads and the ones waiting on the user', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const el = render([
      thread({ runId: 'a' }),
      thread({ runId: 'b' }),
      thread({ runId: 'c', status: 'waiting' }),
    ]);

    expect(slot(el, 'working-threads-count')!.textContent).toBe(
      '2 working · 1 waiting on you',
    );
  });

  it('leaves out the waiting count when nobody waits', () => {
    const el = render([thread({ runId: 'a' }), thread({ runId: 'b' })]);

    expect(slot(el, 'working-threads-count')!.textContent).toBe('2 working');
  });

  it('leaves out the working count when every thread waits', () => {
    const el = render([thread({ status: 'waiting' })]);

    expect(slot(el, 'working-threads-count')!.textContent).toBe(
      '1 waiting on you',
    );
  });

  it('sits in the corner alone', () => {
    const el = render([thread({})]);

    const card = slot(el, 'working-threads-card')!;
    expect(card.className).toContain('right-4');
    expect(card.className).toContain('-bottom-2');
  });

  it('sits left of the agents card beside it', () => {
    const el = render([thread({})], { beside: true });

    const card = slot(el, 'working-threads-card')!;
    expect(card.className).toContain('right-14');
    expect(card.className).not.toContain('right-4');
  });

  it('lists each thread once the panel is pinned, with its agent and how long it has run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const el = render([
      thread({ runId: 'a', title: 'Export the CSV' }),
      thread({
        runId: 'b',
        title: 'Fix the parser',
        agentLabel: null,
        agentKind: 'codex',
        startedAt: null,
        status: 'waiting',
      }),
    ]);

    await openPanel(el);

    const [first, second] = rowsOf(el);
    expect(rowsOf(el).map((row) => row.dataset.run)).toEqual(['a', 'b']);
    expect(first!.textContent).toContain('Export the CSV');
    expect(first!.textContent).toContain('Senior Engineer');
    expect(slot(first!, 'working-thread-elapsed')!.textContent).toBe(
      'for 3m 15s',
    );
    expect(second!.textContent).toContain('Fix the parser');
    expect(second!.textContent).toContain('waiting on you');
    expect(slot(second!, 'working-thread-elapsed')).toBeNull();
  });

  it('shows a working thread with a primary pulse and a waiting one in the warning tone', async () => {
    const el = render([
      thread({ runId: 'a' }),
      thread({ runId: 'b', status: 'waiting' }),
    ]);

    await openPanel(el);

    const [working, waiting] = rowsOf(el);
    expect(slot(working!, 'working-thread-dot')!.dataset.status).toBe(
      'working',
    );
    expect(slot(waiting!, 'working-thread-dot')!.dataset.status).toBe(
      'waiting',
    );
    expect(
      slot(waiting!, 'working-thread-dot')!
        .querySelector('[data-slot="status-dot"]')!
        .getAttribute('data-tone'),
    ).toBe('warn');
  });

  it('Go to thread opens that thread by its run', async () => {
    const onOpenThread = vi.fn();
    const el = render([thread({ runId: 'a' }), thread({ runId: 'b' })], {
      onOpenThread,
    });
    await openPanel(el);

    const button = rowsOf(el)[1]!.querySelector('button')!;
    expect(button.textContent).toBe('Go to thread');
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith('b');
  });

  it('offers no Go to thread button when nothing can open the thread', async () => {
    const el = render([thread({})]);
    await openPanel(el);

    expect(rowsOf(el)[0]!.querySelector('button')).toBeNull();
  });
});
