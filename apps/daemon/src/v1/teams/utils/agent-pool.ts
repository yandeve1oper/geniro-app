import {
  asRecord,
  asString,
  parseJsonColumn,
} from '../../agents/utils/json-util';
import { redactSecrets } from '../../diagnostics/utils/redact';
import type {
  CalleePoolAttempt,
  CalleeTurnOutcome,
  PoolStanding,
  TeamAgentPoolMember,
  TeamMember,
} from '../teams.types';

/**
 * A team member's POOL — the configurations a call to it may run under.
 *
 * Member 1 is the team member's own settings and members 2… are its `pool`,
 * so a team member with no pool is a pool of one and every reader below answers for it
 * without a special case.
 */

/** How many members `node` holds, its own configuration included. */
export function poolSize(node: TeamMember): number {
  return 1 + (node.pool?.length ?? 0);
}

/** Every member's CLI settings, member 1 first. */
export function poolMembersOf(node: TeamMember): TeamAgentPoolMember[] {
  return [memberSettingsOf(node), ...(node.pool ?? [])];
}

/**
 * The settings a member carries besides its `agent` that it REPLACES on the
 * team member — omitted means that setting's own default, never member 1's value.
 * `MemberFieldsAreComplete` below makes a field added to the member schema and
 * missing from both lists a compile error: a member would otherwise silently
 * inherit member 1's value for it.
 */
const MEMBER_FIELDS = [
  'model',
  'effort',
  'contextWindow',
  'modelParameters',
  'configDir',
  'autoCompactPercent',
  // The servers a member runs WITHOUT name servers of ITS profile, so member
  // 1's list is never a member 2's: omitted means none switched off.
  'mcpDisabled',
] as const satisfies readonly Exclude<keyof TeamAgentPoolMember, 'agent'>[];

/**
 * The settings a member OVERRIDES when it states them and otherwise takes
 * from the team member — those it requires, so "omitted" has no default of its
 * own to fall back to.
 */
const INHERITED_FIELDS = ['approval'] as const satisfies readonly Exclude<
  keyof TeamAgentPoolMember,
  'agent'
>[];

type MissingMemberField = Exclude<
  Exclude<keyof TeamAgentPoolMember, 'agent'>,
  (typeof MEMBER_FIELDS)[number] | (typeof INHERITED_FIELDS)[number]
>;
type MemberFieldsAreComplete = [MissingMemberField] extends [never]
  ? true
  : MissingMemberField;
const _memberFieldsAreComplete: MemberFieldsAreComplete = true;
void _memberFieldsAreComplete;

function memberSettingsOf(node: TeamMember): TeamAgentPoolMember {
  const settings: TeamAgentPoolMember = { agent: node.agent };
  for (const field of [...MEMBER_FIELDS, ...INHERITED_FIELDS]) {
    if (node[field] !== undefined) {
      Object.assign(settings, { [field]: node[field] });
    }
  }
  return settings;
}

/**
 * `node` running as member `member` (1-based), or null for a number the pool
 * does not have. The member's settings REPLACE the team member's whole — an omitted
 * model is that CLI's default, never member 1's — except the INHERITED ones,
 * which the team member's own value fills when the member states none. The view holds
 * no pool of its own, so nothing later can mistake it for the team member.
 */
export function poolMemberNode(
  node: TeamMember,
  member: number,
): TeamMember | null {
  if (!Number.isInteger(member) || member < 1 || member > poolSize(node)) {
    return null;
  }
  const shared: TeamMember = { ...node };
  delete shared.pool;
  for (const field of MEMBER_FIELDS) {
    delete shared[field];
  }
  const settings = poolMembersOf(node)[member - 1]!;
  return {
    ...shared,
    ...settings,
    approval: settings.approval ?? node.approval,
  };
}

/** The members to try, in `order`, resolved. */
export function poolAttempts(
  node: TeamMember,
  order: readonly number[],
): CalleePoolAttempt[] {
  return order.flatMap((member) => {
    const resolved = poolMemberNode(node, member);
    return resolved ? [{ member, node: resolved }] : [];
  });
}

/**
 * The groups {@link poolAttemptOrder} tries, best first: unspent members, then
 * those spent on an ordinary failure, whose cooldown is only a guess, then
 * those a limit spent — still tried, since a limit may have reset unseen.
 */
const STANDING_RANK: readonly (PoolStanding | null)[] = [
  null,
  'unavailable',
  'limit',
];

/**
 * The order a NEW conversation tries a pool's members in, from each member's
 * standing (index 0 is member 1): {@link STANDING_RANK}'s groups in turn, each
 * in pool order.
 */
export function poolAttemptOrder(
  standings: readonly (PoolStanding | null)[],
): number[] {
  const members = standings.map((_, i) => i + 1);
  return STANDING_RANK.flatMap((standing) =>
    members.filter((member) => standings[member - 1] === standing),
  );
}

