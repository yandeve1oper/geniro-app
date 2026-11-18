import { randomUUID } from 'node:crypto';

import { BadRequestException } from '@packages/common';
import { describe, expect, it, vi } from 'vitest';

import { AnalysisBroker } from '../../../agents/services/analysis.broker';
import { CommandCenterBroker } from '../../../agents/services/command-center.broker';
import { ProjectChatBroker } from '../../../agents/services/project-chat.broker';
import { TeamBuilderBroker } from '../../../agents/services/team-builder.broker';
import type { ThreadDeliveryService } from '../../../teams/services/thread-delivery.service';
import type { McpCallContext, McpListContext } from '../../mcp.types';
import {
  messageThreadResultText,
  readMessageThreadArgs,
} from './message-thread.reader';
import { MessageThreadTool } from './message-thread.tool';

const THREAD = randomUUID();

const CONTEXT = {
  runId: 'run-1',
  memberId: 'agent',
  conversationId: null,
  caller: 'agent',
  requestId: 1,
} as McpCallContext;

const LISTING: McpListContext = {
  runId: 'run-1',
  memberId: 'agent',
  conversationId: null,
};

const NO_WAIT =
  'Do not wait for a reply: if that thread answers, it reaches you as a message of your own.';

function tool(
  threads: Partial<ThreadDeliveryService>,
  brokers: {
    analysis?: AnalysisBroker;
    teamBuilders?: TeamBuilderBroker;
    projectChats?: ProjectChatBroker;
    commandCenters?: CommandCenterBroker;
  } = {},
) {
  return new MessageThreadTool(threads as ThreadDeliveryService, {
    analysis: brokers.analysis ?? new AnalysisBroker(),
    teamBuilders: brokers.teamBuilders ?? new TeamBuilderBroker(),
    projectChats: brokers.projectChats ?? new ProjectChatBroker(),
    commandCenters: brokers.commandCenters ?? new CommandCenterBroker(),
  });
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0]!.text;
}

describe('readMessageThreadArgs', () => {
  it('reads the thread and the message, and wakes an idle thread when wake is left out', () => {
    expect(
      readMessageThreadArgs({ thread: THREAD, message: 'build is green' }),
    ).toEqual({
      ok: true,
      query: { thread: THREAD, message: 'build is green', wake: true },
    });
  });

  it('reads wake false as false, and a null wake as absent', () => {
    expect(
      readMessageThreadArgs({ thread: THREAD, message: 'x', wake: false }),
    ).toMatchObject({ ok: true, query: { wake: false } });
    expect(
      readMessageThreadArgs({ thread: THREAD, message: 'x', wake: null }),
    ).toMatchObject({ ok: true, query: { wake: true } });
  });

  it('refuses a thread that is not a uuid, a missing message, and an unknown key', () => {
    expect(readMessageThreadArgs({ thread: 'build', message: 'x' }).ok).toBe(
      false,
    );
    expect(readMessageThreadArgs({ thread: THREAD }).ok).toBe(false);
    expect(
      readMessageThreadArgs({ thread: THREAD, message: 'x', wakes: false }).ok,
    ).toBe(false);
  });
});

describe('messageThreadResultText', () => {
  it('answers a joined or a woken send as delivered, with nothing to wait for', () => {
    expect(messageThreadResultText({ outcome: 'joined', title: 'Build' })).toBe(
      `{"outcome":"joined","title":"Build"}\n${NO_WAIT}`,
    );
    expect(messageThreadResultText({ outcome: 'woken', title: 'Build' })).toBe(
      `{"outcome":"woken","title":"Build"}\n${NO_WAIT}`,
    );
  });

  it('says what a waiting send waits for, as its reason words', () => {
    expect(
      messageThreadResultText({
        outcome: 'waiting',
        reason: 'running_turn',
        title: 'Build',
      }),
    ).toBe(
      '{"outcome":"waiting","reason":"running_turn","title":"Build"}\nIt waits for the turn running there to end.',
    );
  });
});

describe('MessageThreadTool', () => {
  it('sends the text to the thread the call names, from the sender run and member, and answers what happened', async () => {
    const send = vi.fn<ThreadDeliveryService['send']>(() =>
      Promise.resolve({ outcome: 'joined', title: 'Build' }),
    );
    const result = await tool({
      senderTarget: () => Promise.resolve('chat'),
      send,
    }).call(
      'message_thread',
      { thread: THREAD, message: 'build is green' },
      CONTEXT,
    );

    expect(send).toHaveBeenCalledWith({
      from: {
        runId: 'run-1',
        memberId: 'agent',
        conversationId: null,
        caller: 'agent',
        target: 'chat',
      },
      toRunId: THREAD,
      text: 'build is green',
      wake: true,
    });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe(
      messageThreadResultText({ outcome: 'joined', title: 'Build' }),
    );
  });

  it('hands wake false to the delivery as the sender asked', async () => {
    const send = vi.fn<ThreadDeliveryService['send']>(() =>
      Promise.resolve({
        outcome: 'waiting',
        reason: 'sender_opted_out',
        title: 'Build',
      }),
    );
    await tool({
      senderTarget: () => Promise.resolve('chat'),
      send,
    }).call(
      'message_thread',
      { thread: THREAD, message: 'for later', wake: false },
      CONTEXT,
    );

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ wake: false }));
  });

  it('refuses from a chat that reaches no other thread, sending nothing', async () => {
    const send = vi.fn<ThreadDeliveryService['send']>();
    const result = await tool({
      senderTarget: () => Promise.resolve(null),
      send,
    }).call('message_thread', { thread: THREAD, message: 'x' }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('This chat does not reach other threads.');
    expect(send).not.toHaveBeenCalled();
  });

  it('answers a refusal of the inbox with its code and message', async () => {
    const result = await tool({
      senderTarget: () => Promise.resolve('chat'),
      send: () =>
        Promise.reject(
          new BadRequestException(
            'MESSAGE_TOO_LONG',
            'the message is 16001 characters',
          ),
        ),
    }).call('message_thread', { thread: THREAD, message: 'x' }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'MESSAGE_TOO_LONG: the message is 16001 characters',
    );
  });

  it('is not offered to an analysis, a team builder or a project chat, and is offered to a chat', () => {
    const analysis = new AnalysisBroker();
    analysis.register('run-1', 'agent', {
      turn: {
        analysisRunId: 'run-1',
        sourceRunId: 'source',
        snapshotSeq: 0,
        sourceWorking: false,
      },
      report: () => Promise.reject(new Error('unused')),
      mark: () => Promise.reject(new Error('unused')),
    });
    const teamBuilders = new TeamBuilderBroker();
    teamBuilders.register('run-1', 'agent', {
      slug: 'team',
      projectId: null,
      turnStartedAt: 0,
      savedHash: null,
      acceptsAnyVersion: false,
    });
    const projectChats = new ProjectChatBroker();
    projectChats.register('run-1', 'agent', { projectId: 'p1' });

    expect(tool({}, { analysis }).list(LISTING)).toEqual([]);
    expect(tool({}, { teamBuilders }).list(LISTING)).toEqual([]);
    expect(tool({}, { projectChats }).list(LISTING)).toEqual([]);
    expect(
      tool({})
        .list(LISTING)
        .map((listed) => listed.name),
    ).toEqual(['message_thread']);
  });
});
