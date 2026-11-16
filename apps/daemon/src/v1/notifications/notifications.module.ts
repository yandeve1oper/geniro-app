import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { BrowserModule } from '../browser/browser.module';
import { DiagnosticsModule } from '../diagnostics/diagnostics.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { LessonsModule } from '../lessons/lessons.module';
import { MemoryModule } from '../memory/memory.module';
import { ProjectsModule } from '../projects/projects.module';
import { SharesModule } from '../shares/shares.module';
import { StatsModule } from '../stats/stats.module';
import { TasksModule } from '../tasks/tasks.module';
import { NotificationsGateway } from './gateways/notifications.gateway';
import { WsPresenceService } from './services/ws-presence.service';

/**
 * Owns the renderer ⇄ daemon Socket.IO channel. The gateway pulls the
 * per-launch token from the global {@link RuntimeModule} and subscribes to the
 * {@link AgentEventBus} (imported from {@link AgentsModule}) to fan run items
 * out to per-run rooms.
 */
@Module({
  // `DiagnosticsModule` for the debug stream this gateway fans out. The
  // direction matters: diagnostics observes the agent plane and this channel
  // observes diagnostics, so nothing under `v1/agents` or `v1/diagnostics`
  // depends on the gateway and there is no cycle.
  // `StatsModule` for the usage bus, and `TasksModule` for the task bus, on the
  // same terms: each module observes its own writes, this channel observes
  // each bus, and nothing under any of them depends on the gateway — so there
  // is still no cycle. `SharesModule` for the share bus, `MemoryModule` for the
  // memory bus and `KnowledgeModule` for the knowledge bus, likewise, and
  // `ProjectsModule` for the project bus. `BrowserModule` for the bridge to the
  // Mac's browser window, a leaf with no dependency on this channel.
  imports: [
    AgentsModule,
    DiagnosticsModule,
    StatsModule,
    TasksModule,
    SharesModule,
    MemoryModule,
    KnowledgeModule,
    ProjectsModule,
    BrowserModule,
    LessonsModule,
  ],
  providers: [NotificationsGateway, WsPresenceService],
  // Exported for the idle shutdown: "is anyone connected?" is a fact only this
  // channel holds, and the decision to exit on it belongs elsewhere.
  exports: [WsPresenceService],
})
export class NotificationsModule {}
