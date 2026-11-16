import { randomBytes } from 'node:crypto';

import { redactSecrets } from '../../diagnostics/utils/redact';
import type { MemoryEntry, MemoryHit } from '../../memory/memory.types';
import type { MemoryService } from '../../memory/services/memory.service';
import type {
  McpCallContext,
  McpToolResult,
  MemoryCallScope,
} from '../mcp.types';
import { BaseMcpTool } from './base-mcp-tool';

/**
 * The base of the shared memory's tools (`memory_search`, `memory_read`,
 * `memory_save`, `memory_forget`, `memory_feedback`): offered on every endpoint while the user
 * has memory on, and refused at call time once it is off — a kept CLI can
 * hold a listing made while it was on. The run's project and team and the caller's
 * identity are looked up here, never taken from the arguments.
 */
export abstract class MemoryMcpTool extends BaseMcpTool {
  constructor(protected readonly memory: MemoryService) {
    super();
  }

  protected isOffered(): boolean {
    return this.memory.enabled;
  }

  /** Answer a call once memory is known to be on and the scope resolved. */
  protected abstract answer(
    args: Record<string, unknown>,
    scope: MemoryCallScope,
  ): Promise<McpToolResult>;

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId }: McpCallContext,
  ): Promise<McpToolResult> {
    if (!this.memory.enabled) {
      return this.text(
        'MEMORY_DISABLED: the user has turned memory off; work without it.',
        true,
      );
    }
    const [place, actor] = await Promise.all([
      this.memory.scopeOf(runId),
      this.memory.actorOf(runId, memberId),
    ]);
    return this.answer(args, { place, actor, memberId });
  }

  /**
   * Every memory result, refusals included, is masked of the secrets geniro
   * knows: one registered after an entry was saved still never leaves.
   */
  protected masked(text: string, isError = false): McpToolResult {
    return this.text(redactSecrets(text), isError);
  }
}

/**
 * One line naming an entry: handle, revision, scope, type and title.
 *
 * TWIN PARSER: `memoryToolEntryOf` in `apps/ui/src/renderer/chats/memory-tool-row.tsx`
 * reads this text for the transcript row, and `memory-usage-history.ts` in
 * `apps/daemon/src/v1/memory/utils/` for the usage backfill; reword it there too.
 */
export function memoryEntryLine(
  entry: Pick<
    MemoryHit,
    'handle' | 'rev' | 'projectId' | 'teamSlug' | 'type' | 'title'
  >,
): string {
  const scope =
    entry.teamSlug !== null
      ? 'this team'
      : entry.projectId === null
        ? 'global'
        : 'this project';
  return `${entry.handle} (rev ${entry.rev}, ${scope}, ${entry.type}) — ${entry.title}`;
}

/**
 * A fence name no stored body can print: a body is agent-written text, and a
 * line inside it shaped like another entry's header must not read as one.
 */
export function memoryFence(): string {
  return `memory-entry-${randomBytes(6).toString('hex')}`;
}

/**
 * An entry in full, its body inside `fence`, as `memory_read` returns it.
 *
 * TWIN PARSER: `readHandles` in `apps/daemon/src/v1/memory/utils/memory-usage-history.ts`
 * finds entries by this header, `by` line and fence.
 */
export function memoryEntryText(entry: MemoryEntry, fence: string): string {
  const by =
    entry.source.agentKind === null
      ? entry.source.actor
      : `${entry.source.agentKind}${entry.source.model ? ` (${entry.source.model})` : ''}`;
  return `${memoryEntryLine(entry)}\nby ${by}, updated ${entry.updatedAt}\n<${fence}>\n${entry.body}\n</${fence}>`;
}
