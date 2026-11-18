import { describe, expect, it, vi } from 'vitest';

import {
  type CommandCenterOps,
  HOST_NOTE_THREAD_TOOL,
  type NoteThreadAnswer,
  THREAD_NOTE_MAX_CHARS,
} from '../../../agents/chat.types';
import { AnalysisBroker } from '../../../agents/services/analysis.broker';
import { CommandCenterBroker } from '../../../agents/services/command-center.broker';
import { CommandCenterOpsBroker } from '../../../agents/services/command-center-ops.broker';
import { ProjectChatBroker } from '../../../agents/services/project-chat.broker';
import { TeamBuilderBroker } from '../../../agents/services/team-builder.broker';
import type { ThreadDeliveryService } from '../../../teams/services/thread-delivery.service';
import type { McpCallContext, McpListContext } from '../../mcp.types';
import { ListThreadsTool } from '../list-threads/list-threads.tool';
import { MessageThreadTool } from '../message-thread/message-thread.tool';
import { noteThreadResultText, readNoteThreadArgs } from './note-thread.reader';
import { NoteThreadTool } from './note-thread.tool';

const LISTING: McpListContext = {
  runId: 'manager-1',
  memberId: 'agent',
  conversationId: null,
};

const CONTEXT = {
  ...LISTING,
  caller: 'agent',
  requestId: 1,
} as McpCallContext;

const NOTED: NoteThreadAnswer = {
  status: 'noted',
  handle: 't1',
  title: 'Billing cache',
};

const UNRESOLVED: NoteThreadAnswer = {
  status: 'unresolved',
  code: 'AMBIGUOUS_TARGET',
  candidates: [
    { handle: 't1', title: 'Billing cache' },
    { handle: 't2', title: 'Billing invoices' },
  ],
};

function ops(
  overrides: Partial<CommandCenterOps> = {},
): CommandCenterOpsBroker {
  const broker = new CommandCenterOpsBroker();
  broker.install({
    tell: () => Promise.reject(new Error('unused')),
    note: () => Promise.resolve(NOTED),
    start: () => Promise.reject(new Error('unused')),
    ...overrides,
  });
  return broker;
}

function tool(
  managers: CommandCenterBroker,
  commandOps: CommandCenterOpsBroker,
): NoteThreadTool {
  return new NoteThreadTool(managers, commandOps);
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0]!.text;
}

function listedNamesFor(
  managers: CommandCenterBroker,
  commandOps: CommandCenterOpsBroker,
): string[] {
  const gates = {
    analysis: new AnalysisBroker(),
    teamBuilders: new TeamBuilderBroker(),
    projectChats: new ProjectChatBroker(),
    commandCenters: managers,
  };
  const threads = {} as ThreadDeliveryService;
  return [
    new NoteThreadTool(managers, commandOps),
    new ListThreadsTool(threads, gates),
    new MessageThreadTool(threads, gates),
  ]
    .flatMap((listed) => listed.list(LISTING))
    .map((listed) => listed.name);
}

describe('readNoteThreadArgs', () => {
  it('reads the thread and the note', () => {
    expect(
      readNoteThreadArgs({ thread: 't1', note: 'waits on billing' }),
    ).toEqual({
      ok: true,
      query: { thread: 't1', note: 'waits on billing' },
    });
  });

  it('reads a null or missing note as clearing it', () => {
    expect(readNoteThreadArgs({ thread: 't1', note: null })).toEqual({
      ok: true,
      query: { thread: 't1' },
    });
    expect(readNoteThreadArgs({ thread: 't1' })).toEqual({
      ok: true,
      query: { thread: 't1' },
    });
  });

  it('refuses no thread, a note over the limit and an unknown key', () => {
    expect(readNoteThreadArgs({ thread: '', note: 'x' }).ok).toBe(false);
    expect(
      readNoteThreadArgs({
        thread: 't1',
        note: 'x'.repeat(THREAD_NOTE_MAX_CHARS + 1),
      }).ok,
    ).toBe(false);
    expect(
      readNoteThreadArgs({ thread: 't1', note: 'x', wakes: true }).ok,
    ).toBe(false);
  });
});

describe('noteThreadResultText', () => {
  it('names the thread the note went on', () => {
    expect(noteThreadResultText(NOTED)).toBe('Noted on t1 (Billing cache).');
  });

  it('says nothing was noted, and asks for one of the candidates, when the thread is unresolved', () => {
    expect(noteThreadResultText(UNRESOLVED)).toBe(
      `${JSON.stringify(UNRESOLVED)}\nNothing was noted: name the thread by one of the candidates.`,
    );
  });
});

describe('NoteThreadTool', () => {
  it('is listed only to a turn the command center has a sink for', () => {
    const managers = new CommandCenterBroker();

    expect(tool(managers, ops()).list(LISTING)).toEqual([]);

    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    expect(
      tool(managers, ops())
        .list(LISTING)
        .map((listed) => listed.name),
    ).toEqual([HOST_NOTE_THREAD_TOOL]);
  });

  it('lists note_thread on a manager turn, and neither list_threads nor message_thread', () => {
    const managers = new CommandCenterBroker();
    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    const names = listedNamesFor(managers, ops());

    expect(names).toContain(HOST_NOTE_THREAD_TOOL);
    expect(names).not.toContain('list_threads');
    expect(names).not.toContain('message_thread');
  });

  it('lists list_threads and message_thread, and not note_thread, on an ordinary chat turn', () => {
    const names = listedNamesFor(new CommandCenterBroker(), ops());

    expect(names).toContain('list_threads');
    expect(names).toContain('message_thread');
    expect(names).not.toContain(HOST_NOTE_THREAD_TOOL);
  });

  it('hands the manager run and the arguments to the operations, and answers what they noted', async () => {
    const note = vi.fn(() => Promise.resolve(NOTED));
    const managers = new CommandCenterBroker();
    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    const result = await tool(managers, ops({ note })).call(
      HOST_NOTE_THREAD_TOOL,
      { thread: 't1', note: 'waits on billing' },
      CONTEXT,
    );

    expect(note).toHaveBeenCalledWith('manager-1', {
      thread: 't1',
      note: 'waits on billing',
    });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe(noteThreadResultText(NOTED));
  });

  it('answers a refusal of the operations as an error, with the reason', async () => {
    const result = await tool(
      new CommandCenterBroker(),
      ops({
        note: () =>
          Promise.reject(
            new Error('only the command center manager may call this tool'),
          ),
      }),
    ).call(
      HOST_NOTE_THREAD_TOOL,
      { thread: 't1', note: 'x' },
      { ...CONTEXT, runId: 'run-2' },
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'The command center could not answer: only the command center manager may call this tool',
    );
  });

  it('answers in-protocol when no command center is installed to answer it', async () => {
    const result = await tool(
      new CommandCenterBroker(),
      new CommandCenterOpsBroker(),
    ).call(HOST_NOTE_THREAD_TOOL, { thread: 't1', note: 'x' }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The command center is not available.');
  });

  it('refuses malformed arguments in-protocol, without reaching the operations', async () => {
    const note = vi.fn(() => Promise.resolve(NOTED));

    const result = await tool(new CommandCenterBroker(), ops({ note })).call(
      HOST_NOTE_THREAD_TOOL,
      { thread: '', note: 'x' },
      CONTEXT,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^INVALID_ARGS: /);
    expect(note).not.toHaveBeenCalled();
  });
});
