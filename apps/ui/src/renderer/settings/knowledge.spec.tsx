// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  type KnowledgeSettings,
  type Settings,
} from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import { Knowledge } from './knowledge';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let writes: Partial<Settings>[];

function install(knowledge: KnowledgeSettings): void {
  writes = [];
  let stored: Settings = { ...DEFAULT_SETTINGS, knowledge };
  window.geniro = createPreloadStub({
    getSettings: () => Promise.resolve(stored),
    updateSettings: (patch) => {
      writes.push(patch);
      stored = { ...stored, ...patch };
      return Promise.resolve(stored);
    },
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<Knowledge />);
  });
  await settle();
}

async function press(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
  await settle();
}

function switchOf(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(
    '#settings-knowledge-enabled',
  )!;
}

function agentWritesOf(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(
    '#settings-knowledge-agent-writes',
  )!;
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

describe('Knowledge settings', () => {
  it('disables the agent-writes choice while agent knowledge is off', async () => {
    install({ enabled: false, agentWrites: 'review' });
    await render();

    expect(switchOf().getAttribute('aria-checked')).toBe('false');
    expect(agentWritesOf().disabled).toBe(true);
  });

  it('keeps the agent-writes choice live while agent knowledge is on', async () => {
    install({ enabled: true, agentWrites: 'direct' });
    await render();

    expect(agentWritesOf().disabled).toBe(false);
  });

  it('turning agent knowledge off saves that alone and keeps the choice', async () => {
    install({ enabled: true, agentWrites: 'direct' });
    await render();

    await press(switchOf());

    expect(writes).toEqual([
      { knowledge: { enabled: false, agentWrites: 'direct' } },
    ]);
    expect(agentWritesOf().disabled).toBe(true);
  });

  it('offers the three ways an agent may write, in the approved words', async () => {
    install({ enabled: true, agentWrites: 'review' });
    await render();

    await press(agentWritesOf());

    const options = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].map((option) => option.textContent?.trim());
    expect(options).toEqual([
      'Wait for my review',
      'Saved at once',
      'Agents only read',
    ]);
  });

  it('says what each row does', async () => {
    install({ enabled: true, agentWrites: 'review' });
    await render();

    expect(container.textContent).toContain(
      'Agents find and read documents, whatever their CLI. Off, they get no knowledge tools and no index — the documents stay here to edit.',
    );
    expect(container.textContent).toContain(
      "Saved at once: agents find an agent's document by search right away; it stays out of every chat's index until you load it there.",
    );
  });
});
