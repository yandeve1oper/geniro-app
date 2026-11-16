// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SplitButton } from './split-button';

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

const GROUPS = [
  {
    items: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ],
  },
];

async function render(props: {
  onClick: () => void;
  onSelect: (value: string) => void;
  onMenuOpen?: () => void;
  disabled?: boolean;
}): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <SplitButton groups={GROUPS} value="a" menuLabel="Choose" {...props}>
        Run alpha
      </SplitButton>,
    );
  });
  return container;
}

async function press(target: Element): Promise<void> {
  await act(async () => {
    (target as HTMLElement).click();
  });
}

function option(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((item) => item.textContent?.includes(label));
  if (!found) {
    throw new Error(`no option ${label}`);
  }
  return found;
}

describe('SplitButton', () => {
  it('runs the action named on its label when the label is pressed', async () => {
    const onClick = vi.fn();
    const onSelect = vi.fn();
    const el = await render({ onClick, onSelect });

    await press(el.querySelector('[data-slot="split-button"] > button')!);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('picks from the menu without running the action, and closes the menu', async () => {
    const onClick = vi.fn();
    const onSelect = vi.fn();
    const onMenuOpen = vi.fn();
    const el = await render({ onClick, onSelect, onMenuOpen });

    await press(el.querySelector('[aria-label="Choose"]')!);
    expect(onMenuOpen).toHaveBeenCalled();
    await press(option('Beta'));

    expect(onSelect).toHaveBeenCalledWith('b');
    expect(onClick).not.toHaveBeenCalled();
    expect(document.querySelector('[role="option"]')).toBeNull();
  });

  it('withholds both halves while disabled', async () => {
    const el = await render({
      onClick: vi.fn(),
      onSelect: vi.fn(),
      disabled: true,
    });

    const buttons = [
      ...el.querySelectorAll<HTMLButtonElement>(
        '[data-slot="split-button"] > button',
      ),
    ];
    expect(buttons.map((button) => button.disabled)).toEqual([true, true]);
  });
});
