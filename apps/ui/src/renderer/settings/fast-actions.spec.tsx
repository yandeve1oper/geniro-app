// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FastAction } from '../../shared/contracts';
import { MAX_FAST_ACTION_NAME, MAX_FAST_ACTIONS } from '../../shared/contracts';
import { FastActionsPane } from './fast-actions';

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
  vi.restoreAllMocks();
});

function action(over: Partial<FastAction> = {}): FastAction {
  return {
    id: 'fa-1',
    name: 'Review the branch',
    description: 'Review what changed on this branch and report findings.',
    ...over,
  };
}

function render(
  props: Partial<React.ComponentProps<typeof FastActionsPane>> = {},
): {
  onSave: ReturnType<typeof vi.fn>;
  onDelete: ReturnType<typeof vi.fn>;
} {
  const onSave = vi.fn();
  const onDelete = vi.fn();
  act(() => {
    root.render(
      <FastActionsPane
        actions={[action()]}
        onSave={onSave}
        onDelete={onDelete}
        {...props}
      />,
    );
  });
  return { onSave, onDelete };
}

/** The one button whose accessible name matches, or a failure naming what was found. */
function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) =>
      b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  );
  if (!found) {
    throw new Error(
      `no button "${name}" — found: ${[...container.querySelectorAll('button')]
        .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())
        .join(' | ')}`,
    );
  }
  return found as HTMLButtonElement;
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const found = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  );
  if (!found) {
    throw new Error(`no field "${label}"`);
  }
  return found;
}

