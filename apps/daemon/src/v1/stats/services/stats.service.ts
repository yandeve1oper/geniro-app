import { resolve, sep } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import type { ChatTotalsWire } from '../../agents/chat.types';
import { GoalDao } from '../../agents/dao/goal.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { isWithinDirectory } from '../../agents/utils/path-within';
import { pollsSpendFor } from '../../agents/utils/polled-spend';
import {
  addPolledSpend,
  addUsage,
  emptyTotals,
} from '../../agents/utils/usage-figures';
import { ProjectRootsService } from '../../projects/services/project-roots.service';
import type { Run } from '../../runs/entity/run.entity';
import { LineBaselineDao } from '../dao/line-baseline.dao';
import { MetricLedgerDao } from '../dao/metric-ledger.dao';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import type { UsageEvent } from '../entity/usage-event.entity';
import type {
  LineBaselineRequest,
  LineBaselineWire,
  LineSnapshotInput,
  ThreadMetricsWire,
  UsageGroupWire,
  UsageStatsWire,
} from '../stats.types';
import { ActivityFold, linesIncrements } from '../utils/activity-fold';
import { folderKeyOf, lineKeyOf } from '../utils/line-keys';
import {
  isPolledSpend,
  PolledTurnCredit,
  tallyUnpricedTurn,
} from '../utils/polled-spend';
import { foldThreadMetrics } from '../utils/thread-metrics-fold';
import { eachLocalDay, localDateKey } from '../utils/usage-fold';
import { UsageEventBus } from './usage-events.bus';

/** What a range resolves to when the caller names neither end and the ledger is empty. */
const EMPTY_RANGE_DAYS = 30;

/** How far ahead of the daemon's clock a dated lines snapshot may fall. See `recordLinesSnapshot`. */
const LINES_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * What the app has spent, over a period.
 *
 * The summing happens HERE rather than in the renderer for the same reason the
 * per-chat totals do: the client holds no ledger, and one that fetched raw
 * events would total whatever page of them it happened to have — silently,
 * since a smaller number looks exactly like a cheaper month.
 *
 * Read-only, on a forked EntityManager. Nothing in this module writes as a
 * consequence of someone opening the page.
 */
@Injectable()
export class StatsService {
  constructor(
    private readonly em: EntityManager,
    private readonly usageDao: UsageEventDao,
    /** Read for which CLIs' money is polled — each one's own `usage.polledSpend`. */
    private readonly adapters: AgentAdapterRegistry,
    /** Which project a folder's spend is filed under — a worktree's repository. */
    private readonly projectRoots: ProjectRootsService,
    /** The thread titles the per-thread breakdown is labelled with. */
    private readonly runDao: RunDao,
    /** The threads' own record: their creations, pull requests and measured line snapshots. */
    private readonly activityDao: UsageActivityDao,
    /** Announces a recorded lines snapshot, so an open page re-reads the figures. */
    private readonly usageBus: UsageEventBus,
    /** The commit each folder's lines are measured against. */
    private readonly baselineDao: LineBaselineDao,
    /** The thread metric ledgers: goals, outcomes, tools, stages and calls. */
    private readonly ledger: MetricLedgerDao,
    /** The goals of the period's threads. */
    private readonly goals: GoalDao,
  ) {}

