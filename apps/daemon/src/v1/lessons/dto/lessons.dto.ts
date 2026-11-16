import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  LessonProposalListQuerySchema,
  LessonProposalListSchema,
  LessonProposalWireSchema,
  LessonReflectionFactsSchema,
  LessonsConfigSchema,
  LessonsReflectStartedSchema,
  ReflectLessonsSchema,
  RejectLessonSchema,
  SaveLessonSchema,
  ThreadLessonsStateSchema,
} from '../lessons.types';

export class ReflectLessonsDto extends createZodDto(ReflectLessonsSchema) {}

export class LessonsReflectStartedDto extends createZodDto(
  LessonsReflectStartedSchema,
) {}

export class ThreadLessonsStateDto extends createZodDto(
  z.object(ThreadLessonsStateSchema.shape),
) {}

export class LessonProposalListQueryDto extends createZodDto(
  LessonProposalListQuerySchema,
) {}

export class LessonProposalListDto extends createZodDto(
  LessonProposalListSchema,
) {}

export class LessonProposalDto extends createZodDto(
  z.object(LessonProposalWireSchema.shape),
) {}

export class SaveLessonDto extends createZodDto(SaveLessonSchema) {}

export class RejectLessonDto extends createZodDto(RejectLessonSchema) {}

export class LessonReflectionFactsDto extends createZodDto(
  z.object(LessonReflectionFactsSchema.shape),
) {}

/** The settings Electron main pushes; replaces whatever the daemon held. */
export class LessonsConfigDto extends createZodDto(LessonsConfigSchema) {}

/** The settings the daemon now holds. */
export class LessonsConfigAckDto extends createZodDto(
  z.object(LessonsConfigSchema.shape),
) {}
