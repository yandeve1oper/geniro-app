import { Injectable, Logger } from '@nestjs/common';

import type {
  CommandCenterOps,
  NoteThreadAnswer,
  NoteThreadInput,
  StartThreadAnswer,
  StartThreadInput,
  TellThreadsAnswer,
  TellThreadsInput,
} from '../chat.types';

const UNAVAILABLE = 'The command center is not available.';

/**
 * The rendezvous behind the manager's tools. The MCP host may not import the
 * command-center module (it imports the tasks module, which the host may not
 * reach), so that module INSTALLS its operations here at boot, on
 * `TaskBoardBroker`'s terms: one handler for the whole daemon, since the
 * roster and the board are durable state.
 */
@Injectable()
export class CommandCenterOpsBroker {
  private readonly logger = new Logger(CommandCenterOpsBroker.name);
  private handler: CommandCenterOps | null = null;

  /** Install the operations; the disposer removes only this install. */
  install(handler: CommandCenterOps): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) {
        this.handler = null;
      }
    };
  }

  tell(
    managerRunId: string,
    input: TellThreadsInput,
  ): Promise<TellThreadsAnswer | { error: string }> {
    return this.guarded('tell_threads', managerRunId, (ops) =>
      ops.tell(managerRunId, input),
    );
  }

  note(
    managerRunId: string,
    input: NoteThreadInput,
  ): Promise<NoteThreadAnswer | { error: string }> {
    return this.guarded('note_thread', managerRunId, (ops) =>
      ops.note(managerRunId, input),
    );
  }

  start(
    managerRunId: string,
    input: StartThreadInput,
  ): Promise<StartThreadAnswer | { error: string }> {
    return this.guarded('start_thread', managerRunId, (ops) =>
      ops.start(managerRunId, input),
    );
  }

  private async guarded<T>(
    tool: string,
    managerRunId: string,
    call: (ops: CommandCenterOps) => Promise<T>,
  ): Promise<T | { error: string }> {
    if (this.handler === null) {
      return { error: UNAVAILABLE };
    }
    try {
      return await call(this.handler);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${tool} failed for run ${managerRunId}: ${reason}`);
      return { error: `The command center could not answer: ${reason}` };
    }
  }
}
