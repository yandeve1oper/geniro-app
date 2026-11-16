import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Optional,
  Param,
  ParseIntPipe,
  Patch,
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
  AppProcessesWire,
  AttachmentDataWire,
  CallMessagesWire,
  ChatExportWire,
  ChatHistoryWire,
  ChatMetricsWire,
  ChatSearchResult,
  ChatTimelineWire,
  ChatTotalsResponse,
  ChatUploadWire,
  ItemWire,
  LocalImageWire,
  RunArtifactsWire,
  RunOutcomesWire,
  RunProcessesWire,
  RunSeenWire,
  RunStateWire,
  RunTeamNotesWire,
  RunWaterfallWire,
  RunWire,
  ShellKillWire,
  ShellOutputWire,
  StoppedDetachedProcesses,
  ThreadAnalysisWire,
  ThreadOverviewWire,
} from '../chat.types';
import {
  ActionPressDto,
  AnalyzeThreadDto,
  ApplyRecommendationsDto,
  AppProcessesDto,
  AttachmentDataDto,
  CallMessagesDto,
  CallMessagesQueryDto,
  CancelledDto,
  ChatDeletedDto,
  ChatExportDto,
  ChatHistoryDto,
  ChatMetricsDto,
  ChatMetricsQueryDto,
  ChatSearchResultDto,
  ChatTimelineDto,
  ChatTotalsDto,
  ChatUploadDto,
  CreateChatDto,
  DeleteRunQueryDto,
  ForgottenInstructionsDto,
  HistoryQueryDto,
  ItemDto,
  ListChatsQueryDto,
  LocalImageDto,
  LocalImageQueryDto,
  NamedPathsDto,
  NamedPathsResultDto,
  PressActionDto,
  RenameRunDto,
  RetriedDto,
  RunArtifactsDto,
  RunDto,
  RunOutcomesDto,
  RunProcessesDto,
  RunSeenDto,
  RunStateDto,
  RunTeamNotesDto,
  RunWaterfallDto,
  SearchChatQueryDto,
  SendMessageDto,
  SetRunNotesDto,
  ShellKillDto,
  ShellKillQueryDto,
  ShellOutputDto,
  ShellOutputQueryDto,
  StopDetachedProcessesDto,
  StoppedDetachedProcessesDto,
  SweepArchivedDto,
  SweptArchivedDto,
  ThreadAnalysisDto,
  ThreadOverviewDto,
  ThreadOverviewQueryDto,
  UpdateChatSettingsDto,
  UploadChatFileDto,
} from '../dto/chat.dto';
import { SetRunColorDto } from '../dto/run-color.dto';
import { SetRunGroupDto } from '../dto/run-group.dto';
import { ReorderPinnedDto, SetRunPinnedDto } from '../dto/run-pin.dto';
import { ActionPressService } from '../services/action-press.service';
import { ChatService } from '../services/chat.service';
import { ChatArtifactsService } from '../services/chat-artifacts.service';
import { ChatExportService } from '../services/chat-export.service';
import { ChatHistoryService } from '../services/chat-history.service';
import { ChatMetricsService } from '../services/chat-metrics.service';
import { ChatRunOutcomesService } from '../services/chat-run-outcomes.service';
import { ChatSearchService } from '../services/chat-search.service';
import { ChatShellsService } from '../services/chat-shells.service';
import { ChatTeamNotesService } from '../services/chat-team-notes.service';
import { ChatTimelineService } from '../services/chat-timeline.service';
import { ChatUploadStoreService } from '../services/chat-upload-store.service';
import { ChatWaterfallService } from '../services/chat-waterfall.service';
import { ExtractLessonsOnDeleteRegistry } from '../services/extract-lessons-on-delete.registry';
import { LocalImageService } from '../services/local-image.service';
import { RecommendationsApplyService } from '../services/recommendations-apply.service';
import { RunNamedPathsService } from '../services/run-named-paths.service';
import { RunProcessesService } from '../services/run-processes.service';
import { RunStateService } from '../services/run-state.service';
import { ShellOutputService } from '../services/shell-output.service';
import { ThreadAnalysisService } from '../services/thread-analysis.service';
import { ThreadOverviewService } from '../services/thread-overview.service';
import { historyConversationOf } from '../utils/history-conversation';
import { runListPageOf } from '../utils/run-list-page';

