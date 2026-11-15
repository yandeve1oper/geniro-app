import { describe, expect, it } from 'vitest';

import { historyQuerySchema } from '../dto/chat.dto';
import { historyConversationOf } from './history-conversation';

describe('historyConversationOf', () => {
  it("reads `conversation=root` as the run's own flow", () => {
    expect(historyConversationOf({ conversation: 'root' })).toEqual({
      root: true,
    });
  });

  it("reads `call` as that call's conversation", () => {
    expect(historyConversationOf({ call: 'call-3' })).toEqual({
      call: 'call-3',
    });
  });

  it("reads `delegate` as that delegate's own rows", () => {
    expect(historyConversationOf({ delegate: 'toolu_a' })).toEqual({
      delegate: 'toolu_a',
    });
  });

  it('reads neither as the whole run', () => {
    expect(historyConversationOf({})).toBeUndefined();
  });
});

describe('historyQuerySchema', () => {
  it('refuses a query naming the root flow and a call at once', () => {
    expect(
      historyQuerySchema.safeParse({ conversation: 'root', call: 'call-3' })
        .success,
    ).toBe(false);
  });

  it('refuses a conversation other than the root flow', () => {
    expect(
      historyQuerySchema.safeParse({ conversation: 'call-3' }).success,
    ).toBe(false);
  });

  it('refuses a delegate together with a call or the root flow', () => {
    expect(
      historyQuerySchema.safeParse({ delegate: 'toolu_a', call: 'call-3' })
        .success,
    ).toBe(false);
    expect(
      historyQuerySchema.safeParse({
        delegate: 'toolu_a',
        conversation: 'root',
      }).success,
    ).toBe(false);
  });

  it('accepts a delegate on its own, with a window', () => {
    expect(
      historyQuerySchema.safeParse({ delegate: 'toolu_a', limit: '200' })
        .success,
    ).toBe(true);
  });
});
