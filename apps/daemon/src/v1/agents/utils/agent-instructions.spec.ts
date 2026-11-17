import { describe, expect, it } from 'vitest';

import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
import type { AgentTurnInput } from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CLAUDE_WITHHELD_TOOLS } from '../adapters/claude/claude.const';
import { CodexAdapter } from '../adapters/codex/codex.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import {
  HOST_ARTIFACT_ANSWERS_TOOL,
  HOST_ARTIFACT_TOOL,
  HOST_BROWSER_CLICK_TOOL,
  HOST_BROWSER_OPEN_TOOL,
  HOST_BROWSER_SCREENSHOT_TOOL,
  HOST_BROWSER_SET_COOKIES_TOOL,
  HOST_BROWSER_SNAPSHOT_TOOL,
  HOST_BROWSER_TYPE_TOOL,
  HOST_CHART_TOOL,
  HOST_COMPARISON_TOOL,
  HOST_FINDINGS_TOOL,
  HOST_GALLERY_TOOL,
  HOST_GOALS_TOOL,
  HOST_KNOWLEDGE_TOOLS,
  HOST_LIST_THREADS_TOOL,
  HOST_MEMORY_FEEDBACK_TOOL,
  HOST_MEMORY_FORGET_TOOL,
  HOST_MEMORY_READ_TOOL,
  HOST_MEMORY_SAVE_TOOL,
  HOST_MEMORY_SEARCH_TOOL,
  HOST_MESSAGE_THREAD_TOOL,
  HOST_METRICS_TOOL,
  HOST_MONITOR_TOOL,
  HOST_NOTIFY_TOOL,
  HOST_PATCH_TOOL,
  HOST_PLAN_TOOL,
  HOST_PROJECT_INSTRUCTIONS_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
  HOST_PUBLISH_ACTION_TOOL,
  HOST_READ_CHAT_CONTEXT_TOOL,
  HOST_READ_TEAMS_TOOL,
  HOST_RECORD_OUTCOME_TOOL,
  HOST_SEARCH_CHATS_TOOL,
  type HostBoardTool,
} from '../chat.types';
import {
  GENIRO_UI_PREAMBLE,
  joinTurnInstructionParts,
  replyLanguageInstruction,
  type TurnInstructionParts,
  turnInstructionParts,
} from './agent-instructions';

/** The block an adapter hands its CLI — the one seam every delivery path calls. */
function composedBy(
  adapter: AgentAdapter,
  input: AgentTurnInput,
  granted = true,
): string {
  return (
    adapter as unknown as {
      composeSystemPrompt(input: AgentTurnInput, granted: boolean): string;
    }
  ).composeSystemPrompt(input, granted);
}

const TURN: AgentTurnInput = { prompt: 'go', cwd: '/proj' };

/** The block the parts compose to — what every adapter joins. */
function composed(parts: TurnInstructionParts): string {
  return joinTurnInstructionParts(turnInstructionParts(parts));
}

/** The one preamble line that starts with `prefix`. */
function lineStartingWith(prefix: string): string {
  const line = GENIRO_UI_PREAMBLE.split('\n').find((candidate) =>
    candidate.startsWith(prefix),
  );
  if (line === undefined) {
    throw new Error(`no preamble line starts with ${prefix}`);
  }
  return line;
}

/** The preamble from its tools heading on. */
function toolsSection(): string {
  const start = GENIRO_UI_PREAMBLE.indexOf("## Geniro's own tools");
  if (start < 0) {
    throw new Error('the preamble has no tools section');
  }
  return GENIRO_UI_PREAMBLE.slice(start);
}

const BOARD_TOOLS_NAMED: readonly HostBoardTool[] = [
  'list_tasks',
  'get_task',
  'create_task',
  'update_task',
  'list_projects',
];

