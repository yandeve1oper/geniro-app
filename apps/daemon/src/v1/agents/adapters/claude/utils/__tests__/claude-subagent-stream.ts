/**
 * Lines of one `claude -p --output-format stream-json --verbose
 * --include-partial-messages` turn on claude 2.1.325 (haiku), sanitized: the
 * ids and the usage are the probe's, the texts and paths are shortened.
 *
 * The turn ran one FOREGROUND delegate (`toolu_fg…`, no tools) and one
 * BACKGROUND delegate (`toolu_bg…`, one shell call). What the probe settled:
 *
 * - `usage.output_tokens` on every `assistant` line is the count reported when
 *   the response STARTED: the main thread's line says 2 where its
 *   `message_delta` says 327, and the background delegate's lines say 17 and
 *   3 where its own transcript says 77 and 88.
 * - A delegate's `stream_event`s are never streamed; only the main thread's
 *   are.
 * - The foreground delegate's final text-only response is not streamed at all;
 *   its usage reaches the parent only as the closing `tool_use_result.usage`.
 * - The background launch's `tool_use_result` (`async_launched`) carries no
 *   usage, and `task_notification.usage` is `{total_tokens, tool_uses,
 *   duration_ms}` only.
 */
export const SESSION = '206b5e4c-2d3a-4117-8e7e-15051dcb63cc';
export const FOREGROUND_CALL = 'toolu_01RWfnDk9j1RxTHJdPBF3vGw';
export const FOREGROUND_AGENT = 'a1750bf257708268e';
export const BACKGROUND_CALL = 'toolu_01543sXeFyDgT1o2Da1h3smy';
export const BACKGROUND_AGENT = 'a6b48b59bff770d11';

const usage = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): Record<string, number> => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

/** The main thread's first response, split over two lines (thinking, tool_use). */
export const mainThreadLines: Record<string, unknown>[] = [
  {
    type: 'assistant',
    session_id: SESSION,
    parent_tool_use_id: null,
    message: {
      id: 'msg_011Ch4tvb5c5JgrmQqMEqjZZ',
      model: 'claude-haiku-5-5',
      content: [{ type: 'thinking', thinking: '', signature: 'x' }],
      usage: usage(2, 2, 27_662, 19_091),
    },
  },
  {
    type: 'assistant',
    session_id: SESSION,
    parent_tool_use_id: null,
    message: {
      id: 'msg_011Ch4tvb5c5JgrmQqMEqjZZ',
      model: 'claude-haiku-5-5',
      content: [
        {
          type: 'tool_use',
          id: FOREGROUND_CALL,
          name: 'Agent',
          input: { prompt: 'Reply with ALPHA.' },
        },
      ],
      usage: usage(2, 2, 27_662, 19_091),
    },
  },
];

/** The background delegate's streamed responses: one tool_use, then a final reply split in two. */
export const backgroundDelegateLines: Record<string, unknown>[] = [
  {
    type: 'assistant',
    session_id: SESSION,
    parent_tool_use_id: BACKGROUND_CALL,
    message: {
      id: 'msg_011Ch4tw4QfBieGi7hZsuhbV',
      model: 'claude-haiku-5-5',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01Hbnf5Rgzhy5dPNPtuNkMop',
          name: 'Bash',
          input: { command: 'echo BETA' },
        },
      ],
      usage: usage(2, 17, 0, 35_605),
    },
  },
  {
    type: 'assistant',
    session_id: SESSION,
    parent_tool_use_id: BACKGROUND_CALL,
    message: {
      id: 'msg_011Ch4twE93gHYjBfWbYhB94',
      model: 'claude-haiku-5-5',
      content: [{ type: 'thinking', thinking: '', signature: 'x' }],
      usage: usage(2, 3, 35_605, 4_188),
    },
  },
  {
    type: 'assistant',
    session_id: SESSION,
    parent_tool_use_id: BACKGROUND_CALL,
    message: {
      id: 'msg_011Ch4twE93gHYjBfWbYhB94',
      model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: 'BETA' }],
      usage: usage(2, 3, 35_605, 4_188),
    },
  },
];

/** The background delegate's own transcript lines, as claude wrote them to disk. */
export const backgroundTranscriptLines: Record<string, unknown>[] = [
  { type: 'user', message: { role: 'user', content: 'Run echo BETA.' } },
  {
    type: 'assistant',
    message: {
      id: 'msg_011Ch4tw4QfBieGi7hZsuhbV',
      model: 'claude-haiku-5-5',
      content: [{ type: 'tool_use', id: 'toolu_01Hbnf5Rgzhy5dPNPtuNkMop' }],
      usage: usage(2, 77, 0, 35_605),
    },
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01Hbnf5Rgzhy5dPNPtuNkMop' },
      ],
    },
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_011Ch4twE93gHYjBfWbYhB94',
      model: 'claude-haiku-5-5',
      content: [{ type: 'thinking', thinking: '' }],
      usage: usage(2, 88, 35_605, 4_188),
    },
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_011Ch4twE93gHYjBfWbYhB94',
      model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: 'BETA' }],
      usage: usage(2, 88, 35_605, 4_188),
    },
  },
];

/** The background launch's acknowledgement: no usage, and not its end. */
export const backgroundLaunchAck: Record<string, unknown> = {
  type: 'user',
  session_id: SESSION,
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: BACKGROUND_CALL,
        content: [{ type: 'text', text: 'Async agent launched successfully.' }],
      },
    ],
  },
  tool_use_result: {
    isAsync: true,
    status: 'async_launched',
    agentId: BACKGROUND_AGENT,
    description: 'Run echo BETA in background',
    resolvedModel: 'claude-haiku-5-5',
    canReadOutputFile: true,
    canContinueAgent: true,
  },
};

/** The foreground delegate's closing line: its LAST request's usage only. */
export const foregroundClose: Record<string, unknown> = {
  type: 'user',
  session_id: SESSION,
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: FOREGROUND_CALL,
        content: [{ type: 'text', text: 'ALPHA' }],
      },
    ],
  },
  tool_use_result: {
    status: 'completed',
    agentId: FOREGROUND_AGENT,
    agentType: 'general-purpose',
    resolvedModel: 'claude-haiku-5-5',
    totalDurationMs: 2256,
    totalTokens: 37_096,
    totalToolUseCount: 0,
    usage: usage(2, 165, 0, 36_929),
  },
};

export const taskNotification = (
  agentId: string,
  toolCallId: string,
  status: string,
): Record<string, unknown> => ({
  type: 'system',
  subtype: 'task_notification',
  session_id: SESSION,
  task_id: agentId,
  tool_use_id: toolCallId,
  status,
  usage: { total_tokens: 40_020, tool_uses: 1, duration_ms: 4079 },
});
