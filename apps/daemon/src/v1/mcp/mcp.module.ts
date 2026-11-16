import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { ActionBroker } from '../agents/services/action.broker';
import { AnalysisBroker } from '../agents/services/analysis.broker';
import { ArtifactBroker } from '../agents/services/artifact.broker';
import { AttachmentStoreService } from '../agents/services/attachment-store.service';
import { BrowserBroker } from '../agents/services/browser.broker';
import { ChartBroker } from '../agents/services/chart.broker';
import { ComparisonBroker } from '../agents/services/comparison.broker';
import { FindingsReportBroker } from '../agents/services/findings-report.broker';
import { GalleryBroker } from '../agents/services/gallery.broker';
import { GalleryImageService } from '../agents/services/gallery-image.service';
import { GlobalChatSearchService } from '../agents/services/global-chat-search.service';
import { GoalWritersBroker } from '../agents/services/goal-writers.broker';
import { GoalsService } from '../agents/services/goals.service';
import { KnowledgeItemsService } from '../agents/services/knowledge-items.service';
import { MetricsBroker } from '../agents/services/metrics.broker';
import { MonitorBroker } from '../agents/services/monitor.broker';
import { NotifyBroker } from '../agents/services/notify.broker';
import { PatchBroker } from '../agents/services/patch.broker';
import { PlanBroker } from '../agents/services/plan.broker';
import { ProjectChatBroker } from '../agents/services/project-chat.broker';
import { ProjectInstructionsBroker } from '../agents/services/project-instructions.broker';
import { ProjectInstructionsChangeService } from '../agents/services/project-instructions-change.service';
import { RunOutcomeBroker } from '../agents/services/run-outcome.broker';
import { TeamBuilderBroker } from '../agents/services/team-builder.broker';
import { TeamNoteBroker } from '../agents/services/team-note.broker';
import { TeamProposalBroker } from '../agents/services/team-proposal.broker';
import { ThreadReaderService } from '../agents/services/thread-reader.service';
import { UserQuestionBroker } from '../agents/services/user-question.broker';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { KnowledgeService } from '../knowledge/services/knowledge.service';
import { LessonsModule } from '../lessons/lessons.module';
import { LessonFilingService } from '../lessons/services/lesson-filing.service';
import { MemoryModule } from '../memory/memory.module';
import { MemoryService } from '../memory/services/memory.service';
import { ShareService } from '../shares/services/share.service';
import { SharesModule } from '../shares/shares.module';
import { TeamHistoryService } from '../stats/services/team-history.service';
import { StatsModule } from '../stats/stats.module';
import { CallBroker } from '../teams/services/call-broker.service';
import { StageService } from '../teams/services/stage.service';
import { TaskBoardBroker } from '../teams/services/task-board.broker';
import { TeamChangeService } from '../teams/services/team-change.service';
import { TeamOverlayService } from '../teams/services/team-overlay.service';
import { TeamProposalService } from '../teams/services/team-proposal.service';
import { TeamStoreService } from '../teams/services/team-store.service';
import { ThreadDeliveryService } from '../teams/services/thread-delivery.service';
import { TeamsModule } from '../teams/teams.module';
import { McpController } from './controllers/mcp.controller';
import { McpServerService } from './services/mcp-server.service';
import { createMcpTools, MCP_TOOLS } from './tools/mcp-tools';

/**
 * geniro's own MCP surface: the per-run endpoint (`/v1/mcp/<runId>/<nodeId>`)
 * and every tool it serves.
 *
 * Its own module because it sits ABOVE the two it serves: the render family's
 * brokers live in {@link AgentsModule}, the call runtime and the board's
 * rendezvous in {@link TeamsModule}, and the host needs both — and the
 * team history an analysis reads in {@link StatsModule}, which sits above
 * those two. Nothing imports this module back.
 *
 * The tools are plain classes, one directory each under `tools/`, built by ONE
 * factory so their listing order is written in one place
 * ({@link createMcpTools}).
 */
