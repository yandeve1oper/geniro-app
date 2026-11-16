import type { ItemKind } from '../../runs/runs.types';
import type { LessonSignal } from '../lessons.types';

/** One stored item as the fold reads it: its payload still the stored JSON text. */
export interface LessonSignalItem {
  seq: number;
  kind: ItemKind;
  role: string | null;
  payload: string;
}

/** The item kinds the fold reads; a caller may page only these. */
export const LESSON_SIGNAL_ITEM_KINDS: ItemKind[] = [
  'message',
  'turn_complete',
  'tool_result',
  'approval_verdict',
  'thread_outcome',
  'stage_change',
  'report_findings',
];

const EXCERPT_MAX_CHARS = 200;

/**
 * Words that open a user's push-back on what the agent just did — a prefilter
 * only: the reflection judges whether the message really corrects anything.
 */
const CORRECTION_CUES =
  /(^|[\s,.!?:;«"'(])(no|nope|wrong|incorrect|don't|do not|didn't|doesn't|stop|instead|actually|again|still|not what|why did|broke|broken|fails?|failing|не|нет|неправильно|неверно|опять|снова|всё ещё|все еще|вместо|зачем|почему|сломал|сломано|не работает|не надо|не нужно)(?=$|[\s,.!?:;»"')])/iu;

/**
 * The learning signals in one stretch of a thread, oldest first — what a
 * reflection is offered on and what its brief points it at. Model-free: it
 * reads only what the items state.
 *
 * - `user_correction`: a user message after an agent's finished turn that
 *   opens with push-back.
 * - `approval_refused`: an approval the user declined.
 * - `error_then_success`: a failed tool result whose tool later succeeded.
 * - `outcome_failed`: a recorded outcome of `failed` or `partial`.
 * - `stage_reopened`: a team stage moved back.
 * - `review_finding`: a code review's findings.
 */
export function foldLessonSignals(
  items: readonly LessonSignalItem[],
  options: {
    /** The stretch starts after a reflected one, which ended on a finished turn. */
    afterFinishedTurn?: boolean;
  } = {},
): LessonSignal[] {
  const signals: LessonSignal[] = [];
  let agentFinished = options.afterFinishedTurn ?? false;
  const failedTools = new Map<string, { seq: number; excerpt: string }>();
  for (const item of items) {
    const payload = parsePayload(item.payload);
    switch (item.kind) {
      case 'turn_complete':
        agentFinished = true;
        break;
      case 'message': {
        if (item.role !== 'user') {
          break;
        }
        const text = stringField(payload, 'text');
        if (agentFinished && text !== null && CORRECTION_CUES.test(text)) {
          signals.push({
            kind: 'user_correction',
            seq: item.seq,
            excerpt: excerpt(text),
          });
        }
        agentFinished = false;
        break;
      }
      case 'approval_verdict':
        if (payload?.allow === false) {
          signals.push({
            kind: 'approval_refused',
            seq: item.seq,
            excerpt: excerpt(
              stringField(payload, 'answer') ?? 'An approval was declined',
            ),
          });
        }
        break;
      case 'tool_result': {
        const name = stringField(payload, 'name');
        if (name === null) {
          break;
        }
        if (payload?.isError === true) {
          if (!failedTools.has(name)) {
            failedTools.set(name, {
              seq: item.seq,
              excerpt: excerpt(`${name}: ${resultText(payload.result)}`),
            });
          }
          break;
        }
        const failed = failedTools.get(name);
        if (failed !== undefined) {
          failedTools.delete(name);
          signals.push({ kind: 'error_then_success', ...failed });
        }
        break;
      }
      case 'thread_outcome': {
        const kind = stringField(payload, 'kind');
        if (kind === 'failed' || kind === 'partial') {
          signals.push({
            kind: 'outcome_failed',
            seq: item.seq,
            excerpt: excerpt(
              `${kind}: ${stringField(payload, 'summary') ?? ''}`.trim(),
            ),
          });
        }
        break;
      }
      case 'stage_change':
        if (stringField(payload, 'action') === 'reopen') {
          signals.push({
            kind: 'stage_reopened',
            seq: item.seq,
            excerpt: excerpt(
              `${stringField(payload, 'stageTitle') ?? 'A stage'}: ${stringField(payload, 'text') ?? ''}`,
            ),
          });
        }
        break;
      case 'report_findings': {
        const findings = Array.isArray(payload?.findings)
          ? payload.findings.length
          : 0;
        if (findings > 0) {
          signals.push({
            kind: 'review_finding',
            seq: item.seq,
            excerpt: `A review reported ${findings} finding${findings === 1 ? '' : 's'}`,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return signals.sort((a, b) => a.seq - b.seq);
}

function parsePayload(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(
  payload: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = payload?.[key];
  return typeof value === 'string' ? value : null;
}

function resultText(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  try {
    return JSON.stringify(result) ?? '';
  } catch {
    return '';
  }
}

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const chars = [...line];
  return chars.length <= EXCERPT_MAX_CHARS
    ? line
    : `${chars.slice(0, EXCERPT_MAX_CHARS - 1).join('')}…`;
}
