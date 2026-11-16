import { totalmem } from 'node:os';

import { describe, expect, it } from 'vitest';

import { KeptSessionConfigSchema } from '../chat.types';
import {
  AgentSessionRegistry,
  SESSION_MEMORY_COST_BYTES,
} from '../services/agent-session.registry';
import { KeptSessionsController } from './kept-sessions.controller';

describe('KeptSessionsController', () => {
  it('holds 60 minutes and the automatic limit until the first push, then what was pushed', () => {
    const registry = new AgentSessionRegistry(3);
    const controller = new KeptSessionsController(registry);

    expect(controller.getConfig()).toEqual({
      idleMinutes: 60,
      limit: null,
      automaticLimit: 3,
      sessionMemoryBytes: SESSION_MEMORY_COST_BYTES,
      totalMemoryBytes: totalmem(),
      recentlyUsedMinutes: 10,
    });
    expect(controller.setConfig({ idleMinutes: 5, limit: 24 })).toMatchObject({
      idleMinutes: 5,
      limit: 24,
      automaticLimit: 3,
    });
    expect(registry.idleMinutes).toBe(5);
    expect(controller.setConfig({ idleMinutes: 5, limit: null })).toMatchObject(
      { limit: null, automaticLimit: 3 },
    );
  });

  it('takes a whole number of minutes from 5 to 180', () => {
    for (const idleMinutes of [5, 60, 180]) {
      expect(
        KeptSessionConfigSchema.safeParse({ idleMinutes, limit: null }).success,
      ).toBe(true);
    }
    for (const idleMinutes of [4, 181, 30.5, 0, -60]) {
      expect(
        KeptSessionConfigSchema.safeParse({ idleMinutes, limit: null }).success,
      ).toBe(false);
    }
    expect(KeptSessionConfigSchema.safeParse({}).success).toBe(false);
  });

  it('takes a whole limit from 2 to 64, or null for automatic', () => {
    for (const limit of [2, 16, 64, null]) {
      expect(
        KeptSessionConfigSchema.safeParse({ idleMinutes: 60, limit }).success,
      ).toBe(true);
    }
    for (const limit of [1, 65, 8.5, 0, -4]) {
      expect(
        KeptSessionConfigSchema.safeParse({ idleMinutes: 60, limit }).success,
      ).toBe(false);
    }
    expect(KeptSessionConfigSchema.safeParse({ idleMinutes: 60 }).success).toBe(
      false,
    );
  });
});
