import { asNumber, asRecord, asString } from '../../../utils/json-util';
import type { AgentPlanLimits, AgentPlanWindow } from '../../adapter.types';
import { classifyMessage, encodeRequest } from '../../utils/json-rpc.utils';
import { CODEX_METHODS } from '../codex.const';
import type { CodexRateLimitWindow } from '../codex.types';

/**
 * The `account/rateLimits/read` request put to a RUNNING codex process, under
 * a string id no frame of the session's own (numbered from 1) can share.
 */
export function codexPlanLimitsRequestLine(requestId: string): string {
  return encodeRequest(
    requestId,
    CODEX_METHODS.rateLimitsRead,
    codexPlanLimitsRequestParams(),
  );
}

/** The params of `account/rateLimits/read`, on a live process or a one-shot. */
export function codexPlanLimitsRequestParams(): {
  excludeResetCreditDetails: true;
} {
  return { excludeResetCreditDetails: true };
}

/**
 * The plan limits in the reply to {@link codexPlanLimitsRequestLine}, or null
 * for any other line (the ask's reader is offered every line the process
 * prints).
 */
export function readCodexPlanLimitsReply(
  obj: unknown,
  requestId: string,
): AgentPlanLimits | null {
  const message = classifyMessage(obj);
  if (message.kind !== 'response' || message.id !== requestId) {
    return null;
  }
  return readCodexPlanLimits(message.result);
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

function readWindow(value: unknown): CodexRateLimitWindow | null {
  const record = asRecord(value);
  const usedPercent = record ? asNumber(record.usedPercent) : null;
  if (record === null || usedPercent === null) {
    return null;
  }
  return {
    usedPercent,
    windowDurationMins: asNumber(record.windowDurationMins),
    resetsAt: asNumber(record.resetsAt),
  };
}

/** A window's length in words — `5-hour limit`, `Weekly limit`. */
function windowLabel(minutes: number | null, fallback: string): string {
  if (minutes === null || minutes <= 0) {
    return fallback;
  }
  if (minutes === MINUTES_PER_WEEK) {
    return 'Weekly limit';
  }
  if (minutes % MINUTES_PER_DAY === 0) {
    return `${minutes / MINUTES_PER_DAY}-day limit`;
  }
  if (minutes % MINUTES_PER_HOUR === 0) {
    return `${minutes / MINUTES_PER_HOUR}-hour limit`;
  }
  return `${minutes}-minute limit`;
}

function toWindow(
  key: string,
  window: CodexRateLimitWindow,
  fallback: string,
): AgentPlanWindow {
  return {
    key,
    label: windowLabel(window.windowDurationMins, fallback),
    percent: Math.max(0, Math.min(100, window.usedPercent)),
    resetsAt:
      window.resetsAt !== null
        ? new Date(window.resetsAt * 1000).toISOString()
        : null,
  };
}

/**
 * An `account/rateLimits/read` result as the plan-limit windows the readout
 * draws — codex's primary (short, 5 hours on the plans measured) and secondary
 * (weekly) windows. Null when the answer holds neither, which is what a
 * signed-in API-key account with no plan reports.
 */
export function readCodexPlanLimits(result: unknown): AgentPlanLimits | null {
  const limits = asRecord(asRecord(result)?.rateLimits);
  if (limits === null) {
    return null;
  }
  const windows: AgentPlanWindow[] = [];
  const primary = readWindow(limits.primary);
  if (primary !== null) {
    windows.push(toWindow('primary', primary, 'Short-term limit'));
  }
  const secondary = readWindow(limits.secondary);
  if (secondary !== null) {
    windows.push(toWindow('secondary', secondary, 'Long-term limit'));
  }
  if (windows.length === 0) {
    return null;
  }
  // `account/rateLimits/read` answers from the account, never from a fallback
  // the reply would have to admit to.
  return { plan: asString(limits.planType), windows, estimated: false };
}
