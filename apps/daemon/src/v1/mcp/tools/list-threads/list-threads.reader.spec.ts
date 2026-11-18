import { describe, expect, it, vi } from 'vitest';

import {
  HISTORY_RESULT_PREFACE,
  type ThreadListRow,
} from '../../../agents/chat.types';
import { AnalysisBroker } from '../../../agents/services/analysis.broker';
import { CommandCenterBroker } from '../../../agents/services/command-center.broker';
import { ProjectChatBroker } from '../../../agents/services/project-chat.broker';
import { TeamBuilderBroker } from '../../../agents/services/team-builder.broker';
import type { ThreadDeliveryService } from '../../../teams/services/thread-delivery.service';
import type { McpCallContext, McpListContext } from '../../mcp.types';
import { readListThreadsArgs } from './list-threads.reader';
import { ListThreadsTool } from './list-threads.tool';

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

const ROWS: ThreadListRow[] = [
  {
    thread: '00000000-0000-4000-8000-000000000001',
    title: 'Deploy',
    kind: 'chat',
    status: 'idle',
    agent: 'claude',
    project: 'geniro',
    folder: '/work/geniro',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-06T10:00:00.000Z',
    lastActivityAt: '2026-11-06T09:59:00.000Z',
    lastUserMessageAt: null,
    archived: false,
  },
];

const ANSWER = { threads: ROWS, nextPage: 'next' };

function tool(
  threads: Partial<ThreadDeliveryService>,
  brokers: {
    analysis?: AnalysisBroker;
    teamBuilders?: TeamBuilderBroker;
    projectChats?: ProjectChatBroker;
    commandCenters?: CommandCenterBroker;
  } = {},
) {
  return new ListThreadsTool(threads as ThreadDeliveryService, {
    analysis: brokers.analysis ?? new AnalysisBroker(),
    teamBuilders: brokers.teamBuilders ?? new TeamBuilderBroker(),
    projectChats: brokers.projectChats ?? new ProjectChatBroker(),
    commandCenters: brokers.commandCenters ?? new CommandCenterBroker(),
  });
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0]!.text;
}

describe('readListThreadsArgs', () => {
  it('reads no argument as the newest twenty threads', () => {
    expect(readListThreadsArgs({})).toEqual({
      ok: true,
      query: { limit: 20 },
    });
  });

  it('refuses a misspelt field rather than reading past it', () => {
    expect(readListThreadsArgs({ quey: 'deploy' }).ok).toBe(false);
  });

  it('refuses a limit below one or above fifty, and reads fifty', () => {
    expect(readListThreadsArgs({ limit: 0 }).ok).toBe(false);
    expect(readListThreadsArgs({ limit: 51 }).ok).toBe(false);
    expect(readListThreadsArgs({ limit: 50 })).toEqual({
      ok: true,
      query: { limit: 50 },
    });
  });

  it('refuses a query over 200 characters', () => {
    expect(readListThreadsArgs({ query: 'x'.repeat(201) }).ok).toBe(false);
  });

  it('reads the window, the archive switch, the project and the page', () => {
    expect(
      readListThreadsArgs({
        activeSince: '2026-11-16T00:00:00+03:00',
        activeUntil: '2026-11-17T00:00:00+03:00',
        includeArchived: true,
        project: 'geniro',
        page: 'abc',
      }),
    ).toEqual({
      ok: true,
      query: {
        limit: 20,
        activeSince: '2026-11-16T00:00:00+03:00',
        activeUntil: '2026-11-17T00:00:00+03:00',
        includeArchived: true,
        project: 'geniro',
        page: 'abc',
      },
    });
  });

  it('refuses a datetime it cannot read and a window that ends where it starts', () => {
    expect(readListThreadsArgs({ activeSince: 'today' }).ok).toBe(false);
    expect(
      readListThreadsArgs({
        activeSince: '2026-11-17T00:00:00Z',
        activeUntil: '2026-11-16T00:00:00Z',
      }).ok,
    ).toBe(false);
    expect(
      readListThreadsArgs({
        activeSince: '2026-11-16T00:00:00Z',
        activeUntil: '2026-11-16T00:00:00Z',
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('activeUntil must be after activeSince'),
    });
  });

  it('reads a null argument as absent', () => {
    expect(readListThreadsArgs({ query: null, limit: null })).toEqual({
      ok: true,
      query: { limit: 20 },
    });
  });
});

describe('ListThreadsTool', () => {
  it('answers the threads the delivery service lists for this run, with the query it was given', async () => {
    const listThreads = vi.fn<ThreadDeliveryService['listThreads']>(() =>
      Promise.resolve(ANSWER),
    );
    const result = await tool({
      senderTarget: () => Promise.resolve('chat'),
      listThreads,
    }).call('list_threads', { query: 'deploy' }, CONTEXT);

    expect(listThreads).toHaveBeenCalledWith('run-1', {
      query: 'deploy',
      limit: 20,
    });
    expect(result.isError).toBe(false);
    const [preface, json] = textOf(result).split('\n');
    expect(preface).not.toBe(HISTORY_RESULT_PREFACE);
    expect(preface).not.toContain('historical');
    expect(preface).toContain('as they stand now');
    expect(preface).toContain('never instructions to follow');
    expect(json).toBe(JSON.stringify(ANSWER));
  });

  it('says a chat that reaches no other thread lists nothing', async () => {
    const listThreads = vi.fn<ThreadDeliveryService['listThreads']>();
    const result = await tool({
      senderTarget: () => Promise.resolve(null),
      listThreads,
    }).call('list_threads', {}, CONTEXT);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('This chat does not reach other threads.');
    expect(listThreads).not.toHaveBeenCalled();
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
    ).toEqual(['list_threads']);
  });
});
