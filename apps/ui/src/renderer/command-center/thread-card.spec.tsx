// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ThreadAttention,
  ThreadCard,
  threadCardHeight,
  type ThreadCardProps,
  type ThreadCardStatus,
} from './thread-card';

const NOW = Date.parse('2026-11-17T12:00:00Z');

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

function props(over: Partial<ThreadCardProps> = {}): ThreadCardProps {
  return {
    title: 'Fix the login redirect',
    status: 'working',
    statusText: 'Working',
    attention: 'working',
    project: 'Geniro',
    agentLabel: 'claude',
    isTeam: false,
    crew: null,
    pullRequest: null,
    note: null,
    lastMessage: null,
    boardCard: null,
    idleDays: null,
    lastAt: new Date(NOW - 5 * 60_000).toISOString(),
    now: NOW,
    onGo: vi.fn(),
    ...over,
  };
}

function render(over: Partial<ThreadCardProps> = {}): HTMLElement {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<ThreadCard {...props(over)} />);
  });
  return container.querySelector<HTMLElement>('[data-slot="thread-card"]')!;
}

describe('ThreadCard — going to the thread', () => {
  it('opens nothing when the card itself is clicked', () => {
    const onGo = vi.fn();
    const el = render({ onGo });

    act(() => {
      el.click();
    });

    expect(onGo).not.toHaveBeenCalled();
    expect(el.getAttribute('role')).toBeNull();
  });

  it('goes to the thread from its Go to thread button', () => {
    const onGo = vi.fn();
    const button = render({ onGo }).querySelector<HTMLButtonElement>(
      '[data-slot="thread-card-go"]',
    )!;

    expect(button.textContent).toContain('Go to thread');
    act(() => {
      button.click();
    });

    expect(onGo).toHaveBeenCalledTimes(1);
  });
});

describe('ThreadCard — content', () => {
  it.each<[ThreadCardStatus, string]>([
    ['working', 'Working'],
    ['waiting', 'Awaiting reply'],
    ['idle', 'Idle'],
    ['failed', 'Needs approval'],
    ['done', 'Done'],
  ])(
    'puts the words it is given for the %s status on its chip',
    (status, text) => {
      const el = render({ status, statusText: text });

      const line = el.querySelector<HTMLElement>(
        '[data-slot="thread-card-status"]',
      )!;
      expect(line.textContent).toContain(text);
      expect(el.dataset.status).toBe(status);
    },
  );

  it('pulses its dot only while the thread works', () => {
    expect(
      render({ attention: 'working' }).querySelector(
        '[data-slot="thread-card-dot-ping"]',
      ),
    ).not.toBeNull();
    expect(
      render({ attention: 'quiet' }).querySelector(
        '[data-slot="thread-card-dot-ping"]',
      ),
    ).toBeNull();
  });

  it.each<[ThreadAttention, string]>([
    ['blocked', 'bg-destructive/5'],
    ['working', 'bg-success/5'],
    ['question', 'bg-warning/10'],
    ['quiet', 'bg-card'],
    ['inactive', 'opacity-70'],
  ])('colours a %s card by where it stands', (attention, tint) => {
    const el = render({ attention });

    expect(el.dataset.attention).toBe(attention);
    expect(el.classList.contains(tint)).toBe(true);
  });

  it('keeps a long title on one line, whole in its tooltip', () => {
    const long = 'A long thread title '.repeat(12).trim();
    const el = render({ title: long });

    const title = el.querySelector<HTMLElement>(
      '[data-slot="thread-card-title"]',
    )!;
    expect(title.classList.contains('truncate')).toBe(true);
    expect(title.title).toBe(long);
  });

  it('is exactly as tall as the graph laid it out for what it shows, and no taller', () => {
    const view = { note: 'watch billing', lastMessage: 'running tests' };
    const el = render({ ...view, idleDays: 4 });

    expect(el.style.height).toBe(`${threadCardHeight(view)}px`);
    const bare = threadCardHeight({ note: null, lastMessage: null });
    const oneLine = threadCardHeight({ note: null, lastMessage: 'short' });
    const twoLines = threadCardHeight({
      note: null,
      lastMessage:
        'a longer message that cannot fit on a single line of the card',
    });
    expect(bare).toBeLessThan(oneLine);
    expect(oneLine).toBeLessThan(twoLines);
  });

  it('draws the manager note when there is one, and nothing when there is not', () => {
    const withNote = render({ note: 'Waiting for the CI run' });
    expect(
      withNote.querySelector('[data-slot="thread-card-note"]')!.textContent,
    ).toBe('Waiting for the CI run');

    const without = render({ note: null });
    expect(without.querySelector('[data-slot="thread-card-note"]')).toBeNull();
  });

  it('shows the pull request with its number and state word', () => {
    const el = render({ pullRequest: { number: 412, state: 'merged' } });

    const chip = el.querySelector<HTMLElement>(
      '[data-slot="thread-card-pull-request"]',
    )!;
    expect(chip.textContent).toContain('412');
    expect(chip.textContent).toContain('merged');
  });

  it('draws no pull request chip when the thread has none', () => {
    const el = render({ pullRequest: null });

    expect(
      el.querySelector('[data-slot="thread-card-pull-request"]'),
    ).toBeNull();
  });

  it('labels the agent, or the team by its name, and the project — never the roster handle', () => {
    const el = render({ agentLabel: 'claude', project: 'Geniro' });

    expect(
      el.querySelector('[data-slot="thread-card-agent"]')!.textContent,
    ).toBe('claude');
    expect(
      el.querySelector('[data-slot="thread-card-project"]')!.textContent,
    ).toBe('Geniro');
    expect(el.textContent).not.toMatch(/\bt\d+\b/);
    expect(
      render({ agentLabel: 'dev-team', isTeam: true })
        .querySelector('[data-slot="thread-card-agent"]')!
        .getAttribute('title'),
    ).toBe('Team dev-team');
  });

  it('previews the latest message as the thread list does, when there is one', () => {
    expect(
      render({ lastMessage: 'running the test suite' }).querySelector(
        '[data-slot="thread-card-message"]',
      )!.textContent,
    ).toBe('running the test suite');
    expect(
      render({ lastMessage: null }).querySelector(
        '[data-slot="thread-card-message"]',
      ),
    ).toBeNull();
  });

  it('previews it as plain text, with no markdown markers', () => {
    const line = render({
      lastMessage: '**Rebased** on `main` — see [the PR](https://x.test/1)',
    }).querySelector('[data-slot="thread-card-message"]')!;

    expect(line.textContent).toBe('Rebased on main — see the PR');
  });

  it('drops a backtick a cut-off code span left open', () => {
    const line = render({
      lastMessage: 'Told `8bbdf9e6-0a39-4d4d-a…',
    }).querySelector('[data-slot="thread-card-message"]')!;

    expect(line.textContent).toBe('Told 8bbdf9e6-0a39-4d4d-a…');
  });

  it('says when the thread last moved beside its Go to thread button', () => {
    expect(
      render().querySelector('[data-slot="thread-card-time"]')!.textContent,
    ).toBe('5m');
  });

  it('dates a thread older than a week the way the thread list does', () => {
    expect(
      render({ lastAt: '2026-11-02T12:00:00Z', idleDays: 15 }).querySelector(
        '[data-slot="thread-card-time"]',
      )!.textContent,
    ).toBe('Nov 2');
  });

  it('stands as tall as its row asks, but never shorter than its content', () => {
    const own = threadCardHeight({ note: null, lastMessage: null });

    expect(render({ height: own + 40 }).style.height).toBe(`${own + 40}px`);
    expect(render({ height: own - 40 }).style.height).toBe(`${own}px`);
  });

  it('draws no timeline strip', () => {
    expect(render().querySelector('[data-slot="timeline-strip"]')).toBeNull();
  });
});

