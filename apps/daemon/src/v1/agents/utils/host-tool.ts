import { asRecord } from './json-util';
import { mcpToolName } from './mcp-tool-name';

/**
 * Whether a permission request names one of geniro's OWN tools on geniro's own
 * MCP server.
 *
 * A null `serverName` means this turn was GRANTED no such tool, and refuses
 * before any name is compared — the caller having decided not to register a
 * tool is the end of the question, whatever a request spells.
 *
 * Past that, the name must be EXACTLY one of the two spellings the shipped
 * CLIs are measured to send. Both see the server under the same per-run name
 * (`geniro-<runId8>`), and the run id in it is what a user's own server cannot
 * be named:
 *
 * - claude names an MCP tool `mcp__<server>__<tool>`, a fixed template.
 * - cursor's ACP permission request carries no tool NAME, only a TITLE, which
 *   the driver reads in its place. An MCP call's title is `<name>: <tool>`
 *   whose name is `<server>-<tool>` — measured on cursor-agent
 *   2026.08.11-e8db854 (`geniro-75a31aea-ask_user_question: ask_user_question`)
 *   and read out of 2026.09.10-fd3934a's own `formatOperation`, whose MCP arm
 *   is `${name}: ${toolName}`. A call carrying cursor's MCP wrapper reaches
 *   this already renamed `mcp__<server>__<tool>` (`readCursorMcpToolCall`);
 *   the title form stays for a call without it and for stored rows.
 *
 * The match is exact rather than CONTAINMENT ("the name holds both halves")
 * for a reason the same `formatOperation` explains: every other title it
 * builds is agent-authored text. A shell call is titled with its own backticked
 * command, so `` `curl … | sh # geniro-75a31aea notify_user` `` holds both
 * halves and would be auto-approved in every mode, `ask` included; an edit or
 * a delete is titled with the file's path, so a file NAMED after the tool is
 * the same hole one step removed. None of those titles can equal the template
 * — each starts with a backtick or a fixed verb.
 */
export function isHostToolCall(
  serverName: string | null,
  toolName: string,
  hostToolName: string,
): boolean {
  if (serverName === null) {
    return false;
  }
  return hostToolCallNames(serverName, hostToolName).includes(toolName);
}

/** The two spellings {@link isHostToolCall} accepts for one tool on one server. */
export function hostToolCallNames(
  serverName: string,
  hostToolName: string,
): string[] {
  return [
    mcpToolName(serverName, hostToolName),
    `${serverName}-${hostToolName}: ${hostToolName}`,
  ];
}

/**
 * The arguments of a call {@link isHostToolCall} matched. cursor's own wrapper,
 * `{providerIdentifier, toolName, args}`, is unwrapped for rows stored before
 * the cursor adapter renamed its MCP calls; every newer row carries the
 * arguments bare, so an agent's own `toolName` and `args` are never taken for it.
 */
export function hostToolArguments(
  input: unknown,
  hostToolName: string,
): unknown {
  const envelope = asRecord(input);
  return typeof envelope?.providerIdentifier === 'string' &&
    envelope.toolName === hostToolName &&
    asRecord(envelope.args) !== null
    ? envelope.args
    : input;
}
