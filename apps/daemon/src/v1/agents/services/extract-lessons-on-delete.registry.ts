import { Injectable } from '@nestjs/common';

/**
 * Takes a run the user deleted with "Extract lessons first": hides it, starts
 * the reflection and deletes it once that settles. Answers null when there is
 * nothing to reflect on, and the route then deletes as usual.
 */
export type ExtractLessonsThenDelete = (
  runId: string,
) => Promise<{ deleted: boolean } | null>;

/**
 * Where the lessons module hangs "Extract lessons first" for the chat and
 * team-run delete routes, which live in modules below it.
 */
@Injectable()
export class ExtractLessonsOnDeleteRegistry {
  private handler: ExtractLessonsThenDelete | null = null;

  use(handler: ExtractLessonsThenDelete): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) {
        this.handler = null;
      }
    };
  }

  extract(runId: string): Promise<{ deleted: boolean } | null> {
    return this.handler === null ? Promise.resolve(null) : this.handler(runId);
  }
}