describe('GENIRO_UI_PREAMBLE', () => {
  it('contradicts the terminal claim rather than only stating the truth', () => {
    // The CLI's own system prompt says the output goes to a terminal, and
    // `--append-system-prompt` cannot delete that line. Dropping the rebuttal
    // and keeping only "you are in a desktop app" is the regression this pins:
    // the preamble would then read as a second opinion, not a correction.
    expect(GENIRO_UI_PREAMBLE).toContain('terminal');
    expect(GENIRO_UI_PREAMBLE.toLowerCase()).toContain('disregard');
  });

  it('sends what a question needs INTO the question, since pre-tool prose may arrive summarized', () => {
    // The fields a tool input carries verbatim are the ones the question card
    // draws — naming any other channel would send the plan somewhere the
    // summary still eats it.
    expect(GENIRO_UI_PREAMBLE).toContain('one-line summary');
    expect(GENIRO_UI_PREAMBLE).toContain("each option's description");
    expect(GENIRO_UI_PREAMBLE).toContain("an option's preview");
    expect(GENIRO_UI_PREAMBLE).toContain('with no tool call after it');
  });

  it('tells the agent how to embed an image', () => {
    expect(GENIRO_UI_PREAMBLE).toContain('![alt](/full/path/to/file.png)');
  });

  it('asks for the FULL path, and says what a relative one is measured against', () => {
    // REPORTED against a real transcript: an agent embedded
    // `out/ci723-assignee-rail.png` and the row drew `could not read` it. The
    // route resolves a relative path against the RUN's cwd, which is not where
    // a delegate, a team member, or a command run in a subdirectory writes
    // its files — so the only form that is always right is the absolute one.
    // The example alone does not carry this: an agent copies the shape of the
    // example but follows the sentence, so the reason has to be stated.
    expect(GENIRO_UI_PREAMBLE).toContain('FULL path');
    expect(GENIRO_UI_PREAMBLE).toContain('working directory');
  });

  it('does not send an agent with numbers off to draw its own chart', () => {
    // The preamble LEADS the instruction stack, so its wording is the default
    // habit. As first written the image bullet said "a chart or diagram you
    // rendered to a file", which is the job `show_chart` does properly — the
    // tool draws a live card, an embedded PNG is a picture of one — and the
    // agent read the preamble first. The bullet must stay about a picture the
    // agent ALREADY has, and the numbers go to the tool.
    const imageBullet = lineStartingWith('- Images');
    expect(imageBullet).not.toContain('chart');
    // Conditional, and that is not a hedge: this text is not gated on the MCP
    // endpoint having been delivered, and on ACP it is said once per session
    // and never repeated, so it has to stay true on a turn where no such tool
    // is registered.
    expect(imageBullet).toContain('where a tool is offered');
    expect(lineStartingWith(`- \`${HOST_CHART_TOOL}\``)).toContain(
      'several readings of one thing',
    );
  });

  it('does not promise remote image URLs, which the renderer CSP refuses', () => {
    // `img-src 'self' data:` means an http(s) source renders as a broken box.
    // Promising it is the one instruction here that would visibly damage a
    // transcript, so the preamble must name it as unsupported — and must never
    // drift into presenting it as a working option.
    const [renders, doesNotRender] =
      GENIRO_UI_PREAMBLE.split('Does not render:');
    expect(doesNotRender).toBeDefined();
    expect(renders).not.toContain('http');
    expect(doesNotRender).toContain('http');
  });
});

