import { describe, expect, it } from 'vitest';

import type { Team, TeamOverlay } from '../teams.types';
import { applyTeamOverlay, overlayCounts } from './team-overlay';
import {
  parseTeamOverlayYaml,
  serializeTeamOverlayYaml,
} from './team-overlay-yaml';

const TEAM: Team = {
  name: 'Dev',
  mode: 'lead',
  members: [
    {
      id: 'lead',
      name: 'Lead',
      agent: 'claude',
      approval: 'ask',
      model: 'opus',
      effort: 'high',
      configDir: '/profiles/claude-home',
      autoCompactPercent: 80,
      instructions: 'Plan the work.',
      mcpDisabled: ['linear'],
      pool: [
        { agent: 'claude', model: 'sonnet' },
        { agent: 'codex', model: 'gpt-5' },
      ],
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      agent: 'cursor-agent',
      approval: 'auto',
      model: 'composer',
    },
  ],
  triggers: [{ kind: 'first-message', member: 'lead' }],
  instructionBlocks: [
    { id: 'b1', title: 'Shared', text: 'Be brief.', audience: 'everyone' },
  ],
  stages: [
    {
      id: 'build',
      title: 'Build',
      goal: 'It builds',
      howToWork: 'Write the code.',
    },
  ],
};

function apply(overlay: TeamOverlay) {
  return applyTeamOverlay(TEAM, overlay, 'p1');
}

describe('applyTeamOverlay', () => {
  it('member override beats allMembers beats team', () => {
    const { team } = apply({
      allMembers: { claude: { effort: 'low', model: 'haiku' } },
      members: { lead: { settings: { effort: 'max' } } },
    });
    const lead = team.members[0]!;

    expect(lead.effort).toBe('max');
    expect(lead.model).toBe('haiku');
    expect(lead.configDir).toBe('/profiles/claude-home');
    expect(team.members[1]!.model).toBe('composer');
  });

  it('agent override resets the whole Model group', () => {
    const { team } = apply({
      allMembers: { codex: { effort: 'medium' } },
      members: { lead: { settings: { agent: 'codex' } } },
    });
    const lead = team.members[0]!;

    expect(lead.agent).toBe('codex');
    expect(lead.model).toBeUndefined();
    expect(lead.configDir).toBeUndefined();
    expect(lead.autoCompactPercent).toBeUndefined();
    expect(lead.effort).toBe('medium');
    expect(lead.approval).toBe('ask');
  });

  it('drops the team’s context window and model parameters when the overlay picks another model', () => {
    const team: Team = {
      ...TEAM,
      members: [
        {
          ...TEAM.members[0]!,
          contextWindow: '1m',
          modelParameters: { fast: 'on' },
        },
        TEAM.members[1]!,
      ],
    };

    const picked = applyTeamOverlay(
      team,
      { members: { lead: { settings: { model: 'haiku' } } } },
      'p1',
    ).team.members[0]!;
    const same = applyTeamOverlay(
      team,
      { members: { lead: { settings: { model: 'opus', effort: 'low' } } } },
      'p1',
    ).team.members[0]!;

    expect(picked.model).toBe('haiku');
    expect(picked.contextWindow).toBeUndefined();
    expect(picked.modelParameters).toBeUndefined();
    expect(same).toMatchObject({
      contextWindow: '1m',
      modelParameters: { fast: 'on' },
    });
  });

  it('drops an allMembers window too when the member’s own override picks another model', () => {
    const member = applyTeamOverlay(
      TEAM,
      {
        allMembers: { claude: { model: 'opus', contextWindow: '1m' } },
        members: { lead: { settings: { model: 'sonnet' } } },
      },
      'p1',
    ).team.members[0]!;

    expect(member.model).toBe('sonnet');
    expect(member.contextWindow).toBeUndefined();
  });

  it('applies allMembers to the team pool entries of that kind only', () => {
    const { team } = apply({
      allMembers: { claude: { configDir: '/profiles/work' } },
    });
    const pool = team.members[0]!.pool!;

    expect(pool[0]!.configDir).toBe('/profiles/work');
    expect(pool[1]!.configDir).toBeUndefined();
  });

  it('a member pool override replaces the whole pool and allMembers leaves it alone', () => {
    const { team } = apply({
      allMembers: { claude: { configDir: '/profiles/work' } },
      members: {
        lead: { pool: [{ agent: 'claude', configDir: '/profiles/claude-2' }] },
      },
    });

    expect(team.members[0]!.pool).toEqual([
      { agent: 'claude', configDir: '/profiles/claude-2' },
    ]);
  });

  it('an empty pool override leaves the member with no pool', () => {
    const { team } = apply({ members: { lead: { pool: [] } } });

    expect(team.members[0]!.pool).toEqual([]);
  });

  it('a member MCP override replaces the team’s switches whole, and [] runs every server', () => {
    expect(
      apply({ members: { lead: { mcpDisabled: ['figma', 'github'] } } }).team
        .members[0]!.mcpDisabled,
    ).toEqual(['figma', 'github']);
    expect(
      apply({ members: { lead: { mcpDisabled: [] } } }).team.members[0]!
        .mcpDisabled,
    ).toBeUndefined();
    expect(apply({}).team.members[0]!.mcpDisabled).toEqual(['linear']);
  });

  it('an agent override keeps the member’s MCP switches', () => {
    const { team } = apply({
      members: { lead: { settings: { agent: 'codex' } } },
    });

    expect(team.members[0]!.mcpDisabled).toEqual(['linear']);
  });

  it('appends extra instructions and leaves the stages as the team has them', () => {
    const { team } = apply({
      members: { lead: { extraInstructions: 'Use the staging DB.' } },
    });

    expect(team.members[0]!.instructions).toBe(
      'Plan the work.\n\nUse the staging DB.',
    );
    expect(team.stages).toEqual(TEAM.stages);
  });

  it('drops entries for a removed member and reports them as orphans', () => {
    const { team, orphans } = apply({
      members: { gone: { settings: { effort: 'low' } } },
      instructionBlocks: [
        { id: 'o1', title: 'P', text: 'Hi', audience: ['lead', 'gone'] },
      ],
    });

    expect(orphans).toEqual([
      'members.gone',
      'instructionBlocks.o1.audience.gone',
    ]);
    expect(team.members.map((m) => m.id)).toEqual(['lead', 'reviewer']);
    expect(team.instructionBlocks[1]!.audience).toEqual(['lead']);
  });

  it('namespaces overlay block ids', () => {
    const { team } = apply({
      instructionBlocks: [
        {
          id: 'b1',
          title: 'Same id',
          text: 'Project text',
          audience: 'everyone',
        },
      ],
    });

    expect(team.instructionBlocks.map((b) => b.id)).toEqual([
      'b1',
      'project:p1:b1',
    ]);
  });

  it('leaves the shared team untouched', () => {
    apply({ members: { lead: { settings: { effort: 'max' } } } });

    expect(TEAM.members[0]!.effort).toBe('high');
  });
});

