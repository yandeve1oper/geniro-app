import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import {
  EditLessonDto,
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
 * The user's lessons: what reflections found, Save or Reject on a lesson that
 * waits, and Undo, Edit or Approve on one filed on its own. Open to paired
 * devices — deciding on a lesson spends nothing.
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

  /** "Undo" on a lesson filed on its own: its memory entry is forgotten, restorable. 409 `LESSON_NOT_FILED`. */
  @Post('proposals/:proposalId/undo')
  @ApiOperation({ operationId: 'undoLesson' })
  @ZodResponse({ status: 201, type: LessonProposalDto })
  undo(@Param('proposalId') proposalId: string): Promise<LessonProposalWire> {
    return this.proposals.undo(proposalId);
  }

  /** "Edit" on a lesson filed on its own: the entry takes the text and becomes the user's own. 409 `LESSON_NOT_FILED` or `LESSON_ENTRY_GONE`. */
  @Post('proposals/:proposalId/edit')
  @ApiOperation({ operationId: 'editLesson' })
  @ZodResponse({ status: 201, type: LessonProposalDto })
  edit(
    @Param('proposalId') proposalId: string,
    @Body() dto: EditLessonDto,
  ): Promise<LessonProposalWire> {
    return this.proposals.edit(proposalId, dto);
  }

  /** "Approve" on a lesson filed on its own: the entry joins the memory index. 409 `LESSON_NOT_FILED` or `LESSON_ENTRY_GONE`. */
  @Post('proposals/:proposalId/approve')
  @ApiOperation({ operationId: 'approveLesson' })
  @ZodResponse({ status: 201, type: LessonProposalDto })
  approve(
    @Param('proposalId') proposalId: string,
  ): Promise<LessonProposalWire> {
    return this.proposals.approve(proposalId);
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