/**
 * {@link poolAttemptOrder}'s order with the member a caller asked for ahead of
 * every member spent the same or worse: it starts the conversation unless it
 * is spent, and stays among the members to try either way.
 */
export function preferredAttemptOrder(
  order: readonly number[],
  standings: readonly (PoolStanding | null)[],
  preferred: number | null,
): number[] {
  if (preferred === null || !order.includes(preferred)) {
    return [...order];
  }
  const rest = order.filter((member) => member !== preferred);
  const rank = (member: number): number =>
    STANDING_RANK.indexOf(standings[member - 1] ?? null);
  const at = rest.findIndex((member) => rank(member) >= rank(preferred));
  rest.splice(at === -1 ? rest.length : at, 0, preferred);
  return rest;
}

/**
 * Whether `member` comes before `than` in the pool's priority: the member a
 * caller asked for first, then pool order.
 */
function ranksBefore(
  member: number,
  than: number,
  preferred: number | null,
): boolean {
  if (member === than) {
    return false;
  }
  if (member === preferred) {
    return true;
  }
  return than !== preferred && member < than;
}

/**
 * The member a pooled conversation's next turn starts on — a team member's own, or a
 * call thread being continued. Its session stays with the member it was
 * opened on, so a conversation that has one moves only when it gains
 * something: off a member a limit spent (unless every other member is limited
 * too), or back to an earlier member PROVEN to work again (`proven`: its
 * account answered, or the reset its CLI named has passed — never a guessed
 * cooldown lapsing, which would only meet the same limit again) — never while
 * the member it is on still runs work of its own, which leaving would stop. A
 * member spent on an ordinary failure keeps the conversation it has.
 * "Earlier" is pool order, with the member a caller asked for (`preferred`,
 * whose `order` is {@link preferredAttemptOrder}'s) ahead of every other.
 */
export function conversationStartMember(input: {
  standings: readonly (PoolStanding | null)[];
  proven: readonly boolean[];
  order: readonly number[];
  held: number;
  hasSession: boolean;
  holdsWork: boolean;
  preferred?: number | null;
}): number {
  const { standings, proven, order, held, hasSession, holdsWork } = input;
  const first = order[0]!;
  if (!hasSession) {
    return first;
  }
  if (standings[held - 1] === 'limit') {
    return standings[first - 1] === 'limit' ? held : first;
  }
  return ranksBefore(first, held, input.preferred ?? null) &&
    proven[first - 1] === true &&
    !holdsWork
    ? first
    : held;
}

/**
 * Whether a failed attempt may be handed to the next member.
 *
 * Two kinds of failure qualify. One another ACCOUNT can get past — a spent
 * usage window, a lapsed sign-in — whatever the attempt had done, since the
 * caller asked for the work and this member can no longer do it. And any
 * failure before the attempt called a single tool: it changed nothing, so
 * running the call again elsewhere duplicates nothing. That second arm is
 * what covers a CLI whose limit wording no adapter recognises yet. A failure
 * mid-work is NOT handed on — running half-done work again from the top on
 * another member could repeat whatever it already did.
 */
export function fallsThroughPool(
  outcome: CalleeTurnOutcome,
  madeToolCalls: boolean,
): boolean {
  if (outcome.status !== 'failed') {
    return false;
  }
  return (
    outcome.failureClass === 'rate_limited' ||
    outcome.failureClass === 'auth_expired' ||
    !madeToolCalls
  );
}

/**
 * The transcript sentence for a call handed from one member to the next,
 * filed in the call's block so the reader sees why a different account
 * answered — and, when the caller asked for the member it leaves, that the
 * conversation goes back to it.
 */
export function poolHandOffNotice(
  calleeName: string,
  from: number,
  to: CalleePoolAttempt,
  outcome: CalleeTurnOutcome,
  scope: 'call' | 'turn' = 'call',
  preferred: number | null = null,
): string {
  const why =
    outcome.failureClass === 'rate_limited'
      ? `hit a usage limit${outcome.resetsAt !== null ? ` (resets ${outcome.resetsAt})` : ''}`
      : outcome.failureClass === 'auth_expired'
        ? 'is signed out'
        : 'failed before doing any work';
  const back =
    from === preferred
      ? ` Later turns move back to member ${from}, the member asked for, once it is available again.`
      : '';
  return `${calleeName}: pool member ${from} ${why} — handing the ${scope} to ${namedMember(to)}.${back}`;
}

/**
 * The transcript sentence for a turn that starts on another pool member than
 * the one its conversation last ran on: an earlier member is available again,
 * or the one it ran on is not.
 */
export function poolMoveNotice(
  nodeName: string,
  from: number,
  to: CalleePoolAttempt,
  preferred: number | null = null,
): string {
  return ranksBefore(to.member, from, preferred)
    ? `${nodeName}: pool ${namedMember(to)} is available again — moving the conversation back to it from member ${from}.`
    : `${nodeName}: pool member ${from} is unavailable — starting the turn on ${namedMember(to)}.`;
}

