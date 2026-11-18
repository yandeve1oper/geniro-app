// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type AppView, NavRail } from './nav-rail';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function rail(
  view: AppView,
  onNavigate: (next: AppView) => void = () => undefined,
  collapsed = false,
  onToggleCollapsed: () => void = () => undefined,
): HTMLDivElement {
  return render(
    <NavRail
      view={view}
      onNavigate={onNavigate}
      collapsed={collapsed}
      hydrated
      onToggleCollapsed={onToggleCollapsed}
    />,
  );
}

const buttonNamed = (el: HTMLElement, label: string): HTMLButtonElement =>
  [...el.querySelectorAll('button')].find(
    (node) => node.textContent === label,
  ) as HTMLButtonElement;

describe('NavRail', () => {
  it('reaches every AppView — a member added to the union without a nav entry is unreachable', () => {
    // The union's OWN members, not a list of labels: as a `Record<AppView, …>`
    // this fails `check-types` the moment a view is added without a row here,
    // and then fails at runtime if that row never reaches the rail. Both halves
    // are load-bearing. The rail's item lists are plain arrays and App's render
    // arms are a conditional chain, so nothing else in the build catches a view
    // that type-checks, ships, and cannot be opened.
    const LABELS: Record<AppView, string> = {
      chats: 'Chats',
      'command-center': 'Command center',
      teams: 'Teams',
      tasks: 'Tasks',
      projects: 'Projects',
      knowledge: 'Knowledge',
      stats: 'Stats',
      settings: 'Settings',
    };
    const el = rail('chats');

    const missing = Object.values(LABELS).filter(
      (label) => buttonNamed(el, label) === undefined,
    );

    expect(missing).toEqual([]);
  });

  it('counts what waits on the user beside a destination, and draws nothing at zero', () => {
    const waiting = render(
      <NavRail
        view="chats"
        onNavigate={() => undefined}
        collapsed={false}
        hydrated
        onToggleCollapsed={() => undefined}
        counts={{ knowledge: 3 }}
      />,
    );
    expect(buttonNamed(waiting, 'Knowledge3')).toBeDefined();

    const collapsed = render(
      <NavRail
        view="chats"
        onNavigate={() => undefined}
        collapsed
        hydrated
        onToggleCollapsed={() => undefined}
        counts={{ knowledge: 3 }}
      />,
    );
    expect(
      collapsed.querySelector('[aria-label="Knowledge, 3 waiting"]'),
    ).not.toBeNull();
    expect(rail('chats').querySelector('[data-slot="nav-count"]')).toBeNull();
  });

  it('navigates to each destination it offers', () => {
    // Pairs with the test above: presence alone would pass for a button wired
    // to nothing, which is the same unreachable view seen one step later.
    for (const [view, label] of Object.entries({
      chats: 'Chats',
      'command-center': 'Command center',
      teams: 'Teams',
      tasks: 'Tasks',
      projects: 'Projects',
      knowledge: 'Knowledge',
      stats: 'Stats',
      settings: 'Settings',
    } satisfies Record<AppView, string>)) {
      const onNavigate = vi.fn();
      const el = rail(view === 'chats' ? 'settings' : 'chats', onNavigate);

      buttonNamed(el, label).click();

      expect(onNavigate).toHaveBeenCalledWith(view);
    }
  });

  it('offers every top-level destination', () => {
    const el = rail('chats');

    for (const label of ['Chats', 'Teams', 'Stats', 'Settings']) {
      expect(buttonNamed(el, label)).toBeTruthy();
    }
  });

  it('navigates to Stats when its row is clicked', () => {
    const onNavigate = vi.fn();
    const el = rail('chats', onNavigate);

    act(() => {
      buttonNamed(el, 'Stats').click();
    });

    expect(onNavigate).toHaveBeenCalledWith('stats');
  });

  it('marks the current destination for assistive tech', () => {
    const el = rail('stats');

    expect(buttonNamed(el, 'Stats').getAttribute('aria-current')).toBe('page');
    expect(buttonNamed(el, 'Chats').getAttribute('aria-current')).toBeNull();
  });

  it('keeps Settings pinned below the primary destinations', () => {
    const el = rail('chats');
    const labels = [...el.querySelectorAll('button')]
      .map((node) => node.textContent)
      .filter((text): text is string =>
        ['Chats', 'Teams', 'Tasks', 'Projects', 'Stats', 'Settings'].includes(
          text ?? '',
        ),
      );

    // Stats is a primary destination, so it belongs with Chats and Teams
    // rather than in the utility group Settings sits in; Projects follows Tasks.
    expect(labels).toEqual([
      'Chats',
      'Teams',
      'Tasks',
      'Projects',
      'Stats',
      'Settings',
    ]);
  });

  it('keeps its own width toggle, in both directions', () => {
    // It moved to the title bar with everything else and moved straight back:
    // it acts on THIS column rather than on the window, so it belongs to the
    // column ("let's leave it in the menu itself, in the same place it was").
    const pressed: string[] = [];
    const open = rail(
      'chats',
      () => undefined,
      false,
      () => pressed.push('x'),
    );
    const toggle = open.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse menu"]',
    );
    expect(toggle).toBeTruthy();
    act(() => {
      toggle?.click();
    });
    expect(pressed).toEqual(['x']);

    act(() => {
      root?.unmount();
    });
    container?.remove();
    expect(
      rail('chats', () => undefined, true).querySelector(
        '[aria-label="Expand menu"]',
      ),
    ).toBeTruthy();
  });
});
