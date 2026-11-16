import type { ActionBroker } from '../../agents/services/action.broker';
import type { AnalysisBroker } from '../../agents/services/analysis.broker';
import type { ArtifactBroker } from '../../agents/services/artifact.broker';
import type { AttachmentStoreService } from '../../agents/services/attachment-store.service';
import type { BrowserBroker } from '../../agents/services/browser.broker';
import type { ChartBroker } from '../../agents/services/chart.broker';
import type { ComparisonBroker } from '../../agents/services/comparison.broker';
import type { FindingsReportBroker } from '../../agents/services/findings-report.broker';
import type { GalleryBroker } from '../../agents/services/gallery.broker';
import type { GalleryImageService } from '../../agents/services/gallery-image.service';
import type { GlobalChatSearchService } from '../../agents/services/global-chat-search.service';
import type { GoalWritersBroker } from '../../agents/services/goal-writers.broker';
import type { GoalsService } from '../../agents/services/goals.service';
import type { KnowledgeItemsService } from '../../agents/services/knowledge-items.service';
import type { MetricsBroker } from '../../agents/services/metrics.broker';
import type { MonitorBroker } from '../../agents/services/monitor.broker';
import type { NotifyBroker } from '../../agents/services/notify.broker';
import type { PatchBroker } from '../../agents/services/patch.broker';
import type { PlanBroker } from '../../agents/services/plan.broker';
import type { ProjectChatBroker } from '../../agents/services/project-chat.broker';
import type { ProjectInstructionsBroker } from '../../agents/services/project-instructions.broker';
import type { ProjectInstructionsChangeService } from '../../agents/services/project-instructions-change.service';
import type { RunOutcomeBroker } from '../../agents/services/run-outcome.broker';
import type { TeamBuilderBroker } from '../../agents/services/team-builder.broker';
import type { TeamNoteBroker } from '../../agents/services/team-note.broker';
import type { TeamProposalBroker } from '../../agents/services/team-proposal.broker';
import type { ThreadReaderService } from '../../agents/services/thread-reader.service';
import type { UserQuestionBroker } from '../../agents/services/user-question.broker';
import type { KnowledgeService } from '../../knowledge/services/knowledge.service';
import type { LessonFilingService } from '../../lessons/services/lesson-filing.service';
import type { MemoryService } from '../../memory/services/memory.service';
import type { ShareService } from '../../shares/services/share.service';
import type { TeamHistoryService } from '../../stats/services/team-history.service';
import type { CallBroker } from '../../teams/services/call-broker.service';
import type { StageService } from '../../teams/services/stage.service';
import type { TaskBoardBroker } from '../../teams/services/task-board.broker';
import type { TeamChangeService } from '../../teams/services/team-change.service';
import type { TeamOverlayService } from '../../teams/services/team-overlay.service';
import type { TeamProposalService } from '../../teams/services/team-proposal.service';
import type { TeamStoreService } from '../../teams/services/team-store.service';
import type { ThreadDeliveryService } from '../../teams/services/thread-delivery.service';
import type { McpTool } from '../mcp.types';
import { AnswerAgentTool } from './answer-agent/answer-agent.tool';
import { AskUserQuestionTool } from './ask-user-question/ask-user-question.tool';
import { AwaitAgentTool } from './await-agent/await-agent.tool';
import { BackupTeamTool } from './backup-team/backup-team.tool';
import { BoardTools } from './board/board.tools';
import { createBrowserTools } from './browser-shared/browser-tools';
import { CallAgentTool } from './call-agent/call-agent.tool';
import { CancelAgentTool } from './cancel-agent/cancel-agent.tool';
import { GoalsTool } from './goals/goals.tool';
import { KnowledgeReadTool } from './knowledge-read/knowledge-read.tool';
import { KnowledgeSaveTool } from './knowledge-save/knowledge-save.tool';
import { KnowledgeSearchTool } from './knowledge-search/knowledge-search.tool';
import { ListAgentThreadsTool } from './list-agent-threads/list-agent-threads.tool';
import { ListMonitorsTool } from './list-monitors/list-monitors.tool';
import { ListThreadsTool } from './list-threads/list-threads.tool';
import { MarkRecommendationsTool } from './mark-recommendations/mark-recommendations.tool';
import { MemoryForgetTool } from './memory-forget/memory-forget.tool';
import { MemoryReadTool } from './memory-read/memory-read.tool';
import { MemorySaveTool } from './memory-save/memory-save.tool';
import { MemorySearchTool } from './memory-search/memory-search.tool';
import { MessageAgentTool } from './message-agent/message-agent.tool';
import { MessageThreadTool } from './message-thread/message-thread.tool';
import { MonitorTool } from './monitor/monitor.tool';
import { MoveStageTool } from './move-stage/move-stage.tool';
import { NotifyUserTool } from './notify-user/notify-user.tool';
import { ProposeLessonsTool } from './propose-lessons/propose-lessons.tool';
import { ProposePatchTool } from './propose-patch/propose-patch.tool';
import { ProposePlanTool } from './propose-plan/propose-plan.tool';
import { ProposeTeamTool } from './propose-team/propose-team.tool';
import { PublishActionTool } from './publish-action/publish-action.tool';
import { ReadAnalyzedThreadTool } from './read-analyzed-thread/read-analyzed-thread.tool';
import { ReadChatContextTool } from './read-chat-context/read-chat-context.tool';
import { ReadTeamsTool } from './read-teams/read-teams.tool';
import { RecordOutcomeTool } from './record-outcome/record-outcome.tool';
import { RemoveActionTool } from './remove-action/remove-action.tool';
import { ReportFindingsTool } from './report-findings/report-findings.tool';
import { ReportRecommendationsTool } from './report-recommendations/report-recommendations.tool';
import { SaveProjectInstructionsTool } from './save-project-instructions/save-project-instructions.tool';
import { SaveTeamChangeTool } from './save-team-change/save-team-change.tool';
import { SearchChatsTool } from './search-chats/search-chats.tool';
import { ShowArtifactTool } from './show-artifact/show-artifact.tool';
import { ShowChartTool } from './show-chart/show-chart.tool';
import { ShowComparisonTool } from './show-comparison/show-comparison.tool';
import { ShowGalleryTool } from './show-gallery/show-gallery.tool';
import { ShowMetricsTool } from './show-metrics/show-metrics.tool';
import { StopMonitorTool } from './stop-monitor/stop-monitor.tool';
import { TeamNoteTool } from './team-note/team-note.tool';
import { TeamNotesTool } from './team-notes/team-notes.tool';

