import { Body, Controller, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import { LessonsConfigAckDto, LessonsConfigDto } from '../dto/lessons.dto';
import type { LessonsConfig } from '../lessons.types';
import { LessonsConfigService } from '../services/lessons-config.service';

/**
 * The lessons settings. Desktop only: the agent and model choose what a
 * reflection spends, and the value is Electron main's to push from
 * settings.json.
 */
@Controller('v1/lessons')
@ApiTags('lessons')
@ApiBearerAuth()
@UseGuards(DesktopOnlyGuard)
export class LessonsConfigController {
  constructor(private readonly config: LessonsConfigService) {}

  @Put('config')
  @ApiOperation({ operationId: 'setLessonsConfig' })
  @ZodResponse({ status: 200, type: LessonsConfigAckDto })
  setConfig(@Body() body: LessonsConfigDto): LessonsConfig {
    return this.config.set(body);
  }
}