/**
 * Loopback chat REST surface (token-gated by the global LoopbackTokenGuard).
 * Commands and history are HTTP; the streamed transcript arrives over the `/ws`
 * Socket.IO channel. Inputs are validated by the global Zod pipe; every
 * response is declared with `@ZodResponse`, which type-checks the handler's
 * return value against the schema, serializes it through that schema, and
 * publishes it to the OpenAPI document the renderer's client is generated from.
 */
@Controller('v1/chats')
@ApiTags('chats')
@ApiBearerAuth()
export class ChatController {
  constructor(
    private readonly artifacts: ChatArtifactsService,
    private readonly teamNotes: ChatTeamNotesService,
    private readonly runOutcomes: ChatRunOutcomesService,
    private readonly chatService: ChatService,
    private readonly chatExport: ChatExportService,
    private readonly history: ChatHistoryService,
    private readonly localImages: LocalImageService,
    private readonly metrics: ChatMetricsService,
    private readonly search: ChatSearchService,
    private readonly namedPaths: RunNamedPathsService,
    private readonly shellOutput: ShellOutputService,
    private readonly shells: ChatShellsService,
    private readonly timeline: ChatTimelineService,
    private readonly uploads: ChatUploadStoreService,
    private readonly waterfall: ChatWaterfallService,
    private readonly processes: RunProcessesService,
    private readonly runState: RunStateService,
    private readonly analyses: ThreadAnalysisService,
    private readonly overview: ThreadOverviewService,
    private readonly recommendations: RecommendationsApplyService,
    private readonly actionPresses: ActionPressService,
    @Optional()
    private readonly extractLessons?: ExtractLessonsOnDeleteRegistry,
  ) {}

  @Post()
  @ApiOperation({ operationId: 'createChat' })
  @ZodResponse({ status: 201, type: RunDto })
  createChat(@Body() dto: CreateChatDto): Promise<RunWire> {
    return this.chatService.createChat(dto);
  }

  @Get()
  @ApiOperation({ operationId: 'listChats' })
  @ZodResponse({ status: 200, type: [RunDto] })
  listChats(@Query() query: ListChatsQueryDto): Promise<RunWire[]> {
    return this.chatService.listChats(
      query.scope ?? 'active',
      runListPageOf(query),
    );
  }

  /**
   * Forget the custom instructions every existing run snapshotted.
   *
   * Declared BEFORE the `:runId` routes so `forget-custom-instructions` is
   * never read as a run id — the same ordering `/v1/groups/reorder` needs.
   */
  @Post('forget-custom-instructions')
  @ApiOperation({ operationId: 'forgetCustomInstructions' })
  @ZodResponse({ status: 200, type: ForgottenInstructionsDto })
  forgetCustomInstructions(): Promise<{ cleared: number }> {
    return this.chatService.forgetCustomInstructions();
  }

  /**
   * Permanently delete every chat archived longer ago than the body says.
   *
   * Declared BEFORE the `:runId` routes for the reason its neighbour is, and a
   * POST rather than a DELETE for a plainer one: it names no resource. The
   * retention window is the CLIENT's because the setting lives in the Electron
   * process's own `settings.json`, which this daemon never opens — so a user
   * who has switched the sweep off is simply a client that never calls this.
   */
  @Post('sweep-archived')
  @ApiOperation({ operationId: 'sweepArchivedChats' })
  @ZodResponse({ status: 200, type: SweptArchivedDto })
  sweepArchived(@Body() dto: SweepArchivedDto): Promise<{ deleted: number }> {
    return this.chatService.sweepArchived(dto.olderThanDays);
  }

