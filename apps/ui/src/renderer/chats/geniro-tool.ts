/**
 * Which tool calls are GENIRO'S OWN, and which of those draw a card.
 *
 * Its own module because two surfaces ask, from opposite ends of a call's life:
 * `transcript-groups.ts` hides the raw rows of a call that has ALREADY
 * happened, and `live-row.tsx` draws a placeholder while the model is still
 * WRITING one (the `composingTool` live field). A second copy of the matching
 * rule is how one of them would come to recognise a tool the other does not —
 * and the failure is silent in both directions: a raw envelope printed into the
 * transcript, or a card that appears with no loader before it.
 */

/**
 * The renderer's own agent-call tools ride the transcript as raw
 * tool_call/tool_result items too, but the dedicated call kinds
 * (call_started/call_result/call_question/call_answer/await_collected)
 * already tell that story in a readable form — the raw envelope JSON rows
 * are pure duplication, so they are hidden from the transcript. Every host tool
 * rides it for the same reason: each draws its own card — a findings table, a
 * chart, a scorecard, a decision table, a diff with Apply, a plan with Approve
 * — and the raw call beside it is the same row twice.
 */

/**
 * The CARD each drawing tool produces — the shape a placeholder should take
 * while the model is still writing the call.
 *
 * It is the union `isCardEntry` already ranges over, minus the kinds no tool
 * produces (a task list is announced, not called for), and it is what lets the
 * loader be the right size and rhythm for what is coming rather than one
 * generic spinner: an artifact resolves into a page, a scorecard into a row of
 * tiles.
 */
export type GeniroCardKind =
  | 'findings'
  | 'recommendations'
  | 'chart'
  | 'metrics'
  | 'comparison'
  | 'gallery'
  | 'screenshot'
  | 'artifact'
  | 'patch'
  | 'plan'
  | 'team';

/**
 * The tools geniro publishes on its own server that tell their story ELSEWHERE
 * in the transcript — as call rows or as a card — so their raw rows are hidden.
 *
 * NOT every tool on that server, which is what the per-run rule below used to
 * hide. `get_task`, `update_task` and `notify_user` draw nothing of their own
 * (the board tools change a card on another screen; `notify_user` posts a
 * system banner), so hiding their rows left no trace at all. REPORTED as "you
 * should have used the tool, but I don't see that tool call in the chat at all"
 * — over a turn that had moved its card to Done through `update_task`, with
 * the call and its result both in the transcript, and nothing on screen
 * between the user's message and the answer.
 *
 * `monitor`, `stop_monitor` and `list_monitors` are deliberately absent: any key
 * here hides a tool's raw rows, and a monitor call has no card, so its call
 * renders as an ordinary tool row.
 *
 * The VALUE is the card that tool draws, or null for one whose story is told by
 * the dedicated call kinds instead. Keeping both facts in one table is what
 * stops the hide list and the loader's list from drifting: a drawing tool added
 * to one is added to the other by construction.
 *
 * TWIN PARSER: the daemon's tool names — `HOST_*_TOOL` in
 * `apps/daemon/src/v1/agents/chat.types.ts` and the call tools in
 * `adapters/adapter.types.ts`. A tool added there that draws its own card
 * belongs here; one that draws nothing does not.
 */
/** `propose_team` — its card stands across turns ({@link standsAcrossTurns}). */
export const PROPOSE_TEAM = 'propose_team';

/** `message_thread` — a send to another thread, whose card is its approval row. */
export const MESSAGE_THREAD = 'message_thread';

/**
 * `save_project_instructions` — an analysis's change to a project's
 * instructions, put on a card. TWIN: `HOST_PROJECT_INSTRUCTIONS_TOOL` in the
 * daemon's `chat.types.ts`.
 */
export const SAVE_PROJECT_INSTRUCTIONS = 'save_project_instructions';

