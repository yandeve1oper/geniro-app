import { readModelParameters } from '../../agents/utils/model-parameters';
import type { Run } from '../../runs/entity/run.entity';
import { AgentKind, AgentKindSchema } from '../../runs/runs.types';
import type { LessonModelChoice, ReflectLessons } from '../lessons.types';

/** What a reflection or a check on one thread runs as. */
export interface ReflectionChoice {
  agentKind: AgentKind;
  model: string | null;
  effort: string | null;
  configDir: string | null;
  contextWindow: string | null;
  modelParameters: Record<string, string>;
}

export type ReflectionSource = Pick<
  Run,
  | 'agentKind'
  | 'configDir'
  | 'model'
  | 'effort'
  | 'contextWindow'
  | 'modelParameters'
>;

/**
 * What a reflection on `source` runs as: what a press named over the settings
 * choice, else the settings choice whole, else the thread as it ran — its CLI,
 * profile, model, effort, window and model parameters. A press naming another
 * CLI than the one it falls back to drops that choice's model, effort and
 * profile, which belong to the other CLI; one naming another model drops the
 * thread's effort, window and parameters, which belong to the other model.
 */
export function reflectionChoiceOf(
  settings: LessonModelChoice | null,
  source: ReflectionSource,
  input: Pick<ReflectLessons, 'agentKind' | 'model' | 'effort' | 'configDir'>,
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
  if (source.agentKind !== agentKind) {
    return {
      agentKind,
      model: input.model ?? null,
      effort: input.effort ?? null,
      configDir: input.configDir ?? null,
      contextWindow: null,
      modelParameters: {},
    };
  }
  const sameModel = input.model === undefined || input.model === source.model;
  return {
    agentKind,
    model: input.model ?? source.model,
    effort: input.effort ?? (sameModel ? source.effort : null),
    configDir: input.configDir ?? source.configDir,
    contextWindow: sameModel ? source.contextWindow : null,
    modelParameters: sameModel
      ? readModelParameters(source.modelParameters)
      : {},
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