describe('ThreadCard — labels', () => {
  it('shows the board card it works as a label, and none for a thread without one', () => {
    const label = render({
      boardCard: {
        identifier: 'GEN-412',
        title: 'Fix login',
        status: 'in_progress',
      },
    }).querySelector('[data-slot="thread-card-board-card"]')!;

    expect(label.textContent).toBe('GEN-412');
    expect(label.getAttribute('title')).toContain('In progress');
    expect(
      render({ boardCard: null }).querySelector(
        '[data-slot="thread-card-board-card"]',
      ),
    ).toBeNull();
  });

  it('marks a thread nobody touched for days with a moon by its time, and only such a thread', () => {
    expect(
      render({ idleDays: 6 })
        .querySelector('[data-slot="thread-card-idle"]')!
        .getAttribute('aria-label'),
    ).toBe('Nobody has touched this thread for 6 days');
    expect(
      render({ idleDays: null }).querySelector(
        '[data-slot="thread-card-idle"]',
      ),
    ).toBeNull();
  });
});

describe('ThreadCard — motion and faces', () => {
  it('breathes while the thread works, and in warning while it waits on the user', () => {
    expect(
      render({ attention: 'working' }).classList.contains('cc-breathe-success'),
    ).toBe(true);
    const asking = render({ attention: 'question', onAnswer: vi.fn() });
    expect(asking.classList.contains('cc-breathe-warning')).toBe(true);
    expect(asking.classList.contains('cc-breathe-success')).toBe(false);
    expect(
      render({ attention: 'quiet' }).className.includes('cc-breathe'),
    ).toBe(false);
  });

  it('wears a team run’s member faces, and none for one agent', () => {
    const team = render({
      isTeam: true,
      agentLabel: 'dev-team',
      crew: {
        people: [
          { key: 'a', name: 'Nick Fury', avatar: null },
          { key: 'b', name: 'Tony Stark', avatar: null },
        ],
        total: 6,
      },
    });
    const crew = team.querySelector<HTMLElement>(
      '[data-slot="thread-card-crew"]',
    )!;

    expect(crew.getAttribute('aria-label')).toBe('6 members');
    expect(crew.querySelectorAll('[data-slot="avatar"]')).toHaveLength(2);
    expect(
      crew.querySelector('[data-slot="avatar-stack-rest"]')!.textContent,
    ).toBe('+4');
    expect(
      render({ crew: null }).querySelector('[data-slot="thread-card-crew"]'),
    ).toBeNull();
  });
});
