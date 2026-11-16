import { asRecord, asString } from '../../../utils/json-util';
import type { AcpMcpToolCall, AcpToolCall } from '../../acp/acp.types';

/**
 * The server, tool and arguments of a cursor MCP call: arguments wrapped as
 * `{providerIdentifier, toolName, args}` under the exact title `<server>: <tool>`
 * (session update) or `<server>-<tool>: <tool>` (permission request). Any other
 * title is agent-authored text, so a call quoting a server and tool is never one.
 */
export function readCursorMcpToolCall(
  call: AcpToolCall,
): AcpMcpToolCall | null {
  const wrapper = asRecord(call.rawInput);
  const server = wrapper ? asString(wrapper.providerIdentifier) : null;
  const tool = wrapper ? asString(wrapper.toolName) : null;
  if (wrapper === null || server === null || tool === null) {
    return null;
  }
  if (
    call.name !== `${server}: ${tool}` &&
    call.name !== `${server}-${tool}: ${tool}`
  ) {
    return null;
  }
  return { server, tool, args: wrapper.args ?? null };
}

/**
 * What a cursor MCP call's reported output says of its result: cursor reports a
 * call the tool answered as exactly `{success: true}` and forwards none of the
 * answer, so that output is no result and reads as null. A refusal or an error
 * it reports is real and is kept.
 */
export function readCursorMcpToolResult(reported: unknown): unknown {
  const record = asRecord(reported);
  return record !== null &&
    Object.keys(record).length === 1 &&
    record.success === true
    ? null
    : reported;
}
