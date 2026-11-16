import {
  asArray,
  asNumber,
  asRecord,
  asString,
} from '../../../utils/json-util';
import {
  type AgentPlanLimits,
  type AgentPlanWindow,
  NO_PLAN_LIMITS,
} from '../../adapter.types';
import { CLAUDE_PLAN_LIMITS_SUBTYPE } from '../claude.const';

/**
 * Reading and writing the `get_usage` control dialogue — what the account
 * behind this chat is allowed, and how much of it is spent.
 *
 * Pure, like its `get_context_usage` and `mcp_status` siblings and for the same
 * reason: the session primitive that carries it (`CliSession.ask`) knows no
 * CLI's vocabulary, so everything about this one lives here and can be
 * exercised without a process. The probe evidence, the reply's shape and the
 * expiry warning are all at {@link CLAUDE_PLAN_LIMITS_SUBTYPE} in
 * `claude.const.ts`.
 */

/**
 * The `get_usage` request line, newline-terminated for the dialogue — ONE line
 * for both readers of the reply, the plan limits below and the running cost
 * further down, and always with the transcript scan switched off.
 *
 * Without `skip_behaviors` the CLI answers only after reading every transcript
 * its profile touched in the last seven days, for a `behaviors` block neither
 * reader looks at. Read out of the 2.1.284 binary: the reply is
 * `Promise.all([<the usage endpoint>, <that scan>])`, so the scan alone sets
 * how long the answer takes. On a profile holding 1.2GB of such transcripts it
 * cost 1.1–2.9s against 1ms for a cached endpoint reading, idle — and it is
 * also what made the plan half of the readout fail OFTEN, where the context
 * half beside it answered: a busy process mid-turn, beside other agents writing
 * those same transcripts, ran it past `CLAUDE_PLAN_LIMITS_TIMEOUT_MS`, and
 * the "taken again while this stays open" retry only started the scan over.
 * The `rate_limits` it returns are the same either way (measured side by side
 * on one process).
 */
