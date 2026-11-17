import { Injectable } from '@nestjs/common';

import {
  DEFAULT_LESSONS_CONFIG,
  type LessonsConfig,
  type ReflectLessons,
} from '../lessons.types';
import {
  checkChoiceOf,
  type ReflectionChoice,
  reflectionChoiceOf,
  type ReflectionSource,
} from '../utils/reflection-choice';

/**
 * The lessons settings as Electron main last pushed them; the defaults until
 * its first push. Held in memory, like the memory config: main pushes again
 * on every daemon start.
 */
@Injectable()
export class LessonsConfigService {
  private current: LessonsConfig = DEFAULT_LESSONS_CONFIG;

  get config(): LessonsConfig {
    return this.current;
  }

  set(config: LessonsConfig): LessonsConfig {
    this.current = { ...config };
    return this.current;
  }

  /** What a reflection on `source` runs as, by the settings and what a press named. */
  reflectionChoice(
    source: ReflectionSource,
    input: Pick<
      ReflectLessons,
      'agentKind' | 'model' | 'effort' | 'configDir'
    > = {},
  ): ReflectionChoice {
    return reflectionChoiceOf(this.current.reflector, source, input);
  }

  /** What the second-model check runs as, or null while it is off. */
  checkChoice(): ReflectionChoice | null {
    return checkChoiceOf(this.current.checker);
  }
}
