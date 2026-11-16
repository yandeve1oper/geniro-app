import type { TurnMember } from '../../agents/chat.types';
import { asRecord, asString } from '../../agents/utils/json-util';
import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import { readTeamSnapshot } from '../../teams/utils/team-snapshot';
import type { UsageEventInput } from '../stats.types';

/** The run columns {@link usageDimensions} reads. */
export type UsageDimensionRun = Pick<
  Run,
  'agentKind' | 'model' | 'cwd' | 'teamId' | 'teamSnapshot' | 'analysisPurpose'
>;

/** The denormalized half of a ledger row — what the turn ran AS. */
export type UsageDimensions = Pick<
  UsageEventInput,
  'agentKind' | 'model' | 'cwd' | 'teamName' | 'purpose'
>;

/**
 * What a turn ran as, read off the run and (for a team turn) its member.
 *
 * Shared by the live recorder and the boot backfill, which must produce
 * identical rows for the same turn — the backfill's whole job is to fill holes
 * the recorder left, and a row that disagreed with its live twin would make the
 * breakdowns depend on which writer happened to get there first. They had
 * already grown two copies of this expression; a fourth dimension is what makes
 * that a question of when, not whether, they diverge.
 *
 * Copied at write time because every row it is read from is destroyed with the
 * run: a chat delete hard-deletes the run, and a join added later would find
 * nothing.
 *
 * A team member's own `node_state` wins over the run's fields where it has them:
 * a team run names no single agent (its `agentKind` is null) and each member
 * names its own, so reading the run alone would attribute every member's spend to
 * nothing. `cwd` only ever lives on the run — `node_state` stamps none — so it
 * comes from there for both shapes.
 *
 * The MODEL is the one the CLI REPORTED running the turn on, when the caller
 * has it ({@link reportedModelOf}), and the one the run or member ASKED for only
 * otherwise. The setting is null whenever a run leaves the choice to the CLI,
 * which filed 18% of a real ledger's spend under a "CLI default" row naming
 * no model at all — REPORTED as "we don't have such model". It is also an
 * alias (`opus`) where the report is the model itself (`claude-opus-5-5`), so
 * preferring the report keeps one model on one row.
 */
export function usageDimensions(
  run: UsageDimensionRun | null,
  state: NodeState | null,
  reportedModel: string | null = null,
  /** The pool member the turn ran on, when its row names one (`turnMemberOf`). */
  member: TurnMember | null = null,
): UsageDimensions {
  return forTurn(
    {
      agentKind: state?.agentKind ?? run?.agentKind ?? null,
      model: state?.model ?? run?.model ?? null,
      cwd: run?.cwd ?? null,
      teamName: teamNameOf(run),
      purpose: run?.analysisPurpose === 'lessons' ? 'lessons' : null,
    },
    reportedModel,
    member,
  );
}

/**
 * One turn's dimensions over its run's or member's: the model its CLI reported,
 * and for a turn another AGENT-POOL member ran, that member's CLI and its own
 * configured model — never member 1's, which the member's state row carries.
 */
export function forTurn(
  dimensions: UsageDimensions,
  reportedModel: string | null,
  member: TurnMember | null,
): UsageDimensions {
  return {
    ...dimensions,
    agentKind: member?.agentKind ?? dimensions.agentKind,
    model: reportedModel ?? (member === null ? dimensions.model : member.model),
  };
}

/**
 * Which team this turn belongs to, or null for a single-agent chat.
 *
 * Gated on `teamId`: a chat is null here whatever else it carries, since a
 * chat filed in the team breakdown is the one thing that breakdown must not
 * contain.
 *
 * The NAME comes from the run's own copy of the team (`Run.teamSnapshot`)
 * and never from the run's TITLE. It was the title, back when the executor
 * stamped every team run with its team's name; since team runs are
 * named after their CONVERSATION like chats are, the title is what the task was
 * about, so one team's spend scattered into a row per conversation — and
 * into its slug for the turns before the name landed. The snapshot is taken at
 * run start, so it names the team as it was when the run ran, and it is
 * read through the teams module's own reader rather than a second parser of the
 * column. The slug is the fallback for a run with no readable snapshot.
 *
 * The consequence worth knowing: renaming a team splits its history at the
 * rename, since each row keeps the name that was true when the turn ran. That
 * is the honest reading — relabelling past spend would restate history the
 * ledger deliberately keeps. For the same reason nothing re-reads rows already
 * written: those recorded while the title was the source keep what they say.
 */
function teamNameOf(run: UsageDimensionRun | null): string | null {
  if (!run || run.teamId === null) {
    return null;
  }
  return readTeamSnapshot(run.teamSnapshot)?.name ?? run.teamId;
}

/**
 * The model a finished turn's payload says the CLI RAN on — `usage.contextModel`,
 * the model the turn's context window was measured for (claude's `modelUsage`,
 * an ACP agent's own current model) — or null when it names none.
 */
export function reportedModelOf(payload: unknown): string | null {
  const model = asString(
    asRecord(asRecord(payload)?.['usage'])?.['contextModel'],
  );
  return model === null || model.trim() === '' ? null : model;
}
