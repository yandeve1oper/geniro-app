import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConflictException, NotFoundException } from '@packages/common';
import type { Subscription } from 'rxjs';

import { KnowledgeService } from '../../knowledge/services/knowledge.service';
import { MemoryService } from '../../memory/services/memory.service';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import {
  type AnalysedRun,
  ANALYSIS_DEFAULT_APPROVAL,
  type RunWire,
  type StartTeamAnalysis,
  type StartThreadAnalysis,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { isAnalysisRun } from '../utils/analysed-runs';
import {
  existingDirectory,
  resolveValidDirectory,
} from '../utils/resolve-directory';
import {
  runSnapshotOf,
  type RunSnapshotReaders,
  teamRunSnapshots,
} from '../utils/run-snapshots';
import {
  analysedThreadKindOf,
  teamAnalysisBrief,
  teamAnalysisGuide,
  threadAnalysisBrief,
  threadAnalysisGuide,
} from '../utils/thread-analysis-guide';
import { AgentEventBus } from './agent-events.bus';
import { ChatService } from './chat.service';

/** The newest of these runs' folders that still exists: an archived run's worktree may be gone. */
function newestExistingFolder(
  runs: readonly { cwd: string | null }[],
): string | null {
  for (const { cwd } of runs) {
    const folder = cwd === null ? null : existingDirectory(cwd);
    if (folder !== null) {
      return folder;
    }
  }
  return null;
}

/**
 * A thread's analysis: ONE chat per thread, linked to its source, carrying the
 * analysis method as its task instructions and sent the brief as its first
 * message — the board's own "create a chat, then message it" pattern
 * (`TaskRunsService.start`).
 *
 * It belongs to the thread it reads, the way the builder's chat belongs to its
 * team: the sidebar never lists it (`RunDao.listChats`), the source's
 * popup finds it ({@link find}), a new one replaces it, and it goes when the
 * source is deleted.
 */
@Injectable()
export class ThreadAnalysisService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ThreadAnalysisService.name);
  private deletedSubscription: Subscription | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
    private readonly bus: AgentEventBus,
    private readonly memory: MemoryService,
    private readonly projectScope: ProjectScopeService,
    @Optional() private readonly knowledge?: KnowledgeService,
  ) {}

  /**
   * A deleted thread takes its analysis with it — nothing else could reach it.
   * Announced after the source's rows are gone, whichever route deleted it (a
   * chat, a team run, the archive's retention sweep).
   */
  onModuleInit(): void {
    this.deletedSubscription = this.bus.allDeleted().subscribe((runId) => {
      // Off the delete's own path, so nothing awaits it: a failed read of the
      // analyses is logged here rather than left an unhandled rejection.
      this.deleteAnalysesOf(runId).catch((err: unknown) => {
        this.logger.warn(
          `analyses of deleted ${runId} not looked up: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }

  /**
   * An analysis whose source is already gone — the delete above missed it:
   * the daemon stopped before the announce was handled, or the delete failed —
   * is reachable from nowhere and still holds the deleted thread's words.
   * Swept once per boot, off the ready path.
   */
  onApplicationBootstrap(): void {
    void this.sweepOrphans().catch((err: unknown) => {
      this.logger.warn(
        `orphaned analyses not swept: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  onModuleDestroy(): void {
    this.deletedSubscription?.unsubscribe();
  }

  /** Delete every analysis whose source thread no longer exists. */
  async sweepOrphans(): Promise<void> {
    const orphans = await this.runDao.listOrphanedAnalyses(this.em.fork());
    await this.deleteRuns(
      'a deleted thread',
      orphans.map((run) => run.id),
    );
  }

  /** The thread's analysis as it reads now, or null when it has none. */
  async find(sourceRunId: string): Promise<RunWire | null> {
    const source = await this.runDao.getById(sourceRunId, this.em.fork());
    if (source === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${sourceRunId}`);
    }
    return this.chats.findAnalysis(sourceRunId);
  }

  async start(
    sourceRunId: string,
    input: StartThreadAnalysis,
  ): Promise<RunWire> {
    const em = this.em.fork();
    const source = await this.runDao.getById(sourceRunId, em);
    if (source === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${sourceRunId}`);
    }
    if (isAnalysisRun(source)) {
      throw new ConflictException(
        'ANALYSIS_OF_ANALYSIS',
        'this thread is itself an analysis — analyse the thread it reads instead',
      );
    }
    // The source's own folder, unless it is gone: repo recommendations are
    // edits in the tree the analysed thread worked in, so a different folder
    // is the user's call, made in the dialog.
    // A folder the user picked is checked with the reason said; only the
    // source's own folder going missing asks for one.
    const cwd =
      input.cwd !== undefined
        ? resolveValidDirectory(input.cwd, {
            errorCode: 'ANALYSIS_FOLDER_GONE',
            noun: 'folder',
          })
        : source.cwd === null
          ? null
          : existingDirectory(source.cwd);
    if (cwd === null) {
      throw new ConflictException(
        'ANALYSIS_FOLDER_GONE',
        "the thread's folder no longer exists — pick a folder to run the analysis in",
      );
    }
    const { snapshotSeq, working } = await runSnapshotOf(
      this.snapshotReaders(),
      sourceRunId,
    );
    if (snapshotSeq < 0) {
      throw new ConflictException(
        'ANALYSIS_SOURCE_EMPTY',
        'the thread has nothing in it to analyse yet',
      );
    }
    // The analyses this start replaces, read BEFORE it creates its own: a
    // start racing it (a second window, the phone) creates one too, and
    // deleting "every analysis but mine" afterwards would delete each
    // other's. The newest then wins `findAnalysis`, and both survive.
    const earlier = (await this.runDao.listReviewAnalysesOf(source.id, em)).map(
      (analysis) => analysis.id,
    );
    const kind = analysedThreadKindOf(source);
    // The source's project, or explicitly none: the analysis's own memory
    // writes and instructions follow the thread it reads, whatever folder the
    // dialog runs it in.
    const project = await this.projectScope.projectOfRun(source);
    const run = await this.chats.createChat({
      agentKind: input.agentKind,
      cwd,
      projectId: project?.id ?? null,
      approval: input.approval ?? ANALYSIS_DEFAULT_APPROVAL,
      model: input.model,
      effort: input.effort,
      contextWindow: input.contextWindow,
      autoCompactPercent: input.autoCompactPercent,
      modelParameters: input.modelParameters,
      configDir: input.configDir,
      customInstructions: input.customInstructions,
      replyLanguage: input.replyLanguage,
      agentOptions: input.agentOptions,
      title: `Analysis: ${source.title ?? 'untitled thread'}`,
      taskInstructions: threadAnalysisGuide(
        kind,
        input.focus ?? null,
        this.memory.enabled,
        this.knowledge?.agentsMayWrite ?? false,
      ),
      analysisSource: {
        runId: source.id,
        seq: snapshotSeq,
        working,
      },
    });
    try {
      await this.chats.sendMessage(
        run.id,
        threadAnalysisBrief({ title: source.title, kind }),
      );
    } catch (error) {
      // An analysis chat that never got its brief is an empty thread with a
      // method and nothing to apply it to; the dialog stays open on the
      // refusal, so the user retries rather than finding it later.
      await this.chats.delete(run.id).catch(() => undefined);
      throw error;
    }
    // Only now is the earlier analysis replaced: a start that fails above
    // leaves the thread the one it had.
    await this.deleteRuns(source.id, earlier);
    // Its own row as it reads after the brief, not the copy taken before it —
    // the popup opens on this, and a `pending` copy would show no Stop.
    return (await this.chats.findAnalysis(source.id, run.id)) ?? run;
  }

  /**
   * The one project every analysed run belongs to, else none: runs that span
   * projects, or none at all, give the analysis chat no project.
   */
  private async commonProjectOf(
    runs: readonly AnalysedRun[],
    em: EntityManager,
  ): Promise<string | null> {
    const ids = new Set<string | null>();
    for (const { runId } of runs) {
      const row = await this.runDao.getById(runId, em);
      ids.add(
        row ? ((await this.projectScope.projectOfRun(row))?.id ?? null) : null,
      );
    }
    const [only] = ids;
    return ids.size === 1 ? (only ?? null) : null;
  }

  /** The team's analysis as it reads now, or null when it has none. */
  findTeamAnalysis(slug: string): Promise<RunWire | null> {
    return this.chats.findTeamAnalysis(slug);
  }

  /**
   * Start a team's analysis over its newest runs: ONE chat per team,
   * replacing the one it had on the same terms as {@link start}. The runs are
   * chosen here, from every run of the team, never from a list a client
   * loaded; each is read up to its own snapshot.
   */
  async startTeam(
    target: { slug: string; name: string },
    input: StartTeamAnalysis,
  ): Promise<RunWire> {
    const em = this.em.fork();
    const snapshots = await teamRunSnapshots(
      this.snapshotReaders(),
      target.slug,
      input.runs,
    );
    if (snapshots.length === 0) {
      throw new ConflictException(
        'ANALYSIS_NO_RUNS',
        'the team has no runs to analyse yet — run it first',
      );
    }
    const runs: AnalysedRun[] = snapshots.map(
      ({ runId, snapshotSeq, working }) => ({ runId, snapshotSeq, working }),
    );
    const cwd =
      input.cwd !== undefined
        ? resolveValidDirectory(input.cwd, {
            errorCode: 'ANALYSIS_FOLDER_GONE',
            noun: 'folder',
          })
        : newestExistingFolder(snapshots);
    if (cwd === null) {
      throw new ConflictException(
        'ANALYSIS_FOLDER_GONE',
        "none of the analysed runs' folders exists any more — pick a folder to run the analysis in",
      );
    }
    const earlier = (await this.runDao.listTeamAnalyses(target.slug, em)).map(
      (analysis) => analysis.id,
    );
    const run = await this.chats.createChat({
      agentKind: input.agentKind,
      cwd,
      projectId: await this.commonProjectOf(runs, em),
      approval: input.approval ?? ANALYSIS_DEFAULT_APPROVAL,
      model: input.model,
      effort: input.effort,
      contextWindow: input.contextWindow,
      autoCompactPercent: input.autoCompactPercent,
      modelParameters: input.modelParameters,
      configDir: input.configDir,
      customInstructions: input.customInstructions,
      replyLanguage: input.replyLanguage,
      agentOptions: input.agentOptions,
      title: `Analysis: ${target.name}`,
      taskInstructions: teamAnalysisGuide(
        input.focus ?? null,
        this.memory.enabled,
        this.knowledge?.agentsMayWrite ?? false,
      ),
      analysisTeam: { slug: target.slug, runs },
    });
    try {
      await this.chats.sendMessage(
        run.id,
        teamAnalysisBrief({ name: target.name, runs: runs.length }),
      );
    } catch (error) {
      await this.chats.delete(run.id).catch(() => undefined);
      throw error;
    }
    await this.deleteRuns(`team ${target.slug}`, earlier);
    return (await this.chats.findTeamAnalysis(target.slug, run.id)) ?? run;
  }

  /** Delete every analysis of a library team — the team is gone. */
  async deleteTeamAnalyses(slug: string): Promise<void> {
    const analyses = await this.runDao.listTeamAnalyses(slug, this.em.fork());
    await this.deleteRuns(
      `team ${slug}`,
      analyses.map((analysis) => analysis.id),
    );
  }

  /** The slugs of every team some analysis was started on. */
  analysedTeamSlugs(): Promise<string[]> {
    return this.runDao.teamAnalysisSlugs(this.em.fork());
  }

  /** Delete every analysis of a thread. */
  private async deleteAnalysesOf(sourceRunId: string): Promise<void> {
    const analyses = await this.runDao.listAnalysesOf(
      sourceRunId,
      this.em.fork(),
    );
    await this.deleteRuns(
      sourceRunId,
      analyses.map((analysis) => analysis.id),
    );
  }

  /**
   * Delete these analyses. One failing is logged and the rest still go: an
   * analysis nothing lists is reachable from nowhere else.
   */
  private async deleteRuns(
    sourceLabel: string,
    analysisIds: readonly string[],
  ): Promise<void> {
    for (const id of analysisIds) {
      await this.chats.delete(id).catch((err: unknown) => {
        this.logger.warn(
          `analysis ${id} of ${sourceLabel} not deleted: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  private snapshotReaders(): RunSnapshotReaders {
    return { em: this.em, runDao: this.runDao, itemDao: this.itemDao };
  }
}
