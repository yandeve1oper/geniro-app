import { parseJsonColumn } from '../../agents/utils/json-util';
import { readSpendBucket } from '../../agents/utils/polled-spend-ledger';
import { snapshotPoolKinds } from '../../agents/utils/snapshot-config-dirs';
import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import type { AgentKind } from '../../runs/runs.types';
import type { UsageEvent } from '../entity/usage-event.entity';
import { POLLED_SPEND_SEQ, type UsageEventInput } from '../stats.types';
import { usageDimensions } from './usage-dimensions';

/**
 * Every run column {@link polledSpendRows} reads — the projection a sweep over
 * priced runs loads. Typed through {@link PolledSpendRun}, so reading one more
 * column without listing it here does not compile.
 */
export const POLLED_SPEND_RUN_FIELDS = [
  'id',
  'polledCostCents',
  'updatedAt',
  'agentKind',
  'model',
  'cwd',
  'teamId',
  'teamSnapshot',
  'analysisPurpose',
  'polledSpendBuckets',
] as const satisfies readonly (keyof Run)[];

export type PolledSpendRun = Pick<
  Run,
  (typeof POLLED_SPEND_RUN_FIELDS)[number]
>;

/**
 * A run's POLLED spend as the ledger rows that carry it — one per local
 * calendar day and model the account billed it under — or none when the poll
 * has priced nothing on this run.
 *
 * A polled-spend CLI (`AdapterConfig.usage.polledSpend` — cursor today) prices
 * nothing on its own wire, so its money reaches this app only through an
 * account poll that writes onto `Run.polledCostCents`, split by day and model
 * in `Run.polledSpendBuckets`. Those columns are destroyed with the run, so
 * Stats reading them straight off the run row would take a deleted chat's whole
 * bill out of every lifetime figure, which is exactly the loss this ledger
 * exists to prevent for turns. Copying them here is what lets them outlive it.
 *
 * Shared by the live recorder and the boot sweep, on `usageDimensions`' rule:
 * the two must write identical rows for the same run, or the figure would
 * depend on which of them got there last.
 *
 * - One row per bucket, so the Stats page draws the bill on the DAYS it was
 *   spent and under the MODELS that spent it. Before, one row per run placed a
 *   month of a team's cursor bill on its last day under no model — the
 *   "By model" list's largest entry was a blank. Rows are keyed
 *   `(runId, POLLED_SPEND_SEQ - i)` over the buckets in key order, and the
 *   whole set is replaced on every write (`UsageEventDao.recordPolledSpend`).
 * - A run with no buckets (priced before they were kept) keeps ONE row on its
 *   last activity, the approximation that row always was.
 * - A row the account named no model for is filed under `reportedModel`.
 * - `agentKind` is the CLI whose money this is, resolved by the caller
 *   (`polledAgentKind`) and never read off the run alone: a TEAM run — where
 *   a polled member's spend comes from — has no agent of its own.
 * - Every figure but the cost is null — the poll measures money and nothing
 *   else, and null means NOT MEASURED here as everywhere in this table.
 * - A team run's bill is split across the members the poll credited
 *   (`NodeState.polledCostCents`), each bucket in proportion to each member's
 *   share, so every row names its member and that member's billed CLI.
 */
export function polledSpendRows(
  run: PolledSpendRun,
  agentKind: AgentKind | null,
  /**
   * The model this run's own turns of that CLI last REPORTED running on
   * (`UsageEventDao.latestReportedModel`) — what a row is filed under when the
   * account named no model for it, since a team run names none of its own.
   */
  reportedModel: string | null = null,
  shares: readonly PolledShare[] = [],
  pollsSpend: (kind: AgentKind) => boolean = () => false,
): UsageEventInput[] {
  const cents = run.polledCostCents;
  if (cents === null || !(cents > 0)) {
    return [];
  }
  const buckets = readBuckets(run.polledSpendBuckets);
  const entries: { occurredAt: Date; model: string | null; cents: number }[] =
    buckets.length === 0
      ? [{ occurredAt: run.updatedAt, model: null, cents }]
      : buckets.map(([bucket, amount]) => {
          const { day, model } = readSpendBucket(bucket);
          return {
            occurredAt: localNoon(day),
            model: model === '' ? null : model,
            cents: amount,
          };
        });
  const poolKinds = snapshotPoolKinds(run.teamSnapshot ?? null);
  const credited = shares.filter((share) => (share.polledCostCents ?? 0) > 0);
  const creditedCents = credited.reduce(
    (total, share) => total + (share.polledCostCents ?? 0),
    0,
  );
  const payers: {
    memberId: string | null;
    agentKind: AgentKind | null;
    fraction: number;
  }[] =
    run.agentKind !== null || creditedCents <= 0
      ? [{ memberId: null, agentKind, fraction: 1 }]
      : [...credited]
          .sort((a, b) => a.memberId.localeCompare(b.memberId))
          .map((share) => ({
            memberId: share.memberId,
            agentKind: billedKindOf(share, poolKinds, pollsSpend),
            fraction: (share.polledCostCents ?? 0) / creditedCents,
          }));
  const charges = entries.flatMap((entry) =>
    payers.map((payer) => ({ entry, payer })),
  );
  return charges.map(({ entry, payer }, index) => ({
    runId: run.id,
    memberId: payer.memberId,
    seq: POLLED_SPEND_SEQ - index,
    occurredAt: entry.occurredAt,
    ...usageDimensions(
      run,
      null,
      entry.model ?? (payer.agentKind === agentKind ? reportedModel : null),
    ),
    agentKind: payer.agentKind,
    costUsd: (entry.cents * payer.fraction) / 100,
    // The vendor's own charge, never priced here.
    estimatedCostUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    thinkingTokens: null,
    durationMs: null,
    apiMs: null,
    ttftMs: null,
    timeToRequestMs: null,
    numTurns: null,
  }));
}

