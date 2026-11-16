import type { Run } from '../../runs/entity/run.entity';
import { AgentKind, AgentKindSchema } from '../../runs/runs.types';
import type { LessonModelChoice, ReflectLessons } from '../lessons.types';

/** The effort a reflection on the thread's own CLI runs at when the model offers it. */
export const LESSON_DEFAULT_EFFORT = 'high';

/** What a reflection or a check on one thread runs as. */
export interface ReflectionChoice {
  agentKind: AgentKind;
  model: string | null;
  effort: string | null;
  configDir: string | null;
  contextWindow: string | null;
  modelParameters: Record<string, string>;
}

/** The facts about a CLI a default choice reads. */
export interface ReflectionChoiceFacts {
  lightModelOf: (agent: AgentKind) => string | null;
  acceptsEffort: (
    agent: AgentKind,
    effort: string,
    model: string | null,
    configDir: string | null,
  ) => boolean;
}

/**
 * What a reflection on `source` runs as: what a press named over the settings
 * choice, else the settings choice whole, else the thread's own CLI and
 * profile on that CLI's light model at high effort when the model offers it.
 * A press naming another CLI than the settings' drops the settings' model,
 * effort and profile, which belong to that CLI.
 */
export function reflectionChoiceOf(
  settings: LessonModelChoice | null,
  source: Pick<Run, 'agentKind' | 'configDir'>,
  input: Pick<ReflectLessons, 'agentKind' | 'model' | 'effort' | 'configDir'>,
  facts: ReflectionChoiceFacts,
): ReflectionChoice {
  const chosen = settingsChoiceOf(settings);
  const agentKind =
    input.agentKind ??
    chosen?.agentKind ??
    source.agentKind ??
    AgentKind.Claude;
  if (chosen !== null && chosen.agentKind === agentKind) {
    return {
      ...chosen,
      model: input.model ?? chosen.model,
      effort: input.effort ?? chosen.effort,
      configDir: input.configDir ?? chosen.configDir,
    };
  }
  const configDir =
    input.configDir ??
    (source.agentKind === agentKind ? source.configDir : null);
  const model = input.model ?? facts.lightModelOf(agentKind);
  const effort =
    input.effort ??
    (facts.acceptsEffort(agentKind, LESSON_DEFAULT_EFFORT, model, configDir)
      ? LESSON_DEFAULT_EFFORT
      : null);
  return {
    agentKind,
    model,
    effort,
    configDir,
    contextWindow: null,
    modelParameters: {},
  };
}

/** The second-model check's choice, or null while the check is off or names a CLI this daemon does not know. */
export function checkChoiceOf(
  checker: LessonModelChoice | null,
): ReflectionChoice | null {
  return settingsChoiceOf(checker);
}

function settingsChoiceOf(
  choice: LessonModelChoice | null,
): ReflectionChoice | null {
  if (choice === null) {
    return null;
  }
  const agent = AgentKindSchema.safeParse(choice.agent);
  if (!agent.success) {
    return null;
  }
  return {
    agentKind: agent.data,
    model: choice.model,
    effort: choice.effort,
    configDir: choice.configDir,
    contextWindow: choice.contextWindow,
    modelParameters: { ...choice.modelParameters },
  };
}
