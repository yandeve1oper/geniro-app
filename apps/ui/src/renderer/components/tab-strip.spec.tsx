// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TabStrip } from './tab-strip';

type Id = 'first' | 'second' | 'third';

const TABS = [
  { id: 'first', label: 'First' },
  { id: 'second', label: 'Second', count: '200+' },
  { id: 'third', label: 'Third' },
] as const;

const LEFT: Record<Id, number> = { first: 0, second: 120, third: 240 };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function draw(value: Id): void {
  act(() => {
    root.render(
      <TabStrip<Id>
        label="Sections"
        idPrefix="sections"
        tabs={TABS}
        value={value}
        onSelect={() => undefined}
      />,
    );
  });
}

function laidOut(): HTMLElement {
  const strip = container.querySelector<HTMLElement>(
    '[data-slot="tab-strip"]',
  )!;
  Object.defineProperty(strip, 'clientWidth', { value: 200 });
  for (const id of Object.keys(LEFT) as Id[]) {
    const tab = container.querySelector<HTMLElement>(`#sections-tab-${id}`)!;
    Object.defineProperty(tab, 'offsetLeft', { value: LEFT[id] });
    Object.defineProperty(tab, 'offsetWidth', { value: 100 });
  }
  return strip;
}

describe('TabStrip', () => {
  it('scrolls a tab picked past the strip’s right edge into view, and back for one past its left', () => {
    draw('first');
    const strip = laidOut();

    draw('third');
    expect(strip.scrollLeft).toBe(140);

    draw('first');
    expect(strip.scrollLeft).toBe(0);
  });

  it('draws a count given as text after the label', () => {
    draw('first');

    expect(container.querySelector('#sections-tab-second')?.textContent).toBe(
      'Second200+',
    );
  });
});