/** The DI token the ordered tool list is provided under. */
export const MCP_TOOLS = Symbol('MCP_TOOLS');

/** What the tools answer through — the brokers they sit in front of. */
export interface McpToolDeps {
  calls: CallBroker;
  questions: UserQuestionBroker;
  findings: FindingsReportBroker;
  charts: ChartBroker;
  metrics: MetricsBroker;
  comparisons: ComparisonBroker;
  galleries: GalleryBroker;
  galleryImages: GalleryImageService;
  artifacts: ArtifactBroker;
  browser: BrowserBroker;
  attachments: AttachmentStoreService;
  actions: ActionBroker;
  monitors: MonitorBroker;
  teamNotes: TeamNoteBroker;
  runOutcomes: RunOutcomeBroker;
  goals: GoalsService;
  goalWriters: GoalWritersBroker;
  stages: StageService;
  patches: PatchBroker;
  plans: PlanBroker;
  notices: NotifyBroker;
  board: TaskBoardBroker;
  history: GlobalChatSearchService;
  memory: MemoryService;
  knowledge: KnowledgeService;
  knowledgeItems: KnowledgeItemsService;
  analysis: AnalysisBroker;
  lessons: LessonFilingService;
  threads: ThreadReaderService;
  teamChanges: TeamChangeService;
  projectInstructions: ProjectInstructionsChangeService;
  projectInstructionCards: ProjectInstructionsBroker;
  teamHistory: TeamHistoryService;
  teamGate: TeamProposalBroker;
  teamBuilders: TeamBuilderBroker;
  projectChats: ProjectChatBroker;
  teamStore: TeamStoreService;
  teamOverlays: TeamOverlayService;
  teamProposals: TeamProposalService;
  shares: ShareService;
  threadDelivery: ThreadDeliveryService;
}

