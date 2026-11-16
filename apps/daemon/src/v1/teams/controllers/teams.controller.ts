import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Optional,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { cameViaRemote } from '../../../auth/remote-marker';
import type {
  ActionPressWire,
  ItemWire,
  RunWire,
  ThreadAnalysisWire,
} from '../../agents/chat.types';
import {
  ActionPressDto,
  AnalyzeTeamDto,
  CancelledDto,
  DeleteRunQueryDto,
  ItemDto,
  ListChatsQueryDto,
  PressActionDto,
  RunDto,
  SendMessageDto,
  ThreadAnalysisDto,
} from '../../agents/dto/chat.dto';
import { ExtractLessonsOnDeleteRegistry } from '../../agents/services/extract-lessons-on-delete.registry';
import { runListPageOf } from '../../agents/utils/run-list-page';
import type { KnowledgeRenamed } from '../../projects/projects.types';
import {
  AnalysisJudgeCheckDto,
  AnalysisJudgeQueryDto,
  CreateTeamDto,
  DeleteTeamOverlayQueryDto,
  DeleteTeamQueryDto,
  ExportedDto,
  ExportTeamDto,
  ImportTeamDto,
  InstructionSizesDto,
  MeasureInstructionSizesDto,
  MemberHealthDto,
  MoveTeamRunStageDto,
  NodeStateDto,
  ProjectTeamOverlaysDto,
  ResetWakesCancelledDto,
  RunTeamDto,
  RunTeamSnapshotDto,
  SaveTeamDto,
  SaveTeamOverlayDto,
  SetPoolMemberResultDto,
  SetTeamRunPoolMemberDto,
  StageMoveResultDto,
  StartTeamChatDto,
  TeamAvatarDataDto,
  TeamAvatarIdDto,
  TeamChatsDiscardedDto,
  TeamDeletedDto,
  TeamFileDto,
  TeamHealthDto,
  TeamHealthQueryDto,
  TeamOverlayDto,
  TeamOverlayScopesDto,
  TeamRemovedDto,
  TeamSummaryDto,
  UploadTeamAvatarDto,
} from '../dto/teams.dto';
import { AnalysisJudgeService } from '../services/analysis-judge.service';
import { AvatarStoreService } from '../services/avatar-store.service';
import { InstructionSizesService } from '../services/instruction-sizes.service';
import { RunTeamService } from '../services/run-team.service';
import { StageWakeService } from '../services/stage-wake.service';
import { TeamActionsService } from '../services/team-actions.service';
import { TeamAnalysisService } from '../services/team-analysis.service';
import { TeamChatService } from '../services/team-chat.service';
import { TeamExecutorService } from '../services/team-executor.service';
import { TeamHealthService } from '../services/team-health.service';
import { TeamOverlayService } from '../services/team-overlay.service';
import { TeamStoreService } from '../services/team-store.service';
import type {
  AnalysisJudgeCheckWire,
  InstructionSizesWire,
  MemberHealth,
  NodeStateWire,
  ProjectTeamOverlay,
  ResetWakesCancelled,
  RunTeamSnapshotWire,
  SetPoolMemberResult,
  StageMoveResultWire,
  TeamHealth,
  TeamOverlayScope,
  TeamOverlayWire,
  TeamSummary,
  TeamWire,
} from '../teams.types';

/**
 * Loopback team REST surface (token-gated by the global
 * LoopbackTokenGuard): library CRUD over the `*.team.yaml` files plus the
 * run endpoints that hand a team to the executor. The static `runs`
 * routes are declared before the `:slug` routes so Nest never captures "runs"
 * as a slug. Run transcripts replay over the existing
 * `GET /v1/chats/:runId/items` history read (items are run-scoped, not
 * team-scoped) and stream over `/ws`.
 */
@Controller('v1/teams')
@ApiTags('teams')
@ApiBearerAuth()
export class TeamsController {
  constructor(
    private readonly store: TeamStoreService,
    private readonly executor: TeamExecutorService,
    private readonly runTeams: RunTeamService,
    private readonly teamChats: TeamChatService,
    private readonly actions: TeamActionsService,
    private readonly instructionSizes: InstructionSizesService,
    private readonly teamAnalyses: TeamAnalysisService,
    private readonly analysisJudge: AnalysisJudgeService,
    private readonly stageWakes: StageWakeService,
    private readonly avatars: AvatarStoreService,
    private readonly health: TeamHealthService,
    private readonly overlays: TeamOverlayService,
    @Optional()
    private readonly extractLessons?: ExtractLessonsOnDeleteRegistry,
  ) {}