describe("GENIRO_UI_PREAMBLE — geniro's own tools", () => {
  it('names every tool it points to by its wire name', () => {
    // claude lists MCP tools by name only, so this section is the one place
    // in its context that says when each is the move; a name that drifted
    // from the tool's would point at nothing.
    const section = toolsSection();
    for (const name of [
      HOST_MONITOR_TOOL,
      HOST_PUBLISH_ACTION_TOOL,
      HOST_NOTIFY_TOOL,
      HOST_CHART_TOOL,
      HOST_METRICS_TOOL,
      HOST_COMPARISON_TOOL,
      HOST_GALLERY_TOOL,
      HOST_ARTIFACT_TOOL,
      HOST_ARTIFACT_ANSWERS_TOOL,
      HOST_BROWSER_OPEN_TOOL,
      HOST_BROWSER_SNAPSHOT_TOOL,
      HOST_BROWSER_CLICK_TOOL,
      HOST_BROWSER_TYPE_TOOL,
      HOST_BROWSER_SCREENSHOT_TOOL,
      HOST_BROWSER_SET_COOKIES_TOOL,
      HOST_FINDINGS_TOOL,
      HOST_PLAN_TOOL,
      HOST_PATCH_TOOL,
      HOST_GOALS_TOOL,
      HOST_RECORD_OUTCOME_TOOL,
      HOST_MEMORY_SEARCH_TOOL,
      HOST_MEMORY_READ_TOOL,
      HOST_MEMORY_SAVE_TOOL,
      HOST_MEMORY_FORGET_TOOL,
      HOST_MEMORY_FEEDBACK_TOOL,
      ...HOST_KNOWLEDGE_TOOLS,
      HOST_SEARCH_CHATS_TOOL,
      HOST_READ_CHAT_CONTEXT_TOOL,
      HOST_LIST_THREADS_TOOL,
      HOST_MESSAGE_THREAD_TOOL,
      ...BOARD_TOOLS_NAMED,
      HOST_READ_TEAMS_TOOL,
      HOST_PROPOSE_TEAM_TOOL,
      HOST_PROJECT_INSTRUCTIONS_TOOL,
    ]) {
      expect(section).toContain(`\`${name}\``);
    }
  });

  it('sends a wait on slow output to monitor rather than a sleep loop', () => {
    const line = lineStartingWith(`- \`${HOST_MONITOR_TOOL}\``);

    expect(line).toContain('CI run');
    expect(line).toContain('end your turn');
    expect(line).toContain('never poll it with sleep loops');
  });

  it('names the tool that replaces each of claude’s own tools geniro withholds', () => {
    // claude 2.1.295's Bash description and its `sleep` refusal tell the model
    // to use `Monitor`, which `--disallowedTools` removes on every geniro turn.
    expect(CLAUDE_WITHHELD_TOOLS).toContain('Monitor');
    expect(lineStartingWith(`- \`${HOST_MONITOR_TOOL}\``)).toContain(
      '`Monitor`',
    );
    for (const name of CLAUDE_WITHHELD_TOOLS) {
      expect(toolsSection()).toContain(`\`${name}\``);
    }
  });

  it('offers a button that stops a server the agent leaves running', () => {
    const line = lineStartingWith(`- \`${HOST_PUBLISH_ACTION_TOOL}\``);

    expect(line).toContain('pull request being merged');
    expect(line).toContain('whenever you leave a server or watcher running');
  });

  it('names ListAgents, in backticks, on the line that offers the thread tools in its place', () => {
    expect(lineStartingWith(`- \`${HOST_LIST_THREADS_TOOL}\``)).toContain(
      '`ListAgents`',
    );
  });

  it('stays true on a turn that registers none of the tools', () => {
    // Not gated on the MCP endpoint, and a team member is offered only some
    // of these tools.
    expect(toolsSection()).toContain(
      'A tool missing from your list is not offered on this turn.',
    );
  });

  it('names no CLI, since every CLI is handed the same text', () => {
    expect(GENIRO_UI_PREAMBLE).not.toMatch(/claude|cursor|codex/i);
  });
});