  /**
   * Rearrange one scope's pinned band, and answer with it.
   *
   * Declared BEFORE the `:runId` routes so `reorder-pinned` is never read as a
   * run id, like its two neighbours above. It names no run in the path because
   * it is about a BAND rather than a row — the scope is in the body beside the
   * order it applies to.
   */
  @Post('reorder-pinned')
  @ApiOperation({ operationId: 'reorderPinnedRuns' })
  @ZodResponse({ status: 200, type: [RunDto] })
  reorderPinned(@Body() dto: ReorderPinnedDto): Promise<RunWire[]> {
    return this.chatService.reorderPinned(dto.groupId, dto.ids);
  }

  /**
   * What the whole app is running right now, by thread, plus geniro's own
   * share — the title bar's usage readout. Declared BEFORE the `:runId`
   * routes so `processes` is never read as a run id.
   */
  @Get('processes')
  @ApiOperation({ operationId: 'readAppProcesses' })
  @ZodResponse({ status: 200, type: AppProcessesDto })
  readAppProcesses(): Promise<AppProcessesWire> {
    return this.processes.readAll();
  }

  @Patch(':runId')
  @ApiOperation({ operationId: 'renameRun' })
  @ZodResponse({ status: 200, type: RunDto })
  rename(
    @Param('runId') runId: string,
    @Body() dto: RenameRunDto,
  ): Promise<RunWire> {
    return this.chatService.rename(runId, dto.title);
  }

  @Patch(':runId/notes')
  @ApiOperation({ operationId: 'setRunNotes' })
  @ZodResponse({ status: 200, type: RunDto })
  setNotes(
    @Param('runId') runId: string,
    @Body() dto: SetRunNotesDto,
  ): Promise<RunWire> {
    return this.chatService.setNotes(runId, dto.notes);
  }

  @Post(':runId/seen')
  @ApiOperation({ operationId: 'markRunSeen' })
  @ZodResponse({ status: 200, type: RunSeenDto })
  markSeen(@Param('runId') runId: string): Promise<RunSeenWire> {
    return this.chatService.markSeen(runId);
  }

  @Patch(':runId/settings')
  @ApiOperation({ operationId: 'updateChatSettings' })
  @ZodResponse({ status: 200, type: RunDto })
  updateSettings(
    @Param('runId') runId: string,
    @Body() dto: UpdateChatSettingsDto,
  ): Promise<RunWire> {
    return this.chatService.updateSettings(runId, dto);
  }

  /**
   * File this run into a sidebar group, or out of every group (`null`).
   *
   * On the RUN's route rather than the group's because the run is what changes
   * and what the answer is — the sidebar replaces the row it already holds. The
   * group routes own the groups themselves (`/v1/groups`).
   */
  @Put(':runId/group')
  @ApiOperation({ operationId: 'setRunGroup' })
  @ZodResponse({ status: 200, type: RunDto })
  setGroup(
    @Param('runId') runId: string,
    @Body() dto: SetRunGroupDto,
  ): Promise<RunWire> {
    return this.chatService.setGroup(runId, dto.groupId);
  }

  /**
   * Pin this run to the top of its own scope, or unpin it.
   *
   * On the RUN's route for {@link setGroup}'s reason, and beside it because it
   * is the same kind of fact: where the sidebar draws this thread. The scope
   * is the run's own group, or the loose list when it belongs to none — so
   * pinning never moves a thread out of the folder it is filed under.
   *
   * It answers with every run the write RE-SEATED — the scope's band plus the
   * pressed row — where its `setGroup` neighbour answers with one run: a pin
   * renumbers rows the caller did not name, and a client left holding their
   * old positions draws an order neither side chose.
   */
  @Put(':runId/pin')
  @ApiOperation({ operationId: 'setRunPinned' })
  @ZodResponse({ status: 200, type: [RunDto] })
  setPinned(
    @Param('runId') runId: string,
    @Body() dto: SetRunPinnedDto,
  ): Promise<RunWire[]> {
    return this.chatService.setPinned(runId, dto.pinned);
  }

