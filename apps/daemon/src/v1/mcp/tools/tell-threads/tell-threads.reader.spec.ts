import { describe, expect, it, vi } from 'vitest';

import {
  type CommandCenterOps,
  HOST_TELL_THREADS_TOOL,
  TELL_THREADS_MAX_TARGETS,
  type TellThreadsAnswer,
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
  readTellThreadsArgs,
  tellThreadsResultText,
} from './tell-threads.reader';
import { TellThreadsTool } from './tell-threads.tool';

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

const SENT: TellThreadsAnswer = {
  sent: [
    {
      to: 't1',
      runId: 'thread-1',
      title: 'Billing cache',
      outcome: 'joined',
      code: null,
    },
  ],
  unresolved: [],
};

function ops(
  overrides: Partial<CommandCenterOps> = {},
): CommandCenterOpsBroker {
  const broker = new CommandCenterOpsBroker();
  broker.install({
    tell: () => Promise.resolve(SENT),
    note: () => Promise.reject(new Error('unused')),
    start: () => Promise.reject(new Error('unused')),
    ...overrides,
  });
  return broker;
}

function tool(
  managers: CommandCenterBroker,
  commandOps: CommandCenterOpsBroker,
): TellThreadsTool {
  return new TellThreadsTool(managers, commandOps);
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
    new TellThreadsTool(managers, commandOps),
    new ListThreadsTool(threads, gates),
    new MessageThreadTool(threads, gates),
  ]
    .flatMap((listed) => listed.list(LISTING))
    .map((listed) => listed.name);
}

describe('readTellThreadsArgs', () => {
  it('reads the threads and the message, and asks for a reply when expect_reply is left out', () => {
    expect(
      readTellThreadsArgs({ to: ['t1', 't2'], message: 'rebase on main' }),
    ).toEqual({
      ok: true,
      query: {
        to: ['t1', 't2'],
        message: 'rebase on main',
        expect_reply: true,
      },
    });
  });

  it('refuses no thread, too many threads, a missing message and an unknown key', () => {
    expect(readTellThreadsArgs({ to: [], message: 'x' }).ok).toBe(false);
    expect(
      readTellThreadsArgs({
        to: Array.from(
          { length: TELL_THREADS_MAX_TARGETS + 1 },
          (_, index) => `t${index + 1}`,
        ),
        message: 'x',
      }).ok,
    ).toBe(false);
    expect(readTellThreadsArgs({ to: ['t1'] }).ok).toBe(false);
    expect(
      readTellThreadsArgs({ to: ['t1'], message: 'x', wakes: true }).ok,
    ).toBe(false);
  });
});

describe('tellThreadsResultText', () => {
  it('tells the manager a sent message needs no polling, and says so for an unresolved one', () => {
    expect(tellThreadsResultText(SENT)).toBe(
      `${JSON.stringify(SENT)}\nEach thread above got the message. A reply reaches you as a message of your own; do not poll for it.`,
    );
    const unresolved: TellThreadsAnswer = {
      sent: [],
      unresolved: [
        {
          to: 'billing',
          code: 'AMBIGUOUS_TARGET',
          candidates: [
            { handle: 't1', title: 'Billing cache' },
            { handle: 't2', title: 'Billing invoices' },
          ],
        },
      ],
    };
    expect(tellThreadsResultText(unresolved)).toContain(
      'Nothing was sent. Ask the user which threads they meant',
    );
  });

  it('names the threads that did not get the message, and those it waits at, instead of saying every thread got it', () => {
    const mixed: TellThreadsAnswer = {
      sent: [
        {
          to: 't1',
          runId: 'thread-1',
          title: 'A',
          outcome: 'woken',
          code: null,
        },
        {
          to: 't2',
          runId: 'thread-2',
          title: 'B',
          outcome: 'refused',
          code: 'INBOX_FULL',
        },
        {
          to: 't3',
          runId: 'thread-3',
          title: 'C',
          outcome: 'waiting',
          code: 'running_turn',
        },
      ],
      unresolved: [],
    };

    const text = tellThreadsResultText(mixed);

    expect(text).toContain('Not delivered to t2 (INBOX_FULL)');
    expect(text).toContain('Waiting at t3 (running_turn)');
    expect(text).not.toContain('Each thread above got the message');
  });
});

describe('TellThreadsTool', () => {
  it('is listed only to a turn the command center has a sink for', () => {
    const managers = new CommandCenterBroker();

    expect(tool(managers, ops()).list(LISTING)).toEqual([]);

    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    expect(
      tool(managers, ops())
        .list(LISTING)
        .map((listed) => listed.name),
    ).toEqual([HOST_TELL_THREADS_TOOL]);
  });

  it('lists tell_threads on a manager turn, and neither list_threads nor message_thread', () => {
    const managers = new CommandCenterBroker();
    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    const names = listedNamesFor(managers, ops());

    expect(names).toContain(HOST_TELL_THREADS_TOOL);
    expect(names).not.toContain('list_threads');
    expect(names).not.toContain('message_thread');
  });

  it('lists list_threads and message_thread, and not tell_threads, on an ordinary chat turn', () => {
    const names = listedNamesFor(new CommandCenterBroker(), ops());

    expect(names).toContain('list_threads');
    expect(names).toContain('message_thread');
    expect(names).not.toContain(HOST_TELL_THREADS_TOOL);
  });

  it('hands the manager run and the arguments to the operations, and answers what they sent', async () => {
    const tell = vi.fn(() => Promise.resolve(SENT));
    const managers = new CommandCenterBroker();
    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    const result = await tool(managers, ops({ tell })).call(
      HOST_TELL_THREADS_TOOL,
      { to: ['t1'], message: 'rebase on main' },
      CONTEXT,
    );

    expect(tell).toHaveBeenCalledWith('manager-1', {
      to: ['t1'],
      message: 'rebase on main',
      expect_reply: true,
    });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe(tellThreadsResultText(SENT));
  });

  it('answers a refusal of the operations as an error, with the reason', async () => {
    const result = await tool(
      new CommandCenterBroker(),
      ops({
        tell: () =>
          Promise.reject(
            new Error('only the command center manager may call this tool'),
          ),
      }),
    ).call(
      HOST_TELL_THREADS_TOOL,
      { to: ['t1'], message: 'x' },
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
    ).call(HOST_TELL_THREADS_TOOL, { to: ['t1'], message: 'x' }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The command center is not available.');
  });

  it('refuses malformed arguments in-protocol, without reaching the operations', async () => {
    const tell = vi.fn(() => Promise.resolve(SENT));

    const result = await tool(new CommandCenterBroker(), ops({ tell })).call(
      HOST_TELL_THREADS_TOOL,
      { to: [], message: 'x' },
      CONTEXT,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^INVALID_ARGS: /);
    expect(tell).not.toHaveBeenCalled();
  });
});