/**
 * `browser_screenshot` — the one browser tool that draws a card, built from its
 * call and its result rather than from a row of its own. TWIN: the daemon's
 * `HOST_BROWSER_SCREENSHOT_TOOL` in `chat.types.ts`.
 */
export const BROWSER_SCREENSHOT = 'browser_screenshot';

/**
 * The `approval_request` row's `toolName` for the first open of a new host in
 * a chat. TWIN: the daemon's `HOST_BROWSER_HOST_CARD` in `chat.types.ts`.
 */
export const BROWSER_HOST_CARD = 'browser_host';

/** `propose_team`'s name before the rename, which the rows recorded then still carry. */
export const LEGACY_PROPOSE_TEAM = 'propose_workflow';

const GENIRO_TOOLS: Readonly<Record<string, GeniroCardKind | null>> = {
  call_agent: null,
  await_agent: null,
  answer_agent: null,
  ask_user_question: null,
  report_findings: 'findings',
  report_recommendations: 'recommendations',
  mark_recommendations: null,
  show_chart: 'chart',
  show_metrics: 'metrics',
  show_comparison: 'comparison',
  show_gallery: 'gallery',
  // Its card is built from the call and its result, so the pair is not hidden
  // the way the others' are (`transcript-groups.ts`).
  [BROWSER_SCREENSHOT]: 'screenshot',
  show_artifact: 'artifact',
  propose_patch: 'patch',
  [SAVE_PROJECT_INSTRUCTIONS]: 'patch',
  propose_plan: 'plan',
  // The action card is drawn from the `action` / `action_outcome` rows the
  // daemon writes, so these calls need no loader of their own.
  publish_action: null,
  remove_action: null,
  // The note is its own `team_note` row; `team_notes` draws nothing, so its
  // call row stays visible.
  team_note: null,
  // The outcome is its own `run_outcome` row.
  record_outcome: null,
  move_stage: null,
  // The card is the `lessons` row the reflection writes into the thread.
  propose_lessons: null,
  // The send is the sender's own `threadMessageSent` row; a refused one keeps
  // its call row (`transcript-groups.ts`).
  [MESSAGE_THREAD]: null,
  // The card is the `approval_request` row the daemon writes, which outlives
  // the call; `read_teams` draws nothing and stays visible.
  [PROPOSE_TEAM]: 'team',
  [LEGACY_PROPOSE_TEAM]: 'team',
};

/** The bare tool names, for the matching below. */
const GENIRO_TOOL_NAMES = Object.keys(GENIRO_TOOLS);

/**
 * The bare tool a call NAMES, when it is one of geniro's own on geniro's own
 * server — the run's own `geniro-<runId8>` — else null.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/utils/host-tool.ts` decides the same
 * question daemon-side, for the permission gate, and its doc block carries the
 * two-names contract both sides read from.
 *
 * The per-run half is what covers cursor, whose tool rows carry no `mcp__` name
 * at all — the CLI reports the pair as one prose label around the server name
 * geniro minted. The run id in that name is what makes the SERVER unforgeable;
 * the tool name is required beside it, the daemon's `isHostToolCall` rule,
 * because that server also publishes tools that draw nothing.
 */
export function geniroToolOf(name: string, runId: string): string | null {
  return (
    GENIRO_TOOL_NAMES.find((tool) => namesToolOnRunServer(name, runId, tool)) ??
    null
  );
}

function namesToolOnRunServer(
  name: string,
  runId: string,
  tool: string,
): boolean {
  const server = `geniro-${runId.slice(0, 8)}`;
  return (
    name === `mcp__${server}__${tool}` ||
    (!name.startsWith('mcp__') &&
      name.includes(server) &&
      namesWord(name, tool))
  );
}

/**
 * The shared-memory tools, which tell their story as one compact row inside the
 * tool group (`MemoryToolRow`) and so are kept OUT of {@link GENIRO_TOOLS}: a
 * key there hides a tool's raw rows, and the memory row is drawn from exactly
 * those pairs. Matched on their own, in the spellings {@link geniroToolOf}
 * reads; codex's bare `mcp__<server>` pins no tool and stays an ordinary row.
 *
 * TWIN PARSER: `HOST_MEMORY_TOOLS` in `apps/daemon/src/v1/agents/chat.types.ts`.
 */
