// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TIMELINE_FIXTURE_NOW, timelineFixtures } from './timeline-fixtures';
import {
  type TimelineEvent,
  TimelinePanel,
  type TimelinePanelProps,
} from './timeline-panel';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function props(over: Partial<TimelinePanelProps> = {}): TimelinePanelProps {
  return {
    events: timelineFixtures(),
    loading: false,
    error: null,
    hasMore: true,
    onLoadOlder: vi.fn(),
    onOpenThread: vi.fn(),
    now: TIMELINE_FIXTURE_NOW,
    ...over,
  };
}

function render(over: Partial<TimelinePanelProps> = {}): HTMLElement {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<TimelinePanel {...props(over)} />);
  });
  return container.querySelector<HTMLElement>(
    '[data-slot="command-center-timeline"]',
  )!;
}

function shownKinds(el: HTMLElement): string[] {
  return [
    ...el.querySelectorAll<HTMLElement>('[data-slot="timeline-event"]'),
  ].map((row) => row.dataset.kind ?? '');
}

function rowOf(el: HTMLElement, kind: TimelineEvent['kind']): HTMLElement {
  return el.querySelector<HTMLElement>(
    `[data-slot="timeline-event"][data-kind="${kind}"]`,
  )!;
}

describe('TimelinePanel — structure', () => {
  it('is a named region with an ordered list of rows and no filter', () => {
    const el = render();

    expect(el.tagName).toBe('SECTION');
    expect(el.getAttribute('aria-label')).toBe('Timeline');
    expect(el.querySelector('[data-slot="timeline-filter"]')).toBeNull();
    expect(el.querySelector('[data-slot="segmented-control"]')).toBeNull();
    const days = el.querySelectorAll('[data-slot="timeline-days"] > li');
    expect(days.length).toBe(4);
    for (const row of el.querySelectorAll('[data-slot="timeline-event"]')) {
      expect(row.tagName).toBe('LI');
      expect(row.parentElement!.tagName).toBe('OL');
    }
  });

  it('draws one row for every event, with its kind', () => {
    const el = render();

    expect(shownKinds(el)).toHaveLength(timelineFixtures().length);
    expect(new Set(shownKinds(el))).toEqual(
      new Set([
        'user_message',
        'manager_message',
        'thread_message',
        'thread_started',
        'start_requested',
        'pull_request',
        'question',
        'approval',
        'stage',
        'outcome',
        'failed',
      ]),
    );
  });
});

describe('TimelinePanel — days', () => {
  it('groups the events under Today, Yesterday and the short date of older ones, newest first', () => {
    const el = render();

    const headings = [
      ...el.querySelectorAll('[data-slot="timeline-days"] h3'),
    ].map((h) => h.textContent);
    const shortDate = (day: string): string =>
      new Date(`${day}T12:00:00`).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
    expect(headings).toEqual([
      'Today',
      'Yesterday',
      shortDate('2026-11-13'),
      shortDate('2026-11-12'),
    ]);
    const today = el.querySelectorAll(
      '[data-slot="timeline-days"] > li:first-child [data-slot="timeline-event"]',
    );
    expect(today).toHaveLength(8);
  });

  it('shows each event time as HH:mm', () => {
    const el = render();

    expect(
      rowOf(el, 'manager_message').querySelector('time')!.textContent,
    ).toBe('11:58');
    expect(
      rowOf(el, 'manager_message')
        .querySelector('time')!
        .getAttribute('datetime'),
    ).toBe(new Date('2026-11-17T11:58:00').toISOString());
  });
});

describe('TimelinePanel — empty', () => {
  it('says nothing is here when there is no event', () => {
    const el = render({ events: [], hasMore: false });

    expect(shownKinds(el)).toEqual([]);
    expect(el.textContent).toContain('Nothing here yet');
  });
});

