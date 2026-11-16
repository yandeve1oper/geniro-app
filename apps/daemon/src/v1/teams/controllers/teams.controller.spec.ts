import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunDao } from '../../agents/dao/run.dao';
import { AvatarStoreService } from '../services/avatar-store.service';
import { MAX_AVATAR_BYTES } from '../teams.types';
import { TeamsController } from './teams.controller';

describe('POST /v1/teams/runs/:runId/actions/:seq/press|dismiss', () => {
  function actionController() {
    const actions = {
      press: vi.fn(async () => ({ outcome: {} })),
      dismiss: vi.fn(async () => ({ outcome: {} })),
    };
    const controller = Object.create(
      TeamsController.prototype,
    ) as TeamsController;
    Object.assign(controller, { actions });
    return { controller, actions };
  }

  it('records a press through the gateway as remote, and one without the stamp as desktop', async () => {
    const { controller, actions } = actionController();

    await controller.pressAction(
      'run-w',
      4,
      { clientMessageId: 'c1' },
      { 'x-geniro-via': 'remote' },
    );
    await controller.pressAction('run-w', 4, { clientMessageId: 'c2' }, {});

    expect(actions.press.mock.calls).toEqual([
      ['run-w', 4, 'c1', 'remote'],
      ['run-w', 4, 'c2', 'desktop'],
    ]);
  });

  it('records a dismissal through the gateway as remote', async () => {
    const { controller, actions } = actionController();

    await controller.dismissAction('run-w', 4, { 'x-geniro-via': 'remote' });

    expect(actions.dismiss).toHaveBeenCalledWith('run-w', 4, 'remote');
  });
});

describe('PUT /v1/teams/runs/:runId/members/:memberId/pool-member', () => {
  it('hands the run, the member and the picked pool member to the executor and answers what it did', async () => {
    const executor = {
      setOwnPoolMember: vi.fn(async () => ({
        member: 2,
        applied: 'next_turn' as const,
      })),
    };
    const controller = Object.create(
      TeamsController.prototype,
    ) as TeamsController;
    Object.assign(controller, { executor });

    await expect(
      controller.setPoolMember('run-w', 'lead', { member: 2 }),
    ).resolves.toEqual({ member: 2, applied: 'next_turn' });
    expect(executor.setOwnPoolMember).toHaveBeenCalledWith('run-w', 'lead', 2);
  });
});

describe('POST /v1/teams/runs/:runId/stages', () => {
  it('records a move through the gateway as remote, and one without the stamp as desktop', async () => {
    const stageWakes = {
      userMove: vi.fn(async (..._args: unknown[]) => ({})),
    };
    const controller = Object.create(
      TeamsController.prototype,
    ) as TeamsController;
    Object.assign(controller, { stageWakes });
    const dto = {
      action: 'complete' as const,
      stage: 'build',
      text: 'built',
      expectedRev: 3,
    };

    await controller.moveStage('run-w', dto, { 'x-geniro-via': 'remote' });
    await controller.moveStage('run-w', dto, {});

    const via = stageWakes.userMove.mock.calls.map((call) => call[2]);
    expect(via).toEqual(['remote', 'desktop']);
  });
});

describe('team avatar routes', () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('a tiny picture body'),
  ]);
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function avatarController() {
    const root = await mkdtemp(join(tmpdir(), 'geniro-avatar-routes-'));
    roots.push(root);
    const avatars = new AvatarStoreService({} as RunDao, {
      root: join(root, 'avatars'),
      teamsDir: join(root, 'teams'),
    });
    const controller = Object.create(
      TeamsController.prototype,
    ) as TeamsController;
    Object.assign(controller, { avatars });
    return { controller, root };
  }

  it('refuses a non-image by bytes and a file over 1 MB', async () => {
    const { controller, root } = await avatarController();

    await expect(
      controller.uploadAvatar({
        data: Buffer.from('<svg/>').toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'AVATAR_NOT_AN_IMAGE' });
    const avif = Buffer.concat([
      Buffer.from([0, 0, 0, 0x1c]),
      Buffer.from('ftypavif'),
    ]);
    await expect(
      controller.uploadAvatar({ data: avif.toString('base64') }),
    ).rejects.toMatchObject({ code: 'AVATAR_NOT_AN_IMAGE' });
    const oversize = Buffer.concat([PNG, Buffer.alloc(MAX_AVATAR_BYTES)]);
    await expect(
      controller.uploadAvatar({ data: oversize.toString('base64') }),
    ).rejects.toMatchObject({ code: 'AVATAR_TOO_LARGE' });

    await expect(readdir(join(root, 'avatars'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('returns a data URI for a stored avatar', async () => {
    const { controller } = await avatarController();

    const { id } = await controller.uploadAvatar({
      data: PNG.toString('base64'),
    });

    expect(id).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(await controller.getAvatar(id)).toEqual({
      dataUri: `data:image/png;base64,${PNG.toString('base64')}`,
    });
    await expect(controller.getAvatar('missing.png')).rejects.toMatchObject({
      code: 'AVATAR_NOT_FOUND',
    });
  });
});
