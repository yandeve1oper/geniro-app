import { Injectable } from '@nestjs/common';

import { ItemDao } from '../../agents/dao/item.dao';
import type {
  CommandCenterTimeline,
  CommandCenterTimelineEvent,
} from '../command-center.types';
import { CommandCenterRosterDao } from '../dao/command-center-roster.dao';
import { CommandCenterTimelineDao } from '../dao/command-center-timeline.dao';
import {
  approvalEvent,
  errorLineOf,
  failedEvent,
  managerMessageEvent,
  outcomeEvent,
  pullRequestEvent,
  stageEvent,
  startRequestEvent,
  threadMessageEvent,
  threadStartedEvent,
  type TimelineCandidate,
  userMessageEvent,
} from '../utils/timeline-events';
import { pageOf } from '../utils/timeline-page';
import { CommandCenterService } from './command-center.service';

const FAR_FUTURE = new Date(8.64e15);
const UNTITLED_THREAD = 'Untitled thread';

/**
 * The command center's timeline: what the manager said and was told, and what
 * its threads did, merged newest first. Its threads are every run on the
 * manager's roster, left ones included, and every active thread on the board.
 */
@Injectable()
export class CommandCenterTimelineService {
  constructor(
    private readonly board: CommandCenterService,
    private readonly roster: CommandCenterRosterDao,
    private readonly items: ItemDao,
    private readonly timeline: CommandCenterTimelineDao,
  ) {}

  async page(
    before: Date | null,
    limit: number,
  ): Promise<CommandCenterTimeline> {
    const managerRunId = await this.board.managerRunId();
    if (managerRunId === null) {
      return { events: [], nextBefore: null };
    }
    const [active, rosterRows] = await Promise.all([
      this.board.activeThreads(),
      this.roster.listOf(managerRunId),
    ]);
    const threadRunIds = [
      ...new Set([
        ...rosterRows.map((row) => row.threadRunId),
        ...active.runs.map((run) => run.id),
      ]),
    ];
    const cutoff = before ?? FAR_FUTURE;
    const now = Date.now();

    const [
      userMessages,
      managerMessages,
      threadMessages,
      threadRuns,
      startRequests,
      pullRequests,
      approvals,
      stages,
      outcomes,
      failed,
    ] = await Promise.all([
      this.timeline.userMessages(managerRunId, cutoff, limit),
      this.timeline.managerMessages(managerRunId, threadRunIds, cutoff, limit),
      this.timeline.threadMessages(managerRunId, threadRunIds, cutoff, limit),
      this.timeline.threadStarts(threadRunIds, cutoff, limit),
      this.timeline.startRequests(managerRunId, cutoff, limit),
      this.timeline.pullRequests(threadRunIds, cutoff, limit),
      this.timeline.approvals(threadRunIds, cutoff, limit),
      this.timeline.stages(threadRunIds, cutoff, limit),
      this.timeline.outcomes(threadRunIds, cutoff, limit),
      this.failedCandidates(threadRunIds, cutoff),
    ]);

    const candidates: TimelineCandidate[] = [
      ...userMessages.map(userMessageEvent),
      ...managerMessages.map((row) => managerMessageEvent(row, now)),
      ...threadMessages.map(threadMessageEvent),
      ...threadRuns.map(threadStartedEvent),
      ...startRequests.flatMap((task) =>
        task.startRequestedAt === null
          ? []
          : [startRequestEvent(task, task.startRequestedAt)],
      ),
      ...pullRequests.map(pullRequestEvent),
      ...approvals.map(approvalEvent),
      ...stages.map(stageEvent),
      ...outcomes.map(outcomeEvent),
      ...failed,
    ];

    const page = pageOf(candidates, limit);
    const titles = await this.titlesOf(
      page.rows.flatMap((row) =>
        row.threadRunId === null ? [] : [row.threadRunId],
      ),
    );

    return {
      events: page.rows.map((row): CommandCenterTimelineEvent => {
        const threadRunId = row.threadRunId;
        return {
          id: row.id,
          at: row.at.toISOString(),
          kind: row.kind,
          threadRunId,
          threadTitle:
            threadRunId === null
              ? null
              : (titles.get(threadRunId) ??
                row.fallbackTitle ??
                UNTITLED_THREAD),
          text: row.text,
          detail: row.detail,
          awaitingReply: row.awaitingReply,
        };
      }),
      nextBefore: page.nextBefore?.toISOString() ?? null,
    };
  }

  private async failedCandidates(
    threadRunIds: readonly string[],
    cutoff: Date,
  ): Promise<TimelineCandidate[]> {
    const runs = await this.timeline.failedRuns(threadRunIds);
    const runIds = runs.map((run) => run.id);
    const [activity, errors] = await Promise.all([
      this.items.latestItemAtPerRun(runIds),
      this.timeline.errorItems(runIds),
    ]);
    const newestError = new Map<string, string | null>();
    for (const row of errors) {
      if (!newestError.has(row.run_id)) {
        newestError.set(row.run_id, errorLineOf(row));
      }
    }
    return runs.flatMap((run) => {
      const at = activity.get(run.id) ?? run.updatedAt;
      return at.getTime() < cutoff.getTime()
        ? [failedEvent(run, at, newestError.get(run.id) ?? null)]
        : [];
    });
  }

  private async titlesOf(runIds: string[]): Promise<Map<string, string>> {
    const runs = await this.timeline.titlesOf([...new Set(runIds)]);
    return new Map(
      runs.flatMap((run): [string, string][] =>
        run.title === null ? [] : [[run.id, run.title]],
      ),
    );
  }
}
