import { Module } from '@nestjs/common';

import { DesktopOnlyGuard } from '../../auth/desktop-only.guard';
import { AgentsModule } from '../agents/agents.module';
import { MemoryModule } from '../memory/memory.module';
import { ProjectsModule } from '../projects/projects.module';
import { UsageEventDao } from '../stats/dao/usage-event.dao';
import { LessonsController } from './controllers/lessons.controller';
import { LessonsConfigController } from './controllers/lessons-config.controller';
import { ThreadLessonsController } from './controllers/thread-lessons.controller';
import { LessonProposalDao } from './dao/lesson-proposal.dao';
import { LessonSegmentDao } from './dao/lesson-segment.dao';
import { LessonFilingService } from './services/lesson-filing.service';
import { LessonProposalService } from './services/lesson-proposal.service';
import { LessonReflectionService } from './services/lesson-reflection.service';
import { LessonRowWriter } from './services/lesson-row.writer';
import { LessonsConfigService } from './services/lessons-config.service';

/**
 * Lessons (`v1/lessons`): a hidden reflection on a thread proposes lessons,
 * and the user saves them to the shared memory.
 *
 * `lesson_proposals` sits outside run teardown; `lesson_segments` goes with
 * its run (`LessonReflectionService`). It provides the usage ledger's DAO it
 * reads rather than importing `StatsModule`, and `McpModule` imports it for
 * `propose_lessons`.
 */
@Module({
  imports: [AgentsModule, MemoryModule, ProjectsModule],
  controllers: [
    ThreadLessonsController,
    LessonsController,
    LessonsConfigController,
  ],
  providers: [
    DesktopOnlyGuard,
    LessonProposalDao,
    LessonSegmentDao,
    UsageEventDao,
    LessonsConfigService,
    LessonRowWriter,
    LessonReflectionService,
    LessonFilingService,
    LessonProposalService,
  ],
  exports: [LessonFilingService],
})
export class LessonsModule {}
