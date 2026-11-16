import { describe, expect, it } from 'vitest';

import {
  BROWSER_HOST_CARD,
  GENIRO_BROWSER_TOOLS,
  geniroBrowserToolOf,
  geniroCardKindOf,
  geniroKnowledgeToolOf,
  geniroMemoryToolOf,
  isGeniroCardKind,
  isGeniroToolName,
  isTeamProposalTool,
  standsAcrossTurns,
} from './geniro-tool';

const RUN = 'abc12345-0000-0000-0000-000000000000';
const SERVER = 'geniro-abc12345';

describe('geniro’s own tool calls', () => {
  it('hides message_thread’s call row, and draws no card of its own', () => {
    expect(isGeniroToolName(`mcp__${SERVER}__message_thread`, RUN)).toBe(true);
    expect(geniroCardKindOf(`mcp__${SERVER}__message_thread`, RUN)).toBeNull();
  });

  it('recognises the per-run server name', () => {
    expect(isGeniroToolName(`mcp__${SERVER}__show_artifact`, RUN)).toBe(true);
  });

  it('recognises cursor’s prose label, which carries no mcp__ name at all', () => {
    expect(isGeniroToolName(`Geniro ${SERVER}: show_chart`, RUN)).toBe(true);
  });

  it('hides team_note’s call row but keeps team_notes’ visible, in either spelling', () => {
    // The note is its own row, so team_note's call is hidden; team_notes
    // draws nothing, so its call must stay — and on cursor its label contains
    // `team_note` as a prefix of `team_notes`.
    expect(isGeniroToolName(`mcp__${SERVER}__team_note`, RUN)).toBe(true);
    expect(isGeniroToolName(`${SERVER}-team_note: team_note`, RUN)).toBe(true);
    expect(isGeniroToolName(`mcp__${SERVER}__team_notes`, RUN)).toBe(false);
    expect(isGeniroToolName(`${SERVER}-team_notes: team_notes`, RUN)).toBe(
      false,
    );
  });

  it.each(['monitor', 'stop_monitor', 'list_monitors'])(
    'does not claim the %s tool, so its call renders as an ordinary tool row',
    (tool) => {
      expect(isGeniroToolName(`mcp__${SERVER}__${tool}`, RUN)).toBe(false);
      expect(isGeniroToolName(`Geniro ${SERVER}: ${tool}`, RUN)).toBe(false);
      expect(geniroCardKindOf(`mcp__${SERVER}__${tool}`, RUN)).toBeNull();
    },
  );

  it('refuses a user’s OWN server that happens to be called geniro', () => {
    // Matching the prefix alone hid every call to their server too, so an agent
    // would work through it while the transcript showed nothing.
    expect(isGeniroToolName('mcp__geniro-mine__show_artifact', RUN)).toBe(
      false,
    );
    expect(isGeniroToolName('mcp__geniro__deploy', RUN)).toBe(false);
  });

  it('refuses another RUN’s server, which is what makes the name unforgeable', () => {
    expect(
      isGeniroToolName(`mcp__${SERVER}__show_artifact`, 'ffffffff-0000'),
    ).toBe(false);
  });
});

describe('which of them draw a card', () => {
  it('names the card each drawing tool is about to produce', () => {
    expect(geniroCardKindOf(`mcp__${SERVER}__show_artifact`, RUN)).toBe(
      'artifact',
    );
    expect(geniroCardKindOf(`mcp__${SERVER}__show_chart`, RUN)).toBe('chart');
    expect(geniroCardKindOf(`mcp__${SERVER}__propose_plan`, RUN)).toBe('plan');
    expect(geniroCardKindOf(`mcp__${SERVER}__propose_team`, RUN)).toBe('team');
  });

  it('draws a team card for a call recorded before the rename as propose_workflow', () => {
    expect(geniroCardKindOf(`mcp__${SERVER}__propose_workflow`, RUN)).toBe(
      'team',
    );
    expect(standsAcrossTurns('propose_workflow')).toBe(true);
    expect(isTeamProposalTool('propose_workflow')).toBe(true);
    expect(isTeamProposalTool('propose_plan')).toBe(false);
  });

  it('answers null for one of geniro’s tools that draws NOTHING', () => {
    // A call tool's story is told by the dedicated call rows, so there is no
    // card coming and a placeholder would resolve into nothing at all.
    expect(geniroCardKindOf(`mcp__${SERVER}__call_agent`, RUN)).toBeNull();
    expect(
      geniroCardKindOf(`mcp__${SERVER}__ask_user_question`, RUN),
    ).toBeNull();
  });

  it('answers null for a tool that is not geniro’s', () => {
    expect(geniroCardKindOf('Bash', RUN)).toBeNull();
    expect(geniroCardKindOf('mcp__linear__create_issue', RUN)).toBeNull();
  });

  it('guards a kind read off an untyped payload', () => {
    // The row's renderer reads this off `payload`, which is `unknown` by the
    // same rule every item's is.
    expect(isGeniroCardKind('artifact')).toBe(true);
    expect(isGeniroCardKind('call_agent')).toBe(false);
    expect(isGeniroCardKind(null)).toBe(false);
  });
});

