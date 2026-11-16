import { describe, expect, it } from 'vitest';

import { readNodePoolMembers, readNodePoolPins } from './node-pool-members';

function row(memberId: string | null, payload: Record<string, unknown>) {
  return { memberId, payload: JSON.stringify(payload) };
}

describe('readNodePoolPins', () => {
  it('pins a member whose last own hand-off the user made', () => {
    const rows = [
      row('lead', { nodePoolHandOff: true, member: 2, fromMember: 1 }),
      row('lead', {
        nodePoolHandOff: true,
        member: 3,
        fromMember: 2,
        pinnedByUser: true,
      }),
    ];
    expect([...readNodePoolPins(rows)]).toEqual([['lead', true]]);
    expect(readNodePoolMembers(rows).get('lead')).toBe(3);
  });

  it('releases the pin once a later hand-off moves the conversation on its own', () => {
    const rows = [
      row('lead', {
        nodePoolHandOff: true,
        member: 2,
        fromMember: 1,
        pinnedByUser: true,
      }),
      row('lead', { nodePoolHandOff: true, member: 3, fromMember: 2 }),
    ];
    expect(readNodePoolPins(rows).size).toBe(0);
  });

  it('says a pin on the member the conversation was already on moved nothing', () => {
    const rows = [
      row('lead', {
        nodePoolHandOff: true,
        member: 1,
        fromMember: 1,
        pinnedByUser: true,
      }),
    ];
    expect([...readNodePoolPins(rows)]).toEqual([['lead', false]]);
    expect(readNodePoolMembers(rows).get('lead')).toBe(1);
  });

  it("ignores a call's hand-off and rows that name no member", () => {
    const rows = [
      row('lead', {
        nodePoolHandOff: true,
        member: 2,
        fromMember: 1,
        pinnedByUser: true,
      }),
      row('lead', {
        nodePoolHandOff: true,
        member: 3,
        fromMember: 2,
        callId: 'call-1',
      }),
      row(null, { nodePoolHandOff: true, member: 2, pinnedByUser: true }),
      row('qa', { nodePoolHandOff: true, pinnedByUser: true }),
    ];
    expect([...readNodePoolPins(rows)]).toEqual([['lead', true]]);
  });
});
