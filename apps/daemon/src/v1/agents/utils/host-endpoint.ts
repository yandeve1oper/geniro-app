/**
 * The path of geniro's own MCP endpoint for one asking process: a member of a
 * run, in its own conversation (`conversationId` null) or in the callee
 * conversation it answers a call in. Every process is told apart from its
 * siblings only by this address, so it is also the key results served to that
 * process are filed under (`HostToolResultLedger`).
 */
export function hostEndpointPath(
  runId: string,
  memberId: string,
  conversationId: string | null,
): string {
  const conversation =
    conversationId === null ? '' : `/${encodeURIComponent(conversationId)}`;
  return `/v1/mcp/${encodeURIComponent(runId)}/${encodeURIComponent(memberId)}${conversation}`;
}

/** The endpoint path of an MCP URL a turn was handed — what {@link hostEndpointPath} built it from. */
export function hostEndpointKey(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}
