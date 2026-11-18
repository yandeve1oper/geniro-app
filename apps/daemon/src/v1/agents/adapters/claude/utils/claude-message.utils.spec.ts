import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../adapter.types';
import { catalogClaudePrices } from './__tests__/claude-list-prices';
import {
  ClaudeDelegateSettler,
  readDelegateEnd,
} from './claude-delegate-spend.utils';
import {
  mapClaudeMessage,
  mapClaudeStreamEvent,
  mapClaudeThinkingTokens,
} from './claude-message.utils';
import { ClaudeSessionCostLedger } from './claude-usage.utils';

/** End a delegate the way the driver's settler does, with no transcript on disk. */
async function endDelegate(
  ledger: ClaudeSessionCostLedger,
  line: Record<string, unknown>,
): Promise<AgentEvent[]> {
  const launchOfTask = (taskId: string, toolCallId: string | null) =>
    ledger.launchOfTask(taskId, toolCallId);
  const end = readDelegateEnd(line, launchOfTask);
  if (end === null) {
    throw new Error('the line ends no delegate');
  }
  return new ClaudeDelegateSettler({
    tracker: ledger.delegateSpend,
    launchOfTask,
    priceNow: (sessionId, spend) => ledger.delegates.priceNow(sessionId, spend),
    record: (sessionId, delegateId, spend) =>
      ledger.delegates.record(sessionId, delegateId, spend),
    readTranscript: () => Promise.resolve(null),
  }).settle(end);
}

/** A stream_event line as captured from a live claude-opus-5 turn. */
const textDelta = (text: string): Record<string, unknown> => ({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  },
});

/** A plain permission pause of the stdin control dialogue. */
const CONTROL_REQUEST =
  '{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"a.txt"}}}\n';