describe('the composed block', () => {
  it('always leads with the preamble, even when the turn contributes nothing', () => {
    expect(composed({})).toBe(GENIRO_UI_PREAMBLE);
  });

  it('orders the parts general → specific, call surface last', () => {
    const block = composed({
      customInstructions: 'GLOBAL',
      systemPrompt: 'MEMBER_INSTRUCTIONS',
      callSurfacePrompt: 'MAY_CALL',
    });

    expect(block).toBe(
      `${GENIRO_UI_PREAMBLE}\n\nGLOBAL\n\nMEMBER_INSTRUCTIONS\n\nMAY_CALL`,
    );
  });

  it('puts a member’s character after its instructions and before the call notes', () => {
    const block = composed({
      systemPrompt: 'INSTRUCTIONS',
      characterPrompt: 'CHARACTER',
      answeringACallPrompt: 'ANSWERING',
      callSurfacePrompt: 'MAY_CALL',
    });

    expect(block).toBe(
      `${GENIRO_UI_PREAMBLE}\n\nINSTRUCTIONS\n\nCHARACTER\n\nANSWERING\n\nMAY_CALL`,
    );
  });

  it('keeps a member’s instructions ranked above the global instructions', () => {
    // Specific beats general: a member's instructions, written for one job, outrank a
    // preference the user set once for every agent. Position IS the precedence
    // mechanism here, so swapping these two is a real behaviour change.
    const block = composed({
      customInstructions: 'GLOBAL',
      systemPrompt: 'MEMBER_INSTRUCTIONS',
    });

    expect(block.indexOf('GLOBAL')).toBeLessThan(
      block.indexOf('MEMBER_INSTRUCTIONS'),
    );
  });

  it('drops a blank part instead of joining it as an empty paragraph', () => {
    // A cleared settings textarea arrives as '' at least as often as it
    // arrives absent, and a whitespace-only value is the same intent.
    expect(composed({ customInstructions: '', systemPrompt: 'ROLE' })).toBe(
      `${GENIRO_UI_PREAMBLE}\n\nROLE`,
    );
    expect(
      composed({
        customInstructions: '   \n  ',
        systemPrompt: 'ROLE',
      }),
    ).toBe(`${GENIRO_UI_PREAMBLE}\n\nROLE`);
  });

  it('drops a null part the same way it drops an absent one', () => {
    expect(
      composed({
        customInstructions: null,
        systemPrompt: null,
        callSurfacePrompt: null,
      }),
    ).toBe(GENIRO_UI_PREAMBLE);
  });

  it('trims a part rather than carrying the user’s trailing newlines into argv', () => {
    expect(composed({ customInstructions: '  BE TERSE\n\n' })).toBe(
      `${GENIRO_UI_PREAMBLE}\n\nBE TERSE`,
    );
  });

  it('masks a secret registered after the run snapshotted its memory index', () => {
    const secret = 'sk-index-0123456789abcdef';
    registerSecret(secret, 'late');
    try {
      const [part] = turnInstructionParts({
        includePreamble: false,
        memoryIndex: `- m1 [user] Key ${secret} rotates (global)`,
      });

      expect(part?.text).toContain('Key ');
      expect(part?.text).not.toContain(secret);
    } finally {
      clearSecrets();
    }
  });

  it('joins projectInstructions right after customInstructions', () => {
    const parts = turnInstructionParts({
      customInstructions: 'GLOBAL',
      projectInstructions: '  PROJECT\n',
      memoryIndex: 'MEMORY',
      taskInstructions: 'CARD',
    });

    expect(parts.map((part) => part.source)).toEqual([
      'preamble',
      'customInstructions',
      'projectInstructions',
      'memoryIndex',
      'taskInstructions',
    ]);
    expect(parts.find((part) => part.source === 'projectInstructions')).toEqual(
      { source: 'projectInstructions', text: 'PROJECT' },
    );
    expect(
      composed({
        customInstructions: 'GLOBAL',
        projectInstructions: 'PROJECT',
      }),
    ).toBe(`${GENIRO_UI_PREAMBLE}\n\nGLOBAL\n\nPROJECT`);
  });

  it('drops a blank projectInstructions rather than joining an empty paragraph', () => {
    const sources = turnInstructionParts({
      customInstructions: 'GLOBAL',
      projectInstructions: '  \n',
    }).map((part) => part.source);

    expect(sources).not.toContain('projectInstructions');
    expect(
      turnInstructionParts({ projectInstructions: null }).map(
        (part) => part.source,
      ),
    ).not.toContain('projectInstructions');
  });

  it('puts the memory index right after the user’s own instructions, ahead of a card’s', () => {
    const parts = turnInstructionParts({
      customInstructions: 'GLOBAL',
      memoryIndex: 'MEMORY',
      taskInstructions: 'CARD',
    });

    expect(parts.map((part) => part.source)).toEqual([
      'preamble',
      'customInstructions',
      'memoryIndex',
      'taskInstructions',
    ]);
  });

  it('puts the knowledge index right after the memory index, masked on every turn', () => {
    const secret = 'sk-knowledge-index-secret';
    registerSecret(secret, 'late');
    const parts = turnInstructionParts({
      memoryIndex: 'MEMORY',
      knowledgeIndex: `- key — Key ${secret}. When: now. (global, 0.1 KB)`,
      taskInstructions: 'CARD',
    });

    expect(parts.map((part) => part.source)).toEqual([
      'preamble',
      'memoryIndex',
      'knowledgeIndex',
      'taskInstructions',
    ]);
    expect(
      parts.find((part) => part.source === 'knowledgeIndex')?.text,
    ).not.toContain(secret);
  });
});