/** Type into a controlled field the way React's own onChange sees it. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const nameField = (): HTMLInputElement =>
  field('Fast action name') as HTMLInputElement;
const descriptionField = (): HTMLTextAreaElement =>
  container.querySelector('textarea') as HTMLTextAreaElement;

describe('FastActionsPane — list', () => {
  it('pressing a row opens THAT action in the editor', () => {
    // The row's press is an edit, not a press of the action: this screen is
    // where actions are written, and the buttons that USE one live under the
    // composer (`chats/fast-action-bar.tsx`).
    render({
      actions: [
        action({ id: 'a', name: 'First' }),
        action({
          id: 'b',
          name: 'Second',
          description: 'Do the second thing.',
        }),
      ],
    });
    click(button('Edit the fast action “Second”'));
    expect(nameField().value).toBe('Second');
    expect(descriptionField().value).toBe('Do the second thing.');
  });

  it('shows what the action writes, under its name', () => {
    // The name alone does not say what a press will do, and the description IS
    // the action — a list of names is a list nobody can audit.
    render({ actions: [action({ description: 'Write the tests first.' })] });
    expect(container.textContent).toContain('Write the tests first.');
  });

  it('deleting takes two presses — the first only arms it', () => {
    const { onDelete } = render();
    click(button('Delete Review the branch'));
    expect(onDelete).not.toHaveBeenCalled();
    click(button('Confirm delete Review the branch'));
    expect(onDelete).toHaveBeenCalledWith('fa-1');
  });

  it('an empty set says so rather than showing a bare list', () => {
    render({ actions: [] });
    expect(container.textContent).toContain('No fast actions yet');
  });

  it('says it ONCE — the toolbar counter is silent on an empty set', () => {
    // The toolbar states how many actions there are against the ceiling the
    // editor refuses a save at. Said on an EMPTY list it duplicated the empty
    // state a few pixels above it, which is what the first screenshot of this
    // pane showed. Counting is the assertion: `toContain` passes either way,
    // which is exactly how the duplicate shipped.
    //
    // A FIXED substring, and that is not a detail. The first version of this
    // matched `/No .*actions yet/g`, whose greedy `.*` swallowed BOTH messages
    // as a single match — so it reported one occurrence with the duplicate
    // restored and certified a bug that was on screen. Verified the other way
    // round this time: with the counter's old text put back, this fails at 2.
    render({ actions: [] });
    expect(container.textContent?.match(/actions yet/g)).toHaveLength(1);
  });

  it('counts against the ceiling once there is something to count', () => {
    // The other half, so the fix above cannot be "delete the counter": the
    // ceiling is real, and a user filling the list up should meet it here
    // rather than in a refusal after writing an action.
    render({ actions: [action({ id: 'a' }), action({ id: 'b' })] });
    expect(container.textContent).toContain(`2 of ${MAX_FAST_ACTIONS}`);
  });
});

describe('FastActionsPane — editor', () => {
  const openNew = (): void => click(button('New action'));

  it('saves a new action against a null id, trimmed', () => {
    const { onSave } = render({ actions: [] });
    openNew();
    type(nameField(), '  Standup  ');
    type(descriptionField(), '  What changed since yesterday?  ');
    click(button('Create'));
    expect(onSave).toHaveBeenCalledWith(
      { name: 'Standup', description: 'What changed since yesterday?' },
      null,
    );
  });

  it('saves an edit back against the SAME id', () => {
    const { onSave } = render({ actions: [action({ id: 'fa-9' })] });
    click(button('Edit the fast action “Review the branch”'));
    type(nameField(), 'Review it harder');
    click(button('Save'));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Review it harder' }),
      'fa-9',
    );
  });

  it('refuses a nameless action and keeps the editor open', () => {
    const { onSave } = render({ actions: [] });
    openNew();
    type(descriptionField(), 'Something useful.');
    click(button('Create'));
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Give the action a name');
    // Still the editor — closing would discard what was typed.
    expect(nameField()).toBeTruthy();
  });

  it('refuses an action that would write NOTHING', () => {
    // A press writes the description into the message box, so an action with
    // none is a button that does nothing at all — and the IPC schema refuses
    // the empty string anyway, which would throw away the whole settings patch.
    const { onSave } = render({ actions: [] });
    openNew();
    type(nameField(), 'Empty');
    type(descriptionField(), '   ');
    click(button('Create'));
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'Write what pressing this action should say',
    );
  });

  it('clears the refusal once the save it refused succeeds', () => {
    // The message renders above the LIST too, so a stale one would sit over the
    // row that proves it wrong.
    const { onSave } = render({ actions: [] });
    openNew();
    click(button('Create'));
    expect(container.textContent).toContain('Give the action a name');
    type(nameField(), 'Named now');
    type(descriptionField(), 'And it says something.');
    click(button('Create'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Give the action a name');
  });

  it('clears the refusal when the editor is cancelled', () => {
    render({ actions: [] });
    openNew();
    click(button('Create'));
    expect(container.textContent).toContain('Give the action a name');
    click(button('Cancel'));
    expect(container.textContent).not.toContain('Give the action a name');
  });

  it('refuses a name longer than the IPC schema accepts, rather than losing the save', () => {
    // That boundary throws on the WHOLE patch, so without this guard the editor
    // closes, the row shows from React state, and nothing is written.
    const { onSave } = render({ actions: [] });
    openNew();
    const long = 'x'.repeat(MAX_FAST_ACTION_NAME + 1);
    // Past the field's own maxLength, so it is set directly — a paste through
    // a harness that does not enforce it lands here.
    type(nameField(), long);
    type(descriptionField(), 'Fine.');
    click(button('Create'));
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain(String(long.length));
  });

  it('refuses a new action once the list is full, and still allows editing one', () => {
    const full = Array.from({ length: MAX_FAST_ACTIONS }, (_, i) =>
      action({ id: `fa-${i}`, name: `Action ${i}` }),
    );
    const { onSave } = render({ actions: full });
    click(button('New action'));
    type(nameField(), 'One too many');
    type(descriptionField(), 'Nope.');
    click(button('Create'));
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain(`${MAX_FAST_ACTIONS} actions`);

    click(button('Cancel'));
    click(button('Edit the fast action “Action 0”'));
    type(nameField(), 'Renamed');
    click(button('Save'));
    // An edit ADDS nothing, so the cap has nothing to say about it.
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Renamed' }),
      'fa-0',
    );
  });
});

describe('FastActionsPane — explanations and long lists', () => {
  const many = (count: number): FastAction[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `fa-${index}`,
      name: `Action ${index}`,
      description: `Do thing ${index}.`,
    }));
  const rows = (): number =>
    container.querySelectorAll('[data-slot="settings-list"] li').length;

  it('explains what a fast action is and titles every button', () => {
    render();
    expect(
      container.querySelector('button[aria-label="About Your actions"]'),
    ).not.toBeNull();
    expect(button('New action').title).toContain('Write a new fast action');
    expect(button('Edit Review the branch').title).toContain('name or text');
    expect(button('Delete Review the branch').title).toContain(
      'You are asked once more',
    );
  });

  it('shows eight actions and opens the rest on a press', () => {
    render({ actions: many(10) });
    expect(rows()).toBe(8);

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-slot="show-all"]',
    )!;
    expect(toggle.textContent).toBe('Show all 10 actions');
    click(toggle);
    expect(rows()).toBe(10);
    expect(container.textContent).toContain(`10 of ${MAX_FAST_ACTIONS}`);
  });

  it('leaves the list expanded after adding one past the cap, so the new action is on screen', () => {
    const existing = many(9);
    const onSave = vi.fn(
      ({ name, description }: { name: string; description: string }) => {
        root.render(
          <FastActionsPane
            actions={[...existing, { id: 'fa-new', name, description }]}
            onSave={onSave}
            onDelete={vi.fn()}
          />,
        );
      },
    );
    render({ actions: existing, onSave });
    expect(rows()).toBe(8);

    click(button('New action'));
    type(nameField(), 'Brand new action');
    type(descriptionField(), 'Say something new.');
    click(button('Create'));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(rows()).toBe(10);
    expect(container.textContent).toContain('Brand new action');
  });

  it('draws no show-all while the list fits', () => {
    render({ actions: many(8) });
    expect(container.querySelector('[data-slot="show-all"]')).toBeNull();
  });
});
