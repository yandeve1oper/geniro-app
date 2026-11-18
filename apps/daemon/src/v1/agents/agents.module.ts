import { join } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Logger, Module } from '@nestjs/common';

import { DesktopOnlyGuard } from '../../auth/desktop-only.guard';
import { environment } from '../../environments';
import { DAEMON_VERSION } from '../../utils/daemon-version';
import { BrowserModule } from '../browser/browser.module';
import { createTeeingSpawn } from '../diagnostics/utils/teeing-spawn';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { MemoryModule } from '../memory/memory.module';
import { ProjectDao } from '../projects/dao/project.dao';
import { ProjectsModule } from '../projects/projects.module';
import type { AdapterDaemonDeps } from './adapters/adapter.types';
import { ClaudeAdapter } from './adapters/claude/claude.adapter';
import { CodexAdapter } from './adapters/codex/codex.adapter';
import { CursorAcpAdapter } from './adapters/cursor-acp/cursor-acp.adapter';
import { AgentActivityController } from './controllers/agent-activity.controller';
import { ArtifactsController } from './controllers/artifacts.controller';
import { ChatController } from './controllers/chat.controller';
import { ChatSearchController } from './controllers/chat-search.controller';
import { GoalsController } from './controllers/goals.controller';
import { KeptSessionsController } from './controllers/kept-sessions.controller';
import { McpController } from './controllers/mcp.controller';
import { MemoryCheckController } from './controllers/memory-check.controller';
import { MemoryImportController } from './controllers/memory-import.controller';
import { ResourceAlertsController } from './controllers/resource-alerts.controller';
import { RunGroupsController } from './controllers/run-groups.controller';
import { SkillsController } from './controllers/skills.controller';
import { ThreadMessagesController } from './controllers/thread-messages.controller';
import { CallContextDao } from './dao/call-context.dao';
import { ChatSearchIndexDao } from './dao/chat-search-index.dao';
import { GoalDao } from './dao/goal.dao';
import { ItemDao } from './dao/item.dao';
import { NodeStateDao } from './dao/node-state.dao';
import { RunDao } from './dao/run.dao';
import { RunGroupDao } from './dao/run-group.dao';
import { ThreadMessageDao } from './dao/thread-message.dao';
import { WallTurnDao } from './dao/wall-turn.dao';
import { ActionBroker } from './services/action.broker';
import { ActionCommandRegistry } from './services/action-command.registry';
import { ActionCommandService } from './services/action-command.service';
import { ActionOutcomeSweep } from './services/action-outcome-sweep.service';
import { ActionPressService } from './services/action-press.service';
import { ActionPublishService } from './services/action-publish.service';
import { ActionStopService } from './services/action-stop.service';
import { AgentActivityService } from './services/agent-activity.service';
import {
  AGENT_ADAPTERS,
  AgentAdapterRegistry,
} from './services/agent-adapter.registry';
import { AgentEventBus } from './services/agent-events.bus';
import { AgentMcpService } from './services/agent-mcp.service';
import { AgentSessionRegistry } from './services/agent-session.registry';
import { AgentVersionService } from './services/agent-version.service';
import { AgentVocabularyService } from './services/agent-vocabulary.service';
import { AnalysisBroker } from './services/analysis.broker';
import { AnalysisReportsService } from './services/analysis-reports.service';
import { ApprovalRegistry } from './services/approval-registry';
import { ArtifactBroker } from './services/artifact.broker';
import { ArtifactPageService } from './services/artifact-page.service';
import { ArtifactStoreService } from './services/artifact-store.service';
import { AttachmentStoreService } from './services/attachment-store.service';
import { BrowserBroker } from './services/browser.broker';
import { CacheResetService } from './services/cache-reset.service';
import { ChartBroker } from './services/chart.broker';
import { ChatService } from './services/chat.service';
import { ChatActionsService } from './services/chat-actions.service';
import { ChatArtifactsService } from './services/chat-artifacts.service';
import { ChatExportService } from './services/chat-export.service';
import { ChatHistoryService } from './services/chat-history.service';
import { ChatMetricsService } from './services/chat-metrics.service';
import { ChatRunOutcomesService } from './services/chat-run-outcomes.service';
import { ChatSearchService } from './services/chat-search.service';
import { ChatShellsService } from './services/chat-shells.service';
import { ChatTeamNotesService } from './services/chat-team-notes.service';
import { ChatTextIndexService } from './services/chat-text-index.service';
import { ChatTimelineService } from './services/chat-timeline.service';
import { ChatTitleService } from './services/chat-title.service';
import { ChatUploadStoreService } from './services/chat-upload-store.service';
import { ChatWaterfallService } from './services/chat-waterfall.service';
import { CliSessionsService } from './services/cli-sessions.service';
import { CommandCenterBroker } from './services/command-center.broker';
import { CommandCenterOpsBroker } from './services/command-center-ops.broker';
import { CommandEndWakeService } from './services/command-end-wake.service';
import { ComparisonBroker } from './services/comparison.broker';
import { ConfigDirPinService } from './services/config-dir-pin.service';
import { ContextWindowStore } from './services/context-window.store';
import { ContextWindowsService } from './services/context-windows.service';
import { DelegateSpendStore } from './services/delegate-spend.store';
import { EffortsService } from './services/efforts.service';
import { ExtractLessonsOnDeleteRegistry } from './services/extract-lessons-on-delete.registry';
import { FindingsReportBroker } from './services/findings-report.broker';
import { GalleryBroker } from './services/gallery.broker';
import { GalleryImageService } from './services/gallery-image.service';
import { GlobalChatSearchService } from './services/global-chat-search.service';
import { GoalWritersBroker } from './services/goal-writers.broker';
import { GoalsService } from './services/goals.service';
import { HostToolResultLedger } from './services/host-tool-result.ledger';
import { HostWakeBus } from './services/host-wake.bus';
import { HostWakeChatDelivery } from './services/host-wake-chat-delivery.service';
import { ItemCallIndexService } from './services/item-call-index.service';
import { ItemSeqAllocator } from './services/item-seq.allocator';
import { KnowledgeItemsService } from './services/knowledge-items.service';
import { LocalImageService } from './services/local-image.service';
import { McpHarvestStore } from './services/mcp-harvest.store';
import { MemoryCheckService } from './services/memory-check.service';
import { MemoryImportService } from './services/memory-import.service';
import { MessageSendService } from './services/message-send.service';
import { MetricsBroker } from './services/metrics.broker';
import { ModelParametersService } from './services/model-parameters.service';
import { ModelPriceCatalog } from './services/model-price-catalog.service';
import { ModelVocabularyStore } from './services/model-vocabulary.store';
import { ModelsService } from './services/models.service';
import { MonitorBroker } from './services/monitor.broker';
import { MonitorRegistry } from './services/monitor.registry';
import { MonitorAnnouncer } from './services/monitor-announcer.service';
import { MonitorChatDelivery } from './services/monitor-chat-delivery.service';
import { MonitorOutcomeSweep } from './services/monitor-outcome-sweep.service';
import { MonitorRowWriter } from './services/monitor-row.writer';
import { NotifyBroker } from './services/notify.broker';
import { OllamaService } from './services/ollama.service';
import { OneShotAskService } from './services/one-shot-ask.service';
import { PartialStreamService } from './services/partial-stream.service';
import { PatchBroker } from './services/patch.broker';
import { PayloadRefsSweepService } from './services/payload-refs-sweep.service';
import { PlanBroker } from './services/plan.broker';
import { PolledSpendService } from './services/polled-spend.service';
import { ProcessRegistry } from './services/process-registry';
import { ProjectChatBroker } from './services/project-chat.broker';
import { ProjectInstructionsBroker } from './services/project-instructions.broker';
import { ProjectInstructionsChangeService } from './services/project-instructions-change.service';
import { PullRequestCaptureService } from './services/pull-request-capture.service';
import { RecommendationsApplyService } from './services/recommendations-apply.service';
import { ResourceAlertEventBus } from './services/resource-alert-events.bus';
import { ResourceWatchService } from './services/resource-watch.service';
import { RunAttentionService } from './services/run-attention.service';
import { RunContextRegistry } from './services/run-context.registry';
import { RunGroupsService } from './services/run-groups.service';
import { RunHoldRegistry } from './services/run-hold.registry';
import { RunIdleReapService } from './services/run-idle-reap.service';
import { RunKindRowsCache } from './services/run-kind-rows.cache';
import { RunLiveWork } from './services/run-live-work.service';
import { RunNamedPathsService } from './services/run-named-paths.service';
import { RunNoticeWriter } from './services/run-notice.writer';
import { RunOutcomeBroker } from './services/run-outcome.broker';
import { RunOutcomeHistoryService } from './services/run-outcome-history.service';
import {
  currentRunOwner,
  RunProcessAttribution,
} from './services/run-process-attribution.service';
import {
  createRunProcessReaper,
  RunProcessReaper,
} from './services/run-process-reaper.service';
import { RunProcessSweep } from './services/run-process-sweep.service';
import { RunProcessesService } from './services/run-processes.service';
import { RunStateService } from './services/run-state.service';
import { RunTeardownService } from './services/run-teardown.service';
import { RunWriteQueue } from './services/run-write.queue';
import { SessionTranscriptsService } from './services/session-transcripts.service';
import { ShellOutputService } from './services/shell-output.service';
import { SkillHarvestStore } from './services/skill-harvest.store';
import { SkillsService } from './services/skills.service';
import { StrandedChildReaper } from './services/stranded-child-reaper.service';
import { StrandedWorkReconcileService } from './services/stranded-work-reconcile.service';
import { SubagentRecoveryService } from './services/subagent-recovery.service';
import { TaskListCaptureService } from './services/task-list-capture.service';
import { TeamBuilderBroker } from './services/team-builder.broker';
import { TeamNoteBroker } from './services/team-note.broker';
import { TeamProposalBroker } from './services/team-proposal.broker';
import { ThreadAnalysisService } from './services/thread-analysis.service';
import { ThreadInboxService } from './services/thread-inbox.service';
import { ThreadOverviewService } from './services/thread-overview.service';
import { ThreadReaderService } from './services/thread-reader.service';
import { ThreadTimelineService } from './services/thread-timeline.service';
import { UnrecordedSpendStore } from './services/unrecorded-spend.store';
import { UserQuestionBroker } from './services/user-question.broker';
import { WallWorkService } from './services/wall-work.service';
import { WriteFailureNotices } from './services/write-failure.notices';
import { CHILD_JOURNAL_FILE_NAME } from './utils/child-journal';
import { defaultSpawn } from './utils/spawn-cli';

