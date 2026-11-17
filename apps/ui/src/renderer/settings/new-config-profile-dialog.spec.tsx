// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { McpSource, McpSourceDocument } from './new-config-profile';
import {
  NewConfigProfileDialog,
  type NewConfigProfileRequest,
} from './new-config-profile-dialog';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

const SOURCES: McpSource[] = [
  { label: 'Default', configDir: null },
  { label: 'Work', configDir: '/cfg/work' },
];

async function render(
  read: (source: McpSource) => Promise<McpSourceDocument>,
  onCreate: (request: NewConfigProfileRequest) => Promise<void>,
): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <NewConfigProfileDialog
        agent="claude"
        open
        sources={SOURCES}
        readSource={read}
        onCreate={onCreate}
        onClose={() => undefined}
      />,
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function type(el: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  );
  expect(found, `no button "${text}"`).toBeDefined();
  return found!;
}

const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('NewConfigProfileDialog', () => {
  it('creates with the typed name and only the servers ticked', async () => {
    const onCreate = vi.fn(() => Promise.resolve());
    await render((source) => {
      const servers: Record<
        string,
        Record<string, unknown>
      > = source.configDir === null
        ? { github: { command: 'gh' } }
        : { linear: { url: 'l' } };
      return Promise.resolve({
        path: `${source.configDir ?? '/home'}/.claude.json`,
        servers,
        unavailableReason: null,
      });
    }, onCreate);

    expect(button('Create and sign in').disabled).toBe(true);
    type(
      document.querySelector<HTMLInputElement>('#new-config-profile-name')!,
      '  Client  ',
    );
    await click(button('linear'));
    await click(button('Create and sign in'));

    expect(onCreate).toHaveBeenCalledWith({
      name: 'Client',
      servers: [
        {
          name: 'linear',
          definition: { url: 'l' },
          from: 'Work',
          carriesKeys: false,
        },
      ],
    });
  });

  it('says so when no other configuration defines a server', async () => {
    await render(
      (source) =>
        Promise.resolve({
          path: `/${source.label}`,
          servers: {},
          unavailableReason: null,
        }),
      () => Promise.resolve(),
    );

    expect(
      document.querySelector('[data-slot="no-mcp-servers"]'),
    ).not.toBeNull();
  });

  it('offers nothing to tick when every configuration reads one shared MCP file', async () => {
    await render(
      () =>
        Promise.resolve({
          path: '/home/.cursor/mcp.json',
          servers: { notion: { url: 'n' } },
          unavailableReason: null,
        }),
      () => Promise.resolve(),
    );

    expect(
      document.querySelector('[data-slot="mcp-servers-shared"]'),
    ).not.toBeNull();
    expect(
      [...document.querySelectorAll('button')].some((b) =>
        b.textContent?.includes('notion'),
      ),
    ).toBe(false);
  });

  it('keeps the dialog open with the reason when creating fails', async () => {
    await render(
      () =>
        Promise.resolve({ path: '/p', servers: {}, unavailableReason: null }),
      () => Promise.reject(new Error('disk full')),
    );
    type(
      document.querySelector<HTMLInputElement>('#new-config-profile-name')!,
      'Work',
    );

    await click(button('Create and sign in'));

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'disk full',
    );
    expect(button('Create and sign in').disabled).toBe(false);
  });
});
