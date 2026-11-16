import { describe, expect, it } from 'vitest';

import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import type { LessonModelChoice, ReflectLessons } from '../lessons.types';
import {
  checkChoiceOf,
  type ReflectionChoiceFacts,
  reflectionChoiceOf,
} from './reflection-choice';

function thread(
  overrides: Partial<Pick<Run, 'agentKind' | 'configDir'>> = {},
): Pick<Run, 'agentKind' | 'configDir'> {
  return {
    agentKind: AgentKind.Claude,
    configDir: '/cfg/claude',
    ...overrides,
  } as Pick<Run, 'agentKind' | 'configDir'>;
}

function choice(overrides: Partial<LessonModelChoice> = {}): LessonModelChoice {
  return {
    agent: 'codex',
    configDir: null,
    model: null,
    effort: null,
    contextWindow: null,
    modelParameters: {},
    ...overrides,
  };
}

function facts(
  overrides: Partial<ReflectionChoiceFacts> = {},
): ReflectionChoiceFacts {
  return {
    lightModelOf: (agent) => (agent === AgentKind.Claude ? 'haiku' : null),
    acceptsEffort: () => true,
    ...overrides,
  };
}

const NO_PRESS: Partial<ReflectLessons> = {};

describe('reflectionChoiceOf', () => {
  it('defaults to the thread CLI, its profile and the light model at high effort', () => {
    expect(reflectionChoiceOf(null, thread(), NO_PRESS, facts())).toEqual({
      agentKind: AgentKind.Claude,
      model: 'haiku',
      effort: 'high',
      configDir: '/cfg/claude',
      contextWindow: null,
      modelParameters: {},
    });
  });

  it('runs the CLI default model when the CLI has no light model', () => {
    expect(
      reflectionChoiceOf(
        null,
        thread({ agentKind: AgentKind.Codex }),
        NO_PRESS,
        facts({ lightModelOf: () => null }),
      ),
    ).toEqual({
      agentKind: AgentKind.Codex,
      model: null,
      effort: 'high',
      configDir: '/cfg/claude',
      contextWindow: null,
      modelParameters: {},
    });
  });

  it('keeps the CLI default effort when the model offers no high', () => {
    expect(
      reflectionChoiceOf(
        null,
        thread(),
        NO_PRESS,
        facts({ acceptsEffort: () => false }),
      ),
    ).toEqual({
      agentKind: AgentKind.Claude,
      model: 'haiku',
      effort: null,
      configDir: '/cfg/claude',
      contextWindow: null,
      modelParameters: {},
    });
  });

  it('uses the settings CLI, profile, model and effort when set', () => {
    const settings = choice({
      agent: 'codex',
      configDir: '/cfg/codex',
      model: 'gpt-settings',
      effort: 'low',
      contextWindow: '200k',
      modelParameters: { temperature: '0.2' },
    });
    expect(reflectionChoiceOf(settings, thread(), NO_PRESS, facts())).toEqual({
      agentKind: AgentKind.Codex,
      model: 'gpt-settings',
      effort: 'low',
      configDir: '/cfg/codex',
      contextWindow: '200k',
      modelParameters: { temperature: '0.2' },
    });
  });

  it('drops the thread profile when the settings CLI differs', () => {
    const settings = choice({
      agent: 'codex',
      configDir: null,
      model: 'gpt-settings',
      effort: 'high',
    });
    expect(reflectionChoiceOf(settings, thread(), NO_PRESS, facts())).toEqual({
      agentKind: AgentKind.Codex,
      model: 'gpt-settings',
      effort: 'high',
      configDir: null,
      contextWindow: null,
      modelParameters: {},
    });
  });

  it.each<
    [string, LessonModelChoice | null, Partial<Run>, ReflectLessons, object]
  >([
    [
      'a settings agent this daemon does not know: the thread’s own CLI, with no settings model',
      choice({ agent: 'gemini', model: 'gemini-settings', effort: 'high' }),
      {},
      {},
      {
        agentKind: AgentKind.Claude,
        model: 'haiku',
        effort: 'high',
        configDir: '/cfg/claude',
      },
    ],
    [
      'a press agent beats the settings agent, and drops the settings model and effort',
      choice({ agent: 'codex', model: 'gpt-settings', effort: 'high' }),
      {},
      { agentKind: AgentKind.Claude },
      {
        agentKind: AgentKind.Claude,
        model: 'haiku',
        effort: 'high',
        configDir: '/cfg/claude',
      },
    ],
    [
      'a press model, effort and folder beat the settings and the thread',
      choice({ agent: 'claude', model: 'settings-model', effort: 'low' }),
      {},
      { model: 'opus', effort: 'max', configDir: '/cfg/press' },
      {
        agentKind: AgentKind.Claude,
        model: 'opus',
        effort: 'max',
        configDir: '/cfg/press',
      },
    ],
    [
      'a press naming another agent keeps the thread’s config folder off: it was the other CLI’s',
      null,
      {},
      { agentKind: AgentKind.Codex },
      {
        agentKind: AgentKind.Codex,
        model: 'gpt-6-luna',
        effort: 'high',
        configDir: null,
      },
    ],
    [
      'a thread with no agent of its own runs as Claude',
      null,
      { agentKind: null as unknown as Run['agentKind'], configDir: null },
      {},
      {
        agentKind: AgentKind.Claude,
        model: 'haiku',
        effort: 'high',
        configDir: null,
      },
    ],
  ])('%s', (_, settings, threadOverrides, press, expected) => {
    expect(
      reflectionChoiceOf(
        settings,
        thread(threadOverrides),
        press,
        facts({
          lightModelOf: (agent) =>
            agent === AgentKind.Claude ? 'haiku' : 'gpt-6-luna',
        }),
      ),
    ).toMatchObject(expected);
  });
});

describe('checkChoiceOf', () => {
  it('is null while the check is off', () => {
    expect(checkChoiceOf(null)).toBeNull();
  });

  it('is null for a checker naming a CLI this daemon does not know', () => {
    expect(checkChoiceOf(choice({ agent: 'gemini', model: 'x' }))).toBeNull();
  });

  it('is the checker choice whole when its CLI is known', () => {
    expect(
      checkChoiceOf(
        choice({
          agent: 'claude',
          configDir: '/cfg/checker',
          model: 'opus',
          effort: 'max',
          contextWindow: '1m',
          modelParameters: { top_p: '0.9' },
        }),
      ),
    ).toEqual({
      agentKind: AgentKind.Claude,
      model: 'opus',
      effort: 'max',
      configDir: '/cfg/checker',
      contextWindow: '1m',
      modelParameters: { top_p: '0.9' },
    });
  });
});
