import { describe, expect, it, vi } from 'vitest';

import {
  type CommandCenterOps,
  HOST_START_THREAD_TOOL,
  type StartThreadAnswer,
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
import {
  readStartThreadArgs,
  startThreadResultText,
} from './start-thread.reader';
import { StartThreadTool } from './start-thread.tool';

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

const STARTING: StartThreadAnswer = {
  status: 'starting',
  taskId: 'task-1',
  identifier: 'GEN-7',
};

const CARD_SHOWN: StartThreadAnswer = {
  status: 'card_shown',
  taskId: 'task-2',
  identifier: null,
};

const REFUSED: StartThreadAnswer = {
  status: 'refused',
  code: 'CARD_NOT_SHOWN',
  reason:
    'the card GEN-8 was filed in backlog, but its Start card could not be shown',
};

const ARGS = {
  project: 'Geniro',
  title: 'Billing cache',
  brief: 'Clear the cache',
};

function ops(
  overrides: Partial<CommandCenterOps> = {},
): CommandCenterOpsBroker {
  const broker = new CommandCenterOpsBroker();
  broker.install({
    tell: () => Promise.reject(new Error('unused')),
    note: () => Promise.reject(new Error('unused')),
    start: () => Promise.resolve(STARTING),
    ...overrides,
  });
  return broker;
}

function tool(
  managers: CommandCenterBroker,
  commandOps: CommandCenterOpsBroker,
): StartThreadTool {
  return new StartThreadTool(managers, commandOps);
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
    new StartThreadTool(managers, commandOps),
    new ListThreadsTool(threads, gates),
    new MessageThreadTool(threads, gates),
  ]
    .flatMap((listed) => listed.list(LISTING))
    .map((listed) => listed.name);
}

describe('readStartThreadArgs', () => {
  it('reads the project, the title and the brief, and the optional agent, team and note', () => {
    expect(readStartThreadArgs(ARGS)).toEqual({ ok: true, query: ARGS });
    expect(
      readStartThreadArgs({
        ...ARGS,
        agent: 'codex',
        team: 'review',
        note: 'watch billing',
      }),
    ).toEqual({
      ok: true,
      query: {
        ...ARGS,
        agent: 'codex',
        team: 'review',
        note: 'watch billing',
      },
    });
  });

  it('refuses no project, no title, a title over the limit, no brief, a note over the limit and an unknown key', () => {
    expect(readStartThreadArgs({ ...ARGS, project: '' }).ok).toBe(false);
    expect(readStartThreadArgs({ ...ARGS, title: '' }).ok).toBe(false);
    expect(readStartThreadArgs({ ...ARGS, title: 'x'.repeat(201) }).ok).toBe(
      false,
    );
    expect(
      readStartThreadArgs({ project: 'Geniro', title: 'Billing cache' }).ok,
    ).toBe(false);
    expect(
      readStartThreadArgs({
        ...ARGS,
        note: 'x'.repeat(THREAD_NOTE_MAX_CHARS + 1),
      }).ok,
    ).toBe(false);
    expect(readStartThreadArgs({ ...ARGS, wakes: true }).ok).toBe(false);
  });
});

describe('startThreadResultText', () => {
  it('says the thread is starting now, and that the manager is told when it has started', () => {
    expect(startThreadResultText(STARTING)).toBe(
      `${JSON.stringify(STARTING)}\nCard GEN-7 is starting now. You are told when the thread has started; end your turn rather than wait.`,
    );
  });

  it('says the Start card is on screen, naming the card by its id when it has no identifier', () => {
    expect(startThreadResultText(CARD_SHOWN)).toBe(
      `${JSON.stringify(CARD_SHOWN)}\nCard task-2 is filed and a Start card is on screen for the user. You are told when they answer and when the thread starts; end your turn rather than wait.`,
    );
  });

  it('answers a refusal with its code and reason, and nothing else', () => {
    expect(startThreadResultText(REFUSED)).toBe(
      'CARD_NOT_SHOWN: the card GEN-8 was filed in backlog, but its Start card could not be shown',
    );
  });
});

describe('StartThreadTool', () => {
  it('is listed only to a turn the command center has a sink for', () => {
    const managers = new CommandCenterBroker();

    expect(tool(managers, ops()).list(LISTING)).toEqual([]);

    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    expect(
      tool(managers, ops())
        .list(LISTING)
        .map((listed) => listed.name),
    ).toEqual([HOST_START_THREAD_TOOL]);
  });

  it('lists start_thread on a manager turn, and neither list_threads nor message_thread', () => {
    const managers = new CommandCenterBroker();
    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    const names = listedNamesFor(managers, ops());

    expect(names).toContain(HOST_START_THREAD_TOOL);
    expect(names).not.toContain('list_threads');
    expect(names).not.toContain('message_thread');
  });

  it('lists list_threads and message_thread, and not start_thread, on an ordinary chat turn', () => {
    const names = listedNamesFor(new CommandCenterBroker(), ops());

    expect(names).toContain('list_threads');
    expect(names).toContain('message_thread');
    expect(names).not.toContain(HOST_START_THREAD_TOOL);
  });

  it('hands the manager run and the arguments to the operations, and answers what they started', async () => {
    const start = vi.fn(() => Promise.resolve(STARTING));
    const managers = new CommandCenterBroker();
    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    const result = await tool(managers, ops({ start })).call(
      HOST_START_THREAD_TOOL,
      { ...ARGS, note: 'watch billing' },
      CONTEXT,
    );

    expect(start).toHaveBeenCalledWith('manager-1', {
      ...ARGS,
      note: 'watch billing',
    });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe(startThreadResultText(STARTING));
  });

  it('passes a refused answer of the operations through as its text', async () => {
    const managers = new CommandCenterBroker();
    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    const result = await tool(
      managers,
      ops({ start: () => Promise.resolve(REFUSED) }),
    ).call(HOST_START_THREAD_TOOL, ARGS, CONTEXT);

    expect(textOf(result)).toBe(startThreadResultText(REFUSED));
  });

  it('answers a refusal of the operations as an error, with the reason', async () => {
    const result = await tool(
      new CommandCenterBroker(),
      ops({
        start: () =>
          Promise.reject(
            new Error('only the command center manager may call this tool'),
          ),
      }),
    ).call(HOST_START_THREAD_TOOL, ARGS, { ...CONTEXT, runId: 'run-2' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'The command center could not answer: only the command center manager may call this tool',
    );
  });

  it('answers in-protocol when no command center is installed to answer it', async () => {
    const result = await tool(
      new CommandCenterBroker(),
      new CommandCenterOpsBroker(),
    ).call(HOST_START_THREAD_TOOL, ARGS, CONTEXT);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The command center is not available.');
  });

  it('refuses malformed arguments in-protocol, without reaching the operations', async () => {
    const start = vi.fn(() => Promise.resolve(STARTING));

    const result = await tool(new CommandCenterBroker(), ops({ start })).call(
      HOST_START_THREAD_TOOL,
      { ...ARGS, project: '' },
      CONTEXT,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^INVALID_ARGS: /);
    expect(start).not.toHaveBeenCalled();
  });
});
