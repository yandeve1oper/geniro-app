// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LESSONS_APP_OFF_REASON,
  type LessonsChoice,
  LessonsOverrideControl,
} from './lessons-override-control';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const INHERITED = 'Inherit (On — app setting)';

function render(props: {
  value: LessonsChoice;
  onChange?: (next: LessonsChoice) => void;
  disabled?: boolean;
  disabledReason?: string;
}): void {
  act(() => {
    root.render(
      <LessonsOverrideControl
        value={props.value}
        onChange={props.onChange ?? (() => undefined)}
        inheritedLabel={INHERITED}
        disabled={props.disabled}
        disabledReason={props.disabledReason}
      />,
    );
  });
}

function option(label: string): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[data-slot="segmented-control"] button',
    ),
  ].find((button) => button.textContent === label);
  if (found === undefined) {
    throw new Error(`no option ${label}`);
  }
  return found;
}

function hint(): string | null {
  return (
    container.querySelector('[data-slot="setting-row"] > div > span:last-child')
      ?.textContent ?? null
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('LessonsOverrideControl', () => {
  it('offers Inherit, On and Off under the Lessons label, with the current value pressed', () => {
    render({ value: 'on' });

    expect(container.textContent).toContain('Lessons');
    expect(
      container
        .querySelector('[aria-label="Lessons"]')
        ?.querySelectorAll('button').length,
    ).toBe(3);
    expect(option('Inherit').getAttribute('aria-pressed')).toBe('false');
    expect(option('On').getAttribute('aria-pressed')).toBe('true');
    expect(option('Off').getAttribute('aria-pressed')).toBe('false');
  });

  it('presses Inherit when no choice of its own is set', () => {
    render({ value: 'inherit' });

    expect(option('Inherit').getAttribute('aria-pressed')).toBe('true');
    expect(option('On').getAttribute('aria-pressed')).toBe('false');
  });

  it('reports each other value when it is picked', () => {
    const onChange = vi.fn();
    render({ value: 'inherit', onChange });

    act(() => option('On').click());
    act(() => option('Off').click());

    expect(onChange.mock.calls).toEqual([['on'], ['off']]);
  });

  it('reports nothing when the value already set is picked again', () => {
    const onChange = vi.fn();
    render({ value: 'off', onChange });

    act(() => option('Off').click());

    expect(onChange).not.toHaveBeenCalled();
  });

  it('hints what inherit resolves to while it is enabled', () => {
    render({ value: 'inherit' });

    expect(hint()).toBe(INHERITED);
  });

  it('locks every option and says why when the app setting is Off', () => {
    const onChange = vi.fn();
    render({
      value: 'on',
      onChange,
      disabled: true,
      disabledReason: LESSONS_APP_OFF_REASON,
    });

    for (const label of ['Inherit', 'On', 'Off']) {
      expect(option(label).disabled).toBe(true);
    }
    act(() => option('Off').click());
    expect(onChange).not.toHaveBeenCalled();
    expect(option('On').getAttribute('aria-pressed')).toBe('true');
    expect(hint()).toBe('Off in Settings → Memory — turn it on there first');
  });

  it('keeps the inherit hint when disabled without a reason', () => {
    render({ value: 'inherit', disabled: true });

    expect(hint()).toBe(INHERITED);
  });
});