  /**
   * Both bounds arrive as ISO-8601 strings and are turned into instants here.
   *
   * The parsing lives with the range resolution rather than at the route,
   * because this service already owns what a range MEANS — what an omitted
   * bound falls back to, and which direction is refused. Splitting the two
   * would put half of that decision in a controller.
   */
  async usage(fromIso?: string, toIso?: string): Promise<UsageStatsWire> {
    const em = this.em.fork();
    const range = await this.resolveRange(
      fromIso === undefined ? undefined : new Date(fromIso),
      toIso === undefined ? undefined : new Date(toIso),
      em,
    );
    const events = await this.usageDao.inRange(range.from, range.to, em);
    // A worktree is not a project: each folder is filed under the project it
    // belongs to before anything is summed — see `ProjectRootsService`.
    const roots = await this.projectRoots.rootsOf(
      events.map((event) => event.cwd),
    );
    const projectOf = (cwd: string | null): string | null =>
      cwd === null ? null : (roots.get(cwd) ?? cwd);

    const totals = emptyTotals();
    const byDay = new Map<string, ChatTotalsWire>();
    const activity = new ActivityFold();
    const byAgent = new Map<string | null, ChatTotalsWire>();
    const byModel = new Map<string | null, ChatTotalsWire>();
    const byProject = new Map<string | null, ChatTotalsWire>();
    const byThread = new Map<string | null, ChatTotalsWire>();
    const byTeam = new Map<string | null, ChatTotalsWire>();
    const byPurpose = new Map<string | null, ChatTotalsWire>();
    // A thread with no team slug is in no team bucket.
    const threadRows = await this.activityDao.threadRowsByRuns(
      [...new Set(events.map((event) => event.runId))],
      em,
    );
    const teamOf = (runId: string): string | null =>
      threadRows.get(runId)?.slug ?? null;

    /**
     * Turns the ledger holds no price for, per run and per agent.
     *
     * They are the turns a POLLED price belongs to — see `addPolledSpend`. The
     * tally is built here rather than re-queried because this loop is already
     * reading every event in the period, and the predicate is the CLI-agnostic
     * one (`costUsd === null` means nobody priced this turn) rather than a test
     * on which agent ran it. Keyed by agent so a team's polled money is
     * credited to each CLI with that CLI's own turns, and so the fold below can
     * leave out the turns of a CLI nobody polls.
     */
    const unpricedTurns = new Map<string, number>();
    /** Each run's polled-spend row in the period — folded once the turns are. */
    const polled: UsageEvent[] = [];

    for (const event of events) {
      if (isPolledSpend(event)) {
        polled.push(event);
        continue;
      }
      addUsage(totals, event);
      addUsage(bucket(byDay, localDateKey(event.occurredAt)), event);
      activity.turn(
        localDateKey(event.occurredAt),
        event.runId,
        event.durationMs !== null,
      );
      addUsage(bucket(byAgent, event.agentKind), event);
      addUsage(bucket(byModel, event.model), event);
      addUsage(bucket(byProject, projectOf(event.cwd)), event);
      // Per THREAD, chats and team runs alike. It replaced a per-team
      // breakdown whose null key pooled every chat into one "Chats" row —
      // REPORTED as combining everything into one bucket — when the question a
      // reader brings here is which conversations cost the most.
      addUsage(bucket(byThread, event.runId), event);
      const team = teamOf(event.runId);
      if (team !== null) {
        addUsage(bucket(byTeam, team), event);
      }
      if (event.purpose !== null && event.purpose !== undefined) {
        addUsage(bucket(byPurpose, event.purpose), event);
      }
      tallyUnpricedTurn(unpricedTurns, event);
    }

    // Then the spend nobody's TURN reported.
    //
    // A polled-spend CLI prices nothing on its own wire, so its money reaches
    // this app through an account poll alone — a page summing turns would show
    // every one of its runs as costing nothing.
    //
    // Read from the LEDGER's own polled rows per run, never off the run: those
    // rows outlive the run, so deleting a chat no longer takes its bill out of
    // every lifetime figure — and reading one source rather than two is what
    // keeps a live run's bill from being counted twice. Every dimension is
    // credited from that same row, so the page stays internally consistent:
    // the headline, the day, the agent, the model, the folder and the thread
    // all move together and each column still sums to the total.
    const adapters = this.adapters.all();
    const polledKinds = [...adapters.keys()].filter((kind) =>
      pollsSpendFor(adapters, kind),
    );
    const credit = new PolledTurnCredit(unpricedTurns, polledKinds);
    for (const event of polled) {
      const costUsd = event.costUsd ?? 0;
      if (costUsd <= 0) {
        continue;
      }
      const { turns, agentTurns } = credit.next(event);
      addPolledSpend(totals, costUsd, turns);
      addPolledSpend(
        bucket(byDay, localDateKey(event.occurredAt)),
        costUsd,
        turns,
      );
      // The agent's own divisor is that agent's unpriced turns alone: the row
      // names the one CLI whose money this is, so a team's other agents'
      // turns are not part of what it is spread over.
      addPolledSpend(bucket(byAgent, event.agentKind), costUsd, agentTurns);
      addPolledSpend(bucket(byModel, event.model), costUsd, turns);
      addPolledSpend(bucket(byProject, projectOf(event.cwd)), costUsd, turns);
      // The polled row is keyed by its own run, so a run's bill lands on that
      // thread's row with the turns it was spread over.
      addPolledSpend(bucket(byThread, event.runId), costUsd, turns);
      const team = teamOf(event.runId);
      if (team !== null) {
        addPolledSpend(bucket(byTeam, team), costUsd, turns);
      }
      if (event.purpose !== null && event.purpose !== undefined) {
        addPolledSpend(bucket(byPurpose, event.purpose), costUsd, turns);
      }
    }

    // What the threads did over the same period. Each fact is filed under the day
    // it happened (see `ActivityFold`), so the period's figures are the days' own
    // summed two ways.
    for (const row of await this.activityDao.inRange(
      'thread',
      range.from,
      range.to,
      ['occurredAt'],
      em,
    )) {
      activity.thread(localDateKey(row.occurredAt));
    }
    for (const row of await this.activityDao.inRange(
      'pull_request',
      range.from,
      range.to,
      ['occurredAt'],
      em,
    )) {
      activity.pullRequest(localDateKey(row.occurredAt));
    }
    const snapshots = await this.activityDao.inRange(
      'lines',
      range.from,
      range.to,
      [
        'runId',
        'lineKey',
        'occurredAt',
        'linesAdded',
        'linesRemoved',
        'partial',
      ],
      em,
    );
    const peaks = await this.activityDao.peakLinesBefore(
      snapshots,
      range.from,
      em,
    );
    for (const increment of linesIncrements(snapshots, peaks)) {
      activity.lines(
        localDateKey(increment.occurredAt),
        increment.addedDelta,
        increment.removedDelta,
        increment.partial,
      );
    }

    const days = eachLocalDay(range.from, range.to);
    const metrics = await this.periodMetrics(range.from, range.to, em);
    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      totals,
      activity: activity.period(totals.workedMs),
      // Every day in the range, not only the ones with turns — see
      // `eachLocalDay`: a chart that omitted the quiet days would draw the busy
      // ones as adjacent.
      days: days.map((date) => {
        const day = byDay.get(date) ?? emptyTotals();
        return {
          date,
          totals: day,
          activity: activity.day(date, day.workedMs),
        };
      }),
      byAgent: rank(byAgent),
      byModel: rank(byModel),
      byProject: rank(byProject),
      byThread: await this.titled(rank(byThread), em),
      byTeam: rank(byTeam),
      byPurpose: rank(byPurpose),
      metrics,
    };
  }

  /**
   * The period's thread metrics: goals and outcomes of the threads STARTED in it, and
   * every tool call, stage change and agent call that HAPPENED in it, whenever its
   * thread started.
   */
  private async periodMetrics(
    from: Date,
    to: Date,
    em: EntityManager,
  ): Promise<ThreadMetricsWire> {
    const runs = (
      await this.activityDao.inRange(
        'thread',
        from,
        to,
        ['runId', 'metricsLedger'],
        em,
      )
    ).map((row) => ({ runId: row.runId, metrics: row.metricsLedger === true }));
    const period = { from, to };
    const [goals, threadOutcomes, toolCalls, stages, calls] = await Promise.all(
      [
        this.goals.statusesOf({ runIds: runs.map((run) => run.runId) }, em),
        this.ledger.threadOutcomes(
          { runIds: runs.map((run) => run.runId) },
          em,
        ),
        this.ledger.toolCalls(period, em),
        this.ledger.stages(period, em),
        this.ledger.calls(period, em),
      ],
    );
    const started = foldThreadMetrics({
      runs,
      goals,
      threadOutcomes,
      toolCalls: [],
      stages: [],
      calls: [],
    });
    const happened = foldThreadMetrics({
      runs: [
        ...new Set([...toolCalls, ...stages, ...calls].map((row) => row.runId)),
      ].map((runId) => ({ runId })),
      goals: [],
      threadOutcomes: [],
      toolCalls,
      stages,
      calls,
    });
    return {
      ...started,
      handOffs:
        started.handOffs === null
          ? null
          : stages.filter((row) => row.action === 'handoff').length,
      tools: happened.tools,
      mcpServers: happened.mcpServers,
      stages: happened.stages,
      calls: happened.calls,
    };
  }

  /**
   * The commit a thread's folder is measured against: the folder's baseline, which the
   * first thread measured there sets to its own start commit. A baseline the caller reports
   * stale (its commit is gone, or the checkout no longer descends from it) is replaced by
   * this thread's start commit, which starts a new series (`lineKeyOf`).
   *
   * Null when there is nothing to measure against: a thread with no folder, or a folder with
   * no baseline yet whose thread recorded no start commit.
   */
  async lineBaseline(input: LineBaselineRequest): Promise<LineBaselineWire> {
    const em = this.em.fork();
    const run = await this.threadOf(input.runId, em);
    if (run.cwd === null) {
      return { baseSha: null };
    }
    const folder = measuredFolder(run.cwd, input.root);
    const folderKey = folderKeyOf(folder, input.branch);
    const current = await this.baselineDao.baseShaOf(folderKey, em);
    if (current !== null && current !== input.staleBaseSha) {
      return { baseSha: current };
    }
    const start = run.startSha;
    // No commit to start from, or this thread's own start is the commit that went stale:
    // the folder cannot be measured until a thread that started elsewhere is.
    if (start === null || start === input.staleBaseSha) {
      return { baseSha: null };
    }
    const baseSha =
      current === null
        ? await this.baselineDao.setIfAbsent(
            { folderKey, root: folder, branch: input.branch, baseSha: start },
            em,
          )
        : await this.baselineDao.replaceIfCurrent(
            folderKey,
            current,
            start,
            em,
          );
    return { baseSha };
  }

  /**
   * Record one folder's cumulative change totals, as the desktop app measured them against
   * the folder's baseline after one of its threads finished a turn. The lines are the
   * growth past the highest total the series had reached (see `linesIncrements`).
   *
   * A snapshot for a run that does not exist is refused rather than written: a thread
   * deleted before its last measurement must not come back as an orphan row. What was
   * measured while it existed stays in the ledger, which is the point of having one.
   */
  async recordLinesSnapshot(input: LineSnapshotInput): Promise<void> {
    const em = this.em.fork();
    const run = await this.threadOf(input.runId, em);
    const occurredAt = input.occurredAt
      ? new Date(input.occurredAt)
      : new Date();
    // A measurement is taken after its thread exists and not in the future. A dated one
    // outside that would move the period's floor or count a day that never happened. The
    // allowance is for two clocks that disagree by a few minutes, nothing more.
    if (
      occurredAt.getTime() < run.createdAt.getTime() ||
      occurredAt.getTime() > Date.now() + LINES_CLOCK_SKEW_MS
    ) {
      throw new BadRequestException(
        'STATS_LINES_OUT_OF_RANGE',
        'a lines snapshot must be dated after its thread was created, and not in the future',
      );
    }
    // A measurement that names its baseline joins the folder's series, and has to name the
    // folder the baseline was resolved for: keyed by anything else it would start a series of
    // its own. One that names no baseline was taken against the thread's own start commit
    // and stays the thread's.
    if (
      input.baseSha !== undefined &&
      (input.branch === undefined || input.root === undefined)
    ) {
      throw new BadRequestException(
        'STATS_LINES_FOLDER_UNNAMED',
        'a lines snapshot that names a baseline must name the branch and repository it was measured on',
      );
    }
    await this.activityDao.insertLineSnapshot(
      {
        runId: input.runId,
        lineKey:
          input.baseSha !== undefined &&
          input.branch !== undefined &&
          input.root !== undefined &&
          run.cwd !== null
            ? lineKeyOf(
                measuredFolder(run.cwd, input.root),
                input.branch,
                input.baseSha,
              )
            : null,
        occurredAt,
        linesAdded: input.linesAdded,
        linesRemoved: input.linesRemoved,
        partial: input.partial,
      },
      em,
    );
    // The announcement a recorded snapshot makes, so an open Stats page re-reads and
    // shows the new lines without being reopened.
    this.usageBus.publish({
      runId: input.runId,
      memberId: null,
      occurredAt: occurredAt.toISOString(),
      turn: false,
    });
  }

  /** The columns a lines measurement needs of its thread, or a 404 for a thread that does not exist. */
  private async threadOf(
    runId: string,
    em: EntityManager,
  ): Promise<Pick<Run, 'cwd' | 'startSha' | 'createdAt'>> {
    const run = await this.runDao.getOne(
      { id: runId },
      { fields: ['id', 'cwd', 'startSha', 'createdAt'] },
      em,
    );
    if (!run) {
      throw new NotFoundException(
        'STATS_RUN_NOT_FOUND',
        'no thread has that run id',
      );
    }
    return run;
  }

  /**
   * The per-thread rows with each thread's title, read off the runs in ONE
   * query. A run deleted since keeps its spend here — the ledger outlives it —
   * and says so rather than passing for an untitled thread.
   */
  private async titled(
    groups: UsageGroupWire[],
    em: EntityManager,
  ): Promise<UsageGroupWire[]> {
    const ids = groups
      .map((group) => group.key)
      .filter((key): key is string => key !== null);
    if (ids.length === 0) {
      return groups;
    }
    const titles = new Map(
      (
        await this.runDao.getAll(
          { id: { $in: ids } },
          { fields: ['id', 'title'], disableIdentityMap: true },
          em,
        )
      ).map((run) => [run.id, run.title]),
    );
    return groups.map((group) =>
      group.key === null
        ? group
        : {
            ...group,
            title: titles.get(group.key) ?? null,
            deleted: !titles.has(group.key),
          },
    );
  }

  /**
   * Fill in whichever end the caller left out.
   *
   * An absent `to` is now, and an absent `from` is the ledger's own first
   * recorded turn — "all time" is the only honest reading of a lower bound
   * nobody named, and on an empty ledger it falls back to a recent window so
   * the page opens on a sensible axis rather than on the epoch.
   */
  private async resolveRange(
    from: Date | undefined,
    to: Date | undefined,
    em: EntityManager,
  ): Promise<{ from: Date; to: Date }> {
    // An unparseable bound is refused rather than allowed through as an
    // `Invalid Date`: every comparison against one is false, so the range would
    // silently match no rows and the page would report a period in which
    // nothing was spent. The route's schema already rejects the shape; this
    // covers a caller that reached the service directly.
    for (const bound of [from, to]) {
      if (bound !== undefined && Number.isNaN(bound.getTime())) {
        throw new BadRequestException(
          'STATS_RANGE_INVALID',
          'the range bounds must be ISO-8601 timestamps',
        );
      }
    }
    // Refused rather than silently swapped, and judged on the two bounds the
    // CALLER actually sent — never on one this method substituted or clamped.
    // Comparing against a substituted start made the same request 400 on a
    // populated ledger and succeed on an empty one; comparing against a clamped
    // end would answer a perfectly ordered future window with "the start is
    // after the end", which is not what the caller did wrong.
    if (
      from !== undefined &&
      to !== undefined &&
      from.getTime() > to.getTime()
    ) {
      throw new BadRequestException(
        'STATS_RANGE_INVALID',
        'the start of the range must not be after its end',
      );
    }

    // BOTH ends are then clamped to the span the ledger can actually answer
    // for. This is what BOUNDS the response: the reply carries one bucket per
    // calendar day in the RESOLVED range, so an unclamped bound expands the
    // body without limit — measured at ~375,000 buckets / ~69MB for
    // `from=1000-01-01`, and ~2.9 million / ~511MB for `to=9999-12-31`. Both
    // ends need it; clamping only the floor left the larger hole open. The
    // resolved range is echoed in the response, so a clamped request says so.
    //
    // The ceiling is NOW because a row's `occurredAt` is its source item's
    // `createdAt` — nothing is ever recorded in the future, so no range needs
    // to reach there. The floor is the earliest thread or pull request the ledger
    // holds, for the mirror-image reason.
    const now = new Date();
    const end = to === undefined || to.getTime() > now.getTime() ? now : to;
    const floor = await this.defaultStart(end, em);
    const requested = from ?? floor;
    const start = requested.getTime() < floor.getTime() ? floor : requested;
    // A start landing after `end` describes a period outside what the ledger
    // holds — entirely before its first turn, or entirely in the future. That
    // is an EMPTY range, which is the honest answer, rather than an error about
    // a bound the caller never sent.
    return { from: start.getTime() > end.getTime() ? end : start, to: end };
  }

  /**
   * How far back the ledger can answer for: its first recorded turn, thread or pull
   * request, or a recent window when it holds nothing. Serves as both the default lower
   * bound and the floor every explicit one is clamped to.
   */
  private async defaultStart(end: Date, em: EntityManager): Promise<Date> {
    // A thread is recorded when it is created, and that can be before its first
    // turn, so the ledger's earliest answer is the earlier of the two.
    const firstTurn = await this.usageDao.earliestOccurredAt(em);
    // A lines snapshot is dated by the client, so the floor reads only what the daemon
    // wrote itself.
    const firstActivity = await this.activityDao.earliestOccurredAt(
      ['thread', 'pull_request'],
      em,
    );
    const candidates = [firstTurn, firstActivity].filter(
      (date): date is Date => date !== null,
    );
    if (candidates.length > 0) {
      return new Date(Math.min(...candidates.map((date) => date.getTime())));
    }
    const fallback = new Date(end);
    fallback.setDate(fallback.getDate() - EMPTY_RANGE_DAYS);
    return fallback;
  }
}

