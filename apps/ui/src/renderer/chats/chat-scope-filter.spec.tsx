// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActivityPreset, ActivityWindow } from './activity-window';
import { ChatScopeFilter } from './chat-scope-filter';
import type { ChatListScope } from './use-chat-run';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(
  scope: ChatListScope,
  onChange: (next: ChatListScope) => void,
  extra: {
    window?: ActivityWindow | null;
    preset?: ActivityPreset;
    onWindowChange?: (
      preset: ActivityPreset,
      window: ActivityWindow | null,
    ) => void;
  } = {},
): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ChatScopeFilter
        scope={scope}
        onChange={onChange}
        window={extra.window ?? null}
        preset={extra.preset ?? 'any'}
        onWindowChange={extra.onWindowChange ?? vi.fn()}
      />,
    );
  });
  return host;
}

const trigger = (container: HTMLElement): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(
    'button[aria-label="Filter chats"]',
  )!;

const options = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[role="option"]'),
];

describe('ChatScopeFilter', () => {
  it('is ONE control, closed, until it is pressed', async () => {
    // The whole point of the replacement: a band of always-visible options
    // became one icon among the header's other three. A panel rendered without
    // a press is that band again under a different name.
    const container = await mount('active', vi.fn());

    expect(options(container)).toHaveLength(0);

    await act(async () => {
      trigger(container).click();
    });

    expect(options(container).map((el) => el.textContent)).toEqual([
      'Active chats',
      'Show all',
      'Archived only',
      'Any time',
      'Today',
      'Since yesterday',
      'This week',
      'Custom range…',
    ]);
    expect(container.textContent).toContain('Last active');
  });

  it('reports the scope the pressed row names', async () => {
    const onChange = vi.fn();
    const container = await mount('active', onChange);
    await act(async () => {
      trigger(container).click();
    });

    await act(async () => {
      options(container)
        .find((el) => el.textContent === 'Show all')!
        .click();
    });

    expect(onChange).toHaveBeenCalledWith('all');
    // And it closes behind the press — a filter panel left standing covers the
    // list it just changed.
    expect(options(container)).toHaveLength(0);
  });

  it('says which scope is current, in words and in tone', async () => {
    // A collapsed control owes its user this much: an icon identical in all
    // three states leaves "why is this thread missing?" unanswerable on screen.
    const active = await mount('active', vi.fn());
    expect(trigger(active).title).toContain('Active chats');
    const untoned = trigger(active).className;

    act(() => root!.unmount());
    host!.remove();

    const archived = await mount('archived', vi.fn());
    expect(trigger(archived).title).toContain('Archived only');
    expect(trigger(archived).className).not.toBe(untoned);
  });

  it('reports a window starting at local midnight for Today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 16, 15, 30));
    try {
      const onWindowChange = vi.fn();
      const container = await mount('active', vi.fn(), { onWindowChange });
      await act(async () => {
        trigger(container).click();
      });

      await act(async () => {
        options(container)
          .find((el) => el.textContent === 'Today')!
          .click();
      });

      expect(onWindowChange).toHaveBeenCalledWith('today', {
        since: new Date(2026, 10, 16).toISOString(),
        until: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports no window for Any time', async () => {
    const onWindowChange = vi.fn();
    const container = await mount('active', vi.fn(), {
      onWindowChange,
      preset: 'today',
      window: { since: '2026-11-16T00:00:00.000Z', until: null },
    });
    await act(async () => {
      trigger(container).click();
    });

    await act(async () => {
      options(container)
        .find((el) => el.textContent === 'Any time')!
        .click();
    });

    expect(onWindowChange).toHaveBeenCalledWith('any', null);
  });

  it('tones the trigger and names the preset when only a window is set', async () => {
    const plain = await mount('active', vi.fn());
    const untoned = trigger(plain).className;
    act(() => root!.unmount());
    host!.remove();

    const windowed = await mount('active', vi.fn(), {
      preset: 'today',
      window: { since: '2026-11-16T00:00:00.000Z', until: null },
    });

    expect(trigger(windowed).className).not.toBe(untoned);
    expect(trigger(windowed).title).toBe('Filter chats · Active chats · Today');
  });

  it('applies a custom range only once both dates are valid', async () => {
    const onWindowChange = vi.fn();
    const container = await mount('active', vi.fn(), { onWindowChange });
    await act(async () => {
      trigger(container).click();
    });
    await act(async () => {
      options(container)
        .find((el) => el.textContent === 'Custom range…')!
        .click();
    });

    const input = (label: string): HTMLInputElement =>
      document.body.querySelector<HTMLInputElement>(
        `input[aria-label="${label}"]`,
      )!;
    const apply = (): HTMLButtonElement =>
      [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
        (el) => el.textContent === 'Apply',
      )!;
    const type = async (el: HTMLInputElement, value: string): Promise<void> => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };

    expect(apply().disabled).toBe(true);
    await type(input('From'), '2026-11-10');
    expect(apply().disabled).toBe(true);
    await type(input('To'), '2026-11-09');
    expect(apply().disabled).toBe(true);
    await type(input('To'), '2026-11-12');
    expect(apply().disabled).toBe(false);

    await act(async () => {
      apply().click();
    });

    expect(onWindowChange).toHaveBeenCalledWith('custom', {
      since: new Date(2026, 10, 10).toISOString(),
      until: new Date(2026, 10, 13).toISOString(),
    });
  });
});