describe('mapClaudeMessage', () => {
  it('extracts the session id from system/init', () => {
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'session', sessionId: 'sess-1' }]);
  });

  it('harvests init slash_commands alongside the session id, dropping non-strings', () => {
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
          slash_commands: ['review', 42, '', 'compact'],
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      {
        type: 'slash_commands',
        // Names and nothing else: the field is an array of plain strings, so
        // every entry reports a null description and the sentence beside it
        // in the popup comes from this CLI's disk scan instead.
        commands: [
          { name: 'review', description: null },
          { name: 'compact', description: null },
        ],
      },
    ]);
  });

  it('harvests init mcp_servers with the state each was in', () => {
    // Captured verbatim from a live 2.1.222 turn. This is the whole point of
    // the MCP harvest: the panel's alternative is `claude mcp list`, which
    // HEALTH-CHECKS — it dials, and therefore starts, every configured server
    // from cold (6.7s measured against nine of them). A wrong field name here
    // ships green and silently leaves the panel on that cold path.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
          mcp_servers: [
            { name: 'codegraph', status: 'connected' },
            { name: 'ticktick', status: 'pending' },
            { name: 'claude.ai n8n', status: 'failed' },
          ],
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      {
        type: 'mcp_servers',
        servers: [
          {
            name: 'codegraph',
            // Init reports a name and a state and nothing else — the command
            // line is genuinely unknown here, and null is what says so.
            target: null,
            transport: null,
            status: 'connected',
            detail: null,
          },
          {
            name: 'ticktick',
            target: null,
            transport: null,
            status: 'loading',
            detail: null,
          },
          {
            name: 'claude.ai n8n',
            target: null,
            transport: null,
            status: 'failed',
            detail: null,
          },
        ],
      },
    ]);
  });

  it('carries a switched-off server through as disabled, not as unknown', () => {
    // PROBE-VERIFIED on 2.1.223, isolated CLAUDE_CONFIG_DIR, one local-scope
    // server: without `disabledMcpServers` init says `failed`, with it init
    // says `disabled`. The mapper used to omit that status from its allow-list
    // — on the stated reasoning that a switched-off server is never loaded and
    // so never reported, which is not what the CLI does — and every such row
    // was harvested as `unknown` instead.
    //
    // Where the CLI's own config could still be read the overlay put it right,
    // which is what kept this invisible. Where it could not, the panel fell
    // back to `status === 'disabled'` and rendered a switched-off server as on.
    const [event] = mapClaudeMessage(
      {
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: 'probe-server', status: 'disabled' }],
      },
      new ClaudeSessionCostLedger(),
    );

    expect(event).toEqual({
      type: 'mcp_servers',
      servers: [
        expect.objectContaining({ name: 'probe-server', status: 'disabled' }),
      ],
    });
  });

  it('translates the CLI’s needs-auth into the app’s own needs_auth', () => {
    // The two spell it differently — init says `needs-auth`, the app's
    // `AgentMcpServerStatus` says `needs_auth` — and the reader compared the
    // raw string against the four statuses that happen to match, so every
    // server the user has to SIGN IN to was harvested as `unknown`. That is the
    // one status carrying no affordance, which makes it the worst possible
    // answer for exactly this state, and it is most of a real list rather than
    // an edge: the reporter's own harvest held 27 such rows of 51 in one
    // folder and 28 of 53 in another.
    //
    // MEASURED on 2.1.251 rather than read off the binary (the literal is in
    // there, sitting among spellcheck and github strings, which says nothing
    // about this field): one `claude -p --output-format stream-json --verbose`
    // answered `{'pending': 3, 'connected': 8, 'needs-auth': 1}`, the odd row
    // being `{name: 'claude.ai Wispr Flow', status: 'needs-auth'}`.
    const [event] = mapClaudeMessage(
      {
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: 'claude.ai Wispr Flow', status: 'needs-auth' }],
      },
      new ClaudeSessionCostLedger(),
    );

    expect(event).toEqual({
      type: 'mcp_servers',
      servers: [
        expect.objectContaining({
          name: 'claude.ai Wispr Flow',
          status: 'needs_auth',
        }),
      ],
    });
  });

  it('reads init’s pending as still connecting, never as awaiting approval', () => {
    const [event] = mapClaudeMessage(
      {
        type: 'system',
        subtype: 'init',
        mcp_servers: [
          { name: 'ticktick', status: 'pending', source: 'user' },
          {
            name: 'claude.ai Wispr Flow',
            status: 'pending',
            source: 'claudeai',
          },
        ],
      },
      new ClaudeSessionCostLedger(),
    );

    expect(event).toEqual({
      type: 'mcp_servers',
      servers: [
        expect.objectContaining({ name: 'ticktick', status: 'loading' }),
        expect.objectContaining({
          name: 'claude.ai Wispr Flow',
          status: 'loading',
        }),
      ],
    });
  });

  it('keeps a server whose status it cannot read, calling it unknown', () => {
    // The server is real either way. Dropping it would shrink the listing on a
    // CLI wording change; calling it `failed` would invent a problem. A row
    // with no usable name is the one thing genuinely not listable.
    //
    // The unreadable example used to be `needs-auth`, which the test above now
    // shows was a status this CLI really sends — so this row is a status no CLI
    // has been seen to send, which is what the case is actually about.
    const [event] = mapClaudeMessage(
      {
        type: 'system',
        subtype: 'init',
        mcp_servers: [
          { name: 'reworded', status: 'reticulating' },
          { name: 'no-status' },
          { status: 'connected' },
          'not-an-object',
        ],
      },
      new ClaudeSessionCostLedger(),
    );

    expect(event).toEqual({
      type: 'mcp_servers',
      servers: [
        expect.objectContaining({ name: 'reworded', status: 'unknown' }),
        expect.objectContaining({ name: 'no-status', status: 'unknown' }),
      ],
    });
  });

  it('reports the model init names, so a window can be applied before turn end', () => {
    // The whole per-model window feature hangs off this one field. `assistant`
    // lines carry the CANONICAL id (`claude-opus-5`), which is not the key
    // `result.modelUsage` uses (`claude-opus-5[1m]`) and so cannot match a
    // remembered window — init's is the one that can. A wrong field name here
    // ships green and leaves the feature inert.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
          model: 'claude-opus-5[1m]',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      { type: 'turn_model', model: 'claude-opus-5[1m]' },
    ]);
  });

  it('says nothing about the model when init names none', () => {
    expect(
      mapClaudeMessage(
        { type: 'system', subtype: 'init', model: 42 },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('ignores non-init system events (hook_*, post_turn_summary)', () => {
    expect(
      mapClaudeMessage(
        { type: 'system', subtype: 'hook_started' },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
    expect(
      mapClaudeMessage(
        { type: 'system', subtype: 'post_turn_summary' },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('maps assistant text/thinking/tool_use blocks in order', () => {
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'let me think' },
            { type: 'text', text: 'hello' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } },
          ],
        },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(events).toEqual([
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: 'hello' },
      { type: 'tool_call', id: 't1', name: 'Read', input: { path: '/x' } },
    ]);
  });

  it('keeps a progress-update thinking block before a tool call as reasoning, and drops the empty signed one beside it', () => {
    // The exact shape Opus 5.5 answered with on 2026-09-24 ahead of an
    // AskUserQuestion: its reasoning block (empty under the CLI's default
    // display, signature only), then the prose it wrote before the call —
    // returned by the API as a SUMMARY in a second thinking block — then the
    // call, with no text block at all. That summary is the only trace of the
    // message the user was meant to read, so it must reach the transcript.
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 'sig-a' },
            {
              type: 'thinking',
              thinking:
                "I'll investigate MAN-4515 starting with a Researcher.\n\n",
              signature: 'sig-b',
            },
            {
              type: 'tool_use',
              id: 't1',
              name: 'AskUserQuestion',
              input: { questions: [] },
            },
          ],
        },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(events).toEqual([
      {
        type: 'reasoning',
        text: "I'll investigate MAN-4515 starting with a Researcher.\n\n",
      },
      {
        type: 'tool_call',
        id: 't1',
        name: 'AskUserQuestion',
        input: { questions: [] },
      },
    ]);
  });

  it('maps a user tool_result block', () => {
    expect(
      mapClaudeMessage(
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: 'file body',
                is_error: false,
              },
            ],
          },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'tool_result',
        id: 't1',
        name: null,
        result: 'file body',
        isError: false,
      },
    ]);
  });

  /**
   * The permission channel dying under the CLI. It arrives as ordinary tool
   * RESULT TEXT, which is why nothing reacted to it and why 239 occurrences sat
   * unremarked in one database until a SQL query went looking.
   */
  const permissionFailure = (content: unknown): unknown =>
    mapClaudeMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't9', content, is_error: true },
          ],
        },
      },
      new ClaudeSessionCostLedger(),
    );

  it('raises a notice when a tool result is the permission channel failing', () => {
    const events = permissionFailure(
      'Tool permission request failed: AbortError: Stream closed',
    );

    // The raw result still reaches the transcript untouched — the notice is an
    // ADDITION, so nothing the agent saw is rewritten.
    expect(events).toEqual([
      expect.objectContaining({ type: 'tool_result', id: 't9', isError: true }),
      expect.objectContaining({ type: 'notice' }),
    ]);
  });

  it('matches the CLI wording whose middle varies, and finds it inside block content', () => {
    // `Error: Stream closed` appears beside `AbortError: Stream closed` in the
    // CLI's own issue tracker, so only the two stable halves are matched — and
    // `content` is an array of blocks on some results, a bare string on others.
    expect(
      permissionFailure([
        { type: 'text', text: 'Tool permission request failed: Stream closed' },
      ]),
    ).toEqual([
      expect.objectContaining({ type: 'tool_result' }),
      expect.objectContaining({ type: 'notice' }),
    ]);
  });

  it('does NOT fire on a tool that merely mentions one half', () => {
    // A grep hit or a test name containing "Stream closed" is not the channel
    // dying; requiring BOTH markers is what keeps this from crying wolf over
    // the user's own source.
    for (const content of [
      'Stream closed by the peer',
      'Tool permission request failed for an unrelated reason',
      null,
      42,
    ]) {
      expect(permissionFailure(content)).toEqual([
        expect.objectContaining({ type: 'tool_result' }),
      ]);
    }
  });

  it('does NOT fire when a tool result merely QUOTES the sentence further down', () => {
    // Measured, not hypothetical. On a real 47-minute run this fired three
    // times, every one of them a sub-agent `Read`ing geniro's own source: the
    // marker constants live in `claude.const.ts` and `spawn-cli.ts` quotes the
    // CLI's sentence verbatim in a doc block, so reading either one reported
    // that claude's permission channel had died. Twelve matches in that
    // daemon's log, and not one genuine CLI failure among them.
    //
    // The first line is what discriminates: the failing tool's result IS the
    // sentence and arrives alone, while a file that documents it has content
    // above it.
    const readOfThisRepo = [
      '330\tconst settlesOnTerminalEvent = opts.stdinLifetime === 0;',
      '331\t  /** they carried 165 of the 181 `Tool permission request failed:',
      '332\t   * AbortError: Stream closed` failures (10.4% here). */',
    ].join('\n');

    expect(permissionFailure(readOfThisRepo)).toEqual([
      expect.objectContaining({ type: 'tool_result' }),
    ]);
  });

  it('still fires when the sentence is the whole result, blank lines and all', () => {
    // The other side of the first-line rule: a leading newline must not hide a
    // genuine failure. Losing this is worse than the false positive it fixes —
    // it is the 239-unremarked-failures bug coming back.
    expect(
      permissionFailure(
        '\n\nTool permission request failed: AbortError: Stream closed',
      ),
    ).toEqual([
      expect.objectContaining({ type: 'tool_result' }),
      expect.objectContaining({ type: 'notice' }),
    ]);
  });

  it('requires both markers in ONE text leaf, not merely somewhere in the payload', () => {
    // The detector reads text leaves; it does NOT serialize the payload. Two
    // unrelated blocks each carrying one half are not the CLI's sentence, and
    // the old `JSON.stringify(content)` search called them one. Restore it and
    // this fires.
    expect(
      permissionFailure([
        { type: 'text', text: 'Tool permission request failed' },
        { type: 'text', text: 'Stream closed' },
      ]),
    ).toEqual([expect.objectContaining({ type: 'tool_result' })]);
  });

  it('does not read prose out of an image block, which is what the scan was narrowed for', () => {
    // The worst case of the whole-payload stringify: a base64 image result
    // serialized in full so two short markers could be searched for in bytes
    // that cannot carry prose. Matching here would also be a false positive —
    // an image is not the permission channel reporting anything.
    expect(
      permissionFailure([
        {
          type: 'image',
          source: {
            data: 'Tool permission request failed: AbortError: Stream closed',
          },
        },
      ]),
    ).toEqual([expect.objectContaining({ type: 'tool_result' })]);
  });

  it('still finds the sentence when the result is an object carrying a text field', () => {
    // The third shape the narrowing kept — asserted so a later "simplify to
    // strings and arrays" cannot drop it silently.
    expect(
      permissionFailure({
        text: 'Tool permission request failed: AbortError: Stream closed',
      }),
    ).toEqual([
      expect.objectContaining({ type: 'tool_result' }),
      expect.objectContaining({ type: 'notice' }),
    ]);
  });

  it('marks the result of a turn the CLI ran BY ITSELF as a continuation, and only that one', () => {
    // Probed on 2.1.266: a message sent mid-continuation got the continuation's
    // own result first — with this origin — and its real answer after, with none.
    const line = (origin?: unknown) =>
      mapClaudeMessage(
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Background task completed (exit code 0).',
          stop_reason: 'end_turn',
          ...(origin === undefined ? {} : { origin }),
        },
        new ClaudeSessionCostLedger(),
      );
    expect(line({ kind: 'task-notification' })).toEqual([
      expect.objectContaining({
        type: 'turn_complete',
        finalText: 'Background task completed (exit code 0).',
        continuation: true,
      }),
    ]);
    expect(line()).toEqual([
      expect.not.objectContaining({ continuation: expect.anything() }),
    ]);
    expect(line({ kind: 'human' })).toEqual([
      expect.not.objectContaining({ continuation: expect.anything() }),
    ]);
  });

  it('marks a FAILED continuation as one too — claude 2.1.280 puts origin on error results', () => {
    // Read out of the 2.1.280 query loop: one common block carrying `origin` is
    // spread into every result variant, `error_during_execution` and
    // `error_max_turns` included. Without the flag a continuation that failed
    // reached spawn-cli as a plain `error` and ended the user's own turn.
    const line = (origin?: unknown) =>
      mapClaudeMessage(
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'The continuation hit an API error.',
          ...(origin === undefined ? {} : { origin }),
        },
        new ClaudeSessionCostLedger(),
      );
    expect(line({ kind: 'task-notification' })).toEqual([
      expect.objectContaining({
        type: 'error',
        message: 'The continuation hit an API error.',
        continuation: true,
      }),
    ]);
    expect(line()).toEqual([
      expect.not.objectContaining({ continuation: expect.anything() }),
    ]);
  });

  it('keeps what a FAILED turn spent on its error — a session limit after hours of work is real money', () => {
    // Measured on run e33259e4: three Engineer calls ran 22–25 minutes each and
    // ended `You've hit your session limit`, and the ~$165 their requests cost
    // reached no total and no Stats row, because the error dropped the line's
    // `total_cost_usd` — a required field of 2.1.280's result schema whatever
    // `is_error` says.
    const [event] = mapClaudeMessage(
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'api_error',
        api_error_status: 429,
        result: "You've hit your session limit · resets 1:20pm (Asia/Almaty)",
        session_id: 'session-limit',
        total_cost_usd: 56.69,
        usage: {
          input_tokens: 40,
          output_tokens: 193_000,
          cache_creation_input_tokens: 660_000,
          cache_read_input_tokens: 95_400_000,
        },
      },
      new ClaudeSessionCostLedger(),
    );

    expect(event).toMatchObject({
      type: 'error',
      message: "You've hit your session limit · resets 1:20pm (Asia/Almaty)",
      usage: {
        costUsd: 56.69,
        outputTokens: 193_000,
        cacheReadTokens: 95_400_000,
      },
    });
  });

  describe('why the prompt cache is five minutes', () => {
    // The `rate_limit_event` shape as the 2.1.295 probe printed it, and a
    // result whose last request wrote the given cache.
    const rateLimit = (sessionId: string, info: Record<string, unknown>) => ({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        overageStatus: 'allowed',
        ...info,
      },
      session_id: sessionId,
    });
    const result = (
      sessionId: string,
      oneHour: number,
      fiveMinutes: number,
    ) => {
      const split = {
        cache_creation: {
          ephemeral_1h_input_tokens: oneHour,
          ephemeral_5m_input_tokens: fiveMinutes,
        },
      };
      return {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        session_id: sessionId,
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          ...split,
          iterations: [{ input_tokens: 2, output_tokens: 3, ...split }],
        },
      };
    };
    const reasonOf = (events: AgentEvent[]) => {
      const [event] = events;
      return event?.type === 'turn_complete'
        ? event.usage?.promptCacheTtlReason
        : undefined;
    };

    it('names extra usage when the account is on it and the cache is five minutes', () => {
      const ledger = new ClaudeSessionCostLedger();

      expect(
        mapClaudeMessage(rateLimit('s1', { isUsingOverage: true }), ledger),
      ).toEqual([]);
      expect(reasonOf(mapClaudeMessage(result('s1', 0, 1_967), ledger))).toBe(
        'extra-usage',
      );
    });

    it('states no reason for an hour-long cache, whatever the account is on', () => {
      const ledger = new ClaudeSessionCostLedger();
      mapClaudeMessage(rateLimit('s1', { isUsingOverage: true }), ledger);

      expect(
        reasonOf(mapClaudeMessage(result('s1', 1_967, 0), ledger)),
      ).toBeNull();
    });

    it('states no reason for a five-minute cache the CLI never tied to extra usage', () => {
      // An API-key profile writes the five-minute cache by default — nothing
      // was said about extra usage, so nothing is claimed.
      expect(
        reasonOf(
          mapClaudeMessage(result('s1', 0, 512), new ClaudeSessionCostLedger()),
        ),
      ).toBeNull();
    });

    it('drops the reason once the account leaves extra usage', () => {
      const ledger = new ClaudeSessionCostLedger();
      mapClaudeMessage(rateLimit('s1', { isUsingOverage: true }), ledger);
      mapClaudeMessage(rateLimit('s1', { isUsingOverage: false }), ledger);

      expect(
        reasonOf(mapClaudeMessage(result('s1', 0, 512), ledger)),
      ).toBeNull();
    });

    it('keeps the state through an event that does not say', () => {
      // The CLI sends the event on a CHANGE; a line missing the flag is not a
      // statement that the account left extra usage.
      const ledger = new ClaudeSessionCostLedger();
      mapClaudeMessage(rateLimit('s1', { isUsingOverage: true }), ledger);
      mapClaudeMessage(
        { type: 'rate_limit_event', rate_limit_info: {}, session_id: 's1' },
        ledger,
      );

      expect(reasonOf(mapClaudeMessage(result('s1', 0, 512), ledger))).toBe(
        'extra-usage',
      );
    });

    it("keeps each session's account apart", () => {
      // One adapter serves every concurrent process, and two profiles can be
      // on two different accounts.
      const ledger = new ClaudeSessionCostLedger();
      mapClaudeMessage(rateLimit('s1', { isUsingOverage: true }), ledger);

      expect(
        reasonOf(mapClaudeMessage(result('s2', 0, 512), ledger)),
      ).toBeNull();
    });
  });

  it('adds no usage to a failure that spent nothing', () => {
    const [event] = mapClaudeMessage(
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      new ClaudeSessionCostLedger(),
    );

    expect(event).toMatchObject({ type: 'error' });
    expect(event).not.toHaveProperty('usage');
  });

  it('maps a successful result to turn_complete with the usage readClaudeUsage derives', () => {
    expect(
      mapClaudeMessage(
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'pong',
          stop_reason: 'end_turn',
          usage: {
            // Turn-wide roll-up: three requests' worth of the same conversation.
            input_tokens: 12,
            output_tokens: 3,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 2_700,
            iterations: [
              {
                input_tokens: 4,
                output_tokens: 3,
                cache_creation_input_tokens: 12,
                cache_read_input_tokens: 996,
              },
            ],
          },
          modelUsage: {
            'claude-opus-5[1m]': {
              inputTokens: 12,
              cacheReadInputTokens: 2_700,
              contextWindow: 1_000_000,
            },
          },
          session_id: 'sess-result',
          // Plausible for these tokens — a total far past what they can cost is
          // read as history the ledger could not subtract, and capped.
          total_cost_usd: 0.004,
          duration_ms: 7618,
          duration_api_ms: 7176,
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'turn_complete',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          // The other two thirds of the same roll-up, cumulative like the
          // input count beside them — NOT the last request's 12/996, which is
          // what `contextTokens` below is built from.
          cacheReadTokens: 2_700,
          cacheCreationTokens: 100,
          // This fixture's result carries no `output_tokens_details`, and a
          // build that reports none must read as unknown rather than as a turn
          // that thought nothing.
          thinkingTokens: null,
          // The final request's prompt (4 + 12 + 996), not the 2_812 roll-up.
          contextTokens: 1012,
          contextWindowTokens: 1_000_000,
          contextModel: expect.any(String),
          costUsd: 0.004,
          // The CLI's own turn timing, carried through the mapper to the turn
          // the transcript persists — the number that lets a finished turn say
          // how long it worked instead of only what it cost.
          durationMs: 7618,
          apiMs: 7176,
          ttftMs: null,
          timeToRequestMs: null,
          numTurns: null,
          // This fixture's usage carries no `cache_creation` split.
          promptCacheTtlMs: null,
          promptCacheTtlReason: null,
          modelCosts: null,
        },
        stopReason: 'end_turn',
        finalText: 'pong',
      },
    ]);
  });

  it('drops a result that reports no work at all', () => {
    // The CLI emits this at the START of a resumed turn, before any output of
    // that turn. Mapping it to a completion planted a `✓ done · $0.0000` under
    // the user's message, zeroed the context meter, and marked the turn
    // terminated — so the real work that followed got no completion and its
    // cost was never counted.
    expect(
      mapClaudeMessage(
        {
          type: 'result',
          is_error: false,
          result: null,
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          total_cost_usd: 0,
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  describe('a resumed process whose seed found no cost-state', () => {
    const SESSION_ID = 's-resumed';
    /** A resumed process's opening line: no request, the running total only. */
    const quietResult = (total: number) => ({
      type: 'result',
      is_error: false,
      session_id: SESSION_ID,
      result: null,
      stop_reason: null,
      duration_ms: 49,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {
        'claude-haiku-5-5': { contextWindow: 1_000_000, costUSD: 0 },
      },
      total_cost_usd: total,
    });
    const billed = (events: AgentEvent[]): number =>
      events.reduce(
        (sum, event) =>
          sum +
          (event.type === 'turn_complete' ? (event.usage?.costUsd ?? 0) : 0),
        0,
      );
    /** The ledger as a resumed process leaves it once its `init` is mapped. */
    function resumed(
      ...before: Record<string, unknown>[]
    ): ClaudeSessionCostLedger {
      const ledger = new ClaudeSessionCostLedger();
      ledger.expectResume(SESSION_ID, () => null);
      for (const line of [
        ...before,
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
      ]) {
        mapClaudeMessage(line, ledger);
      }
      return ledger;
    }

    it('bills nothing for its opening line, whatever running total it carries', () => {
      const ledger = resumed();

      expect(billed(mapClaudeMessage(quietResult(40.676), ledger))).toBe(0);
    });

    it('bills a quiet line after its own main-thread compaction', () => {
      const ledger = resumed();
      mapClaudeMessage(
        { type: 'system', subtype: 'compact_boundary', session_id: SESSION_ID },
        ledger,
      );

      expect(billed(mapClaudeMessage(quietResult(0.4), ledger))).toBeCloseTo(
        0.4,
        6,
      );
    });

    it('does not let a sub-agent’s compaction, or one from before its init, exempt that line', () => {
      const delegate = resumed();
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'compact_boundary',
          session_id: SESSION_ID,
          parent_tool_use_id: 'toolu_1',
        },
        delegate,
      );
      expect(billed(mapClaudeMessage(quietResult(0.4), delegate))).toBe(0);

      const stale = resumed({
        type: 'system',
        subtype: 'compact_boundary',
        session_id: SESSION_ID,
      });
      expect(billed(mapClaudeMessage(quietResult(0.4), stale))).toBe(0);
    });
  });

  it('keeps a completion that reports a stop reason but no tokens', () => {
    // The drop is narrow on purpose: only a result saying NOTHING is discarded,
    // so a real completion can never be swallowed by it.
    const [event] = mapClaudeMessage(
      {
        type: 'result',
        is_error: false,
        result: null,
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
      },
      new ClaudeSessionCostLedger(),
    );
    expect(event).toMatchObject({
      type: 'turn_complete',
      stopReason: 'end_turn',
    });
  });

  it('drops a no-work result whose text is EMPTY rather than absent', () => {
    // Reconstructed from the author's own geniro.db + debug log (2026-08-18,
    // 2.1.234, run 4144f28e, twice in 40 minutes): `status?` was answered with
    // `✓ done · 0s · $0.0000` and nothing above it, 2.7s after it was sent. The
    // CLI's own session file shows the turn it ran in that window was a
    // `<task-notification>` it had queued for itself, not the user's prompt —
    // so the line was the absence of an answer, and `result: ""` rather than
    // `result: null` is the only reason it was read as one.
    expect(
      mapClaudeMessage(
        {
          type: 'result',
          is_error: false,
          result: '',
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          total_cost_usd: 0,
          duration_ms: 35,
          duration_api_ms: 0,
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('keeps a wordless completion that did REAL work', () => {
    // The other half of the narrowness: a turn can legitimately end with no
    // sentence — it ran tools and stopped — and that one has token counts. Only
    // a line reporting nothing at all is discarded.
    const [event] = mapClaudeMessage(
      {
        type: 'result',
        is_error: false,
        result: '',
        stop_reason: null,
        usage: { input_tokens: 1_200, output_tokens: 8 },
        total_cost_usd: 0.02,
      },
      new ClaudeSessionCostLedger(),
    );
    expect(event).toMatchObject({ type: 'turn_complete' });
  });

  it('maps an error result to an error event', () => {
    expect(
      mapClaudeMessage(
        {
          type: 'result',
          is_error: true,
          result: 'context limit exceeded',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'error', message: 'context limit exceeded' }]);
  });

  it('names the CLI’s own subtype when an error result carries no sentence', () => {
    // The exact line a user was handed: `{type:'result', is_error:true}` with
    // no `result` and no `error`, rendered as three words that answer nothing
    // — reported back as "i have error, i dont know why". The subtype is the
    // only thing the line does say, and it is searchable.
    expect(
      mapClaudeMessage(
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'error',
        message: 'claude run failed (error_during_execution)',
        // …and the same word as a FIELD, which is what a reader can search
        // and a report can carry without the sentence around it.
        detail: { code: 'error_during_execution' },
      },
    ]);
  });

  it('keeps the CLI’s own sentence alone when it has one', () => {
    // A subtype appended to an explanation is machine noise on the end of it.
    expect(
      mapClaudeMessage(
        {
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          result: 'reached the turn limit',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'error',
        message: 'reached the turn limit',
        detail: { code: 'error_max_turns' },
      },
    ]);
  });

  it('ignores unknown event types and non-objects', () => {
    expect(
      mapClaudeMessage(
        { type: 'rate_limit_event', tier: 'x' },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
    expect(mapClaudeMessage('garbage', new ClaudeSessionCostLedger())).toEqual(
      [],
    );
    expect(mapClaudeMessage(null, new ClaudeSessionCostLedger())).toEqual([]);
    expect(mapClaudeMessage(42, new ClaudeSessionCostLedger())).toEqual([]);
  });
});

describe('mapClaudeMessage — the control dialogue (ask mode)', () => {
  it('maps a can_use_tool control_request to an approval_request event', () => {
    expect(
      mapClaudeMessage(
        JSON.parse(CONTROL_REQUEST),
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'approval_request',
        id: 'req-1',
        toolName: 'Write',
        input: { file_path: 'a.txt' },
      },
    ]);
  });

  it("offers a permission the CLI's own remembering answers, and a question none", () => {
    const request = (toolName: string): unknown => ({
      type: 'control_request',
      request_id: 'req-r',
      request: {
        subtype: 'can_use_tool',
        tool_name: toolName,
        input: { questions: [] },
        permission_suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      },
    });
    const [permission] = mapClaudeMessage(
      request('Bash'),
      new ClaudeSessionCostLedger(),
    );
    expect(
      permission?.type === 'approval_request'
        ? permission.options?.map((option) => option.id)
        : null,
    ).toEqual(['session', 'always']);
    const [question] = mapClaudeMessage(
      request('AskUserQuestion'),
      new ClaudeSessionCostLedger(),
    );
    expect(
      question?.type === 'approval_request' ? question.options : null,
    ).toBeUndefined();
  });

  it('carries requires_user_interaction — the question-vs-permission discriminator (M4)', () => {
    const events = mapClaudeMessage(
      {
        type: 'control_request',
        request_id: 'req-q',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: { questions: [] },
          requires_user_interaction: true,
        },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'approval_request',
        toolName: 'AskUserQuestion',
        requiresUserInteraction: true,
      }),
    ]);
    // A plain permission carries no flag — the event must not fake one.
    const plain = mapClaudeMessage(
      JSON.parse(CONTROL_REQUEST),
      new ClaudeSessionCostLedger(),
    );
    expect(
      (plain[0] as { requiresUserInteraction?: boolean })
        .requiresUserInteraction,
    ).toBeUndefined();
  });

  it('projects an AskUserQuestion into the question card, and nothing else', () => {
    const request = (toolName: string) => ({
      type: 'control_request',
      request_id: 'req-q',
      request: {
        subtype: 'can_use_tool',
        tool_name: toolName,
        input: {
          questions: [
            {
              question: 'Which store?',
              header: 'Store',
              multiSelect: true,
              options: [
                { label: 'SQLite', description: 'embedded', preview: '# plan' },
              ],
            },
          ],
        },
      },
    });
    expect(
      mapClaudeMessage(
        request('AskUserQuestion'),
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      expect.objectContaining({
        questions: [
          {
            question: 'Which store?',
            header: 'Store',
            multiSelect: true,
            options: [
              { label: 'SQLite', description: 'embedded', preview: '# plan' },
            ],
          },
        ],
      }),
    ]);
    // The same payload under any other tool is a permission, not a question.
    const [plain] = mapClaudeMessage(
      request('Write'),
      new ClaudeSessionCostLedger(),
    );
    expect(plain).not.toHaveProperty('questions');
  });

  it('lifts message.usage off a REAL assistant line as live context', () => {
    // Captured verbatim from `claude -p --output-format stream-json --verbose`
    // on 2.1.220 (2026-07-29), trimmed to the fields under test. Fabricating
    // this line would pin our own guess about the CLI, not the CLI.
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'A teapot.' }],
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 36569,
            cache_read_input_tokens: 18366,
            output_tokens: 1,
            service_tier: 'standard',
          },
        },
      },
      new ClaudeSessionCostLedger(),
    );
    // Prompt side only — output tokens are not context — and cache traffic
    // counts, because on a resumed session it IS the context.
    //
    // The SPEND rides the same line, unsummed, and the two readings are the
    // reason both events exist: `context_progress` folds three of these four
    // into a level, which is the wrong number for a bill because cache reads
    // dominate it and are the cheapest tokens on it. Real figures off a
    // captured 2.1.220 line, so the split is pinned against the CLI's own
    // field names rather than against this spec's arithmetic.
    expect(events).toEqual([
      { type: 'context_progress', contextTokens: 2 + 36569 + 18366 },
      {
        type: 'usage_progress',
        inputTokens: 2,
        outputTokens: 1,
        cacheReadTokens: 18366,
        cacheCreationTokens: 36569,
      },
      { type: 'text', text: 'A teapot.' },
    ]);
  });

  it('emits NO spend event for a delegate’s own assistant line', () => {
    // Same rule as the context above it, for a different reason worth stating:
    // a delegate's context is another conversation's LEVEL and would be wrong
    // to show, while its spend is real money on this turn — but the turn's own
    // `turn_complete` roll-up already counts every request the turn made,
    // delegates included. Publishing both would show a running total that then
    // SHRANK at the settle.
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_delegate',
        message: {
          content: [{ type: 'text', text: 'from a delegate' }],
          usage: { input_tokens: 11, output_tokens: 22 },
        },
      },
      new ClaudeSessionCostLedger(),
    );

    expect(events.some((event) => event.type === 'usage_progress')).toBe(false);
    expect(events.some((event) => event.type === 'context_progress')).toBe(
      false,
    );
  });

  it('emits no context event for an assistant line that carries no usage', () => {
    // A CLI build that omits it must degrade to "the meter waits", never to a
    // zero that reads as an empty context.
    expect(
      mapClaudeMessage(
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hi' }] },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('returns an unmodelled control subtype as data instead of dropping it', () => {
    // The mapper is pure and cannot log, so the ONLY way an
    // unrecognized subtype becomes visible is by leaving the function. If this
    // ever goes back to `[]` the daemon is silently blind again.
    expect(
      mapClaudeMessage(
        {
          type: 'control_request',
          request_id: 'r',
          request: { subtype: 'initialize' },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'unhandled_control', subtype: 'initialize' }]);
  });

  it('reports a control_request with no readable subtype rather than swallowing it', () => {
    expect(
      mapClaudeMessage(
        { type: 'control_request', request_id: 'r' },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'unhandled_control', subtype: '<none>' }]);
  });

  it('maps control_cancel_request — the CLI withdrawing a request — to approval_withdrawn', () => {
    // The 2.1.280 envelope, `{type, request_id}`, written when a
    // `can_use_tool` request's abort fires. With no arm the request stayed
    // outstanding for good: the silence deadline suspended on it and every
    // later turn re-offered a card whose answer could reach nothing.
    expect(
      mapClaudeMessage(
        { type: 'control_cancel_request', request_id: 'req-1' },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'approval_withdrawn', id: 'req-1' }]);
    expect(
      mapClaudeMessage(
        { type: 'control_cancel_request' },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });
});

