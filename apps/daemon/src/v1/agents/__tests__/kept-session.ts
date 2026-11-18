import type {
  AgentSession,
  AgentTurnHandle,
  AgentTurnInput,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { StoppedCommands } from '../utils/spawn-cli';

/** A kept CLI that lives until it is closed, and then exits at once. */
export class KeptSession implements AgentSession {
  alive = true;
  pid: number | null = 4242;
  parked = false;
  retired = false;
  shellsRunning = 0;
  detachedRunning = 0;
  runningCommands: string[] = [];
  endedRunning: StoppedCommands | null = null;
  inputs: AgentTurnInput[] = [];
  private settle: (() => void) | null = null;
  private resolveClosed!: () => void;
  closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  get idle(): boolean {
    return this.alive && this.settle === null;
  }

  ask(): Promise<null> {
    return Promise.resolve(null);
  }

  startTurn(input: AgentTurnInput): AgentTurnHandle | null {
    if (!this.idle) {
      return null;
    }
    this.inputs.push(input);
    return {
      done: new Promise<void>((resolve) => {
        this.settle = resolve;
      }),
      cancel: () => undefined,
      respondApproval: () => false,
      sendUserMessage: () => false,
      attributableDelegate: () => null,
      setApprovalMode: () => false,
    };
  }

  endTurn(): void {
    this.settle?.();
    this.settle = null;
  }

  recordedGroupsOf(): null {
    return null;
  }

  subagentRecoveryBlocked(): boolean {
    return false;
  }

  close(): void {
    this.alive = false;
    this.pid = null;
    this.resolveClosed();
  }
}

/** An adapter whose every session is a {@link KeptSession}, kept in `kept`. */
export function keptSessionAdapter(): {
  adapter: AgentAdapter;
  kept: KeptSession[];
} {
  const kept: KeptSession[] = [];
  const adapter = {
    startSession: () => {
      const session = new KeptSession();
      kept.push(session);
      return session;
    },
    getConfig: () => ({ kind: 'claude' }),
  } as unknown as AgentAdapter;
  return { adapter, kept };
}
