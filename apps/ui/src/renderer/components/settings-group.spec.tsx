// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SettingsGroup, SettingsGroups } from './settings-group';

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

describe('SettingsGroup', () => {
  it('names its section and keeps its explanation behind a "?" until opened', () => {
    act(() => {
      root.render(
        <SettingsGroups>
          <SettingsGroup
            title="Notifications"
            description="How Geniro tells you an agent needs you."
            hint="Banners come from macOS.">
            <button type="button">Send a test</button>
          </SettingsGroup>
        </SettingsGroups>,
      );
    });

    const section = container.querySelector('section');
    expect(section?.getAttribute('aria-label')).toBe('Notifications');
    expect(section?.querySelector('h2')?.textContent).toBe('Notifications');
    expect(section?.textContent).toContain(
      'How Geniro tells you an agent needs you.',
    );
    expect(container.textContent).not.toContain('Banners come from macOS.');

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="About Notifications"]',
    );
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
      trigger!.focus();
    });
    expect(
      container.querySelector('[data-slot="popover-panel"]')?.textContent,
    ).toBe('Banners come from macOS.');
  });

  it('draws the group actions in its header, before its rows', () => {
    act(() => {
      root.render(
        <SettingsGroup
          title="Entries"
          layout="stacked"
          actions={<button type="button">New entry</button>}>
          <p data-testid="rows">rows</p>
        </SettingsGroup>,
      );
    });

    const actions = container.querySelector(
      'header [data-slot="settings-group-actions"]',
    );
    expect(actions?.textContent).toBe('New entry');
    expect(
      actions!.compareDocumentPosition(
        container.querySelector('[data-testid="rows"]')!,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