describe('the composed block — background work note', () => {
  it('puts the CLI’s note right after the preamble, ahead of the user’s own instructions', () => {
    expect(
      composed({
        backgroundWorkNote: 'NOTE',
        customInstructions: 'GLOBAL',
        systemPrompt: 'ROLE',
      }),
    ).toBe(`${GENIRO_UI_PREAMBLE}\n\nNOTE\n\nGLOBAL\n\nROLE`);
  });

  it('withholds the note with the preamble, for a probe that has no turn to end', () => {
    expect(
      composed({
        includePreamble: false,
        backgroundWorkNote: 'NOTE',
        systemPrompt: 'ROLE',
      }),
    ).toBe('ROLE');
  });
});

describe('the composed block — reply language', () => {
  const RUSSIAN = replyLanguageInstruction('Russian')!;

  it('names the language and says the English around it does not decide', () => {
    expect(RUSSIAN).toContain('Reply to the user in Russian');
    expect(RUSSIAN).toContain('whatever language these instructions');
    expect(RUSSIAN).toContain('comments in code');
  });

  it('counts the text handed to a tool the user reads as a reply', () => {
    expect(RUSSIAN).toContain('every word the user reads');
    expect(RUSSIAN).toContain('a question and its options');
    expect(RUSSIAN).toContain(
      'even when what you pass on was written in another language',
    );
    expect(RUSSIAN).toContain('stays in the language the project already uses');
  });

  it('sits after the background note and ahead of the user’s own instructions', () => {
    expect(
      composed({
        backgroundWorkNote: 'NOTE',
        replyLanguage: 'Russian',
        customInstructions: 'GLOBAL',
        systemPrompt: 'ROLE',
      }),
    ).toBe(`${GENIRO_UI_PREAMBLE}\n\nNOTE\n\n${RUSSIAN}\n\nGLOBAL\n\nROLE`);
  });

  it('trims the name and composes nothing for a blank or absent one', () => {
    expect(replyLanguageInstruction('  Russian \n')).toBe(RUSSIAN);
    expect(replyLanguageInstruction('   ')).toBeNull();
    expect(replyLanguageInstruction(null)).toBeNull();
    expect(composed({ replyLanguage: '  ' })).toBe(GENIRO_UI_PREAMBLE);
  });

  it('withholds the line with the preamble, for a probe whose output is parsed', () => {
    expect(
      composed({
        includePreamble: false,
        replyLanguage: 'Russian',
        systemPrompt: 'ROLE',
      }),
    ).toBe('ROLE');
  });

  it.each([
    ['claude', new ClaudeAdapter()],
    [
      'cursor-agent',
      new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore() }),
    ],
    ['codex', new CodexAdapter({ clientVersion: '1.0.0' })],
  ])(
    '%s: carries the run’s language into its composed block',
    (_agent, adapter) => {
      expect(
        composedBy(adapter, { ...TURN, replyLanguage: 'Russian' }),
      ).toContain(RUSSIAN);
      expect(composedBy(adapter, TURN)).not.toContain('Reply to the user in');
    },
  );
});