/** The run's buckets in key order, dropping any entry that is not a figure. */
function readBuckets(raw: string | null): [string, number][] {
  const value = parseJsonColumn(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => {
      const amount = entry[1];
      return (
        typeof amount === 'number' && Number.isFinite(amount) && amount > 0
      );
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

/** Noon of a local `YYYY-MM-DD`, so the row lands on that day in any bucketing. */
function localNoon(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1, 12);
}

/**
 * Whether a ledger row is a run's polled spend rather than a finished turn.
 *
 * Every reader that COUNTS turns must ask this first: the polled row is money
 * with no turn behind it, so folding it as one would add a phantom turn and
 * price it — see the polled-spend fold in `StatsService`.
 */
export function isPolledSpend(event: Pick<UsageEvent, 'seq'>): boolean {
  return event.seq <= POLLED_SPEND_SEQ;
}

/** The unpriced-turn tally key for one run and one agent. */
export function turnKey(runId: string, agentKind: string | null): string {
  return `${runId}\u0000${agentKind ?? ''}`;
}

/**
 * Count a finished turn nobody priced (`costUsd === null`) — the turns a POLLED price is
 * spread over. Keyed by agent, so a team's polled money is credited to each CLI with
 * that CLI's own turns.
 */
export function tallyUnpricedTurn(
  tally: Map<string, number>,
  event: Pick<UsageEvent, 'runId' | 'agentKind' | 'costUsd'>,
): void {
  if (event.costUsd === null) {
    const key = turnKey(event.runId, event.agentKind);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
}

/** One run's unpriced turns that belong to a CLI whose money is polled. */
export function polledTurns(
  unpricedTurns: ReadonlyMap<string, number>,
  polledKinds: readonly string[],
  runId: string,
): number {
  let turns = 0;
  for (const kind of polledKinds) {
    turns += unpricedTurns.get(turnKey(runId, kind)) ?? 0;
  }
  return turns;
}

/**
 * The unpriced turns each polled row of a fold is spread over.
 *
 * A run's bill is several rows (one per day and model) and its unpriced turns are what
 * that WHOLE bill is spread over, so they are credited with the run's first row alone —
 * otherwise a cost per turn would divide one bill by the same turns once per row. Only
 * turns of a CLI whose money is polled count: an unpriced turn of one that is not stays
 * unmeasured.
 */
export class PolledTurnCredit {
  private readonly credited = new Set<string>();

  constructor(
    private readonly unpricedTurns: ReadonlyMap<string, number>,
    private readonly polledKinds: readonly string[],
  ) {}

  /**
   * `turns` for the run as a whole, `agentTurns` for the one CLI the row names. Call once
   * per row.
   */
  next(row: Pick<UsageEvent, 'runId' | 'agentKind'>): {
    turns: number;
    agentTurns: number;
  } {
    if (this.credited.has(row.runId)) {
      return { turns: 0, agentTurns: 0 };
    }
    this.credited.add(row.runId);
    return {
      turns: polledTurns(this.unpricedTurns, this.polledKinds, row.runId),
      agentTurns:
        this.unpricedTurns.get(turnKey(row.runId, row.agentKind)) ?? 0,
    };
  }
}

/**
 * The CLI a run's polled money belongs to. A chat's is its own agent's. A
 * team run names no agent, so its bill is the CLI of the member holding the
 * largest polled share — the per-member figures the poll records beside the run's
 * total — or null when no member carries one.
 *
 * A POOLED member's stamp is pool member 1's, so where that CLI polls nothing the
 * bill is its polling pool member's, read off the run's snapshot (`pollsSpend`).
 */
export function polledAgentKind(
  run: Pick<Run, 'agentKind' | 'teamSnapshot'>,
  shares: readonly PolledShare[],
  pollsSpend: (kind: AgentKind) => boolean = () => false,
): AgentKind | null {
  if (run.agentKind !== null) {
    return run.agentKind;
  }
  const poolKinds = snapshotPoolKinds(run.teamSnapshot ?? null);
  let kind: AgentKind | null = null;
  let largest = 0;
  for (const share of shares) {
    const cents = share.polledCostCents ?? 0;
    const billed = billedKindOf(share, poolKinds, pollsSpend);
    if (billed !== null && cents > largest) {
      kind = billed;
      largest = cents;
    }
  }
  return kind;
}

/** One member's polled share of a team run's bill, as the poll recorded it. */
export type PolledShare = Pick<
  NodeState,
  'memberId' | 'agentKind' | 'polledCostCents'
>;

/** The CLI a member's polled money belongs to: its own, else a polling pool member's. */
function billedKindOf(
  share: PolledShare,
  poolKinds: ReturnType<typeof snapshotPoolKinds>,
  pollsSpend: (kind: AgentKind) => boolean,
): AgentKind | null {
  return share.agentKind !== null && pollsSpend(share.agentKind)
    ? share.agentKind
    : (poolKinds.get(share.memberId)?.find(pollsSpend) ?? share.agentKind);
}
