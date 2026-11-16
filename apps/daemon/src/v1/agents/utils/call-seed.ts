import type {
  CallConversation,
  CallResultPayload,
  CallSeedRecord,
  CallStartedPayload,
  KindRowsView,
  MessageDeliveryFailure,
  RunCallSeed,
} from '../chat.types';
import { asNumber, parseJsonColumn } from './json-util';
import { positive } from './positive-figure';

/** One transcript row, as much of it as the fold reads. */
export interface CallSeedRow {
  kind: string;
  payload: unknown;
  /** When the row was written — a `call_result`'s is when its call ended. */
  createdAt?: Date;
}

/**
 * The rows {@link readCallSeed} folds: every call row, and the `system` rows
 * carrying the notices that acknowledge failed deliveries to their sender.
 */
export const CALL_RECORDS: KindRowsView = {
  name: 'call-records',
  kinds: ['call_started', 'call_result', 'call_answer', 'system'],
  keep: (row) =>
    row.kind !== 'system' || row.payload.includes('"messageDeliveryNotices"'),
};

/** The id the broker mints for a run's `n`th call — what {@link callNumber} reads back. */
export function callIdOf(n: number): string {
  return `call-${n}`;
}

/**
 * The number in a broker call id (`call-7` → 7), or null for anything else.
 *
 * Read back by the seed, to continue the counter past the transcript, and by
 * the broker, to tell an id an EARLIER daemon minted from one that never
 * existed.
 */
