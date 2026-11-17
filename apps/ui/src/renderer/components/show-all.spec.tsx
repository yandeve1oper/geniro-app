// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ShowAllButton, useShowAll } from './show-all';

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

function List({
  items,
  limit,
}: {
  items: string[];
  limit: number;
}): React.JSX.Element {
  const { shown, expanded, setExpanded } = useShowAll(items, limit);
  return (
    <div>
      <ul>
        {shown.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <ShowAllButton
        total={items.length}
        limit={limit}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        noun="entries"
      />
    </div>
  );
}

const items = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `item-${index}`);

function button(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-slot="show-all"]');
}

describe('ShowAllButton', () => {
  it('shows the first few, then every row on a press, then folds back', () => {
    act(() => root.render(<List items={items(7)} limit={5} />));
    expect(container.querySelectorAll('li')).toHaveLength(5);
    expect(button()?.textContent).toBe('Show all 7 entries');
    expect(button()?.getAttribute('aria-expanded')).toBe('false');

    act(() => button()!.click());
    expect(container.querySelectorAll('li')).toHaveLength(7);
    expect(button()?.textContent).toBe('Show fewer');
    expect(button()?.getAttribute('aria-expanded')).toBe('true');

    act(() => button()!.click());
    expect(container.querySelectorAll('li')).toHaveLength(5);
  });

  it('hides the whole list behind a limit of 0 until it is asked for', () => {
    act(() => root.render(<List items={items(1228)} limit={0} />));
    expect(container.querySelectorAll('li')).toHaveLength(0);
    expect(button()?.textContent).toBe('Show 1,228 entries');

    act(() => button()!.click());
    expect(container.querySelectorAll('li')).toHaveLength(1228);
    expect(button()?.textContent).toBe('Hide entries');
  });

  it('reads "Show entries" for a list nobody counted, and still draws it', () => {
    act(() =>
      root.render(
        <ShowAllButton
          total={null}
          limit={0}
          expanded={false}
          onToggle={() => undefined}
          noun="entries"
        />,
      ),
    );
    expect(button()?.textContent).toBe('Show entries');
  });

  it('names a hidden list of one in the singular', () => {
    act(() =>
      root.render(
        <ShowAllButton
          total={1}
          limit={0}
          expanded={false}
          onToggle={() => undefined}
          noun="entries"
          nounOne="entry"
        />,
      ),
    );
    expect(button()?.textContent).toBe('Show 1 entry');
  });

  it('draws nothing for a list that already fits', () => {
    act(() => root.render(<List items={items(3)} limit={5} />));
    expect(container.querySelectorAll('li')).toHaveLength(3);
    expect(button()).toBeNull();
  });
});
