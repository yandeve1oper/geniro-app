import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { type RuntimeInfo } from './auth/runtime';
import { RuntimeModule } from './auth/runtime.module';
import { LoopbackTokenGuard } from './auth/token.guard';
import { environment } from './environments';
import { IdleShutdownLifecycle } from './utils/idle-shutdown.lifecycle';
import { InstanceLockLifecycle } from './utils/instance-lock.lifecycle';
import { PidfileLifecycle } from './utils/pidfile.lifecycle';
import { AgentsModule } from './v1/agents/agents.module';
import { AgentSessionRegistry } from './v1/agents/services/agent-session.registry';
import { ProcessRegistry } from './v1/agents/services/process-registry';
import { AuthModule } from './v1/auth/auth.module';
import { DiagnosticsModule } from './v1/diagnostics/diagnostics.module';
import { HandoffModule } from './v1/handoff/handoff.module';
import { KnowledgeModule } from './v1/knowledge/knowledge.module';
import { LessonsModule } from './v1/lessons/lessons.module';
import { McpModule } from './v1/mcp/mcp.module';
import { MemoryModule } from './v1/memory/memory.module';
import { MigrationsModule } from './v1/migrations/migrations.module';
import { NotificationsModule } from './v1/notifications/notifications.module';
import { WsPresenceService } from './v1/notifications/services/ws-presence.service';
import { ProjectsModule } from './v1/projects/projects.module';
import { RunsModule } from './v1/runs/runs.module';
import { SharesModule } from './v1/shares/shares.module';
import { StatsModule } from './v1/stats/stats.module';
import { StorageModule } from './v1/storage/storage.module';
import { TasksModule } from './v1/tasks/tasks.module';
import { TeamsModule } from './v1/teams/teams.module';

export interface AppModuleOptions {
  runtime: RuntimeInfo;
}

/**
 * The daemon's domain module. Infra (HTTP server, mikro-orm, metrics, logger)
 * is wired via bootstrapper extensions in main.ts — mirroring how Geniro's
 * apps/api keeps AppModule free of infra imports. The per-launch runtime is
 * exposed app-wide via the global RuntimeModule (so the HTTP token guard and
 * the notifications gateway both read it).
 */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        RuntimeModule.forRoot(options.runtime),
        RunsModule,
        AgentsModule,
        TeamsModule,
        McpModule,
        DiagnosticsModule,
        NotificationsModule,
        HandoffModule,
        AuthModule,
        StatsModule,
        ProjectsModule,
        TasksModule,
        SharesModule,
        MemoryModule,
        LessonsModule,
        KnowledgeModule,
        StorageModule,
        MigrationsModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: LoopbackTokenGuard },
        PidfileLifecycle,
        InstanceLockLifecycle,
        {
          // Factory because the window is config and the trailing options bag
          // is a test seam. Lives here rather than in either module it reads:
          // "is anyone connected" belongs to notifications and "is anything
          // running" to agents, and the decision to exit belongs to neither.
          provide: IdleShutdownLifecycle,
          useFactory: (
            presence: WsPresenceService,
            processes: ProcessRegistry,
            sessions: AgentSessionRegistry,
          ) =>
            new IdleShutdownLifecycle(
              environment.idleExitMs,
              presence,
              processes,
              sessions,
            ),
          inject: [WsPresenceService, ProcessRegistry, AgentSessionRegistry],
        },
      ],
    };
  }
}
