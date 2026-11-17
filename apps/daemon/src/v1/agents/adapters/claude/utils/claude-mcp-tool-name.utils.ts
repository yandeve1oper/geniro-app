import type { ToolCallMetric } from '../../adapter.types';
import {
  CLAUDE_DISALLOWED_TOOLS_FLAG,
  CLAUDE_MCP_TOOL_PREFIX,
  CLAUDE_WITHHELD_TOOLS,
} from '../claude.const';

/**
 * The server segment claude puts in an MCP tool's name, for a server as it is
 * NAMED in config and in `claude mcp list`.
 *
 * Transcribed from the CLI's own normalizer (`bn` in the 2.1.284 bundle —
 * `strings` of `~/.local/share/claude/versions/2.1.284`, beside the
 * `claude.ai ` / `claude_ai_` constants): every character outside
 * `[a-zA-Z0-9_-]` becomes `_`, and a name starting `claude.ai ` (an account
 * connector) additionally has its underscore runs collapsed and its ends
 * trimmed. So `claude.ai Booking.com` → `claude_ai_Booking_com` and
 * `plugin:playwright:playwright` → `plugin_playwright_playwright`, which is
 * what the tool names in `system/init` read.
 */
export function claudeMcpServerSegment(server: string): string {
  const replaced = server.replace(/[^a-zA-Z0-9_-]/g, '_');
  return server.startsWith('claude.ai ')
    ? replaced.replace(/_+/g, '_').replace(/^_|_$/g, '')
    : replaced;
}

/**
 * The `--disallowedTools` rule that takes EVERY tool of one server away.
 *
 * The CLI reads a rule by splitting it on `__` (`Is` in the 2.1.284 bundle):
 * `mcp__<server>` with no tool part is a server-level rule, matched against
 * each tool's own server segment (`jHe` → `isServerLevelDisallowed`). A
 * segment that itself contains `__` would split wrongly — `mcp__a__b` reads as
 * tool `b` of server `a` — so such a server is named with a tool wildcard
 * instead (`mcp__a__b__*` → server `a`, tool pattern `b__*`), which covers
 * exactly that server's tools.
 */
export function claudeMcpServerRule(server: string): string {
  const segment = claudeMcpServerSegment(server);
  return segment.includes('__')
    ? `${CLAUDE_MCP_TOOL_PREFIX}${segment}__*`
    : `${CLAUDE_MCP_TOOL_PREFIX}${segment}`;
}

/**
 * The argv that withholds claude's own replaced tools
 * (`CLAUDE_WITHHELD_TOOLS`) and a team member's switched-off MCP servers
 * from one claude process — always at least the replaced tools.
 *
 * MEASURED on 2.1.284 (`claude -p --output-format stream-json --verbose`, read
 * to `system/init`, in a folder loading codegraph and the playwright plugin):
 * 125 tools with no flag; `--disallowedTools mcp__codegraph
 * mcp__plugin_playwright_playwright` → 96, every `mcp__codegraph__*` and
 * `mcp__plugin_playwright_playwright__*` gone, both servers still listed
 * `connected`. Alone, a rule here hides the tools and the CLI still DIALS the
 * server; the model is never offered its tools, which is the switch the member
 * asked for. What keeps a switched-off server from starting is the settings
 * deny list (`CLAUDE_DENIED_MCP_SERVERS_KEY`, `claudeSettingsArgs`).
 *
 * geniro's OWN server (`ownServer`, the per-run endpoint) is never withheld,
 * whatever the member lists: a member switching it off would lose its call surface
 * while its instructions still told it to use it. Duplicates are dropped.
 */
export function claudeDisallowedToolArgs(
  servers: readonly string[] | undefined,
  ownServer: string | null,
): string[] {
  const rules = [
    ...new Set(
      claudeSwitchedOffServers(servers, ownServer).map(claudeMcpServerRule),
    ),
  ];
  return [CLAUDE_DISALLOWED_TOOLS_FLAG, ...CLAUDE_WITHHELD_TOOLS, ...rules];
}

/**
 * The config names of the servers a turn switches off: empty names, repeats
 * and geniro's own server (matched by its segment, as the CLI names it) are
 * dropped. The settings deny list and the tool rules both read it.
 */
export function claudeSwitchedOffServers(
  servers: readonly string[] | undefined,
  ownServer: string | null,
): string[] {
  const own = ownServer === null ? null : claudeMcpServerSegment(ownServer);
  return [
    ...new Set(
      (servers ?? [])
        .filter((server) => server.length > 0)
        .filter((server) => claudeMcpServerSegment(server) !== own),
    ),
  ];
}

/**
 * A claude tool call as the tool ledger counts it: `mcp__<server>__<tool>` is
 * an MCP tool of `<server>` (the server's segment, as {@link claudeMcpServerSegment}
 * names it; one holding `__` itself is read as far as its first `__`), and
 * every other name is one of claude's own tools.
 */
export function claudeToolCallMetric(name: string): ToolCallMetric {
  if (!name.startsWith(CLAUDE_MCP_TOOL_PREFIX)) {
    return { tool: name, server: null };
  }
  const rest = name.slice(CLAUDE_MCP_TOOL_PREFIX.length);
  const split = rest.indexOf('__');
  return split <= 0 || split + 2 >= rest.length
    ? { tool: name, server: null }
    : { tool: rest.slice(split + 2), server: rest.slice(0, split) };
}
