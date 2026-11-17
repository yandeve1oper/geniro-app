import { EntityManager, type FilterQuery } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { Run } from '../../runs/entity/run.entity';
import { baseTeamSnapshotOf } from '../../teams/utils/team-snapshot';
import type {
  ActivityWindow,
  ChatListScope,
  ChatTextDatabase,
  ContextLevel,
  PromptCacheTtlReason,
  RunFacts,
  RunListPage,
  RunPullRequest,
  SettleFigures,
  TaskStageLine,
  ThreadListFilter,
  ThreadListPage,
} from '../chat.types';
import { idBatches } from '../utils/id-batches';
import { positive } from '../utils/positive-figure';
import { readRunPullRequests } from '../utils/pull-request-capture';
import {
  hasActivityWindow,
  newestItemAt,
  newestUserMessageAt,
  runIdsActiveIn,
  windowBounds,
} from '../utils/run-activity';
import { readRunStageProgress, stageLineOf } from '../utils/stage-progress';

@Injectable()
export class RunDao extends BaseDao<Run> {
  constructor(em: EntityManager) {
    super(em, Run);
  }

  /** Whether any run's frozen copy of its team contains `text` (a stored file's id). */
  async teamSnapshotMentions(text: string): Promise<boolean> {
    const found = await this.em
      .fork()
      .findOne(
        Run,
        { teamSnapshot: { $like: `%${text}%` } },
        { fields: ['id'], filters: false },
      );
    return found !== null;
  }

  /**
   * Single-agent chat runs (no team), newest first, filtered by how much
   * of the archive the caller asked for.
   *
   * `all` states NO condition on `archivedAt` rather than a condition matching
   * both sides — an `$in` over null and non-null is the same rows written as a
   * predicate SQL cannot use an index for, and one that a nullable column
   * makes easy to get subtly wrong.
   *
   * **A team-editing chat is NOT a chat of the sidebar's kind** and is
   * excluded on every scope. It is the builder's "Change with chat" panel: the
   * user never opened it, never named it, and cannot get back to the team
   * it is about from a sidebar row — it belongs to that one page, and the panel
   * finds it through {@link listEditingTeam} rather than through this
   * listing. REPORTED as "этот тред здесь быть не должен! Он должен быть только
   * там, на той странице, то есть это special тред."
   *
   * **A thread's analysis is hidden for the same reason** ("I should not see
   * this thread in shared list - same as for thread with changing team"):
   * it belongs to the thread it reads, opens in that thread's popup, and is
   * found through {@link listAnalysesOf}. A team's analysis is hidden on
   * the same terms and found through {@link listTeamAnalyses}, and so is a
   * project's own chat, found through {@link listEditingProject}. Nothing
   * else is hidden by kind.
   */
  async listChats(
    scope: ChatListScope,
    txEm?: EntityManager,
    page: RunListPage = {},
  ): Promise<Run[]> {
    return this.listPage(
      {
        teamId: null,
        editsTeamSlug: null,
        editsProjectId: null,
        analysisSourceRunId: null,
        analysisTeamSlug: null,
        ...scopeFilter(scope),
      },
      page,
      txEm,
    );
  }

  /**
   * One page of the threads an agent may reach: chats and team runs alike,
   * never a builder, project or analysis one, and an archived one only when
   * asked. The caller's own project first, then the last active, each run
   * dated by its newest transcript row (`utils/run-activity.ts`) — its
   * creation when it has none, which falls in no activity window.
   */
  async listThreads(
    filter: ThreadListFilter,
    txEm?: EntityManager,
  ): Promise<ThreadListPage> {
    const em = txEm ?? this.em.fork();
    const db = em.getKysely<ChatTextDatabase>({ convertValues: false });
    let ranked = db
      .selectFrom('runs as r')
      .select((eb) => [
        'r.id',
        newestItemAt(eb).as('last_activity_at'),
        newestUserMessageAt(eb).as('last_user_message_at'),
        eb.fn.coalesce(newestItemAt(eb), eb.ref('r.created_at')).as('sort_at'),
        (filter.callerProjectId === null
          ? eb.lit(1)
          : eb
              .case()
              .when('r.project_id', '=', filter.callerProjectId)
              .then(0)
              .else(1)
              .end()
        ).as('rank'),
      ])
      .where('r.deleted_at', 'is', null)
      .where('r.pending_delete_at', 'is', null)
      .where('r.edits_team_slug', 'is', null)
      .where('r.edits_project_id', 'is', null)
      .where('r.analysis_source_run_id', 'is', null)
      .where('r.analysis_team_slug', 'is', null)
      .where('r.id', '!=', filter.excludeRunId);
    if (!filter.includeArchived) {
      ranked = ranked.where('r.archived_at', 'is', null);
    }
    if (filter.query !== null) {
      ranked = ranked.where('r.title', 'like', `%${filter.query}%`);
    }
    if (filter.projectId !== null) {
      ranked = ranked.where('r.project_id', '=', filter.projectId);
    }
    let page = db.selectFrom(ranked.as('t')).selectAll();
    const { window, after } = filter;
    if (window !== undefined) {
      page = page.where((eb) =>
        windowBounds(eb, eb.ref('t.last_activity_at'), window),
      );
    }
    if (after !== null) {
      page = page.where((eb) =>
        eb.or([
          eb('t.rank', '>', after.rank),
          eb.and([
            eb('t.rank', '=', after.rank),
            eb('t.sort_at', '<', after.sortAt),
          ]),
          eb.and([
            eb('t.rank', '=', after.rank),
            eb('t.sort_at', '=', after.sortAt),
            eb('t.id', '<', after.id),
          ]),
        ]),
      );
    }
    const rows = await page
      .orderBy('t.rank', 'asc')
      .orderBy('t.sort_at', 'desc')
      .orderBy('t.id', 'desc')
      .limit(filter.limit + 1)
      .execute();
    const shown = rows.slice(0, filter.limit);
    const runs = new Map(
      shown.length === 0
        ? []
        : (
            await this.getRepo(em).find(
              { id: { $in: shown.map((row) => row.id) } },
              { disableIdentityMap: true },
            )
          ).map((run) => [run.id, run] as const),
    );
    const last = shown.at(-1);
    return {
      runs: shown.flatMap((row) => {
        const run = runs.get(row.id);
        return run === undefined
          ? []
          : [
              {
                run,
                lastActivityAt: dateOf(row.last_activity_at),
                lastUserMessageAt: dateOf(row.last_user_message_at),
              },
            ];
      }),
      next:
        rows.length > filter.limit && last !== undefined
          ? {
              rank: Number(last.rank),
              sortAt: Number(last.sort_at),
              id: last.id,
            }
          : null,
    };
  }