  /**
   * Tint this run's sidebar row with a palette colour, or clear it (`null`).
   * On the RUN's route beside {@link setPinned}, for the same reason: it is how
   * the sidebar draws the thread.
   */
  @Put(':runId/color')
  @ApiOperation({ operationId: 'setRunColor' })
  @ZodResponse({ status: 200, type: RunDto })
  setColor(
    @Param('runId') runId: string,
    @Body() dto: SetRunColorDto,
  ): Promise<RunWire> {
    return this.chatService.setColor(runId, dto.color);
  }

  @Get(':runId/items')
  @ApiOperation({ operationId: 'listRunItems' })
  @ZodResponse({ status: 200, type: ChatHistoryDto })
  getHistory(
    @Param('runId') runId: string,
    @Query() query: HistoryQueryDto,
  ): Promise<ChatHistoryWire> {
    return this.history.read(
      runId,
      query.afterSeq ?? -1,
      query.limit === undefined
        ? undefined
        : {
            limit: query.limit,
            beforeSeq: query.beforeSeq,
            take: query.take,
            probe: query.probe === 'true',
          },
      historyConversationOf(query),
    );
  }

  @Get(':runId/calls/:callId/messages')
  @ApiOperation({ operationId: 'listCallMessages' })
  @ZodResponse({ status: 200, type: CallMessagesDto })
  getCallMessages(
    @Param('runId') runId: string,
    @Param('callId') callId: string,
    @Query() query: CallMessagesQueryDto,
  ): Promise<CallMessagesWire> {
    return this.history.callMessages(runId, callId, query.limit);
  }

  /**
   * Find a message inside this conversation — including one the client has
   * never loaded, which is the whole reason this is a route.
   *
   * `:runId/items` serves a WINDOW to a screen and pages behind a cursor; a
   * search filtered over that window could only ever answer about the newest
   * page, and would say nothing about the rest — silent by construction, and
   * exactly wrong for the question a search box is opened to ask.
   */
  @Get(':runId/search')
  @ApiOperation({ operationId: 'searchChat' })
  @ZodResponse({ status: 200, type: ChatSearchResultDto })
  searchChat(
    @Param('runId') runId: string,
    @Query() query: SearchChatQueryDto,
  ): Promise<ChatSearchResult> {
    return this.search.search(runId, query.query, query.limit);
  }

  /**
   * Which of the given folders this run's tool calls name — how the changes
   * chip finds a worktree an agent of this thread made for itself among the
   * repository's others.
   */
  @Post(':runId/named-paths')
  @ApiOperation({ operationId: 'readRunNamedPaths' })
  @ZodResponse({ status: 200, type: NamedPathsResultDto })
  readNamedPaths(
    @Param('runId') runId: string,
    @Body() dto: NamedPathsDto,
  ): Promise<{ named: string[] }> {
    return this.namedPaths.named(runId, dto.paths);
  }

  /**
   * What the run holds as a WHOLE — its open cards, calls, delegates, running
   * commands, dynamic workflows — for every readout the loaded transcript
   * window must not decide. See `RunStateWireSchema`.
   */
  /**
   * Several of a thread's opening reads in one request — the state, totals,
   * timeline, artifacts and analysis routes' own answers, for the parts named
   * in `parts`. See `ThreadOverviewWireSchema`.
   */
  @Get(':runId/overview')
  @ApiOperation({ operationId: 'readThreadOverview' })
  @ZodResponse({ status: 200, type: ThreadOverviewDto })
  readOverview(
    @Param('runId') runId: string,
    @Query() query: ThreadOverviewQueryDto,
  ): Promise<ThreadOverviewWire> {
    return this.overview.read(runId, query.parts);
  }