/**
 * Single-agent chat (M2): the AgentAdapter subclasses, persistence DAOs, the in-proc
 * event bus, and the child-process registry. Entities are discovered globally
 * (mikro-orm config glob) and the EntityManager is provided app-wide by the
 * global MikroOrmModule, so no `forFeature` import is needed here.
 * `AgentEventBus` is exported so the notifications gateway can fan its events
 * out to per-run Socket.IO rooms.
 *
 * The adapters arrive as ONE list (`AGENT_ADAPTERS`), each built by its own
 * `forDaemon` from the shared services — the list below is the only place the
 * daemon names which CLIs exist, and nothing is exported per CLI: every
 * consumer reaches an adapter through `AgentAdapterRegistry`.
 */
@Module({
  imports: [BrowserModule, MemoryModule, KnowledgeModule, ProjectsModule],
  controllers: [
    AgentActivityController,
    ArtifactsController,
    ChatController,
    GoalsController,
    ThreadMessagesController,
    ChatSearchController,
    KeptSessionsController,
    McpController,
    ResourceAlertsController,
    MemoryCheckController,
    MemoryImportController,
    RunGroupsController,
    SkillsController,
  ],
  providers: [
    DesktopOnlyGuard,
    ExtractLessonsOnDeleteRegistry,
    ChatShellsService,
    ChatHistoryService,
    RunStateService,
    ChatService,
    ChatSearchService,
    RunNamedPathsService,
    ChatSearchIndexDao,
    ChatTextIndexService,
    GlobalChatSearchService,
    ChatActionsService,
    ChatArtifactsService,
    ChatTeamNotesService,
    ChatRunOutcomesService,
    ChatTimelineService,
    ChatWaterfallService,
    ThreadTimelineService,
    ThreadReaderService,
    ThreadAnalysisService,
    ThreadOverviewService,
    RecommendationsApplyService,
    {
      // Factory because the trailing process listing is a test seam, not a
      // DI token.
      provide: RunProcessesService,
      useFactory: (
        em: EntityManager,
        runDao: RunDao,
        sessions: AgentSessionRegistry,
        attribution: RunProcessAttribution,
        reaper: RunProcessReaper,
        monitors: MonitorRegistry,
      ) =>
        new RunProcessesService(
          em,
          runDao,
          sessions,
          attribution,
          reaper,
          monitors,
        ),
      inject: [
        EntityManager,
        RunDao,
        AgentSessionRegistry,
        RunProcessAttribution,
        RunProcessReaper,
        MonitorRegistry,
      ],
    },
    PullRequestCaptureService,
    RunAttentionService,
    TaskListCaptureService,
    PolledSpendService,
    UserQuestionBroker,
    FindingsReportBroker,
    AnalysisBroker,
    AnalysisReportsService,
    ProjectInstructionsChangeService,
    KnowledgeItemsService,
    ProjectInstructionsBroker,
    ProjectChatBroker,
    CommandCenterBroker,
    CommandCenterOpsBroker,
    ChartBroker,
    PatchBroker,
    ComparisonBroker,
    MetricsBroker,
    GalleryBroker,
    BrowserBroker,
    ArtifactBroker,
    ActionBroker,
    GoalWritersBroker,
    TeamProposalBroker,
    TeamBuilderBroker,
    ActionPublishService,
    ActionPressService,
    ActionStopService,
    ActionCommandService,
    ActionCommandRegistry,
    ActionOutcomeSweep,
    MonitorRegistry,
    MonitorRowWriter,
    MonitorAnnouncer,
    MonitorChatDelivery,
    MonitorOutcomeSweep,
    StrandedWorkReconcileService,
    MonitorBroker,
    TeamNoteBroker,
    RunOutcomeBroker,
    GoalsService,
    GoalDao,
    RunOutcomeHistoryService,
    HostWakeBus,
    HostWakeChatDelivery,
    {
      provide: CommandEndWakeService,
      useFactory: (bus: HostWakeBus) => new CommandEndWakeService(bus),
      inject: [HostWakeBus],
    },
    RunNoticeWriter,
    WriteFailureNotices,
    RunLiveWork,
    ArtifactPageService,
    PlanBroker,
    NotifyBroker,
    CacheResetService,
    AgentAdapterRegistry,
    AgentVersionService,
    ChatExportService,
    ChatMetricsService,
    ChatTitleService,
    LocalImageService,
    // Factories because the trailing options bags are test seams, not DI tokens.
    { provide: SkillHarvestStore, useFactory: () => new SkillHarvestStore() },
    { provide: McpHarvestStore, useFactory: () => new McpHarvestStore() },
    {
      provide: AttachmentStoreService,
      useFactory: () => new AttachmentStoreService(),
    },
    {
      provide: GalleryImageService,
      useFactory: (attachments: AttachmentStoreService) =>
        new GalleryImageService(attachments),
      inject: [AttachmentStoreService],
    },
    {
      provide: ChatUploadStoreService,
      useFactory: () => new ChatUploadStoreService(),
    },
    {
      provide: ArtifactStoreService,
      useFactory: (runs: RunDao) => new ArtifactStoreService({ runs }),
      inject: [RunDao],
    },
    {
      provide: SkillsService,
      useFactory: (
        harvest: SkillHarvestStore,
        adapters: AgentAdapterRegistry,
        processes: ProcessRegistry,
        versions: AgentVersionService,
      ) => new SkillsService(harvest, adapters, processes, versions),
      inject: [
        SkillHarvestStore,
        AgentAdapterRegistry,
        ProcessRegistry,
        AgentVersionService,
      ],
    },
    {
      // Factory because the trailing options bag is a test seam, not a DI token.
      provide: AgentMcpService,
      useFactory: (
        adapters: AgentAdapterRegistry,
        processes: ProcessRegistry,
        versions: AgentVersionService,
        harvest: McpHarvestStore,
        sessions: AgentSessionRegistry,
      ) =>
        new AgentMcpService(adapters, processes, versions, harvest, sessions),
      inject: [
        AgentAdapterRegistry,
        ProcessRegistry,
        AgentVersionService,
        McpHarvestStore,
        AgentSessionRegistry,
      ],
    },
    {
      // Factory because the trailing options bag is a test seam, not a DI token.
      provide: ModelsService,
      useFactory: (
        adapters: AgentAdapterRegistry,
        processes: ProcessRegistry,
        versions: AgentVersionService,
        store: ModelVocabularyStore,
        ollama: OllamaService,
        windows: ContextWindowStore,
      ) =>
        new ModelsService(adapters, processes, versions, store, {
          ollama,
          windows,
        }),
      inject: [
        AgentAdapterRegistry,
        ProcessRegistry,
        AgentVersionService,
        ModelVocabularyStore,
        OllamaService,
        ContextWindowStore,
      ],
    },
    OllamaService,
    AgentVocabularyService,
    // Plain provider, unlike its siblings above: it has no options bag to seed,
    // because an adapter answers from a documented constant (no spawn, no TTL).
    CliSessionsService,
    ConfigDirPinService,
    {
      // A factory now, and for the same reason `ModelsService` is one: asking a
      // model's effort axis SPAWNS a CLI handshake, so this gained a version
      // key, a TTL and a single-flight — and the options bag behind them is a
      // test seam, not a DI token.
      provide: EffortsService,
      useFactory: (
        adapters: AgentAdapterRegistry,
        processes: ProcessRegistry,
        versions: AgentVersionService,
      ) => new EffortsService(adapters, processes, versions),
      inject: [AgentAdapterRegistry, ProcessRegistry, AgentVersionService],
    },
    {
      // Its twin, and a factory for the identical reason: asking a model's
      // window sizes spawns the same handshake, so it carries the same version
      // key, TTL and single-flight (`ModelVocabularyCache`, shared with it).
      provide: ContextWindowsService,
      useFactory: (
        adapters: AgentAdapterRegistry,
        processes: ProcessRegistry,
        versions: AgentVersionService,
      ) => new ContextWindowsService(adapters, processes, versions),
      inject: [AgentAdapterRegistry, ProcessRegistry, AgentVersionService],
    },
    {
      // The THIRD reader of that one handshake, and a factory for the same
      // reason again. It differs from its two siblings only in what it takes
      // out of the reply: everything they did not.
      provide: ModelParametersService,
      useFactory: (
        adapters: AgentAdapterRegistry,
        processes: ProcessRegistry,
        versions: AgentVersionService,
      ) => new ModelParametersService(adapters, processes, versions),
      inject: [AgentAdapterRegistry, ProcessRegistry, AgentVersionService],
    },
    AgentEventBus,
    HostToolResultLedger,
    RunContextRegistry,
    RunHoldRegistry,
    ApprovalRegistry,
    {
      provide: ContextWindowStore,
      useFactory: () => new ContextWindowStore(),
    },
    {
      // Factory for the same reason its neighbour is one: the options bag is a
      // test seam, not a DI token.
      provide: ModelVocabularyStore,
      useFactory: () => new ModelVocabularyStore(),
    },
    // A plain class provider rather than a factory, because it needs its
    // lifecycle hooks (the boot load and the staleness timer); its options bag
    // is `@Optional()` and arrives empty here.
    ModelPriceCatalog,
    PartialStreamService,
    // The live plane's durable halves — `Run.unrecordedSpend` and `Run.delegateSpend`.
    UnrecordedSpendStore,
    DelegateSpendStore,
    ProcessRegistry,
    AgentSessionRegistry,
    AgentActivityService,
    {
      // Factory because the trailing options bag is a test seam, not a DI
      // token — and because the journal path is config, not a dependency.
      provide: StrandedChildReaper,
      useFactory: (reaper: RunProcessReaper) =>
        new StrandedChildReaper(
          join(environment.userDataDir, CHILD_JOURNAL_FILE_NAME),
          (runId, groups) => reaper.stopLeftGroups(runId, groups),
        ),
      inject: [RunProcessReaper],
    },
    {
      // Factories because the options bags are test seams, not DI tokens.
      provide: RunProcessAttribution,
      useFactory: () => new RunProcessAttribution(currentRunOwner()),
    },
    {
      provide: RunProcessReaper,
      useFactory: (
        attribution: RunProcessAttribution,
        sessions: AgentSessionRegistry,
        commands: ActionCommandRegistry,
        monitors: MonitorRegistry,
        em: EntityManager,
        runDao: RunDao,
      ) =>
        createRunProcessReaper(attribution, sessions, [commands, monitors], {
          stillGone: async (runIds) => {
            const live = await runDao.getAll(
              { id: { $in: runIds }, archivedAt: null },
              undefined,
              em.fork(),
            );
            const liveIds = new Set(live.map((run) => run.id));
            return new Set(runIds.filter((id) => !liveIds.has(id)));
          },
        }),
      inject: [
        RunProcessAttribution,
        AgentSessionRegistry,
        ActionCommandRegistry,
        MonitorRegistry,
        EntityManager,
        RunDao,
      ],
    },
    ResourceAlertEventBus,
    {
      // Factory because the trailing readers are test seams, not DI tokens.
      provide: ResourceWatchService,
      useFactory: (
        processes: RunProcessesService,
        sessions: AgentSessionRegistry,
        monitors: MonitorRegistry,
        reaper: RunProcessReaper,
        bus: ResourceAlertEventBus,
      ) => new ResourceWatchService(processes, sessions, monitors, reaper, bus),
      inject: [
        RunProcessesService,
        AgentSessionRegistry,
        MonitorRegistry,
        RunProcessReaper,
        ResourceAlertEventBus,
      ],
    },
    {
      provide: RunProcessSweep,
      useFactory: (
        em: EntityManager,
        runDao: RunDao,
        itemDao: ItemDao,
        sessions: AgentSessionRegistry,
        reaper: RunProcessReaper,
        attribution: RunProcessAttribution,
        idleReap: RunIdleReapService,
      ) =>
        new RunProcessSweep(
          em,
          runDao,
          itemDao,
          sessions,
          reaper,
          attribution,
          idleReap,
        ),
      inject: [
        EntityManager,
        RunDao,
        ItemDao,
        AgentSessionRegistry,
        RunProcessReaper,
        RunProcessAttribution,
        RunIdleReapService,
      ],
    },
    RunIdleReapService,
    RunTeardownService,
    SessionTranscriptsService,
    RunGroupsService,
    ShellOutputService,
    ItemSeqAllocator,
    RunWriteQueue,
    SubagentRecoveryService,
    ItemCallIndexService,
    WallWorkService,
    PayloadRefsSweepService,
    RunKindRowsCache,
    MessageSendService,
    ItemDao,
    NodeStateDao,
    WallTurnDao,
    CallContextDao,
    ThreadMessageDao,
    ThreadInboxService,
    RunDao,
    RunGroupDao,
    ProjectDao,
    MemoryImportService,
    MemoryCheckService,
    OneShotAskService,
    {
      // Every CLI the daemon drives, each built by its own `forDaemon` — which
      // is where that CLI decides its directories, its stores and its probes.
      // This list is the whole of what registering a new agent takes here.
      provide: AGENT_ADAPTERS,
      inject: [
        ModelVocabularyStore,
        AgentVersionService,
        ProcessRegistry,
        ModelPriceCatalog,
        HostToolResultLedger,
      ],
      useFactory: (
        vocabularyStore: ModelVocabularyStore,
        versions: AgentVersionService,
        processes: ProcessRegistry,
        prices: ModelPriceCatalog,
        hostToolResults: HostToolResultLedger,
      ) => {
        const deps: AdapterDaemonDeps = {
          userDataDir: environment.userDataDir,
          // The `agent-stdio` debug channel, wired at the ONE seam every
          // adapter already shares. Inert unless that channel is switched on,
          // and it knows nothing about which CLI it is wrapping — see
          // `createTeeingSpawn` for why the spawn is the right seam.
          spawn: createTeeingSpawn(defaultSpawn),
          // Without a real sink the base class's diagnostics (skipped
          // unparseable lines, unmodelled control subtypes, a failed turn
          // resource disposer) are `?.warn` on undefined — silently discarded
          // in the one build that matters.
          logger: (name) => new Logger(name),
          vocabularyStore,
          versions,
          processes,
          clientVersion: DAEMON_VERSION,
          prices,
          hostToolResults,
        };
        return [
          ClaudeAdapter.forDaemon(deps),
          CursorAcpAdapter.forDaemon(deps),
          CodexAdapter.forDaemon(deps),
        ];
      },
    },
  ],
  exports: [
    AnalysisBroker,
    // For the notifications gateway, which broadcasts each alert-list change.
    ResourceAlertEventBus,
    // For the teams module's team analysis ("Analyze & improve"), which
    // checks the library before starting one here.
    ThreadAnalysisService,
    // For the teams module's pool cooldowns, which key a member by the account
    // its folder pins, as the plan-limits readout does.
    ConfigDirPinService,
    ThreadReaderService,
    // For the MCP host's `save_project_instructions`.
    ProjectInstructionsChangeService,
    KnowledgeItemsService,
    GlobalChatSearchService,
    AgentEventBus,
    // For `McpModule`'s MCP host, which files each result it serves here for a
    // CLI that reports none (`HostToolResultLedger`).
    HostToolResultLedger,
    ApprovalRegistry,
    // Exported for `McpModule` (`v1/mcp`): its MCP host serves the
    // `ask_user_question` tool through this broker, and the turn that can
    // actually put the card on screen registers here.
    UserQuestionBroker,
    // Exported on the same terms: the MCP host serves the RENDER family —
    // `report_findings`, `show_chart` and `propose_patch` — through these
    // brokers, and the turn that can actually persist the row (and, for a
    // patch, write the file) registers here.
    FindingsReportBroker,
    ChartBroker,
    PatchBroker,
    ProjectInstructionsBroker,
    ComparisonBroker,
    MetricsBroker,
    GalleryBroker,
    BrowserBroker,
    // For show_gallery, which downloads the pictures a call names by URL.
    GalleryImageService,
    ArtifactBroker,
    ActionBroker,
    // For the MCP host's monitor tools and the team executor, which registers
    // each member's sink and delivers its monitors' output; for the run-process
    // panel and teardown, which list and stop them.
    MonitorBroker,
    MonitorRegistry,
    // For the MCP host's team-note tools and the team executor, which registers
    // each member's sink and reads the unread figure into call replies and wakes.
    TeamNoteBroker,
    RunOutcomeBroker,
    GoalsService,
    GoalDao,
    RunOutcomeHistoryService,
    // For the team delivery, which records the end of output it drops.
    MonitorRowWriter,
    // For the share service, which wakes the agent that asked once a share
    // waiting on the user's sign-in lands, and the team delivery of it.
    HostWakeBus,
    // For the team executor, which wakes a member whose command ended after its turn.
    CommandEndWakeService,
    WriteFailureNotices,
    // For the team module, which reports its runs' blocked conversations.
    AgentActivityService,
    // For the task board, which keeps a card's worktree while its run works
    // outside a turn, and the team module, which adds its own sources.
    RunLiveWork,
    // What a team member's button tools and the team press route reuse:
    // the publish (over `ChatActionsService`, the rows' one writer) and the
    // press beside it.
    ActionPublishService,
    ActionPressService,
    GoalWritersBroker,
    TeamProposalBroker,
    TeamBuilderBroker,
    ProjectChatBroker,
    CommandCenterBroker,
    CommandCenterOpsBroker,
    // And the store behind it: a TEAM member publishes a page too, and the
    // executor is the turn that persists that row.
    ArtifactStoreService,
    ChatArtifactsService,
    // For v1/shares, which encrypts the same document a saved file carries.
    ArtifactPageService,
    PlanBroker,
    NotifyBroker,
    PartialStreamService,
    ProcessRegistry,
    // Exported for the team executor: a follow-up message to a team run
    // carries pictures the way a chat's does, saved under the run it joins.
    AttachmentStoreService,
    // Exported so the team executor's own run delete reaches the same
    // teardown obligation a chat delete does — a run-scoped CLI process is
    // reaped by nothing else.
    AgentSessionRegistry,
    // Exported so a server sign-in can re-check the server until it SEES it
    // connected, through the one path that also patches every reading of it.
    AgentMcpService,
    SubagentRecoveryService,
    // Exported for main.ts's boot sweep — it runs before the server listens,
    // beside the other reconciles a crashed launch leaves behind.
    StrandedChildReaper,
    // Exported so the TEAM run listing backfills its pull requests the way
    // the chat listing does. The live capture rides the event bus and covers a
    // run whose turns end while a window is open; this covers the rest — a run
    // whose `gh pr create` landed while the daemon was down, and every run that
    // predates the capture existing, whose marker is null and is therefore read
    // once from the beginning.
    PullRequestCaptureService,
    // Exported so `CliAuthService` can drop an agent's cached answers the
    // moment it signs that agent in or out: a different account is a different
    // set of models, and nothing about that moves the CLI's `--version`. The
    // reset service rather than the store alone, because every in-memory mirror
    // of the store is consulted before it (`CacheResetService.forgetAgent`).
    CacheResetService,
    // Exported for the team executor's own run delete: one teardown serves
    // both run kinds, so neither can drift out of clearing a store.
    RunTeardownService,
    // Exported for the team executor: a team run's rows are numbered by
    // the same allocator a chat's are, since its kept agent processes write
    // between passes.
    ItemSeqAllocator,
    RunWriteQueue,
    // Exported for the team executor's writes, which stamp each row's call
    // the way a chat's do.
    ItemCallIndexService,
    // Exported for the team executor, which catches a member's wall-clock work
    // up after each turn its CLI did not time, and for the boot sweep.
    WallWorkService,
    // Exported for the team executor and the handoff, which read usage rows and call records through it.
    RunKindRowsCache,
    MessageSendService,
    SkillHarvestStore,
    // Exported for the team executor's own turn seam: a member's turn reports
    // what it loaded, and that report is what keeps the MCP panel off a cold
    // re-dial.
    McpHarvestStore,
    // Exported for the tasks module: a card's description holds pictures too —
    // a pasted screenshot, a diagram dropped in — and how a local picture
    // reaches the screen has ONE reader in this app.
    LocalImageService,
    ItemDao,
    NodeStateDao,
    WallTurnDao,
    CallContextDao,
    ThreadInboxService,
    RunDao,
    AgentAdapterRegistry,
    // Exported for the diagnostics report, which names each CLI and the
    // version that binary answers with. Through this ONE service so the
    // report costs no new spawn: it serves the same per-binary memo the rest
    // of the daemon reads.
    AgentVersionService,
    // Exported for the board tools' `board_vocabulary`, which lists one CLI's
    // model ids and effort levels so an agent filing a card can spell them —
    // through the same cached listings the composer reads.
    ModelsService,
    EffortsService,
    // Exported so a TEAM run is filed by the same rule a chat is: a group
    // can claim a team by slug, and the executor is the only place a
    // team run row is created.
    RunGroupsService,
    // Exported for the tasks module: pressing Run on a card starts an ORDINARY
    // chat, so it needs the same service the chat routes use rather than a
    // second execution path of its own. Nest encapsulation makes this entry
    // required for that injection, not merely tidy.
    //
    // The service alone, and the import runs one way — `TasksModule` imports
    // this module, never the reverse, as `TeamsModule` already does.
    ChatService,
    // For the lessons module, which takes a delete with "Extract lessons first".
    ExtractLessonsOnDeleteRegistry,
  ],
})
export class AgentsModule {}
