// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BottomTabBar } from './bottom-tab-bar';
import type { AppView } from './nav-rail';

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

function render(
  view: AppView,
  onNavigate: (next: AppView) => void = () => undefined,
): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<BottomTabBar view={view} onNavigate={onNavigate} />);
  });
  return container;
}

const tabs = (el: HTMLElement): HTMLButtonElement[] => [
  ...el.querySelectorAll<HTMLButtonElement>('nav[aria-label="Main"] button'),
];

describe('BottomTabBar', () => {
  it('offers every destination the rail does, in the rail’s order', () => {
    const labels = tabs(render('chats')).map((tab) =>
      tab.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'Chats',
      'Command center',
      'Teams',
      'Tasks',
      'Projects',
      'Knowledge',
      'Stats',
      'Settings',
    ]);
  });

  it('marks the current view as the page and only that one', () => {
    const current = tabs(render('tasks')).filter(
      (tab) => tab.getAttribute('aria-current') === 'page',
    );
    expect(current.map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'Tasks',
    ]);
  });

  it('navigates to the tab pressed', () => {
    const onNavigate = vi.fn();
    const el = render('chats', onNavigate);
    const settings = tabs(el).find(
      (tab) => tab.getAttribute('aria-label') === 'Settings',
    )!;
    act(() => {
      settings.click();
    });
    expect(onNavigate).toHaveBeenCalledWith('settings');
  });

  it('is drawn below `sm` only — the rail is the navigation at wider widths', () => {
    const nav = render('chats').querySelector('nav')!;
    expect(nav.classList.contains('sm:hidden')).toBe(true);
    expect(nav.classList.contains('max-sm:hidden')).toBe(false);
  });
});