  @Get(':runId/state')
  @ApiOperation({ operationId: 'readRunState' })
  @ZodResponse({ status: 200, type: RunStateDto })
  readState(@Param('runId') runId: string): Promise<RunStateWire> {
    return this.runState.read(runId);
  }

  /**
   * Stop one of those commands — ASKED FOR as "i wanna have an ability to kill
   * terminals". Until now only the AGENT could end one, so a `pnpm dev` left up
   * by a finished thread ran until the user found it in Activity Monitor.
   *
   * A QUERY parameter for the call id and not a path segment, matching
   * `:runId/shell-output` — the id is the CLI's own token and nothing here
   * should have to reason about which characters it may contain.
   *
   * A command that is no longer running is an ORDINARY 200 rather than a 404:
   * the list a user pressed from is a snapshot, so a command that ended between
   * the render and the press is a race, not a mistake. Only an unknown run is a
   * 4xx.
   */
  @Post(':runId/shells/kill')
  @ApiOperation({ operationId: 'killChatShell' })
  @ZodResponse({ status: 200, type: ShellKillDto })
  killShell(
    @Param('runId') runId: string,
    @Query() query: ShellKillQueryDto,
  ): Promise<ShellKillWire> {
    return this.shells.kill(runId, query.callId);
  }

  /**
   * The conversation as a rail of its user messages, with what each one cost.
   *
   * A route for `:runId/search`'s reason: the client holds at most
   * `HISTORY_PAGE` items, so a rail folded there would describe the loaded
   * window and report a shorter, cheaper conversation than the one that
   * happened — with nothing on screen saying which.
   */
  @Get(':runId/timeline')
  @ApiOperation({ operationId: 'readChatTimeline' })
  @ZodResponse({ status: 200, type: ChatTimelineDto })
  readTimeline(@Param('runId') runId: string): Promise<ChatTimelineWire> {
    return this.timeline.read(runId);
  }

  /**
   * This run as money, order and timing on one wall clock — a DAEMON fold for
   * `:runId/timeline`'s reason: the client holds one window of the transcript,
   * so a waterfall folded there would start in the middle of a long run and say
   * nothing about it.
   */
  @Get(':runId/waterfall')
  @ApiOperation({ operationId: 'readRunWaterfall' })
  @ZodResponse({ status: 200, type: RunWaterfallDto })
  readWaterfall(@Param('runId') runId: string): Promise<RunWaterfallWire> {
    return this.waterfall.read(runId);
  }

  /**
   * Every process this run has running now — each kept agent CLI and its
   * whole tree — with CPU and memory. A live reading the panel polls; the
   * attribution starts from the pids the daemon spawned, never from a command
   * line.
   */
  @Get(':runId/processes')
  @ApiOperation({ operationId: 'readRunProcesses' })
  @ZodResponse({ status: 200, type: RunProcessesDto })
  readProcesses(@Param('runId') runId: string): Promise<RunProcessesWire> {
    return this.processes.read(runId);
  }

  @Post(':runId/processes/stop')
  @ApiOperation({ operationId: 'stopDetachedProcesses' })
  @ZodResponse({ status: 200, type: StoppedDetachedProcessesDto })
  stopDetachedProcesses(
    @Param('runId') runId: string,
    @Body() dto: StopDetachedProcessesDto,
  ): Promise<StoppedDetachedProcesses> {
    return this.processes.stopDetached(runId, dto);
  }

  /**
   * The pages this run published — a DAEMON fold for `:runId/timeline`'s
   * reason: the client holds one window of the transcript, so folding there
   * silently drops an artifact published earlier in a long thread.
   */
  @Get(':runId/artifacts')
  @ApiOperation({ operationId: 'readRunArtifacts' })
  @ZodResponse({ status: 200, type: RunArtifactsDto })
  readArtifacts(@Param('runId') runId: string): Promise<RunArtifactsWire> {
    return this.artifacts.read(runId);
  }

