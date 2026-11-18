import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { ProjectsModule } from '../projects/projects.module';
import { TasksModule } from '../tasks/tasks.module';
import { TeamsModule } from '../teams/teams.module';
import { CommandCenterController } from './controllers/command-center.controller';
import { CommandCenterRosterDao } from './dao/command-center-roster.dao';
import { CommandCenterTimelineDao } from './dao/command-center-timeline.dao';
import { CommandCenterService } from './services/command-center.service';
import { CommandCenterChatService } from './services/command-center-chat.service';
import { CommandCenterEventBus } from './services/command-center-events.bus';
import { CommandCenterEventsService } from './services/command-center-events.service';
import { CommandCenterOpsService } from './services/command-center-ops.service';
import { CommandCenterStartsService } from './services/command-center-starts.service';
import { CommandCenterTimelineService } from './services/command-center-timeline.service';

/**
 * The command center: one board over every active thread, and the manager
 * chat that watches, messages and starts them.
 *
 * It sits above Agents, Teams, Tasks and Projects and imports them one way —
 * none of them imports it back. What they must reach of it is installed into
 * them at boot instead: the manager's brief into `ChatService`
 * (`useCommandCenter`), and its tools' operations into `CommandCenterOpsBroker`.
 * `CommandCenterEventBus` is exported for `NotificationsModule`, the one
 * fan-out subscriber, on `TaskEventBus`'s terms.
 */
@Module({
  imports: [AgentsModule, TeamsModule, TasksModule, ProjectsModule],
  controllers: [CommandCenterController],
  providers: [
    CommandCenterRosterDao,
    CommandCenterTimelineDao,
    CommandCenterEventBus,
    CommandCenterService,
    CommandCenterChatService,
    CommandCenterStartsService,
    CommandCenterOpsService,
    CommandCenterEventsService,
    CommandCenterTimelineService,
  ],
  exports: [CommandCenterEventBus],
})
export class CommandCenterModule {}
