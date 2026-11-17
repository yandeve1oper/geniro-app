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
  UpdateLessonRuleDto,
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
   * Save a proposed lesson where its target says, as the user: memory, one
   * line of the project's or a member's instructions, or a project knowledge
   * document. 409 `LESSON_DECIDED`, `MEMORY_NEAR_DUPLICATE`,
   * `LESSON_NO_PROJECT`, `LESSON_NO_TEAM`, `PROJECT_INSTRUCTIONS_DRIFT`,
   * `LESSON_INSTRUCTIONS_TOO_LONG`, `LESSON_MEMBER_GONE`, `LESSON_TEAM_GONE`,
   * `LESSON_HASH_DRIFT`, `LESSON_DOCUMENT_GONE` or `LESSON_DOCUMENT_CHANGED`.
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

  /** "Update rule" on a lesson that refines a memory entry: the entry takes its text as the user's edit. 409 `LESSON_NOT_A_REFINEMENT`, `LESSON_ENTRY_GONE` or `MEMORY_STALE`. */
  @Post('proposals/:proposalId/update-rule')
  @ApiOperation({ operationId: 'updateLessonRule' })
  @ZodResponse({ status: 201, type: LessonProposalDto })
  updateRule(
    @Param('proposalId') proposalId: string,
    @Body() dto: UpdateLessonRuleDto,
  ): Promise<LessonProposalWire> {
    return this.proposals.updateRule(proposalId, dto);
  }

  /** "Move up" on a rule broken again: its entry into every chat's memory index. 409 `LESSON_NOT_BROKEN_AGAIN`, `LESSON_ALREADY_INDEXED`. */
  @Post('proposals/:proposalId/move-up')
  @ApiOperation({ operationId: 'moveLessonUp' })
  @ZodResponse({ status: 201, type: LessonProposalDto })
  moveUp(@Param('proposalId') proposalId: string): Promise<LessonProposalWire> {
    return this.proposals.moveUp(proposalId);
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
