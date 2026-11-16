import { HOST_ANALYZED_THREAD_TOOL } from '../../../agents/chat.types';

/** The description the second-model check reads for `check_lessons`. */
export function checkLessonsInstructions(): string {
  return `File your verdict on every lesson your brief lists — keep, rewrite (with the new title and rule) or drop — each with the gate it passes or fails. Call it once, after reading each lesson's evidence with ${HOST_ANALYZED_THREAD_TOOL}. Kept and rewritten lessons are saved to the shared memory with no human review; dropped ones are shown to the user with your reason. When the call is refused nothing is recorded — correct what each refusal names and send every verdict again. Not for anything but this check.`;
}