  /**
   * One page of a listing, newest first. `id` breaks a `createdAt` tie so the
   * cursor names one place in the order and no row is skipped or repeated
   * across pages.
   */
  private async listPage(
    where: FilterQuery<Run>,
    page: RunListPage,
    txEm?: EntityManager,
  ): Promise<Run[]> {
    const { before, runId, limit, active } = page;
    const narrowed: FilterQuery<Run>[] = [where, { pendingDeleteAt: null }];
    if (runId !== undefined) {
      narrowed.push({ id: runId });
    }
    if (hasActivityWindow(active)) {
      const ids = await this.runIdsActiveIn(active, txEm);
      if (ids.length === 0) {
        return [];
      }
      narrowed.push({ id: { $in: ids } });
    }
    if (before !== undefined) {
      narrowed.push({
        $or: [
          { createdAt: { $lt: before.createdAt } },
          { createdAt: before.createdAt, id: { $lt: before.id } },
        ],
      });
    }
    return this.getRepo(txEm).find(
      { $and: narrowed },
      // Read-only list paths: skip identity-map tracking so a long run history
      // doesn't accumulate managed entities in the forked EM (see item.dao).
      {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(limit === undefined ? {} : { limit }),
        disableIdentityMap: true,
      },
    );
  }

  async runIdsActiveIn(
    window: ActivityWindow,
    txEm?: EntityManager,
  ): Promise<string[]> {
    const rows = await runIdsActiveIn(
      (txEm ?? this.em.fork()).getKysely<ChatTextDatabase>({
        convertValues: false,
      }),
      window,
    ).execute();
    return rows.map((row) => row.id);
  }

