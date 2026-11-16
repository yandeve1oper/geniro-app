import { Injectable } from '@nestjs/common';

import { DEFAULT_LESSONS_CONFIG, type LessonsConfig } from '../lessons.types';

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
}