/**
 * Every tool geniro's MCP endpoint serves, in the order `tools/list` names
 * them.
 *
 * The order is part of what a model reads — the descriptions are audited as a
 * SET (`mcp-server.service.spec.ts`) — so it is written once, here: the call
 * surface, the team notes, the run outcome and goals, then the question, the render family, the in-app browser, the action buttons, the
 * monitors, the board, the chat history, the team library, the analysis tools, and the
 * agent's own notification last.
 */
export function createMcpTools(deps: McpToolDeps): McpTool[] {
  return [
    new CallAgentTool(deps.calls),
    new AwaitAgentTool(deps.calls),
    new AnswerAgentTool(deps.calls),
    new CancelAgentTool(deps.calls),
    new MessageAgentTool(deps.calls),
    new ListAgentThreadsTool(deps.calls),
    new TeamNoteTool(deps.teamNotes),
    new TeamNotesTool(deps.teamNotes),
    new RecordOutcomeTool(deps.runOutcomes),
    new MoveStageTool(deps.stages, deps.calls),
    new GoalsTool(deps.goals, deps.goalWriters),
    new AskUserQuestionTool(deps.questions),
    new ReportFindingsTool(deps.findings),
    new ShowChartTool(deps.charts),
    new ShowMetricsTool(deps.metrics),
    new ShowComparisonTool(deps.comparisons),
    new ShowGalleryTool(deps.galleries, deps.galleryImages),
    new ShowArtifactTool(deps.artifacts, deps.shares),
    ...createBrowserTools(deps.browser, deps.attachments),
    new ProposePatchTool(deps.patches),
    new ProposePlanTool(deps.plans),
    new PublishActionTool(deps.actions),
    new RemoveActionTool(deps.actions),
    new MonitorTool(deps.monitors),
    new StopMonitorTool(deps.monitors),
    new ListMonitorsTool(deps.monitors),
    new BoardTools(deps.board),
    new SearchChatsTool(deps.history),
    new ReadChatContextTool(deps.history),
    new ListThreadsTool(deps.threadDelivery, deps),
    new MessageThreadTool(deps.threadDelivery, deps),
    new MemorySearchTool(deps.memory),
    new MemoryReadTool(deps.memory),
    new MemorySaveTool(deps.memory),
    new MemoryForgetTool(deps.memory),
    new KnowledgeSearchTool(deps.knowledge, deps),
    new KnowledgeReadTool(deps.knowledge, deps),
    new KnowledgeSaveTool(deps.knowledge, deps, deps.knowledgeItems),
    new ReadTeamsTool(
      deps.teamGate,
      deps.teamStore,
      deps.teamOverlays,
      deps.teamProposals,
    ),
    new ProposeTeamTool(
      deps.teamGate,
      deps.teamBuilders,
      deps.projectChats,
      deps.analysis,
      deps.teamProposals,
    ),
    new ReadAnalyzedThreadTool(
      deps.analysis,
      deps.threads,
      deps.teamChanges,
      deps.teamHistory,
    ),
    new ReportRecommendationsTool(
      deps.analysis,
      deps.memory,
      deps.teamHistory,
      deps.knowledge,
    ),
    new MarkRecommendationsTool(deps.analysis),
    new ProposeLessonsTool(deps.analysis, deps.lessons),
    new SaveTeamChangeTool(
      deps.analysis,
      deps.teamBuilders,
      deps.threads,
      deps.teamChanges,
    ),
    new SaveProjectInstructionsTool(
      deps.analysis,
      deps.projectChats,
      deps.projectInstructions,
      deps.projectInstructionCards,
    ),
    new BackupTeamTool(deps.teamBuilders, deps.teamChanges),
    new NotifyUserTool(deps.notices),
  ];
}