/**
 * The transcript sentence for the user picking the pool member a member's own
 * conversation runs on: `moved` when the conversation leaves another member,
 * otherwise the member it is on is only pinned.
 */
export function poolSwitchNotice(
  nodeName: string,
  to: CalleePoolAttempt,
  moved: boolean,
): string {
  return moved
    ? `${nodeName}: switched to pool ${namedMember(to)} by the user — the conversation continues there in a new session.`
    : `${nodeName}: pinned to pool ${namedMember(to)} by the user.`;
}

/**
 * The `system` row recording which pool member a member's own conversation
 * now runs on. `pinnedByUser` is written only when true: a hand-off without it
 * is what releases a pin (`readNodePoolPins`).
 */
export function nodePoolHandOffRow(input: {
  member: number;
  fromMember: number;
  previousSessionId: string | null;
  message: string;
  pinnedByUser: boolean;
}): Record<string, unknown> {
  return {
    severity: 'info',
    member: input.member,
    nodePoolHandOff: true,
    fromMember: input.fromMember,
    previousSessionId: input.previousSessionId,
    ...(input.pinnedByUser ? { pinnedByUser: true } : {}),
    message: input.message,
  };
}

/** `member 2 (codex · gpt-5.5)`: the member a reader is told now answers. */
function namedMember({ member, node }: CalleePoolAttempt): string {
  return `member ${member} (${poolMemberLabel(node)})`;
}

/**
 * The task a handed-on call opens its next member with: the call's own
 * message, then everything said into the call while the failed attempt ran —
 * the next member starts a conversation of its own and heard none of it.
 */
export function poolHandOffPrompt(
  message: string,
  sentSince: readonly string[],
): string {
  if (sentSince.length === 0) {
    return message;
  }
  return [
    message,
    '',
    'Messages sent about this task after it was handed out, in order:',
    ...sentSince.map((text) => `- ${text}`),
  ].join('\n');
}

/** Carry a team member's work into a fresh account without reusing its CLI session. */
export function nodePoolHandOffPrompt(
  prompt: string,
  memberId: string,
  rows: readonly {
    memberId: string | null;
    kind: string;
    role: string | null;
    payload: string;
  }[],
): string {
  return poolTranscriptPrompt(
    prompt,
    rows.filter(
      (row) =>
        row.memberId === memberId ||
        (row.memberId === null && row.role === 'user'),
    ),
  );
}

/** Rows are scoped to this call's conversation by the caller, including its original brief. */
export function callPoolHandOffPrompt(
  prompt: string,
  rows: readonly { kind: string; role: string | null; payload: string }[],
): string {
  const firstAsk = rows.find((row) => row.kind === 'call_started');
  const original = asString(
    asRecord(parseJsonColumn(firstAsk?.payload))?.message,
  );
  return poolTranscriptPrompt(
    original === null
      ? prompt
      : `${prompt}\n\nOriginal task:\n${redactSecrets(original).slice(0, 8_000)}`,
    rows,
  );
}

function poolTranscriptPrompt(
  prompt: string,
  rows: readonly { kind: string; role: string | null; payload: string }[],
): string {
  const history = rows
    .filter((row) =>
      [
        'message',
        'tool_call',
        'tool_result',
        'call_started',
        'call_result',
      ].includes(row.kind),
    )
    .map((row) => {
      // Masked before the cut, which could otherwise leave part of a secret
      // showing — the next member may be another vendor's model.
      const masked = redactSecrets(row.payload);
      const payload =
        masked.length > 8_000
          ? `${masked.slice(0, 4_000)}\n[transcript item truncated]\n${masked.slice(-4_000)}`
          : masked;
      return `${row.kind}${row.role ? ` (${row.role})` : ''}: ${payload}`;
    });
  // Large file reads must not fill the backup's first prompt. Carry the
  // newest work within a fixed budget, leaving room for the task and role.
  const recent: string[] = [];
  let size = 0;
  for (const line of history.reverse()) {
    if (size + line.length > 48_000) {
      break;
    }
    recent.push(line);
    size += line.length;
  }
  return [
    prompt,
    '',
    'Continue this team after another pool member became unavailable. Use the recent transcript below as context. Preserve completed work; do not repeat completed tool calls. Existing call IDs still belong to you: collect or message those calls instead of dispatching them again.',
    ...recent.reverse(),
  ].join('\n');
}

/**
 * One member as a caller is told it: its CLI, then whatever tells it apart —
 * model, effort, and whether it runs under a profile of its own (another
 * account). The profile is not NAMED: this line goes to the caller's model
 * provider, and the member number already tells two members apart.
 */
export function poolMemberLabel(member: TeamAgentPoolMember): string {
  return [
    member.agent,
    member.model,
    member.effort !== undefined ? `effort ${member.effort}` : undefined,
    member.configDir !== undefined ? 'separate profile' : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
}
