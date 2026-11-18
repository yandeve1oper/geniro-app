import {
  HOST_QUESTION_TOOL,
  StageChangePayloadSchema,
  ThreadOutcomePayloadSchema,
} from '../../agents/chat.types';
import {
  asArray,
  asRecord,
  parseJsonColumn,
  payloadString,
} from '../../agents/utils/json-util';
import { bareToolName } from '../../agents/utils/mcp-tool-name';
import type { Run } from '../../runs/entity/run.entity';
import type { ThreadMessage } from '../../runs/entity/thread-message.entity';
import type { UsageActivity } from '../../stats/entity/usage-activity.entity';
import type { Task } from '../../tasks/entity/task.entity';
import type { CommandCenterTimelineKind } from '../command-center.types';
import { oneLine, type TimedRow } from './timeline-page';

export interface TimelineCandidate extends TimedRow {
  kind: CommandCenterTimelineKind;
  threadRunId: string | null;
  fallbackTitle: string | null;
  text: string | null;
  detail: string | null;
  awaitingReply: boolean;
}

export interface ItemRow {
  id: string;
  run_id: string;
  payload: string;
  created_at: number;
}

function candidate(
  kind: CommandCenterTimelineKind,
  source: string,
  at: Date,
  fields: Partial<Omit<TimelineCandidate, 'id' | 'at' | 'kind'>> = {},
): TimelineCandidate {
  return {
    id: `${kind}:${source}`,
    at,
    kind,
    threadRunId: null,
    fallbackTitle: null,
    text: null,
    detail: null,
    awaitingReply: false,
    ...fields,
  };
}

function itemAt(row: ItemRow): Date {
  return new Date(row.created_at);
}

export function userMessageEvent(row: ItemRow): TimelineCandidate {
  return candidate('user_message', row.id, itemAt(row), {
    text: oneLine(payloadString(parseJsonColumn(row.payload), 'text')),
  });
}

export function managerMessageEvent(
  row: Pick<
    ThreadMessage,
    | 'id'
    | 'toRunId'
    | 'text'
    | 'createdAt'
    | 'replyCreditUntil'
    | 'replyCreditSpentAt'
  >,
  now: number,
): TimelineCandidate {
  return candidate('manager_message', row.id, row.createdAt, {
    threadRunId: row.toRunId,
    text: oneLine(row.text),
    awaitingReply:
      row.replyCreditUntil !== null &&
      row.replyCreditSpentAt === null &&
      row.replyCreditUntil.getTime() > now,
  });
}

export function threadMessageEvent(
  row: Pick<
    ThreadMessage,
    'id' | 'fromRunId' | 'fromTitle' | 'text' | 'createdAt'
  >,
): TimelineCandidate {
  return candidate('thread_message', row.id, row.createdAt, {
    threadRunId: row.fromRunId,
    fallbackTitle: row.fromTitle,
    text: oneLine(row.text),
  });
}

export function threadStartedEvent(
  run: Pick<Run, 'id' | 'createdAt'>,
): TimelineCandidate {
  return candidate('thread_started', run.id, run.createdAt, {
    threadRunId: run.id,
  });
}

export function startRequestEvent(
  task: Pick<Task, 'id' | 'title' | 'startApprovedAt'>,
  at: Date,
): TimelineCandidate {
  return candidate('start_requested', task.id, at, {
    text: oneLine(task.title),
    detail: task.startApprovedAt === null ? 'waiting for Start' : 'approved',
  });
}

export function pullRequestEvent(
  row: Pick<
    UsageActivity,
    'id' | 'runId' | 'occurredAt' | 'prOwner' | 'prRepo' | 'prNumber'
  >,
): TimelineCandidate {
  return candidate('pull_request', row.id, row.occurredAt, {
    threadRunId: row.runId,
    text:
      row.prOwner === null || row.prRepo === null
        ? null
        : `${row.prOwner}/${row.prRepo}`,
    detail: row.prNumber === null ? null : String(row.prNumber),
  });
}

export function approvalEvent(row: ItemRow): TimelineCandidate {
  const body = parseJsonColumn(row.payload);
  const toolName = payloadString(body, 'toolName');
  const isQuestion =
    asRecord(body)?.requiresUserInteraction === true ||
    toolName === HOST_QUESTION_TOOL;
  const questionText = payloadString(
    asArray(asRecord(body)?.questions)[0],
    'question',
  );
  return candidate(isQuestion ? 'question' : 'approval', row.id, itemAt(row), {
    threadRunId: row.run_id,
    text: oneLine(
      isQuestion
        ? (questionText ?? toolName)
        : toolName === null
          ? null
          : bareToolName(toolName),
    ),
  });
}

export function stageEvent(row: ItemRow): TimelineCandidate {
  const parsed = StageChangePayloadSchema.safeParse(
    parseJsonColumn(row.payload),
  );
  return candidate('stage', row.id, itemAt(row), {
    threadRunId: row.run_id,
    text: oneLine(parsed.success ? parsed.data.text : null),
    detail: parsed.success ? parsed.data.stageTitle : null,
  });
}

export function outcomeEvent(row: ItemRow): TimelineCandidate {
  const parsed = ThreadOutcomePayloadSchema.safeParse(
    parseJsonColumn(row.payload),
  );
  return candidate('outcome', row.id, itemAt(row), {
    threadRunId: row.run_id,
    text: oneLine(parsed.success ? parsed.data.summary : null),
    detail: parsed.success ? parsed.data.kind : null,
  });
}

export function failedEvent(
  run: Pick<Run, 'id'>,
  at: Date,
  errorLine: string | null,
): TimelineCandidate {
  return candidate('failed', run.id, at, {
    threadRunId: run.id,
    text: oneLine(errorLine),
  });
}

export function errorLineOf(row: Pick<ItemRow, 'payload'>): string | null {
  return payloadString(parseJsonColumn(row.payload), 'message');
}
