import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { ConflictException } from '@packages/common';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { NO_CALL_INDEX } from '../../agents/__tests__/no-call-index';
import { NO_COMMANDS } from '../../agents/__tests__/no-commands';
import { NO_STOPS } from '../../agents/__tests__/no-stops';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { ActionCommandRegistry } from '../../agents/services/action-command.registry';
import { ActionPressService } from '../../agents/services/action-press.service';
import {
  type ActionPublishContext,
  ActionPublishService,
} from '../../agents/services/action-publish.service';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ChatService } from '../../agents/services/chat.service';
import { ChatActionsService } from '../../agents/services/chat-actions.service';
import { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { TeamActionsService } from './team-actions.service';
import type { TeamExecutorService } from './team-executor.service';

/** Real SQLite under the shared press, with the executor's delivery observed. */
describe('TeamActionsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let items: ItemDao;
  let runs: RunDao;
  let actions: ChatActionsService;
  let publisher: ActionPublishService;
  let sendMessage: ReturnType<typeof vi.fn>;
  let chatSend: ReturnType<typeof vi.fn>;
  let service: TeamActionsService;

  /** A callee's button: it says who it is. */
  const engineer: ActionPublishContext = {
    runId: 'run-w',
    rowNodeId: 'engineer',
    publisher: {
      nodeId: 'engineer',
      conversationId: 'call-1',
      callId: 'call-1',
      agentLabel: 'Engineer',
    },
  };
  /** The trigger-fed manager's own button: nothing to say. */
  const manager: ActionPublishContext = {
    runId: 'run-w',
    rowNodeId: 'manager',
    publisher: { nodeId: 'manager', conversationId: '' },
  };

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, Item, NodeState],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    items = new ItemDao(orm.em.fork());
    runs = new RunDao(orm.em.fork());
    actions = new ChatActionsService(
      orm.em,
      items,
      new AgentEventBus(),
      NO_CALL_INDEX,
      new ItemSeqAllocator(orm.em, items),
    );
    publisher = new ActionPublishService(actions, NO_STOPS, NO_COMMANDS);
    sendMessage = vi.fn(() => Promise.resolve({ seq: 99 }));
    chatSend = vi.fn();
    service = new TeamActionsService(
      new ActionPressService(
        orm.em,
        runs,
        actions,
        { sendMessage: chatSend } as unknown as ChatService,
        NO_STOPS,
        NO_COMMANDS,
        new ActionCommandRegistry(),
      ),
      { sendMessage } as unknown as TeamExecutorService,
    );
    await runs.create({ id: 'run-w', status: 'running', teamId: 'team' });
    await runs.create({ id: 'run-c', status: 'completed', teamId: null });
  });

  async function publishedSeq(runId: string, actionId: string) {
    const live = await actions.live(runId);
    return live.find((action) => action.actionId === actionId)!.seq;
  }

  it('team press delivers to the trigger-fed agents with the From <agent> prefix', async () => {
    await publisher.publish(engineer, {
      label: 'PR merged',
      message: 'PR #12 is merged — continue',
    });
    const seq = await publishedSeq('run-w', 'pr-merged');

    const result = await service.press('run-w', seq, 'client-1', 'remote');

    expect(sendMessage).toHaveBeenCalledWith(
      'run-w',
      'From Engineer (action "PR merged"):\nPR #12 is merged — continue',
      [],
      'client-1',
    );
    expect(chatSend).not.toHaveBeenCalled();
    expect(result.outcome).toEqual({
      actionSeq: seq,
      actionId: 'pr-merged',
      nodeId: 'engineer',
      conversationId: 'call-1',
      state: 'succeeded',
      via: 'remote',
    });
    expect(await actions.live('run-w')).toEqual([]);
  });

  it('sends the manager’s own button as written', async () => {
    await publisher.publish(manager, { label: 'Deploy', message: 'deploy' });

    await service.press(
      'run-w',
      await publishedSeq('run-w', 'deploy'),
      'c1',
      'desktop',
    );

    expect(sendMessage).toHaveBeenCalledWith('run-w', 'deploy', [], 'c1');
  });

  it('writes nothing when the run answers RUN_BUSY, so the same seq can be pressed again', async () => {
    await publisher.publish(engineer, { label: 'Go', message: 'go' });
    const seq = await publishedSeq('run-w', 'go');
    sendMessage.mockRejectedValueOnce(
      new ConflictException('RUN_BUSY', 'the team is still starting'),
    );

    await expect(
      service.press('run-w', seq, 'c1', 'desktop'),
    ).rejects.toMatchObject({ errorCode: 'RUN_BUSY' });
    expect(await items.rowsOfKinds('run-w', ['action_outcome'])).toEqual([]);

    await service.press('run-w', seq, 'c1', 'desktop');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(await actions.live('run-w')).toEqual([]);
  });

  it('dismisses without telling any agent', async () => {
    await publisher.publish(engineer, { label: 'Go', message: 'go' });

    const result = await service.dismiss(
      'run-w',
      await publishedSeq('run-w', 'go'),
      'desktop',
    );

    expect(result.outcome.state).toBe('dismissed');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await actions.live('run-w')).toEqual([]);
  });

  it('refuses a chat run, whose buttons have their own route', async () => {
    await publisher.publish(
      { ...manager, runId: 'run-c' },
      { label: 'Go', message: 'go' },
    );
    const seq = await publishedSeq('run-c', 'go');

    await expect(
      service.press('run-c', seq, 'c1', 'desktop'),
    ).rejects.toMatchObject({ errorCode: 'NOT_A_TEAM_RUN' });
    await expect(
      service.dismiss('run-c', seq, 'desktop'),
    ).rejects.toMatchObject({ errorCode: 'NOT_A_TEAM_RUN' });
    expect(await actions.live('run-c')).toHaveLength(1);
  });
});