  /**
   * `ListChatsQueryDto` rather than a query type of this module's own: the
   * scope is ONE vocabulary — the sidebar lists chats and team runs
   * together and sends both halves the same answer — and a second spelling of
   * it is how the two would come to disagree about what `all` means.
   */
  @Get('runs')
  @ApiOperation({ operationId: 'listTeamRuns' })
  @ZodResponse({ status: 200, type: [RunDto] })
  listRuns(@Query() query: ListChatsQueryDto): Promise<RunWire[]> {
    return this.executor.listRuns(
      query.scope ?? 'active',
      runListPageOf(query),
    );
  }

  @Get('runs/:runId/nodes')
  @ApiOperation({ operationId: 'listTeamRunNodes' })
  @ZodResponse({ status: 200, type: [NodeStateDto] })
  getRunNodes(@Param('runId') runId: string): Promise<NodeStateWire[]> {
    return this.executor.getNodeStates(runId);
  }

  /**
   * Run a member's own conversation on one pool member of its agent pool and
   * pin it there — at once while it is idle, from its next turn while a turn
   * of it runs.
   */
  @Put('runs/:runId/members/:memberId/pool-member')
  @ApiOperation({ operationId: 'setTeamRunPoolMember' })
  @ZodResponse({ status: 200, type: SetPoolMemberResultDto })
  setPoolMember(
    @Param('runId') runId: string,
    @Param('memberId') memberId: string,
    @Body() dto: SetTeamRunPoolMemberDto,
  ): Promise<SetPoolMemberResult> {
    return this.executor.setOwnPoolMember(runId, memberId, dto.member);
  }

  /**
   * The team THIS run runs — the copy it keeps, never the library's current
   * one, so editing a team changes no run already made from it. A run made
   * before runs kept a copy takes one on this first read.
   */
  @Get('runs/:runId/team')
  @ApiOperation({ operationId: 'getTeamRunSnapshot' })
  @ZodResponse({ status: 200, type: RunTeamSnapshotDto })
  getRunTeam(@Param('runId') runId: string): Promise<RunTeamSnapshotWire> {
    return this.runTeams.snapshotOfRun(runId);
  }

  @Post('runs/:runId/cancel')
  @ApiOperation({ operationId: 'cancelTeamRun' })
  @ZodResponse({ status: 200, type: CancelledDto })
  cancelRun(@Param('runId') runId: string): Promise<{ cancelled: boolean }> {
    return this.executor.cancel(runId);
  }

  /**
   * Call off the continues geniro promised this run at a usage-limit reset —
   * the user would rather pick the team up themselves.
   */
  @Post('runs/:runId/reset-wakes/cancel')
  @ApiOperation({ operationId: 'cancelTeamRunResetWakes' })
  @ZodResponse({ status: 200, type: ResetWakesCancelledDto })
  cancelResetWakes(
    @Param('runId') runId: string,
  ): Promise<ResetWakesCancelled> {
    return this.executor.cancelResetWakes(runId);
  }

  /**
   * A follow-up message for a team run — it goes to the agents the run's
   * trigger feeds, as though the trigger had fired again with this text.
   * Answers with the persisted message row, like the chat route's twin.
   */
  @Post('runs/:runId/messages')
  @ApiOperation({ operationId: 'sendTeamRunMessage' })
  @ZodResponse({ status: 201, type: ItemDto })
  sendMessage(
    @Param('runId') runId: string,
    @Body() dto: SendMessageDto,
  ): Promise<ItemWire> {
    return this.executor.sendMessage(
      runId,
      dto.text,
      dto.images,
      dto.clientMessageId,
      dto.backgroundWork,
    );
  }

