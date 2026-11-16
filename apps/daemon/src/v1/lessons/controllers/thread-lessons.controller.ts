import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import {
  LessonsReflectStartedDto,
  ReflectLessonsDto,
  ThreadLessonsStateDto,
} from '../dto/lessons.dto';
import type { ThreadLessonsState } from '../lessons.types';
import {
  LessonReflectionService,
  type LessonsReflectStarted,
} from '../services/lesson-reflection.service';

/** One thread's lessons reflection: whether it can run now, and "Reflect now". */
@Controller('v1/chats')
@ApiTags('lessons')
@ApiBearerAuth()
export class ThreadLessonsController {
  constructor(private readonly reflections: LessonReflectionService) {}

  @Get(':runId/lessons')
  @ApiOperation({ operationId: 'getThreadLessonsState' })
  @ZodResponse({ status: 200, type: ThreadLessonsStateDto })
  state(@Param('runId') runId: string): Promise<ThreadLessonsState> {
    return this.reflections.state(runId);
  }

  /**
   * "Reflect now": a hidden reflection over the thread's items past its last
   * one. 409 `LESSONS_NOTHING_NEW`, `LESSONS_REFLECTING` or
   * `LESSONS_NOT_REFLECTABLE`.
   */
  @Post(':runId/lessons/reflect')
  @ApiOperation({ operationId: 'reflectLessons' })
  @ZodResponse({ status: 201, type: LessonsReflectStartedDto })
  reflect(
    @Param('runId') runId: string,
    @Body() dto: ReflectLessonsDto,
  ): Promise<LessonsReflectStarted> {
    return this.reflections.start(runId, dto);
  }
}
