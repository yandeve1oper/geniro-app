import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  MemoryCreateSchema,
  MemoryEntrySchema,
  MemoryExportSchema,
  MemoryFindingListSchema,
  MemoryForgetAllSchema,
  MemoryForgetBatchListSchema,
  MemoryForgetBatchRequestSchema,
  MemoryForgetBatchResultSchema,
  MemoryImportPreviewRequestSchema,
  MemoryImportPreviewSchema,
  MemoryImportRequestSchema,
  MemoryImportResultSchema,
  MemoryImportTriageRequestSchema,
  MemoryImportTriageSchema,
  MemoryIndexPreviewQuerySchema,
  MemoryIndexPreviewSchema,
  MemoryKeepResultSchema,
  MemoryListQuerySchema,
  MemoryListSchema,
  MemoryMergeRequestSchema,
  MemoryMergeResultSchema,
  MemoryPatchSchema,
  MemoryPurgeResultSchema,
  MemoryRestoreBatchResultSchema,
  MemoryReviewCheckRequestSchema,
  MemoryReviewCheckResultSchema,
  MemoryReviewIdsSchema,
  MemoryReviewPageSchema,
  MemoryReviewPairsQuerySchema,
  MemoryReviewPairsSchema,
  MemoryReviewQuerySchema,
  MemoryReviewSummaryQuerySchema,
  MemoryReviewSummarySchema,
  MemoryTriageAgentsSchema,
} from '../memory.types';

export class MemoryReviewSummaryQueryDto extends createZodDto(
  MemoryReviewSummaryQuerySchema,
) {}

export class MemoryPurgeResultDto extends createZodDto(
  MemoryPurgeResultSchema,
) {}

export class MemoryListQueryDto extends createZodDto(MemoryListQuerySchema) {}

export class MemoryListDto extends createZodDto(
  z.object(MemoryListSchema.shape),
) {}

export class CreateMemoryDto extends createZodDto(MemoryCreateSchema) {}

export class UpdateMemoryDto extends createZodDto(MemoryPatchSchema) {}

export class MemoryEntryDto extends createZodDto(
  z.object(MemoryEntrySchema.shape),
) {}

export class ForgetAllMemoriesDto extends createZodDto(MemoryForgetAllSchema) {}

export class MemoryTriageAgentsDto extends createZodDto(
  MemoryTriageAgentsSchema,
) {}

export class MemoryIndexPreviewQueryDto extends createZodDto(
  MemoryIndexPreviewQuerySchema,
) {}

export class MemoryIndexPreviewDto extends createZodDto(
  MemoryIndexPreviewSchema,
) {}

export class MemoryExportDto extends createZodDto(MemoryExportSchema) {}

export class MemoryReviewQueryDto extends createZodDto(
  MemoryReviewQuerySchema,
) {}

export class MemoryReviewPageDto extends createZodDto(MemoryReviewPageSchema) {}

export class MemoryReviewIdsDto extends createZodDto(MemoryReviewIdsSchema) {}

export class MemoryReviewSummaryDto extends createZodDto(
  MemoryReviewSummarySchema,
) {}

export class ForgetMemoryBatchDto extends createZodDto(
  MemoryForgetBatchRequestSchema,
) {}

export class MemoryForgetBatchResultDto extends createZodDto(
  MemoryForgetBatchResultSchema,
) {}

export class MemoryForgetBatchListDto extends createZodDto(
  MemoryForgetBatchListSchema,
) {}

export class MemoryRestoreBatchResultDto extends createZodDto(
  MemoryRestoreBatchResultSchema,
) {}

export class MemoryKeepResultDto extends createZodDto(MemoryKeepResultSchema) {}

export class MemoryImportPreviewRequestDto extends createZodDto(
  MemoryImportPreviewRequestSchema,
) {}

export class MemoryImportPreviewDto extends createZodDto(
  MemoryImportPreviewSchema,
) {}

export class ImportMemoriesDto extends createZodDto(
  MemoryImportRequestSchema,
) {}

export class MemoryImportResultDto extends createZodDto(
  MemoryImportResultSchema,
) {}

export class MemoryImportTriageRequestDto extends createZodDto(
  MemoryImportTriageRequestSchema,
) {}

export class MemoryImportTriageDto extends createZodDto(
  MemoryImportTriageSchema,
) {}

export class MemoryReviewPairsQueryDto extends createZodDto(
  MemoryReviewPairsQuerySchema,
) {}

export class MemoryReviewPairsDto extends createZodDto(
  MemoryReviewPairsSchema,
) {}

export class MemoryReviewCheckRequestDto extends createZodDto(
  MemoryReviewCheckRequestSchema,
) {}

export class MemoryReviewCheckResultDto extends createZodDto(
  MemoryReviewCheckResultSchema,
) {}

export class MemoryFindingListDto extends createZodDto(
  MemoryFindingListSchema,
) {}

export class MergeMemoriesDto extends createZodDto(MemoryMergeRequestSchema) {}

export class MemoryMergeResultDto extends createZodDto(
  MemoryMergeResultSchema,
) {}
