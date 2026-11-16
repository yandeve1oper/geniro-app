import { HOST_ANALYZED_THREAD_TOOL } from '../../../agents/chat.types';
import { LESSONS_PER_REFLECTION_MAX } from '../../../lessons/lessons.types';

/** The description a lessons reflection reads for `propose_lessons`. */
export function proposeLessonsInstructions(): string {
  return `File the lessons of this reflection: at most ${LESSONS_PER_REFLECTION_MAX}, each passing all five gates of your method, or an empty list when none does — zero is the normal outcome. Call it once, after reading the thread with ${HOST_ANALYZED_THREAD_TOOL}. geniro saves them to the shared memory as searchable entries — after a second model checks them when the user has one set — and shows them as a card in the thread you read, where the user can undo each. Every lesson's evidence quotes a row inside your stretch word for word, and geniro checks it: when the call is refused, nothing is recorded — correct what each refusal names and send the whole list again. Not for anything but this reflection's lessons.`;
}
