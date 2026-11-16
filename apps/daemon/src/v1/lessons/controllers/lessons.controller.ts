import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import {
  LessonProposalDto,
  LessonProposalListDto,
  LessonProposalListQueryDto,
  LessonReflectionFactsDto,
  RejectLessonDto,
  SaveLessonDto,
} from '../dto/lessons.dto';
import type {
  LessonProposalWire,
  LessonReflectionFacts,
} from '../lessons.types';
import { LessonProposalService } from '../services/lesson-proposal.service';

/**
 * The user's lessons: what reflections proposed, and Save or Reject on each.
 * Open to paired devices — deciding on a lesson spends nothing.
 */
@Controller('v1/lessons')
@ApiTags('lessons')
@ApiBearerAuth()
export class LessonsController {
  constructor(private readonly proposals: LessonProposalService) {}

  @Get('proposals')
  @ApiOperation({ operationId: 'listLessonProposals' })
  @ZodResponse({ status: 200, type: LessonProposalListDto })
  async list(
    @Query() query: LessonProposalListQueryDto,
  ): Promise<{ proposals: LessonProposalWire[] }> {
    return { proposals: await this.proposals.list(query) };
  }

  /**
   * Save a proposed lesson to the shared memory, as the user. 409
   * `LESSON_DECIDED`, `MEMORY_NEAR_DUPLICATE`, `LESSON_NO_PROJECT` or
   * `LESSON_NO_TEAM`.
   */
  @Post('proposals/:proposalId/save')
  @ApiOperation({ operationId: 'saveLesson' })
  @ZodResponse({ status: 201, type: LessonProposalDto })
  save(
    @Param('proposalId') proposalId: string,
    @Body() dto: SaveLessonDto,
  ): Promise<LessonProposalWire> {
    return this.proposals.save(proposalId, dto);
  }

  @Post('proposals/:proposalId/reject')
  @ApiOperation({ operationId: 'rejectLesson' })
  @ZodResponse({ status: 201, type: LessonProposalDto })
  reject(
    @Param('proposalId') proposalId: string,
    @Body() dto: RejectLessonDto,
  ): Promise<LessonProposalWire> {
    return this.proposals.reject(proposalId, dto);
  }

  @Get('reflections/:reflectionRunId')
  @ApiOperation({ operationId: 'getLessonReflection' })
  @ZodResponse({ status: 200, type: LessonReflectionFactsDto })
  reflection(
    @Param('reflectionRunId') reflectionRunId: string,
  ): Promise<LessonReflectionFacts> {
    return this.proposals.reflectionFacts(reflectionRunId);
  }
}