describe('TimelinePanel — threads and messages', () => {
  it('opens the thread from its title link', () => {
    const onOpenThread = vi.fn();
    const el = render({ onOpenThread });

    act(() => {
      rowOf(el, 'pull_request')
        .querySelector<HTMLButtonElement>('[data-slot="timeline-thread-link"]')!
        .click();
    });

    expect(onOpenThread).toHaveBeenCalledWith('run-login');
  });

  it('names the pull request by its number', () => {
    const el = render();

    expect(rowOf(el, 'pull_request').textContent).toContain('opened PR #418');
  });

  it('gives a user message no thread link, only the words You wrote', () => {
    const el = render();

    const row = rowOf(el, 'user_message');
    expect(row.querySelector('[data-slot="timeline-thread-link"]')).toBeNull();
    expect(row.textContent).toContain('You wrote');
  });

  it('shows a thread row without a thread as plain text, not a link', () => {
    const el = render({
      events: [
        {
          id: 'evt-x',
          at: new Date('2026-11-17T08:15:00').toISOString(),
          kind: 'start_requested',
          threadRunId: null,
          threadTitle: 'Wire the thread-start conductor',
          text: null,
          detail: null,
          awaitingReply: false,
        },
      ],
    });

    const row = rowOf(el, 'start_requested');
    expect(row.querySelector('[data-slot="timeline-thread-link"]')).toBeNull();
    expect(row.textContent).toContain('Wire the thread-start conductor');
    expect(row.textContent).toContain('Start requested');
  });

  it('marks a manager message awaiting a reply, and only that one', () => {
    const el = render();

    expect(
      rowOf(el, 'manager_message').querySelector('[data-slot="badge"]')!
        .textContent,
    ).toBe('awaiting reply');
    expect(rowOf(el, 'question').textContent).not.toContain('awaiting reply');
    expect(rowOf(el, 'thread_message').textContent).not.toContain(
      'awaiting reply',
    );
  });

  it('colours an outcome that failed as a failure, and a finished one as a success', () => {
    const el = render();

    const outcomes = [
      ...el.querySelectorAll<HTMLElement>('[data-kind="outcome"]'),
    ];
    expect(outcomes).toHaveLength(2);
    const finished = outcomes.find((row) => row.textContent!.includes('done'))!;
    const failed = outcomes.find((row) => row.textContent!.includes('failed'))!;
    expect(
      finished.querySelector('span[aria-hidden="true"]')!.className,
    ).toContain('text-success');
    expect(
      failed.querySelector('span[aria-hidden="true"]')!.className,
    ).toContain('text-destructive');
  });
});

describe('TimelinePanel — loading and errors', () => {
  it('asks for older events from Load older', () => {
    const onLoadOlder = vi.fn();
    const el = render({ onLoadOlder });

    act(() => {
      el.querySelector<HTMLButtonElement>(
        '[data-slot="timeline-load-older"]',
      )!.click();
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('draws no Load older when nothing older is there', () => {
    const el = render({ hasMore: false });

    expect(el.querySelector('[data-slot="timeline-load-older"]')).toBeNull();
  });

  it('holds Load older while older events are on their way', () => {
    const el = render({ loading: true });

    const button = el.querySelector<HTMLButtonElement>(
      '[data-slot="timeline-load-older"]',
    )!;
    expect(button.disabled).toBe(true);
    expect(button.querySelector('svg')).not.toBeNull();
  });

  it('says it is loading, and nothing else, before any event has arrived', () => {
    const el = render({ events: [], loading: true, hasMore: false });

    expect(el.textContent).toContain('Loading the timeline');
    expect(el.textContent).not.toContain('Nothing here yet');
    expect(el.querySelector('[data-slot="timeline-days"]')).toBeNull();
  });

  it('shows an empty timeline as nothing here yet', () => {
    const el = render({ events: [], hasMore: false });

    expect(el.textContent).toContain('Nothing here yet');
    expect(el.querySelector('[data-slot="timeline-event"]')).toBeNull();
  });

  it('shows a load error in words, and does not claim the timeline is empty', () => {
    const el = render({
      events: [],
      hasMore: false,
      error: 'Could not load the timeline.',
    });

    const alert = el.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toBe('Could not load the timeline.');
    expect(el.textContent).not.toContain('Nothing here yet');
  });

  it('keeps the events it has when an older page fails', () => {
    const el = render({ error: 'Could not load older events.' });

    expect(el.querySelector('[role="alert"]')!.textContent).toBe(
      'Could not load older events.',
    );
    expect(shownKinds(el)).toHaveLength(timelineFixtures().length);
  });
});