  @Post('runs/:runId/stages')
  @ApiOperation({ operationId: 'moveTeamRunStage' })
  @ZodResponse({ status: 201, type: StageMoveResultDto })
  moveStage(
    @Param('runId') runId: string,
    @Body() dto: MoveTeamRunStageDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<StageMoveResultWire> {
    return this.stageWakes.userMove(
      runId,
      {
        action: dto.action,
        stage: dto.stage,
        ...(dto.next !== undefined ? { next: dto.next } : {}),
        text: dto.text,
      },
      cameViaRemote(headers) ? 'remote' : 'desktop',
      dto.expectedRev,
    );
  }

  /**
   * A press of an agent's button in a team run: a message action goes to
   * the agents the run's trigger feeds, prefixed with who published it when
   * that was another agent. Refusals are the chat route's twin, the run's own
   * `RUN_BUSY` included, after which the same press may be repeated.
   */
  @Post('runs/:runId/actions/:seq/press')
  @ApiOperation({ operationId: 'pressTeamAction' })
  @ApiParam({ name: 'seq', type: Number })
  @ZodResponse({ status: 201, type: ActionPressDto })
  pressAction(
    @Param('runId') runId: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Body() dto: PressActionDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<ActionPressWire> {
    return this.actions.press(
      runId,
      seq,
      dto.clientMessageId,
      cameViaRemote(headers) ? 'remote' : 'desktop',
    );
  }

  /** Takes an agent's button off a team run; no agent is told. */
  @Post('runs/:runId/actions/:seq/dismiss')
  @ApiOperation({ operationId: 'dismissTeamAction' })
  @ApiParam({ name: 'seq', type: Number })
  @ZodResponse({ status: 201, type: ActionPressDto })
  dismissAction(
    @Param('runId') runId: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<ActionPressWire> {
    return this.actions.dismiss(
      runId,
      seq,
      cameViaRemote(headers) ? 'remote' : 'desktop',
    );
  }

  /**
   * A message straight to the callee of one RUNNING call, past its caller.
   * 409 `CALL_NOT_RUNNING` once the call has settled or the member is not its
   * callee, `CALL_MESSAGE_REFUSED` when the callee's CLI cannot take a message
   * mid-turn.
   */
  @Post('runs/:runId/nodes/:memberId/calls/:callId/messages')
  @ApiOperation({ operationId: 'sendTeamCallMessage' })
  @ZodResponse({ status: 201, type: ItemDto })
  sendCallMessage(
    @Param('runId') runId: string,
    @Param('memberId') memberId: string,
    @Param('callId') callId: string,
    @Body() dto: SendMessageDto,
  ): Promise<ItemWire> {
    return this.executor.sendCallMessage(
      runId,
      memberId,
      callId,
      dto.text,
      dto.images,
      dto.clientMessageId,
    );
  }

  /**
   * Destructive and irreversible — the team-run half of the chats
   * sidebar's delete (its chat rows go to `DELETE /v1/chats/:runId`). The
   * LIBRARY team is untouched: this deletes one run's history, not the
   * team it ran.
   */
  @Delete('runs/:runId')
  @ApiOperation({ operationId: 'deleteTeamRun' })
  @ZodResponse({ status: 200, type: TeamDeletedDto })
  async deleteRun(
    @Param('runId') runId: string,
    @Query() query: DeleteRunQueryDto,
  ): Promise<{ deleted: boolean }> {
    if (query.extractLessons === 'true') {
      const taken = await this.extractLessons?.extract(runId);
      if (taken != null) {
        return taken;
      }
    }
    return this.executor.deleteRun(runId);
  }

  @Get()
  @ApiOperation({ operationId: 'listTeams' })
  @ZodResponse({ status: 200, type: [TeamSummaryDto] })
  list(): Promise<TeamSummary[]> {
    return this.store.list();
  }

  @Post()
  @ApiOperation({ operationId: 'createTeam' })
  @ZodResponse({ status: 201, type: TeamFileDto })
  create(@Body() dto: CreateTeamDto): Promise<TeamWire> {
    return this.store.create(dto.team, dto.slug);
  }

  @Post('import')
  @ApiOperation({ operationId: 'importTeam' })
  @ZodResponse({ status: 201, type: TeamFileDto })
  import(@Body() dto: ImportTeamDto): Promise<TeamWire> {
    return this.store.importFrom(dto.path);
  }

  @Post('instruction-sizes')
  @ApiOperation({ operationId: 'measureInstructionSizes' })
  @ZodResponse({ status: 200, type: InstructionSizesDto })
  measureInstructionSizes(
    @Body() dto: MeasureInstructionSizesDto,
  ): InstructionSizesWire {
    return this.instructionSizes.measureFor(dto);
  }

  @Post('avatars')
  @ApiOperation({ operationId: 'uploadTeamAvatar' })
  @ZodResponse({ status: 201, type: TeamAvatarIdDto })
  async uploadAvatar(
    @Body() dto: UploadTeamAvatarDto,
  ): Promise<{ id: string }> {
    return {
      id: await this.avatars.save(Buffer.from(dto.data, 'base64')),
    };
  }

  @Get('avatars/:id')
  @ApiOperation({ operationId: 'getTeamAvatar' })
  @ZodResponse({ status: 200, type: TeamAvatarDataDto })
  async getAvatar(@Param('id') id: string): Promise<{ dataUri: string }> {
    const { mediaType, base64 } = await this.avatars.read(id);
    return { dataUri: `data:${mediaType};base64,${base64}` };
  }

  @Get(':slug')
  @ApiOperation({ operationId: 'getTeam' })
  @ZodResponse({ status: 200, type: TeamFileDto })
  get(@Param('slug') slug: string): Promise<TeamWire> {
    return this.store.get(slug);
  }

  /**
   * How well each member is set up. `probe=true` (the team page only) also
   * asks `AgentMcpService` to list each distinct profile's MCP servers, which
   * launches the user's servers behind its cache and single-flight; without
   * it nothing is dialled.
   */
  @Get(':slug/health')
  @ApiOperation({ operationId: 'readTeamHealth' })
  @ZodResponse({ status: 200, type: TeamHealthDto })
  readHealth(
    @Param('slug') slug: string,
    @Query() query: TeamHealthQueryDto,
  ): Promise<TeamHealth> {
    return this.health.health(
      slug,
      query.probe === 'true',
      query.projectId ?? null,
    );
  }

  @Get(':slug/members/:memberId/health')
  @ApiOperation({ operationId: 'readMemberHealth' })
  @ZodResponse({ status: 200, type: MemberHealthDto })
  readMemberHealth(
    @Param('slug') slug: string,
    @Param('memberId') memberId: string,
    @Query() query: TeamHealthQueryDto,
  ): Promise<MemberHealth> {
    return this.health.memberHealth(
      slug,
      memberId,
      query.probe === 'true',
      query.projectId ?? null,
    );
  }

  /** Every team's overlay one project holds: its default team's, then the ones it kept of teams it no longer defaults to. */
  @Get('project-overlays/:projectId')
  @ApiOperation({ operationId: 'listProjectTeamOverlays' })
  @ZodResponse({ status: 200, type: ProjectTeamOverlaysDto })
  async listProjectOverlays(
    @Param('projectId') projectId: string,
  ): Promise<{ overlays: ProjectTeamOverlay[] }> {
    return { overlays: await this.overlays.forProject(projectId) };
  }

  /**
   * The projects this team serves: every project whose default team it is
   * (its overlay applies to its runs), then every project still holding an
   * overlay of it while defaulting to something else (inactive).
   */
  @Get(':slug/overlays')
  @ApiOperation({ operationId: 'listTeamOverlays' })
  @ZodResponse({ status: 200, type: TeamOverlayScopesDto })
  async listOverlays(
    @Param('slug') slug: string,
  ): Promise<{ scopes: TeamOverlayScope[] }> {
    return { scopes: await this.overlays.scopes(slug) };
  }

  /** One project's overlay of this team; an empty overlay with a null hash when it has none yet. */
  @Get(':slug/overlays/:projectId')
  @ApiOperation({ operationId: 'getTeamOverlay' })
  @ZodResponse({ status: 200, type: TeamOverlayDto })
  getOverlay(
    @Param('slug') slug: string,
    @Param('projectId') projectId: string,
  ): Promise<TeamOverlayWire> {
    return this.overlays.get(slug, projectId);
  }

  /** Write one project's overlay; 409 `TEAM_OVERLAY_CHANGED` over a newer file, 400 `TEAM_OVERLAY_INVALID` when the team would not run with it. */
  @Put(':slug/overlays/:projectId')
  @ApiOperation({ operationId: 'saveTeamOverlay' })
  @ZodResponse({ status: 200, type: TeamOverlayDto })
  saveOverlay(
    @Param('slug') slug: string,
    @Param('projectId') projectId: string,
    @Body() dto: SaveTeamOverlayDto,
  ): Promise<TeamOverlayWire> {
    return this.overlays.save(slug, projectId, dto.overlay, dto.baseHash);
  }

  /** Remove one project's overlay of this team, after a backup. */
  @Delete(':slug/overlays/:projectId')
  @ApiOperation({ operationId: 'deleteTeamOverlay' })
  @ZodResponse({ status: 200, type: TeamDeletedDto })
  deleteOverlay(
    @Param('slug') slug: string,
    @Param('projectId') projectId: string,
    @Query() query: DeleteTeamOverlayQueryDto,
  ): Promise<{ deleted: boolean }> {
    return this.overlays.remove(slug, projectId, query.baseHash);
  }

  @Put(':slug')
  @ApiOperation({ operationId: 'saveTeam' })
  @ZodResponse({ status: 200, type: TeamFileDto })
  save(
    @Param('slug') slug: string,
    @Body() dto: SaveTeamDto,
  ): Promise<TeamWire> {
    return this.store.save(slug, dto.team, dto.baseHash);
  }

  /**
   * Through `TeamChatService` rather than the store, because deleting a
   * team also destroys the builder chat about it — a conversation whose
   * agent still carries a brief naming a file that is gone.
   */
  @Delete(':slug')
  @ApiOperation({ operationId: 'deleteTeam' })
  @ZodResponse({ status: 200, type: TeamRemovedDto })
  async delete(
    @Param('slug') slug: string,
    @Query() query: DeleteTeamQueryDto,
  ): Promise<{
    deleted: boolean;
    knowledgeRenamed: KnowledgeRenamed[];
  }> {
    const knowledgeRenamed = await this.teamChats.deleteTeam(
      slug,
      query.memories ?? 'keep',
      query.knowledge ?? 'global',
    );
    return { deleted: true, knowledgeRenamed };
  }

  /**
   * The builder chat panel's conversation about this team — the one
   * already open, or a new one started with the composer's chips. The chips
   * are read only when there is nothing to reopen; changing an open chat's
   * agent or model is `PATCH /v1/chats/:runId`.
   */
  @Post(':slug/chat')
  @ApiOperation({ operationId: 'openTeamChat' })
  @ZodResponse({ status: 201, type: RunDto })
  openChat(
    @Param('slug') slug: string,
    @Body() dto: StartTeamChatDto,
  ): Promise<RunWire> {
    return this.teamChats.open(slug, dto);
  }

  /**
   * **Destructive and irreversible**: throw away the conversation about this
   * team so the next open starts a fresh one. The team itself is
   * untouched.
   */
  @Delete(':slug/chat')
  @ApiOperation({ operationId: 'discardTeamChat' })
  @ZodResponse({ status: 200, type: TeamChatsDiscardedDto })
  discardChat(@Param('slug') slug: string): Promise<{ deleted: number }> {
    return this.teamChats.discard(slug);
  }

  /**
   * This team's analysis — the chat its "Analyze & improve" popup opens —
   * or `analysis: null` while it has none. 404 for a team the library
   * does not hold.
   */
  @Get(':slug/analysis')
  @ApiOperation({ operationId: 'getTeamAnalysis' })
  @ZodResponse({ status: 200, type: ThreadAnalysisDto })
  async getAnalysis(@Param('slug') slug: string): Promise<ThreadAnalysisWire> {
    return { analysis: await this.teamAnalyses.find(slug) };
  }

  /**
   * Whether an analysis run as `agent` / `model` would judge members that
   * run the same vendor's models — the dialog's hint to pick another judge.
   * 404 for a team the library does not hold.
   */
  @Get(':slug/analysis-judge')
  @ApiOperation({ operationId: 'checkTeamAnalysisJudge' })
  @ZodResponse({ status: 200, type: AnalysisJudgeCheckDto })
  checkAnalysisJudge(
    @Param('slug') slug: string,
    @Query() query: AnalysisJudgeQueryDto,
  ): Promise<AnalysisJudgeCheckWire> {
    return this.analysisJudge.check(slug, query);
  }

  /**
   * Start this team's analysis ("Analyze & improve") over its `runs`
   * newest runs, replacing the one it had. 409 `ANALYSIS_NO_RUNS` for a
   * team never run, `ANALYSIS_FOLDER_GONE` until a folder that exists is
   * sent as `cwd`.
   */
  @Post(':slug/analyses')
  @ApiOperation({ operationId: 'analyzeTeam' })
  @ZodResponse({ status: 201, type: RunDto })
  analyze(
    @Param('slug') slug: string,
    @Body() dto: AnalyzeTeamDto,
  ): Promise<RunWire> {
    return this.teamAnalyses.start(slug, dto);
  }

  @Post(':slug/export')
  @ApiOperation({ operationId: 'exportTeam' })
  @ZodResponse({ status: 200, type: ExportedDto })
  async export(
    @Param('slug') slug: string,
    @Body() dto: ExportTeamDto,
  ): Promise<{ exported: boolean }> {
    await this.store.exportTo(slug, dto.path);
    return { exported: true };
  }

  @Post(':slug/runs')
  @ApiOperation({ operationId: 'startTeamRun' })
  @ZodResponse({ status: 201, type: RunDto })
  run(@Param('slug') slug: string, @Body() dto: RunTeamDto): Promise<RunWire> {
    return this.executor.startRunBySlug(slug, dto);
  }
}