describe('mapClaudeMessage — sub-agent origin', () => {
  /**
   * Captured verbatim from `claude -p --output-format stream-json --verbose` on
   * 2.1.226 (2026-08-10), from a turn that launched one sub-agent, trimmed to
   * the fields under test. The whole defect is that these lines are
   * indistinguishable from main-thread ones, so a fabricated fixture would pin
   * our guess about the CLI rather than the CLI.
   *
   * In that capture `parent_tool_use_id` appeared on the 12 `assistant`/`user`
   * lines and nowhere else: null on the 9 main-thread ones, and set to the id
   * of the `Agent` tool call on the 3 the sub-agent produced.
   */
  const AGENT_TOOL_USE_ID = 'toolu_01GffB3XLs9hgFTpZLrsex4f';

  it('marks a sub-agent tool call with the call that started it', () => {
    expect(
      mapClaudeMessage(
        {
          type: 'assistant',
          parent_tool_use_id: AGENT_TOOL_USE_ID,
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_01W3VZjfLcUZ1wi9o3NJD7sW',
                name: 'Bash',
                input: { command: 'echo hello-from-subagent' },
              },
            ],
          },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'tool_call',
        id: 'toolu_01W3VZjfLcUZ1wi9o3NJD7sW',
        name: 'Bash',
        input: { command: 'echo hello-from-subagent' },
        parentToolUseId: AGENT_TOOL_USE_ID,
      },
    ]);
  });

  it('names the model a delegate is RUNNING, from the first line it speaks on', () => {
    // Every other channel reports a delegate's model when the work is OVER
    // (the launching call's `resolvedModel`), so a running one was unattributed
    // for exactly as long as it ran. Verified on disk against a real delegate's
    // own transcript: its first assistant row carries `message.model`.
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        parent_tool_use_id: AGENT_TOOL_USE_ID,
        message: {
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'looking' }],
        },
      },
      new ClaudeSessionCostLedger(),
    );

    const declaration = events.find(
      (event) => event.type === 'subagent_info',
    ) as { id: string; model: string | null } | undefined;
    expect(declaration).toMatchObject({
      id: AGENT_TOOL_USE_ID,
      model: 'claude-opus-5',
    });
    // ABOUT a delegate, not produced BY one: it names the launching call in its
    // own `id`, so stamping the origin as well would file the declaration as
    // one of the delegate's own rows.
    expect(declaration).not.toHaveProperty('parentToolUseId');
    // Every other field null, so it cannot blank what a richer announcement
    // gave under the merge rule.
    expect(declaration).toMatchObject({ label: null, prompt: null });
  });

  it('announces that model ONCE, not on every line the delegate writes', () => {
    // A delegate writes an assistant line per response, and each names its
    // model. Announcing every one persists dozens of identical declaration
    // rows per delegate — for a fan-out of twelve, hundreds a turn.
    const ledger = new ClaudeSessionCostLedger();
    const line = {
      type: 'assistant',
      parent_tool_use_id: AGENT_TOOL_USE_ID,
      message: {
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'still looking' }],
      },
    };

    const first = mapClaudeMessage(line, ledger);
    const second = mapClaudeMessage(line, ledger);

    expect(first.filter((e) => e.type === 'subagent_info')).toHaveLength(1);
    expect(second.filter((e) => e.type === 'subagent_info')).toHaveLength(0);
    // …and the delegate's own words still come through on both.
    expect(second.filter((e) => e.type === 'text')).toHaveLength(1);
  });

  it('says nothing about a sub-agent for a MAIN-THREAD line that names a model', () => {
    // The main thread's model is `turn_model`, off `system/init`. A
    // `subagent_info` here would invent a delegate keyed by nothing.
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'done.' }],
        },
      },
      new ClaudeSessionCostLedger(),
    );

    expect(events.filter((e) => e.type === 'subagent_info')).toHaveLength(0);
  });

  it('leaves a main-thread line unmarked, rather than stamping a null', () => {
    // `parent_tool_use_id: null` is what the CLI sends for the ordinary case,
    // and it must not become a key on every row in the database.
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'done.' }] },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(events).toEqual([{ type: 'text', text: 'done.' }]);
    expect(events[0]).not.toHaveProperty('parentToolUseId');
  });

  it('marks a sub-agent tool RESULT too, so a pair stays together', () => {
    // The result arrives on a `user` line, a different arm of the switch —
    // which is exactly why the stamp is applied around the switch and not
    // inside one case.
    expect(
      mapClaudeMessage(
        {
          type: 'user',
          parent_tool_use_id: AGENT_TOOL_USE_ID,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_01W3VZjfLcUZ1wi9o3NJD7sW',
                content: 'hello-from-subagent',
              },
            ],
          },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'tool_result',
        id: 'toolu_01W3VZjfLcUZ1wi9o3NJD7sW',
        name: null,
        result: 'hello-from-subagent',
        isError: false,
        parentToolUseId: AGENT_TOOL_USE_ID,
      },
    ]);
  });

  it('does NOT report a sub-agent request as the conversation’s context', () => {
    // THE METER BUG. A sub-agent's own request is a fresh, nearly empty
    // context; reporting it dropped the pill to a few thousand tokens and the
    // next main-thread line snapped it back. The usage below is deliberately
    // well-formed — dropping it is a decision about WHOSE context it is, not a
    // parse failure.
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        parent_tool_use_id: AGENT_TOOL_USE_ID,
        message: {
          content: [{ type: 'text', text: 'looking' }],
          usage: {
            input_tokens: 4,
            cache_creation_input_tokens: 11_000,
            cache_read_input_tokens: 0,
            output_tokens: 9,
          },
        },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(events.some((event) => event.type === 'context_progress')).toBe(
      false,
    );
    expect(events.some((event) => event.type === 'usage_progress')).toBe(false);
    expect(events).toEqual([
      {
        type: 'delegate_progress',
        delegateId: AGENT_TOOL_USE_ID,
        figures: {
          requests: 1,
          inputTokens: 4,
          outputTokens: 9,
          cacheReadTokens: 0,
          cacheCreationTokens: 11_000,
          contextTokens: 11_013,
          model: null,
          costUsd: null,
          estimatedCostUsd: null,
        },
        final: false,
        parentToolUseId: AGENT_TOOL_USE_ID,
      },
      { type: 'text', text: 'looking', parentToolUseId: AGENT_TOOL_USE_ID },
    ]);
  });

  it('treats an EMPTY parent id as the main thread, not as a sub-agent', () => {
    // `asString` passes `''` straight through, so without normalization this
    // line would suppress the context meter for the whole turn and persist as
    // a sub-agent row — while the renderer half of the twin rejects `''` and
    // calls the same row the main thread's. Two readings of one shape must not
    // disagree about who wrote it.
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        parent_tool_use_id: '',
        message: {
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 7, cache_read_input_tokens: 3 },
        },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(events).toContainEqual({
      type: 'context_progress',
      contextTokens: 10,
    });
    expect(events.every((event) => !('parentToolUseId' in event))).toBe(true);
  });

  it('still reports the MAIN thread’s context from the same shape', () => {
    // The companion to the test above: without this pair, gating the meter on
    // "has no parent" and gating it on "always off" look identical.
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'looking' }],
          usage: {
            input_tokens: 4,
            cache_creation_input_tokens: 11_000,
            cache_read_input_tokens: 0,
            output_tokens: 9,
          },
        },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(events).toContainEqual({
      type: 'context_progress',
      contextTokens: 4 + 11_000,
    });
  });
});