describe('overlayCounts', () => {
  it('counts overridden fields, pools, blocks and notes', () => {
    expect(
      overlayCounts({
        allMembers: { claude: { effort: 'low' } },
        members: {
          lead: {
            settings: { model: 'opus', effort: 'max' },
            pool: [],
            mcpDisabled: [],
            extraInstructions: 'x',
          },
        },
        instructionBlocks: [
          { id: 'o', title: '', text: '', audience: 'everyone' },
        ],
      }),
    ).toEqual({ overrides: 5, blocks: 1, notes: 1 });
  });
});

describe('team overlay YAML', () => {
  it('round-trips an overlay and drops empty sections', () => {
    const text = serializeTeamOverlayYaml({
      allMembers: { codex: {} },
      members: {
        lead: { settings: { effort: 'max' }, extraInstructions: '  ' },
        reviewer: { mcpDisabled: [] },
      },
    });

    expect(parseTeamOverlayYaml(text)).toEqual({
      members: {
        lead: { settings: { effort: 'max' } },
        reviewer: { mcpDisabled: [] },
      },
    });
  });

  it('reads a file written with stage addenda, dropping them', () => {
    expect(
      parseTeamOverlayYaml(
        'members:\n  lead:\n    extraInstructions: Hi\nstages:\n  build:\n    howToWorkAddendum: Run the suite.\n',
      ),
    ).toEqual({ members: { lead: { extraInstructions: 'Hi' } } });
  });

  it('reads an empty file as an empty overlay and refuses a malformed one', () => {
    expect(parseTeamOverlayYaml('')).toEqual({});
    expect(() => parseTeamOverlayYaml('members: [1')).toThrow(
      /YAML parse error/,
    );
    expect(() =>
      parseTeamOverlayYaml('allMembers:\n  gemini: { model: x }\n'),
    ).toThrow();
  });
});
