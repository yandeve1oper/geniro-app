/** The name a transcript row gives a call of one MCP server's tool, whichever CLI made it. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}
