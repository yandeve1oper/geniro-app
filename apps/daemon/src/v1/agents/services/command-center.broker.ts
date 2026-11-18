import { Injectable } from '@nestjs/common';

import { HostSinkBroker } from './host-sink.broker';

/** Which manager one command-center turn belongs to. */
export interface CommandCenterSink {
  managerRunId: string;
}

/**
 * Says a turn is the command center's manager. Read synchronously by the tool
 * listing: the manager's own tools are offered only here, and the tools that
 * reach other threads one at a time are withheld here.
 */
@Injectable()
export class CommandCenterBroker extends HostSinkBroker<CommandCenterSink> {
  canManage(runId: string, memberId: string): boolean {
    return this.has(runId, memberId);
  }
}
