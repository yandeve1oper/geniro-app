import { describe, expect, it } from 'vitest';

import type {
  CalleeTurnOutcome,
  PoolStanding,
  TeamMember,
} from '../teams.types';
import {
  callPoolHandOffPrompt,
  conversationStartMember,
  fallsThroughPool,
  poolAttemptOrder,
  poolAttempts,
  poolHandOffNotice,
  poolHandOffPrompt,
  poolMemberLabel,
  poolMemberNode,
  poolMoveNotice,
  poolSize,
  poolSwitchNotice,
} from './agent-pool';

function pooled(): TeamMember {
  return {
    id: 'engineer',
    name: 'Engineer',
    agent: 'claude',
    model: 'opus',
    effort: 'high',
    configDir: '/profiles/work',
    instructions: 'Build things.',
    role: 'Builds.',
    approval: 'auto',
    pool: [
      { agent: 'claude', configDir: '/profiles/personal' },
      { agent: 'codex', model: 'gpt-5.5' },
    ],
  };
}

function failed(patch: Partial<CalleeTurnOutcome> = {}): CalleeTurnOutcome {
  return {
    status: 'failed',
    finalText: null,
    error: 'boom',
    failureClass: 'crashed',
    resetsAt: null,
    sessionId: null,
    ...patch,
  };
}

describe('poolMemberNode', () => {
  it('member 1 is the team member’s own settings, without the pool', () => {
    const member = poolMemberNode(pooled(), 1);
    expect(member).toMatchObject({
      agent: 'claude',
      model: 'opus',
      configDir: '/profiles/work',
    });
    expect(member?.pool).toBeUndefined();
  });

  it('a later member REPLACES the CLI settings whole and keeps the member’s own text', () => {
    const member = poolMemberNode(pooled(), 2);
    expect(member).toEqual({
      id: 'engineer',
      name: 'Engineer',
      agent: 'claude',
      configDir: '/profiles/personal',
      instructions: 'Build things.',
      role: 'Builds.',
      approval: 'auto',
    });
  });

  it('a member compacts at its own threshold, and never when it states none', () => {
    const node: TeamMember = {
      ...pooled(),
      autoCompactPercent: 80,
      pool: [{ agent: 'codex', autoCompactPercent: 60 }, { agent: 'codex' }],
    };
    expect(poolMemberNode(node, 1)?.autoCompactPercent).toBe(80);
    expect(poolMemberNode(node, 2)?.autoCompactPercent).toBe(60);
    expect(poolMemberNode(node, 3)).not.toHaveProperty('autoCompactPercent');
  });

  it('a member runs without its OWN switched-off MCP servers, never member 1’s', () => {
    const node: TeamMember = {
      ...pooled(),
      mcpDisabled: ['codegraph'],
      pool: [
        { agent: 'claude', mcpDisabled: ['playwright'] },
        { agent: 'codex' },
      ],
    };
    expect(poolMemberNode(node, 1)?.mcpDisabled).toEqual(['codegraph']);
    expect(poolMemberNode(node, 2)?.mcpDisabled).toEqual(['playwright']);
    // A member naming none switches nothing off — member 1's list names
    // another profile's servers.
    expect(poolMemberNode(node, 3)).not.toHaveProperty('mcpDisabled');
  });

  it('a pool member runs its own approval mode, else the team member’s', () => {
    const node: TeamMember = {
      ...pooled(),
      approval: 'acceptEdits',
      pool: [{ agent: 'codex', approval: 'auto' }, { agent: 'codex' }],
    };
    expect(poolMemberNode(node, 2)?.approval).toBe('auto');
    expect(poolMemberNode(node, 3)?.approval).toBe('acceptEdits');
  });

  it('answers null for a number the pool does not have', () => {
    expect(poolMemberNode(pooled(), 0)).toBeNull();
    expect(poolMemberNode(pooled(), 4)).toBeNull();
    expect(poolMemberNode(pooled(), 1.5)).toBeNull();
  });

  it('a team member with no pool is a pool of one', () => {
    const { pool: _pool, ...single } = pooled();
    expect(poolSize(single)).toBe(1);
    expect(poolSize(pooled())).toBe(3);
  });
});

describe('poolAttemptOrder', () => {
  it('tries members in priority order, starting with member 1', () => {
    expect(poolAttemptOrder([null, null, null])).toEqual([1, 2, 3]);
  });

  it('moves spent members to the back, preserving priority in each group', () => {
    expect(poolAttemptOrder([null, 'limit', null, 'limit'])).toEqual([
      1, 3, 2, 4,
    ]);
    expect(poolAttemptOrder(['limit', null, null, null])).toEqual([2, 3, 4, 1]);
    expect(poolAttemptOrder(['limit', 'limit'])).toEqual([1, 2]);
  });

  it('tries a member spent on an ordinary failure before one a limit spent', () => {
    expect(poolAttemptOrder(['limit', 'unavailable', null])).toEqual([3, 2, 1]);
  });
});

