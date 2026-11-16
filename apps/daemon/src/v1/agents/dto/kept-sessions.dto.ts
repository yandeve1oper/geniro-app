import { createZodDto } from 'nestjs-zod';

import {
  KeptSessionConfigSchema,
  KeptSessionConfigStateSchema,
} from '../chat.types';

/** The settings Electron main pushes; replaces whatever the daemon held. */
export class KeptSessionConfigDto extends createZodDto(
  KeptSessionConfigSchema,
) {}

export class KeptSessionConfigStateDto extends createZodDto(
  KeptSessionConfigStateSchema,
) {}
