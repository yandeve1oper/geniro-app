import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotFoundException } from '@packages/common';
import { ZodResponse } from 'nestjs-zod';

import {
  CreateKnowledgeDto,
  KnowledgeCountsDto,
  KnowledgeDocumentDetailDto,
  KnowledgeExportDto,
  KnowledgeExportQueryDto,
  KnowledgeHeadDetailDto,
  KnowledgeListDto,
  KnowledgeListQueryDto,
  KnowledgeRemovedDto,
  KnowledgeRevisionDetailDto,
  KnowledgeRevisionListDto,
  KnowledgeRunSearchDto,
  KnowledgeRunSearchQueryDto,
  RestoreKnowledgeRevisionDto,
  UpdateKnowledgeDto,
} from '../dto/knowledge.dto';
import type {
  KnowledgeCounts,
  KnowledgeDocumentDto,
  KnowledgeExport,
  KnowledgeHeadDto,
  KnowledgeList,
  KnowledgeRevisionDetail,
  KnowledgeRevisionList,
  KnowledgeRunSearch,
} from '../knowledge.types';
import { KnowledgeService } from '../services/knowledge.service';
import { refusalError, savedDocumentOrThrow } from '../utils/knowledge-outcome';

/**
 * The user's own view of the knowledge store: list, read, write, review,
 * history and export. Open to paired devices, as `/v1/memories` is: the user
 * reads, edits and approves from the phone too. Every write here is the user's.
 */
