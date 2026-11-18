import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type { RunWire } from '../../agents/chat.types';
import { RunDto } from '../../agents/dto/chat.dto';
import type {
  CommandCenterBoard,
  CommandCenterStart,
  CommandCenterTimeline,
} from '../command-center.types';
import {
  CommandCenterBoardDto,
  CommandCenterBoardQueryDto,
  CommandCenterChatsDiscardedDto,
  CommandCenterStartFailedDto,
  CommandCenterStartsDto,
  CommandCenterStartsQueryDto,
  CommandCenterTimelineDto,
  CommandCenterTimelineQueryDto,
  StartCommandCenterChatDto,
} from '../dto/command-center.dto';
import { CommandCenterService } from '../services/command-center.service';
import { CommandCenterChatService } from '../services/command-center-chat.service';
import { CommandCenterStartsService } from '../services/command-center-starts.service';
import { CommandCenterTimelineService } from '../services/command-center-timeline.service';

@Controller('v1/command-center')
@ApiTags('command-center')
@ApiBearerAuth()
export class CommandCenterController {
  constructor(
    private readonly board: CommandCenterService,
    private readonly managers: CommandCenterChatService,
    private readonly starts: CommandCenterStartsService,
    private readonly timelines: CommandCenterTimelineService,
  ) {}

  /** Every active thread as a card, or just the named ones. */
  @Get('board')
  @ApiOperation({ operationId: 'readCommandCenterBoard' })
  @ZodResponse({ status: 200, type: CommandCenterBoardDto })
  read(
    @Query() query: CommandCenterBoardQueryDto,
  ): Promise<CommandCenterBoard> {
    return this.board.board(query.runIds);
  }

  @Get('timeline')
  @ApiOperation({ operationId: 'listCommandCenterTimeline' })
  @ZodResponse({ status: 200, type: CommandCenterTimelineDto })
  timeline(
    @Query() query: CommandCenterTimelineQueryDto,
  ): Promise<CommandCenterTimeline> {
    return this.timelines.page(
      query.before === undefined ? null : new Date(query.before),
      query.limit,
    );
  }

  /** The manager's chat — the one that exists, or a new one with these chips. */
  @Post('chat')
  @ApiOperation({ operationId: 'openCommandCenterChat' })
  @ZodResponse({ status: 201, type: RunDto })
  open(@Body() dto: StartCommandCenterChatDto): Promise<RunWire> {
    return this.managers.open(dto);
  }

  /** **Destructive and irreversible**: discard the manager chat and its roster. */
  @Delete('chat')
  @ApiOperation({ operationId: 'discardCommandCenterChat' })
  @ZodResponse({ status: 200, type: CommandCenterChatsDiscardedDto })
  discard(): Promise<{ deleted: number }> {
    return this.managers.reset();
  }

  /** The approved starts Electron main's drain starts. */
  @Get('starts')
  @ApiOperation({ operationId: 'listCommandCenterStarts' })
  @ZodResponse({ status: 200, type: CommandCenterStartsDto })
  async listStarts(
    @Query() _query: CommandCenterStartsQueryDto,
  ): Promise<{ starts: CommandCenterStart[] }> {
    return { starts: await this.starts.approvedStarts() };
  }

  /** The drain could not start this card: its request ends and the manager is told. */
  @Post('starts/:taskId/failed')
  @HttpCode(204)
  @ApiOperation({ operationId: 'reportCommandCenterStartFailed' })
  failed(
    @Param('taskId') taskId: string,
    @Body() dto: CommandCenterStartFailedDto,
  ): Promise<void> {
    return this.starts.failed(taskId, dto.reason);
  }
}