describe('mapClaudeStreamEvent', () => {
  it('lifts an assistant text increment', () => {
    expect(mapClaudeStreamEvent(textDelta('The sea'))).toEqual([
      { type: 'text_delta', text: 'The sea' },
    ]);
  });

  it('reports a tool argument stream as BYTES, never as its characters', () => {
    // The arguments themselves still never cross — a large Write's whole file
    // content would go over twice for no benefit, which is why this used to map
    // to nothing at all. What DOES cross is how much has arrived, because that
    // is the only evidence on screen that a model writing a host tool's payload
    // (an artifact is a whole HTML document) is still producing.
    const partial = '{"content":"…';
    const events = mapClaudeStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: partial },
      },
    });

    expect(events).toEqual([
      { type: 'tool_compose', tool: null, bytes: partial.length, done: false },
    ]);
    // The payload is not in there under any key.
    expect(JSON.stringify(events)).not.toContain('content');
  });

  it('opens a composition on a tool_use block, naming the tool', () => {
    // PROBE-VERIFIED on claude 2.1.x with `--include-partial-messages`: one
    // `content_block_start` carrying `{type:'tool_use', name}`. The NAME is the
    // load-bearing half — a client uses it to decide whether the wait is one
    // worth drawing a card skeleton for.
    expect(
      mapClaudeStreamEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'Write' },
        },
      }),
    ).toEqual([{ type: 'tool_compose', tool: 'Write', bytes: 0, done: false }]);
  });

  it('closes a composition on a block stop', () => {
    expect(
      mapClaudeStreamEvent({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      }),
    ).toEqual([{ type: 'tool_compose', tool: null, bytes: 0, done: true }]);
  });

  it('says nothing about a DELEGATE writing a call', () => {
    // The composition drives a placeholder in the MAIN thread's transcript, so
    // a sub-agent writing a file has no business putting one there. Excluded
    // here rather than downstream, where every consumer would have to remember.
    expect(
      mapClaudeStreamEvent({
        type: 'stream_event',
        parent_tool_use_id: 'toolu_parent',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'Write' },
        },
      }),
    ).toEqual([]);
  });

  it('streams the words of a thinking increment as reasoning', () => {
    expect(
      mapClaudeStreamEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'I need to check' },
        },
      }),
    ).toEqual([{ type: 'reasoning_delta', text: 'I need to check' }]);
  });

  it("says nothing about a DELEGATE's thinking", () => {
    expect(
      mapClaudeStreamEvent({
        type: 'stream_event',
        parent_tool_use_id: 'toolu_parent',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'the delegate thinks' },
        },
      }),
    ).toEqual([]);
  });

  it('ignores a thinking increment whose text the CLI withheld', () => {
    // Captured verbatim from a turn without `--thinking-display summarized`:
    // the body is empty and only a token estimate rides along.
    expect(
      mapClaudeStreamEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'thinking_delta',
            thinking: '',
            estimated_tokens: 150,
          },
        },
      }),
    ).toEqual([]);
  });

  it('ignores message framing the durable events already express', () => {
    for (const type of ['message_start', 'message_delta', 'message_stop']) {
      expect(
        mapClaudeStreamEvent({ type: 'stream_event', event: { type } }),
      ).toEqual([]);
    }
  });

  it('ignores a block start that is not a tool call', () => {
    // A text or thinking block opens the same way and has its own channel. A
    // start carrying no block at all is the malformed case, and answers the
    // same way rather than opening a nameless composition.
    for (const block of [{ type: 'text' }, { type: 'thinking' }, undefined]) {
      expect(
        mapClaudeStreamEvent({
          type: 'stream_event',
          // The CLI's own key, which is snake_case on the wire.
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: block,
          },
        }),
      ).toEqual([]);
    }
  });

  it('survives a malformed or empty envelope rather than failing the turn', () => {
    expect(mapClaudeStreamEvent({ type: 'stream_event' })).toEqual([]);
    expect(
      mapClaudeStreamEvent({ type: 'stream_event', event: 'nope' }),
    ).toEqual([]);
    expect(mapClaudeStreamEvent(textDelta(''))).toEqual([]);
  });
});

