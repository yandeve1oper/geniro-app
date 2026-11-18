// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTACT_LIT_MS,
  ContactEdgeLine,
  type ContactEdgeLineProps,
  type ContactPulse,
  edgeStateOf,
  PULSE_TRAVEL_MS,
} from './contact-edge';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-17T12:00:00Z');
const before = (ms: number): string => new Date(NOW - ms).toISOString();

function pulse(
  id: string,
  at: string,
  direction: ContactPulse['direction'] = 'out',
): ContactPulse {
  return { id, threadId: 'thread', at, direction };
}

describe('edgeStateOf', () => {
  it('lights the edge for five minutes after the last contact', () => {
    expect(
      edgeStateOf(
        { lastAt: before(CONTACT_LIT_MS - 1), awaitingReply: false },
        [],
        NOW,
      ),
    ).toBe('lit');
  });

  it('goes idle exactly when five minutes have passed since the last contact', () => {
    expect(
      edgeStateOf(
        { lastAt: before(CONTACT_LIT_MS), awaitingReply: false },
        [],
        NOW,
      ),
    ).toBe('idle');
  });

  it('lights the edge for a pulse on that thread, and drops it once the pulse is five minutes old', () => {
    expect(edgeStateOf(undefined, [pulse('p', before(1_000))], NOW)).toBe(
      'lit',
    );
    expect(
      edgeStateOf(undefined, [pulse('p', before(CONTACT_LIT_MS))], NOW),
    ).toBe('idle');
  });

  it('is idle with no contact and no pulse at all', () => {
    expect(edgeStateOf(undefined, [], NOW)).toBe('idle');
    expect(edgeStateOf({ lastAt: null, awaitingReply: false }, [], NOW)).toBe(
      'idle',
    );
  });

  it('shows awaiting over lit, and keeps showing it long after the contact', () => {
    expect(
      edgeStateOf(
        { lastAt: before(1_000), awaitingReply: true },
        [pulse('p', before(1_000))],
        NOW,
      ),
    ).toBe('awaiting');
    expect(
      edgeStateOf(
        { lastAt: before(60 * 60 * 1000), awaitingReply: true },
        [],
        NOW,
      ),
    ).toBe('awaiting');
  });
});

describe('ContactEdgeLine travelling dot', () => {
  let container: HTMLDivElement;
  let root: Root;

  const props: ContactEdgeLineProps = {
    id: 'contact:thread',
    path: 'M 0 0 L 100 0',
    state: 'lit',
    pulses: [],
    now: NOW,
  };

  function draw(overrides: Partial<ContactEdgeLineProps>): void {
    act(() => {
      root.render(
        <svg>
          <ContactEdgeLine {...props} {...overrides} />
        </svg>,
      );
    });
  }

  function dots(): NodeListOf<Element> {
    return container.querySelectorAll('[data-slot="contact-dot"]');
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('draws one dot for a fresh pulse, running against the edge for an inbound pulse', () => {
    draw({ pulses: [pulse('p1', before(0), 'in')] });
    expect(dots()).toHaveLength(1);
    const motion = container.querySelector('animateMotion');
    expect(motion?.getAttribute('keyPoints')).toBe('1;0');
  });

  it('runs an outbound pulse from the manager end of the edge', () => {
    draw({ pulses: [pulse('p1', before(0), 'out')] });
    expect(
      container.querySelector('animateMotion')?.getAttribute('keyPoints'),
    ).toBe('0;1');
  });

  it('removes the travelling dot under prefers-reduced-motion, and keeps the edge state colour', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    draw({ pulses: [pulse('p1', before(0))] });
    expect(dots()).toHaveLength(0);
    expect(
      container
        .querySelector('[data-slot="contact-edge"]')
        ?.getAttribute('data-state'),
    ).toBe('lit');
  });

  it('streams dots out of the manager on a lit wire, back to it on an awaiting one, and only drifts an idle one', () => {
    const flow = (): Element | null =>
      container.querySelector('[data-slot="contact-flow"]');
    draw({ state: 'lit' });
    expect(flow()?.getAttribute('class')).toContain('cc-wire-flow');
    expect(flow()?.getAttribute('class')).not.toContain('cc-wire-flow-back');
    draw({ state: 'awaiting' });
    expect(flow()?.getAttribute('class')).toContain('cc-wire-flow-back');
    draw({ state: 'idle' });
    expect(flow()).toBeNull();
    expect(
      container
        .querySelector('[data-slot="contact-edge"] path')
        ?.getAttribute('class'),
    ).toContain('cc-wire-drift');
  });

  it('keeps every wire still under prefers-reduced-motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    draw({ state: 'lit' });
    expect(container.querySelector('[data-slot="contact-flow"]')).toBeNull();
    draw({ state: 'idle' });
    expect(
      container
        .querySelector('[data-slot="contact-edge"] path')
        ?.getAttribute('class'),
    ).not.toContain('cc-wire-drift');
  });

  it('does not draw a dot for a pulse older than the travel window', () => {
    draw({ pulses: [pulse('p1', before(PULSE_TRAVEL_MS))] });
    expect(dots()).toHaveLength(0);
  });

  it('plays each pulse once: the dot is gone after its travel, and a re-render does not replay it', () => {
    vi.useFakeTimers();
    draw({ pulses: [pulse('p1', before(0))] });
    expect(dots()).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(PULSE_TRAVEL_MS);
    });
    expect(dots()).toHaveLength(0);
    draw({ pulses: [pulse('p1', before(0))] });
    expect(dots()).toHaveLength(0);
  });
});