export const GENIRO_MEMORY_TOOLS = [
  'memory_search',
  'memory_read',
  'memory_save',
  'memory_forget',
] as const;

export type GeniroMemoryTool = (typeof GENIRO_MEMORY_TOOLS)[number];

/** The memory tool a call NAMES on this run's own geniro server, else null. */
export function geniroMemoryToolOf(
  name: string,
  runId: string,
): GeniroMemoryTool | null {
  return (
    GENIRO_MEMORY_TOOLS.find((tool) =>
      namesToolOnRunServer(name, runId, tool),
    ) ?? null
  );
}

/**
 * The in-app browser's tools but the screenshot, which tell their story as one
 * compact row inside the tool group (`BrowserToolRow`) and so are kept OUT of
 * {@link GENIRO_TOOLS} for the reason {@link GENIRO_MEMORY_TOOLS} is.
 *
 * TWIN PARSER: `HOST_BROWSER_TOOLS` in `apps/daemon/src/v1/agents/chat.types.ts`.
 */
export const GENIRO_BROWSER_TOOLS = [
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_select',
  'browser_scroll',
  'browser_console',
  'browser_evaluate',
  'browser_tabs',
  'browser_label_tab',
  'browser_close',
  'browser_set_cookies',
  'browser_get_cookies',
  'browser_clear_cookies',
] as const;

export type GeniroBrowserTool = (typeof GENIRO_BROWSER_TOOLS)[number];

/** The browser tool a call NAMES on this run's own geniro server, else null. */
export function geniroBrowserToolOf(
  name: string,
  runId: string,
): GeniroBrowserTool | null {
  return (
    GENIRO_BROWSER_TOOLS.find((tool) =>
      namesToolOnRunServer(name, runId, tool),
    ) ?? null
  );
}

/**
 * The knowledge store's tools, which tell their story as one compact row inside
 * the tool group (`KnowledgeToolRow`) and so are kept OUT of
 * {@link GENIRO_TOOLS} for the reason {@link GENIRO_MEMORY_TOOLS} is.
 *
 * TWIN PARSER: `HOST_KNOWLEDGE_TOOLS` in `apps/daemon/src/v1/agents/chat.types.ts`.
 */
export const GENIRO_KNOWLEDGE_TOOLS = [
  'knowledge_search',
  'knowledge_read',
  'knowledge_save',
] as const;

export type GeniroKnowledgeTool = (typeof GENIRO_KNOWLEDGE_TOOLS)[number];

/** The knowledge tool a call NAMES on this run's own geniro server, else null. */
export function geniroKnowledgeToolOf(
  name: string,
  runId: string,
): GeniroKnowledgeTool | null {
  return (
    GENIRO_KNOWLEDGE_TOOLS.find((tool) =>
      namesToolOnRunServer(name, runId, tool),
    ) ?? null
  );
}

/**
 * Whether `tool` appears in `name` as a whole word — not inside a longer tool
 * name, so cursor's label for `team_notes` is not read as `team_note`.
 */
