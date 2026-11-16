// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionNotice, DEFAULT_ACTION_NOTICE_MS } from './action-notice';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function renderNotice(
  props: Partial<React.ComponentProps<typeof ActionNotice>>,
): void {
  act(() => {
    root.render(
      <ActionNotice
        icon="💡"
        title="Learning from “Refactor the parser”"
        onDismiss={vi.fn()}
        {...props}
      />,
    );
  });
}

function noticeOf(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-slot="action-notice"]')!;
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function hover(target: HTMLElement, entering: boolean): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(entering ? 'mouseover' : 'mouseout', {
        bubbles: true,
      }),
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('ActionNotice', () => {
  it('withdraws itself after eight seconds by default', () => {
    const onDismiss = vi.fn();
    renderNotice({ onDismiss });

    advance(DEFAULT_ACTION_NOTICE_MS - 1);
    expect(onDismiss).not.toHaveBeenCalled();

    advance(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('withdraws after the duration it is given', () => {
    const onDismiss = vi.fn();
    renderNotice({ onDismiss, durationMs: 2_000 });

    advance(1_999);
    expect(onDismiss).not.toHaveBeenCalled();

    advance(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a pointer over it pauses the countdown, and leaving resumes it with the time left', () => {
    const onDismiss = vi.fn();
    renderNotice({ onDismiss, durationMs: 10_000 });

    advance(4_000);
    hover(noticeOf(), true);
    advance(60_000);
    expect(onDismiss).not.toHaveBeenCalled();

    hover(noticeOf(), false);
    advance(5_999);
    expect(onDismiss).not.toHaveBeenCalled();

    advance(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('the close control dismisses it at once', () => {
    const onDismiss = vi.fn();
    renderNotice({ onDismiss });

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!
        .click();
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('draws its title and detail each on one line, the detail muted', () => {
    renderNotice({
      title: 'Learning from “A very long thread title”',
      detail: 'claude-haiku-5-5 · ≈$0.02 · $0.12 today',
    });

    const title = noticeOf().querySelector<HTMLElement>(
      '[data-slot="action-notice-title"]',
    )!;
    const detail = noticeOf().querySelector<HTMLElement>(
      '[data-slot="action-notice-detail"]',
    )!;
    expect(title.textContent).toBe('Learning from “A very long thread title”');
    expect(title.className).toContain('truncate');
    expect(detail.textContent).toBe('claude-haiku-5-5 · ≈$0.02 · $0.12 today');
    expect(detail.className).toContain('text-muted-foreground');
  });

  it('draws the icon in its own cell, beside the text', () => {
    renderNotice({ icon: '💡' });

    expect(
      noticeOf().querySelector('[data-slot="action-notice-icon"]')?.textContent,
    ).toBe('💡');
  });

  it('draws no detail line when it has none', () => {
    renderNotice({});

    expect(
      noticeOf().querySelector('[data-slot="action-notice-detail"]'),
    ).toBeNull();
  });

  it('draws one quiet action that runs its own handler', () => {
    const skip = vi.fn();
    renderNotice({ action: { label: 'Skip', onAction: skip } });

    const buttons = [
      ...noticeOf().querySelectorAll<HTMLButtonElement>('button'),
    ];
    const action = buttons.find((button) => button.textContent === 'Skip')!;
    expect(action.className).toContain('shrink-0');
    expect(
      buttons.filter((button) => button.textContent === 'Skip'),
    ).toHaveLength(1);

    act(() => action.click());
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it('draws no action when it has none', () => {
    renderNotice({});

    expect(noticeOf().textContent).not.toContain('Skip');
  });

  it('announces itself politely, as a status', () => {
    renderNotice({});

    expect(noticeOf().getAttribute('role')).toBe('status');
    expect(noticeOf().textContent).toContain('Learning from');
  });
});
