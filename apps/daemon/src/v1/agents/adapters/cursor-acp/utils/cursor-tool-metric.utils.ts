import type { ToolCallMetric } from '../../adapter.types';

/** An MCP call as the ACP driver names it from cursor's wrapper: `mcp__<server>__<tool>`. */
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

/** cursor's own MCP title on rows written before the driver renamed them: `<server>-<tool>: <tool>`. */
const CURSOR_MCP_TITLE = /^(.+)-([^\s:]+): \2$/;

/**
 * A cursor tool call as the tool ledger counts it. ACP gives cursor's calls a
 * human title and no machine name, so a call is counted by its ACP `kind`
 * (`read`, `edit`, `execute`, …) — a shell call is titled with the command
 * itself and an edit with the file's path, which would make every call a tool
 * of its own. The one exception is an MCP call, counted by its server and tool.
 */
export function cursorToolCallMetric(
  name: string,
  kind: string | null,
): ToolCallMetric {
  const mcp = MCP_TOOL_NAME.exec(name) ?? CURSOR_MCP_TITLE.exec(name);
  if (mcp !== null) {
    return { tool: mcp[2]!, server: mcp[1]! };
  }
  return { tool: kind ?? 'other', server: null };
}
