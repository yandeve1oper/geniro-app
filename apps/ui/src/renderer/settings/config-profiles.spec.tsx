// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliKind, ConfigProfile } from '../../shared/contracts';
import { ConfigProfileList, defaultName } from './config-profiles';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

const profile = (over: Partial<ConfigProfile> = {}): ConfigProfile => ({
  id: 'p1',
  name: 'Work',
  dir: '/Users/x/.claude-work',
  color: 'blue',
  agent: 'claude',
  ...over,
});

function render(
  profiles: ConfigProfile[],
  pick: () => Promise<string | null> = async () => null,
  agent: CliKind = 'claude',
  compact = false,
): { el: HTMLElement; changes: ConfigProfile[][] } {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const changes: ConfigProfile[][] = [];
  act(() => {
    root.render(
      <ConfigProfileList
        compact={compact}
        agent={agent}
        profiles={profiles}
        onChange={(next) => changes.push(next)}
        onPickDirectory={pick}
      />,
    );
  });
  return { el: container, changes };
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('ConfigProfileList — a new configuration', () => {
  it('offers signing in to a new configuration beside adding a folder, only when it can', () => {
    const onCreateNew = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <ConfigProfileList
          agent="codex"
          profiles={[]}
          onChange={() => undefined}
          onPickDirectory={async () => null}
          onCreateNew={onCreateNew}
        />,
      );
    });
    const labels = [...container.querySelectorAll('button')]
      .map((b) => b.textContent)
      .filter((text) => text !== '');
    expect(labels).toEqual([
      'Sign in to a new configuration',
      'Add existing folder',
    ]);

    act(() => {
      container
        .querySelector('button[title^="Makes a new folder"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onCreateNew).toHaveBeenCalledTimes(1);
  });

  it('keeps the single Add configuration button where no sign-in is possible', () => {
    const { el } = render([]);
    expect(
      [...el.querySelectorAll('button')]
        .map((b) => b.textContent)
        .filter((text) => text !== ''),
    ).toEqual(['Add configuration']);
  });
});

/**
 * Type into a controlled field the way React's own onChange sees it.
 *
 * React tracks an input's value on the node, so assigning `.value` directly and
 * firing `input` is swallowed — the handler never runs and the assertion passes
 * against a component that did nothing. The native setter is what defeats the
 * tracker; the same helper is in `fast-actions.spec.tsx` for the same reason.
 */
function type(el: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The one control whose label starts with `text` — rows are keyed by name. */
function byLabel(el: HTMLElement, text: string): HTMLElement {
  const found = [...el.querySelectorAll<HTMLElement>('[aria-label]')].find(
    (node) => node.getAttribute('aria-label')?.startsWith(text),
  );
  expect(found, `no control labelled ${text}`).toBeDefined();
  return found!;
}

describe('ConfigProfileList', () => {
  it('keeps the onboarding introduction concise while retaining profile editing', async () => {
    const { el, changes } = render(
      [],
      async () => '/tmp/work-profile',
      'claude',
      true,
    );
    // The onboarding row says "Default setup" itself; the list adds no sentence.
    expect(el.textContent).not.toContain('None yet');
    expect(el.textContent).not.toContain('Configurations');
    expect(el.textContent).not.toContain('Name the config directories');
    const add = el.querySelector('button')!;
    expect(add.textContent).toContain('Add profile');
    await act(async () => add.click());
    expect(changes).toEqual([
      [expect.objectContaining({ agent: 'claude', dir: '/tmp/work-profile' })],
    ]);
  });

  it('explains what a configuration is behind a hint beside the heading, and every button says what it does', () => {
    const { el } = render([profile()]);
    expect(
      el.querySelector('button[aria-label="About Configurations"]'),
    ).not.toBeNull();
    const remove = el.querySelector('button[aria-label="Remove Work"]');
    expect(remove?.getAttribute('title')).toContain('login stay on disk');
    const add = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Add configuration'),
    );
    expect(add?.title).toContain('already uses');
  });

  it('says what the feature is FOR when there is nothing in it', () => {
    // Empty is the state most installs are in and will stay in, so the empty
    // case has to explain rather than report a count of zero.
    const { el } = render([]);
    expect(el.textContent).toContain('None yet');
    expect(el.querySelector('[data-slot="config-profile-row"]')).toBeNull();
  });

  it('draws a row per configuration — swatch, name and directory', () => {
    const { el } = render([
      profile(),
      profile({ id: 'p2', name: 'Personal', dir: '/Users/x/.claude-home' }),
    ]);
    const rows = el.querySelectorAll('[data-slot="config-profile-row"]');
    expect(rows).toHaveLength(2);
    expect(el.textContent).toContain('.claude-work');
    // The NAME is an input, so it is not in `textContent` — read the value.
    expect(
      (byLabel(el, 'Name for /Users/x/.claude-work') as HTMLInputElement).value,
    ).toBe('Work');
  });

  it('gives the colour cell a FIXED width, so the columns after it line up', () => {
    // REPORTED as the list not being straight. The colour trigger was the one
    // content-sized cell in the row and also the FIRST, so `Blue` and `Orange`
    // started their neighbours at different x and every column after them was
    // ragged — the delete buttons agreed only because they are pushed against
    // the right edge. jsdom computes no layout, so the emitted class is the
    // observable; it is also the whole mechanism, since the row's other three
    // cells were already fixed (`w-40`), flexible (`flex-1`) or `shrink-0`.
    const { el } = render([
      profile({ color: 'blue' }),
      profile({ id: 'p2', name: 'Personal', color: 'orange' }),
    ]);
    const triggers = [
      ...el.querySelectorAll<HTMLElement>('[data-menu-trigger]'),
    ];
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      expect(trigger.className).toContain('w-28');
      expect(trigger.className).toContain('shrink-0');
    }
  });

  it('elides a directory from the HEAD, keeping the end that identifies it', () => {
    // Two segments rather than the default three: this cell is last in a row
    // that has already spent its width on a colour, a name field and a delete
    // button, and at three the path overran and was CSS-truncated — which eats
    // the TAIL, the one end that says which directory it is. Measured in the
    // running app after the change: both rows fit with nothing cut.
    const { el } = render([
      profile({ dir: '/Users/x/Desktop/Projects/workspace/.claude-work' }),
    ]);
    expect(el.textContent).toContain('…/workspace/.claude-work');
    expect(el.textContent).not.toContain('Desktop');
  });

  it('takes the colour from the PALETTE, never an inline value', () => {
    // `renderer-design-system.md` makes a raw colour an eslint error, and the
    // eight `--color-group-*` tokens are the app's one palette — the same ones
    // the sidebar's groups use, so a blue profile and a blue group are the same
    // blue. Asserted on the class because jsdom loads no stylesheet.
    const { el } = render([profile({ color: 'teal' })]);
    const dot = el.querySelector<HTMLElement>('[data-color="teal"]');
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain('bg-group-teal');
  });

  it('commits a rename on BLUR, not on every keystroke', async () => {
    const { el, changes } = render([profile()]);
    const input = byLabel(
      el,
      'Name for /Users/x/.claude-work',
    ) as HTMLInputElement;

    type(input, 'Client');
    // Nothing written yet: a per-keystroke commit rewrites settings.json once
    // per letter.
    expect(changes).toHaveLength(0);

    await act(async () => {
      // `focusout`, not `blur`: React maps `onBlur` onto the bubbling
      // `focusout` event, and a `blur` dispatched here reaches no handler at
      // all — the test would then pass for a component that never committed.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]![0]!.name).toBe('Client');
  });

  it('treats an emptied name as a REVERT rather than a save', async () => {
    // The schema refuses `min(1)`, so writing it would fail the whole patch and
    // take the rest of the list down with it.
    const { el, changes } = render([profile()]);
    const input = byLabel(
      el,
      'Name for /Users/x/.claude-work',
    ) as HTMLInputElement;

    type(input, '   ');
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(changes).toHaveLength(0);
    expect(input.value).toBe('Work');
  });

  it('adds the directory the picker returns, named after its own leaf', async () => {
    const { el, changes } = render([], async () => '/Users/x/.claude-lab');

    await act(async () => {
      [...el.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Add configuration'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toHaveLength(1);
    expect(changes[0]![0]!.dir).toBe('/Users/x/.claude-lab');
    expect(changes[0]![0]!.name).toBe('claude-lab');
    // Stamped with the CARD's own kind — a profile is offered to its one CLI.
    expect(changes[0]![0]!.agent).toBe('claude');
  });

  it('stamps a new configuration with the CARD it was added from, never a fixed CLI', async () => {
    // The list is rendered on every agent card whose CLI can take a config
    // directory, so a codex card's own "Add configuration" must not silently
    // hand back a claude profile — which is what a hardcoded stamp would do.
    const { el, changes } = render(
      [],
      async () => '/Users/x/.codex-lab',
      'codex',
    );

    await act(async () => {
      [...el.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Add configuration'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(changes[0]![0]!.agent).toBe('codex');
  });

  it('refuses a SECOND entry for a directory already in the list', async () => {
    // The directory is the identity: two names for one account leaves nothing
    // able to say which of them a run is using.
    const { el, changes } = render(
      [profile()],
      async () => '/Users/x/.claude-work',
    );

    await act(async () => {
      [...el.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Add configuration'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(changes).toHaveLength(0);
  });

  it('refuses to RE-POINT a row at a directory another row already stands for', async () => {
    // The same invariant as the test above, on the other path that can set a
    // directory. Enforced on the add alone, the row's own directory button was
    // free to aim at a folder already in the list — two names for one account,
    // reached by the control that exists to change one.
    const { el, changes } = render(
      [profile(), profile({ id: 'p2', name: 'Lab', dir: '/Users/x/.lab' })],
      async () => '/Users/x/.claude-work',
    );

    await act(async () => {
      byLabel(el, 'Change the directory for Lab').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(changes).toHaveLength(0);
  });

  it('lets a row be re-picked onto the directory it is already on', async () => {
    // The guard is about OTHER rows: a row that refused itself would make
    // re-confirming the same folder look like a broken button.
    const { el, changes } = render(
      [profile()],
      async () => '/Users/x/.claude-work',
    );

    await act(async () => {
      byLabel(el, 'Change the directory for Work').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]![0]!.dir).toBe('/Users/x/.claude-work');
  });

  it('writes nothing when the picker is cancelled', async () => {
    const { el, changes } = render([]);
    await act(async () => {
      [...el.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Add configuration'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(changes).toHaveLength(0);
  });

  it('removes one entry and leaves the rest in the user’s order', async () => {
    const { el, changes } = render([
      profile(),
      profile({ id: 'p2', name: 'Personal', dir: '/Users/x/.claude-home' }),
      profile({ id: 'p3', name: 'Lab', dir: '/Users/x/.claude-lab' }),
    ]);

    await act(async () => {
      byLabel(el, 'Remove Personal').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(changes[0]!.map((row) => row.id)).toEqual(['p1', 'p3']);
  });
});

describe('ConfigProfileList — signing a configuration in and out', () => {
  function renderAuth(
    profiles: ConfigProfile[],
    auth: {
      withHandlers?: boolean;
      signingIn?: string | null;
      busy?: boolean;
      logins?: Record<string, boolean | null>;
    } = {},
  ): { el: HTMLElement; signIns: string[]; signOuts: string[] } {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const signIns: string[] = [];
    const signOuts: string[] = [];
    const withHandlers = auth.withHandlers ?? true;
    act(() => {
      root.render(
        <ConfigProfileList
          agent="claude"
          profiles={profiles}
          onChange={() => undefined}
          onPickDirectory={async () => null}
          {...(withHandlers
            ? {
                onSignIn: (dir: string) => signIns.push(dir),
                onSignOut: (dir: string) => signOuts.push(dir),
              }
            : {})}
          signingIn={auth.signingIn ?? null}
          busy={auth.busy ?? false}
          logins={auth.logins ?? {}}
        />,
      );
    });
    return { el: container, signIns, signOuts };
  }

  const two = (): ConfigProfile[] => [
    profile(),
    profile({ id: 'p2', name: 'Personal', dir: '/Users/x/.claude-home' }),
  ];

  const press = (el: HTMLElement, label: string): void => {
    act(() => {
      byLabel(el, label).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
  };

  it('signs in the account of the row that was pressed — its own directory, not the first', () => {
    // The whole feature: a config directory IS an account, so the directory
    // handed over is what decides which account gets signed in. Pressing the
    // SECOND row is what tells "its own" apart from "whichever came first".
    const { el, signIns } = renderAuth(two());
    press(el, 'Sign in to Personal');
    expect(signIns).toEqual(['/Users/x/.claude-home']);
  });

  it('signs out the account of the row that was pressed', () => {
    const { el, signOuts } = renderAuth(two(), {
      logins: { '/Users/x/.claude-home': true },
    });
    press(el, 'Sign out of Personal');
    expect(signOuts).toEqual(['/Users/x/.claude-home']);
  });

  it('offers ONE verb per row, chosen by what the CLI said about that account', () => {
    // Both drawn side by side — two mirror-image arrow icons — would leave
    // the user to guess which one applies.
    const { el } = renderAuth(two(), {
      logins: { '/Users/x/.claude-work': true, '/Users/x/.claude-home': false },
    });
    const labels = [...el.querySelectorAll('button')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toContain('Sign out of Work');
    expect(labels).not.toContain('Sign in to Work');
    expect(labels).toContain('Sign in to Personal');
    expect(labels).not.toContain('Sign out of Personal');
  });

  it('offers Sign in when the account could not be asked', () => {
    // A re-sign-in of a live account is harmless; Sign out alone on a lapsed
    // one would leave no cure on the row.
    const { el } = renderAuth(two(), { logins: {} });
    const labels = [...el.querySelectorAll('button')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toContain('Sign in to Work');
    expect(labels).not.toContain('Sign out of Work');
  });

  it('offers neither verb when the caller has no daemon to ask', () => {
    // An absent handler renders nothing rather than a control that could only
    // report its own inability — the rule the card's own footer follows.
    const { el } = renderAuth(two(), { withHandlers: false });
    const labels = [...el.querySelectorAll('button')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).not.toContain('Sign in to Work');
    expect(labels).not.toContain('Sign out of Work');
  });

  it('blocks every row while ANY sign-in owns the card — the default profile’s included', () => {
    // The case `busy` exists for. A sign-in to the DEFAULT profile carries a
    // null directory, so `signingIn` is null throughout it — and a row that
    // only disabled on `signingIn` would stay live and start a second browser
    // challenge, which invalidates the first.
    const { el, signIns } = renderAuth(two(), {
      signingIn: null,
      busy: true,
      logins: { '/Users/x/.claude-work': true },
    });
    for (const label of ['Sign out of Work', 'Sign in to Personal']) {
      expect((byLabel(el, label) as HTMLButtonElement).disabled).toBe(true);
    }
    press(el, 'Sign in to Personal');
    expect(signIns).toEqual([]);
  });

  it('spins only the row whose sign-in is starting', () => {
    const { el } = renderAuth(two(), {
      signingIn: '/Users/x/.claude-home',
      busy: true,
    });
    const spins = (label: string): boolean =>
      byLabel(el, label).querySelector('.animate-spin') !== null;
    expect(spins('Sign in to Personal')).toBe(true);
    expect(spins('Sign in to Work')).toBe(false);
  });
});

describe('defaultName', () => {
  it('drops a leading dot — a hidden folder is not called `.claude-work`', () => {
    expect(defaultName('/Users/x/.claude-work')).toBe('claude-work');
  });

  it('ignores a trailing separator', () => {
    expect(defaultName('/Users/x/profiles/team/')).toBe('team');
  });

  it('never returns the empty string the schema would refuse', () => {
    // `min(1)` on the name, so a path with no usable segment has to fall back
    // to a word rather than to a value the very next write would reject.
    expect(defaultName('/')).toBe('Configuration');
    expect(defaultName('')).toBe('Configuration');
  });
});