  /**
   * Every chat opened to EDIT one library team, newest first.
   *
   * Archived rows are included deliberately: the two readers want opposite
   * things from the shelf — reopening the builder's panel should find a chat
   * the user shelved rather than silently start a second one, and deleting the
   * team must destroy every chat about it, shelved ones included.
   */
  async listEditingTeam(slug: string, txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { editsTeamSlug: slug },
      { orderBy: { createdAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /** Every project's own chat for one project, newest first — archived ones included, for the reason {@link listEditingTeam} gives. */
  async listEditingProject(
    projectId: string,
    txEm?: EntityManager,
  ): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { editsProjectId: projectId, editsTeamSlug: null },
      { orderBy: { createdAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /** The projects that have an own chat, archived ones included. */
  async projectChatProjectIds(txEm?: EntityManager): Promise<string[]> {
    const runs = await this.getRepo(txEm).find(
      { editsProjectId: { $ne: null }, editsTeamSlug: null },
      { fields: ['id', 'editsProjectId'], disableIdentityMap: true },
    );
    return [
      ...new Set(
        runs.flatMap((run) =>
          run.editsProjectId === null ? [] : [run.editsProjectId],
        ),
      ),
    ];
  }

  /**
   * Every analysis started on one thread, newest first, lessons reflections
   * included. Archived rows are included: the source's delete must take them
   * all.
   */
  async listAnalysesOf(
    sourceRunId: string,
    txEm?: EntityManager,
  ): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { analysisSourceRunId: sourceRunId },
      { orderBy: { createdAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /**
   * The user's own analyses of one thread ("Analyze thread"), newest first —
   * never a lessons reflection. A thread keeps one — a new one replaces it —
   * so more than one means a replace that did not finish, and the reader
   * takes the newest.
   */
  async listReviewAnalysesOf(
    sourceRunId: string,
    txEm?: EntityManager,
  ): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { $and: [{ analysisSourceRunId: sourceRunId }, REVIEW_PURPOSE] },
      { orderBy: { createdAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /** One thread's lessons reflections, newest first, archived ones included. */
  async listLessonReflectionsOf(
    sourceRunId: string,
    txEm?: EntityManager,
  ): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { analysisSourceRunId: sourceRunId, analysisPurpose: 'lessons' },
      { orderBy: { createdAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /** The runs deleted with "Extract lessons first" whose delete has not happened yet. */
  async listPendingDeletes(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { pendingDeleteAt: { $ne: null } },
      { disableIdentityMap: true },
    );
  }

  /**
   * Every analysis started on one library team, newest first — archived
   * rows included, for the reason {@link listAnalysesOf} gives.
   */
  async listTeamAnalyses(slug: string, txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { analysisTeamSlug: slug },
      { orderBy: { createdAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /**
   * Every chat that can file recommendations or member assessments about a
   * library team — its analyses and its builder chats, and every thread
   * analysis, whose source may be one of its runs — archived ones included.
   */
  async teamLedgerChats(
    txEm?: EntityManager,
  ): Promise<
    Pick<
      Run,
      | 'id'
      | 'analysisTeamSlug'
      | 'editsTeamSlug'
      | 'analysisSourceRunId'
      | 'agentKind'
      | 'model'
    >[]
  > {
    return this.getRepo(txEm).find(
      {
        $and: [
          {
            $or: [
              { analysisTeamSlug: { $ne: null } },
              { editsTeamSlug: { $ne: null } },
              { analysisSourceRunId: { $ne: null } },
            ],
          },
          REVIEW_PURPOSE,
        ],
      },
      {
        fields: [
          'id',
          'analysisTeamSlug',
          'editsTeamSlug',
          'analysisSourceRunId',
          'agentKind',
          'model',
        ],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * Where the runs created since `since` were filed — any at all, their
   * projects and their teams — archived ones included.
   */
  async placesWithRunsSince(
    since: Date,
    txEm?: EntityManager,
  ): Promise<{ any: boolean; projectIds: string[]; teamSlugs: string[] }> {
    const rows = await this.getRepo(txEm).find(
      { createdAt: { $gte: since } },
      { fields: ['projectId', 'teamId'], disableIdentityMap: true },
    );
    const projectIds = new Set<string>();
    const teamSlugs = new Set<string>();
    for (const run of rows) {
      if (run.projectId !== null) {
        projectIds.add(run.projectId);
      }
      if (run.teamId !== null) {
        teamSlugs.add(run.teamId);
      }
    }
    return {
      any: rows.length > 0,
      projectIds: [...projectIds],
      teamSlugs: [...teamSlugs],
    };
  }

  /** The slugs of every team some analysis was started on. */
  async teamAnalysisSlugs(txEm?: EntityManager): Promise<string[]> {
    const rows = await this.getRepo(txEm).find(
      { analysisTeamSlug: { $ne: null } },
      { fields: ['analysisTeamSlug'], disableIdentityMap: true },
    );
    return [...new Set(rows.map((run) => run.analysisTeamSlug!))];
  }

  /**
   * A library team's newest runs, newest first, archived ones included: at
   * most `limit`, the ones a team analysis reads, or with null all of them.
   */
  async newestTeamRuns(
    slug: string,
    limit: number | null,
    txEm?: EntityManager,
  ): Promise<
    Pick<Run, 'id' | 'status' | 'title' | 'createdAt' | 'cwd' | 'archivedAt'>[]
  > {
    return this.getRepo(txEm).find(
      { teamId: slug },
      {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(limit === null ? {} : { limit }),
        fields: ['id', 'status', 'title', 'createdAt', 'cwd', 'archivedAt'],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * Every analysis whose source thread no longer exists — what a missed
   * cascade leaves behind (`ThreadAnalysisService.sweepOrphans`).
   */
  async listOrphanedAnalyses(txEm?: EntityManager): Promise<Run[]> {
    const analyses = await this.getRepo(txEm).find(
      { analysisSourceRunId: { $ne: null } },
      { disableIdentityMap: true },
    );
    if (analyses.length === 0) {
      return [];
    }
    const sources = await this.getRepo(txEm).find(
      {
        id: {
          $in: [...new Set(analyses.map((run) => run.analysisSourceRunId!))],
        },
      },
      { fields: ['id'], disableIdentityMap: true },
    );
    const alive = new Set(sources.map((run) => run.id));
    return analyses.filter((run) => !alive.has(run.analysisSourceRunId!));
  }

  /** How many runs are on the desk and how many are archived. */
  async countByShelf(
    txEm?: EntityManager,
  ): Promise<{ active: number; archived: number }> {
    const repo = this.getRepo(txEm);
    const [active, archived] = await Promise.all([
      repo.count({ archivedAt: null, pendingDeleteAt: null }),
      repo.count({ archivedAt: { $ne: null }, pendingDeleteAt: null }),
    ]);
    return { active, archived };
  }

  /** Every run id the table holds, soft-deleted rows included. */
  async allIdsIncludingDeleted(txEm?: EntityManager): Promise<Set<string>> {
    const rows = await this.getRepo(txEm).find(
      {},
      { fields: ['id'], filters: false, disableIdentityMap: true },
    );
    return new Set(rows.map((run) => run.id));
  }

  /**
   * Every ARCHIVED run shelved at or before `cutoff`, oldest first — both kinds.
   *
   * TWO columns rather than whole rows: every one of them is about to be
   * destroyed, so hydrating entities buys nothing and a long archive would load
   * its whole history into the forked EM. The `teamId` rides along because
   * the sweep has to know which teardown a run needs, and asking per id would
   * be a second query for a column this one already touches.
   *
   * It answered CHAT runs alone until team runs became archivable — a limit
   * that then meant the retention window silently did not cover half the shelf.
   *
   * Oldest FIRST, which is the reverse of every other listing here and is the
   * one ordering that degrades well: a sweep interrupted part-way — the daemon
   * quits, the disk fills — has removed the runs furthest past the retention
   * window, so the next sweep resumes rather than starting over on rows it has
   * already reached.
   */
  async archivedRunsBefore(
    cutoff: Date,
    txEm?: EntityManager,
  ): Promise<{ id: string; teamId: string | null }[]> {
    const rows = await this.getRepo(txEm).find(archivedAtOrBefore(cutoff), {
      fields: ['id', 'teamId'],
      orderBy: { archivedAt: 'asc' },
      disableIdentityMap: true,
    });
    return rows.map((run) => ({ id: run.id, teamId: run.teamId }));
  }

  /** How many runs {@link archivedRunsBefore} would answer. */
  async countArchivedBefore(
    cutoff: Date,
    txEm?: EntityManager,
  ): Promise<number> {
    return this.getRepo(txEm).count(archivedAtOrBefore(cutoff));
  }

  /**
   * Who these runs are — never their team copy, which runs to hundreds of KB a run. `'every-team-run'` reads every team run. A run that no
   * longer exists is absent.
   */
  async runFacts(
    runIds: readonly string[] | 'every-team-run',
    txEm?: EntityManager,
  ): Promise<RunFacts[]> {
    const read = async (where: FilterQuery<Run>): Promise<RunFacts[]> =>
      (
        await this.getRepo(txEm).find(where, {
          fields: ['id', 'teamId', 'agentKind', 'createdAt'],
          disableIdentityMap: true,
        })
      ).map((run) => ({
        id: run.id,
        teamId: run.teamId,
        agentKind: run.agentKind,
        createdAt: run.createdAt,
      }));
    if (runIds === 'every-team-run') {
      return read({ teamId: { $ne: null } });
    }
    const facts: RunFacts[] = [];
    for (const batch of idBatches(runIds)) {
      facts.push(...(await read({ id: { $in: batch } })));
    }
    return facts;
  }

  /**
   * The SHARED team each of these runs started from (`baseTeamSnapshotOf`:
   * `Run.teamBaseSnapshot`, else `Run.teamSnapshot`), by run id — what a team
   * version is hashed over; a run that no longer exists is absent.
   */
  async baseTeamSnapshots(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const batch of idBatches(runIds)) {
      const rows = await this.getRepo(txEm).find(
        { id: { $in: batch } },
        {
          fields: ['id', 'teamSnapshot', 'teamBaseSnapshot'],
          disableIdentityMap: true,
        },
      );
      for (const run of rows) {
        out.set(run.id, baseTeamSnapshotOf(run));
      }
    }
    return out;
  }

  /** Which of these runs still exist. */
  async existingIds(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    for (const batch of idBatches([...new Set(runIds)])) {
      const rows = await this.getRepo(txEm).find(
        { id: { $in: batch } },
        { fields: ['id'], disableIdentityMap: true },
      );
      for (const run of rows) {
        out.add(run.id);
      }
    }
    return out;
  }

  /**
   * Forget the snapshotted custom instructions on every run still holding any,
   * and report how many were cleared.
   *
   * EVERY run, not only the unsettled ones. A settled chat is a chat whose last
   * turn ended, not one that is closed — the user can send it another message
   * at any time, and that turn would re-send the text they retracted. Limiting
   * this to in-flight runs would leave the retention it exists to end.
   *
   * The cost is deliberate and is the whole reason this is a BUTTON rather
   * than something clearing the settings box does on its own: it discards the
   * per-run snapshot, so an old chat continued afterwards runs without the
   * instructions it started under.
   *
   * The USER's text only. `Run.taskInstructions` — a task run's label block
   * and report ask — is not theirs to retract through this button, so it is
   * left exactly as it is.
   */
  async forgetCustomInstructions(txEm?: EntityManager): Promise<number> {
    return this.getRepo(txEm).nativeUpdate(
      { customInstructions: { $ne: null } },
      { customInstructions: null },
    );
  }

  /**
   * Retitle a run only while its title is still `expected`, and report whether
   * that held.
   *
   * The predicate is the whole point, and it is why auto-naming cannot go
   * through `updateById`: that reads the row, assigns, and flushes, so the write
   * is decided by a snapshot taken before the title was resolved — and resolving
   * one is slow (a `node_state` read, a session-store read, a transcript read).
   * A `PATCH /v1/chats/:runId` rename landing inside that window would be
   * overwritten by a name the user never chose, invisibly: nothing announces the
   * loss, and the screen keeps showing their title until the next listing.
   *
   * `expected: null` claims an unnamed run; a string replaces one auto-name with
   * a better one and refuses if the user has since renamed it. Answering `false`
   * is a real outcome rather than a failure — the run has a name, just not the
   * one this call assumed — and the caller uses it to withhold the announce, so
   * a title that lost the race is never broadcast either.
   */
  async retitle(
    runId: string,
    title: string,
    expected: string | null,
    txEm?: EntityManager,
  ): Promise<boolean> {
    const written = await this.getRepo(txEm).nativeUpdate(
      { id: runId, title: expected },
      { title },
    );
    return written > 0;
  }

  /**
   * File how full this run's context window is, as the CLI just reported it.
   *
   * A bare `nativeUpdate` rather than `updateById`, and for the ordinary reason
   * rather than `retitle`'s: this fires once per main-thread model response, so
   * it must not read the row, hydrate an entity and flush it — nothing here
   * needs the row's other columns, and loading them would put a whole run entity
   * through the identity map several times a minute.
   *
   * Each half is written only when the reading HAS it, and neither is ever
   * cleared. A reading that carries no window has said nothing about the
   * model's, and overwriting a real denominator with silence leaves the ring a
   * numerator it cannot divide; the mirror image holds for the count. That is
   * also why both are optional rather than one call per pair — claude reports
   * the count on every assistant line and the window on its result line alone,
   * so the two genuinely arrive apart.
   */
  async rememberContext(
    runId: string,
    reading: ContextLevel,
    txEm?: EntityManager,
  ): Promise<void> {
    const data: Partial<Run> = {};
    if (positive(reading.contextTokens)) {
      data.contextTokens = reading.contextTokens;
      data.contextEstimated = reading.contextEstimated === true ? true : null;
    }
    if (positive(reading.contextWindowTokens)) {
      data.contextWindowTokens = reading.contextWindowTokens;
    }
    if (Object.keys(data).length === 0) {
      return;
    }
    await this.getRepo(txEm).nativeUpdate({ id: runId }, data);
  }

  /**
   * Add one turn's worked milliseconds and tool count to this chat's running
   * totals — the run-level twin of `NodeStateDao.rememberWork`, and the
   * accumulating counterpart of {@link rememberContext} above.
   *
   * That one records a LEVEL and overwrites; these are TOTALS, so every write
   * is a fraction of the answer and overwriting would report the last turn's
   * work as the chat's whole history.
   *
   * Read-modify-write rather than a SQL increment, on the same reasoning its
   * node-level twin states: a chat's turns are serialized — one turn per run at
   * a time, enforced by the session registry's own busy check — so the two
   * writes that can touch this row never overlap. A second concurrent writer
   * would need a real increment.
   *
   * Neither figure is cleared by a turn that omits it: a CLI reporting no
   * timing must not erase the time already counted, which is the ordinary case
   * on every ACP agent.
   */
  async rememberWork(
    runId: string,
    workedMs: number | null,
    toolCalls: number | null,
    txEm?: EntityManager,
  ): Promise<void> {
    if (!positive(workedMs) && !positive(toolCalls)) {
      return;
    }
    const row = await this.getRepo(txEm).findOne(
      { id: runId },
      { disableIdentityMap: true },
    );
    if (row === null) {
      return;
    }
    const data: Partial<Run> = {};
    if (positive(workedMs)) {
      data.workedMs = (row.workedMs ?? 0) + workedMs;
    }
    if (positive(toolCalls)) {
      data.toolCalls = (row.toolCalls ?? 0) + toolCalls;
    }
    await this.getRepo(txEm).nativeUpdate({ id: runId }, data);
  }

  /**
   * Move this chat's prompt-cache expiry on to `at` plus the cache's lifetime,
   * as one of its turns ends.
   *
   * `reported` is the lifetime the turn itself reported, with its reason; a
   * turn that reported none — a Stop, a failure, a turn that wrote nothing to
   * the cache — still kept the cache warm with its requests, so the lifetime
   * the run last stated is used instead, and the reason stored with it is kept.
   * A run that has never stated one is left untouched: an expiry nobody
   * measured would put a warning on a CLI with no prompt cache.
   */
  async rememberPromptCache(
    runId: string,
    reported: {
      ttlMs: number | null;
      reason: PromptCacheTtlReason | null;
    },
    at: Date,
    txEm?: EntityManager,
  ): Promise<void> {
    if (positive(reported.ttlMs)) {
      await this.getRepo(txEm).nativeUpdate(
        { id: runId },
        {
          promptCacheTtlMs: reported.ttlMs,
          promptCacheTtlReason: reported.reason,
          promptCacheExpiresAt: new Date(at.getTime() + reported.ttlMs),
        },
      );
      return;
    }
    const row = await this.getRepo(txEm).findOne(
      { id: runId },
      { disableIdentityMap: true },
    );
    if (row === null || !positive(row.promptCacheTtlMs)) {
      return;
    }
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      {
        promptCacheExpiresAt: new Date(at.getTime() + row.promptCacheTtlMs),
      },
    );
  }

  /**
   * The run's CURRENT worked-time and tool-count totals.
   *
   * Read for the settle announce alone (`writeRunStatus`), which is what keeps
   * a client's copy of these columns from freezing at the moment it fetched the
   * run. They are TOTALS the daemon accumulates per turn, so unlike `status` or
   * `title` a client cannot derive the new value from the event that changed
   * it — and nothing else refreshes the row between full listings.
   *
   * `disableIdentityMap` for the reason {@link rememberWork} needs it: that
   * write is a `nativeUpdate`, which the identity map never sees, so a cached
   * entity would answer with the totals as they stood before this very turn.
   */
  async readWork(
    runId: string,
    txEm?: EntityManager,
  ): Promise<SettleFigures | null> {
    const row = await this.getRepo(txEm).findOne(
      { id: runId },
      { disableIdentityMap: true },
    );
    if (row === null) {
      return null;
    }
    return {
      workedMs: row.workedMs,
      toolCalls: row.toolCalls,
      // Moved by every turn's ending, so it rides the same read: the settle is
      // the only moment it changes, and nothing else refreshes a client's row.
      promptCacheExpiresAt: row.promptCacheExpiresAt,
      promptCacheTtlMs: row.promptCacheTtlMs,
      promptCacheTtlReason: row.promptCacheTtlReason,
    };
  }

  /**
   * Every run whose pull-request marker was reached under a capture rule other
   * than `version`, never-scanned runs included, newest first.
   */
  async listOutdatedPullRequestScans(
    version: number,
    txEm?: EntityManager,
  ): Promise<Run[]> {
    return this.getRepo(txEm).find(
      {
        $or: [
          { pullRequestsScanVersion: null },
          { pullRequestsScanVersion: { $ne: version } },
        ],
      },
      { orderBy: { createdAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /**
   * Every run created before `before`, with the fields the memory usage
   * backfill reads: its memory index and whether its payload columns are
   * stamped.
   */
  async listCreatedBefore(
    before: Date,
    txEm?: EntityManager,
  ): Promise<
    Pick<Run, 'id' | 'createdAt' | 'memoryIndex' | 'payloadRefsVersion'>[]
  > {
    return this.getRepo(txEm).find(
      { createdAt: { $lt: before } },
      {
        fields: ['id', 'createdAt', 'memoryIndex', 'payloadRefsVersion'],
        orderBy: { createdAt: 'asc' },
        disableIdentityMap: true,
      },
    );
  }

  /**
   * Every run whose rows were not all stamped with their payload columns under
   * `version`, newest first — the threads opened next are stamped soonest.
   * Archived runs included: unarchiving reads them again.
   */
  async listUnstampedPayloadRefs(
    version: number,
    txEm?: EntityManager,
  ): Promise<string[]> {
    const rows = await this.getRepo(txEm).find(
      {
        $or: [
          { payloadRefsVersion: null },
          { payloadRefsVersion: { $ne: version } },
        ],
      },
      {
        fields: ['id'],
        orderBy: { createdAt: 'desc' },
        disableIdentityMap: true,
      },
    );
    return rows.map((run) => run.id);
  }

  /** Bookkeeping, not activity: a bare `nativeUpdate`, like {@link setResetWakes}. */
  async markPayloadRefs(
    runId: string,
    version: number,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      { payloadRefsVersion: version },
    );
  }

  /**
   * Every run with its newest item seq (soft-deleted rows included, -1 for a
   * run with none) and the seq the boot reconcile last recorded for it. One
   * index-only lookup per run.
   */
  async reconcileMarks(
    txEm?: EntityManager,
  ): Promise<
    { runId: string; newestSeq: number; reconciledThroughSeq: number | null }[]
  > {
    const rows = await (txEm ?? this.em.fork())
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('runs')
      .select((eb) => [
        'runs.id',
        'runs.reconciled_through_seq',
        eb
          .selectFrom('items')
          .select((sub) => sub.fn.max('items.seq').as('seq'))
          .whereRef('items.run_id', '=', 'runs.id')
          .as('newest_seq'),
      ])
      .execute();
    return rows.map((row) => ({
      runId: row.id,
      newestSeq: row.newest_seq == null ? -1 : Number(row.newest_seq),
      reconciledThroughSeq: row.reconciled_through_seq,
    }));
  }

  /** Bookkeeping, not activity: a bare `nativeUpdate`, like {@link setResetWakes}. */
  async markReconciledThrough(
    runId: string,
    seq: number,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      { reconciledThroughSeq: seq },
    );
  }

  /**
   * Which pull requests each of these runs OPENED, keyed by run id.
   *
   * ONE query for a whole board. The tasks module draws a card's pull requests
   * as the result of the work done on it, and a card names a run — so asking
   * per card would be a query per card on every listing, for a column almost
   * every one of them has nothing in.
   *
   * A run with none is ABSENT from the map rather than present with an empty
   * list, which is what lets the caller read a miss as "none": a task pointing
   * at a run that has since been deleted has to answer the same way as one
   * whose transcript opened nothing, and neither is a state worth a branch.
   *
   * `disableIdentityMap` on {@link listChats}' reasoning — a read-only path
   * over rows nothing here will write.
   */
  async pullRequestsOf(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Map<string, RunPullRequest[]>> {
    const ids = [...new Set(runIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.getRepo(txEm).find(
      { id: { $in: ids } },
      {
        // The column and its key: `pullRequests` is JSON TEXT and the rest of a
        // run row is most of what the chat list reads.
        fields: ['id', 'pullRequests'],
        disableIdentityMap: true,
      },
    );
    return pullRequestsByRun(rows);
  }

  async boardFactsOf(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<{
    pullRequests: Map<string, RunPullRequest[]>;
    stages: Map<string, TaskStageLine>;
  }> {
    const stages = new Map<string, TaskStageLine>();
    const ids = [...new Set(runIds)];
    if (ids.length === 0) {
      return { pullRequests: new Map(), stages };
    }
    const rows = await this.getRepo(txEm).find(
      { id: { $in: ids } },
      {
        fields: ['id', 'pullRequests', 'stageProgress'],
        disableIdentityMap: true,
      },
    );
    for (const row of rows) {
      const progress = readRunStageProgress(row.stageProgress);
      if (progress !== null) {
        stages.set(row.id, stageLineOf(progress));
      }
    }
    return { pullRequests: pullRequestsByRun(rows), stages };
  }

  /**
   * Drop the run's context COUNT, because a compaction has just made it
   * describe a conversation that is gone.
   *
   * The one write that clears what {@link rememberContext} refuses to clear,
   * and it is a separate method for exactly that reason: there, an absent
   * figure means the reading said nothing about it; here, geniro knows the
   * figure is wrong. Only the count — the WINDOW is a property of the model
   * and a compaction does not change it, so clearing it would leave a later
   * numerator with nothing to divide by.
   *
   * Nulling rather than replacing, because there is no replacement to write: a
   * compaction geniro performed itself has not run yet (its summary reaches the
   * CLI on the NEXT turn), and one the CLI performed did not always say what it
   * left behind. Inventing the figure is the single thing a context meter must
   * never do.
   */
  async forgetContext(runId: string, txEm?: EntityManager): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      { contextTokens: null, contextEstimated: null },
    );
  }

  /**
   * Record — or, with null, forget — the DEFERRED question card this run is
   * parked on (`Run.pendingQuestion`).
   *
   * A bare `nativeUpdate` on `contextTokens`' own terms: it is a LEVEL rather
   * than a total, so the newest write is the whole truth and one that lands on
   * a run already torn down harmlessly matches nothing.
   */
  async setPendingQuestion(
    runId: string,
    value: string | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      { pendingQuestion: value },
    );
  }

  /**
   * Forget the deferred card this run is parked on, but only if the column
   * still holds exactly `expected` — the text the caller just read and
   * checked. Answers whether it cleared it.
   *
   * A compare-and-swap rather than {@link setPendingQuestion}'s bare write,
   * because the caller is an answer delivery that awaited a file write first:
   * in that window the user may have typed on, and a new turn put a DIFFERENT
   * card in the column. Clearing that one would leave it on screen with
   * nothing to bring it back after a restart.
   */
  async clearPendingQuestionIf(
    runId: string,
    expected: string,
    txEm?: EntityManager,
  ): Promise<boolean> {
    const cleared = await this.getRepo(txEm).nativeUpdate(
      { id: runId, pendingQuestion: expected },
      { pendingQuestion: null },
    );
    return cleared > 0;
  }

  /**
   * Record — or, with null, forget — the usage-limit continues geniro has
   * promised this run and not yet made (`Run.resetWakes`).
   *
   * A bare `nativeUpdate` for the reason {@link setPendingQuestion} gives: the
   * newest write is the whole list, and one landing on a run already torn down
   * harmlessly matches nothing.
   */
  async setResetWakes(
    runId: string,
    value: string | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate({ id: runId }, { resetWakes: value });
  }

  /**
   * Every run holding a promised continue — what the boot rehydration reads,
   * so a daemon restart before the reset does not drop the promise. Archived
   * runs INCLUDED: they hold a promise nothing will keep, and the rehydration
   * is what writes it off.
   */
  async listRunsWithResetWakes(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { resetWakes: { $ne: null } },
      { disableIdentityMap: true },
    );
  }

  /**
   * Replace a run's {@link Run.unrecordedSpend}. A bare `nativeUpdate`, like
   * {@link setResetWakes}: it is bookkeeping about money, not activity in the
   * thread, so it must not move `updatedAt`.
   */
  async setUnrecordedSpend(
    runId: string,
    value: string | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      { unrecordedSpend: value },
    );
  }

  /** One run's {@link Run.unrecordedSpend}, or null for a run that is gone. */
  async unrecordedSpendOf(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    const row = await this.getRepo(txEm).findOne(
      { id: runId },
      { fields: ['unrecordedSpend'], disableIdentityMap: true },
    );
    return row?.unrecordedSpend ?? null;
  }

  /** Replace a run's {@link Run.delegateSpend}, leaving `updatedAt` alone. */
  async setDelegateSpend(
    runId: string,
    value: string | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      { delegateSpend: value },
    );
  }

  /** One run's {@link Run.delegateSpend}, or null for a run that is gone. */
  async delegateSpendOf(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    const row = await this.getRepo(txEm).findOne(
      { id: runId },
      { fields: ['delegateSpend'], disableIdentityMap: true },
    );
    return row?.delegateSpend ?? null;
  }

  /** Every run with delegate figures — what the boot rehydration seeds from. */
  async listRunsWithDelegateSpend(
    txEm?: EntityManager,
  ): Promise<Pick<Run, 'id' | 'delegateSpend'>[]> {
    const rows = await this.getRepo(txEm).find(
      { delegateSpend: { $ne: null } },
      { fields: ['id', 'delegateSpend'], disableIdentityMap: true },
    );
    return rows.map((row) => ({
      id: row.id,
      delegateSpend: row.delegateSpend,
    }));
  }

  /** Every run with spend outstanding — what the boot rehydration seeds from. */
  async listRunsWithUnrecordedSpend(
    txEm?: EntityManager,
  ): Promise<Pick<Run, 'id' | 'unrecordedSpend'>[]> {
    const rows = await this.getRepo(txEm).find(
      { unrecordedSpend: { $ne: null } },
      { fields: ['id', 'unrecordedSpend'], disableIdentityMap: true },
    );
    return rows.map((row) => ({
      id: row.id,
      unrecordedSpend: row.unrecordedSpend,
    }));
  }

  /**
   * Every run parked on a deferred question card — what the boot rehydration
   * reads.
   *
   * Over `runs` rather than `items`, which is the whole reason the column
   * exists: this is one query against a table with a row per conversation,
   * where the transcript-side answer is a scan per run over the largest table
   * in the database.
   */
  async listRunsWithPendingQuestion(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { pendingQuestion: { $ne: null } },
      { disableIdentityMap: true },
    );
  }

  /**
   * Record — or, with null, forget — the standing team proposal card
   * (`Run.pendingTeamProposal`), on {@link setPendingQuestion}'s terms.
   */
  async setPendingTeamProposal(
    runId: string,
    value: string | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      { pendingTeamProposal: value },
    );
  }

  /** Every run standing on a team proposal card — the boot rehydration's read. */
  async listRunsWithPendingTeamProposal(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { pendingTeamProposal: { $ne: null } },
      { disableIdentityMap: true },
    );
  }

  /** A team run's standing project card (`Run.pendingTeamProjectCard`), on {@link setPendingQuestion}'s terms. */
  async setPendingTeamProjectCard(
    runId: string,
    value: string | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      { pendingTeamProjectCard: value },
    );
  }

  /** Every team run standing on a project card — the boot rehydration's read. */
  async listRunsWithPendingTeamProjectCard(
    txEm?: EntityManager,
  ): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { pendingTeamProjectCard: { $ne: null } },
      { disableIdentityMap: true },
    );
  }

  /** A team run's standing member question cards (`Run.pendingMemberQuestions`). */
  async setPendingMemberQuestions(
    runId: string,
    value: string | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      { pendingMemberQuestions: value },
    );
  }

  /** Every team run standing on a member's question card — the boot rehydration's read. */
  async listRunsWithPendingMemberQuestions(
    txEm?: EntityManager,
  ): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { pendingMemberQuestions: { $ne: null } },
      { disableIdentityMap: true },
    );
  }

  /**
   * Move the row's `updatedAt` and nothing else — "the user just did something
   * in this thread".
   *
   * The sidebar orders by that column inside its tier, and only a STATUS write
   * moved it: a message that starts a turn does (`running`), and a settle does,
   * but answering a question card does not — the verdict writes an item, and
   * items never touch the run row. So a thread parked on a question led the
   * list while it was asking and dropped to wherever its turn had STARTED the
   * moment it was answered. REPORTED as "как только я на него ответил, он
   * переместился обратно. То есть он прыгает!", and measured on the reporter's
   * own database: `CI336` was last written at 15:44:21, when its turn began,
   * with three threads written since — so answering sent it from first to
   * fourth.
   *
   * An explicit write rather than a no-op update: `onUpdate` fires when the ORM
   * flushes a CHANGED entity, and every write on this DAO is a `nativeUpdate`
   * that bypasses it — which is correct for the readings beside it (a context
   * figure is not activity) and exactly what this one exists to do on purpose.
   */
  async touch(
    runId: string,
    at: Date = new Date(),
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate({ id: runId }, { updatedAt: at });
  }

  /**
   * The run's `runOutcomes` column as it stands in the database — read past
   * the identity map, because the writer (`RunOutcomeBroker`) and the readers
   * that announce the pull-request list hold different copies of the row.
   */
  async runOutcomesOf(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    const row = await this.getRepo(txEm).findOne(
      { id: runId },
      { fields: ['id', 'runOutcomes'], disableIdentityMap: true },
    );
    return row?.runOutcomes ?? null;
  }

  /**
   * What recording a pull request's outcome reads off its run, in one read
   * past the identity map: the team it ran, the pull-request lists the
   * announce re-projects, and the outcomes column it updates. Null for a
   * run that is gone.
   */
  /** The run's recorded thread outcome column, read alone; null for none or a run that is gone. */
  async threadOutcomeOf(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    const row = await this.getRepo(txEm).findOne(
      { id: runId },
      { fields: ['id', 'threadOutcome'], disableIdentityMap: true },
    );
    return row?.threadOutcome ?? null;
  }

  async outcomeContextOf(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Pick<
    Run,
    'teamId' | 'pullRequests' | 'touchedPullRequests' | 'runOutcomes'
  > | null> {
    const row = await this.getRepo(txEm).findOne(
      { id: runId },
      {
        fields: [
          'id',
          'teamId',
          'pullRequests',
          'touchedPullRequests',
          'runOutcomes',
        ],
        disableIdentityMap: true,
      },
    );
    if (row === null) {
      return null;
    }
    return {
      teamId: row.teamId,
      pullRequests: row.pullRequests,
      touchedPullRequests: row.touchedPullRequests,
      runOutcomes: row.runOutcomes,
    };
  }

  /**
   * Write BOOKKEEPING columns on a run without claiming the run did anything.
   *
   * `updatedAt` is the sidebar's "last activity" — its order and the time each
   * row prints — and `onUpdate` stamps it on every flush of a changed entity.
   * So a write that is about the ROW rather than the conversation moved it too:
   * the pull-request capture pass, which runs over every run the chat list
   * returns, stamped a whole archive at once — REPORTED as every archived
   * thread reading `just now` (and, twelve minutes later, every one reading
   * `12m`), with no way left to tell when any of them was last worked in.
   * Archiving, pinning, filing and renaming are the same kind of write.
   *
   * A `nativeUpdate` bypasses `onUpdate`, as the readings above rely on. What
   * it does not do is tell the identity map, so a managed copy is patched and
   * RE-SNAPSHOTTED here: left stale, the next flush of that fork would see the
   * copy differ from its snapshot, write the columns a second time and stamp
   * `updatedAt` anyway.
   */
  async updateWithoutActivity(
    runId: string,
    data: Partial<Run>,
    txEm?: EntityManager,
  ): Promise<void> {
    const em = txEm ?? this.em;
    await em.nativeUpdate(Run, { id: runId }, data);
    const managed = em.getUnitOfWork().getById<Run>(Run, runId);
    if (managed) {
      Object.assign(managed, data);
      em.getUnitOfWork().merge(managed);
    }
  }

  /**
   * File the last reading taken from this run's agent before its process was
   * closed — see {@link Run.lastMetricsReading}.
   *
   * A bare `nativeUpdate` for `rememberContext`'s reason: nothing here needs
   * the row's other columns, and the caller holds a fork whose entity may
   * predate the session it just said goodbye to.
   */
  async rememberMetricsReading(
    runId: string,
    reading: string | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      { lastMetricsReading: reading },
    );
  }

  /**
   * Write (or clear) the summary a geniro compaction owes this run's next turn
   * — see {@link Run.pendingContext}.
   *
   * A bare `nativeUpdate` for `rememberContext`'s reason: nothing here needs the
   * row's other columns, and the caller is holding a fork whose entity may
   * predate the turn that just settled.
   */
  async setPendingContext(
    runId: string,
    context: string | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      { pendingContext: context },
    );
  }

  /**
   * Take the summary this run is owed, clearing it in the SAME statement, and
   * report what was taken.
   *
   * Read-then-clear rather than a read followed by a write: the column is
   * consumed exactly once, and two turns racing for it — a follow-up delivered
   * as another opens — would otherwise both read the summary and both prepend
   * it. `nativeUpdate` reports how many rows the predicate matched, so the
   * loser is told it took nothing rather than being handed a copy.
   */
  async takePendingContext(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    const repo = this.getRepo(txEm);
    const run = await repo.findOne(
      { id: runId },
      { disableIdentityMap: true, fields: ['pendingContext'] },
    );
    const pending = run?.pendingContext ?? null;
    if (pending === null) {
      return null;
    }
    const cleared = await repo.nativeUpdate(
      { id: runId, pendingContext: pending },
      { pendingContext: null },
    );
    return cleared > 0 ? pending : null;
  }

  /**
   * Chat runs stuck in a non-terminal `running` state — used by the boot-time
   * reconcile to close runs a crash / SIGKILL / restart left mid-turn.
   */
  async listRunningChats(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { teamId: null, status: 'running' },
      { disableIdentityMap: true },
    );
  }

  /**
   * Release every run filed under a group — used when the group is deleted.
   *
   * The runs are UNTOUCHED apart from the column: a folder disappearing must
   * never take a conversation with it, which is the whole reason this exists
   * instead of a cascade. Both run kinds are swept, since the sidebar files
   * chats and team runs into the same groups.
   */
  async clearGroup(groupId: string, txEm?: EntityManager): Promise<number> {
    const runs = await this.getRepo(txEm).find({ groupId });
    for (const run of runs) {
      // The PIN goes with the group, though the chat does not. A pinned
      // position is contiguous within its own scope, so a released run
      // carrying its old number lands in the loose band already holding that
      // slot — two rows claiming one place, in an order the user never made.
      // Clearing is the one outcome that cannot produce a broken band, and it
      // costs an arrangement rather than a conversation.
      //
      // Without touching `updatedAt`: a folder going away is not activity in
      // any of the conversations it held (see `updateWithoutActivity`).
      await this.updateWithoutActivity(
        run.id,
        { groupId: null, pinnedPosition: null },
        txEm,
      );
    }
    return runs.length;
  }

  /**
   * Every PINNED run of one scope — a group, or the loose list when `groupId`
   * is null — in the order the sidebar draws them.
   *
   * The scope is the whole query rather than a filter over every pinned run,
   * because `Run.pinnedPosition` is contiguous WITHIN a scope: two runs in
   * different groups legitimately hold position 0, so a scope-blind read
   * would interleave two bands into one nonsense order.
   *
   * Both run kinds, like {@link clearGroup} and for its reason — the sidebar
   * pins chats and team runs into the same bands. The identity map is
   * deliberately LEFT ON, unlike the read-only listings above: every caller
   * renumbers what it reads and flushes.
   */
  async pinnedInScope(
    groupId: string | null,
    txEm?: EntityManager,
  ): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { groupId, pinnedPosition: { $ne: null } },
      { orderBy: { pinnedPosition: 'asc' } },
    );
  }

  /**
   * Put one run into its scope's pinned band, or take it out, and leave the
   * band contiguous either way.
   *
   * Pinning APPENDS rather than leading the band: the order inside it is the
   * user's own arrangement, and a newly pinned thread shoving itself into
   * first place would move every row they placed there. Pinning a run that is
   * already pinned leaves it exactly where it is, so a replayed request cannot
   * walk a thread to the end of its own band.
   */
  async repin(run: Run, pinned: boolean, txEm?: EntityManager): Promise<void> {
    const next = !pinned
      ? null
      : run.pinnedPosition === null
        ? (await this.pinnedInScope(run.groupId, txEm)).length
        : run.pinnedPosition;
    if (next !== run.pinnedPosition) {
      // A pin is an arrangement of the sidebar, not activity in the thread —
      // see `updateWithoutActivity`.
      await this.updateWithoutActivity(run.id, { pinnedPosition: next }, txEm);
      run.pinnedPosition = next;
    }
    await this.renumberPinned(run.groupId, txEm);
  }

  /**
   * Renumber one scope's pinned band contiguously from 0.
   *
   * Run on every write that touches a band rather than only on the ones that
   * leave a hole, so a band that ever came to share a position — a deleted
   * run, a re-file, a write interrupted half way — is repaired by the next
   * pin. The same self-healing `RunGroupsService.reorder` gives group order.
   */
  async renumberPinned(
    groupId: string | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.applyPinnedOrder(await this.pinnedInScope(groupId, txEm), txEm);
  }

  /**
   * Write one band's ARRANGEMENT: the given runs take positions 0..n-1 in the
   * order they arrive.
   *
   * The order is decided by the caller — which runs, and in what sequence, is
   * policy — while the contiguous numbering and the write are this layer's, so
   * no caller has to know that the column may not have gaps in it.
   */
  async applyPinnedOrder(
    ordered: readonly Run[],
    txEm?: EntityManager,
  ): Promise<void> {
    for (const [position, row] of ordered.entries()) {
      if (row.pinnedPosition === position) {
        continue;
      }
      await this.updateWithoutActivity(
        row.id,
        { pinnedPosition: position },
        txEm,
      );
      row.pinnedPosition = position;
    }
  }

  /**
   * Team runs (team executions), newest first, filtered by how much of the
   * archive the caller asked for.
   *
   * The archive predicate is {@link listChats}' own, down to `all` stating no
   * condition at all — the two listings feed ONE sidebar, so a scope that meant
   * different things on either side of it would put a shelved team run in a
   * view the user opened to see only live work.
   */
  async listTeamRuns(
    scope: ChatListScope,
    txEm?: EntityManager,
    page: RunListPage = {},
  ): Promise<Run[]> {
    return this.listPage(
      { teamId: { $ne: null }, ...scopeFilter(scope) },
      page,
      txEm,
    );
  }

  /**
   * The id of every 1:1 chat run, a team's builder chats and archived
   * chats included — what the wall-work boot sweep walks. Ids only: the sweep
   * reads each chat's rows itself.
   */
  async listChatRunIds(txEm?: EntityManager): Promise<string[]> {
    const rows = await this.getRepo(txEm).find(
      { teamId: null },
      { fields: ['id'], disableIdentityMap: true },
    );
    return rows.map((row) => row.id);
  }

  /**
   * Team runs left in a non-terminal state by a crash / SIGKILL — the
   * team executor's boot reconcile closes them (pending counts too: a
   * team run is created `running`, so anything non-terminal is orphaned).
   */
  async listRunningTeamRuns(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      {
        teamId: { $ne: null },
        status: { $in: ['pending', 'running'] },
      },
      { disableIdentityMap: true },
    );
  }
}

/** An analysis that is the user's own review, not a lessons reflection. */
const REVIEW_PURPOSE: FilterQuery<Run> = {
  $or: [{ analysisPurpose: null }, { analysisPurpose: 'review' }],
};

function dateOf(stored: number | null): Date | null {
  return stored === null ? null : new Date(stored);
}

/** The archive half of a listing's filter; `all` states no condition. */
function scopeFilter(scope: ChatListScope): {
  archivedAt?: { $ne: null } | null;
} {
  return scope === 'all'
    ? {}
    : { archivedAt: scope === 'archived' ? { $ne: null } : null };
}

function pullRequestsByRun(
  rows: readonly { id: string; pullRequests: string | null }[],
): Map<string, RunPullRequest[]> {
  const byRun = new Map<string, RunPullRequest[]>();
  for (const row of rows) {
    const captured = readRunPullRequests(row.pullRequests);
    if (captured.length > 0) {
      byRun.set(row.id, captured);
    }
  }
  return byRun;
}

function archivedAtOrBefore(cutoff: Date): FilterQuery<Run> {
  return { archivedAt: { $ne: null, $lte: cutoff }, pendingDeleteAt: null };
}