describe('each CLI’s background work note', () => {
  const claude = new ClaudeAdapter();
  const cursor = new CursorAcpAdapter({
    vocabularyStore: freshVocabularyStore(),
  });
  const codex = new CodexAdapter({ clientVersion: '1.0.0' });

  it.each([
    ['claude', claude],
    ['cursor-agent', cursor],
    ['codex', codex],
  ])(
    '%s: composes its own note after the preamble, and none into a probe',
    (_agent, adapter) => {
      const note = adapter.getConfig().backgroundWork.agentNote!;

      expect(composedBy(adapter, TURN)).toBe(
        `${GENIRO_UI_PREAMBLE}\n\n${note}`,
      );
      expect(composedBy(adapter, { ...TURN, internalProbe: true })).toBe('');
    },
  );

  it('tells claude and cursor their turn is held and they are woken, so they end it instead of polling', () => {
    // geniro HOLDS these two: spawn-cli keeps a claude turn (and the call it
    // answers) open while a delegate is out, and the ACP session holds a
    // cursor turn and wakes it with the delegates' reports.
    const claudeNote = claude.getConfig().backgroundWork.agentNote!;
    const cursorNote = cursor.getConfig().backgroundWork.agentNote!;
    for (const note of [claudeNote, cursorNote]) {
      expect(note).toContain('the call you are answering, if any — stays open');
      expect(note).toContain('END YOUR TURN instead of waiting');
      expect(note).toContain(
        'never poll with sleep, date, ls or until/tail loops',
      );
      expect(note).toContain('never predict what they will report');
    }
    expect(claudeNote).toContain('started again automatically');
    expect(claudeNote).toContain('Background COMMANDS are different');
    expect(cursorNote).toContain('prompted with their reports');
  });

  it('tells cursor a command it leaves running starts it again when it ends, and to wait in-turn with AwaitShell', () => {
    const note = cursor.getConfig().backgroundWork.agentNote!;

    expect(note).toContain(
      'you are started again with a message naming it, its exit code and where its output is',
    );
    expect(note).toContain('end your turn rather than poll it');
    expect(note).toContain('wait for it with AwaitShell');
    expect(note).not.toMatch(/\d/);
  });

  it('tells codex the opposite — its turn is not held, so it waits with wait_agent', () => {
    // Nothing holds a codex turn (`onTurnCompleted` settles at once), so the
    // claude advice to end the turn would hand back an answer without results.
    const note = codex.getConfig().backgroundWork.agentNote!;

    expect(note).toContain('NOT waited for when you end your turn');
    expect(note).toContain('wait_agent');
    expect(note).toContain('if it times out, wait again');
    expect(note).toContain('a long timeout (minutes)');
    expect(note).not.toContain('END YOUR TURN');
  });
});

describe('the composed block — answering a call', () => {
  it('sits after the role and before the call surface, whose calls-specific rule reads on from it', () => {
    expect(
      composed({
        includePreamble: false,
        systemPrompt: 'ROLE',
        answeringACallPrompt: 'ANSWERING',
        callSurfacePrompt: 'MAY_CALL',
      }),
    ).toBe('ROLE\n\nANSWERING\n\nMAY_CALL');
  });

  it('reaches the CLI even when the call tools were not delivered', () => {
    // A leaf callee is handed no call tools and so no "May call" block; the
    // sentence must not be dropped with them.
    const input = {
      ...TURN,
      answeringACallPrompt: 'ANSWERING',
      callSurfacePrompt: 'MAY_CALL',
    };
    const composed = composedBy(new ClaudeAdapter(), input);
    const withheld = composedBy(new ClaudeAdapter(), input, false);

    expect(composed).toContain('ANSWERING\n\nMAY_CALL');
    expect(withheld).toContain('ANSWERING');
    expect(withheld).not.toContain('MAY_CALL');
  });
});

describe('the composed block — task instructions', () => {
  // A card's label block and report ask are stored apart from the user's own
  // text, so the user can purge theirs; the turn must still read them in the
  // order they used to be joined in: user's own first, then the card's.
  it('ranks a card’s instructions right after the user’s own, above the member’s blocks and instructions', () => {
    expect(
      composed({
        includePreamble: false,
        customInstructions: 'GLOBAL',
        taskInstructions: 'CARD',
        instructionBlocks: 'BLOCK',
        systemPrompt: 'ROLE',
        callSurfacePrompt: 'CALLS',
      }),
    ).toBe('GLOBAL\n\nCARD\n\nBLOCK\n\nROLE\n\nCALLS');
  });

  it('carries a card’s instructions when the user has none of their own', () => {
    expect(
      composed({
        includePreamble: false,
        customInstructions: null,
        taskInstructions: 'CARD',
      }),
    ).toBe('CARD');
  });
});

describe('the composed block — instruction blocks', () => {
  // Order IS precedence here, and the block sits between the two fields it is
  // a peer of: below a preference the user set for every agent, above the
  // instructions of the one member it is addressed to.
  it('ranks the blocks below the user instructions and above the member instructions', () => {
    expect(
      composed({
        includePreamble: false,
        customInstructions: 'GLOBAL',
        instructionBlocks: 'BLOCK',
        systemPrompt: 'ROLE',
        callSurfacePrompt: 'CALLS',
      }),
    ).toBe('GLOBAL\n\nBLOCK\n\nROLE\n\nCALLS');
  });

  it('drops a blank block instead of joining an empty paragraph', () => {
    expect(
      composed({
        includePreamble: false,
        customInstructions: 'GLOBAL',
        instructionBlocks: '   ',
        systemPrompt: 'ROLE',
      }),
    ).toBe('GLOBAL\n\nROLE');
  });

  it('is absent for a plain chat turn, which has no team to address one', () => {
    expect(
      composed({
        includePreamble: false,
        customInstructions: 'GLOBAL',
      }),
    ).toBe('GLOBAL');
  });
});

