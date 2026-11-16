import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import {
  LessonEstimateQueryDto,
  LessonSegmentDto,
  LessonSegmentListDto,
  LessonSegmentListQueryDto,
  LessonsSpendDto,
  ThreadLessonEstimateDto,
} from '../dto/lessons.dto';
import type {
  LessonSegmentWire,
  LessonsSpend,
  ThreadLessonEstimate,
} from '../lessons.types';
import { LessonSegmentService } from '../services/lesson-segment.service';
import { LessonSpendService } from '../services/lesson-spend.service';

/**
 * The stretches queued for a reflection, Skip on the archive notice, what a
 * reflection would cost and what lessons cost so far. Open to paired devices
 * like "Reflect now": nothing here starts a run.
 */
@Controller('v1/lessons')
@ApiTags('lessons')
@ApiBearerAuth()
export class LessonSegmentsController {
  constructor(
    private readonly segments: LessonSegmentService,
    private readonly spending: LessonSpendService,
  ) {}

  @Get('segments')
  @ApiOperation({ operationId: 'listLessonSegments' })
  @ZodResponse({ status: 200, type: LessonSegmentListDto })
  async list(
    @Query() query: LessonSegmentListQueryDto,
  ): Promise<{ segments: LessonSegmentWire[] }> {
    return { segments: await this.segments.list(query) };
  }

  /** "Skip" on the archive notice: the queued stretch never runs. 409 `LESSON_SEGMENT_DECIDED` once it has started. */
  @Post('segments/:segmentId/skip')
  @ApiOperation({ operationId: 'skipLessonSegment' })
  @ZodResponse({ status: 201, type: LessonSegmentDto })
  skip(@Param('segmentId') segmentId: string): Promise<LessonSegmentWire> {
    return this.segments.skip(segmentId);
  }

  @Get('estimate')
  @ApiOperation({ operationId: 'estimateLessons' })
  @ZodResponse({ status: 200, type: ThreadLessonEstimateDto })
  estimate(
    @Query() query: LessonEstimateQueryDto,
  ): Promise<ThreadLessonEstimate> {
    return this.segments.threadEstimate(query);
  }

  @Get('spend')
  @ApiOperation({ operationId: 'getLessonsSpend' })
  @ZodResponse({ status: 200, type: LessonsSpendDto })
  spend(): Promise<LessonsSpend> {
    return this.spending.spend();
  }
}