describe('conversationStartMember', () => {
  const start = (
    patch: Partial<Parameters<typeof conversationStartMember>[0]> & {
      standings: (PoolStanding | null)[];
    },
  ): number =>
    conversationStartMember({
      order: poolAttemptOrder(patch.standings),
      proven: patch.standings.map((standing) => standing === null),
      held: 1,
      hasSession: true,
      holdsWork: false,
      ...patch,
    });

  it('starts a team member with no conversation yet on the first pool member in order', () => {
    expect(start({ standings: ['unavailable', null], hasSession: false })).toBe(
      2,
    );
  });

  it('moves a conversation off a member a limit spent', () => {
    expect(start({ standings: ['limit', null] })).toBe(2);
    expect(start({ standings: ['limit', 'unavailable'] })).toBe(2);
  });

  it('keeps it where it is when every other member is limited too', () => {
    expect(start({ standings: ['limit', 'limit'], held: 2 })).toBe(2);
  });

  it('keeps it on a member spent only on an ordinary failure', () => {
    expect(start({ standings: ['unavailable', null] })).toBe(1);
  });

  it('moves it back to an earlier unspent member, unless the one it is on runs work', () => {
    expect(start({ standings: [null, null], held: 2 })).toBe(1);
    expect(start({ standings: [null, null], held: 2, holdsWork: true })).toBe(
      2,
    );
    expect(start({ standings: ['unavailable', null], held: 2 })).toBe(2);
  });

  it('never moves it back to an earlier member not proven to work again', () => {
    expect(
      start({ standings: [null, null], proven: [false, true], held: 2 }),
    ).toBe(2);
  });
});

describe('poolAttempts', () => {
  it('resolves each member in the order given', () => {
    const attempts = poolAttempts(pooled(), [3, 1]);
    expect(attempts.map((a) => [a.member, a.node.agent])).toEqual([
      [3, 'codex'],
      [1, 'claude'],
    ]);
  });
});

describe('fallsThroughPool', () => {
  it('hands on a usage limit or a lapsed sign-in even after work', () => {
    expect(
      fallsThroughPool(failed({ failureClass: 'rate_limited' }), true),
    ).toBe(true);
    expect(
      fallsThroughPool(failed({ failureClass: 'auth_expired' }), true),
    ).toBe(true);
  });

  it('hands on any failure that came before a single tool call', () => {
    expect(fallsThroughPool(failed(), false)).toBe(true);
  });

  it('keeps a failure mid-work, and never hands on a success or a cancel', () => {
    expect(fallsThroughPool(failed(), true)).toBe(false);
    expect(
      fallsThroughPool(
        failed({ status: 'cancelled', failureClass: null }),
        false,
      ),
    ).toBe(false);
    expect(
      fallsThroughPool(
        failed({ status: 'completed', failureClass: null }),
        false,
      ),
    ).toBe(false);
  });
});

describe('poolMemberLabel', () => {
  it('names the CLI, then what tells the member apart', () => {
    expect(
      poolMemberLabel({
        agent: 'claude',
        model: 'opus',
        effort: 'high',
        configDir: '/profiles/work',
      }),
    ).toBe('claude · opus · effort high · separate profile');
    expect(poolMemberLabel({ agent: 'codex' })).toBe('codex');
  });
});

describe('poolHandOffNotice', () => {
  it('names the CLI and model of the member the work moves to, and why', () => {
    const [, , third] = poolAttempts(pooled(), [1, 2, 3]);
    expect(
      poolHandOffNotice(
        'Senior Engineer',
        1,
        third!,
        failed({
          failureClass: 'rate_limited',
          resetsAt: '8pm (Asia/Dubai)',
        }),
      ),
    ).toBe(
      'Senior Engineer: pool member 1 hit a usage limit (resets 8pm (Asia/Dubai)) — handing the call to member 3 (codex · gpt-5.5).',
    );
  });
});

describe('poolMoveNotice', () => {
  it('names the pool member a turn moves to, back or on', () => {
    const [first, , third] = poolAttempts(pooled(), [1, 2, 3]);
    expect(poolMoveNotice('Engineer', 3, first!)).toBe(
      'Engineer: pool member 1 (claude · opus · effort high · separate profile) is available again — moving the conversation back to it from member 3.',
    );
    expect(poolMoveNotice('Engineer', 1, third!)).toBe(
      'Engineer: pool member 1 is unavailable — starting the turn on member 3 (codex · gpt-5.5).',
    );
  });
});

describe('poolSwitchNotice', () => {
  it('says the user moved the conversation, or only pinned the member it is on', () => {
    const [, , third] = poolAttempts(pooled(), [1, 2, 3]);
    expect(poolSwitchNotice('Engineer', third!, true)).toBe(
      'Engineer: switched to pool member 3 (codex · gpt-5.5) by the user — the conversation continues there in a new session.',
    );
    expect(poolSwitchNotice('Engineer', third!, false)).toBe(
      'Engineer: pinned to pool member 3 (codex · gpt-5.5) by the user.',
    );
  });
});

describe('poolHandOffPrompt', () => {
  it('passes the task on unchanged when nothing was said into the call', () => {
    expect(poolHandOffPrompt('build it', [])).toBe('build it');
  });

  it('carries what was said into the call after the task, in order', () => {
    expect(poolHandOffPrompt('build it', ['use red', 'skip tests'])).toBe(
      'build it\n\nMessages sent about this task after it was handed out, in order:\n- use red\n- skip tests',
    );
  });
});

describe('callPoolHandOffPrompt', () => {
  it('keeps the original task when recent tool output fills the history budget', () => {
    const prompt = callPoolHandOffPrompt('Finish the checks.', [
      {
        kind: 'call_started',
        role: null,
        payload: JSON.stringify({ message: 'Build in /work/letters.' }),
      },
      ...Array.from({ length: 200 }, () => ({
        kind: 'tool_result',
        role: null,
        payload: 'x'.repeat(20_000),
      })),
    ]);
    expect(prompt).toContain('Build in /work/letters.');
    expect(prompt).toContain('Finish the checks.');
    expect(prompt).toContain('[transcript item truncated]');
    expect(prompt.length).toBeLessThan(57_000);
  });
});