export function usageRequestLine(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: CLAUDE_PLAN_LIMITS_SUBTYPE, skip_behaviors: true },
  })}\n`;
}

/**
 * What to call each window kind the CLI reports.
 *
 * The CLI's own dialog labels these "Current session" and "Current week (all
 * models)"; the parenthetical is dropped because the scoped row beside it
 * already names its own model, so the qualifier only reads as a warning on the
 * one row that needs none.
 *
 * A kind that is NOT here is dropped by {@link readWindow} — never labelled
 * from its key. `weekly_scoped` reaches a human as a phrase nobody wrote for
 * them, and a mislabelled limit is worse than a missing one.
 */
const WINDOW_LABELS: Readonly<Record<string, string>> = {
  session: 'Current session',
  weekly_all: 'Current week',
};

/**
 * The label for a MODEL-SCOPED window, whose name comes out of the payload
 * rather than out of this map — the server chose it ("Fable"), and it changes
 * with the vendor's line-up rather than with this app.
 */
function scopedLabel(name: unknown): string | null {
  const text = asString(name);
  return text === null || text.trim() === '' ? null : `Current week · ${text}`;
}

/** One `limits[]` row projected, or null when it cannot be named or measured. */
function readWindow(row: unknown): AgentPlanWindow | null {
  const limit = asRecord(row);
  if (!limit) {
    return null;
  }
  const kind = asString(limit.kind);
  if (kind === null) {
    return null;
  }
  const label =
    WINDOW_LABELS[kind] ??
    scopedLabel(asRecord(asRecord(limit.scope)?.model)?.display_name);
  if (label === null) {
    return null;
  }
  const percent = asNumber(limit.percent);
  // A window with no percentage is not a reading. Defaulting it to 0 would
  // render "0% used" — the single most reassuring thing the panel can say —
  // about a limit whose state is unknown.
  if (percent === null || !Number.isFinite(percent)) {
    return null;
  }
  return {
    key: kind,
    label,
    // Clamped, because the number drives a bar: the CLI reports 0-100 and a
    // stray 103 would draw past its track rather than full.
    percent: Math.max(0, Math.min(100, percent)),
    resetsAt: asString(limit.resets_at),
  };
}

/**
 * One window from the NAMED map, projected — or null when the map holds no
 * reading for it.
 *
 * `utilization` is on the same 0-100 scale as a `limits[]` row's `percent`
 * (measured side by side on one reply: 34 and 34), and `null` is the CLI's own
 * "no reading", which its `/usage` dialog skips rather than drawing as 0%.
 */
function namedWindow(
  key: string,
  label: string | null,
  window: unknown,
): AgentPlanWindow | null {
  const reading = asRecord(window);
  const percent = asNumber(reading?.utilization);
  if (label === null || percent === null || !Number.isFinite(percent)) {
    return null;
  }
  return {
    key,
    label,
    percent: Math.max(0, Math.min(100, percent)),
    resetsAt: asString(reading?.resets_at),
  };
}

/**
 * The windows read off the NAMED map, the way the CLI's own `/usage` dialog
 * reads them — because the CLI does not always send `limits[]`.
 *
 * Read out of the 2.1.284 binary: its `get_usage` handler STRIPS `limits` from
 * the reply whenever its usage data is "seeded" (`if (u !== null &&
 * a?.status === "seeded") { let {limits, ...v} = u; m = v }`), while the named
 * map stays. Measured on one profile within minutes: four replies in a row with
 * no `limits` key at all, then replies carrying it. And the `/usage` dialog
 * never reads `limits[]` — it draws "Current session" from `five_hour`,
 * "Current week (all models)" from `seven_day`, "Current week (Sonnet only)"
 * from `seven_day_sonnet` (on `max`, `team` or an unnamed plan) and one row per
 * `model_scoped[]` entry. Reading `limits[]` alone therefore left a seeded
 * reply with no windows, which the reader used to treat as "not my reply": the
 * readout then waited out its whole deadline and said the agent "did not
 * answer the usage request in time" about an agent that had answered at once.
 */
function namedWindows(
  limits: Readonly<Record<string, unknown>>,
  plan: string | null,
): AgentPlanWindow[] {
  const showsSonnet = plan === null || plan === 'max' || plan === 'team';
  return [
    namedWindow('session', WINDOW_LABELS.session ?? null, limits.five_hour),
    namedWindow(
      'weekly_all',
      WINDOW_LABELS.weekly_all ?? null,
      limits.seven_day,
    ),
    ...(showsSonnet
      ? [
          namedWindow(
            'weekly_scoped',
            scopedLabel('Sonnet'),
            limits.seven_day_sonnet,
          ),
        ]
      : []),
    ...asArray(limits.model_scoped).map((row) =>
      namedWindow(
        'weekly_scoped',
        scopedLabel(asRecord(row)?.display_name),
        row,
      ),
    ),
  ].filter((window): window is AgentPlanWindow => window !== null);
}

/**
 * What one parsed stdout line says about the question `requestId` is waiting
 * on: the projected plan limits; {@link NO_PLAN_LIMITS} when the CLI answered
 * and the account has no windows to report; or null for "not my reply, keep
 * waiting".
 *
 * A REFUSAL reads as null — same rule as the context reader: one question, one
 * answer, and a refusal and a timeout leave the caller with the same readout.
 * An answer with no windows does NOT: an account on an API key reports
 * `rate_limits_available: false` with nothing under it, and reading that as
 * "not mine" held the readout for the whole deadline before calling it a
 * timeout.
 */
export function readPlanLimitsReply(
  obj: unknown,
  requestId: string,
): AgentPlanLimits | typeof NO_PLAN_LIMITS | null {
  const line = asRecord(obj);
  if (!line || line.type !== 'control_response') {
    return null;
  }
  const envelope = asRecord(line.response);
  if (!envelope || envelope.request_id !== requestId) {
    return null;
  }
  if (envelope.subtype !== 'success') {
    return null;
  }
  const body = asRecord(envelope.response);
  if (!body) {
    return null;
  }
  const plan = asString(body.subscription_type);
  const limits = asRecord(body.rate_limits);
  // `limits[]` first: it carries the server's own kinds and scoped labels, in
  // the server's order. The named map is the fallback the CLI itself uses.
  const listed = asArray(limits?.limits)
    .map(readWindow)
    .filter((window): window is AgentPlanWindow => window !== null);
  const windows =
    listed.length > 0 || !limits ? listed : namedWindows(limits, plan);
  // Rendering an empty list would say "no limits" in the shape of a reading;
  // the caller has a sentence for an account that reports none.
  if (windows.length === 0) {
    return NO_PLAN_LIMITS;
  }
  // The CLI strips `limits` exactly when its reading is SEEDED — the usage
  // endpoint did not answer (read out of 2.1.284: `if (u !== null && a?.status
  // === "seeded") { let {limits, ...v} = u; m = v }`), so the figures are its
  // own last request's rate-limit headers or a persisted snapshot. The array's
  // absence is therefore the one thing in the reply that says so.
  return { plan, windows, estimated: !Array.isArray(limits?.limits) };
}

/**
 * {@link readPlanLimitsReply} over a one-shot process's whole stdout: the
 * reply to `requestId` on any of its lines, or null while none has arrived.
 */
export function readPlanLimitsStdout(
  stdout: string,
  requestId: string,
): AgentPlanLimits | typeof NO_PLAN_LIMITS | null {
  for (const raw of stdout.split('\n')) {
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const reading = readPlanLimitsReply(line, requestId);
    if (reading !== null) {
      return reading;
    }
  }
  return null;
}

/**
 * What one parsed stdout line says about the cost question `requestId` asked:
 * the process's running total in dollars, `'refused'` when the CLI answered
 * and the answer cannot be used, or null for "not my reply, keep waiting".
 *
 * Unlike the plan-limits reader, a refusal is kept apart from "not mine": the
 * caller asks again every few seconds, and a CLI that has said it cannot
 * answer should stop being asked rather than refuse on every request of a
 * long turn. A success whose shape no longer carries the figure reads as a
 * refusal for the same reason — asking again would get the same shape back.
 */
export function readSessionCostReply(
  obj: unknown,
  requestId: string,
): number | 'refused' | null {
  const line = asRecord(obj);
  if (!line || line.type !== 'control_response') {
    return null;
  }
  const envelope = asRecord(line.response);
  if (!envelope || envelope.request_id !== requestId) {
    return null;
  }
  if (envelope.subtype !== 'success') {
    return 'refused';
  }
  const total = asNumber(
    asRecord(asRecord(envelope.response)?.session)?.total_cost_usd,
  );
  return total === null || !Number.isFinite(total) || total < 0
    ? 'refused'
    : total;
}