describe('mapClaudeMessage — context compaction', () => {
  it('reads the boundary the CLI emits after compacting', () => {
    // The metadata shape is the CLI's own schema (2.1.226):
    // `{ trigger: 'manual'|'auto', pre_tokens, post_tokens? }`.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'compact_boundary',
          session_id: 's1',
          compact_metadata: {
            trigger: 'auto',
            pre_tokens: 180_000,
            post_tokens: 32_000,
          },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'context_compacted',
        phase: 'finished',
        trigger: 'auto',
        preTokens: 180_000,
        postTokens: 32_000,
      },
    ]);
  });

  it('still reports the compaction when the metadata is absent or partial', () => {
    // The EVENT is the point — it is what explains the context meter dropping.
    // A boundary carrying no numbers must not be swallowed for lack of them.
    expect(
      mapClaudeMessage(
        { type: 'system', subtype: 'compact_boundary' },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'context_compacted',
        phase: 'finished',
        trigger: null,
        preTokens: null,
        postTokens: null,
      },
    ]);
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'manual' },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'context_compacted',
        phase: 'finished',
        trigger: 'manual',
        preTokens: null,
        postTokens: null,
      },
    ]);
  });

  it('reads the LIVE status line the CLI emits when compaction starts', () => {
    // Captured verbatim on 2.1.227 from a persistent stream-json session (see
    // CLAUDE_STATUS_SUBTYPE). Before this arm existed the line fell through the
    // subtype checks and returned [], so a 46-second compaction was announced as
    // nothing at all — the reported defect.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'status',
          status: 'compacting',
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'context_compacted',
        phase: 'started',
        // No counts: nothing has been dropped yet, and this line carries no
        // `compact_metadata` to invent them from.
        trigger: null,
        preTokens: null,
        postTokens: null,
      },
    ]);
  });

  it('says out loud when a compaction FAILED, with the reason the CLI gave', () => {
    // The terminating status line, captured verbatim. A silent failure leaves
    // the user waiting on a compaction that never happened, still at full
    // context — so unlike the success path this one earns a durable row.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'status',
          status: null,
          compact_result: 'failed',
          compact_error: 'Not enough messages to compact.',
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'notice',
        message:
          'the conversation was not compacted — Not enough messages to compact.',
      },
      // The second event is what takes down the present-tense phrase `started`
      // put up. Drop it and the live row keeps saying "compacting the
      // conversation" after the CLI has already refused — only the SUCCESS path
      // emits a boundary to supersede it.
      {
        type: 'context_compacted',
        phase: 'failed',
        trigger: null,
        preTokens: null,
        postTokens: null,
      },
    ]);
  });

  it('states the failure without a reason when the CLI gave none', () => {
    // The defensive branch: `compact_result:'failed'` with no `compact_error`.
    // Unpinned, a later "always append the reason" tidy-up ships a dangling
    // " — " or the word "undefined" in a user-facing notice.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'status',
          status: null,
          compact_result: 'failed',
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      { type: 'notice', message: 'the conversation was not compacted' },
      {
        type: 'context_compacted',
        phase: 'failed',
        trigger: null,
        preTokens: null,
        postTokens: null,
      },
    ]);
  });

  it('says nothing on the SUCCESS status line — the boundary and summary speak', () => {
    // Asserted because the obvious implementation announces both ends of the
    // status pair; a success notice would duplicate the boundary event AND the
    // summary row, giving three lines for one compaction.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'status',
          status: null,
          compact_result: 'success',
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('surfaces the CLI’s own compaction summary as a system row', () => {
    // Item 2. Captured verbatim: the summary arrives as a `user` line whose
    // `content` is a plain STRING, and the block loop that arm runs sees nothing
    // in a string — which is why the summary never reached the transcript.
    expect(
      mapClaudeMessage(
        {
          type: 'user',
          message: {
            role: 'user',
            content:
              'This session is being continued from a previous conversation…\n\nSummary: the user asked for numbers.',
          },
          isReplay: false,
          isSynthetic: true,
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'notice',
        message:
          'This session is being continued from a previous conversation…\n\nSummary: the user asked for numbers.',
        // The CLI wrote this, not the daemon. Without the marker the renderer
        // paints it in the failure chrome every other notice earns, so a relayed
        // summary reads as geniro reporting an error — and untrusted text could
        // then impersonate an application-level advisory.
        origin: 'cli',
      },
    ]);
  });

  it('leaves the daemon’s OWN notices unmarked, so their rows do not change', () => {
    // The other side of the `origin` contract: only CLI-authored text carries it.
    // A daemon advisory must stay exactly the shape it was, or every existing
    // notice's transcript row changes appearance with this diff.
    const events = mapClaudeMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content:
                'Tool permission request failed: AbortError: Stream closed',
            },
          ],
        },
        session_id: 's1',
      },
      new ClaudeSessionCostLedger(),
    );
    const notice = events.find((event) => event.type === 'notice');
    expect(notice).toBeDefined();
    expect(notice && 'origin' in notice).toBe(false);
  });

  it('ignores a REPLAYED synthetic line, so a resume cannot re-persist the summary', () => {
    // This fixture is deliberately `isSynthetic: true` AND `isReplay: true` —
    // the only shape that the replay half of the guard actually decides. With
    // `isSynthetic` omitted the test would pass with `!asBoolean(root.isReplay)`
    // deleted from production, since the synthetic check alone already fails it:
    // a false pin, and the duplicate of the real-user-message test below.
    //
    // What it protects: a resumed session replays the preserved segment, so
    // without the replay guard the summary would be lifted again and persisted
    // once more on every resume.
    expect(
      mapClaudeMessage(
        {
          type: 'user',
          message: {
            role: 'user',
            content:
              'This session is being continued from a previous conversation…',
          },
          isReplay: true,
          isSynthetic: true,
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('ignores the replayed `<local-command-stdout>` line beside the summary', () => {
    // The other half of the captured burst, verbatim. Distinct from the case
    // above: this one is a replay that carries NO `isSynthetic`, so it is barred
    // twice over — worth keeping as the shape actually observed on the wire.
    expect(
      mapClaudeMessage(
        {
          type: 'user',
          message: {
            role: 'user',
            content: '<local-command-stdout>Compacted </local-command-stdout>',
          },
          isReplay: true,
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('reads the echo of a message the CLI has TAKEN as that acknowledgement', () => {
    // Captured on 2.1.270 with `--replay-user-messages`: what tells a follow-up
    // answered inside the turn from one still waiting for a result of its own.
    // Only the text blocks make up `text` — the images beside them are the
    // same message, and matching is done on its words.
    expect(
      mapClaudeMessage(
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', data: 'AAAA' } },
              { type: 'text', text: 'Now reply with the single word BANANA.' },
            ],
          },
          isReplay: true,
          session_id: 's1',
          uuid: '0b62ea5d-cf8b-41fe-943f-ed30d77d2b65',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'user_message_consumed',
        text: 'Now reply with the single word BANANA.',
      },
    ]);
  });

  it('does not read a message the CLI has NOT echoed as taken', () => {
    // The same line without `isReplay` — its text blocks are the user's own
    // words in a stored conversation, never an acknowledgement.
    expect(
      mapClaudeMessage(
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Now reply with BANANA.' }],
          },
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('never lifts a REAL user message into a system row', () => {
    // The guard that keeps this from surfacing the user's own words back at
    // them: a genuine user line is not synthetic. Drop the isSynthetic check and
    // this fails.
    expect(
      mapClaudeMessage(
        {
          type: 'user',
          message: { role: 'user', content: 'please fix the login bug' },
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('leaves the other system subtypes alone', () => {
    // The compaction arm is keyed on its own subtype, so `init` must still map
    // to the session/commands/model events it always did.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'init',
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'session', sessionId: 's1' }]);
  });
});

describe('mapClaudeMessage — background tasks', () => {
  // Every line below is captured verbatim from a 2.1.231 turn told to launch a
  // delegate and NOT wait for it. What makes them load-bearing: that same run
  // printed TWO `result` lines — the user's answer, and then a turn claude ran
  // on its own accord once a task reported (`origin:{kind:"task-notification"}`)
  // — so a turn settled on the first `result` is settled mid-work.
  it('opens a unit of background work on task_started', () => {
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'ad83f0a35d8a3dfc9',
          tool_use_id: 'toolu_01LWpVdfmqPnsMuftxq7YiAA',
          description: 'Delayed sleep echo task',
          subagent_type: 'general-purpose',
          task_type: 'local_agent',
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'ad83f0a35d8a3dfc9',
        phase: 'started',
        // A DELEGATE, and the call that launched it — what lets the transcript
        // keep that sub-agent's block open past the instant return.
        unit: 'agent',
        toolCallId: 'toolu_01LWpVdfmqPnsMuftxq7YiAA',
      },
    ]);
  });

  it('credits a RESUMED agent’s work to the call that first launched it', () => {
    // claude keys an agent's task by its agentId, so `SendMessage` resuming it
    // re-registers the SAME task id — under the SendMessage call. The resumed
    // agent's own rows stay parented to the ORIGINAL Agent call, so its open
    // and close must land there too, or an agent that failed at launch and was
    // resumed keeps that first failure as its block's only close.
    const ledger = new ClaudeSessionCostLedger();
    const started = (toolUseId: string) =>
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'aef8e0b14f76cbb5a',
          tool_use_id: toolUseId,
          description: 'Re-review: bugs',
          task_type: 'local_agent',
          session_id: 's1',
        },
        ledger,
      );

    expect(started('toolu_launch')[0]).toMatchObject({
      toolCallId: 'toolu_launch',
    });
    expect(started('toolu_sendmessage')[0]).toMatchObject({
      unit: 'agent',
      toolCallId: 'toolu_launch',
    });
  });

  it('does not call a delegate’s own shell command a delegate', () => {
    // Probed 2026-08-17 on 2.1.232: ONE Task call produced two `task_started`
    // lines — the delegate, and the `sleep` that delegate then ran. Both are
    // background work the turn must outlive; reading the second as a sub-agent
    // would report two where the user launched one.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'bx0yxbert',
          owned_by_subagent: true,
          tool_use_id: 'toolu_01JGZBzkWjmavxf5ztmdNu83',
          description: 'Sleep for 20 seconds',
          task_type: 'local_bash',
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'bx0yxbert',
        phase: 'started',
        unit: 'other',
        toolCallId: 'toolu_01JGZBzkWjmavxf5ztmdNu83',
        // …and says whose it is, so the session keeps it off the main
        // thread's terminals.
        ownedByDelegate: true,
      },
    ]);
  });

  it('marks a unit the launching call BLOCKS on as foreground', () => {
    // The 2.1.280 schema: `is_backgrounded` is false when the task was
    // registered "in the foreground with the spawning tool call blocking on it"
    // — a sync sub-agent. Read as background, it put `subagentsOut` above zero
    // and the composer sent a message straight into a turn that could not read
    // it until the sub-agent returned.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'a1fore',
          tool_use_id: 'toolu_fore',
          description: 'Analyze unsorted-file lifecycle',
          subagent_type: 'Explore',
          task_type: 'local_agent',
          is_backgrounded: false,
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'a1fore',
        phase: 'started',
        unit: 'agent',
        toolCallId: 'toolu_fore',
        foreground: true,
      },
    ]);
  });

  it('leaves a unit background when the CLI says so or says nothing', () => {
    for (const isBackgrounded of [true, undefined]) {
      const [event] = mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'a1back',
          tool_use_id: 'toolu_back',
          task_type: 'local_agent',
          is_backgrounded: isBackgrounded,
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      );
      expect(event).not.toHaveProperty('foreground');
    }
  });

  it('reports a foreground unit moved to the background, never as a settle', () => {
    // "A later move to the background arrives as task_updated
    // patch.is_backgrounded" — the CLI's auto-background timer, or a queued
    // message it moved the work aside to deliver.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_updated',
          task_id: 'a1fore',
          patch: { is_backgrounded: true },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'a1fore',
        phase: 'backgrounded',
        unit: 'other',
        toolCallId: null,
      },
    ]);
  });

  it('reads a patch that also ENDS the unit as a settle alone', () => {
    const events = mapClaudeMessage(
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'a1fore',
        patch: { status: 'completed', is_backgrounded: true },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ phase: 'settled', outcome: 'completed' });
  });

  it('closes it from EITHER terminal channel, which spell the status differently', () => {
    // `task_updated` carries it in a patch, `task_notification` at the root —
    // and the same task was reported `killed` by one and `stopped` by the other
    // in one measured run, which is why neither spelling is trusted alone.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_updated',
          task_id: 'ad83f0a35d8a3dfc9',
          patch: { status: 'completed', end_time: 1786635753021 },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'ad83f0a35d8a3dfc9',
        phase: 'settled',
        // A settle states neither: the consumer matches it against what the
        // 'started' recorded, which is the only line that says what a unit is.
        unit: 'other',
        toolCallId: null,
        // …but it DOES state the outcome, and translating it here is what keeps
        // this CLI's two spellings for one ending out of every consumer.
        outcome: 'completed',
      },
    ]);
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'bblzv799n',
          status: 'stopped',
          tool_use_id: 'toolu_x',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'bblzv799n',
        phase: 'settled',
        unit: 'other',
        // This channel DOES name the call; the other does not, which is why the
        // consumer never depends on either naming it.
        toolCallId: 'toolu_x',
        outcome: 'stopped',
      },
    ]);
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_updated',
          task_id: 'bblzv799n',
          patch: { status: 'killed', end_time: 1786635772095 },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'bblzv799n',
        phase: 'settled',
        unit: 'other',
        toolCallId: null,
        // The SAME task the notification above called `stopped`. Both spellings
        // collapse to one outcome here, which is the whole reason the mapping
        // lives in this adapter rather than at each consumer.
        outcome: 'stopped',
      },
    ]);
  });

  it('carries what the unit SPENT off the notification that settles it', () => {
    // The figures behind "in front of each agent i wanna see amount of
    // tokens/costs/time". Probed on 2.1.237 against a real delegation: the
    // notification is the only channel that states them, and it states exactly
    // these three keys.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'a71b21049ece3b941',
          status: 'completed',
          tool_use_id: 'toolu_01J4EGWm9tNfE1hQGUYw7TSj',
          usage: { total_tokens: 26124, tool_uses: 0, duration_ms: 2029 },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'a71b21049ece3b941',
        phase: 'settled',
        unit: 'other',
        toolCallId: 'toolu_01J4EGWm9tNfE1hQGUYw7TSj',
        outcome: 'completed',
        usage: { tokens: 26124, toolUses: 0, durationMs: 2029 },
      },
    ]);
  });

  it('says NOTHING about spend on a settle whose channel carries none', () => {
    // `task_updated` is an id and a status patch, and this daemon maps both
    // channels on purpose so a CLI dropping one still settles. An absent block
    // therefore has to claim nothing rather than report zeros — the consumer
    // merges announcements by preferring the last non-null field, and a record
    // of nulls arriving second is indistinguishable from a measurement.
    const [event] = mapClaudeMessage(
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'ad83f0a35d8a3dfc9',
        patch: { status: 'completed' },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(event).toMatchObject({ type: 'background_work', phase: 'settled' });
    expect(
      (event as Extract<AgentEvent, { type: 'background_work' }>).usage,
    ).toBeUndefined();
  });

  it('leaves the work OPEN for a status it does not recognise', () => {
    // The direction is the point: an unrecognised status delays a settle
    // (bounded by the turn's silence deadline) rather than declaring work
    // finished while it is still running, which is the whole defect.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_updated',
          task_id: 't1',
          patch: { status: 'reticulating_splines' },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
    // `task_progress` is the in-flight ping and carries no status at all.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_progress',
          task_id: 't1',
          description: 'Running sleep 40 && echo delegate-finished-late',
          last_tool_name: 'Bash',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('reports nothing for a task line carrying no id', () => {
    // Identity is the whole content of the event — the set is keyed by it — so
    // an id-less line is unusable rather than a unit of anonymous work.
    expect(
      mapClaudeMessage(
        { type: 'system', subtype: 'task_started' },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_notification',
          status: 'completed',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });
});

describe('mapClaudeThinkingTokens', () => {
  it('reads the running reasoning total off the telemetry line', () => {
    // Captured verbatim from a live turn.
    expect(
      mapClaudeThinkingTokens({
        type: 'system',
        subtype: 'thinking_tokens',
        estimated_tokens: 300,
        estimated_tokens_delta: 100,
      }),
    ).toEqual([{ type: 'thinking_progress', tokens: 300 }]);
  });

  it('reports nothing when there is no usable total', () => {
    expect(mapClaudeThinkingTokens({ type: 'system' })).toEqual([]);
    expect(mapClaudeThinkingTokens({ estimated_tokens: 0 })).toEqual([]);
    expect(mapClaudeThinkingTokens({ estimated_tokens: 'lots' })).toEqual([]);
  });
});

describe('mapClaudeMessage — what a failed turn reports about itself', () => {
  it('carries the provider’s own account of an API failure', () => {
    // Transcribed from a live 2.1.234 failure (`--model
    // definitely-not-a-model`), fields verbatim. Every one of these was on the
    // wire and dropped: the row reached the user as one sentence with nothing
    // in it anyone could look up.
    expect(
      mapClaudeMessage(
        {
          type: 'result',
          is_error: true,
          terminal_reason: 'api_error',
          api_error_status: 404,
          session_id: '99691942-8ca6-415d-a4c5-975ed3aa4b73',
          duration_ms: 986,
          subtype: 'success',
          result: 'There’s an issue with the selected model.',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'error',
        message: 'There’s an issue with the selected model.',
        detail: {
          // `terminal_reason`, NOT `subtype`: the line above says
          // `"subtype":"success"` on a failure, which is exactly why appending
          // it to the sentence was misleading.
          code: 'api_error',
          httpStatus: 404,
          sessionId: '99691942-8ca6-415d-a4c5-975ed3aa4b73',
          durationMs: 986,
        },
      },
    ]);
  });

  it('tells a turn the CLI ABORTED from one it rejected', () => {
    // The reported failure, verbatim from the screenshot: no sentence of its
    // own, so the row read `claude run failed (aborted_streaming)` — machine
    // noise naming neither what happened nor what to do. The CLI's own source
    // puts this reason in an abort family it explicitly excludes from its error
    // family, and its own consumer logs it at ordinary level.
    const [event] = mapClaudeMessage(
      {
        type: 'result',
        is_error: true,
        terminal_reason: 'aborted_streaming',
        session_id: 'a2a059b3-3212-4fe5-b5a8-a08cd117fd0a',
        duration_ms: 24322,
        subtype: 'success',
      },
      new ClaudeSessionCostLedger(),
    );

    expect(event).toMatchObject({ type: 'error' });
    const message = (event as { message: string }).message;
    expect(message).not.toContain('claude run failed');
    expect(message).toContain('stopped this turn before it finished');
    // The code is NOT dropped — it moves into the facts table, which is where a
    // bug report reads it from.
    expect(event).toMatchObject({ detail: { code: 'aborted_streaming' } });
  });

  it('keeps the CLI’s own sentence even when the turn was aborted', () => {
    // Same rule as every other failure here: geniro speaks only where the CLI
    // said nothing.
    expect(
      mapClaudeMessage(
        {
          type: 'result',
          is_error: true,
          terminal_reason: 'aborted_tools',
          result: 'Streaming stopped while a tool was running.',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'error',
        message: 'Streaming stopped while a tool was running.',
        detail: { code: 'aborted_tools' },
      },
    ]);
  });

  it('says nothing extra when the CLI reported nothing extra', () => {
    // A CLI that carries none of it must produce the row it always produced —
    // an empty `detail` object would put a blank table under every failure.
    expect(
      mapClaudeMessage(
        { type: 'result', is_error: true, result: 'it broke' },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'error', message: 'it broke' }]);
  });
});

describe('an api-error assistant line', () => {
  /** The shape read off the author's own session store — see the predicate. */
  const apiErrorLine = (
    code: string,
    text: string,
  ): Record<string, unknown> => ({
    type: 'assistant',
    error: code,
    request_id: 'req_011CeHzsz3E8dXUXzFMFsqZu',
    is_api_error_message: true,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 41234, output_tokens: 12 },
    },
  });

  it('is the daemon reporting a failed request, never the agent talking', () => {
    expect(
      mapClaudeMessage(
        apiErrorLine(
          'server_error',
          'API Error: Connection closed mid-response. The response above may be incomplete.',
        ),
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'notice',
        message:
          'API Error: Connection closed mid-response. The response above may be incomplete.',
        severity: 'warning',
        caption: 'api error',
      },
    ]);
  });

  it('never relays it as CLI-authored text, which picks the quiet chrome', () => {
    // `origin: 'cli'` is for text the AGENT wrote, and the renderer drops a
    // severity beside it — so stamping it here would put the report back in
    // prose chrome, one step from the assistant bubble this replaced.
    const [notice] = mapClaudeMessage(
      apiErrorLine('rate_limit', "You've hit your weekly limit · resets 4pm"),
      new ClaudeSessionCostLedger(),
    );

    expect(notice).toEqual({
      type: 'notice',
      message: "You've hit your weekly limit · resets 4pm",
      severity: 'warning',
      caption: 'api error',
    });
    expect(notice).not.toHaveProperty('origin');
  });

  it('publishes no window reading off a synthetic failure line', () => {
    // The usage on it belongs to a request that FAILED. Lifting it would move
    // the composer's meter on the strength of a request that produced nothing.
    expect(
      mapClaudeMessage(
        apiErrorLine('server_error', 'Request timed out'),
        new ClaudeSessionCostLedger(),
      ).filter((event) => event.type === 'context_progress'),
    ).toEqual([]);
  });

  it('leaves an ORDINARY assistant line alone', () => {
    // The flag is the whole discriminator: the envelope is identical, and
    // `request_id` rides ordinary lines too.
    expect(
      mapClaudeMessage(
        {
          type: 'assistant',
          request_id: 'req_011CeHzsz3E8dXUXzFMFsqZu',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'API Error: is what I would say' }],
          },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'text', text: 'API Error: is what I would say' }]);
  });
});