function bucket<K>(buckets: Map<K, ChatTotalsWire>, key: K): ChatTotalsWire {
  const existing = buckets.get(key);
  if (existing) {
    return existing;
  }
  const fresh = emptyTotals();
  buckets.set(key, fresh);
  return fresh;
}

/**
 * Slices ordered by what they cost, dearest first — and by turn count where
 * nothing reported a cost, so a cursor-only breakdown still ranks by something
 * the user can act on instead of by map insertion order.
 */
function rank(buckets: Map<string | null, ChatTotalsWire>): UsageGroupWire[] {
  return [...buckets]
    .map(([key, totals]) => ({ key, totals }))
    .sort(
      (a, b) =>
        (b.totals.costUsd ?? 0) - (a.totals.costUsd ?? 0) ||
        b.totals.turns - a.totals.turns,
    );
}

/**
 * The folder a thread's lines are filed under: the repository root the client measured, when
 * it contains the thread's own folder, else the thread's folder. The root is what makes two
 * threads in one repository one series; the check is what keeps a client from filing a
 * thread under a folder it does not work in.
 */
function measuredFolder(cwd: string, root: string): string {
  // A root that is not a plain absolute path — relative, with a `..` or a trailing separator,
  // or the filesystem root that contains every folder — names no repository, and is not
  // honoured.
  // (`resolve` turns a relative path into an absolute one, so it fails the equality too.)
  const plain = resolve(root) === root && root !== sep;
  // Compared without case: macOS paths are case-insensitive, and a folder canonicalized as it
  // was typed can differ in case from the one git prints off the disk. The KEY is git's root,
  // which every thread in the repository reads the same.
  return plain && isWithinDirectory(cwd.toLowerCase(), root.toLowerCase())
    ? root
    : cwd;
}
