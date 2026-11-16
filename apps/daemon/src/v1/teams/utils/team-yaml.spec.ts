import { BadRequestException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../__tests__/team-builders';
import type { Team } from '../teams.types';
import {
  parseTeamYaml,
  parseTeamYamlDocument,
  serializeTeamYaml,
} from './team-yaml';

const VALID_SOURCE = `# My review team
name: review-team
mode: lead
members:
  # the coder writes the change
  - id: coder
    name: Coder
    agent: claude
    instructions: You write the code.
  - id: reviewer
    name: Reviewer
    agent: cursor-agent
    approval: ask
triggers:
  - kind: first-message
    member: coder
instructionBlocks: []
`;

const LEGACY_SOURCE = `# An old graph
name: review-team
description: Reviews changes
maxActiveTurns: 2
nodes:
  - id: start
    kind: trigger
    trigger: manual
  - id: coder
    kind: agent
    name: Coder
    agent: claude
    description: Writes the change.
    role: You write the code.
  - id: reviewer
    kind: agent
    agent: cursor-agent
    approval: ask
  - id: style
    kind: instruction
    name: House style
    instructions: Prefer short sentences.
edges:
  - from: start
    to: coder
    kind: data
  - from: coder
    to: reviewer
    kind: call
  - from: coder
    to: reviewer
    kind: data
  - from: style
    to: coder
    kind: instruction
layout:
  coder:
    x: 1
    'y': 2
stages:
  - id: build
    title: Build
    instructions: Write it.
    doneWhen: It compiles
    ownerHint: coder
    next: [ship]
  - id: ship
    title: Ship
    doneWhen: It is released
`;

function rejection(source: string): BadRequestException {
  try {
    parseTeamYaml(source);
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return err as BadRequestException;
  }
  return expect.unreachable('expected a rejection');
}

describe('parseTeamYaml', () => {
  it('parses a valid team and fills zod defaults', () => {
    const team = parseTeamYaml(VALID_SOURCE);
    expect(team.name).toBe('review-team');
    expect(team.mode).toBe('lead');
    expect(team.members.map((m) => m.id)).toEqual(['coder', 'reviewer']);
    expect(team.members[0]!.approval).toBe('auto');
    expect(team.members[1]!.approval).toBe('ask');
    expect(team.triggers).toEqual([{ kind: 'first-message', member: 'coder' }]);
  });

  it('defaults the mode, members, triggers and blocks of a bare file', () => {
    expect(parseTeamYaml('name: bare\n')).toEqual({
      name: 'bare',
      mode: 'lead',
      members: [],
      triggers: [],
      instructionBlocks: [],
    });
  });

  it('rejects malformed YAML with TEAM_YAML_INVALID', () => {
    const exception = rejection('members: [\nname: :');
    expect(exception.errorCode).toBe('TEAM_YAML_INVALID');
  });

  it('rejects schema violations naming the offending path', () => {
    const exception = rejection(
      'name: x\nmembers:\n  - id: a\n    name: A\n    agent: gpt\n',
    );
    expect(exception.errorCode).toBe('TEAM_YAML_INVALID');
    expect(exception.getMessage()).toContain('members.0.agent');
  });

  it('rejects a member with no name', () => {
    const exception = rejection(
      'name: x\nmembers:\n  - id: a\n    agent: claude\n',
    );
    expect(exception.errorCode).toBe('TEAM_YAML_INVALID');
    expect(exception.getMessage()).toContain('members.0.name');
  });

  it('rejects a trigger of an unknown kind naming the path', () => {
    const exception = rejection(
      'name: x\ntriggers:\n  - kind: schedule\n    member: a\n',
    );
    expect(exception.getMessage()).toContain('triggers.0.kind');
  });
});

describe('parseTeamYaml — a team written as a node graph', () => {
  it('converts agent nodes to members, the trigger edge to the trigger, and instruction nodes to blocks', () => {
    const team = parseTeamYaml(LEGACY_SOURCE);

    expect(team.name).toBe('review-team');
    expect(team.description).toBe('Reviews changes');
    expect(team.maxActiveTurns).toBe(2);
    expect(team.mode).toBe('lead');
    expect(team.members).toEqual([
      member('coder', {
        name: 'Coder',
        role: 'Writes the change.',
        instructions: 'You write the code.',
      }),
      member('reviewer', { agent: 'cursor-agent', approval: 'ask' }),
    ]);
    expect(team.triggers).toEqual([{ kind: 'first-message', member: 'coder' }]);
    expect(team.instructionBlocks).toEqual([
      {
        id: 'style',
        title: 'House style',
        text: 'Prefer short sentences.',
        audience: ['coder'],
      },
    ]);
  });

  it('converts the stages: instructions, doneWhen and ownerHint become howToWork, goal and responsible', () => {
    expect(parseTeamYaml(LEGACY_SOURCE).stages).toEqual([
      {
        id: 'build',
        title: 'Build',
        howToWork: 'Write it.',
        goal: 'It compiles',
        responsible: ['coder'],
        next: ['ship'],
      },
      { id: 'ship', title: 'Ship', goal: 'It is released' },
    ]);
  });

  it('drops the layout and the edges, and says in the notes that the file was a graph', () => {
    const { team, legacyNotes } = parseTeamYamlDocument(LEGACY_SOURCE);

    expect(JSON.stringify(team)).not.toContain('layout');
    expect(legacyNotes).toEqual([
      'dropped the data edge "coder" → "reviewer": members hand work on by calling each other',
      'every member may now call every other; the graph allowed only "coder" → "reviewer"',
    ]);
  });

  it('reports no legacy notes for a file already written as a team', () => {
    expect(parseTeamYamlDocument(VALID_SOURCE).legacyNotes).toBeNull();
  });

  it('rejects a node graph that does not parse, naming the offending path', () => {
    const exception = rejection(
      'name: old\nnodes:\n  - id: a\n    kind: agent\n    agent: gpt\n',
    );
    expect(exception.errorCode).toBe('TEAM_YAML_INVALID');
    expect(exception.getMessage()).toContain('nodes.0.agent');
  });

  it('rejects a kind-less node of a graph', () => {
    const exception = rejection(
      'name: old\nnodes:\n  - id: a\n    agent: claude\n',
    );
    expect(exception.errorCode).toBe('TEAM_YAML_INVALID');
  });
});

describe('serializeTeamYaml', () => {
  it('emits parseable YAML for a fresh team (no existing source)', () => {
    const team = teamOf([member('a')]);
    expect(parseTeamYaml(serializeTeamYaml(team))).toEqual(team);
  });

  it('round-trips a team with every top-level field set', () => {
    const team: Team = teamOf(
      [
        member('a', {
          role: 'Does things',
          instructions: 'Privately',
          character: 'Dry',
        }),
        member('b'),
      ],
      {
        description: 'all of it',
        maxActiveTurns: 2,
        instructionBlocks: [
          { id: 'blk', title: 'Blk', text: 'Be brief', audience: ['b'] },
        ],
        stages: [
          { id: 'only', title: 'Only', goal: 'done', responsible: ['a'] },
        ],
      },
    );

    expect(parseTeamYaml(serializeTeamYaml(team))).toEqual(team);
  });

  it('preserves user comments when patching an existing file', () => {
    const team = parseTeamYaml(VALID_SOURCE);
    team.members[0]!.model = 'opus';
    const out = serializeTeamYaml(team, VALID_SOURCE);
    expect(out).toContain('# My review team');
    expect(out).toContain('# the coder writes the change');
    expect(parseTeamYaml(out).members[0]!.model).toBe('opus');
  });

  it('drops a removed member from the file', () => {
    const team = parseTeamYaml(VALID_SOURCE);
    const pruned: Team = {
      ...team,
      members: team.members.filter((m) => m.id !== 'reviewer'),
    };
    const out = serializeTeamYaml(pruned, VALID_SOURCE);
    expect(out).not.toContain('reviewer');
    expect(parseTeamYaml(out).members.map((m) => m.id)).toEqual(['coder']);
  });

  it('appends a new member while keeping the existing ones in place', () => {
    const team = parseTeamYaml(VALID_SOURCE);
    const grown: Team = {
      ...team,
      members: [...team.members, member('tester')],
    };
    const out = serializeTeamYaml(grown, VALID_SOURCE);
    expect(out).toContain('# the coder writes the change');
    expect(parseTeamYaml(out).members.map((m) => m.id)).toEqual([
      'coder',
      'reviewer',
      'tester',
    ]);
  });

  it("writes a reordered member list into an existing file, keeping each member's comments", () => {
    const team = parseTeamYaml(VALID_SOURCE);
    const reordered: Team = { ...team, members: [...team.members].reverse() };
    const out = serializeTeamYaml(reordered, VALID_SOURCE);
    expect(parseTeamYaml(out).members.map((m) => m.id)).toEqual([
      'reviewer',
      'coder',
    ]);
    expect(out).toContain('# the coder writes the change');
  });

  it('writes a reordered block list into an existing file', () => {
    const blocks = [
      { id: 'one', title: 'One', text: 'a', audience: 'everyone' as const },
      { id: 'two', title: 'Two', text: 'b', audience: 'everyone' as const },
    ];
    const team = { ...parseTeamYaml(VALID_SOURCE), instructionBlocks: blocks };
    const source = serializeTeamYaml(team, VALID_SOURCE);
    const out = serializeTeamYaml(
      { ...team, instructionBlocks: [...blocks].reverse() },
      source,
    );
    expect(parseTeamYaml(out).instructionBlocks.map((b) => b.id)).toEqual([
      'two',
      'one',
    ]);
  });

  it('clears an optional field the editor removed', () => {
    const team = parseTeamYaml(VALID_SOURCE);
    delete team.members[0]!.instructions;
    const out = serializeTeamYaml(team, VALID_SOURCE);
    expect(out).not.toContain('You write the code.');
    expect(parseTeamYaml(out).members[0]!.instructions).toBeUndefined();
  });

  it('writes the mode into an existing file', () => {
    const team = parseTeamYaml(VALID_SOURCE);
    team.mode = 'relay';
    const out = serializeTeamYaml(team, VALID_SOURCE);
    expect(parseTeamYaml(out).mode).toBe('relay');
    expect(out).toContain('# the coder writes the change');
  });

  it('writes maxActiveTurns into an existing file, and removes it once cleared', () => {
    const team = parseTeamYaml(VALID_SOURCE);
    team.maxActiveTurns = 3;
    const out = serializeTeamYaml(team, VALID_SOURCE);
    expect(parseTeamYaml(out).maxActiveTurns).toBe(3);
    expect(out).toContain('# the coder writes the change');

    const cleared = parseTeamYaml(out);
    delete cleared.maxActiveTurns;
    const back = serializeTeamYaml(cleared, out);
    expect(back).not.toContain('maxActiveTurns');
    expect(parseTeamYaml(back).maxActiveTurns).toBeUndefined();
  });

  it.each(['on', 'off'] as const)(
    'round-trips a team whose lessons setting is %s',
    (lessons) => {
      const team: Team = teamOf([member('a')], { lessons });

      expect(parseTeamYaml(serializeTeamYaml(team)).lessons).toBe(lessons);
      expect(parseTeamYaml(serializeTeamYaml(team))).toEqual(team);
    },
  );

  it('writes lessons: off into an existing file, and reads it back', () => {
    const team = parseTeamYaml(VALID_SOURCE);
    team.lessons = 'off';
    const out = serializeTeamYaml(team, VALID_SOURCE);

    expect(out).toContain('lessons: off');
    expect(parseTeamYaml(out).lessons).toBe('off');
    expect(out).toContain('# the coder writes the change');
  });

  it('removes lessons from the file once the team drops it, so it inherits again', () => {
    const team = parseTeamYaml(VALID_SOURCE);
    team.lessons = 'off';
    const withOff = serializeTeamYaml(team, VALID_SOURCE);

    const inherited = parseTeamYaml(withOff);
    delete inherited.lessons;
    const back = serializeTeamYaml(inherited, withOff);

    expect(back).not.toContain('lessons');
    expect(parseTeamYaml(back).lessons).toBeUndefined();
  });

  it('refuses a lessons value that is neither on nor off, naming the path', () => {
    const exception = rejection(
      'name: x\nlessons: maybe\nmembers:\n  - id: a\n    name: A\n',
    );
    expect(exception.errorCode).toBe('TEAM_YAML_INVALID');
    expect(exception.getMessage()).toContain('lessons');
  });

  it('writes a moved trigger into an existing file', () => {
    const team = parseTeamYaml(VALID_SOURCE);
    team.triggers = [{ kind: 'first-message', member: 'reviewer' }];
    const out = serializeTeamYaml(team, VALID_SOURCE);
    expect(parseTeamYaml(out).triggers).toEqual(team.triggers);
    expect(out).toContain('# the coder writes the change');
  });

  it('writes stages into an existing file, keeps their comments while unchanged, and removes them once cleared', () => {
    const team = parseTeamYaml(VALID_SOURCE);
    team.stages = [
      {
        id: 'investigation',
        title: 'Investigation',
        goal: 'The cause is known',
        next: ['fix'],
      },
      { id: 'fix', title: 'Fix', goal: 'Tests pass' },
    ];
    const out = serializeTeamYaml(team, VALID_SOURCE);
    expect(parseTeamYaml(out).stages).toEqual(team.stages);
    expect(out).toContain('# the coder writes the change');

    const commented = out.replace(
      'title: Investigation',
      'title: Investigation # first look',
    );
    const resaved = serializeTeamYaml(parseTeamYaml(commented), commented);
    expect(resaved).toContain('# first look');

    const cleared = parseTeamYaml(resaved);
    delete cleared.stages;
    const back = serializeTeamYaml(cleared, resaved);
    expect(back).not.toContain('stages');
    expect(parseTeamYaml(back).stages).toBeUndefined();
  });

  it('merges every top-level field of a team into an existing file, and drops each optional one once cleared', () => {
    const full: Team = teamOf([member('a')], {
      name: 'merged',
      description: 'every field set',
      maxActiveTurns: 2,
      instructionBlocks: [
        { id: 'blk', title: 'Blk', text: 'text', audience: 'everyone' },
      ],
      stages: [{ id: 'only', title: 'Only', goal: 'done' }],
    });
    const bare: Team = teamOf([], { name: 'bare' });

    const merged = serializeTeamYaml(full, serializeTeamYaml(bare));
    expect(parseTeamYaml(merged)).toEqual(full);

    const cleared = serializeTeamYaml(bare, merged);
    expect(parseTeamYaml(cleared)).toEqual(bare);
    expect(Object.keys(parseTeamYaml(cleared)).sort()).toEqual([
      'instructionBlocks',
      'members',
      'mode',
      'name',
      'triggers',
    ]);
  });

  it('keeps a hand-written stage block, comments and key order, when a save leaves it unchanged', () => {
    const source = `${VALID_SOURCE}stages:
  # what every run walks
  - goal: The cause is known # goal first, by hand
    id: investigation
    title: Investigation
`;
    const out = serializeTeamYaml(parseTeamYaml(source), source);
    expect(out).toContain('# goal first, by hand');
    expect(out).toContain('# what every run walks');
  });

  it.each<[string, Partial<Team['members'][number]>]>([
    ['name', { name: 'Renamed' }],
    ['character', { character: 'Dry and brief' }],
    ['avatar', { avatar: { kind: 'emoji', value: '🦊' } }],
    ['role', { role: 'Writes the change.' }],
    ['instructions', { instructions: 'Work in small steps.' }],
    ['configDir', { configDir: '/opt/plugins/reviewer' }],
    [
      'pool',
      {
        pool: [
          { agent: 'claude', configDir: '/profiles/personal' },
          { agent: 'codex', model: 'gpt-5.5' },
        ],
      },
    ],
    ['mcpDisabled', { mcpDisabled: ['notes'] }],
  ])('writes a member %s back into an existing file', (_field, change) => {
    const team = parseTeamYaml(VALID_SOURCE);
    Object.assign(team.members[0]!, change);

    const out = serializeTeamYaml(team, VALID_SOURCE);

    expect(parseTeamYaml(out).members[0]).toMatchObject(change);
    expect(out).toContain('# the coder writes the change');
  });

  it('refuses a pool member naming no CLI', () => {
    const source = VALID_SOURCE.replace(
      '    instructions: You write the code.',
      '    instructions: You write the code.\n    pool:\n      - model: opus',
    );
    expect(() => parseTeamYaml(source)).toThrow(BadRequestException);
  });

  it('clears a configDir the inspector removed', () => {
    const withConfigDir = VALID_SOURCE.replace(
      '    instructions: You write the code.',
      '    instructions: You write the code.\n    configDir: /opt/plugins/reviewer',
    );
    const team = parseTeamYaml(withConfigDir);
    expect(team.members[0]!.configDir).toBe('/opt/plugins/reviewer');
    delete team.members[0]!.configDir;

    const out = serializeTeamYaml(team, withConfigDir);

    expect(out).not.toContain('/opt/plugins/reviewer');
    expect(parseTeamYaml(out).members[0]!.configDir).toBeUndefined();
  });

  it('does not emit a member twice when the existing file already holds its id twice', () => {
    const dupSource = `name: review-team
members:
  - id: coder
    name: Coder
    agent: claude
  - id: coder
    name: Coder
    agent: claude
  - id: reviewer
    name: Reviewer
    agent: cursor-agent
`;
    const team = teamOf([
      member('coder'),
      member('reviewer', { agent: 'cursor-agent' }),
    ]);
    const back = parseTeamYaml(serializeTeamYaml(team, dupSource));
    expect(back.members.map((m) => m.id)).toEqual(['coder', 'reviewer']);
  });

  it('falls back to a clean dump when the existing source is unparseable', () => {
    const team = teamOf([member('a')], { name: 'rescued' });
    const out = serializeTeamYaml(team, 'members: [\nname: :');
    expect(parseTeamYaml(out)).toEqual(team);
  });

  it('re-dumps fresh over a file still written as a node graph, dropping its comments and nodes', () => {
    const team = parseTeamYaml(LEGACY_SOURCE);

    const out = serializeTeamYaml(team, LEGACY_SOURCE);

    expect(out).not.toContain('# An old graph');
    expect(out).not.toContain('nodes:');
    expect(out).not.toContain('edges:');
    expect(out).not.toContain('layout');
    expect(parseTeamYaml(out)).toEqual(team);
    expect(parseTeamYamlDocument(out).legacyNotes).toBeNull();
  });
});

const BLOCK_SOURCE = `name: with-notes
members:
  - id: writer
    name: Writer
    agent: claude
  - id: editor
    name: Editor
    agent: claude
triggers:
  - kind: first-message
    member: writer
instructionBlocks:
  # the house style every writer shares
  - id: style
    title: Style
    text: Prefer short sentences.
    audience: everyone
  - id: edits
    title: Edits
    text: Mark changes.
    audience: [editor]
`;

describe('instruction blocks', () => {
  it('parses a block and its audience', () => {
    const team = parseTeamYaml(BLOCK_SOURCE);
    expect(team.instructionBlocks).toEqual([
      {
        id: 'style',
        title: 'Style',
        text: 'Prefer short sentences.',
        audience: 'everyone',
      },
      {
        id: 'edits',
        title: 'Edits',
        text: 'Mark changes.',
        audience: ['editor'],
      },
    ]);
  });

  it('defaults a block that names only its id and title: no text, audience everyone', () => {
    const team = parseTeamYaml(
      'name: n\ninstructionBlocks:\n  - id: style\n    title: Style\n',
    );
    expect(team.instructionBlocks).toEqual([
      { id: 'style', title: 'Style', text: '', audience: 'everyone' },
    ]);
  });

  // A hand-written `text:` with nothing after it parses as NULL, which a plain
  // `.default('')` never fires for.
  it('accepts a block whose text key is present but empty', () => {
    const team = parseTeamYaml(
      'name: n\ninstructionBlocks:\n  - id: style\n    title: Style\n    text:\n',
    );
    expect(team.instructionBlocks[0]!.text).toBe('');
  });

  it('keeps block text and audience, and the comment above a block, through a save', () => {
    const team = parseTeamYaml(BLOCK_SOURCE);
    team.instructionBlocks[0]!.text = 'Prefer short sentences. Cite files.';
    team.instructionBlocks[1]!.audience = ['writer', 'editor'];

    const out = serializeTeamYaml(team, BLOCK_SOURCE);

    expect(out).toContain('# the house style every writer shares');
    expect(parseTeamYaml(out).instructionBlocks).toEqual(
      team.instructionBlocks,
    );
  });

  it('drops a removed block and appends a new one', () => {
    const team = parseTeamYaml(BLOCK_SOURCE);
    team.instructionBlocks = [
      team.instructionBlocks[1]!,
      { id: 'tone', title: 'Tone', text: 'Warm.', audience: 'everyone' },
    ];

    const out = serializeTeamYaml(team, BLOCK_SOURCE);

    expect(out).not.toContain('Prefer short sentences.');
    expect(parseTeamYaml(out).instructionBlocks.map((b) => b.id)).toEqual([
      'edits',
      'tone',
    ]);
  });

  it('loads a block of 16,787 characters intact — no length limit', () => {
    const text = 'x'.repeat(16_787);
    const team = parseTeamYaml(
      `name: n\ninstructionBlocks:\n  - id: style\n    title: Style\n    text: ${text}\n`,
    );
    expect(team.instructionBlocks[0]!.text).toBe(text);
  });

  it('refuses a control character in a block', () => {
    const exception = rejection(
      'name: n\ninstructionBlocks:\n  - id: style\n    title: Style\n    text: "a\\u0000b"\n',
    );
    expect(exception.errorCode).toBe('TEAM_YAML_INVALID');
    expect(exception.getMessage()).toContain('instructionBlocks.0.text');
  });

  it('still accepts an empty block text', () => {
    const team = parseTeamYaml(
      'name: n\ninstructionBlocks:\n  - id: style\n    title: Style\n    text: ""\n',
    );
    expect(team.instructionBlocks[0]!.text).toBe('');
  });
});

const FIELD_COMMENT_SOURCE = `name: annotated
members:
  - id: coder
    name: Coder
    # which CLI drives this member
    agent: claude
    model: opus
    instructions: You write the code.
`;

describe('comment-preserving merge — member FIELD comments', () => {
  it('keeps a comment written on a member field, and the file’s field order', () => {
    const team = parseTeamYaml(FIELD_COMMENT_SOURCE);
    team.members[0]!.model = 'sonnet';
    const out = serializeTeamYaml(team, FIELD_COMMENT_SOURCE);

    expect(out).toContain('# which CLI drives this member');
    expect(out.indexOf('agent:')).toBeLessThan(out.indexOf('model:'));
    expect(out.indexOf('model:')).toBeLessThan(out.indexOf('instructions:'));
    expect(parseTeamYaml(out).members[0]!.model).toBe('sonnet');
  });

  it('clears a field the editor removed without disturbing its neighbours', () => {
    const team = parseTeamYaml(FIELD_COMMENT_SOURCE);
    delete team.members[0]!.instructions;
    const out = serializeTeamYaml(team, FIELD_COMMENT_SOURCE);

    expect(out).toContain('# which CLI drives this member');
    expect(out).not.toContain('instructions:');
    expect(parseTeamYaml(out).members[0]!.model).toBe('opus');
  });
});
