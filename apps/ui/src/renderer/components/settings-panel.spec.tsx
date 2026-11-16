// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SettingsList,
  SettingsPanel,
  SettingsPanelRow,
} from './settings-panel';
import { Switch } from './ui/switch';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SettingsPanelRow', () => {
  it('makes the label press the control it names', () => {
    const onCheckedChange = vi.fn();
    act(() => {
      root.render(
        <SettingsPanel>
          <SettingsPanelRow
            label="Show system notifications"
            htmlFor="spec-notifications"
            description="Banners when an agent asks something.">
            <Switch
              id="spec-notifications"
              checked={false}
              onCheckedChange={onCheckedChange}
            />
          </SettingsPanelRow>
        </SettingsPanel>,
      );
    });

    // The whole reason the row takes `htmlFor` at all: the control moved to the
    // far side of the row, so the words are the large target and the switch is
    // the small one. A row that renders the label without the association reads
    // identically and cannot be clicked.
    act(() => {
      container
        .querySelector<HTMLLabelElement>('label')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('keeps a hint off the row behind a "?" that opens on keyboard focus', () => {
    act(() => {
      root.render(
        <SettingsPanel>
          <SettingsPanelRow
            label="Keep the Mac awake while agents work"
            hint="The display still turns off.">
            <button type="button">Toggle</button>
          </SettingsPanelRow>
        </SettingsPanel>,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="About Keep the Mac awake while agents work"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.querySelector('svg')).not.toBeNull();
    expect(container.textContent).not.toContain('The display still turns off.');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
      trigger!.focus();
    });

    expect(
      container.querySelector('[data-slot="popover-panel"]')?.textContent,
    ).toBe('The display still turns off.');
  });

  it('renders no heading for a row that is not a setting', () => {
    act(() => {
      root.render(
        <SettingsPanel>
          <SettingsPanelRow>
            <button type="button">Send a test</button>
          </SettingsPanelRow>
        </SettingsPanel>,
      );
    });

    // A panel carries rows that ACT rather than set — the notification test,
    // the update buttons. Without this arm each would need a label invented to
    // give it one, which is how a screen grows words nobody needed.
    expect(container.querySelector('label')).toBeNull();
    expect(container.querySelector('button')?.textContent).toBe('Send a test');
  });

  it('drops the right-hand column in the block layout', () => {
    act(() => {
      root.render(
        <SettingsPanel>
          <SettingsPanelRow layout="block" label="Theme">
            <span>swatches</span>
          </SettingsPanelRow>
        </SettingsPanel>,
      );
    });

    const row = container.querySelector<HTMLElement>(
      '[data-slot="settings-panel-row"]',
    );
    // jsdom computes no layout and resolves no container query, so the CLASS is
    // the observable — and here it is the mechanism rather than a proxy for it:
    // `inline` is the row turning into two columns at `26rem`, and `block` is
    // exactly the absence of that. A block row that kept the `flex-row` would
    // right-align a run of swatches into a cell that cannot hold them.
    expect(row?.className).not.toContain('@[26rem]:flex-row');
    expect(row?.className).toContain('flex-col');
  });
});

describe('SettingsList', () => {
  it('is a real list, so its rows can be counted by something that cannot see them', () => {
    act(() => {
      root.render(
        <SettingsList aria-label="Fast actions">
          <li>Review my diff</li>
          <li>Write the tests</li>
        </SettingsList>,
      );
    });

    // The whole reason this exists beside `SettingsPanel` rather than being a
    // variant of it: the two render the same surface, and a `<div>` here would
    // look identical while telling a screen reader nothing about how many
    // configurations the user has saved. `SettingsPanel` is a group of controls
    // and correctly is NOT a list.
    const list = container.querySelector('ul');
    expect(list).not.toBeNull();
    expect(list?.getAttribute('aria-label')).toBe('Fast actions');
    expect(list?.querySelectorAll('li')).toHaveLength(2);
  });

  it('wears the same enclosure as the panel, so two settings surfaces cannot drift', () => {
    act(() => {
      root.render(
        <>
          <SettingsPanel>
            <SettingsPanelRow label="A">
              <span>x</span>
            </SettingsPanelRow>
          </SettingsPanel>
          <SettingsList>
            <li>row</li>
          </SettingsList>
        </>,
      );
    });

    const panel = container.querySelector<HTMLElement>(
      '[data-slot="settings-panel"]',
    );
    const list = container.querySelector<HTMLElement>(
      '[data-slot="settings-list"]',
    );
    // Asserted as the classes they SHARE rather than as a literal string, so
    // the pin survives either one gaining something of its own — which the list
    // already has (`list-none`, `m-0`, `p-0`). What it catches is the enclosure
    // itself being respelled in one place and not the other: jsdom computes no
    // styles, so the emitted class is the observable, and here it is the whole
    // mechanism — one shared constant is the only thing keeping a radius or a
    // divider from diverging between the two surfaces.
    for (const shared of [
      'rounded-lg',
      'border',
      'border-border',
      'bg-card',
      'divide-y',
      'divide-border',
    ]) {
      expect(panel?.className).toContain(shared);
      expect(list?.className).toContain(shared);
    }
  });
});
