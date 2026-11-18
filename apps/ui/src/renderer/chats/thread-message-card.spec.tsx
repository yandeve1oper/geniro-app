// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountIntoDocument } from '../__tests__/mount-into-document';
import { ThreadMessageCard, ThreadOpenContext } from './thread-message-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const render = mountIntoDocument();

const LONG_TEXT = `${'a'.repeat(1_500)}\nthe last line`;
const REPLY = {
  text: 'Can you take the backfill?',
  at: '2026-11-06T10:00:00.000Z',
};

const MESSAGES = [
  {
    id: 'm1',
    fromRunId: 'r-pelican',
    fromTitle: 'Pelican',
    fromMember: null,
    text: 'hi there',
    inReplyTo: null,
  },
  {
    id: 'm2',
    fromRunId: 'r-otter',
    fromTitle: 'Otter',
    fromMember: 'Backend Engineer',
    text: LONG_TEXT,
    inReplyTo: null,
  },
];

const ANSWERING = [{ ...MESSAGES[0]!, inReplyTo: REPLY }];

describe('ThreadMessageCard', () => {
  it('draws each message with its sender and its whole text', () => {
    const el = render(<ThreadMessageCard messages={MESSAGES} />);
    const cards = el.querySelectorAll('[data-slot="thread-message"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('Pelican');
    expect(cards[0]?.textContent).toContain('hi there');
    expect(cards[1]?.textContent).toContain('Backend Engineer');
    expect(cards[1]?.textContent).toContain('the last line');
  });

  it('holds a long received text to three lines', () => {
    const el = render(<ThreadMessageCard messages={MESSAGES} />);
    const texts = el.querySelectorAll('[data-slot="thread-message-text"]');
    expect(texts[1]?.className).toContain('line-clamp-3');
  });

  it('shows the message a message answers above its text, with the whole excerpt as its title', () => {
    const el = render(<ThreadMessageCard messages={ANSWERING} />);
    const reply = el.querySelector<HTMLElement>(
      '[data-slot="thread-message-reply-to"]',
    );
    const text = el.querySelector('[data-slot="thread-message-text"]');
    expect(reply?.textContent).toContain('replying to your message');
    expect(reply?.textContent).toContain(REPLY.text);
    expect(reply?.getAttribute('title')).toBe(REPLY.text);
    expect(
      reply!.compareDocumentPosition(text!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows no reply line for a message that answers nothing', () => {
    const el = render(<ThreadMessageCard messages={MESSAGES} />);
    expect(
      el.querySelector('[data-slot="thread-message-reply-to"]'),
    ).toBeNull();
  });

  it('opens the sending thread when its title is pressed, where threads can open', () => {
    const opened: string[] = [];
    const el = render(
      <ThreadOpenContext.Provider value={(runId) => opened.push(runId)}>
        <ThreadMessageCard messages={MESSAGES} />
      </ThreadOpenContext.Provider>,
    );
    act(() => {
      el.querySelectorAll<HTMLButtonElement>(
        '[data-slot="thread-title"]',
      )[1]!.click();
    });
    expect(opened).toEqual(['r-otter']);
  });

  it('draws the sender as a chip with an arrow only where a thread can be opened', () => {
    const opened = render(
      <ThreadOpenContext.Provider value={() => {}}>
        <ThreadMessageCard messages={MESSAGES} />
      </ThreadOpenContext.Provider>,
    );
    expect(
      opened.querySelector('[data-slot="thread-title"] svg'),
    ).not.toBeNull();

    const plain = render(<ThreadMessageCard messages={MESSAGES} />);
    expect(plain.querySelector('[data-slot="thread-title"]')).toBeNull();
    expect(plain.textContent).toContain('Otter');
    expect(
      plain.querySelector('[data-slot="thread-message"] svg'),
    ).not.toBeNull();
  });
});