export function callNumber(callId: string): number | null {
  const match = /^call-(\d+)$/.exec(callId);
  return match ? Number(match[1]) : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isMemberNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function positiveNumber(value: unknown): number | null {
  const number = asNumber(value);
  return positive(number) ? number : null;
}

/** The cache facts a `call_result` row carries, each only when measured. */
function cacheFactsOf(
  fields: Partial<Record<keyof CallResultPayload, unknown>>,
  createdAt: Date | undefined,
): Pick<
  CallSeedRecord,
  'endedAt' | 'promptCacheTtlMs' | 'contextTokens' | 'contextWindowTokens'
> {
  const endedAt = createdAt?.getTime();
  const ttl = positiveNumber(fields.promptCacheTtlMs);
  const tokens = positiveNumber(fields.contextTokens);
  const window = positiveNumber(fields.contextWindowTokens);
  return {
    ...(endedAt !== undefined && Number.isFinite(endedAt) ? { endedAt } : {}),
    ...(ttl !== null ? { promptCacheTtlMs: ttl } : {}),
    ...(tokens !== null ? { contextTokens: tokens } : {}),
    ...(window !== null ? { contextWindowTokens: window } : {}),
  };
}

/**
 * Fold a run's `call_started` / `call_result` rows into what a later pass of
 * the run needs to carry its calls on — see `RunCallSeed`.
 *
 * Rows arrive in seq order, which the fold relies on twice: a `call_result`
 * lands after its `call_started` (so the session id is filed onto a record
 * that exists), and a continuation lands after the call it continued (so the
 * broker can walk the parent chain in list order). A `call_started` with no
 * result — a call the earlier daemon died in the middle of — is still a
 * record: it bumps the counter, so its id is never reissued, and it records no
 * session, so a continuation of it is refused as THREAD_UNAVAILABLE with the
 * honest sentence rather than resuming a conversation that never settled.
 *
 * The keys are read through `CallStartedPayload` / `CallResultPayload`, which
 * the broker's two writes satisfy, so a key renamed there fails to compile here.
 */
export function readCallSeed(rows: readonly CallSeedRow[]): RunCallSeed {
  const records = new Map<string, CallSeedRecord>();
  const messageFailures = new Map<string, MessageDeliveryFailure>();
  let callSeq = 0;
  for (const row of rows) {
    // The column holds JSON text; a fake or an in-memory row may hold the
    // object itself. Both read the same.
    const payload = parseJsonColumn(row.payload);
    if (typeof payload !== 'object' || payload === null) {
      continue;
    }
    const delivery = payload as Record<string, unknown>;
    if (
      row.kind === 'system' &&
      Array.isArray(delivery.messageDeliveryNotices)
    ) {
      for (const id of delivery.messageDeliveryNotices) {
        if (typeof id === 'string') {
          messageFailures.delete(id);
        }
      }
      continue;
    }
    if (row.kind === 'call_answer' && delivery.outcome === 'undelivered') {
      const deliveryId = readString(delivery.deliveryId);
      const callId = readString(delivery.callId);
      const callerMemberId = readString(delivery.callerNodeId);
      const calleeMemberId = readString(delivery.calleeNodeId);
      const message = readString(delivery.message);
      const reason = readString(delivery.reason);
      const conversation = readString(delivery.callerConversationId);
      if (
        deliveryId &&
        callId &&
        callerMemberId &&
        calleeMemberId &&
        message &&
        reason
      ) {
        messageFailures.set(deliveryId, {
          deliveryId,
          callId,
          callerNodeId: callerMemberId,
          calleeNodeId: calleeMemberId,
          message,
          reason,
          ...(conversation !== null
            ? { callerConversationId: conversation }
            : {}),
        });
      }
      continue;
    }
    const fields = payload as Partial<
      Record<keyof CallStartedPayload | keyof CallResultPayload, unknown>
    >;
    const callId = readString(fields.callId);
    const callerMemberId = readString(fields.callerNodeId);
    const callerConversationId = readString(fields.callerConversationId);
    const calleeMemberId = readString(fields.calleeNodeId);
    if (callId === null || callerMemberId === null || calleeMemberId === null) {
      continue;
    }
    const number = callNumber(callId);
    if (number !== null && number > callSeq) {
      callSeq = number;
    }
    if (row.kind === 'call_started') {
      records.set(callId, {
        callId,
        callerMemberId,
        ...(callerConversationId !== null ? { callerConversationId } : {}),
        calleeMemberId,
        thread: readString(fields.thread),
        sessionId: null,
      });
      continue;
    }
    if (row.kind === 'call_result') {
      const sessionId = readString(fields.sessionId);
      const preferredMember = isMemberNumber(fields.preferredMember)
        ? fields.preferredMember
        : fields.memberPinned === true && isMemberNumber(fields.member)
          ? fields.member
          : null;
      const member = isMemberNumber(fields.member)
        ? {
            member: fields.member,
            ...(preferredMember !== null ? { preferredMember } : {}),
          }
        : {};
      const cache = cacheFactsOf(fields, row.createdAt);
      const existing = records.get(callId);
      if (existing) {
        existing.sessionId = sessionId;
        Object.assign(existing, member, cache);
      } else {
        // A result whose start is missing (a transcript window, an older
        // build) is still a settled call — resumable when it says so.
        records.set(callId, {
          callId,
          callerMemberId,
          ...(callerConversationId !== null ? { callerConversationId } : {}),
          calleeMemberId,
          thread: null,
          sessionId,
          ...member,
          ...cache,
        });
      }
    }
  }
  return {
    callSeq,
    records: [...records.values()],
    ...(messageFailures.size > 0
      ? { messageFailures: [...messageFailures.values()] }
      : {}),
  };
}

/**
 * The CONVERSATION one call belongs to, rebuilt from the same records the
 * broker re-seeds from — or null for a call the records do not hold.
 *
 * A callee's kept process is keyed by its conversation (the first call of a
 * `thread:` lineage), not by the call, so anything that wants that process — a
 * context readout opened on one call's card — has to walk the lineage back
 * first. Walked exactly the way `CallBroker.registerRun` walks it, in record
 * order, so the two cannot disagree about which conversation a continuation
 * joined: a thread naming a call these records do not hold starts a
 * conversation of its own.
 *
 * `sessionId` is the NEWEST one any call of the conversation recorded, which is
 * the session a later continuation would resume.
 */
export function callConversation(
  records: readonly CallSeedRecord[],
  callId: string,
): CallConversation | null {
  const conversationOf = new Map<string, string>();
  for (const record of records) {
    conversationOf.set(
      record.callId,
      (record.thread === null ? null : conversationOf.get(record.thread)) ??
        record.callId,
    );
  }
  const conversationId = conversationOf.get(callId);
  const own = records.find((record) => record.callId === callId);
  if (conversationId === undefined || own === undefined) {
    return null;
  }
  const members = records.filter(
    (record) => conversationOf.get(record.callId) === conversationId,
  );
  const sessionIds = new Set<string>();
  let sessionId: string | null = null;
  for (const member of members) {
    sessionId = member.sessionId ?? sessionId;
    if (member.sessionId !== null) {
      sessionIds.add(member.sessionId);
    }
  }
  return {
    conversationId,
    calleeMemberId: own.calleeMemberId,
    callIds: members.map((member) => member.callId),
    sessionId,
    sessionIds: [...sessionIds],
  };
}

/**
 * The callee pool member a recorded CLI session belongs to, or null when no
 * call result named one — a callee with no pool, or a session no call ran.
 */
export function sessionMember(
  records: readonly CallSeedRecord[],
  sessionId: string,
): number | null {
  let member: number | null = null;
  for (const record of records) {
    if (record.sessionId === sessionId && record.member !== undefined) {
      member = record.member;
    }
  }
  return member;
}