function namesWord(name: string, tool: string): boolean {
  let at = name.indexOf(tool);
  while (at !== -1) {
    const before = name[at - 1];
    const after = name[at + tool.length];
    if (!isWordChar(before) && !isWordChar(after)) {
      return true;
    }
    at = name.indexOf(tool, at + 1);
  }
  return false;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/**
 * Whether a string names a card kind — the guard a row's renderer needs.
 *
 * A live row's payload is `unknown` by the same rule every other item's is, and
 * this is what stands between a value read off it and the exhaustive switch
 * that draws the silhouette. It is derived from {@link GENIRO_TOOLS} rather
 * than from a second list, so a card added to that table is recognised here
 * without a second edit.
 */
export function isGeniroCardKind(
  value: string | null,
): value is GeniroCardKind {
  return value !== null && GENIRO_CARD_KINDS.has(value);
}

const GENIRO_CARD_KINDS = new Set<string>(
  Object.values(GENIRO_TOOLS).filter(
    (kind): kind is GeniroCardKind => kind !== null,
  ),
);

/**
 * Whether a tool call names geniro's `monitor` — kept out of
 * {@link GENIRO_TOOLS} so its row stays visible, so matched here on its own,
 * in the two spellings {@link geniroToolOf} reads (`mcp__<server>__<tool>`, and
 * cursor's `<server>-<tool>: <tool>`) for a server named `geniro-<runId8>` —
 * and the bare `mcp__<server>` codex names a call it cannot pin to one tool,
 * which may be a monitor.
 *
 * TWIN PARSER: the exact spellings of the daemon's `isHostToolCall`
 * (`apps/daemon/src/v1/agents/utils/host-tool.ts`), and codex's bare
 * `mcp__<server>` card name (`mcpToolApprovalCard` in
 * `apps/daemon/src/v1/agents/adapters/codex/utils/codex-approval.utils.ts`).
 */
export function namesGeniroMonitor(name: string): boolean {
  return /^(?:mcp__geniro-[0-9a-f]{8}(?:__monitor)?|geniro-[0-9a-f]{8}-monitor: monitor)$/.test(
    name,
  );
}

/**
 * Whether a tool call names geniro's `show_gallery`, in the same spellings as
 * {@link namesGeniroMonitor} — codex's bare `mcp__<server>` included, which may
 * be a gallery. Its card is the one a gallery naming a URL raises outside
 * `auto`.
 *
 * TWIN PARSER: the daemon's `isHostToolCall`
 * (`apps/daemon/src/v1/agents/utils/host-tool.ts`).
 */
export function namesGeniroGallery(name: string): boolean {
  return /^(?:mcp__geniro-[0-9a-f]{8}(?:__show_gallery)?|geniro-[0-9a-f]{8}-show_gallery: show_gallery)$/.test(
    name,
  );
}

/** Whether a tool call is one of geniro's own on geniro's own server. */
export function isGeniroToolName(name: string, runId: string): boolean {
  return geniroToolOf(name, runId) !== null;
}

/**
 * The card a tool call is about to draw, or null when it draws none.
 *
 * Null covers three different things on purpose — a tool of somebody else's
 * server, one of geniro's that draws no card, and a name nothing recognises —
 * because the caller does the same thing with all three: leave the transcript
 * exactly as it was.
 */
export function geniroCardKindOf(
  name: string,
  runId: string,
): GeniroCardKind | null {
  const tool = geniroToolOf(name, runId);
  return tool === null ? null : (GENIRO_TOOLS[tool] ?? null);
}

/**
 * Whether an approval card for this tool stands ACROSS turns — `propose_team`
 * and the browser's new-host card — so it waits on the user only while no turn
 * runs, the daemon's `awaitingOf` rule.
 *
 * TWIN PARSER: `PendingApproval.standing` in
 * `apps/daemon/src/v1/agents/services/approval-registry.ts`, set for every card
 * `ChatService.raiseOwnedCard` raises.
 */
export function standsAcrossTurns(toolName: string | null): boolean {
  return isTeamProposalTool(toolName) || toolName === BROWSER_HOST_CARD;
}

/** Whether a row's tool is `propose_team`, under either of its names. */
export function isTeamProposalTool(toolName: string | null): boolean {
  return toolName === PROPOSE_TEAM || toolName === LEGACY_PROPOSE_TEAM;
}

/** Whether an approval row is one of geniro's proposed changes: a card with a heading of its own and a diff. */
export function isProposedChange(toolName: string): boolean {
  return GENIRO_TOOLS[toolName] === 'patch';
}
