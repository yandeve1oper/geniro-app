import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import {
  ImportMemoriesDto,
  MemoryImportPreviewDto,
  MemoryImportPreviewRequestDto,
  MemoryImportResultDto,
  MemoryImportTriageDto,
  MemoryImportTriageRequestDto,
  MemoryTriageAgentsDto,
} from '../../memory/dto/memories.dto';
import type {
  MemoryImportPreview,
  MemoryImportResult,
  MemoryImportTriage,
  MemoryTriageAgents,
} from '../../memory/memory.types';
import { MemoryImportService } from '../services/memory-import.service';

/**
 * The import of each CLI's own memory. Desktop only: it reads the Mac's own
 * CLI profiles, at directories the client names, which a paired device must
 * not be able to point anywhere.
 */
@Controller('v1/memories/import')
@ApiTags('memories')
@ApiBearerAuth()
@UseGuards(DesktopOnlyGuard)
export class MemoryImportController {
  constructor(private readonly imports: MemoryImportService) {}

  @Post('preview')
  @ApiOperation({ operationId: 'previewMemoryImport' })
  @ZodResponse({ status: 201, type: MemoryImportPreviewDto })
  preview(
    @Body() body: MemoryImportPreviewRequestDto,
  ): Promise<MemoryImportPreview> {
    return this.imports.preview(body);
  }

  @Post('triage')
  @ApiOperation({ operationId: 'triageMemoryImport' })
  @ZodResponse({ status: 201, type: MemoryImportTriageDto })
  triage(
    @Body() body: MemoryImportTriageRequestDto,
  ): Promise<MemoryImportTriage> {
    return this.imports.triage(body);
  }

  @Get('triage/agents')
  @ApiOperation({ operationId: 'listMemoryTriageAgents' })
  @ZodResponse({ status: 200, type: MemoryTriageAgentsDto })
  triageAgents(): MemoryTriageAgents {
    return this.imports.triageAgents();
  }

  @Post()
  @ApiOperation({ operationId: 'importMemories' })
  @ZodResponse({ status: 201, type: MemoryImportResultDto })
  import(@Body() body: ImportMemoriesDto): Promise<MemoryImportResult> {
    return this.imports.apply(body);
  }
}