  /**
   * Every team note this run's agents wrote, superseded ones marked — a
   * daemon fold on `:runId/artifacts`' reason.
   */
  @Get(':runId/team-notes')
  @ApiOperation({ operationId: 'readRunTeamNotes' })
  @ZodResponse({ status: 200, type: RunTeamNotesDto })
  readTeamNotes(@Param('runId') runId: string): Promise<RunTeamNotesWire> {
    return this.teamNotes.read(runId);
  }

  /** Every pull request outcome this run's agents recorded, per pull request with its history. */
  @Get(':runId/outcomes')
  @ApiOperation({ operationId: 'readRunOutcomes' })
  @ZodResponse({ status: 200, type: RunOutcomesDto })
  readOutcomes(@Param('runId') runId: string): Promise<RunOutcomesWire> {
    return this.runOutcomes.read(runId);
  }

  /**
   * The whole conversation as one file — every setting, every transcript item
   * with its payload verbatim, the per-member execution state and the spend.
   *
   * Its own route rather than a flag on `:runId/items`, because it answers a
   * different question: that route serves a WINDOW to a screen and is paged
   * behind a cursor, while this is the complete thread for a bug report. It is
   * also the one read here that is deliberately unbounded, which is why it is
   * pressed rather than polled.
   */
  @Get(':runId/export')
  @ApiOperation({ operationId: 'exportChat' })
  @ZodResponse({ status: 200, type: ChatExportDto })
  exportChat(@Param('runId') runId: string): Promise<ChatExportWire> {
    return this.chatExport.export(runId);
  }

  /**
   * This thread's analysis — the chat its "Analyze thread" popup opens — or
   * `analysis: null` while it has none. 404 for a thread that does not exist.
   */
  @Get(':runId/analysis')
  @ApiOperation({ operationId: 'getThreadAnalysis' })
  @ZodResponse({ status: 200, type: ThreadAnalysisDto })
  async getThreadAnalysis(
    @Param('runId') runId: string,
  ): Promise<ThreadAnalysisWire> {
    return { analysis: await this.analyses.find(runId) };
  }

  /**
   * Start this thread's analysis ("Analyze thread"), replacing the one it had: linked to it,
   * reading it through the analysis tools up to this moment's newest row.
   * 409 `ANALYSIS_FOLDER_GONE` until a folder that exists is sent as `cwd`.
   */
  @Post(':runId/analyses')
  @ApiOperation({ operationId: 'analyzeThread' })
  @ZodResponse({ status: 201, type: RunDto })
  analyzeThread(
    @Param('runId') runId: string,
    @Body() dto: AnalyzeThreadDto,
  ): Promise<RunWire> {
    return this.analyses.start(runId, dto);
  }

  /**
   * The recommendations card's Apply: sends the analysis agent a message
   * holding the selected items in full, with the selection persisted on it.
   * 409 `RUN_BUSY` while the analysis is still working.
   */
  @Post(':runId/recommendations/apply')
  @ApiOperation({ operationId: 'applyRecommendations' })
  @ZodResponse({ status: 201, type: ItemDto })
  applyRecommendations(
    @Param('runId') runId: string,
    @Body() dto: ApplyRecommendationsDto,
  ): Promise<ItemWire> {
    return this.recommendations.apply(runId, dto);
  }