describe('mapClaudeMessage — dynamic workflows', () => {
  // Every line below is captured verbatim from a live 2.1.251 workflow run
  // (`-p --output-format stream-json --verbose`, a two-agent script) and
  // trimmed to the fields the mapper reads. See
  // `CLAUDE_TASK_PROGRESS_SUBTYPE` for the full capture.
  const ledger = (): ClaudeSessionCostLedger => new ClaudeSessionCostLedger();

  it('names the workflow on its launch line, where the name only ever appears', () => {
    // The progress lines after it carry `summary` (the description) and never
    // `workflow_name`, so a card built from those alone could say what the
    // workflow does and never what it IS.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'w23o3h707',
          tool_use_id: 'toolu_01F7',
          task_type: 'local_workflow',
          workflow_name: 'probe-run',
          description: 'Two trivial agents, for a wire probe',
          prompt: 'export const meta = …',
        },
        ledger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'w23o3h707',
        phase: 'started',
        // NOT a delegate: `local_workflow` is neither `local_agent` nor a
        // shell, and announcing it as one would put a phantom sub-agent block
        // in the transcript beside the workflow's own card.
        unit: 'other',
        toolCallId: 'toolu_01F7',
      },
      {
        type: 'workflow_info',
        id: 'toolu_01F7',
        name: 'probe-run',
        title: 'Two trivial agents, for a wire probe',
        activity: null,
        tokens: null,
        toolUses: null,
        durationMs: null,
        agents: null,
      },
    ]);
  });

  it('reads the roster and the running bill off a progress line', () => {
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_progress',
          task_id: 'w23o3h707',
          tool_use_id: 'toolu_01F7',
          description: 'Probe: probe-1',
          usage: { total_tokens: 13779, tool_uses: 2, duration_ms: 1328 },
          summary: 'Two trivial agents, for a wire probe',
          workflow_progress: [
            { type: 'workflow_phase', index: 1, title: 'Probe' },
            {
              type: 'workflow_agent',
              index: 1,
              label: 'probe-1',
              phaseTitle: 'Probe',
              model: 'claude-haiku-4-5-20251001',
              state: 'done',
              tokens: 13779,
              toolCalls: 2,
              durationMs: 1303,
              resultPreview: 'ok1',
            },
            {
              type: 'workflow_agent',
              index: 2,
              label: 'probe-2',
              phaseTitle: 'Probe',
              model: 'claude-haiku-4-5-20251001',
              state: 'start',
            },
          ],
        },
        ledger(),
      ),
    ).toEqual([
      {
        type: 'workflow_info',
        id: 'toolu_01F7',
        // A progress line never carries the name — only the anchor does.
        name: null,
        title: 'Two trivial agents, for a wire probe',
        activity: 'Probe: probe-1',
        tokens: 13779,
        toolUses: 2,
        durationMs: 1328,
        agents: [
          {
            index: 1,
            label: 'probe-1',
            phase: 'Probe',
            state: 'done',
            model: 'claude-haiku-4-5-20251001',
            tokens: 13779,
            toolCalls: 2,
            durationMs: 1303,
            error: null,
          },
          {
            index: 2,
            label: 'probe-2',
            phase: 'Probe',
            // `start` is an agent that is OUT, not a fourth state anything
            // downstream has to learn.
            state: 'running',
            model: 'claude-haiku-4-5-20251001',
            tokens: null,
            toolCalls: null,
            durationMs: null,
            error: null,
          },
        ],
      },
    ]);
    // The `workflow_phase` entry is dropped: every agent row already repeats
    // its title, so keeping it would mean a second list to join against for a
    // string already in hand.
  });

  it('ignores a DELEGATE’s progress line, which rides the same subtype', () => {
    // The roster is the only discriminator on the wire — a delegate's progress
    // names a `subagent_type` and carries none. Without this the transcript
    // would grow a workflow card for every Task call.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_progress',
          task_id: 'ad83f0a35d8a3dfc9',
          tool_use_id: 'toolu_01LW',
          description: 'Delayed sleep echo task',
          subagent_type: 'general-purpose',
          usage: { total_tokens: 26124, tool_uses: 0, duration_ms: 2029 },
        },
        ledger(),
      ),
    ).toEqual([]);
  });

  it('keeps an unrecognised agent state OUT working rather than finished', () => {
    const [event] = mapClaudeMessage(
      {
        type: 'system',
        subtype: 'task_progress',
        tool_use_id: 'toolu_01F7',
        workflow_progress: [
          { type: 'workflow_agent', index: 1, state: 'quantum-superposed' },
        ],
      },
      ledger(),
    );
    // Guessing `done` would show a workflow as complete while it works, and the
    // roster is where the card's "3 running" comes from.
    expect(event).toMatchObject({
      type: 'workflow_info',
      agents: [{ index: 1, state: 'running' }],
    });
  });

  it('drops a roster row that names no agent index', () => {
    // The index is the CLI's own merge key and the roster's identity; a row
    // without one cannot be placed, ordered, or told apart from its neighbour.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_progress',
          tool_use_id: 'toolu_01F7',
          workflow_progress: [{ type: 'workflow_agent', state: 'done' }],
        },
        ledger(),
      ),
    ).toEqual([expect.objectContaining({ type: 'workflow_info', agents: [] })]);
  });
});

