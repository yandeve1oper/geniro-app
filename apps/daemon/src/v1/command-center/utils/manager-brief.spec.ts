import { describe, expect, it } from 'vitest';

import { HOST_TELL_THREADS_TOOL } from '../../agents/chat.types';
import { composeManagerBrief, type RosterBriefLine } from './manager-brief';

const ROSTER: RosterBriefLine[] = [
  {
    handle: 't1',
    title: 'Billing  cache',
    project: 'Billing',
    reason: 'auto',
    note: 'waits for the schema to land',
  },
  {
    handle: 't2',
    title: 'Docs',
    project: null,
    reason: 'user',
    note: null,
  },
  {
    handle: 't3',
    title: 'Release',
    project: 'Web',
    reason: 'manager',
    note: 'owns the tag',
  },
];

describe('composeManagerBrief', () => {
  it('composes the same text for the same roster, byte for byte', () => {
    const again = structuredClone(ROSTER);

    expect(composeManagerBrief(again)).toBe(composeManagerBrief(ROSTER));
  });

  it('lists every handle with its title, project, why it is there and its note', () => {
    const brief = composeManagerBrief(ROSTER);

    expect(brief).toContain(
      '- t1 · Billing cache · Billing · active · note: waits for the schema to land',
    );
    expect(brief).toContain('- t2 · Docs · no project · added by the user');
    expect(brief).toContain(
      '- t3 · Release · Web · started by you · note: owns the tag',
    );
  });

  it('says no thread is active for an empty roster, and lists no handle', () => {
    const brief = composeManagerBrief([]);

    expect(brief).toContain('No threads are active right now.');
    expect(brief).not.toMatch(/^- t\d/m);
  });

  it('names the tool that reaches the threads by its wire name', () => {
    expect(composeManagerBrief(ROSTER)).toContain(
      `\`${HOST_TELL_THREADS_TOOL}\``,
    );
  });
});
