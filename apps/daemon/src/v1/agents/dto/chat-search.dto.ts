import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  GlobalChatSearchQuerySchema,
  GlobalChatSearchResultSchema,
} from '../chat.types';
import {
  isOrderedWindow,
  UNORDERED_WINDOW_MESSAGE,
} from '../utils/run-activity';

export class GlobalChatSearchQueryDto extends createZodDto(
  GlobalChatSearchQuerySchema.extend({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    includeArchived: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default(true),
  }).refine(isOrderedWindow, { message: UNORDERED_WINDOW_MESSAGE }),
) {}

export class GlobalChatSearchResultDto extends createZodDto(
  GlobalChatSearchResultSchema,
) {}