/** The catalog's anthropic prices — what the cost ledgers below price with. */
const LIST_PRICES = catalogClaudePrices();

describe('mapClaudeMessage — what a delegate spent, and what it cost', () => {
  // Money priced from tokens needs list prices: the catalog's, through the
  // daemon's own parser.

  // Both lines below are verbatim from one 2.1.251 turn: a delegate told to
  // answer `OK` and use no tools, and the `result` that closed the turn. They
  // are the only two lines in the whole stream that bear on a delegate's price
  // — probed across every channel, nothing else says anything about money.
  const delegateReturn = {
    type: 'user',
    session_id: 'e8ff1386-3c9b-4aa3-b507-c82715de4346',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_016irjy3GNmGTa2RzaFCy6HM',
          content: [{ type: 'text', text: 'OK' }],
        },
      ],
    },
    tool_use_result: {
      status: 'completed',
      agentId: 'a8ff521205ae8b053',
      agentType: 'general-purpose',
      resolvedModel: 'claude-opus-5[1m]',
      totalDurationMs: 1761,
      totalTokens: 29_388,
      totalToolUseCount: 0,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 29_382,
        cache_read_input_tokens: 0,
        output_tokens: 4,
      },
    },
  };

  const turnResult = {
    type: 'result',
    subtype: 'success',
    session_id: 'e8ff1386-3c9b-4aa3-b507-c82715de4346',
    result: 'DONE',
    duration_ms: 21_000,
    total_cost_usd: 0.44389499999999993,
    usage: { input_tokens: 6, output_tokens: 313 },
    modelUsage: {
      'claude-opus-5[1m]': {
        inputTokens: 6,
        outputTokens: 313,
        cacheReadInputTokens: 59_805,
        cacheCreationInputTokens: 51_632,
        costUSD: 0.44389499999999993,
        contextWindow: 1_000_000,
      },
    },
  };

  it('counts the closing request as ONE of the delegate’s requests, never as its whole spend', () => {
    const events = mapClaudeMessage(
      delegateReturn,
      new ClaudeSessionCostLedger(LIST_PRICES),
    );

    // `usage` and `totalTokens` on this line are the LAST request's only, so
    // the declaration states none of them as the delegate's spend.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'toolu_016irjy3GNmGTa2RzaFCy6HM',
        kind: 'general-purpose',
        model: 'claude-opus-5[1m]',
        durationMs: 1761,
        tokens: null,
        toolUses: 0,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'delegate_progress',
        delegateId: 'toolu_016irjy3GNmGTa2RzaFCy6HM',
        final: false,
        figures: expect.objectContaining({
          requests: 1,
          inputTokens: 2,
          outputTokens: 4,
          cacheReadTokens: 0,
          cacheCreationTokens: 29_382,
          contextTokens: 29_388,
          model: 'claude-opus-5[1m]',
          costUsd: null,
        }),
      }),
    );
  });

  it('does not price a delegate that has not ENDED, whatever result line arrives', () => {
    const ledger = new ClaudeSessionCostLedger(LIST_PRICES);
    mapClaudeMessage(delegateReturn, ledger);

    const events = mapClaudeMessage(turnResult, ledger);

    expect(
      events.some(
        (event) =>
          (event.type === 'subagent_info' && event.costUsd !== null) ||
          event.type === 'delegate_progress',
      ),
    ).toBe(false);
  });

  it('still closes the launching call, which is the row the block hangs on', () => {
    const events = mapClaudeMessage(
      delegateReturn,
      new ClaudeSessionCostLedger(LIST_PRICES),
    );

    expect(events[0]).toEqual(
      expect.objectContaining({
        type: 'tool_result',
        id: 'toolu_016irjy3GNmGTa2RzaFCy6HM',
      }),
    );
  });

  it('prices the delegate on the result line, calibrated against that turn', async () => {
    const ledger = new ClaudeSessionCostLedger(LIST_PRICES);
    mapClaudeMessage(delegateReturn, ledger);
    await endDelegate(ledger, delegateReturn);

    const events = mapClaudeMessage(turnResult, ledger);

    const priced = events.find(
      (event) => event.type === 'subagent_info' && event.costUsd !== null,
    );
    expect(priced).toEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'toolu_016irjy3GNmGTa2RzaFCy6HM',
        costUsd: expect.closeTo(0.2263, 4),
      }),
    );
    // The turn's own completion is unaffected — the delegate's price is an
    // extra row about the delegate, never a change to the turn's accounting.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'turn_complete' }),
    );
  });

  it('says nothing about money when no delegate returned in the turn', () => {
    const events = mapClaudeMessage(
      turnResult,
      new ClaudeSessionCostLedger(LIST_PRICES),
    );

    expect(events.some((event) => event.type === 'subagent_info')).toBe(false);
  });

  it('prices a delegate on ITS OWN session’s result under fan-out, never a neighbour’s', async () => {
    // One adapter — and so one ledger — maps every claude process a team
    // fans out to. Session B's `result` landing between A's delegate return
    // and A's own `result` must not price A's delegate into B's stream.
    const ledger = new ClaudeSessionCostLedger(LIST_PRICES);
    mapClaudeMessage(delegateReturn, ledger);
    await endDelegate(ledger, delegateReturn);

    const neighbour = mapClaudeMessage(
      { ...turnResult, session_id: 'another-process-session' },
      ledger,
    );
    expect(neighbour.some((event) => event.type === 'subagent_info')).toBe(
      false,
    );

    const own = mapClaudeMessage(turnResult, ledger);
    expect(own).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'toolu_016irjy3GNmGTa2RzaFCy6HM',
        costUsd: expect.closeTo(0.2263, 4),
      }),
    );
  });

  it('refuses to bill a line that closes two calls at once', () => {
    // `tool_use_result` rides the LINE and names no call of its own, so a line
    // closing two calls cannot say which one it describes. Charging both would
    // double a delegate's tokens and its price.
    const events = mapClaudeMessage(
      {
        ...delegateReturn,
        message: {
          role: 'user',
          content: [
            ...delegateReturn.message.content,
            {
              type: 'tool_result',
              tool_use_id: 'toolu_other',
              content: [{ type: 'text', text: 'unrelated' }],
            },
          ],
        },
      },
      new ClaudeSessionCostLedger(LIST_PRICES),
    );

    expect(events.filter((event) => event.type === 'tool_result')).toHaveLength(
      2,
    );
    expect(events.some((event) => event.type === 'subagent_info')).toBe(false);
  });

  it('does not call an ordinary tool’s rich result a sub-agent', () => {
    // The same root key carries other tools' structured results. `agentId` is
    // the discriminator; without it a file read would be announced as a
    // delegate, and the transcript would grow a sub-agent block per tool call.
    const events = mapClaudeMessage(
      {
        ...delegateReturn,
        tool_use_result: {
          filenames: ['a.ts', 'b.ts'],
          numFiles: 2,
          usage: { input_tokens: 5, output_tokens: 5 },
        },
      },
      new ClaudeSessionCostLedger(LIST_PRICES),
    );

    expect(events.some((event) => event.type === 'subagent_info')).toBe(false);
  });

  it('prices a delegate whose turn then FAILED — it still ran and still billed', async () => {
    const ledger = new ClaudeSessionCostLedger(LIST_PRICES);
    mapClaudeMessage(delegateReturn, ledger);
    await endDelegate(ledger, delegateReturn);

    const events = mapClaudeMessage(
      { ...turnResult, is_error: true, terminal_reason: 'api_error' },
      ledger,
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        costUsd: expect.closeTo(0.2263, 4),
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
  });
});
