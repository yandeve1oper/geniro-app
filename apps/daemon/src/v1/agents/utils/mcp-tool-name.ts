/** The name a transcript row gives a call of one MCP server's tool, whichever CLI made it. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** A tool's own name, without the `mcp__<server>__` prefix {@link mcpToolName} gives it. */
export function bareToolName(name: string): string {
  const match = /^mcp__.+?__(.+)$/.exec(name);
  return match === null ? name : match[1]!;
}