@Module({
  imports: [
    AgentsModule,
    TeamsModule,
    SharesModule,
    MemoryModule,
    KnowledgeModule,
    StatsModule,
    LessonsModule,
  ],
  controllers: [McpController],
  providers: [
    {
      provide: MCP_TOOLS,
      useFactory: (
        calls: CallBroker,
        questions: UserQuestionBroker,
        findings: FindingsReportBroker,
        charts: ChartBroker,
        metrics: MetricsBroker,
        comparisons: ComparisonBroker,
        galleries: GalleryBroker,
        galleryImages: GalleryImageService,
        artifacts: ArtifactBroker,
        browser: BrowserBroker,
        attachments: AttachmentStoreService,
        actions: ActionBroker,
        monitors: MonitorBroker,
        teamNotes: TeamNoteBroker,
        runOutcomes: RunOutcomeBroker,
        goals: GoalsService,
        goalWriters: GoalWritersBroker,
        stages: StageService,
        patches: PatchBroker,
        plans: PlanBroker,
        notices: NotifyBroker,
        board: TaskBoardBroker,
        history: GlobalChatSearchService,
        memory: MemoryService,
        knowledge: KnowledgeService,
        analysis: AnalysisBroker,
        threads: ThreadReaderService,
        teamChanges: TeamChangeService,
        projectInstructions: ProjectInstructionsChangeService,
        projectInstructionCards: ProjectInstructionsBroker,
        teamHistory: TeamHistoryService,
        teamGate: TeamProposalBroker,
        teamBuilders: TeamBuilderBroker,
        projectChats: ProjectChatBroker,
        teamStore: TeamStoreService,
        teamOverlays: TeamOverlayService,
        teamProposals: TeamProposalService,
        shares: ShareService,
        threadDelivery: ThreadDeliveryService,
        knowledgeItems: KnowledgeItemsService,
        lessons: LessonFilingService,
      ) =>
        createMcpTools({
          calls,
          questions,
          findings,
          charts,
          metrics,
          comparisons,
          galleries,
          galleryImages,
          artifacts,
          browser,
          attachments,
          actions,
          monitors,
          teamNotes,
          runOutcomes,
          goals,
          goalWriters,
          stages,
          patches,
          plans,
          notices,
          board,
          history,
          memory,
          knowledge,
          analysis,
          threads,
          teamChanges,
          projectInstructions,
          projectInstructionCards,
          teamHistory,
          teamGate,
          teamBuilders,
          projectChats,
          teamStore,
          teamOverlays,
          teamProposals,
          shares,
          threadDelivery,
          knowledgeItems,
          lessons,
        }),
      inject: [
        CallBroker,
        UserQuestionBroker,
        FindingsReportBroker,
        ChartBroker,
        MetricsBroker,
        ComparisonBroker,
        GalleryBroker,
        GalleryImageService,
        ArtifactBroker,
        BrowserBroker,
        AttachmentStoreService,
        ActionBroker,
        MonitorBroker,
        TeamNoteBroker,
        RunOutcomeBroker,
        GoalsService,
        GoalWritersBroker,
        StageService,
        PatchBroker,
        PlanBroker,
        NotifyBroker,
        TaskBoardBroker,
        GlobalChatSearchService,
        MemoryService,
        KnowledgeService,
        AnalysisBroker,
        ThreadReaderService,
        TeamChangeService,
        ProjectInstructionsChangeService,
        ProjectInstructionsBroker,
        TeamHistoryService,
        TeamProposalBroker,
        TeamBuilderBroker,
        ProjectChatBroker,
        TeamStoreService,
        TeamOverlayService,
        TeamProposalService,
        ShareService,
        ThreadDeliveryService,
        KnowledgeItemsService,
        LessonFilingService,
      ],
    },
    McpServerService,
  ],
})
export class McpModule {}