@Controller('v1/knowledge')
@ApiTags('knowledge')
@ApiBearerAuth()
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  @ApiOperation({ operationId: 'listKnowledge' })
  @ZodResponse({ status: 200, type: KnowledgeListDto })
  list(@Query() query: KnowledgeListQueryDto): Promise<KnowledgeList> {
    return this.knowledge.list(query);
  }

  @Get('runs/:runId/search')
  @ApiOperation({ operationId: 'searchKnowledgeForRun' })
  @ZodResponse({ status: 200, type: KnowledgeRunSearchDto })
  runSearch(
    @Param('runId') runId: string,
    @Query() query: KnowledgeRunSearchQueryDto,
  ): Promise<KnowledgeRunSearch> {
    return this.knowledge.runSearch(runId, query.q);
  }

  @Post()
  @ApiOperation({ operationId: 'createKnowledge' })
  @ZodResponse({ status: 201, type: KnowledgeDocumentDetailDto })
  async create(
    @Body() body: CreateKnowledgeDto,
  ): Promise<KnowledgeDocumentDto> {
    return savedDocumentOrThrow(await this.knowledge.create(body));
  }

  @Get('counts')
  @ApiOperation({ operationId: 'knowledgeCounts' })
  @ZodResponse({ status: 200, type: KnowledgeCountsDto })
  counts(): Promise<KnowledgeCounts> {
    return this.knowledge.counts();
  }

  @Get('export')
  @ApiOperation({ operationId: 'exportKnowledge' })
  @ZodResponse({ status: 200, type: KnowledgeExportDto })
  async export(
    @Query() query: KnowledgeExportQueryDto,
  ): Promise<KnowledgeExport> {
    const exported = await this.knowledge.exportMarkdown(query);
    if (exported === null) {
      throw new NotFoundException(
        'KNOWLEDGE_NOT_FOUND',
        'nothing to export there',
      );
    }
    return exported;
  }

  @Get('revisions/:revisionId')
  @ApiOperation({ operationId: 'readKnowledgeRevision' })
  @ZodResponse({ status: 200, type: KnowledgeRevisionDetailDto })
  async revision(
    @Param('revisionId') revisionId: string,
  ): Promise<KnowledgeRevisionDetail> {
    const revision = await this.knowledge.revision(revisionId);
    if (revision === null) {
      throw new NotFoundException(
        'KNOWLEDGE_NOT_FOUND',
        `no revision ${revisionId}`,
      );
    }
    return revision;
  }

  @Post('revisions/:revisionId/approve')
  @HttpCode(200)
  @ApiOperation({ operationId: 'approveKnowledgeRevision' })
  @ZodResponse({ status: 200, type: KnowledgeDocumentDetailDto })
  async approve(
    @Param('revisionId') revisionId: string,
  ): Promise<KnowledgeDocumentDto> {
    return savedDocumentOrThrow(await this.knowledge.approve(revisionId));
  }

  @Post('revisions/:revisionId/reject')
  @HttpCode(200)
  @ApiOperation({ operationId: 'rejectKnowledgeRevision' })
  @ZodResponse({ status: 200, type: KnowledgeRemovedDto })
  async reject(
    @Param('revisionId') revisionId: string,
  ): Promise<{ deleted: boolean }> {
    const outcome = await this.knowledge.reject(revisionId);
    if (outcome.kind === 'refused') {
      throw refusalError(outcome);
    }
    return { deleted: outcome.deleted };
  }

  @Post('revisions/:revisionId/restore')
  @HttpCode(200)
  @ApiOperation({ operationId: 'restoreKnowledgeRevision' })
  @ZodResponse({ status: 200, type: KnowledgeDocumentDetailDto })
  async restoreRevision(
    @Param('revisionId') revisionId: string,
    @Body() body: RestoreKnowledgeRevisionDto,
  ): Promise<KnowledgeDocumentDto> {
    return savedDocumentOrThrow(
      await this.knowledge.restoreRevision(revisionId, body.rev),
    );
  }

  @Get(':id')
  @ApiOperation({ operationId: 'readKnowledge' })
  @ZodResponse({ status: 200, type: KnowledgeDocumentDetailDto })
  async read(@Param('id') id: string): Promise<KnowledgeDocumentDto> {
    const document = await this.knowledge.get(id);
    if (document === null) {
      throw new NotFoundException('KNOWLEDGE_NOT_FOUND', `no document ${id}`);
    }
    return document;
  }

  @Patch(':id')
  @ApiOperation({ operationId: 'updateKnowledge' })
  @ZodResponse({ status: 200, type: KnowledgeDocumentDetailDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateKnowledgeDto,
  ): Promise<KnowledgeDocumentDto> {
    return savedDocumentOrThrow(await this.knowledge.edit(id, body));
  }

  @Delete(':id')
  @ApiOperation({ operationId: 'deleteKnowledge' })
  @ZodResponse({ status: 200, type: KnowledgeRemovedDto })
  async remove(@Param('id') id: string): Promise<{ deleted: boolean }> {
    const refusal = await this.knowledge.remove(id);
    if (refusal !== null) {
      throw refusalError(refusal);
    }
    return { deleted: true };
  }

  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({ operationId: 'archiveKnowledge' })
  @ZodResponse({ status: 200, type: KnowledgeHeadDetailDto })
  async archive(@Param('id') id: string): Promise<KnowledgeHeadDto> {
    return this.statusOrThrow(id, 'archived');
  }

  @Post(':id/restore')
  @HttpCode(200)
  @ApiOperation({ operationId: 'restoreKnowledge' })
  @ZodResponse({ status: 200, type: KnowledgeHeadDetailDto })
  async restore(@Param('id') id: string): Promise<KnowledgeHeadDto> {
    return this.statusOrThrow(id, 'active');
  }

  @Post(':id/index')
  @HttpCode(200)
  @ApiOperation({ operationId: 'indexKnowledge' })
  @ZodResponse({ status: 200, type: KnowledgeHeadDetailDto })
  async index(@Param('id') id: string): Promise<KnowledgeHeadDto> {
    return this.indexedOrThrow(id, true);
  }

  @Post(':id/search-only')
  @HttpCode(200)
  @ApiOperation({ operationId: 'searchOnlyKnowledge' })
  @ZodResponse({ status: 200, type: KnowledgeHeadDetailDto })
  async searchOnly(@Param('id') id: string): Promise<KnowledgeHeadDto> {
    return this.indexedOrThrow(id, false);
  }

  @Get(':id/revisions')
  @ApiOperation({ operationId: 'listKnowledgeRevisions' })
  @ZodResponse({ status: 200, type: KnowledgeRevisionListDto })
  revisions(@Param('id') id: string): Promise<KnowledgeRevisionList> {
    return this.knowledge.revisions(id);
  }

  private async indexedOrThrow(
    id: string,
    indexed: boolean,
  ): Promise<KnowledgeHeadDto> {
    const outcome = await this.knowledge.setIndexed(id, indexed);
    if (outcome.kind === 'refused') {
      throw refusalError(outcome);
    }
    return outcome.head;
  }

  private async statusOrThrow(
    id: string,
    status: 'active' | 'archived',
  ): Promise<KnowledgeHeadDto> {
    const outcome = await this.knowledge.setStatus(id, status);
    if (outcome.kind === 'refused') {
      throw refusalError(outcome);
    }
    return outcome.head;
  }
}