  /**
   * A press of an agent's button. 409 `ACTION_CHANGED` when the agent has
   * republished it since, `ACTION_GONE` when it is no longer live,
   * `ACTION_BUSY` mid-press, `RUN_ARCHIVED` for an archived chat, and the
   * chat's own `RUN_BUSY`, after which the same press may be repeated.
   */
  @Post(':runId/actions/:seq/press')
  @ApiOperation({ operationId: 'pressChatAction' })
  @ApiParam({ name: 'seq', type: Number })
  @ZodResponse({ status: 201, type: ActionPressDto })
  pressAction(
    @Param('runId') runId: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Body() dto: PressActionDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<ActionPressWire> {
    return this.actionPresses.pressChat(
      runId,
      seq,
      dto.clientMessageId,
      cameViaRemote(headers) ? 'remote' : 'desktop',
    );
  }

  /** Takes an agent's button off the chat; the agent is not told. */
  @Post(':runId/actions/:seq/dismiss')
  @ApiOperation({ operationId: 'dismissChatAction' })
  @ApiParam({ name: 'seq', type: Number })
  @ZodResponse({ status: 201, type: ActionPressDto })
  dismissAction(
    @Param('runId') runId: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<ActionPressWire> {
    return this.actionPresses.dismissChat(
      runId,
      seq,
      cameViaRemote(headers) ? 'remote' : 'desktop',
    );
  }

  @Post(':runId/messages')
  @ApiOperation({ operationId: 'sendChatMessage' })
  @ZodResponse({ status: 201, type: ItemDto })
  sendMessage(
    @Param('runId') runId: string,
    @Body() dto: SendMessageDto,
  ): Promise<ItemWire> {
    return this.chatService.sendMessage(runId, dto.text, dto.images, {
      clientMessageId: dto.clientMessageId,
      backgroundWork: dto.backgroundWork,
      waitForAnswer: dto.waitForAnswer,
    });
  }

  /**
   * Store a file a PHONE attached through the composer's paperclip and answer
   * with its path, which the composer writes into the message. Not under a run:
   * the landing composer has none yet. See `ChatUploadStoreService`.
   */
  @Post('uploads')
  @ApiOperation({ operationId: 'uploadChatFile' })
  @ZodResponse({ status: 201, type: ChatUploadDto })
  uploadFile(@Body() dto: UploadChatFileDto): Promise<ChatUploadWire> {
    return this.uploads.store(dto.name, dto.data);
  }

  @Get(':runId/attachments/:attachmentId')
  @ApiOperation({ operationId: 'readChatAttachment' })
  @ZodResponse({ status: 200, type: AttachmentDataDto })
  readAttachment(
    @Param('runId') runId: string,
    @Param('attachmentId') attachmentId: string,
  ): AttachmentDataWire {
    return this.chatService.readAttachment(runId, attachmentId);
  }

  /**
   * An image an agent referenced from its own markdown. A QUERY parameter and
   * not a path segment: the value is a filesystem path, so it carries slashes
   * of its own and no amount of route shaping makes it one segment.
   */
  @Get(':runId/image')
  @ApiOperation({ operationId: 'readLocalImage' })
  @ZodResponse({ status: 200, type: LocalImageDto })
  readLocalImage(
    @Param('runId') runId: string,
    @Query() query: LocalImageQueryDto,
  ): Promise<LocalImageWire> {
    return this.localImages.read(runId, query.path);
  }

  /**
   * The terminal behind one command in the running-shells list.
   *
   * A QUERY parameter for the call id and not a path segment, matching the
   * image route beside it: the id is the CLI's own token and nothing here
   * should have to reason about which characters it may contain.
   *
   * Polled while a detached command runs — it is a bounded tail of one file, so
   * unlike `:runId/metrics` (a round trip to the live CLI) it is cheap enough to
   * ask again every couple of seconds.
   */
  @Get(':runId/shell-output')
  @ApiOperation({ operationId: 'readShellOutput' })
  @ZodResponse({ status: 200, type: ShellOutputDto })
  readShellOutput(
    @Param('runId') runId: string,
    @Query() query: ShellOutputQueryDto,
  ): Promise<ShellOutputWire> {
    return this.shellOutput.read(runId, query.callId);
  }

  /**
   * What this chat's context window holds, and what the thread has cost.
   *
   * A GET with a real cost behind it — the breakdown is a round trip to the
   * live CLI, measured at 1.2–3.3s — so it is fetched when the readout is
   * OPENED and never polled. Absent figures are an answer here, not an error:
   * a CLI with no such channel and a chat whose process has been reaped both
   * come back 200 with `breakdownReason` saying which.
   */
  @Get(':runId/metrics')
  @ApiOperation({ operationId: 'readChatMetrics' })
  @ZodResponse({ status: 200, type: ChatMetricsDto })
  readMetrics(
    @Param('runId') runId: string,
    @Query() query: ChatMetricsQueryDto,
  ): Promise<ChatMetricsWire> {
    return this.metrics.read(
      runId,
      query.memberId ?? null,
      query.callId ?? null,
      query.refresh ?? false,
    );
  }

  /**
   * What this thread has cost — the spend half of `:runId/metrics`, alone.
   *
   * Its own route because the two halves cost different things to produce. The
   * breakdown is a round trip to the live CLI and is why that route is opened
   * rather than polled; this one is a database sum, so the chat header can carry
   * the figure on every thread the user opens without paying a CLI dial to
   * switch chats.
   */
  @Get(':runId/totals')
  @ApiOperation({ operationId: 'readChatTotals' })
  @ZodResponse({ status: 200, type: ChatTotalsDto })
  async readTotals(@Param('runId') runId: string): Promise<ChatTotalsResponse> {
    return this.metrics.readTotalsResponse(runId);
  }

  @Post(':runId/cancel')
  @ApiOperation({ operationId: 'cancelChat' })
  @ZodResponse({ status: 200, type: CancelledDto })
  cancel(@Param('runId') runId: string): Promise<{ cancelled: boolean }> {
    return this.chatService.cancel(runId);
  }

  /**
   * Reopen a failed turn's conversation without replaying its prompt.
   *
   * Its own route rather than a flag on `sendChatMessage`: the guarantee that
   * matters here is that NO prompt goes out, and a route whose name promises a
   * message would bury that in a branch. 200 rather than 201 for the same
   * reason `cancel` is — nothing is created that the caller did not have.
   */
  @Post(':runId/retry')
  @ApiOperation({ operationId: 'retryChat' })
  @ZodResponse({ status: 200, type: RetriedDto })
  retry(@Param('runId') runId: string): Promise<{ retried: boolean }> {
    return this.chatService.retry(runId);
  }

  /**
   * Shelve this chat, or put it back. Two routes rather than one taking a
   * boolean: each is a thing the user pressed, and the pair reads the same way
   * in the generated client as it does in the sidebar.
   *
   * They answer with the RUN, like `setGroup` above and for its reason — the
   * sidebar replaces the row it already holds.
   */
  @Post(':runId/archive')
  @ApiOperation({ operationId: 'archiveChat' })
  @ZodResponse({ status: 200, type: RunDto })
  archive(@Param('runId') runId: string): Promise<RunWire> {
    return this.chatService.archive(runId);
  }

  @Post(':runId/unarchive')
  @ApiOperation({ operationId: 'unarchiveChat' })
  @ZodResponse({ status: 200, type: RunDto })
  unarchive(@Param('runId') runId: string): Promise<RunWire> {
    return this.chatService.unarchive(runId);
  }

  @Delete(':runId')
  @ApiOperation({ operationId: 'deleteChat' })
  @ZodResponse({ status: 200, type: ChatDeletedDto })
  async delete(
    @Param('runId') runId: string,
    @Query() query: DeleteRunQueryDto,
  ): Promise<{ deleted: boolean }> {
    if (query.extractLessons === 'true') {
      const taken = await this.extractLessons?.extract(runId);
      if (taken != null) {
        return taken;
      }
    }
    return this.chatService.delete(runId);
  }
}