describe('the composed block — team instructions', () => {
  // The brief names the file a builder chat owns, so it must outrank a
  // standing preference and yield to a member's instructions, written for one job — the same
  // placement the card's block beside it takes.
  it('ranks the brief below the user instructions and above the member instructions', () => {
    expect(
      composed({
        includePreamble: false,
        customInstructions: 'GLOBAL',
        teamInstructions: 'TEAM',
        systemPrompt: 'ROLE',
        callSurfacePrompt: 'CALLS',
      }),
    ).toBe('GLOBAL\n\nTEAM\n\nROLE\n\nCALLS');
  });

  it('drops a blank brief instead of joining an empty paragraph', () => {
    expect(
      composed({
        includePreamble: false,
        customInstructions: 'GLOBAL',
        teamInstructions: '   ',
      }),
    ).toBe('GLOBAL');
  });

  it('is absent for a chat opened outside the team builder', () => {
    expect(
      composed({
        includePreamble: false,
        customInstructions: 'GLOBAL',
        taskInstructions: 'CARD',
      }),
    ).toBe('GLOBAL\n\nCARD');
  });
});

describe('turnInstructionParts', () => {
  const EVERY_PART = {
    backgroundWorkNote: 'NOTE',
    replyLanguage: 'Russian',
    customInstructions: '  GLOBAL\n',
    taskInstructions: 'CARD',
    teamInstructions: 'TEAM',
    instructionBlocks: 'BLOCKS',
    systemPrompt: 'ROLE',
    answeringACallPrompt: 'ANSWER',
    callSurfacePrompt: 'CALLS',
  };

  it('names every part by its source, in the order the block joins them', () => {
    expect(turnInstructionParts(EVERY_PART).map((part) => part.source)).toEqual(
      [
        'preamble',
        'backgroundWorkNote',
        'replyLanguage',
        'customInstructions',
        'taskInstructions',
        'teamInstructions',
        'instructionBlocks',
        'instructions',
        'answeringACall',
        'callSurface',
      ],
    );
  });

  it('joins to the composed block, trimmed and blank parts dropped', () => {
    const parts = {
      ...EVERY_PART,
      taskInstructions: '   ',
      systemPrompt: null,
    };

    expect(joinTurnInstructionParts(turnInstructionParts(parts))).toBe(
      [
        GENIRO_UI_PREAMBLE,
        'NOTE',
        replyLanguageInstruction('Russian'),
        'GLOBAL',
        'TEAM',
        'BLOCKS',
        'ANSWER',
        'CALLS',
      ].join('\n\n'),
    );
    expect(
      turnInstructionParts(parts).some(
        (p) => p.source === 'taskInstructions' || p.source === 'instructions',
      ),
    ).toBe(false);
  });

  it.each([
    ['claude', new ClaudeAdapter()],
    [
      'cursor-agent',
      new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore() }),
    ],
    ['codex', new CodexAdapter({ clientVersion: '1.0.0' })],
  ])(
    '%s: its named parts join to the block it hands its CLI, call surface gated on the grant',
    (_agent, adapter) => {
      const input: AgentTurnInput = {
        ...TURN,
        customInstructions: 'GLOBAL',
        instructionBlocks: 'BLOCKS',
        systemPrompt: 'ROLE',
        callSurfacePrompt: 'CALLS',
      };
      for (const granted of [true, false]) {
        const parts = adapter.turnInstructionParts(input, granted);
        expect(joinTurnInstructionParts(parts)).toBe(
          composedBy(adapter, input, granted),
        );
        expect(parts.some((p) => p.source === 'callSurface')).toBe(granted);
      }
      expect(
        adapter
          .turnInstructionParts(TURN, true)
          .find((p) => p.source === 'backgroundWorkNote')?.text,
      ).toBe(adapter.getConfig().backgroundWork.agentNote?.trim());
    },
  );
});