describe('shared-memory tools', () => {
  const MEMORY_TOOLS = [
    'memory_search',
    'memory_read',
    'memory_save',
    'memory_forget',
    'memory_feedback',
  ] as const;

  it.each(MEMORY_TOOLS)('recognises %s in claude’s spelling', (tool) => {
    expect(geniroMemoryToolOf(`mcp__${SERVER}__${tool}`, RUN)).toBe(tool);
  });

  it.each(MEMORY_TOOLS)('recognises %s in cursor’s spelling', (tool) => {
    expect(geniroMemoryToolOf(`${SERVER}-${tool}: ${tool}`, RUN)).toBe(tool);
    expect(geniroMemoryToolOf(`Geniro ${SERVER}: ${tool}`, RUN)).toBe(tool);
  });

  it('refuses another server and another run', () => {
    expect(geniroMemoryToolOf('mcp__geniro-mine__memory_save', RUN)).toBeNull();
    expect(
      geniroMemoryToolOf(`mcp__${SERVER}__memory_save`, 'ffffffff-0000'),
    ).toBeNull();
    expect(geniroMemoryToolOf(`mcp__${SERVER}__memory_saved`, RUN)).toBeNull();
  });

  it.each(MEMORY_TOOLS)(
    'keeps the raw %s call visible, since its row is drawn from that pair',
    (tool) => {
      expect(isGeniroToolName(`mcp__${SERVER}__${tool}`, RUN)).toBe(false);
      expect(geniroCardKindOf(`mcp__${SERVER}__${tool}`, RUN)).toBeNull();
    },
  );
});

describe('shared-knowledge tools', () => {
  const KNOWLEDGE_TOOLS = [
    'knowledge_search',
    'knowledge_read',
    'knowledge_save',
  ] as const;

  it.each(KNOWLEDGE_TOOLS)('recognises %s in claude’s spelling', (tool) => {
    expect(geniroKnowledgeToolOf(`mcp__${SERVER}__${tool}`, RUN)).toBe(tool);
  });

  it.each(KNOWLEDGE_TOOLS)('recognises %s in cursor’s spelling', (tool) => {
    expect(geniroKnowledgeToolOf(`${SERVER}-${tool}: ${tool}`, RUN)).toBe(tool);
    expect(geniroKnowledgeToolOf(`Geniro ${SERVER}: ${tool}`, RUN)).toBe(tool);
  });

  it('refuses another server, another run and a longer name', () => {
    expect(
      geniroKnowledgeToolOf('mcp__geniro-mine__knowledge_save', RUN),
    ).toBeNull();
    expect(
      geniroKnowledgeToolOf(`mcp__${SERVER}__knowledge_save`, 'ffffffff-0000'),
    ).toBeNull();
    expect(
      geniroKnowledgeToolOf(`mcp__${SERVER}__knowledge_saved`, RUN),
    ).toBeNull();
  });

  it.each(KNOWLEDGE_TOOLS)(
    'keeps the raw %s call visible, since its row is drawn from that pair',
    (tool) => {
      expect(isGeniroToolName(`mcp__${SERVER}__${tool}`, RUN)).toBe(false);
      expect(geniroCardKindOf(`mcp__${SERVER}__${tool}`, RUN)).toBeNull();
    },
  );
});

describe('in-app browser tools', () => {
  it.each(GENIRO_BROWSER_TOOLS)(
    'recognises %s in claude’s and cursor’s spellings',
    (tool) => {
      expect(geniroBrowserToolOf(`mcp__${SERVER}__${tool}`, RUN)).toBe(tool);
      expect(geniroBrowserToolOf(`Geniro ${SERVER}: ${tool}`, RUN)).toBe(tool);
    },
  );

  it('refuses another server, another run and a longer name', () => {
    expect(
      geniroBrowserToolOf('mcp__geniro-mine__browser_open', RUN),
    ).toBeNull();
    expect(
      geniroBrowserToolOf(`mcp__${SERVER}__browser_open`, 'ffffffff-0000'),
    ).toBeNull();
    expect(
      geniroBrowserToolOf(`mcp__${SERVER}__browser_opened`, RUN),
    ).toBeNull();
  });

  it.each(GENIRO_BROWSER_TOOLS)(
    'keeps the raw %s call visible, since its row is drawn from that pair',
    (tool) => {
      expect(isGeniroToolName(`mcp__${SERVER}__${tool}`, RUN)).toBe(false);
      expect(geniroCardKindOf(`mcp__${SERVER}__${tool}`, RUN)).toBeNull();
    },
  );

  it('draws the screenshot as a card and hides its raw call', () => {
    expect(isGeniroToolName(`mcp__${SERVER}__browser_screenshot`, RUN)).toBe(
      true,
    );
    expect(geniroCardKindOf(`mcp__${SERVER}__browser_screenshot`, RUN)).toBe(
      'screenshot',
    );
    expect(isGeniroCardKind('screenshot')).toBe(true);
    expect(geniroBrowserToolOf(`mcp__${SERVER}__browser_screenshot`, RUN)).toBe(
      null,
    );
  });

  it('lets the new-host card stand across turns', () => {
    expect(standsAcrossTurns(BROWSER_HOST_CARD)).toBe(true);
  });
});
