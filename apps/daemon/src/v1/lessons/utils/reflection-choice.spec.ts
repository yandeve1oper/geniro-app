import { describe, expect, it } from 'vitest';

import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import type { LessonModelChoice, ReflectLessons } from '../lessons.types';
import {
  checkChoiceOf,
  reflectionChoiceOf,
  type ReflectionSource,
} from './reflection-choice';

function thread(overrides: Partial<ReflectionSource> = {}): ReflectionSource {
  return {
    agentKind: AgentKind.Claude,
    configDir: '/cfg/claude',
    model: 'opus',
    effort: 'medium',
    contextWindow: '1m',
    modelParameters: '{"fast":"on"}',
    ...overrides,
  };
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

const NO_PRESS: Partial<ReflectLessons> = {};

describe('reflectionChoiceOf', () => {
  it('defaults to the thread as it ran: its CLI, profile, model, effort, window and model parameters', () => {
    expect(reflectionChoiceOf(null, thread(), NO_PRESS)).toEqual({
      agentKind: AgentKind.Claude,
      model: 'opus',
      effort: 'medium',
      configDir: '/cfg/claude',
      contextWindow: '1m',
      modelParameters: { fast: 'on' },
    });
  });

  it('keeps the CLI defaults a thread ran on, swapping in no model or effort of its own', () => {
    expect(
      reflectionChoiceOf(
        null,
        thread({
          agentKind: AgentKind.Codex,
          model: null,
          effort: null,
          contextWindow: null,
          modelParameters: null,
        }),
        NO_PRESS,
      ),
    ).toEqual({
      agentKind: AgentKind.Codex,
      model: null,
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
    expect(reflectionChoiceOf(settings, thread(), NO_PRESS)).toEqual({
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
    expect(reflectionChoiceOf(settings, thread(), NO_PRESS)).toEqual({
      agentKind: AgentKind.Codex,
      model: 'gpt-settings',
      effort: 'high',
      configDir: null,
      contextWindow: null,
      modelParameters: {},
    });
  });

  it.each<
    [
      string,
      LessonModelChoice | null,
      Partial<ReflectionSource>,
      ReflectLessons,
      object,
    ]
  >([
    [
      'a settings agent this daemon does not know: the thread as it ran',
      choice({ agent: 'gemini', model: 'gemini-settings', effort: 'high' }),
      {},
      {},
      {
        agentKind: AgentKind.Claude,
        model: 'opus',
        effort: 'medium',
        configDir: '/cfg/claude',
      },
    ],
    [
      'a press agent beats the settings agent, and runs that CLI as the thread ran it',
      choice({ agent: 'codex', model: 'gpt-settings', effort: 'high' }),
      {},
      { agentKind: AgentKind.Claude },
      {
        agentKind: AgentKind.Claude,
        model: 'opus',
        effort: 'medium',
        configDir: '/cfg/claude',
      },
    ],
    [
      'a press model, effort and folder beat the settings and the thread',
      choice({ agent: 'claude', model: 'settings-model', effort: 'low' }),
      {},
      { model: 'sonnet', effort: 'max', configDir: '/cfg/press' },
      {
        agentKind: AgentKind.Claude,
        model: 'sonnet',
        effort: 'max',
        configDir: '/cfg/press',
      },
    ],
    [
      'a press naming another model drops the effort, window and parameters the thread’s model had',
      null,
      {},
      { model: 'sonnet' },
      {
        agentKind: AgentKind.Claude,
        model: 'sonnet',
        effort: null,
        contextWindow: null,
        modelParameters: {},
      },
    ],
    [
      'a press naming the thread’s own model keeps its effort, window and parameters',
      null,
      {},
      { model: 'opus' },
      {
        model: 'opus',
        effort: 'medium',
        contextWindow: '1m',
        modelParameters: { fast: 'on' },
      },
    ],
    [
      'a press naming another agent takes none of the thread’s settings: they were the other CLI’s',
      null,
      {},
      { agentKind: AgentKind.Codex },
      {
        agentKind: AgentKind.Codex,
        model: null,
        effort: null,
        configDir: null,
        contextWindow: null,
        modelParameters: {},
      },
    ],
    [
      'a thread with no agent of its own runs as Claude with the CLI defaults',
      null,
      { agentKind: null as unknown as Run['agentKind'], configDir: null },
      {},
      {
        agentKind: AgentKind.Claude,
        model: null,
        effort: null,
        configDir: null,
      },
    ],
  ])('%s', (_, settings, threadOverrides, press, expected) => {
    expect(
      reflectionChoiceOf(settings, thread(threadOverrides), press),
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
