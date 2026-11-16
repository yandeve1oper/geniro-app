import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tempDir } from '../../__tests__/temp-dir';
import type { AgentEvent, AgentTurnInput } from '../adapter.types';
import type {
  AcpConversationReading,
  AcpDelegateProtocol,
  AcpSessionOptions,
  AcpTurnOptions,
} from './acp-driver';
import {
  CUT_OFF_TOOL_RESULT,
  HOST_CONTEXT_NOTE,
  HOST_CONTEXT_TAG,
  INTERRUPT_ACK_DEADLINE_MS,
  INTERRUPTED_TOOL_RESULT,
  permissionAnswerOptionId,
  REFUSED_TOOL_RESULT,
  selectPermissionOption,
} from './acp-driver';
import { AcpSession } from './acp-session';

/**
 * The flat options these specs are written against — the two halves the driver
 * now takes separately, spelled as one bag so a case can override a session
 * fact and a turn fact side by side.
 *
 * `harness` splits it, and the SPLIT is the point rather than a convenience:
 * `turnOptions` re-derives the per-turn half from whatever input the session is
 * opening a turn with, which is exactly what an adapter must do.
 */
type AcpDriverOptions = Omit<AcpSessionOptions, 'turnOptions'> & AcpTurnOptions;

/** The turn's instructions as the prompt actually carries them. */
function hostBlock(instructions: string): string {
  return `<${HOST_CONTEXT_TAG}>\n\n${HOST_CONTEXT_NOTE}\n\n${instructions}\n\n</${HOST_CONTEXT_TAG}>`;
}

interface Harness {
  driver: AcpSession;
  /** Every frame the driver wrote to stdin, parsed. */
  sent: Record<string, unknown>[];
  /** Events the driver emitted through `io.emit` (the onStdinReady channel). */
  emitted: AgentEvent[];
  /** Feed one parsed stdout line; returns the events it produced. */
  feed: (message: unknown) => AgentEvent[];
  /** The frame for the Nth request the driver sent, by method name. */
  sentMethod: (method: string) => Record<string, unknown> | undefined;
  /** Every frame for one method, oldest first. */
  sentAll: (method: string) => Record<string, unknown>[];
  /**
   * Open a LATER turn on the same live session, as `startTurn` does — with its
   * OWN per-turn options, since that is exactly what a real adapter's factory
   * re-derives and what a spec about a second turn needs to vary.
   */
  openTurn: (
    input: AgentTurnInput,
    turnOverrides?: Partial<AcpTurnOptions>,
  ) => void;
}

const UNWATCHABLE_DELEGATE: AcpDelegateProtocol = {
  method: 'test/task',
  launchMarker: { key: '_toolName', value: 'task' },
  read: () => null,
  resultIsBookkeeping: true,
  stepsUnavailableReason: null,
};

const BASE_INPUT: AgentTurnInput = { prompt: 'do the thing', cwd: '/work' };

function harness(
  overrides: Partial<AcpDriverOptions> = {},
  // A THUNK as well as a flag, so a spec can let the handshake through and then
  // close the pipe under one later frame — which is the only way to reach the
  // "this write did not land" branch of a driver that writes for itself.
  writeResult: boolean | (() => boolean) = true,
  // What the WRITER says is in the way, which is the only honest source for it
  // — see `TurnIo.writeObstacle`. Undefined models a caller that supplies none,
  // which is what a driver must be able to log against without inventing one.
  writeObstacle?: () => string | null,
): Harness {
  const sent: Record<string, unknown>[] = [];
  const emitted: AgentEvent[] = [];
  /** Per-turn overrides for the NEXT turn the harness opens; see `openTurn`. */
  let nextTurn: Partial<AcpTurnOptions> = {};
  const input = overrides.input ?? BASE_INPUT;
  const merged: AcpDriverOptions = {
    input: BASE_INPUT,
    clientName: 'geniro',
    clientVersion: '1.2.3',
    autoDecide: () => null,
    // A STUB, not a mirror of AgentAdapter.composeSystemPrompt: these specs
    // pin what the DRIVER does with the callback's result — that it prepends
    // it, and that it passes the right `granted` — never how the text is
    // composed. The real join (host preamble, custom instructions, role, call
    // surface) is `turnInstructionParts`, covered directly by
    // `utils/agent-instructions.spec.ts` and end-to-end through the real
    // adapter in `cursor-acp.adapter.spec.ts`.
    composeSystemPrompt: (granted) =>
      [input.systemPrompt, granted ? input.callSurfacePrompt : null]
        .filter((part): part is string => Boolean(part))
        .join('\n\n'),
    ...overrides,
  };
  const driver = new AcpSession(
    {
      ...merged,
      // Every per-turn value re-derived from the input the session hands over,
      // which is what an adapter's own factory does — so a spec that opens a
      // second turn gets that turn's prompt and attachments rather than the
      // first turn's.
      turnOptions: (turnInput) => ({
        ...merged,
        ...nextTurn,
        input: turnInput,
      }),
    },
    merged.input,
  );
  driver.onStdinReady({
    write: (payload) => {
      if (!(typeof writeResult === 'function' ? writeResult() : writeResult)) {
        return false;
      }
      sent.push(JSON.parse(payload) as Record<string, unknown>);
      return true;
    },
    emit: (event) => emitted.push(event),
    writeObstacle,
  });
  const io = {
    write: (payload: string) => {
      if (!(typeof writeResult === 'function' ? writeResult() : writeResult)) {
        return false;
      }
      sent.push(JSON.parse(payload) as Record<string, unknown>);
      return true;
    },
    emit: (event: AgentEvent) => emitted.push(event),
    writeObstacle,
  };
  return {
    driver,
    sent,
    emitted,
    feed: (message) => driver.onMessage(message),
    sentMethod: (method) => sent.find((frame) => frame.method === method),
    sentAll: (method) => sent.filter((frame) => frame.method === method),
    openTurn: (turnInput, turnOverrides) => {
      nextTurn = turnOverrides ?? {};
      driver.openTurn(io, turnInput);
    },
  };
}

/** The reply the agent sends to `initialize`, with the capabilities under test. */
function initializeReply(
  id: number,
  capabilities: { loadSession?: boolean; http?: boolean; image?: boolean } = {},
): unknown {
  return {
    id,
    result: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: capabilities.loadSession ?? false,
        mcpCapabilities: { http: capabilities.http ?? false },
        promptCapabilities: { image: capabilities.image ?? false },
      },
    },
  };
}

describe('AcpSession handshake', () => {
  it('opens with initialize, declining the fs and terminal capabilities', () => {
    const h = harness();
    const init = h.sentMethod('initialize');
    expect(init).toBeDefined();
    expect(init?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'geniro', version: '1.2.3' },
    });
  });

  it('creates a session and prompts it, emitting the session id', () => {
    const h = harness();
    expect(h.feed(initializeReply(1))).toEqual([]);
    const newSession = h.sentMethod('session/new');
    expect(newSession?.params).toEqual({ cwd: '/work', mcpServers: [] });

    const events = h.feed({ id: 2, result: { sessionId: 'sess-1' } });
    expect(events).toEqual([{ type: 'session', sessionId: 'sess-1' }]);
    expect(h.sentMethod('session/prompt')?.params).toEqual({
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'do the thing' }],
    });
  });

  it('reports a failure when the agent returns a session with no id', () => {
    const h = harness();
    h.feed(initializeReply(1));
    expect(h.feed({ id: 2, result: {} })).toEqual([
      {
        type: 'error',
        message: 'acp session failed: the agent returned no session id',
      },
    ]);
    expect(h.sentMethod('session/prompt')).toBeUndefined();
  });

  it('surfaces an initialize error as a turn error', () => {
    const h = harness();
    expect(h.feed({ id: 1, error: { code: -32603, message: 'boom' } })).toEqual(
      [{ type: 'error', message: 'acp initialize failed: boom' }],
    );
  });

  it('emits an error when the opening frame cannot be written', () => {
    const h = harness({}, false);
    expect(h.emitted).toEqual([
      // No invented cause: the parenthetical this used to carry ("the agent's
      // stdin is closed") was one of four possibilities stated as fact.
      { type: 'error', message: 'acp: failed to send initialize' },
    ]);
  });

  it('names the WRITER’s reason on an opening frame that could not go out', () => {
    const h = harness({}, false, () => 'its process group has been terminated');
    expect(h.emitted).toEqual([
      {
        type: 'error',
        message:
          'acp: failed to send initialize — its process group has been terminated',
      },
    ]);
  });

  it('notes a protocol version the client does not implement', () => {
    const h = harness();
    const events = h.feed({ id: 1, result: { protocolVersion: 99 } });
    expect(events).toContainEqual({
      type: 'notice',
      message:
        'agent negotiated ACP protocol version 99; this client implements 1',
    });
  });

  it('ignores a reply to an id it never sent', () => {
    const h = harness();
    expect(h.feed({ id: 999, result: {} })).toEqual([]);
  });
});

describe('AcpSession MCP delivery', () => {
  const endpoint = {
    input: {
      ...BASE_INPUT,
      mcpEndpoint: {
        url: 'http://127.0.0.1:1/v1/mcp/r/n',
        token: 'tok-1',
        serverName: 'geniro-run12345',
      },
    },
  };

  /** A caller turn: a role, plus the awareness block naming its callees. */
  const caller = {
    input: {
      ...endpoint.input,
      systemPrompt: 'You orchestrate.',
      callSurfacePrompt: 'May call (via the call_agent tool): - Helper',
    },
  };

  function promptText(h: Harness): string {
    const params = h.sentMethod('session/prompt')?.params as
      { prompt: { text: string }[] } | undefined;
    return params?.prompt[0]?.text ?? '';
  }

  it('carries the call endpoint in session/new when the agent advertises HTTP MCP', () => {
    const h = harness(endpoint);
    h.feed(initializeReply(1, { http: true }));
    expect(h.sentMethod('session/new')?.params).toEqual({
      cwd: '/work',
      mcpServers: [
        {
          type: 'http',
          name: 'geniro-run12345',
          url: 'http://127.0.0.1:1/v1/mcp/r/n',
          headers: [{ name: 'Authorization', value: 'Bearer tok-1' }],
        },
      ],
    });
  });

  it('degrades visibly, without the endpoint, when HTTP MCP is not advertised', () => {
    const h = harness(endpoint);
    const events = h.feed(initializeReply(1, { http: false }));
    expect(events).toContainEqual({
      type: 'notice',
      message:
        'agent calls disabled for this turn: the agent does not advertise HTTP MCP support (mcpCapabilities.http), so the callee list was removed from this turn’s instructions too',
    });
    expect(h.sentMethod('session/new')?.params).toEqual({
      cwd: '/work',
      mcpServers: [],
    });
  });

  it('keeps the callee list in the prompt when the call tools were registered', () => {
    const h = harness(caller);
    h.feed(initializeReply(1, { http: true }));
    h.feed({ id: 2, result: { sessionId: 's' } });
    expect(promptText(h)).toBe(
      `do the thing\n\n${hostBlock(
        'You orchestrate.\n\nMay call (via the call_agent tool): - Helper',
      )}`,
    );
  });

  it('drops the callee list from the prompt when the call tools were withheld', () => {
    const h = harness(caller);
    h.feed(initializeReply(1, { http: false }));
    h.feed({ id: 2, result: { sessionId: 's' } });
    // Telling an agent to route work through `call_agent` when no such tool is
    // registered makes its callees silently never run while the member still
    // reports success. The role survives; only the false affordance goes.
    expect(promptText(h)).toBe(
      `do the thing\n\n${hostBlock('You orchestrate.')}`,
    );
    expect(promptText(h)).not.toContain('call_agent');
  });

  it('carries a team member’s instructions in the prompt, ACP having no system-prompt field', () => {
    const h = harness({ input: { ...BASE_INPUT, systemPrompt: 'Be terse.' } });
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 's' } });
    expect(promptText(h)).toBe(`do the thing\n\n${hostBlock('Be terse.')}`);
  });

  it('opens the prompt with the USER’s words, never with the instructions', () => {
    // THE REPORTED DEFECT, and the reason the order is asserted rather than
    // merely the contents. ACP has no system-prompt field, so the instructions
    // ride the prompt TEXT — and the CLI names the conversation from that first
    // prompt. Led by geniro's own preamble, cursor-agent named a chat asking
    // about bloom filters "Markdown Not Terminal"; with the user's sentence
    // first the same prompt produced "Bloom Filter Explained".
    const h = harness({ input: { ...BASE_INPUT, systemPrompt: 'Be terse.' } });
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 's' } });
    expect(promptText(h)?.startsWith('do the thing')).toBe(true);
  });

  it('marks the instructions as HOST CONTEXT, not as something to answer', () => {
    // REPORTED, then reproduced end to end: a cursor chat opened with `Hello!`
    // was answered "Got it — I'll treat this as a **rich markdown chat
    // transcript**, not terminal output", listing the formats geniro had just
    // described — because on ACP these instructions arrive inside the USER's
    // turn, and an agent answers what the user says. claude never had this;
    // `--append-system-prompt` is out of band. With the wrapper the same
    // opening is answered "Hello! How can I help you today?".
    const h = harness({ input: { ...BASE_INPUT, systemPrompt: 'Be terse.' } });
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 's' } });
    const text = promptText(h) ?? '';

    // The boundary and the sentence saying what it is: a bare tag is just more
    // text, and the sentence without the tag has nothing to scope.
    expect(text).toContain(`<${HOST_CONTEXT_TAG}>`);
    expect(text).toContain(`</${HOST_CONTEXT_TAG}>`);
    expect(text).toContain(HOST_CONTEXT_NOTE);
    // Inside it, and after the user's own words.
    expect(text.indexOf('do the thing')).toBeLessThan(
      text.indexOf(`<${HOST_CONTEXT_TAG}>`),
    );
    expect(text.indexOf('Be terse.')).toBeGreaterThan(
      text.indexOf(HOST_CONTEXT_NOTE),
    );
    expect(text.indexOf('Be terse.')).toBeLessThan(
      text.indexOf(`</${HOST_CONTEXT_TAG}>`),
    );
  });

  it('sends the prompt ALONE when the turn has no instructions at all', () => {
    // An empty wrapper would be a boundary around nothing plus a sentence about
    // it — noise in every resumed turn, which is most of them.
    const h = harness({ composeSystemPrompt: () => '' });
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 's' } });
    expect(promptText(h)).toBe('do the thing');
  });

  it('sends no server list when the turn has no endpoint', () => {
    const h = harness();
    h.feed(initializeReply(1, { http: true }));
    expect(h.sentMethod('session/new')?.params).toEqual({
      cwd: '/work',
      mcpServers: [],
    });
  });
});

describe('AcpSession session resume', () => {
  const resuming = { input: { ...BASE_INPUT, resumeSessionId: 'prior-7' } };

  it('loads the prior session when the agent supports it', () => {
    const h = harness(resuming);
    h.feed(initializeReply(1, { loadSession: true }));
    expect(h.sentMethod('session/load')?.params).toEqual({
      sessionId: 'prior-7',
      cwd: '/work',
      mcpServers: [],
    });
    expect(h.sentMethod('session/new')).toBeUndefined();
  });

  /** The text of the Nth `session/prompt` the harness wrote. */
  function promptText(h: Harness, index = 0): string | undefined {
    const params = h.sentAll('session/prompt')[index]?.params as
      { prompt: { text?: string }[] } | undefined;
    return params?.prompt.at(-1)?.text;
  }

  it('withholds the instructions a session/load replayed back', () => {
    // Prompt text IS the conversation on this transport, so a block one turn
    // carried is in the window for every turn after it. The replay hands each
    // prior user message back whole, and the newest block in it is the one the
    // conversation already holds — sending it again is a second full copy of
    // the role, blocks and preamble in that window.
    const h = harness({ ...resuming, composeSystemPrompt: () => 'ROLE' });
    h.feed(initializeReply(1, { loadSession: true }));
    h.feed(chunk('user_message_chunk', `earlier ask\n\n${hostBlock('ROLE')}`));
    h.feed({ jsonrpc: '2.0', id: 2, result: {} });

    expect(promptText(h)).toBe('do the thing');
  });

  it('sends the instructions again when the replayed block is a different one', () => {
    // The block is compared as TEXT, so what changed since that turn — a call
    // surface this process was not granted, instructions the user forgot —
    // still reaches the agent, and the newer block supersedes the older.
    const h = harness({ ...resuming, composeSystemPrompt: () => 'NEW ROLE' });
    h.feed(initializeReply(1, { loadSession: true }));
    h.feed(chunk('user_message_chunk', `first\n\n${hostBlock('OLD ROLE')}`));
    h.feed(chunk('user_message_chunk', 'second, carrying no block'));
    h.feed({ jsonrpc: '2.0', id: 2, result: {} });

    expect(promptText(h)).toBe(`do the thing\n\n${hostBlock('NEW ROLE')}`);
  });

  it('reads the NEWEST replayed block, not the first', () => {
    const h = harness({ ...resuming, composeSystemPrompt: () => 'ROLE v2' });
    h.feed(initializeReply(1, { loadSession: true }));
    h.feed(chunk('user_message_chunk', `a\n\n${hostBlock('ROLE v1')}`));
    h.feed(chunk('user_message_chunk', `b\n\n${hostBlock('ROLE v2')}`));
    h.feed({ jsonrpc: '2.0', id: 2, result: {} });

    expect(promptText(h)).toBe('do the thing');
  });

  it('sends the instructions on a resumed session whose replay carried none', () => {
    // A conversation imported from the user's own terminal, or one whose
    // replay came back altered, holds nothing this client can vouch for — the
    // safe direction is one more copy, never a missing instruction.
    const h = harness({ ...resuming, composeSystemPrompt: () => 'ROLE' });
    h.feed(initializeReply(1, { loadSession: true }));
    h.feed(chunk('user_message_chunk', 'hello from the terminal'));
    h.feed({ jsonrpc: '2.0', id: 2, result: {} });

    expect(promptText(h)).toBe(`do the thing\n\n${hostBlock('ROLE')}`);
  });

  it('does not count what a REFUSED load replayed', () => {
    // A refused load is followed by `session/new`, which holds nothing — so a
    // block that came back before the refusal must not be taken as delivered.
    const h = harness({ ...resuming, composeSystemPrompt: () => 'ROLE' });
    h.feed(initializeReply(1, { loadSession: true }));
    h.feed(chunk('user_message_chunk', `earlier\n\n${hostBlock('ROLE')}`));
    h.feed({ id: 2, error: { code: -32602, message: 'Invalid params' } });
    h.feed({ id: 3, result: { sessionId: 'fresh-1' } });

    expect(promptText(h)).toBe(`do the thing\n\n${hostBlock('ROLE')}`);
  });

  it('sends the instructions on a session that was NOT resumed', () => {
    // The control: a fresh `session/new` holds nothing, so withholding them
    // there would leave that agent never told any of it.
    const h = harness({ composeSystemPrompt: () => 'PREAMBLE\n\nROLE' });
    h.feed(initializeReply(1));
    h.feed({ jsonrpc: '2.0', id: 2, result: { sessionId: 'fresh-1' } });

    expect(promptText(h)).toBe(
      `do the thing\n\n${hostBlock('PREAMBLE\n\nROLE')}`,
    );
  });

  it('drops the replayed transcript a session/load streams back', () => {
    const h = harness(resuming);
    h.feed(initializeReply(1, { loadSession: true }));

    // Everything between the load request and its reply is history already in
    // SQLite; persisting it again would duplicate the whole thread per turn.
    expect(h.feed(chunk('agent_message_chunk', 'an old answer'))).toEqual([]);
    expect(
      h.feed(
        update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read' }),
      ),
    ).toEqual([]);

    // The load reply carries no session id — the id is the one we sent.
    expect(h.feed({ id: 2, result: {} })).toEqual([
      { type: 'session', sessionId: 'prior-7' },
    ]);
    // ...and live output after the reply flows normally.
    expect(h.feed(chunk('agent_message_chunk', 'a new answer'))).toEqual([
      { type: 'text_delta', text: 'a new answer' },
    ]);
  });

  it('measures what the session/load replay cost before the prompt could be sent', () => {
    const debug = vi.fn();
    const h = harness({ ...resuming, logger: { warn: vi.fn(), debug } });
    h.feed(initializeReply(1, { loadSession: true }));

    h.feed(chunk('agent_message_chunk', 'an old answer'));
    h.feed(
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read' }),
    );
    h.feed(chunk('agent_message_chunk', 'another old answer'));
    // Nothing is reported until the load reply lands — that is the point the
    // prompt is unblocked, so that is what the measurement bounds.
    expect(debug).not.toHaveBeenCalled();

    h.feed({ id: 2, result: {} });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]?.[0]).toContain('replayed 3 update(s)');
  });

  it('notices when the agent does not offer the mode this turn asked for', () => {
    const h = harness({ preferredModeId: 'plan' });
    h.feed(initializeReply(1));
    const events = h.feed({
      id: 2,
      result: {
        sessionId: 's',
        modes: { currentModeId: 'normal', availableModes: [{ id: 'normal' }] },
      },
    });

    // A `plan` turn that quietly ran under the agent's normal mode has write
    // access the user believed they had turned off — the one degrade here that
    // costs something, so it must not be silent.
    expect(events).toContainEqual({
      type: 'notice',
      message:
        "agent does not offer the 'plan' mode — this turn runs under the agent's current mode instead",
    });
    // The turn still runs; the notice reports, it does not abort.
    expect(h.sentMethod('session/prompt')).toBeDefined();
    expect(h.sentMethod('session/set_mode')).toBeUndefined();
  });

  it('sets the mode without a notice when the agent does offer it', () => {
    const h = harness({ preferredModeId: 'plan' });
    h.feed(initializeReply(1));
    const events = h.feed({
      id: 2,
      result: {
        sessionId: 's',
        modes: {
          currentModeId: 'normal',
          availableModes: [{ id: 'normal' }, { id: 'plan' }],
        },
      },
    });

    expect(h.sentMethod('session/set_mode')?.params).toEqual({
      sessionId: 's',
      modeId: 'plan',
    });
    expect(events.filter((e) => e.type === 'notice')).toEqual([]);
  });

  it('never claims the agent lacks a mode from a reply that enumerated none', () => {
    const h = harness({
      input: { ...BASE_INPUT, resumeSessionId: 'prior-7' },
      preferredModeId: 'plan',
    });
    h.feed(initializeReply(1, { loadSession: true }));
    // Silence is not a refusal: reading a missing `modes` block as "not offered"
    // would put a false statement about the agent into the transcript. (A real
    // `session/load` reply DOES carry modes — measured on 2026.08.11-e8db854 —
    // so this is the shape a future build could still send, not the normal one.)
    const events = h.feed({ id: 2, result: {} });

    expect(
      events.filter(
        (e) => e.type === 'notice' && e.message.includes('does not offer'),
      ),
    ).toEqual([]);
  });

  it('applies the mode and model a session/load reply enumerates, like a fresh one', () => {
    // The measured shape of a real load reply on 2026.08.11-e8db854: `modes`,
    // `models` and a full `configOptions` list with each option's currentValue.
    // Recorded here because it was previously believed to carry none of them,
    // which is what made a resumed turn look like it needed its own rules.
    const h = harness({
      input: { ...BASE_INPUT, resumeSessionId: 'prior-7', model: 'opus-5' },
      preferredModeId: 'plan',
    });
    h.feed(initializeReply(1, { loadSession: true }));

    h.feed({
      id: 2,
      result: {
        modes: {
          currentModeId: 'agent',
          availableModes: [{ id: 'agent' }, { id: 'plan' }],
        },
        models: { currentModelId: 'sonnet-5', availableModels: [] },
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: 'sonnet-5',
            availableValues: [{ value: 'opus-5' }, { value: 'sonnet-5' }],
          },
        ],
      },
    });

    expect(h.sentMethod('session/set_mode')?.params).toEqual({
      sessionId: 'prior-7',
      modeId: 'plan',
    });
    expect(h.sentMethod('session/set_config_option')?.params).toEqual({
      sessionId: 'prior-7',
      configId: 'model',
      value: 'opus-5',
    });
  });

  it('runs the turn on a FRESH session when the agent cannot reopen the thread', () => {
    // The dead end this replaces: a refused load ended the turn, and since every
    // later turn resumes the same id, the chat was unusable for good — the user
    // saw a turn finish instantly having written nothing. Measured refusal shape
    // on 2026.08.11-e8db854: `-32602 Invalid params`, "Session … not found".
    const h = harness(resuming);
    h.feed(initializeReply(1, { loadSession: true }));

    const events = h.feed({
      id: 2,
      error: { code: -32602, message: 'Invalid params' },
    });

    expect(events).toContainEqual({
      type: 'notice',
      message:
        'agent could not reopen this conversation (Invalid params) — this turn runs on a fresh session, without the earlier history in its context',
    });
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(h.sentMethod('session/new')?.params).toEqual({
      cwd: '/work',
      mcpServers: [],
    });
  });

  it('un-arms the replay drop after a failed load, so the new turn is not swallowed', () => {
    // The load set `replaying`, and every transcript update is dropped while it
    // is set. Leave it armed and the fresh session's whole answer vanishes —
    // which turns "lost the history" into "wrote nothing at all", the very
    // symptom the degrade exists to end.
    const h = harness(resuming);
    h.feed(initializeReply(1, { loadSession: true }));
    h.feed({ id: 2, error: { code: -32602, message: 'Invalid params' } });
    h.feed({ id: 3, result: { sessionId: 'fresh-1' } });

    expect(h.feed(chunk('agent_message_chunk', 'a new answer'))).toEqual([
      { type: 'text_delta', text: 'a new answer' },
    ]);
    expect(h.sentMethod('session/prompt')?.params).toEqual({
      sessionId: 'fresh-1',
      prompt: [{ type: 'text', text: 'do the thing' }],
    });
  });

  it('carries the call surface into the fresh session a failed load falls back to', () => {
    // The MCP servers were granted during `initialize`; a fallback that dropped
    // them would silently withhold the agent-call tools for that turn while its
    // instructions still named the callees.
    const h = harness({
      input: {
        ...BASE_INPUT,
        resumeSessionId: 'prior-7',
        mcpEndpoint: {
          url: 'http://127.0.0.1:1/v1/mcp/r/n',
          token: 'tok',
          serverName: 'geniro-r',
        },
      },
    });
    h.feed(initializeReply(1, { loadSession: true, http: true }));
    h.feed({ id: 2, error: { code: -32602, message: 'Invalid params' } });

    expect(h.sentMethod('session/new')?.params).toEqual({
      cwd: '/work',
      mcpServers: [
        {
          type: 'http',
          name: 'geniro-r',
          url: 'http://127.0.0.1:1/v1/mcp/r/n',
          headers: [{ name: 'Authorization', value: 'Bearer tok' }],
        },
      ],
    });
  });

  it('shows a stubbed permission request the arguments its tool_call announced', () => {
    const h = harness();
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 's' } });
    h.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't-1',
        name: 'write_file',
        kind: 'edit',
        rawInput: { path: 'a.ts', contents: 'x' },
      }),
    );

    // The request's own toolCall is a stub: no name, no kind, no rawInput.
    // Without the cache the user is asked to approve a blank tool with no
    // visible arguments.
    const events = h.feed({
      id: 'p1',
      method: 'session/request_permission',
      params: { toolCall: { toolCallId: 't-1' }, options: [] },
    });
    expect(events).toEqual([
      {
        type: 'approval_request',
        id: expect.any(String) as unknown as string,
        toolName: 'write_file',
        input: { path: 'a.ts', contents: 'x' },
      },
    ]);
  });

  it('measures nothing on a fresh session, which has no replay to pay for', () => {
    const debug = vi.fn();
    const h = harness({ input: BASE_INPUT, logger: { warn: vi.fn(), debug } });
    h.feed(initializeReply(1, { loadSession: true }));
    h.feed({ id: 2, result: { sessionId: 's' } });
    expect(debug).not.toHaveBeenCalled();
  });

  it('still harvests the command set and the context usage during that replay', () => {
    const h = harness(resuming);
    h.feed(initializeReply(1, { loadSession: true }));

    // Unlike the replayed transcript, these two describe CURRENT state — the
    // set of commands this session can invoke now, and how full its context
    // is — so the replay window must not swallow them the way it swallows
    // history.
    expect(
      h.feed(
        update({
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'review' }],
        }),
      ),
    ).toEqual([
      {
        type: 'slash_commands',
        commands: [{ name: 'review', description: null }],
      },
    ]);
    h.feed(
      update({
        sessionUpdate: 'usage_update',
        used: 12_345,
        size: 200_000,
        cost: { amount: 0.5, currency: 'USD' },
      }),
    );

    h.feed({ id: 2, result: {} });
    const [event] = h.feed({ id: 3, result: { stopReason: 'end_turn' } });
    expect(event).toMatchObject({
      type: 'turn_complete',
      usage: { contextTokens: 12_345, costUsd: 0.5 },
    });
  });

  it('says so when resume was asked for but the agent cannot load sessions', () => {
    const h = harness(resuming);
    const events = h.feed(initializeReply(1, { loadSession: false }));
    expect(events).toContainEqual({
      type: 'notice',
      message:
        'this agent cannot resume a conversation — the turn starts fresh, without the earlier messages',
    });
    expect(h.sentMethod('session/new')).toBeDefined();
  });
});

describe('AcpSession — the files a tool call names', () => {
  it('carries the paths through, and a line only where the agent set one', () => {
    // Measured on cursor-agent 2026.08.31-4057e58: six kinds carry `locations`
    // on the OPENING frame, and `read` is the only one that ever sets a line —
    // from `args.offset`, and only when that offset is above zero.
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 't-1',
          title: 'Read File',
          locations: [
            { path: '/repo/src/a.ts', line: 42 },
            { path: '/repo/src/b.ts' },
          ],
        }),
      ),
    ).toMatchObject([
      {
        type: 'tool_call',
        locations: [
          { path: '/repo/src/a.ts', line: 42 },
          { path: '/repo/src/b.ts', line: null },
        ],
      },
    ]);
  });

  it('omits the key entirely when the agent named no files', () => {
    // ABSENT is not the same as empty here, and the difference is the agent's:
    // it drops the field rather than sending `[]`, so an empty array would put
    // "this call touched nothing" in its mouth. Every claude row is this case.
    const h = harness();
    const [event] = h.feed(
      update({ sessionUpdate: 'tool_call', toolCallId: 't-2', title: 'Bash' }),
    );

    expect(event).toMatchObject({ type: 'tool_call' });
    expect(event).not.toHaveProperty('locations');
  });

  it('drops a location that names no file rather than emitting a blank path', () => {
    const h = harness();
    const [event] = h.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't-3',
        title: 'Glob',
        locations: [{ line: 3 }, { path: '/repo/src/c.ts' }],
      }),
    );

    expect(event).toMatchObject({
      locations: [{ path: '/repo/src/c.ts', line: null }],
    });
  });
});

describe('AcpSession — the agent naming its own conversation', () => {
  it('draws no row for it, and records nothing', () => {
    // The name reaches geniro already: this CLI writes it into its own session
    // store BEFORE emitting the frame, and `readSessionTitle` reads that store.
    // So the frame buys only TIMING — and collecting that needs a consumer able
    // to reach `ChatTitleService`, which owns the guard keeping a manual rename
    // permanent and which no driver can call. Handling it without that consumer
    // is state nobody reads.
    const h = harness();
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 'sess-1' } });

    expect(
      h.feed(
        update({
          sessionUpdate: 'session_info_update',
          title: 'Bloom Filters',
        }),
      ),
    ).toEqual([]);
  });
});

describe('AcpSession — a resume-only turn', () => {
  const reopening = {
    input: { ...BASE_INPUT, resumeSessionId: 'prior-7', resumeOnly: true },
  };

  it('settles from the load reply, having sent no prompt', () => {
    const h = harness(reopening);
    h.feed(initializeReply(1, { loadSession: true }));
    expect(h.sentMethod('session/load')).toBeDefined();

    const events = h.feed({ id: 2, result: {} });

    // The load reply IS the settle here, and nothing else could be: no prompt
    // is in flight to earn a stop reason, so an unbranched turn would wait out
    // the transport's silence deadline and settle as a failure having done
    // exactly what it was asked to.
    expect(h.sentMethod('session/prompt')).toBeUndefined();
    expect(
      events.find((event) => event.type === 'turn_complete'),
    ).toMatchObject({ stopReason: null, finalText: null });
  });

  it('still sends the prompt on an ordinary resume', () => {
    // The control. Without it the pin above passes just as well against a
    // driver that never sends a prompt on any resumed session at all.
    const h = harness({ input: { ...BASE_INPUT, resumeSessionId: 'prior-7' } });
    h.feed(initializeReply(1, { loadSession: true }));

    const events = h.feed({ id: 2, result: {} });

    expect(h.sentMethod('session/prompt')).toBeDefined();
    expect(events.map((event) => event.type)).not.toContain('turn_complete');
  });

  it('reports a refused load as a failure instead of opening a fresh session', () => {
    const h = harness(reopening);
    h.feed(initializeReply(1, { loadSession: true }));

    const events = h.feed({
      id: 2,
      error: { code: -32602, message: 'Session "prior-7" not found' },
    });

    // The ordinary turn's degrade — a notice, then `session/new` on the same
    // process — is right when there is a prompt to run without the history.
    // This turn's only product IS the reopened conversation, so taking that
    // path would report success while discarding it.
    expect(h.sentMethod('session/new')).toBeUndefined();
    expect(events).toEqual([
      {
        type: 'error',
        message:
          'agent could not reopen this conversation: Session "prior-7" not found',
      },
    ]);
  });

  it('sends no prompt when opened on a session the process already holds', () => {
    // The SECOND opener. `onSessionReady`'s branch covers a turn that shook
    // hands; a turn opened on a KEPT session goes `openOnLiveSession` →
    // `beginTurn` → `sendPrompt` and never passes through it. `ChatService.retry`
    // closes a kept session first, which is what makes this unreachable in
    // production — but that is a cross-module invariant this file cannot
    // enforce, and the guard in `sendPrompt` is what holds if it ever breaks.
    const h = harness();
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 'sess-1' } });
    h.feed({ id: 3, result: { stopReason: 'end_turn' } });
    const before = h.sentAll('session/prompt').length;

    h.openTurn({ ...BASE_INPUT, resumeSessionId: 'sess-1', resumeOnly: true });

    expect(h.sentAll('session/prompt')).toHaveLength(before);
  });

  it('has no session to write a follow-up into before its load reply', () => {
    // Not a guard of its own: a follow-up is a second `session/prompt`, and the
    // existing null-session check already refuses one for the whole life of
    // this turn — the id arrives with the load reply, which is also what
    // settles it. Pinned so a later change that sets the id earlier has to come
    // back here and decide deliberately.
    const h = harness(reopening);
    h.feed(initializeReply(1, { loadSession: true }));

    expect(h.driver.sendFollowUp({ text: 'while you are back, do X' })).toBe(
      false,
    );
    expect(h.sentMethod('session/prompt')).toBeUndefined();
  });
});

describe('AcpSession model selection', () => {
  const WANTED = 'claude-opus-5[thinking=true]';
  const wanting = { input: { ...BASE_INPUT, model: WANTED } };

  function sessionWithModels(
    current: string,
    available: string[],
  ): Record<string, unknown> {
    return {
      sessionId: 's-1',
      models: {
        currentModelId: current,
        availableModels: available.map((modelId) => ({
          modelId,
          name: modelId,
        })),
      },
    };
  }

  /** Frame order, so "before the prompt" can be asserted rather than assumed. */
  function methodsOf(h: ReturnType<typeof harness>): string[] {
    return h.sent
      .map((frame) => frame.method)
      .filter((method): method is string => typeof method === 'string');
  }

  /** Notices the driver RETURNED — `onMessage`'s value, not the emit channel. */
  function noticesIn(events: AgentEvent[]): AgentEvent[] {
    return events.filter((event) => event.type === 'notice');
  }

  it('sets an offered model BEFORE the prompt goes out', () => {
    // Order is the whole mechanism: both frames ride one ordered stdio stream,
    // so a set_model sent after the prompt would apply to the NEXT turn.
    const h = harness(wanting);
    h.feed(initializeReply(1));
    const events = h.feed({
      id: 2,
      result: sessionWithModels('composer-2.5', [WANTED]),
    });

    expect(h.sentMethod('session/set_model')?.params).toEqual({
      sessionId: 's-1',
      modelId: WANTED,
    });
    const methods = methodsOf(h);
    expect(methods.indexOf('session/set_model')).toBeLessThan(
      methods.indexOf('session/prompt'),
    );
    expect(noticesIn(events)).toEqual([]);
  });

  it('spends no frame when the session is already on that model', () => {
    const h = harness(wanting);
    h.feed(initializeReply(1));
    const events = h.feed({
      id: 2,
      result: sessionWithModels(WANTED, [WANTED]),
    });

    expect(h.sentMethod('session/set_model')).toBeUndefined();
    expect(noticesIn(events)).toEqual([]);
  });

  it('says so, and sends nothing, when a FRESH session does not offer it', () => {
    // The local refusal is worth it here because the reply genuinely lists
    // what is on offer — asking anyway would spend a round-trip to be refused.
    const h = harness(wanting);
    h.feed(initializeReply(1));
    const events = h.feed({
      id: 2,
      result: sessionWithModels('composer-2.5', ['gpt-5.2']),
    });

    expect(h.sentMethod('session/set_model')).toBeUndefined();
    expect(events).toContainEqual({
      type: 'notice',
      message: `agent does not offer the model '${WANTED}' — this turn runs on the agent's current model instead`,
    });
  });

  it('names the model the turn stays on when a FRESH session does not offer it', () => {
    const h = harness(wanting);
    h.feed(initializeReply(1));
    const events = h.feed({
      id: 2,
      result: sessionWithModels('composer-2.5', ['composer-2.5']),
    });

    const announced = events.filter((event) => event.type === 'turn_model');
    expect(announced).toEqual([{ type: 'turn_model', model: 'composer-2.5' }]);
  });

  it('announces no model when a refused session never named its own', () => {
    const h = harness(wanting);
    h.feed(initializeReply(1));
    const events = h.feed({
      id: 2,
      result: {
        sessionId: 's-1',
        models: { availableModels: [{ modelId: 'gpt-5.2', name: 'gpt-5.2' }] },
      },
    });

    expect(noticesIn(events)).toHaveLength(1);
    expect(events.some((event) => event.type === 'turn_model')).toBe(false);
  });

  it('still asks on a RESUMED session, whose reply lists no models', () => {
    // The regression this pins: gating a resumed turn on the offers check
    // refuses locally on EVERY turn after a chat's first — cursor cannot keep
    // its process, so they all resume — leaving the model unapplied for the
    // whole conversation and landing a degrade row per turn.
    const h = harness({
      input: { ...BASE_INPUT, model: WANTED, resumeSessionId: 'prior-7' },
    });
    h.feed(initializeReply(1, { loadSession: true }));
    const events = h.feed({ id: 2, result: {} });

    expect(h.sentMethod('session/set_model')?.params).toEqual({
      sessionId: 'prior-7',
      modelId: WANTED,
    });
    expect(noticesIn(events)).toEqual([]);
  });

  it('reports the agent’s OWN refusal rather than assuming one', () => {
    const h = harness({
      input: { ...BASE_INPUT, model: WANTED, resumeSessionId: 'prior-7' },
    });
    h.feed(initializeReply(1, { loadSession: true }));
    h.feed({ id: 2, result: {} });
    const setModelId = h.sent.find(
      (frame) => frame.method === 'session/set_model',
    )?.id;

    const events = h.feed({
      id: setModelId,
      error: { code: -32602, message: 'Invalid model value' },
    });

    expect(events).toEqual([
      {
        type: 'notice',
        message: `agent declined model '${WANTED}': Invalid model value — this turn runs on the agent's current model`,
      },
    ]);
  });

  it('does not re-send a model the session has already confirmed', () => {
    // Every later turn on a kept process is handed the STORED `session/new`
    // reply, which names the model the session was CREATED with. Compared
    // against that, a model confirmed on turn 1 looks unset on turn 2 — so the
    // frame goes out again each turn, and the seed above rewinds the field the
    // anti-poisoning guard reads back to the session's original model.
    const h = harness(wanting);
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: sessionWithModels('agents-own-model', [WANTED]) });
    const setModelId = h.sent.find(
      (frame) => frame.method === 'session/set_model',
    )?.id;
    h.feed({ id: setModelId, result: {} });
    const afterTurnOne = h.sentAll('session/set_model').length;
    expect(afterTurnOne).toBe(1);

    h.openTurn({ ...BASE_INPUT, model: WANTED });

    expect(h.sentAll('session/set_model')).toHaveLength(afterTurnOne);
  });

  it('leaves a turn that named no model alone', () => {
    const h = harness();
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: sessionWithModels('composer-2.5', [WANTED]) });

    expect(h.sentMethod('session/set_model')).toBeUndefined();
  });

  describe('what a window measured on this turn is filed under', () => {
    // The reading this transport takes off disk names no model of its own, so
    // the label falls back to what the SESSION is running as — and that field
    // holds the model the agent CONFIRMED, never the one a turn requested,
    // which `turn_model` announces instead. `PartialStreamService`'s
    // anti-poisoning guard compares exactly those two, so collapsing them onto
    // one value leaves it comparing that value against itself, unable to fire,
    // filing a refused model's window under the model the user asked for.
    const NAMELESS_READING = {
      usedTokens: 101_100,
      windowTokens: 200_000,
      model: null,
    };

    /** Drive a turn that asks for WANTED on an agent sitting on its own model. */
    function switching(): {
      h: Harness;
      opened: AgentEvent[];
      setModelId: unknown;
    } {
      const h = harness({
        ...wanting,
        readContext: () => NAMELESS_READING,
      });
      h.feed(initializeReply(1));
      const opened = h.feed({
        id: 2,
        result: sessionWithModels('agents-own-model', [WANTED]),
      });
      const setModelId = h.sent.find(
        (frame) => frame.method === 'session/set_model',
      )?.id;
      return { h, opened, setModelId };
    }

    /**
     * Settle the turn and hand back its `turn_complete`.
     *
     * The return type is the NARROWED member rather than `AgentEvent`: the
     * union's other variants carry no `usage`, so annotating it as the union
     * discards exactly the narrowing every assertion below needs.
     */
    function settle(
      h: Harness,
    ): Extract<AgentEvent, { type: 'turn_complete' }> | undefined {
      const promptId = h.sent.find(
        (frame) => frame.method === 'session/prompt',
      )?.id;
      return h
        .feed({ id: promptId, result: { stopReason: 'end_turn' } })
        .find((event) => event.type === 'turn_complete');
    }

    it('labels it with the AGENT’s model when the switch was refused', () => {
      const { h, opened, setModelId } = switching();

      // The offers check passed, so nothing local knows yet that this will be
      // refused: the turn announces what it asked to run as.
      expect(opened).toContainEqual({ type: 'turn_model', model: WANTED });

      const refused = h.feed({
        id: setModelId,
        error: { code: -32602, message: 'Invalid model value' },
      });

      const complete = settle(h);
      expect(complete?.usage?.contextWindowTokens).toBe(200_000);
      expect(complete?.usage?.contextModel).toBe('agents-own-model');
      expect(refused.filter((event) => event.type === 'turn_model')).toEqual([
        { type: 'turn_model', model: 'agents-own-model' },
      ]);
    });

    it('labels it with the model it announced when the offers check refused', () => {
      const h = harness({ ...wanting, readContext: () => NAMELESS_READING });
      h.feed(initializeReply(1));
      const opened = h.feed({
        id: 2,
        result: sessionWithModels('agents-own-model', ['agents-own-model']),
      });

      const complete = settle(h);
      expect(complete?.usage?.contextModel).toBe('agents-own-model');
      expect(opened.filter((event) => event.type === 'turn_model')).toEqual([
        { type: 'turn_model', model: 'agents-own-model' },
      ]);
    });

    it('labels it with the REQUESTED model once the agent accepts it', () => {
      // The other direction, and the reason the fix is a moved write rather than
      // a dropped one: a guard that blocked every ACP window would be a fresh
      // defect wearing the old one's clothes.
      const { h, setModelId } = switching();
      h.feed({ id: setModelId, result: {} });

      const complete = settle(h);
      expect(complete?.usage?.contextModel).toBe(WANTED);
    });
  });

  describe('when the reply enumerates nothing', () => {
    // Silence is not a refusal. `readAcpModels`' own contract says an empty
    // result means "the agent said nothing", and that EVERY caller must read it
    // as unknown — so refusing locally here would run the turn on a model the
    // user did not pick while asserting something the agent never said.
    const refused = {
      type: 'notice',
      message: `agent does not offer the model '${WANTED}' — this turn runs on the agent's current model instead`,
    };

    function fresh(result: Record<string, unknown>): {
      sent: Record<string, unknown> | undefined;
      events: AgentEvent[];
    } {
      const h = harness(wanting);
      h.feed(initializeReply(1));
      const events = h.feed({ id: 2, result });
      return { sent: h.sentMethod('session/set_model'), events };
    }

    it('asks anyway when a fresh reply carries no models block', () => {
      const { sent, events } = fresh({ sessionId: 's-1' });

      expect(sent?.params).toEqual({ sessionId: 's-1', modelId: WANTED });
      expect(events).not.toContainEqual(refused);
    });

    it('asks anyway when the block names a current model but no list', () => {
      const { sent, events } = fresh({
        sessionId: 's-1',
        models: { currentModelId: 'composer-2.5' },
      });

      expect(sent?.params).toEqual({ sessionId: 's-1', modelId: WANTED });
      expect(events).not.toContainEqual(refused);
    });
  });

  describe('over the ACP 1.0 config-option carrier', () => {
    /** A `session/new` reply that enumerates models the ACP 1.0 way. */
    function sessionWithConfigOptions(
      current: string,
      available: string[],
    ): Record<string, unknown> {
      return {
        sessionId: 's-1',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: current,
            options: available.map((value) => ({ value, name: value })),
          },
        ],
      };
    }

    it('sets the model with session/set_config_option, not session/set_model', () => {
      // No stable schema ever declared `session/set_model`. An agent that
      // enumerated its models under `configOptions` is one that implements the
      // replacement, so sending the legacy method would be a refused frame
      // and a degrade notice for a model the agent was perfectly able to use.
      const h = harness(wanting);
      h.feed(initializeReply(1));
      const events = h.feed({
        id: 2,
        result: sessionWithConfigOptions('composer-2.5', [WANTED]),
      });

      expect(h.sentMethod('session/set_config_option')?.params).toEqual({
        sessionId: 's-1',
        // `configId`, NOT the `configOptionId` the docs' prose uses — probed
        // on cursor-agent 2026.08.04, which rejects the latter as invalid.
        configId: 'model',
        value: WANTED,
      });
      expect(h.sentMethod('session/set_model')).toBeUndefined();
      expect(noticesIn(events)).toEqual([]);
    });

    it('still puts it before the prompt', () => {
      const h = harness(wanting);
      h.feed(initializeReply(1));
      h.feed({
        id: 2,
        result: sessionWithConfigOptions('composer-2.5', [WANTED]),
      });

      const methods = methodsOf(h);
      expect(methods.indexOf('session/set_config_option')).toBeLessThan(
        methods.indexOf('session/prompt'),
      );
    });

    it('keeps the legacy frame for an agent that offers no model option', () => {
      // Absence from the SPEC is not absence from the binaries. An agent
      // on the pre-1.0 surface enumerates under `models` and answers only
      // `session/set_model`.
      const h = harness(wanting);
      h.feed(initializeReply(1));
      h.feed({ id: 2, result: sessionWithModels('composer-2.5', [WANTED]) });

      expect(h.sentMethod('session/set_model')?.params).toEqual({
        sessionId: 's-1',
        modelId: WANTED,
      });
      expect(h.sentMethod('session/set_config_option')).toBeUndefined();
    });

    it('refuses locally against a config-option list that omits the model', () => {
      const h = harness(wanting);
      h.feed(initializeReply(1));
      const events = h.feed({
        id: 2,
        result: sessionWithConfigOptions('composer-2.5', ['gpt-5.2']),
      });

      expect(h.sentMethod('session/set_config_option')).toBeUndefined();
      expect(events).toContainEqual({
        type: 'notice',
        message: `agent does not offer the model '${WANTED}' — this turn runs on the agent's current model instead`,
      });
    });

    describe('a model parameter the current model does not take', () => {
      /**
       * A `session/new` reply shaped like cursor's own: the model option, plus
       * the model's parameters as their own entries under the agent's
       * categories. Values measured on cursor-agent 2026.08.11-e8db854 —
       * `grok-4.6` offers `low|medium|high|xhigh` and no `max`.
       */
      function sessionOffering(
        currentModel: string,
        effortValues: string[] | null,
      ): Record<string, unknown> {
        return {
          sessionId: 's-1',
          configOptions: [
            {
              id: 'model',
              category: 'model',
              currentValue: currentModel,
              options: [{ value: currentModel, name: currentModel }],
            },
            ...(effortValues === null
              ? []
              : [
                  {
                    id: 'effort',
                    category: 'thought_level',
                    currentValue: 'high',
                    options: effortValues.map((value) => ({
                      value,
                      name: value,
                    })),
                  },
                ]),
          ],
        };
      }

      /** A turn already on `grok-4.6`, asking for an effort with it. */
      function turnOn(
        model: string,
        effort: string,
      ): Partial<AcpDriverOptions> {
        return {
          input: { ...BASE_INPUT, model },
          modelSelection: {
            model,
            parameters: [
              // The shape `cursorModelSelection` really produces — every
              // spelling of the axis, so the driver can resolve it.
              {
                id: 'effort',
                value: effort,
                alternateIds: ['effort', 'reasoning'],
              },
            ],
          },
        };
      }

      it('says so, and sends nothing, rather than being refused for it', () => {
        // The report: a cursor chat on Grok with the effort chip left at `max`
        // opened every turn with a red SYSTEM row reading `agent declined model
        // setting 'effort=max': Invalid params` — and then worked normally. The
        // chip is remembered per CLI and `max` is real on `claude-opus-5`, so
        // pointing that chat at Grok asks for a value that model has never had.
        const h = harness(turnOn('grok-4.6', 'max'));
        h.feed(initializeReply(1));
        const events = h.feed({
          id: 2,
          result: sessionOffering('grok-4.6', [
            'low',
            'medium',
            'high',
            'xhigh',
          ]),
        });

        // Not sent at all: the reply on hand describes the model this turn runs
        // on, so the round-trip could only come back refused.
        expect(
          h.sent.filter(
            (frame) =>
              frame.method === 'session/set_config_option' &&
              (frame.params as { configId?: string }).configId === 'effort',
          ),
        ).toEqual([]);
        expect(noticesIn(events)).toEqual([
          {
            type: 'notice',
            severity: 'warning',
            message:
              "this model does not offer 'effort=max' — the turn runs at 'high' (it offers low, medium, high, xhigh)",
          },
        ]);
      });

      it('says it plainly when the model has no such setting at all', () => {
        // `auto-smart` and `composer-2.5` enumerate no `effort` option; the
        // agent's own words for the frame are `Unknown model config option`.
        const h = harness(turnOn('auto-smart', 'max'));
        h.feed(initializeReply(1));
        const events = h.feed({
          id: 2,
          result: sessionOffering('auto-smart', null),
        });

        expect(noticesIn(events)).toEqual([
          {
            type: 'notice',
            severity: 'warning',
            message:
              "this model has no 'effort' setting — the turn runs without it",
          },
        ]);
      });

      it('sends a value the model DOES offer, with no notice', () => {
        const h = harness(turnOn('grok-4.6', 'xhigh'));
        h.feed(initializeReply(1));
        const events = h.feed({
          id: 2,
          result: sessionOffering('grok-4.6', [
            'low',
            'medium',
            'high',
            'xhigh',
          ]),
        });

        expect(
          h.sent.find(
            (frame) =>
              frame.method === 'session/set_config_option' &&
              (frame.params as { configId?: string }).configId === 'effort',
          )?.params,
        ).toEqual({ sessionId: 's-1', configId: 'effort', value: 'xhigh' });
        expect(noticesIn(events)).toEqual([]);
      });

      describe('a spelling no declared id names', () => {
        /**
         * The case that produced this fallback: cursor renamed the axis on the
         * newest model of two families at once (`grok-4.7`,
         * `gemini-3.8-flash`, measured 2026-09-22), under the `thought_level`
         * its older spellings already used. The id here is deliberately one
         * NOBODY has measured — pinning today's list would pin the miss.
         */
        function offering(
          options: Record<string, unknown>[],
        ): Record<string, unknown> {
          return {
            sessionId: 's-1',
            configOptions: [
              {
                id: 'model',
                category: 'model',
                currentValue: 'some-model',
                options: [{ value: 'some-model', name: 'some-model' }],
              },
              ...options,
            ],
          };
        }

        const graded = (id: string): Record<string, unknown> => ({
          id,
          category: 'thought_level',
          currentValue: 'high',
          options: ['low', 'medium', 'high', 'xhigh'].map((value) => ({
            value,
            name: value,
          })),
        });

        /** The OTHER `thought_level` axis — a toggle, on 10 of 37 models. */
        const thinking: Record<string, unknown> = {
          id: 'thinking',
          category: 'thought_level',
          currentValue: 'true',
          options: [
            { value: 'false', name: 'Off' },
            { value: 'true', name: 'On' },
          ],
        };

        function askingFor(value: string): Partial<AcpDriverOptions> {
          return {
            input: { ...BASE_INPUT, model: 'some-model' },
            modelSelection: {
              model: 'some-model',
              parameters: [
                {
                  id: 'effort',
                  value,
                  alternateIds: ['effort', 'reasoning', 'reasoning_effort'],
                  category: 'thought_level',
                },
              ],
            },
          };
        }

        it('is adopted from its category, so the level still goes out', () => {
          const h = harness(askingFor('xhigh'));
          h.feed(initializeReply(1));
          const events = h.feed({
            id: 2,
            result: offering([thinking, graded('deliberation')]),
          });

          expect(
            h.sent.find((frame) => frame.method === 'session/set_config_option')
              ?.params,
          ).toEqual({
            sessionId: 's-1',
            configId: 'deliberation',
            value: 'xhigh',
          });
          expect(noticesIn(events)).toEqual([]);
        });

        it('is never a TOGGLE of that category', () => {
          // `thinking` is `thought_level` too, and adopting it would answer a
          // reasoning level by writing `xhigh` into a `false|true` switch.
          const h = harness(askingFor('xhigh'));
          h.feed(initializeReply(1));
          const events = h.feed({ id: 2, result: offering([thinking]) });

          expect(
            h.sent.filter(
              (frame) => frame.method === 'session/set_config_option',
            ),
          ).toEqual([]);
          expect(noticesIn(events)).toEqual([
            {
              type: 'notice',
              severity: 'warning',
              message:
                "this model has no 'effort' setting — the turn runs without it",
            },
          ]);
        });

        it('adopts nothing when the category holds two candidates', () => {
          // A tie is a coin flip on which axis the user's level is written to,
          // so the caller's own id goes out and the agent answers for it.
          const h = harness(askingFor('xhigh'));
          h.feed(initializeReply(1));
          const events = h.feed({
            id: 2,
            result: offering([graded('deliberation'), graded('rumination')]),
          });

          expect(
            h.sent.filter(
              (frame) => frame.method === 'session/set_config_option',
            ),
          ).toEqual([]);
          expect(noticesIn(events)).toEqual([
            {
              type: 'notice',
              severity: 'warning',
              message:
                "this model has no 'effort' setting — the turn runs without it",
            },
          ]);
        });
      });

      /** A turn switching from grok-4.6 to claude-opus-5, asking for `max`. */
      function switchingToOpus(): { h: Harness; opened: AgentEvent[] } {
        const h = harness(turnOn('claude-opus-5', 'max'));
        h.feed(initializeReply(1));
        const opened = h.feed({
          id: 2,
          result: {
            sessionId: 's-1',
            configOptions: [
              {
                id: 'model',
                category: 'model',
                currentValue: 'grok-4.6',
                options: [
                  { value: 'grok-4.6', name: 'grok' },
                  { value: 'claude-opus-5', name: 'opus' },
                ],
              },
              // Grok's list, which does NOT contain `max` — and must not be
              // read as the incoming model's.
              {
                id: 'effort',
                category: 'thought_level',
                currentValue: 'high',
                options: ['low', 'medium', 'high', 'xhigh'].map((value) => ({
                  value,
                  name: value,
                })),
              },
            ],
          },
        });
        return { h, opened };
      }

      const effortFrame = (h: Harness): Record<string, unknown> | undefined =>
        h.sent.find(
          (frame) =>
            frame.method === 'session/set_config_option' &&
            (frame.params as { configId?: string }).configId === 'effort',
        );

      it('never judges the parameter by the model being switched AWAY from', () => {
        // The session reply describes grok, so it says nothing about the model
        // this turn will run on — its missing `max` is no reason to refuse.
        const { h, opened } = switchingToOpus();
        expect(noticesIn(opened)).toEqual([]);
        const modelFrame = h.sent.find(
          (frame) => frame.method === 'session/set_config_option',
        );

        // A model reply listing no options (`session/set_model`'s own shape)
        // leaves nothing to judge by, so the frame goes out as handed.
        const events = h.feed({ id: modelFrame?.id, result: {} });

        expect(effortFrame(h)?.params).toEqual({
          sessionId: 's-1',
          configId: 'effort',
          value: 'max',
        });
        expect(noticesIn(events)).toEqual([]);
      });

      it('judges it by the NEW model, once the model frame is answered', () => {
        // The model frame's own reply lists the model the turn switched TO, and
        // a parameter is only sent after it — so it is checked against that.
        const { h } = switchingToOpus();
        const modelFrame = h.sent.find(
          (frame) => frame.method === 'session/set_config_option',
        );
        expect(effortFrame(h)).toBeUndefined();

        const events = h.feed({
          id: modelFrame?.id,
          result: {
            configOptions: [
              {
                id: 'effort',
                category: 'thought_level',
                currentValue: 'high',
                options: ['low', 'high'].map((value) => ({
                  value,
                  name: value,
                })),
              },
            ],
          },
        });

        expect(effortFrame(h)).toBeUndefined();
        expect(noticesIn(events)).toEqual([
          {
            type: 'notice',
            severity: 'warning',
            message:
              "this model does not offer 'effort=max' — the turn runs at 'high' (it offers low, high)",
          },
        ]);
      });

      it('sends the spelling THIS model uses, not the one it was handed', () => {
        // One axis, two names, and the model decides which: measured on
        // cursor-agent 2026.08.11-e8db854, `gpt-5.2` enumerates `reasoning`
        // where `grok-4.6` enumerates `effort`, and the wrong name is
        // `-32602 Unknown model config option`. So the OpenAI-family models had
        // an effort picker that could never have applied anything.
        const h = harness({
          input: { ...BASE_INPUT, model: 'gpt-5.2' },
          modelSelection: {
            model: 'gpt-5.2',
            parameters: [
              {
                id: 'effort',
                value: 'high',
                alternateIds: ['effort', 'reasoning'],
              },
            ],
          },
        });
        h.feed(initializeReply(1));
        const events = h.feed({
          id: 2,
          result: {
            sessionId: 's-1',
            configOptions: [
              {
                id: 'model',
                category: 'model',
                currentValue: 'gpt-5.2',
                options: [{ value: 'gpt-5.2', name: 'GPT-5.2' }],
              },
              {
                id: 'reasoning',
                category: 'thought_level',
                currentValue: 'medium',
                options: ['low', 'medium', 'high', 'extra-high'].map(
                  (value) => ({ value, name: value }),
                ),
              },
            ],
          },
        });

        expect(
          h.sent.find((frame) => frame.method === 'session/set_config_option')
            ?.params,
        ).toEqual({ sessionId: 's-1', configId: 'reasoning', value: 'high' });
        expect(noticesIn(events)).toEqual([]);
      });

      it('keeps the id it was handed when the model offers no other spelling', () => {
        // The ordinary case, and the guard against the resolution above turning
        // into a guess: `grok-4.6` has `effort`, so `effort` is what goes out.
        const h = harness(turnOn('grok-4.6', 'xhigh'));
        h.feed(initializeReply(1));
        h.feed({
          id: 2,
          result: sessionOffering('grok-4.6', [
            'low',
            'medium',
            'high',
            'xhigh',
          ]),
        });

        expect(
          h.sent.find((frame) => frame.method === 'session/set_config_option')
            ?.params,
        ).toEqual({ sessionId: 's-1', configId: 'effort', value: 'xhigh' });
      });

      it('asks anyway when the agent enumerated no options at all', () => {
        // Silence is not a refusal — the same contract the model check obeys.
        // Reading it as one would drop every parameter on a pre-1.0 transport.
        const h = harness(turnOn('grok-4.6', 'max'));
        h.feed(initializeReply(1));
        const events = h.feed({
          id: 2,
          result: { sessionId: 's-1', models: { currentModelId: 'grok-4.6' } },
        });

        expect(
          h.sent.find(
            (frame) =>
              frame.method === 'session/set_config_option' &&
              (frame.params as { configId?: string }).configId === 'effort',
          )?.params,
        ).toEqual({ sessionId: 's-1', configId: 'effort', value: 'max' });
        expect(noticesIn(events)).toEqual([]);
      });
    });

    it('reports a refused set_config_option as the same model degrade', () => {
      // The user asked to run on a model; which frame carried that request is
      // not something they should have to learn from the failure line.
      const h = harness(wanting);
      h.feed(initializeReply(1));
      h.feed({
        id: 2,
        result: sessionWithConfigOptions('composer-2.5', [WANTED]),
      });
      const sentId = h.sent.find(
        (frame) => frame.method === 'session/set_config_option',
      )?.id;

      const events = h.feed({
        id: sentId,
        error: { code: -32602, message: 'Invalid model value' },
      });

      expect(events).toEqual([
        {
          type: 'notice',
          message: `agent declined model '${WANTED}': Invalid model value — this turn runs on the agent's current model`,
        },
        { type: 'turn_model', model: 'composer-2.5' },
      ]);
    });
  });
});

describe('AcpSession session modes', () => {
  function sessionWithModes(current: string, available: string[]): unknown {
    return {
      id: 2,
      result: {
        sessionId: 's',
        modes: {
          currentModeId: current,
          availableModes: available.map((id) => ({ id, name: id })),
        },
      },
    };
  }

  it('requests the preferred mode when the agent offers it', () => {
    const h = harness({ preferredModeId: 'plan' });
    h.feed(initializeReply(1));
    h.feed(sessionWithModes('agent', ['agent', 'plan']));
    expect(h.sentMethod('session/set_mode')?.params).toEqual({
      sessionId: 's',
      modeId: 'plan',
    });
  });

  it('spends no round-trip when the mode is absent or already current', () => {
    const absent = harness({ preferredModeId: 'plan' });
    absent.feed(initializeReply(1));
    absent.feed(sessionWithModes('agent', ['agent']));
    expect(absent.sentMethod('session/set_mode')).toBeUndefined();

    const already = harness({ preferredModeId: 'plan' });
    already.feed(initializeReply(1));
    already.feed(sessionWithModes('plan', ['agent', 'plan']));
    expect(already.sentMethod('session/set_mode')).toBeUndefined();
  });

  it('degrades a refused mode to a notice rather than failing the turn', () => {
    const h = harness({ preferredModeId: 'plan' });
    h.feed(initializeReply(1));
    h.feed(sessionWithModes('agent', ['agent', 'plan']));
    const events = h.feed({ id: 3, error: { code: -32602, message: 'no' } });
    expect(events).toEqual([
      {
        type: 'notice',
        // `warning`, not the default: "a degrade, not a failure" is what this
        // arm's own comment has always said, and the severity is what finally
        // keeps the renderer from drawing it as a failed turn.
        severity: 'warning',
        message: "agent declined session mode 'plan': no",
      },
    ]);
  });
});

/** A `session/update` notification wrapping one update payload. */
function update(payload: Record<string, unknown>): unknown {
  return {
    method: 'session/update',
    params: { sessionId: 's', update: payload },
  };
}

function chunk(kind: string, text: string): unknown {
  return update({ sessionUpdate: kind, content: { type: 'text', text } });
}

describe('AcpSession — the CLI going quiet', () => {
  /** A turn whose prompt is out. */
  function promptOut() {
    const h = harness();
    h.feed(initializeReply(h.sentMethod('initialize')?.id as number));
    h.feed({
      id: h.sentMethod('session/new')?.id,
      result: { sessionId: 's1' },
    });
    expect(h.sentMethod('session/prompt')).toBeDefined();
    return h;
  }
  const toolCall = (
    id: string,
    status: string,
    rawInput?: unknown,
  ): unknown => ({
    method: 'session/update',
    params: {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: 'Read',
        kind: 'read',
        status,
        ...(rawInput === undefined ? {} : { rawInput }),
      },
    },
  });
  const toolDone = (id: string): unknown => ({
    method: 'session/update',
    params: {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: 'completed',
      },
    },
  });

  it('closes the open block as its row, once', () => {
    const h = promptOut();
    h.feed(chunk('agent_thought_chunk', 'I will wait.'));

    expect(h.driver.onQuiet()).toEqual([
      { type: 'reasoning', text: 'I will wait.' },
    ]);
    expect(h.driver.onQuiet()).toEqual([]);
  });

  it('starts a new block for what the agent says next', () => {
    const h = promptOut();
    h.feed(chunk('agent_message_chunk', 'first'));
    h.driver.onQuiet();
    h.feed(chunk('agent_message_chunk', 'second'));

    expect(h.driver.onQuiet()).toEqual([{ type: 'text', text: 'second' }]);
  });

  it('answers null while a call it reported is open, and not after', () => {
    const h = promptOut();
    h.feed(toolCall('t1', 'pending', { path: '/a' }));
    expect(h.driver.onQuiet()).toBeNull();

    h.feed(toolDone('t1'));
    expect(h.driver.onQuiet()).toEqual([]);
  });

  it('answers null while a call is still being written', () => {
    const h = promptOut();
    h.feed(toolCall('t1', 'pending'));
    expect(h.driver.onQuiet()).toBeNull();
  });

  it('answers null with no prompt out', () => {
    expect(harness().driver.onQuiet()).toBeNull();
  });

  it('answers null once the user has asked it to stop', () => {
    const h = promptOut();
    h.driver.buildInterruptPayload();
    expect(h.driver.onQuiet()).toBeNull();
  });

  it('answers null while a message waits on the cancel it sent', () => {
    const h = promptOut();
    expect(h.driver.sendFollowUp({ text: 'do X instead' })).toBe(true);
    expect(h.driver.onQuiet()).toBeNull();
  });
});

describe('AcpSession session updates', () => {
  it('streams a message chunk as an ephemeral delta, not a transcript row', () => {
    const h = harness();
    // `text_delta` is EPHEMERAL by contract; `text` is the durable row. A
    // chunk must be the former, or every word of a reply becomes its own row.
    expect(h.feed(chunk('agent_message_chunk', 'hello'))).toEqual([
      { type: 'text_delta', text: 'hello' },
    ]);
  });

  it('closes the answer block and opens a thought block when the agent switches', () => {
    const h = harness();
    h.feed(chunk('agent_message_chunk', 'hello'));
    // The switch is the boundary: the answer is written as one row, and the
    // thought starts a new one rather than merging into it.
    expect(h.feed(chunk('agent_thought_chunk', 'hmm'))).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'reasoning_delta', text: 'hmm' },
    ]);
    expect(h.feed(chunk('agent_message_chunk', 'done'))).toEqual([
      { type: 'reasoning', text: 'hmm' },
      { type: 'text_delta', text: 'done' },
    ]);
  });

  it('streams a thought chunk live as well as buffering it into a row', () => {
    // REPORTED as a cursor chat sitting on "Working…" for three minutes with
    // nothing happening. Thought chunks were arriving the whole time — this
    // driver buffers them until the block closes, and until the ephemeral twin
    // below existed a pure reasoning stretch emitted NOTHING, so the transcript
    // showed the row it draws for an agent that has produced nothing at all.
    const h = harness();
    expect(h.feed(chunk('agent_thought_chunk', 'let me '))).toEqual([
      { type: 'reasoning_delta', text: 'let me ' },
    ]);
    expect(h.feed(chunk('agent_thought_chunk', 'work it out'))).toEqual([
      { type: 'reasoning_delta', text: 'work it out' },
    ]);
    // The durable row is still ONE block, unchanged by the live twin.
    expect(h.feed(chunk('agent_message_chunk', 'answer'))).toEqual([
      { type: 'reasoning', text: 'let me work it out' },
      { type: 'text_delta', text: 'answer' },
    ]);
  });

  it('closes the open block before a tool call, keeping the interleaving', () => {
    const h = harness();
    h.feed(chunk('agent_message_chunk', 'let me look'));
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 't-9',
          title: 'Read',
        }),
      ),
    ).toEqual([
      { type: 'text', text: 'let me look' },
      { type: 'tool_call', id: 't-9', name: 'Read', input: null },
    ]);
  });

  it('ignores a non-text content block instead of emitting an empty row', () => {
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'image', data: 'x' },
        }),
      ),
    ).toEqual([]);
  });

  it('maps a tool call and carries its name onto the result', () => {
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 't-1',
          name: 'read_file',
          title: 'Read file',
          rawInput: { path: 'a.ts' },
        }),
      ),
    ).toEqual([
      {
        type: 'tool_call',
        id: 't-1',
        name: 'read_file',
        input: { path: 'a.ts' },
      },
    ]);

    // The update carries no name — the driver supplies the one it recorded.
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't-1',
          status: 'completed',
          rawOutput: { text: 'ok' },
        }),
      ),
    ).toEqual([
      {
        type: 'tool_result',
        id: 't-1',
        name: 'read_file',
        result: { text: 'ok' },
        isError: false,
      },
    ]);
  });

  it('falls back to the title when a tool call reports no machine name', () => {
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 't-2',
          title: 'Run tests',
        }),
      ),
    ).toEqual([
      { type: 'tool_call', id: 't-2', name: 'Run tests', input: null },
    ]);
  });

  it('reads an EMPTY argument bag as no arguments, not as empty arguments', () => {
    // Measured on cursor-agent 2026.08.04-aaa8809: its read/search/edit calls
    // send `rawInput: {}` on the initial `tool_call` and never send arguments on
    // any later update. Carrying the `{}` through made the transcript render the
    // arguments as `{}` — the reported defect. Null is the honest reading, and
    // it is what lets the renderer omit the body entirely.
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 't-empty',
          title: 'Read File',
          rawInput: {},
        }),
      ),
    ).toEqual([
      { type: 'tool_call', id: 't-empty', name: 'Read File', input: null },
    ]);
  });

  it("carries the agent's OWN classification of the call", () => {
    // Without it the transcript has to recognise this agent's tool NAMES to say
    // what a turn did — and cursor's are "Read File"/"Edit File"/"grep" with no
    // arguments at all, so its group summary read "Used 3 tools" and named none
    // of the work. ACP classifies every call; this is that field reaching the row.
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 't-kind',
          title: 'Edit File',
          kind: 'edit',
          rawInput: {},
        }),
      ),
    ).toEqual([
      {
        type: 'tool_call',
        id: 't-kind',
        name: 'Edit File',
        input: null,
        kind: 'edit',
      },
    ]);
  });

  it('omits the kind entirely when the agent classified nothing', () => {
    // `other` would claim a classification nobody made, and the renderer reads
    // "no kind" as "fall through to the name buckets".
    const h = harness();
    const [event] = h.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't-nokind',
        title: 'Mystery',
      }),
    ) as { kind?: unknown }[];
    expect(event).not.toHaveProperty('kind');
  });

  describe('a call announced before its arguments were written', () => {
    // cursor-agent 2026.09.10-fd3934a opens an MCP call while the model is still
    // writing it — title `MCP: tool`, no arguments — and sends the server, the
    // tool and the arguments in a status-less update (`refreshToolCall`), then
    // `in_progress` as the call starts. REPORTED as a transcript whose every MCP
    // row read `MCP: tool` over no input. Measured over `cursor-agent acp` with a
    // raw frame capture: placeholder at +13980ms, the refresh 2ms later, then
    // `in_progress`, the permission request and `completed` with
    // `rawOutput: {success: true}` — the result body is all it sends.
    const placeholder = {
      sessionUpdate: 'tool_call',
      toolCallId: 'mcp-1',
      title: 'MCP: tool',
      kind: 'other',
      status: 'pending',
      rawInput: {},
    };
    const refresh = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'mcp-1',
      title: 'geniro: update_task',
      rawInput: {
        providerIdentifier: 'geniro',
        toolName: 'update_task',
        args: { status: 'in_review' },
      },
    };

    it('writes the row with the name and arguments the update disclosed', () => {
      const h = harness();
      expect(h.feed(update(placeholder))).toEqual([]);
      expect(h.feed(update(refresh))).toEqual([]);
      expect(
        h.feed(
          update({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'mcp-1',
            status: 'in_progress',
          }),
        ),
      ).toEqual([
        {
          type: 'tool_call',
          id: 'mcp-1',
          name: 'geniro: update_task',
          input: refresh.rawInput,
          kind: 'other',
        },
      ]);
      // And the result is named by what the call turned out to be.
      expect(
        h.feed(
          update({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'mcp-1',
            status: 'completed',
            rawOutput: { success: true },
          }),
        ),
      ).toEqual([
        {
          type: 'tool_result',
          id: 'mcp-1',
          name: 'geniro: update_task',
          result: { success: true },
          isError: false,
        },
      ]);
    });

    it('writes a held call ahead of its result when the agent settles it without starting it', () => {
      const h = harness();
      h.feed(update(placeholder));
      h.feed(update(refresh));
      expect(
        h.feed(
          update({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'mcp-1',
            status: 'failed',
            rawOutput: { error: 'boom' },
          }),
        ),
      ).toEqual([
        {
          type: 'tool_call',
          id: 'mcp-1',
          name: 'geniro: update_task',
          input: refresh.rawInput,
          kind: 'other',
        },
        {
          type: 'tool_result',
          id: 'mcp-1',
          name: 'geniro: update_task',
          result: { error: 'boom' },
          isError: true,
        },
      ]);
    });

    it('writes a held call before the words the agent says after it', () => {
      const h = harness();
      h.feed(update(placeholder));
      expect(h.feed(chunk('agent_message_chunk', 'done'))).toEqual([
        {
          type: 'tool_call',
          id: 'mcp-1',
          name: 'MCP: tool',
          input: null,
          kind: 'other',
        },
        { type: 'text_delta', text: 'done' },
      ]);
    });

    it('writes a held call before a permission card for it', () => {
      const h = harness();
      h.feed(update(placeholder));
      h.feed(update(refresh));
      expect(
        h.feed({
          id: 5,
          method: 'session/request_permission',
          params: {
            sessionId: 's',
            toolCall: { toolCallId: 'mcp-1' },
            options: [
              { optionId: 'o-allow', name: 'Allow', kind: 'allow_once' },
            ],
          },
        }),
      ).toEqual([
        {
          type: 'tool_call',
          id: 'mcp-1',
          name: 'geniro: update_task',
          input: refresh.rawInput,
          kind: 'other',
        },
        {
          type: 'approval_request',
          id: 'n:5',
          toolName: 'geniro: update_task',
          input: refresh.rawInput,
        },
      ]);
    });

    it('writes a held call before the turn settles', () => {
      const h = harness();
      h.feed(initializeReply(1));
      h.feed({ id: 2, result: { sessionId: 's' } });
      h.feed(update(placeholder));
      const events = h.feed({ id: 3, result: { stopReason: 'end_turn' } });
      const types = events.map((event) => event.type);
      expect(types).toContain('tool_call');
      expect(types.indexOf('tool_call')).toBeLessThan(
        types.indexOf('turn_complete'),
      );
    });

    it('releases only up to the call that started, holding the ones still being written', () => {
      const h = harness();
      h.feed(update(placeholder));
      h.feed(update({ ...placeholder, toolCallId: 'mcp-2' }));
      const started = h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'mcp-1',
          status: 'in_progress',
        }),
      );
      expect(started.map((event) => (event as { id?: string }).id)).toEqual([
        'mcp-1',
      ]);
      expect(
        h.feed(
          update({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'mcp-2',
            status: 'in_progress',
          }),
        ),
      ).toEqual([expect.objectContaining({ type: 'tool_call', id: 'mcp-2' })]);
    });

    it('keeps holding a call still being written when a sibling call settles', () => {
      const h = harness();
      h.feed(update({ ...placeholder, toolCallId: '1_tool' }));
      h.feed(
        update({
          ...refresh,
          toolCallId: '1_tool',
          title: 'geniro-83139c58: await_agent',
          rawInput: {
            providerIdentifier: 'geniro-83139c58',
            toolName: 'await_agent',
            args: { call_id: 'call-20' },
          },
        }),
      );
      h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: '1_tool',
          status: 'in_progress',
        }),
      );
      h.feed(update({ ...placeholder, toolCallId: '2_tool' }));
      const settled = h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: '1_tool',
          status: 'completed',
          rawOutput: { success: true },
        }),
      );
      expect(settled).toEqual([
        expect.objectContaining({ type: 'tool_result', id: '1_tool' }),
      ]);
      h.feed(
        update({
          ...refresh,
          toolCallId: '2_tool',
          title: 'geniro-83139c58: list_agent_threads',
          rawInput: {
            providerIdentifier: 'geniro-83139c58',
            toolName: 'list_agent_threads',
            args: {},
          },
        }),
      );
      expect(
        h.feed(
          update({
            sessionUpdate: 'tool_call_update',
            toolCallId: '2_tool',
            status: 'in_progress',
          }),
        ),
      ).toEqual([
        expect.objectContaining({
          type: 'tool_call',
          id: '2_tool',
          name: 'geniro-83139c58: list_agent_threads',
        }),
      ]);
    });

    it('writes a pending call that opens WITH its arguments at once', () => {
      const h = harness();
      expect(
        h.feed(
          update({
            sessionUpdate: 'tool_call',
            toolCallId: 'sh-1',
            title: 'echo hi',
            kind: 'execute',
            status: 'pending',
            rawInput: { command: 'echo hi' },
          }),
        ),
      ).toEqual([
        {
          type: 'tool_call',
          id: 'sh-1',
          name: 'echo hi',
          input: { command: 'echo hi' },
          kind: 'execute',
        },
      ]);
    });
  });

  it('normalizes the diff an edit reports into the shape the row renders', () => {
    // Probed on cursor-agent 2026.08.11-e8db854: an `edit` call sends
    // `rawInput: {}`, never fills it, sends no `locations` — and reports the whole
    // change, path included, as a `diff` content block on the completing update.
    // Passed through raw it rendered as the block ARRAY in JSON, escaped newlines
    // and all; `{diffs}` is what the transcript draws as a diff.
    const h = harness();
    h.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't-diff',
        title: 'Edit File',
        kind: 'edit',
        rawInput: {},
      }),
    );
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't-diff',
          status: 'completed',
          content: [
            {
              type: 'diff',
              path: '/w/notes.txt',
              oldText: 'alpha\nbeta\n',
              newText: 'alpha\nBETA edited\n',
            },
          ],
        }),
      ),
    ).toEqual([
      {
        type: 'tool_result',
        id: 't-diff',
        name: 'Edit File',
        result: {
          diffs: [
            {
              path: '/w/notes.txt',
              oldText: 'alpha\nbeta\n',
              newText: 'alpha\nBETA edited\n',
            },
          ],
        },
        isError: false,
      },
    ]);
  });

  it("prefers the agent's rawOutput over a diff, and passes other content through", () => {
    // Two guards in one: an agent that reports BOTH keeps its own output (the
    // richer answer), and content that is not a diff must reach the row exactly
    // as it did before — the normalization is additive, not a filter.
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't-both',
          status: 'completed',
          rawOutput: { exitCode: 0 },
          content: [{ type: 'diff', path: '/w/a', newText: 'x' }],
        }),
      ),
    ).toMatchObject([{ result: { exitCode: 0 } }]);
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't-text',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
        }),
      ),
    ).toMatchObject([
      { result: [{ type: 'content', content: { type: 'text', text: 'hi' } }] },
    ]);
  });

  it('closes the pair only on a settled tool call', () => {
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't-3',
          status: 'in_progress',
        }),
      ),
    ).toEqual([]);
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't-3',
          status: 'failed',
        }),
      ),
    ).toEqual([
      {
        type: 'tool_result',
        id: 't-3',
        name: null,
        result: null,
        isError: true,
      },
    ]);
  });

  it('harvests the available commands for the composer autocomplete', () => {
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'review', description: 'Review the diff' },
            { name: 'shell', description: null },
            { name: '', description: 'skipped' },
            { description: 'no name' },
          ],
        }),
      ),
    ).toEqual([
      {
        type: 'slash_commands',
        // The DESCRIPTION rides along, because for an ACP agent with no
        // on-disk convention geniro can scan this frame is the only place it
        // exists — reading just the name left every row in the composer's `/`
        // popup a bare word. An entry that reports none stays null.
        commands: [
          { name: 'review', description: 'Review the diff' },
          { name: 'shell', description: null },
        ],
      },
    ]);
  });

  it('ignores updates the transcript does not model', () => {
    const h = harness();
    expect(h.feed(chunk('user_message_chunk', 'our own prompt'))).toEqual([]);
    expect(
      h.feed(
        update({ sessionUpdate: 'config_option_update', configOptions: [] }),
      ),
    ).toEqual([]);
  });

  it('records a mode the AGENT switched to, and draws no row for it', () => {
    // `session/set_mode`'s reply covers a change this client ASKED for and
    // nothing else, so this notification is the only channel reporting the
    // agent moving itself. It is recorded because the mode outlives the turn —
    // `pickMode` reads it to decide whether the next turn needs a frame at all
    // — and it draws nothing, being session state rather than something said.
    //
    // The FIELD is what this pins, deliberately: the adopt emits no event, so
    // an assertion about events holds either way and could not fail on a revert.
    const h = harness();
    expect(h.driver.currentModeId).toBeNull();

    const events = h.feed(
      update({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }),
    );

    expect(h.driver.currentModeId).toBe('plan');
    expect(events).toEqual([]);
  });

  it('leaves the mode alone when the update names none', () => {
    const h = harness();
    h.feed(
      update({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }),
    );

    h.feed(update({ sessionUpdate: 'current_mode_update' }));

    expect(h.driver.currentModeId).toBe('plan');
  });

  it('degrades a malformed notification to no events', () => {
    const h = harness();
    expect(h.feed({ method: 'session/update', params: null })).toEqual([]);
    expect(
      h.feed({ method: 'session/update', params: { update: 'nope' } }),
    ).toEqual([]);
  });
});

describe('AcpSession turn completion', () => {
  /** Drive the handshake so the turn is ready for its prompt reply (id 3). */
  function primed(overrides: Partial<AcpDriverOptions> = {}): Harness {
    const h = harness(overrides);
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 's' } });
    return h;
  }

  it('settles on the FAILURE an agent reported about itself, not on end_turn', () => {
    // The reported screenshot: `Error: RetriableError: [unavailable] PING timed
    // out` in the transcript as the agent's own prose, under `✓ done · 1m 14s`.
    // cursor-agent catches its own transport failure, writes it out as a
    // message chunk and answers `end_turn` regardless — so the stop reason is a
    // statement the CLI has already contradicted.
    const h = primed({
      agentFailure: {
        read: (text) => (text.startsWith('\n\nError: ') ? text.trim() : null),
      },
    });
    h.feed(chunk('agent_message_chunk', 'Found it. The plugin lives at ~/x.'));
    h.feed(
      chunk(
        'agent_message_chunk',
        '\n\nError: RetriableError: [unavailable] PING timed out',
      ),
    );

    // What the agent said BEFORE it died is kept — that is the part the user
    // can act on — and the failure ends the turn INSTEAD of a `turn_complete`,
    // so the run settles once and settles failed.
    expect(h.feed({ id: 3, result: { stopReason: 'end_turn' } })).toEqual([
      { type: 'text', text: 'Found it. The plugin lives at ~/x.' },
      {
        type: 'error',
        message: 'Error: RetriableError: [unavailable] PING timed out',
      },
    ]);
  });

  describe('a failure that is only a dropped connection', () => {
    const DROP =
      '\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)';
    const resumable = (
      delaysMs: readonly number[] = [0, 0],
      maxPerTurn = 10,
    ): Partial<AcpDriverOptions> => ({
      agentFailure: {
        read: (text) => (text.startsWith('\n\nError: ') ? text.trim() : null),
        resume: {
          isTransient: (message) => message.includes('[canceled]'),
          prompt: () => 'continue where you left off',
          delaysMs,
          maxPerTurn,
        },
      },
    });
    const lastPromptId = (h: Harness): number =>
      h.sentAll('session/prompt').at(-1)!.id as number;

    it('resumes the SAME session instead of failing the turn, and the turn then completes', () => {
      // Measured on cursor-agent 2026.08.31: its ACP server runs a turn without
      // the retries its interactive client has, so a dropped stream ended the
      // turn; a continuation prompt on the same session carried it on.
      const h = primed(resumable());
      h.feed(chunk('agent_message_chunk', 'Running the command.'));
      h.feed(chunk('agent_message_chunk', DROP));

      const events = h.feed({ id: 3, result: { stopReason: 'end_turn' } });

      expect(events).toEqual([
        { type: 'text', text: 'Running the command.' },
        expect.objectContaining({
          type: 'notice',
          severity: 'info',
          message: expect.stringContaining('attempt 1 of 2'),
        }),
      ]);
      const resumed = h.sentAll('session/prompt').at(-1)!;
      expect(resumed.params).toEqual({
        sessionId: 's',
        prompt: [{ type: 'text', text: 'continue where you left off' }],
      });

      h.feed(chunk('agent_message_chunk', 'FINISHED'));
      expect(
        h.feed({ id: lastPromptId(h), result: { stopReason: 'end_turn' } }),
      ).toEqual([
        { type: 'text', text: 'FINISHED' },
        expect.objectContaining({ type: 'turn_complete' }),
      ]);
    });

    it('re-sends the brief and its instructions when the request died before the agent did anything', () => {
      // Run 1b0f91aa, call-5: the stream stalled ~66s after a callee's FIRST
      // prompt and cursor had saved none of it — its store held the bare
      // "continue" as the conversation's first user message. With no brief and
      // no role the agent went looking through other sessions' transcripts for
      // something to continue, and finished another conversation's work.
      const h = primed({ ...resumable(), composeSystemPrompt: () => 'ROLE' });
      h.feed(chunk('agent_message_chunk', DROP));

      h.feed({ id: 3, result: { stopReason: 'end_turn' } });

      const resumed = h.sentAll('session/prompt').at(-1)!;
      const text = (
        resumed.params as { prompt: { type: string; text?: string }[] }
      ).prompt
        .map((block) => block.text ?? '')
        .join('\n');
      expect(text).toContain('do the thing');
      expect(text).toContain(hostBlock('ROLE'));
    });

    describe('when the CLI can say what its saved conversation holds', () => {
      const promptText = (h: Harness): string =>
        (
          h.sentAll('session/prompt').at(-1)!.params as {
            prompt: { type: string; text?: string }[];
          }
        ).prompt
          .map((block) => block.text ?? '')
          .join('\n');

      const reading = (
        atResume:
          AcpConversationReading | null | (() => AcpConversationReading | null),
        atPrompt: AcpConversationReading | null = {
          messages: 2,
          userTexts: [],
        },
      ): {
        overrides: Partial<AcpDriverOptions>;
        froms: number[];
      } => {
        const froms: number[] = [];
        const base = resumable();
        const overrides: Partial<AcpDriverOptions> = {
          composeSystemPrompt: () => 'ROLE',
          agentFailure: {
            ...base.agentFailure!,
            resume: {
              ...base.agentFailure!.resume!,
              readConversation: (sessionId, fromMessage) => {
                expect(sessionId).toBe('s');
                froms.push(fromMessage);
                if (fromMessage === Number.MAX_SAFE_INTEGER) {
                  return atPrompt;
                }
                return typeof atResume === 'function' ? atResume() : atResume;
              },
            },
          },
        };
        return { overrides, froms };
      };
      const SAVED_BRIEF = {
        messages: 3,
        userTexts: ['<user_query>\ndo the thing\n</user_query>'],
      };

      it('re-sends the brief when the conversation dropped the request the agent had already acted on', () => {
        const { overrides, froms } = reading({
          messages: 3,
          userTexts: [
            '<user_query>\ncontinue where you left off\n</user_query>',
          ],
        });
        const h = primed(overrides);
        h.feed(chunk('agent_message_chunk', 'Running the command.'));
        h.feed(chunk('agent_message_chunk', DROP));

        h.feed({ id: 3, result: { stopReason: 'end_turn' } });

        expect(froms).toEqual([Number.MAX_SAFE_INTEGER, 2]);
        expect(promptText(h)).toContain('do the thing');
        expect(promptText(h)).toContain(hostBlock('ROLE'));
        expect(promptText(h).endsWith('continue where you left off')).toBe(
          true,
        );
      });

      it('sends the bare continuation when a message added since the prompt holds it', () => {
        const { overrides, froms } = reading({
          messages: 4,
          userTexts: [
            '<timestamp>Friday</timestamp>\n<user_query>\ndo  the\nthing\n</user_query>',
          ],
        });
        const h = primed(overrides);
        h.feed(chunk('agent_message_chunk', DROP));

        h.feed({ id: 3, result: { stopReason: 'end_turn' } });

        expect(froms).toEqual([Number.MAX_SAFE_INTEGER, 2]);
        expect(h.sentAll('session/prompt').at(-1)!.params).toEqual({
          sessionId: 's',
          prompt: [{ type: 'text', text: 'continue where you left off' }],
        });
      });

      it('decides by progress when the conversation cannot be read at the resume', () => {
        const h = primed(reading(null).overrides);
        h.feed(chunk('agent_message_chunk', 'Running the command.'));
        h.feed(chunk('agent_message_chunk', DROP));

        h.feed({ id: 3, result: { stopReason: 'end_turn' } });

        expect(promptText(h)).toBe('continue where you left off');
      });

      it('decides by progress when the conversation could not be read as the prompt went out', () => {
        const { overrides, froms } = reading(SAVED_BRIEF, null);
        const h = primed(overrides);
        h.feed(chunk('agent_message_chunk', DROP));

        h.feed({ id: 3, result: { stopReason: 'end_turn' } });

        expect(froms).toEqual([Number.MAX_SAFE_INTEGER]);
        expect(promptText(h)).toContain('do the thing');
      });

      it('decides by progress for a prompt with no words to look for', () => {
        const h = primed({
          ...reading({ messages: 3, userTexts: [] }).overrides,
          input: { ...BASE_INPUT, prompt: '  \n ' },
        });
        h.feed(chunk('agent_message_chunk', 'Running the command.'));
        h.feed(chunk('agent_message_chunk', DROP));

        h.feed({ id: 3, result: { stopReason: 'end_turn' } });

        expect(promptText(h)).toBe('continue where you left off');
      });

      it('does not take a saved continuation for a short prompt it contains', () => {
        const readings = [
          { messages: 3, userTexts: ['<user_query>\nfiller\n</user_query>'] },
          {
            messages: 4,
            userTexts: [
              '<user_query>\nfiller\n</user_query>',
              '<user_query>\ncontinue where you left off\n</user_query>',
            ],
          },
        ];
        const h = primed({
          ...reading(() => readings.shift() ?? null).overrides,
          input: { ...BASE_INPUT, prompt: 'continue' },
        });
        h.feed(chunk('agent_message_chunk', 'Step one.'));
        h.feed(chunk('agent_message_chunk', DROP));
        h.feed({ id: 3, result: { stopReason: 'end_turn' } });
        h.feed(chunk('agent_message_chunk', 'Step two.'));
        h.feed(chunk('agent_message_chunk', DROP));

        h.feed({ id: lastPromptId(h), result: { stopReason: 'end_turn' } });

        expect(promptText(h)).not.toBe('continue where you left off');
        expect(promptText(h)).toContain(hostBlock('ROLE'));
      });

      it('decides by progress when the reader throws', () => {
        const h = primed(
          reading(() => {
            throw new Error('store moved');
          }).overrides,
        );
        h.feed(chunk('agent_message_chunk', DROP));

        h.feed({ id: 3, result: { stopReason: 'end_turn' } });

        expect(promptText(h)).toContain('do the thing');
      });
    });

    it('reports the drop as the turn’s failure once the attempts are spent', () => {
      const h = primed(resumable([0]));
      h.feed(chunk('agent_message_chunk', DROP));
      h.feed({ id: 3, result: { stopReason: 'end_turn' } });

      h.feed(chunk('agent_message_chunk', DROP));
      expect(
        h.feed({ id: lastPromptId(h), result: { stopReason: 'end_turn' } }),
      ).toEqual([{ type: 'error', message: DROP.trim() }]);
      expect(h.sentAll('session/prompt')).toHaveLength(2);
    });

    it('still stops consecutive failures with no progress between them', () => {
      const h = primed(resumable([0, 0]));
      h.feed(chunk('agent_message_chunk', DROP));
      h.feed({ id: 3, result: { stopReason: 'end_turn' } });

      h.feed(chunk('agent_message_chunk', DROP));
      h.feed({ id: lastPromptId(h), result: { stopReason: 'end_turn' } });

      h.feed(chunk('agent_message_chunk', DROP));
      expect(
        h.feed({ id: lastPromptId(h), result: { stopReason: 'end_turn' } }),
      ).toEqual([{ type: 'error', message: DROP.trim() }]);
      expect(h.sentAll('session/prompt')).toHaveLength(3);
    });

    it('gives a failure after progress a fresh budget', () => {
      const h = primed(resumable([0]));
      h.feed(chunk('agent_message_chunk', DROP));
      h.feed({ id: 3, result: { stopReason: 'end_turn' } });

      h.feed(chunk('agent_message_chunk', 'Ran the second step.'));
      h.feed(chunk('agent_message_chunk', DROP));
      const events = h.feed({
        id: lastPromptId(h),
        result: { stopReason: 'end_turn' },
      });

      expect(h.sentAll('session/prompt')).toHaveLength(3);
      expect(h.sentAll('session/prompt').at(-1)!.params).toEqual({
        sessionId: 's',
        prompt: [{ type: 'text', text: 'continue where you left off' }],
      });
      expect(events).toEqual([
        { type: 'text', text: 'Ran the second step.' },
        expect.objectContaining({
          type: 'notice',
          message: expect.stringContaining('attempt 1 of 1'),
        }),
      ]);
    });

    it('stops at the per-turn ceiling however much progress came between', () => {
      const h = primed(resumable([0], 2));
      h.feed(chunk('agent_message_chunk', 'First step.'));
      h.feed(chunk('agent_message_chunk', DROP));
      h.feed({ id: 3, result: { stopReason: 'end_turn' } });

      h.feed(chunk('agent_message_chunk', 'Second step.'));
      h.feed(chunk('agent_message_chunk', DROP));
      h.feed({ id: lastPromptId(h), result: { stopReason: 'end_turn' } });
      expect(h.sentAll('session/prompt')).toHaveLength(3);

      h.feed(chunk('agent_message_chunk', 'Third step.'));
      h.feed(chunk('agent_message_chunk', DROP));
      expect(
        h.feed({ id: lastPromptId(h), result: { stopReason: 'end_turn' } }),
      ).toEqual([
        { type: 'text', text: 'Third step.' },
        { type: 'error', message: DROP.trim() },
      ]);
      expect(h.sentAll('session/prompt')).toHaveLength(3);
    });

    it('restarts the pause from its first entry after progress', () => {
      vi.useFakeTimers();
      try {
        const h = primed(resumable([15_000, 60_000]));
        h.feed(chunk('agent_message_chunk', DROP));
        h.feed({ id: 3, result: { stopReason: 'end_turn' } });
        vi.advanceTimersByTime(15_000);
        expect(h.sentAll('session/prompt')).toHaveLength(2);

        h.feed(chunk('agent_message_chunk', 'Ran the second step.'));
        h.feed(chunk('agent_message_chunk', DROP));
        expect(
          h.feed({ id: lastPromptId(h), result: { stopReason: 'end_turn' } }),
        ).toEqual([
          { type: 'text', text: 'Ran the second step.' },
          expect.objectContaining({
            type: 'notice',
            severity: 'info',
            message: expect.stringContaining(
              'trying again in 15s (attempt 1 of 2)',
            ),
          }),
        ]);
        vi.advanceTimersByTime(15_000);
        expect(h.sentAll('session/prompt')).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits its pause before resuming, and says when it will try again', () => {
      // Sent back to back, every attempt that meets the same outage dies on
      // the CLI's own 30s stall — three spent 90s inside one two-minute Cursor
      // outage (run f1fa241c). The pause is what lets the budget outlast it.
      vi.useFakeTimers();
      try {
        const h = primed(resumable([15_000]));
        h.feed(chunk('agent_message_chunk', 'Running the command.'));
        h.feed(chunk('agent_message_chunk', DROP));

        expect(h.feed({ id: 3, result: { stopReason: 'end_turn' } })).toEqual([
          { type: 'text', text: 'Running the command.' },
          expect.objectContaining({
            type: 'notice',
            severity: 'info',
            message: expect.stringContaining(
              'trying again in 15s (attempt 1 of 1)',
            ),
          }),
        ]);
        vi.advanceTimersByTime(14_999);
        expect(h.sentAll('session/prompt')).toHaveLength(1);

        vi.advanceTimersByTime(1);
        expect(h.sentAll('session/prompt')).toHaveLength(2);
        expect(h.sentAll('session/prompt').at(-1)!.params).toEqual({
          sessionId: 's',
          prompt: [{ type: 'text', text: 'continue where you left off' }],
        });
        h.feed(chunk('agent_message_chunk', 'FINISHED'));
        expect(
          h.feed({ id: lastPromptId(h), result: { stopReason: 'end_turn' } }),
        ).toEqual([
          { type: 'text', text: 'FINISHED' },
          expect.objectContaining({ type: 'turn_complete' }),
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ends the turn on a Stop pressed during the pause, sending nothing more', () => {
      // The failed prompt has already answered and the next is not out, so a
      // session/cancel would cancel nothing: the pause itself is withdrawn,
      // which is the path spawn-cli settles as a cancellation.
      vi.useFakeTimers();
      try {
        const h = primed(resumable([60_000]));
        h.feed(chunk('agent_message_chunk', DROP));
        h.feed({ id: 3, result: { stopReason: 'end_turn' } });

        expect(h.driver.withdrawHeldPrompt()).toBe(true);
        vi.advanceTimersByTime(60_000);

        expect(h.sentAll('session/prompt')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('calls the pending resume off when a message is pushed through during the pause', () => {
      // The user's message carries the turn on by itself. Fired later, the
      // resume would supersede it on this CLI — whose follow-up interrupts —
      // or start a prompt nobody asked for once it had ended the turn.
      vi.useFakeTimers();
      try {
        const h = primed(resumable([60_000]));
        h.feed(chunk('agent_message_chunk', DROP));
        h.feed({ id: 3, result: { stopReason: 'end_turn' } });

        expect(
          h.driver.sendFollowUp({ text: 'actually, stop here', images: [] }),
        ).toBe(true);
        vi.advanceTimersByTime(60_000);

        const prompts = h.sentAll('session/prompt');
        expect(prompts).toHaveLength(2);
        expect(JSON.stringify(prompts[1])).toContain('actually, stop here');
      } finally {
        vi.useRealTimers();
      }
    });

    it('resumes a drop the prompt answers as an error reply, keeping what the agent said', () => {
      // cursor-agent 2026.10.19-6bbf2c4 (run 0d6b2220): a drop inside its
      // background-task drain escapes the catch block that writes `Error: …`,
      // so the prompt answers `-32603` with the cause under `data.details`.
      const h = primed(resumable());
      h.feed(chunk('agent_message_chunk', 'Reading the diff.'));

      const events = h.feed({
        id: 3,
        error: {
          code: -32603,
          message: 'Internal error',
          data: { details: '[canceled] http/2 stream closed' },
        },
      });

      expect(events).toEqual([
        { type: 'text', text: 'Reading the diff.' },
        expect.objectContaining({
          type: 'notice',
          message: expect.stringContaining('attempt 1 of 2'),
        }),
      ]);
      expect(h.sentAll('session/prompt').at(-1)!.params).toEqual({
        sessionId: 's',
        prompt: [{ type: 'text', text: 'continue where you left off' }],
      });
      h.feed(chunk('agent_message_chunk', 'FINISHED'));
      expect(
        h.feed({ id: lastPromptId(h), result: { stopReason: 'end_turn' } }),
      ).toEqual([
        { type: 'text', text: 'FINISHED' },
        expect.objectContaining({ type: 'turn_complete' }),
      ]);
    });

    it('fails the turn on an error reply that is not a drop', () => {
      const h = primed(resumable());
      h.feed(RUNNING_STEP);

      expect(
        h.feed({
          id: 3,
          error: {
            code: -32603,
            message: 'Internal error',
            data: { details: 'Input token limit exceeded' },
          },
        }),
      ).toEqual([
        {
          type: 'tool_result',
          id: 't1',
          name: 'Run tests',
          result: CUT_OFF_TOOL_RESULT,
          isError: true,
        },
        {
          type: 'error',
          message:
            'acp prompt failed: Internal error: Input token limit exceeded',
        },
      ]);
      expect(h.sentAll('session/prompt')).toHaveLength(1);
    });

    it('forgets a reported drop once the agent carries on past it', () => {
      // cursor-agent drains background-task completions after reporting a
      // failure, and that drain continues the conversation in the same prompt.
      const h = primed(resumable());
      h.feed(chunk('agent_message_chunk', DROP));
      h.feed(chunk('agent_message_chunk', 'Launching the reviewers.'));

      expect(h.feed({ id: 3, result: { stopReason: 'end_turn' } })).toEqual([
        { type: 'text', text: 'Launching the reviewers.' },
        expect.objectContaining({ type: 'turn_complete' }),
      ]);
      expect(h.sentAll('session/prompt')).toHaveLength(1);
    });

    it('does not resume a failure that is not a dropped connection', () => {
      // `[internal] Input token limit exceeded` is a RetriableError too, and a
      // continuation would only hit the same limit again.
      const h = primed(resumable());
      h.feed(
        chunk(
          'agent_message_chunk',
          '\n\nError: RetriableError: [internal] Input token limit exceeded',
        ),
      );
      expect(h.feed({ id: 3, result: { stopReason: 'end_turn' } })).toEqual([
        {
          type: 'error',
          message:
            'Error: RetriableError: [internal] Input token limit exceeded',
        },
      ]);
      expect(h.sentAll('session/prompt')).toHaveLength(1);
    });

    /** A step the failed request was still running when it died. */
    const RUNNING_STEP = update({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Run tests',
      status: 'in_progress',
      rawInput: { command: 'pnpm test' },
    });

    it('marks an unwatchable delegate untracked when its parent request fails', () => {
      const h = primed({ ...resumable(), delegate: UNWATCHABLE_DELEGATE });
      h.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'delegate',
          title: 'Review',
          status: 'in_progress',
          rawInput: { _toolName: 'task' },
        }),
      );
      h.feed(chunk('agent_message_chunk', DROP));
      const events = h.feed({ id: 3, result: { stopReason: 'end_turn' } });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'subagent_info',
          id: 'delegate',
          backgroundOutcome: 'untracked',
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool_result',
          id: 'delegate',
          isError: false,
        }),
      );
    });

    it('closes a step the failed request left open, which the agent never will', () => {
      // Read out of cursor-agent 2026.10.01-e373342: when its run throws it
      // writes `Error: …`, answers `end_turn`, and sends no `tool_call_update`
      // for a call still running — so the row read as running for the rest of
      // the conversation (run a8f5fb5f, two blocks spinning above the retry).
      const h = primed(resumable());
      h.feed(RUNNING_STEP);
      h.feed(chunk('agent_message_chunk', DROP));

      const events = h.feed({ id: 3, result: { stopReason: 'end_turn' } });

      expect(events).toContainEqual({
        type: 'tool_result',
        id: 't1',
        name: 'Run tests',
        result: CUT_OFF_TOOL_RESULT,
        isError: true,
      });
      // Closed AHEAD of the resume notice: the step belongs to the request
      // that failed, not to the one carrying the turn on.
      const kinds = events.map((event) => event.type);
      expect(kinds.indexOf('tool_result')).toBeLessThan(
        kinds.indexOf('notice'),
      );
    });

    it('closes it on a failure that is not resumed, too', () => {
      const h = primed(resumable());
      h.feed(RUNNING_STEP);
      h.feed(
        chunk(
          'agent_message_chunk',
          '\n\nError: RetriableError: [internal] Input token limit exceeded',
        ),
      );

      expect(h.feed({ id: 3, result: { stopReason: 'end_turn' } })).toEqual([
        {
          type: 'tool_result',
          id: 't1',
          name: 'Run tests',
          result: CUT_OFF_TOOL_RESULT,
          isError: true,
        },
        {
          type: 'error',
          message:
            'Error: RetriableError: [internal] Input token limit exceeded',
        },
      ]);
    });

    it('tells the continuation prompt nothing about sub-agents when the request caught none', () => {
      const prompt = vi.fn(() => 'continue');
      const h = primed({
        agentFailure: {
          read: (text) => (text.startsWith('\n\nError: ') ? text.trim() : null),
          resume: {
            isTransient: (message) => message.includes('[canceled]'),
            prompt,
            delaysMs: [0],
            maxPerTurn: 10,
          },
        },
      });
      h.feed(RUNNING_STEP);
      h.feed(chunk('agent_message_chunk', DROP));
      h.feed({ id: 3, result: { stopReason: 'end_turn' } });

      // An ordinary step is not a sub-agent: closing it is the whole answer,
      // and the prompt says only "continue".
      expect(prompt).toHaveBeenCalledWith({ stillRunning: [], finished: [] });
      expect(h.sentAll('session/prompt')).toHaveLength(2);
    });
  });

  it('keeps the failure OUT of the answer the turn reports', () => {
    // `finalText` is what a caller consumes as this member's
    // output. A turn that produced no answer must not hand one the transport
    // error as one — which is what pushing the chunk onto `textChunks` would
    // do, silently, since the row it also draws would look right.
    const h = primed({
      agentFailure: { read: (text) => (text.includes('boom') ? 'boom' : null) },
    });
    h.feed(chunk('agent_message_chunk', 'boom'));
    const events = h.feed({ id: 3, result: { stopReason: 'end_turn' } });

    expect(events).toEqual([{ type: 'error', message: 'boom' }]);
    expect(events.some((event) => event.type === 'turn_complete')).toBe(false);
  });

  it('leaves a turn alone when the adapter declares no such channel', () => {
    // Every agent whose failures reach the protocol, and the default: the same
    // chunk is the agent talking, and stays an ordinary answer.
    const h = primed();
    h.feed(chunk('agent_message_chunk', '\n\nError: RetriableError: nope'));

    expect(h.feed({ id: 3, result: { stopReason: 'end_turn' } })).toEqual([
      { type: 'text', text: '\n\nError: RetriableError: nope' },
      expect.objectContaining({
        type: 'turn_complete',
        finalText: '\n\nError: RetriableError: nope',
      }),
    ]);
  });

  it('completes with the stop reason and the accumulated answer text', () => {
    const h = primed();
    h.feed(chunk('agent_message_chunk', 'part one '));
    h.feed(chunk('agent_message_chunk', 'part two'));
    // The joined `text` row is the regression pin: a durable event per chunk
    // put a real cursor reply into the transcript as 68 one-word rows.
    expect(h.feed({ id: 3, result: { stopReason: 'end_turn' } })).toEqual([
      { type: 'text', text: 'part one part two' },
      {
        type: 'turn_complete',
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          thinkingTokens: null,
          contextTokens: null,
          contextWindowTokens: null,
          contextModel: null,
          costUsd: null,
          // ACP has no turn-timing channel at all, so the driver reports none
          // rather than passing off its own wall clock as the agent's figure.
          durationMs: null,
          apiMs: null,
          ttftMs: null,
          timeToRequestMs: null,
          numTurns: null,
        },
        stopReason: 'end_turn',
        finalText: 'part one part two',
      },
    ]);
  });

  it('reports a cancelled turn as cancelled, never as a completion', () => {
    const h = primed();
    h.feed(chunk('agent_message_chunk', 'half an answer'));
    expect(h.feed({ id: 3, result: { stopReason: 'cancelled' } })).toEqual([
      { type: 'text', text: 'half an answer' },
      { type: 'turn_cancelled' },
    ]);
  });

  it('keeps a non-end_turn stop reason as a completion', () => {
    const h = primed();
    const [event] = h.feed({ id: 3, result: { stopReason: 'max_tokens' } });
    expect(event).toMatchObject({
      type: 'turn_complete',
      stopReason: 'max_tokens',
    });
  });

  it('combines the prompt reply tokens with the streamed context usage', () => {
    const h = primed();
    h.feed(
      update({
        sessionUpdate: 'usage_update',
        used: 4200,
        size: 200_000,
        cost: { amount: 0.42, currency: 'USD' },
      }),
    );
    const [event] = h.feed({
      id: 3,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      },
    });
    expect(event).toMatchObject({
      type: 'turn_complete',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        thinkingTokens: null,
        contextTokens: 4200,
        contextWindowTokens: null,
        contextModel: null,
        costUsd: 0.42,
      },
    });
    // The occupancy the agent stated is not an estimate.
    expect(event).not.toHaveProperty('usage.contextEstimated');
  });

  it('falls back to the input count when no usage_update ever arrived', () => {
    const h = primed();
    const [event] = h.feed({
      id: 3,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 77, outputTokens: 1 },
      },
    });
    expect(event).toMatchObject({
      usage: { contextTokens: 77, contextEstimated: true },
    });
  });

  it('refuses to report a non-USD cost in the costUsd field', () => {
    const h = primed();
    h.feed(
      update({
        sessionUpdate: 'usage_update',
        used: 10,
        size: 100,
        cost: { amount: 5, currency: 'EUR' },
      }),
    );
    const [event] = h.feed({ id: 3, result: { stopReason: 'end_turn' } });
    expect(event).toMatchObject({
      usage: { costUsd: null, contextTokens: 10, contextWindowTokens: null },
    });
  });

  it('reports no final text when the agent streamed none', () => {
    const h = primed();
    const [event] = h.feed({ id: 3, result: { stopReason: 'end_turn' } });
    expect(event).toMatchObject({ finalText: null });
  });
});

describe('AcpSession off-protocol context reading', () => {
  const READING = {
    usedTokens: 101_100,
    windowTokens: 200_000,
    model: 'cursor-grok-4.6',
  };
  const PROGRESS = {
    type: 'context_progress',
    contextTokens: 101_100,
    contextWindowTokens: 200_000,
    contextModel: 'cursor-grok-4.6',
  };

  /** Drive the handshake, returning the events the session reply produced. */
  function opened(overrides: Partial<AcpDriverOptions>): {
    h: Harness;
    onSession: AgentEvent[];
  } {
    const h = harness(overrides);
    h.feed(initializeReply(1));
    return { h, onSession: h.feed({ id: 2, result: { sessionId: 's' } }) };
  }

  it('reports the window BEFORE the prompt, so a resumed chat is scaled at once', () => {
    // ACP carries no context accounting, so an agent whose figures live off
    // protocol had none until its turn ended: the reported cursor chat showed a
    // full breakdown in the panel behind a ring that had never been given a
    // reading. Taken at the session reply — the prompt has not gone out yet.
    const { onSession } = opened({ readContext: () => READING });
    expect(onSession).toContainEqual(PROGRESS);
  });

  it('takes a fresh reading AHEAD of the turn_complete that settles the run', () => {
    // Order is the assertion: the live plane a reading rides is cleared when the
    // run settles, so one emitted after `turn_complete` would be published into
    // a state the client has already been told to drop.
    const { h } = opened({ readContext: () => READING });
    const events = h.feed({ id: 3, result: { stopReason: 'end_turn' } });
    const reading = events.findIndex((e) => e.type === 'context_progress');
    const complete = events.findIndex((e) => e.type === 'turn_complete');
    expect(reading).toBeGreaterThanOrEqual(0);
    expect(reading).toBeLessThan(complete);
  });

  it('says nothing when the source has no used figure yet', () => {
    // A session the CLI has not written to — a fresh conversation's first turn.
    // An empty window is not a reading of zero, and a ring drawn at 0% would be
    // a claim rather than a silence.
    const { h, onSession } = opened({
      readContext: () => ({
        usedTokens: null,
        windowTokens: 200_000,
        model: null,
      }),
    });
    expect(onSession.some((e) => e.type === 'context_progress')).toBe(false);
    expect(
      h
        .feed({ id: 3, result: { stopReason: 'end_turn' } })
        .some((e) => e.type === 'context_progress'),
    ).toBe(false);
  });

  it('carries the reading into turn_complete, so the ring survives the turn', () => {
    // THE REPORTED DEFECT: "cursor's little circle works wrong — it doesn't
    // sync with the context", against a chat whose panel read 140.7k of
    // 200k with an empty ring beside it. Emitting the reading was only half of
    // it — the live plane is dropped when the run settles, so the ring was fed
    // for the length of a turn and blank between turns, which is when anyone
    // looks. The durable row has to carry the same figures.
    const { h } = opened({ readContext: () => READING });
    const complete = h
      .feed({ id: 3, result: { stopReason: 'end_turn' } })
      .find((event) => event.type === 'turn_complete');

    expect(complete?.usage).toMatchObject({
      contextTokens: 101_100,
      contextWindowTokens: 200_000,
      contextModel: 'cursor-grok-4.6',
    });
  });

  it('lets the wire’s own occupancy outrank the off-protocol reading', () => {
    // `usage_update.used` is the agent stating its occupancy in protocol; the
    // reading is the same quantity taken out of its files. Both beat
    // `inputTokens`, which measures one request rather than the window — but a
    // figure the agent SENT is the one to believe.
    const { h } = opened({ readContext: () => READING });
    h.feed({
      method: 'session/update',
      params: {
        sessionId: 's',
        update: { sessionUpdate: 'usage_update', used: 42_000 },
      },
    });
    const complete = h
      .feed({ id: 3, result: { stopReason: 'end_turn' } })
      .find((event) => event.type === 'turn_complete');

    expect(complete?.usage?.contextTokens).toBe(42_000);
    // The WINDOW still comes from the reading: this frame carries no `size`,
    // and the arm does not read one even when a frame does, so dropping the
    // reading here would leave the ring a count with no denominator.
    expect(complete?.usage?.contextWindowTokens).toBe(200_000);
  });

  it('claims no window at all for an agent with no reading', () => {
    // Every other ACP agent. No shipped one here has been observed stating a
    // window — the protocol defines `size` on `usage_update` and none sends the
    // frame — so the consumer must show the count bare rather than have this
    // client invent a denominator, the rule the meter's own "no assumed 200k"
    // note keeps.
    const { h } = opened({});
    const complete = h
      .feed({ id: 3, result: { stopReason: 'end_turn' } })
      .find((event) => event.type === 'turn_complete');

    expect(complete?.usage?.contextWindowTokens).toBeNull();
    expect(complete?.usage?.contextModel).toBeNull();
  });

  /** One ordinary `session/update` — the carrier of the mid-turn re-read. */
  function chunk(text: string): Record<string, unknown> {
    return {
      method: 'session/update',
      params: {
        sessionId: 's',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      },
    };
  }

  describe('while the turn is still running', () => {
    // The interval is wall-clock, so these drive the clock rather than wait on
    // it. Every one of them starts from a session reply that has already taken
    // its own reading — which arms the interval, as any read does.
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('fills the ring MID-turn, not only once the first turn has ended', () => {
      // THE REPORTED DEFECT: a newly-started chat "still hadn't loaded any
      // context, and loaded it only later". The two readings this driver used
      // to take are both BOUNDARIES — the session reply, where a conversation
      // the agent has never held has written nothing to read, and the settle —
      // so a first turn ran to completion with an empty ring above it. Measured
      // on a fresh cursor chat: the store held a complete reading 18.2s in.
      let written = false;
      const { h, onSession } = opened({
        readContext: () => (written ? READING : null),
      });
      expect(onSession.some((e) => e.type === 'context_progress')).toBe(false);

      written = true;
      vi.advanceTimersByTime(5_000);
      expect(h.feed(chunk('working on it'))).toContainEqual(PROGRESS);
    });

    it('re-reads at most once per interval, however chatty the agent is', () => {
      // A turn streams its answer a word at a time, and each reading published
      // is a socket emission to every client watching the run.
      const readContext = vi.fn(() => READING);
      const { h } = opened({ readContext });
      expect(readContext).toHaveBeenCalledTimes(1); // the session reply

      h.feed(chunk('one'));
      h.feed(chunk('two'));
      expect(readContext).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5_000);
      h.feed(chunk('three'));
      h.feed(chunk('four'));
      expect(readContext).toHaveBeenCalledTimes(2);
    });

    it('publishes a mid-turn reading only once the figure has MOVED', () => {
      let reading = READING;
      const { h } = opened({ readContext: () => reading });

      vi.advanceTimersByTime(5_000);
      expect(
        h.feed(chunk('same window')).some((e) => e.type === 'context_progress'),
      ).toBe(false);

      reading = { ...READING, usedTokens: 133_700 };
      vi.advanceTimersByTime(5_000);
      expect(h.feed(chunk('grown'))).toContainEqual({
        ...PROGRESS,
        contextTokens: 133_700,
      });
    });
  });

  it('survives a source that throws — a meter is not worth a failed turn', () => {
    const warn = vi.fn();
    const { h, onSession } = opened({
      readContext: () => {
        throw new Error('store is locked');
      },
      logger: { warn },
    });
    expect(onSession.some((e) => e.type === 'context_progress')).toBe(false);
    // …and the turn still finishes normally rather than dying on the readout.
    expect(
      h.feed({ id: 3, result: { stopReason: 'end_turn' } }),
    ).toContainEqual(
      expect.objectContaining({
        type: 'turn_complete',
        stopReason: 'end_turn',
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('store is locked'),
    );
  });
});

describe('AcpSession — a parameter the turn must not start without', () => {
  /** A session already on the turn's model, offering a `context` axis. */
  function sessionOfferingContext(): Record<string, unknown> {
    return {
      sessionId: 's-1',
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'claude-opus-5',
          options: [{ value: 'claude-opus-5', name: 'claude-opus-5' }],
        },
        {
          id: 'context',
          category: 'model_config',
          currentValue: '300k',
          options: [
            { value: '300k', name: '300K' },
            { value: '1m', name: '1M' },
          ],
        },
      ],
    };
  }

  function turnAsking(promptAwaitsConfig: boolean): Partial<AcpDriverOptions> {
    return {
      promptAwaitsConfig,
      input: { ...BASE_INPUT, model: 'claude-opus-5' },
      modelSelection: {
        model: 'claude-opus-5',
        parameters: [{ id: 'context', value: '1m' }],
      },
    };
  }

  const methods = (frames: Record<string, unknown>[]): unknown[] =>
    frames.map((frame) => frame.method);

  it('holds the prompt until the agent has answered the frame', () => {
    // MEASURED, not defensive: cursor binds the window when the TURN begins, so
    // the identical frames pipelined behind the prompt leave it on the model's
    // default (300,000) while awaited they give the 1,000,000 asked for — with
    // the reply confirming `context = 1m` either way. Nothing but the timing
    // separates the two.
    const h = harness(turnAsking(true));
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: sessionOfferingContext() });

    // The parameter went out; the prompt did NOT.
    expect(methods(h.sent)).toContain('session/set_config_option');
    expect(methods(h.sent)).not.toContain('session/prompt');

    h.feed({ id: 3, result: { configOptions: [] } });
    expect(methods(h.sent)).toContain('session/prompt');
  });

  it('sends the prompt straight away for an agent that does not ask', () => {
    // An agent that reads its settings per request keeps the pipeline — one
    // ordered stdio stream already puts the frames in order, and deferring
    // behind a reply costs a round trip (~1.7–2.0s on cursor) per turn.
    const h = harness(turnAsking(false));
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: sessionOfferingContext() });

    expect(methods(h.sent)).toContain('session/prompt');
  });

  it('releases the prompt when the agent REFUSES the frame', () => {
    // A turn must not be stranded behind a setting that was never going to
    // land. The refusal is narrated; the turn runs on what the agent kept.
    const h = harness(turnAsking(true));
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: sessionOfferingContext() });
    expect(methods(h.sent)).not.toContain('session/prompt');

    const events = h.feed({
      id: 3,
      error: { code: -32602, message: 'Invalid params' },
    });

    expect(methods(h.sent)).toContain('session/prompt');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        severity: 'warning',
      }),
    );
  });

  it('releases the prompt when the agent never answers the frame at all', () => {
    // The refusal above is the agent SAYING no; this is it saying nothing, and
    // the two must end the same way. A held turn emits nothing while it waits,
    // so a frame that was never going to be answered stranded the prompt in
    // total silence — until the turn-level silence deadline gave up on the
    // whole turn half an hour later.
    //
    // Its own fake timers: the only `vi.useFakeTimers()` in this file is scoped
    // to a nested describe elsewhere, so nothing here inherits them.
    vi.useFakeTimers();
    try {
      const h = harness(turnAsking(true));
      h.feed(initializeReply(1));
      h.feed({ id: 2, result: sessionOfferingContext() });
      expect(methods(h.sent)).not.toContain('session/prompt');

      vi.advanceTimersByTime(30_000);

      expect(methods(h.sent)).toContain('session/prompt');
      expect(h.emitted).toContainEqual(
        expect.objectContaining({ type: 'notice', severity: 'warning' }),
      );
      // Nothing was torn down: an `error` is how this turn would have ENDED,
      // and the whole point is that it runs on the agent's own settings instead.
      expect(h.emitted).not.toContainEqual(
        expect.objectContaining({ type: 'error' }),
      );
      // Still able to serve the turn it released — which is the liveness claim
      // that matters here, the session having no flag to read one off.
      const promptId = h.sent.find(
        (frame) => frame.method === 'session/prompt',
      )?.id;
      expect(
        h.feed({ id: promptId, result: { stopReason: 'end_turn' } }),
      ).toContainEqual(expect.objectContaining({ type: 'turn_complete' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays silent for a frame that never held the prompt', () => {
    // Every parameter goes out under the one `set_model_parameter` kind while
    // the last one blocks only for a `promptAwaitsConfig` agent, so on any
    // other the armed frame has nothing to rescue. Speaking anyway is worse than silence: an event emitted after
    // the turn settles reaches the off-turn handler, which reads a `notice` as
    // the run working again with no terminal left to take the badge back down.
    vi.useFakeTimers();
    try {
      const h = harness(turnAsking(false));
      h.feed(initializeReply(1));
      h.feed({ id: 2, result: sessionOfferingContext() });
      // The frame went out and the prompt did NOT wait for it.
      expect(methods(h.sent)).toContain('session/set_config_option');
      expect(methods(h.sent)).toContain('session/prompt');
      const settled = h.emitted.length;

      vi.advanceTimersByTime(30_000);

      expect(h.emitted).toHaveLength(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing when the turn it would narrate is already gone', () => {
    // The session outlives its turns and gets no settle signal, so a deadline
    // can fire into a turn that was stopped or whose process died. The evidence
    // is the release itself: a prompt that cannot be written has no turn behind
    // it, and BOTH events would be untrue there — a notice promising a turn
    // that runs on, over an error reporting a send nobody awaits.
    vi.useFakeTimers();
    let writable = true;
    try {
      const h = harness(turnAsking(true), () => writable);
      h.feed(initializeReply(1));
      h.feed({ id: 2, result: sessionOfferingContext() });
      expect(methods(h.sent)).not.toContain('session/prompt');
      const held = h.emitted.length;

      // The turn is stopped and its group killed — every later write refuses.
      writable = false;
      vi.advanceTimersByTime(30_000);

      expect(h.emitted).toHaveLength(held);
    } finally {
      vi.useRealTimers();
    }
  });

  it('narrates each frame that stranded the queue, and then runs the turn', () => {
    // The frames go out one at a time, so an effort that is never answered
    // strands the context frame behind it as well as the prompt. Each expiry
    // is narrated once and moves the queue on; the turn then runs.
    vi.useFakeTimers();
    try {
      const h = harness({
        promptAwaitsConfig: true,
        input: { ...BASE_INPUT, model: 'claude-opus-5' },
        modelSelection: {
          model: 'claude-opus-5',
          parameters: [
            { id: 'effort', value: 'xhigh' },
            { id: 'context', value: '1m' },
          ],
        },
      });
      h.feed(initializeReply(1));
      h.feed({ id: 2, result: sessionOfferingEffortAndContext() });
      const notices = (): number =>
        h.emitted.filter((event) => event.type === 'notice').length;

      // Neither frame is ever answered. The effort's expiry is narrated and
      // sends the context frame — but not yet the prompt, which that one holds.
      vi.advanceTimersByTime(30_000);
      expect(notices()).toBe(1);
      expect(h.sentAll('session/set_config_option')).toHaveLength(2);
      expect(methods(h.sent)).not.toContain('session/prompt');

      vi.advanceTimersByTime(30_000);
      expect(notices()).toBe(2);
      expect(methods(h.sent)).toContain('session/prompt');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT bound the prompt itself', () => {
    // The one kind deliberately absent from the deadline map. A prompt IS the
    // turn, so a deadline on it would give up on an agent that is working — a
    // plain harness, since a turn asking for a parameter arms that frame's own.
    vi.useFakeTimers();
    try {
      const h = harness();
      h.feed(initializeReply(1));
      h.feed({ id: 2, result: { sessionId: 's-1' } });
      expect(methods(h.sent)).toContain('session/prompt');
      const settled = h.emitted.length;

      vi.advanceTimersByTime(60 * 60_000);

      expect(h.emitted).toHaveLength(settled);
      // The assertion that actually costs something: arming `prompt` would take
      // its entry out of `pending`, after which the agent's reply routes to the
      // "nothing owed" arm and the turn never settles at all.
      const promptId = h.sent.find(
        (frame) => frame.method === 'session/prompt',
      )?.id;
      expect(
        h.feed({ id: promptId, result: { stopReason: 'end_turn' } }),
      ).toContainEqual(expect.objectContaining({ type: 'turn_complete' }));
    } finally {
      vi.useRealTimers();
    }
  });

  /** A session offering BOTH axes, so two parameter frames can go out. */
  function sessionOfferingEffortAndContext(): Record<string, unknown> {
    return {
      sessionId: 's-1',
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'claude-opus-5',
          options: [{ value: 'claude-opus-5', name: 'claude-opus-5' }],
        },
        {
          id: 'effort',
          category: 'model_config',
          currentValue: 'medium',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'xhigh', name: 'Extra high' },
          ],
        },
        {
          id: 'context',
          category: 'model_config',
          currentValue: '300k',
          options: [
            { value: '300k', name: '300K' },
            { value: '1m', name: '1M' },
          ],
        },
      ],
    };
  }

  it('sends each frame only once the one before it is answered', () => {
    // THE REPORTED DEFECT. cursor handles each set_config_option as its own
    // async read-modify-write of the model's whole parameter list, so frames in
    // flight together overwrite each other: a Grok 4.7 member set to 500K ran at
    // 256K "only sometimes". Probed on cursor-agent 2026.09.10-fd3934a, the
    // pipelined frames landed right one run in three; one at a time, three of
    // three. The order is the adapter's: effort first, the context window
    // (which, being last, also holds the prompt) after it.
    const h = harness({
      promptAwaitsConfig: true,
      input: { ...BASE_INPUT, model: 'claude-opus-5' },
      modelSelection: {
        model: 'claude-opus-5',
        parameters: [
          { id: 'effort', value: 'xhigh' },
          { id: 'context', value: '1m' },
        ],
      },
    });
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: sessionOfferingEffortAndContext() });

    const configIds = (): unknown[] =>
      h
        .sentAll('session/set_config_option')
        .map((frame) => (frame.params as { configId?: string }).configId);

    // Only the effort is out; the context frame waits for its reply.
    expect(configIds()).toEqual(['effort']);
    expect(methods(h.sent)).not.toContain('session/prompt');

    // A reply to some OTHER id moves nothing.
    h.feed({ id: 99, result: {} });
    expect(configIds()).toEqual(['effort']);

    // The effort's reply (id 3) sends the context frame — and not the prompt,
    // which the context frame holds.
    h.feed({ id: 3, result: {} });
    expect(configIds()).toEqual(['effort', 'context']);
    expect(methods(h.sent)).not.toContain('session/prompt');

    // The context's reply (id 4) is the one the prompt was waiting on.
    h.feed({ id: 4, result: { configOptions: [] } });
    expect(methods(h.sent)).toContain('session/prompt');
  });

  it('sends the prompt right behind the LAST frame when none holds it', () => {
    // One at a time still saves the last round-trip: with nothing asking to be
    // in force first, the prompt follows the final frame down the pipe.
    const h = harness({
      input: { ...BASE_INPUT, model: 'claude-opus-5' },
      modelSelection: {
        model: 'claude-opus-5',
        parameters: [
          { id: 'effort', value: 'xhigh' },
          { id: 'context', value: '1m' },
        ],
      },
    });
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: sessionOfferingEffortAndContext() });
    expect(methods(h.sent)).not.toContain('session/prompt');

    h.feed({ id: 3, result: {} });

    expect(methods(h.sent).slice(-2)).toEqual([
      'session/set_config_option',
      'session/prompt',
    ]);
  });

  describe('a model switch that sets nothing else', () => {
    // The model frame is then the LAST frame, so whether the prompt waits is
    // the agent's answer alone — no parameter is there to ask for it. cursor
    // binds the model when the prompt arrives too (a pipelined switch to
    // `gpt-5.5` billed as the old `gpt-5.6-sol`, though the reply confirmed it).
    function switching(promptAwaitsConfig: boolean): Harness {
      const h = harness({
        promptAwaitsConfig,
        input: { ...BASE_INPUT, model: 'claude-opus-5' },
        modelSelection: { model: 'claude-opus-5', parameters: [] },
      });
      h.feed(initializeReply(1));
      h.feed({
        id: 2,
        result: {
          sessionId: 's-1',
          configOptions: [
            {
              id: 'model',
              category: 'model',
              currentValue: 'grok-4.6',
              options: [
                { value: 'grok-4.6', name: 'grok' },
                { value: 'claude-opus-5', name: 'opus' },
              ],
            },
          ],
        },
      });
      return h;
    }

    it('holds the prompt until the model frame is answered', () => {
      const h = switching(true);
      expect(h.sentAll('session/set_config_option')).toHaveLength(1);
      expect(methods(h.sent)).not.toContain('session/prompt');

      h.feed({ id: 3, result: { configOptions: [] } });
      expect(methods(h.sent)).toContain('session/prompt');
    });

    it('pipelines the prompt behind it for an agent that does not ask', () => {
      const h = switching(false);
      expect(methods(h.sent).slice(-2)).toEqual([
        'session/set_config_option',
        'session/prompt',
      ]);
    });
  });

  it('drops the parameters queued behind a model the agent refused', () => {
    // They belong to the refused model; set on whichever model the agent kept,
    // they would apply half of a selection the user never made.
    const h = harness({
      promptAwaitsConfig: true,
      input: { ...BASE_INPUT, model: 'claude-opus-5' },
      modelSelection: {
        model: 'claude-opus-5',
        parameters: [{ id: 'context', value: '1m' }],
      },
    });
    h.feed(initializeReply(1));
    h.feed({
      id: 2,
      result: {
        sessionId: 's-1',
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: 'grok-4.6',
            options: [
              { value: 'grok-4.6', name: 'grok' },
              { value: 'claude-opus-5', name: 'opus' },
            ],
          },
        ],
      },
    });
    expect(h.sentAll('session/set_config_option')).toHaveLength(1);

    h.feed({ id: 3, error: { code: -32602, message: 'Invalid model value' } });

    expect(h.sentAll('session/set_config_option')).toHaveLength(1);
    expect(methods(h.sent)).toContain('session/prompt');
  });
});

describe('AcpSession permissions', () => {
  function permissionRequest(
    id: number | string,
    overrides: Record<string, unknown> = {},
  ): unknown {
    return {
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 's',
        toolCall: {
          toolCallId: 't-1',
          name: 'write_file',
          kind: 'edit',
          rawInput: { path: 'a.ts' },
          ...overrides,
        },
        options: [
          { optionId: 'o-allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'o-always', name: 'Always', kind: 'allow_always' },
          { optionId: 'o-reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    };
  }

  it('answers without the user when the policy decides, emitting nothing', () => {
    const h = harness({ autoDecide: () => 'allow' });
    expect(h.feed(permissionRequest(5))).toEqual([]);
    const reply = h.sent.find((frame) => frame.id === 5);
    expect(reply?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'o-allow' },
    });
  });

  it('passes the tool call to the policy so it can classify the request', () => {
    const autoDecide = vi.fn(() => null);
    const h = harness({ autoDecide });
    h.feed(permissionRequest(5));
    expect(autoDecide).toHaveBeenCalledWith({
      toolCallId: 't-1',
      name: 'write_file',
      kind: 'edit',
      status: null,
      rawInput: { path: 'a.ts' },
      rawOutput: null,
      // Null rather than absent: `readToolCall` always produces the key, and a
      // permission request's toolCall stub names no files. No policy reads it,
      // so this is shape rather than signal — asserted exactly so the day it
      // becomes signal is a day this test has to be revisited.
      locations: null,
    });
  });

  it('restores the cached NAME onto a stub request, and never its kind or locations', () => {
    // The merge exists so a stubbed request is drawn on what the opening frame
    // announced. The kind and `locations` are deliberately left out of it: no
    // policy reads either — the card shows the name and arguments — so merging
    // one would cache a value with no reader. These are the assertions that go
    // red if either is added.
    const autoDecide = vi.fn(() => null);
    const h = harness({ autoDecide });
    h.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't-1',
        name: 'write_file',
        kind: 'edit',
        locations: [{ path: '/repo/src/a.ts', line: 42 }],
      }),
    );

    h.feed({
      id: 5,
      method: 'session/request_permission',
      params: {
        sessionId: 's',
        toolCall: { toolCallId: 't-1' },
        options: [{ optionId: 'o-allow', name: 'Allow', kind: 'allow_once' }],
      },
    });

    expect(autoDecide).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'write_file',
        kind: null,
        locations: null,
      }),
    );
  });

  it('parks the request as an approval card when the policy defers', () => {
    const h = harness();
    expect(h.feed(permissionRequest(5))).toEqual([
      {
        type: 'approval_request',
        id: 'n:5',
        toolName: 'write_file',
        input: { path: 'a.ts' },
      },
    ]);
    // Nothing was answered — the agent stays parked until a verdict arrives.
    expect(h.sent.some((frame) => frame.id === 5)).toBe(false);
  });

  it('names a parked card from the tool call it belongs to when the request omits the name', () => {
    const h = harness();
    // ACP's permission request carries a ToolCallUpdate, where every field
    // except toolCallId is optional — the agent already named this call once,
    // on the tool_call update the driver recorded.
    h.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't-1',
        name: 'write_file',
        kind: 'edit',
      }),
    );
    expect(
      h.feed({
        id: 5,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          toolCall: { toolCallId: 't-1' },
          options: [{ optionId: 'o-allow', name: 'Allow', kind: 'allow_once' }],
        },
      }),
    ).toEqual([
      {
        type: 'approval_request',
        id: 'n:5',
        toolName: 'write_file',
        input: null,
      },
    ]);
  });

  it('answers a parked request with the id type the agent used', () => {
    const numeric = harness();
    numeric.feed(permissionRequest(5));
    const allow = numeric.driver.buildApprovalResponse('n:5', true);
    expect(JSON.parse(allow ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 5,
      result: { outcome: { outcome: 'selected', optionId: 'o-allow' } },
    });

    const textual = harness();
    textual.feed(permissionRequest('req-a'));
    const deny = textual.driver.buildApprovalResponse('s:req-a', false);
    expect(JSON.parse(deny ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 'req-a',
      result: { outcome: { outcome: 'selected', optionId: 'o-reject' } },
    });
  });

  it('never selects an *_always option', () => {
    // An always-choice would outlive the turn the user was asked about.
    const h = harness();
    h.feed({
      id: 5,
      method: 'session/request_permission',
      params: {
        toolCall: { toolCallId: 't', name: 'x' },
        options: [
          { optionId: 'o-always', name: 'Always', kind: 'allow_always' },
        ],
      },
    });
    expect(
      JSON.parse(h.driver.buildApprovalResponse('n:5', true) ?? ''),
    ).toEqual({
      jsonrpc: '2.0',
      id: 5,
      result: { outcome: { outcome: 'cancelled' } },
    });
  });

  it("offers the agent's *_always option on the card, worded by the reach the adapter declares", () => {
    const h = harness({ alwaysAnswerScope: 'session' });
    expect(h.feed(permissionRequest(5))).toEqual([
      {
        type: 'approval_request',
        id: 'n:5',
        toolName: 'write_file',
        input: { path: 'a.ts' },
        // Under the agent's own id, so the verdict answers with it; never
        // under the agent's own "Always" when geniro keeps it for a session.
        options: [
          {
            id: 'o-always',
            label: 'Allow for this session',
            allow: true,
            scope: 'session',
          },
        ],
      },
    ]);
  });

  it('answers a picked *_always option with that option, and a plain verdict with *_once', () => {
    const picked = harness({ alwaysAnswerScope: 'session' });
    const [card] = picked.feed(permissionRequest(5));
    const option =
      card?.type === 'approval_request' ? card.options?.[0] : undefined;
    expect(option?.id).toBe('o-always');
    expect(
      JSON.parse(
        picked.driver.buildApprovalResponse('n:5', true, undefined, option) ??
          '',
      ).result,
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'o-always' } });

    const plain = harness({ alwaysAnswerScope: 'session' });
    plain.feed(permissionRequest(5));
    expect(
      JSON.parse(plain.driver.buildApprovalResponse('n:5', true) ?? '').result,
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'o-allow' } });
  });

  it('auto-approves with *_once even where *_always is offered', () => {
    // Nothing the daemon decides on its own may be remembered past the run.
    const h = harness({
      alwaysAnswerScope: 'session',
      autoDecide: () => 'allow',
    });
    expect(h.feed(permissionRequest(5))).toEqual([]);
    expect(h.sent.find((frame) => frame.id === 5)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'o-allow' },
    });
  });

  it('refuses to answer an unknown or already-answered request', () => {
    const h = harness();
    h.feed(permissionRequest(5));
    expect(h.driver.buildApprovalResponse('n:5', true)).toBeDefined();
    // Answering twice must not write a second reply for the same id.
    expect(h.driver.buildApprovalResponse('n:5', true)).toBeUndefined();
    expect(h.driver.buildApprovalResponse('n:404', true)).toBeUndefined();
    expect(h.driver.buildApprovalResponse('untagged', true)).toBeUndefined();
  });

  describe('the result of a call whose permission was refused', () => {
    /** A live session with the call announced, so a settle can name it. */
    function withCall(overrides: Partial<AcpDriverOptions> = {}): Harness {
      const h = harness(overrides);
      h.feed(initializeReply(1));
      h.feed({ id: 2, result: { sessionId: 'sess-1' } });
      h.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 't-1',
          name: 'write_file',
          status: 'in_progress',
          rawInput: { path: 'a.ts' },
        }),
      );
      return h;
    }

    function settle(h: Harness, extra: Record<string, unknown> = {}) {
      return h
        .feed(
          update({
            sessionUpdate: 'tool_call_update',
            toolCallId: 't-1',
            status: 'completed',
            ...extra,
          }),
        )
        .filter((event) => event.type === 'tool_result');
    }

    it('is an error carrying the refusal when the agent closes it completed with no output', () => {
      const h = withCall();
      h.feed(permissionRequest(5));
      h.driver.buildApprovalResponse('n:5', false);

      expect(settle(h)).toEqual([
        {
          type: 'tool_result',
          id: 't-1',
          name: 'write_file',
          result: REFUSED_TOOL_RESULT,
          isError: true,
        },
      ]);
    });

    it('is an error that keeps the body the agent sent', () => {
      const h = withCall();
      h.feed(permissionRequest(5));
      h.driver.buildApprovalResponse('n:5', false);

      expect(settle(h, { rawOutput: { rejected: true } })).toEqual([
        {
          type: 'tool_result',
          id: 't-1',
          name: 'write_file',
          result: { rejected: true },
          isError: true,
        },
      ]);
    });

    it('is an error when the agent offered no reject option and the reply was `cancelled`', () => {
      const h = withCall();
      h.feed({
        id: 5,
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          toolCall: { toolCallId: 't-1', name: 'write_file' },
          options: [{ optionId: 'o-allow', name: 'Allow', kind: 'allow_once' }],
        },
      });
      h.driver.buildApprovalResponse('n:5', false);

      expect(settle(h)).toMatchObject([
        { result: REFUSED_TOOL_RESULT, isError: true },
      ]);
    });

    it('is an error when the user allowed it but the agent offered no allow option, so the reply was `cancelled`', () => {
      const h = withCall();
      h.feed({
        id: 5,
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          toolCall: { toolCallId: 't-1', name: 'write_file' },
          options: [{ optionId: 'o-rej', name: 'Reject', kind: 'reject_once' }],
        },
      });
      h.driver.buildApprovalResponse('n:5', true);

      expect(settle(h)).toMatchObject([
        { result: REFUSED_TOOL_RESULT, isError: true },
      ]);
    });

    it('is a success when a refused call is asked again and allowed', () => {
      const h = withCall();
      h.feed(permissionRequest(5));
      h.driver.buildInterruptPayload();
      h.feed(permissionRequest(6));
      h.driver.buildApprovalResponse('n:6', true);

      expect(settle(h, { rawOutput: { ok: true } })).toMatchObject([
        { result: { ok: true }, isError: false },
      ]);
    });

    it('is an error when the agent closes it in a later turn than the refusal', () => {
      const h = withCall();
      h.feed(permissionRequest(5));
      h.driver.buildApprovalResponse('n:5', false);
      h.feed({ id: 3, result: { stopReason: 'end_turn' } });
      h.openTurn({ prompt: 'next', cwd: '/work' });

      expect(settle(h)).toMatchObject([
        { result: REFUSED_TOOL_RESULT, isError: true },
      ]);
    });

    it('is a success when the user allowed it', () => {
      const h = withCall();
      h.feed(permissionRequest(5));
      h.driver.buildApprovalResponse('n:5', true);

      expect(settle(h, { rawOutput: { ok: true } })).toMatchObject([
        { result: { ok: true }, isError: false },
      ]);
    });

    it('is an error when the policy denied it without asking', () => {
      const h = withCall({ autoDecide: () => 'deny' });
      h.feed(permissionRequest(5));

      expect(settle(h)).toMatchObject([
        { result: REFUSED_TOOL_RESULT, isError: true },
      ]);
    });

    it('is a success when the policy allowed it without asking', () => {
      const h = withCall({ autoDecide: () => 'allow' });
      h.feed(permissionRequest(5));

      expect(settle(h, { rawOutput: { ok: true } })).toMatchObject([
        { result: { ok: true }, isError: false },
      ]);
    });

    it('is an error when the policy allowed it but the agent offered no allow option', () => {
      const h = withCall({ autoDecide: () => 'allow' });
      h.feed({
        id: 5,
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          toolCall: { toolCallId: 't-1', name: 'write_file' },
          options: [{ optionId: 'o-rej', name: 'Reject', kind: 'reject_once' }],
        },
      });

      expect(settle(h)).toMatchObject([
        { result: REFUSED_TOOL_RESULT, isError: true },
      ]);
    });

    it('is an error when a Stop released the request unanswered', () => {
      const h = withCall();
      h.feed(permissionRequest(5));
      h.driver.buildInterruptPayload();

      expect(settle(h)).toMatchObject([
        { result: REFUSED_TOOL_RESULT, isError: true },
      ]);
    });

    it('is an error when the verdict lands in a later turn than the request', () => {
      const h = withCall();
      h.feed(permissionRequest(5));
      h.feed({ id: 3, result: { stopReason: 'end_turn' } });
      h.openTurn({ prompt: 'next', cwd: '/work' });
      h.driver.buildApprovalResponse('n:5', false);

      expect(settle(h)).toMatchObject([
        { result: REFUSED_TOOL_RESULT, isError: true },
      ]);
    });

    it('consumes the refusal mark with the first settle', () => {
      const h = withCall();
      h.feed(permissionRequest(5));
      h.driver.buildApprovalResponse('n:5', false);

      expect(settle(h)).toMatchObject([{ isError: true }]);
      // The mark is consumed by the first settle.
      h.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 't-1',
          name: 'write_file',
          status: 'in_progress',
          rawInput: { path: 'a.ts' },
        }),
      );
      expect(settle(h, { rawOutput: { ok: true } })).toMatchObject([
        { result: { ok: true }, isError: false },
      ]);
    });
  });
});

describe('selectPermissionOption', () => {
  it('picks the once-scoped option in the requested direction', () => {
    const options = [
      { optionId: 'a', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'r', name: 'Reject', kind: 'reject_once' as const },
    ];
    expect(selectPermissionOption(options, true)).toBe('a');
    expect(selectPermissionOption(options, false)).toBe('r');
  });

  it('returns null rather than guessing when nothing matches', () => {
    expect(selectPermissionOption([], true)).toBeNull();
    expect(
      selectPermissionOption(
        [{ optionId: 'x', name: 'Always', kind: 'reject_always' }],
        false,
      ),
    ).toBeNull();
  });
});

describe('permissionAnswerOptionId', () => {
  const options = [
    { optionId: 'a', name: 'Allow', kind: 'allow_once' as const },
    { optionId: 'aa', name: 'Always', kind: 'allow_always' as const },
    { optionId: 'r', name: 'Reject', kind: 'reject_once' as const },
  ];
  const always = {
    id: 'aa',
    label: 'Allow for this session',
    allow: true,
    scope: 'session' as const,
  };

  it('answers with the picked always option in its own direction', () => {
    expect(permissionAnswerOptionId(options, true, always)).toBe('aa');
  });

  it('falls back to the once option for a pick pointing the other way or not offered', () => {
    // An allow-always id riding a Deny is answered as the Deny it was pressed as.
    expect(permissionAnswerOptionId(options, false, always)).toBe('r');
    expect(
      permissionAnswerOptionId(options, true, { ...always, id: 'gone' }),
    ).toBe('a');
    expect(permissionAnswerOptionId(options, true, undefined)).toBe('a');
  });
});

describe('AcpSession unsupported requests', () => {
  it('declines an unimplemented client method in-protocol, once, with a notice', () => {
    const h = harness();
    // A blocking request left unanswered parks the agent for the whole turn.
    const events = h.feed({
      id: 9,
      method: 'fs/read_text_file',
      params: { path: '/etc/hosts' },
    });
    expect(h.sent.find((frame) => frame.id === 9)?.error).toEqual({
      code: -32601,
      message: 'fs/read_text_file is not implemented by this client',
    });
    expect(events).toEqual([
      {
        type: 'notice',
        message:
          "agent asked for 'fs/read_text_file', which this client does not implement; it was declined",
      },
    ]);

    // Still answered, but the transcript is not spammed with one notice each.
    expect(h.feed({ id: 10, method: 'terminal/create', params: {} })).toEqual(
      [],
    );
    expect(h.sent.find((frame) => frame.id === 10)?.error).toBeDefined();
  });

  it('ignores a vendor notification instead of replying to it', () => {
    const h = harness();
    const before = h.sent.length;
    expect(
      h.feed({ method: 'cursor/update_todos', params: { todos: [] } }),
    ).toEqual([]);
    expect(h.sent.length).toBe(before);
  });

  it('warns rather than throwing when a reply cannot be written', () => {
    const warn = vi.fn();
    const h = harness({ logger: { warn } }, false);
    h.feed({ id: 9, method: 'fs/read_text_file', params: {} });
    // NO invented cause when the writer names none. It used to append `— stdin
    // is closed` unconditionally, which this driver cannot know.
    expect(warn).toHaveBeenCalledWith(
      'acp: dropped the error reply to fs/read_text_file',
    );
  });

  it('quotes the WRITER’s reason for a dropped reply instead of guessing one', () => {
    // The whole point: `write` answers a bare boolean and four different things
    // produce that false. The one this used to print named geniro as the
    // closer, and the case that mattered was the opposite — cursor-agent
    // closing its own read end while still running. Logged as `dropped a reply
    // to request 183 — stdin is closed`, it cost a live investigation.
    const warn = vi.fn();
    const h = harness(
      { logger: { warn } },
      false,
      () => 'the CLI closed its end of stdin while still running',
    );
    h.feed({ id: 9, method: 'fs/read_text_file', params: {} });
    expect(warn).toHaveBeenCalledWith(
      'acp: dropped the error reply to fs/read_text_file — the CLI closed its end of stdin while still running',
    );
  });
});

describe('AcpSession vendor question channel', () => {
  const ASK = 'vendor/ask_question';
  const CARD = [
    { question: 'Which?', header: null, options: [], multiSelect: false },
  ];
  /** A stand-in protocol: the driver must know NO agent's question shape. */
  const question = {
    method: ASK,
    toolName: ASK,
    accepts: (params: unknown) =>
      Array.isArray((params as { questions?: unknown[] })?.questions),
    card: () => CARD,
    encodeReply: (_params: unknown, allow: boolean, updatedInput: unknown) => ({
      outcome: allow ? { outcome: 'answered', updatedInput } : 'declined',
    }),
  };
  const askRequest = {
    id: 9,
    method: ASK,
    params: { questions: [{ id: 'q1', prompt: 'Which?' }] },
  };

  it('parks the question as a card rather than declining it', () => {
    // The regression: a BLOCKING vendor request answered with -32601 stalls
    // the turn on a question the user was never shown.
    const h = harness({ question });
    const events = h.feed(askRequest);

    expect(events).toEqual([
      {
        type: 'approval_request',
        id: 'n:9',
        toolName: ASK,
        input: askRequest.params,
        requiresUserInteraction: true,
        // The adapter's own reading of its shape — the card the user sees.
        questions: CARD,
      },
    ]);
    // Nothing was sent — the agent stays parked until a verdict arrives.
    expect(h.sent.some((frame) => frame.id === 9)).toBe(false);
  });

  it('carries no card when the adapter reads none out of the params', () => {
    const h = harness({ question: { ...question, card: () => [] } });
    const [event] = h.feed(askRequest);
    expect(event).toMatchObject({ type: 'approval_request', id: 'n:9' });
    expect(event).not.toHaveProperty('questions');
  });

  it('answers it with the adapter’s encoder, not a permission outcome', () => {
    const h = harness({ question });
    h.feed(askRequest);

    const reply = h.driver.buildApprovalResponse('n:9', true, { answer: 'a' });
    expect(JSON.parse(reply ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: {
        outcome: { outcome: 'answered', updatedInput: { answer: 'a' } },
      },
    });
  });

  it('is never auto-decided, however permissive the turn’s posture', () => {
    // `autoDecide` resolves a PERMISSION posture. A question has no safe
    // machine answer, so an `auto` turn must still surface the card.
    const h = harness({ question, autoDecide: () => 'allow' as const });
    expect(h.feed(askRequest)).toHaveLength(1);
    expect(h.sent.some((frame) => frame.id === 9)).toBe(false);
  });

  it('declines a payload it cannot read as a question, as before', () => {
    // The shape is documented rather than observed, so drift must cost only
    // today's behaviour — never a card the user cannot answer.
    const warn = vi.fn();
    const h = harness({ question, logger: { warn } });
    const events = h.feed({ id: 9, method: ASK, params: { nope: true } });

    expect(h.sent.find((frame) => frame.id === 9)?.error).toEqual({
      code: -32601,
      message: `${ASK} is not implemented by this client`,
    });
    expect(events).toEqual([
      {
        type: 'notice',
        message: `agent asked for '${ASK}', which this client does not implement; it was declined`,
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      `acp: ${ASK} arrived in an unrecognized shape — declined rather than shown as a question`,
    );
  });

  it('declines it outright for a driver given no question protocol', () => {
    const h = harness();
    h.feed(askRequest);
    expect(h.sent.find((frame) => frame.id === 9)?.error).toBeDefined();
  });
});

describe('AcpSession refusals the agent absorbs', () => {
  const HARMLESS = 'vendor/update_todos';
  const options = { declinedWithoutNotice: [HARMLESS] };

  it('declines them in-protocol but spends no notice', () => {
    const h = harness(options);
    const events = h.feed({ id: 7, method: HARMLESS, params: { todos: [] } });

    // Still answered — a request left hanging parks the agent either way.
    expect(h.sent.find((frame) => frame.id === 7)?.error).toEqual({
      code: -32601,
      message: `${HARMLESS} is not implemented by this client`,
    });
    expect(events).toEqual([]);
  });

  it('leaves the turn’s ONE notice for a refusal that actually costs something', () => {
    // The regression this pins, and the reason the list exists at all: the
    // notice is a per-turn budget of one. Measured on cursor-agent
    // 2026.08.04, an ordinary planning turn sends `cursor/update_todos` — a
    // refusal its own agent discards — which under the old behaviour burnt
    // the slot, leaving a consequential refusal later in the same turn
    // unmentioned.
    const h = harness(options);
    expect(h.feed({ id: 7, method: HARMLESS, params: {} })).toEqual([]);

    const events = h.feed({ id: 8, method: 'fs/read_text_file', params: {} });
    expect(events).toEqual([
      {
        type: 'notice',
        message:
          "agent asked for 'fs/read_text_file', which this client does not implement; it was declined",
      },
    ]);
  });

  it('still narrates a method that is NOT on the list', () => {
    const h = harness(options);
    const events = h.feed({
      id: 7,
      method: 'vendor/something_else',
      params: {},
    });
    expect(events).toHaveLength(1);
  });

  it('records the silent refusal on the debug channel rather than nowhere', () => {
    const debug = vi.fn();
    const h = harness({ ...options, logger: { warn: vi.fn(), debug } });
    h.feed({ id: 7, method: HARMLESS, params: {} });

    expect(debug).toHaveBeenCalledWith(
      `acp: declined ${HARMLESS}; the agent handles that refusal itself`,
    );
  });
});

describe('AcpSession image attachments', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  /** A real file on disk — the driver reads bytes, not a fixture string. */
  function imageInput(): AgentTurnInput {
    const path = join(tempDir('acp-driver-images-'), 'a.png');
    writeFileSync(path, PNG);
    return {
      ...BASE_INPUT,
      images: [{ path, mediaType: 'image/png' }],
    };
  }

  /**
   * Drive the handshake to the point where `session/prompt` has been sent,
   * keeping the events the session reply produced — that is the channel the
   * prompt-time notice rides, not the `onStdinReady` one.
   */
  function promptedWith(image: boolean): {
    h: Harness;
    events: AgentEvent[];
  } {
    const h = harness({ input: imageInput() });
    h.feed(initializeReply(1, { image }));
    return { h, events: h.feed({ id: 2, result: { sessionId: 'sess-1' } }) };
  }

  it('sends the attached image to an agent that accepts image prompts', () => {
    const { h } = promptedWith(true);

    expect(h.sentMethod('session/prompt')?.params).toEqual({
      sessionId: 'sess-1',
      // Images first, then the text — the order the claude path sends.
      prompt: [
        { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') },
        { type: 'text', text: 'do the thing' },
      ],
    });
  });

  it('withholds the image from an agent that never advertised the capability, and says so', () => {
    // Sending anyway earns an error reply that fails the whole turn over an
    // attachment; dropping it quietly leaves the user watching the agent
    // answer about a screenshot it never got. Neither is acceptable, so the
    // turn runs text-only WITH a notice.
    const { h, events } = promptedWith(false);

    expect(h.sentMethod('session/prompt')?.params).toEqual({
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'do the thing' }],
    });
    expect(events).toContainEqual({
      type: 'notice',
      message:
        'agent does not accept image prompts — 1 attached image was not sent with this turn',
    });
  });

  it('says nothing about images on a turn that has none', () => {
    // The notice is about a real loss; a text-only turn must not carry it.
    const h = harness();
    h.feed(initializeReply(1, { image: false }));
    const events = h.feed({ id: 2, result: { sessionId: 'sess-1' } });

    expect(
      [...events, ...h.emitted].filter(
        (event) => event.type === 'notice' && event.message.includes('image'),
      ),
    ).toEqual([]);
  });

  it('fails the turn on an unreadable attachment instead of prompting without it', () => {
    // Constructed inside AgentAdapter.start's synchronous try, so this is the
    // seam where a broken attachment stops the turn.
    const input = {
      ...BASE_INPUT,
      images: [{ path: '/nope/missing.png', mediaType: 'image/png' }],
    };
    expect(
      () =>
        new AcpSession(
          {
            clientName: 'geniro',
            clientVersion: '1.2.3',
            turnOptions: (turnInput) => ({
              input: turnInput,
              autoDecide: () => null,
              composeSystemPrompt: () => '',
            }),
          },
          input,
        ),
    ).toThrow();
  });
});

describe('AcpSession task list', () => {
  const TODOS = 'vendor/update_todos';
  /** A reader in the shape an adapter supplies one — the params are its facts. */
  const todos = {
    method: TODOS,
    read: (params: unknown) => {
      const record = params as { rows?: unknown[]; whole?: boolean } | null;
      if (!Array.isArray(record?.rows)) {
        return null;
      }
      return {
        mode: (record.whole === true ? 'snapshot' : 'patch') as
          'snapshot' | 'patch',
        tasks: record.rows.map((row) => row as never),
        toolCallId: 'call-1',
      };
    },
  };

  it('ANSWERS the announcement and emits the list', () => {
    // The bug this fixes was a silent one: the announcement is a blocking
    // request whose agent absorbs a refusal, so declining it cost the turn
    // nothing and threw the list away with no symptom anywhere.
    const h = harness({ todos });
    const events = h.feed({
      id: 4,
      method: TODOS,
      params: { whole: true, rows: [{ id: '1' }] },
    });

    expect(h.sent.find((frame) => frame.id === 4)).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: {},
    });
    expect(events).toEqual([
      {
        type: 'task_list',
        mode: 'snapshot',
        tasks: [{ id: '1' }],
        toolCallId: 'call-1',
      },
    ]);
  });

  it('carries the mode the READER decided, never one inferred here', () => {
    const h = harness({ todos });
    const events = h.feed({ id: 5, method: TODOS, params: { rows: [] } });
    expect(events[0]?.type === 'task_list' && events[0].mode).toBe('patch');
  });

  it('falls back to the decline when the payload does not read as a list', () => {
    const warn = vi.fn();
    const h = harness({ todos, logger: { warn } });
    const events = h.feed({ id: 6, method: TODOS, params: { rows: 'nope' } });

    expect(h.sent.find((frame) => frame.id === 6)?.error).toEqual({
      code: -32601,
      message: `${TODOS} is not implemented by this client`,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('notice');
    expect(warn).toHaveBeenCalledWith(
      `acp: ${TODOS} arrived in an unrecognized shape — declined rather than recorded as a task list`,
    );
  });

  it('declines it outright for a driver given no todo protocol', () => {
    const h = harness();
    expect(
      h.feed({ id: 7, method: TODOS, params: { rows: [{ id: '1' }] } }).length,
    ).toBe(1);
    expect(h.sent.find((frame) => frame.id === 7)?.error).toBeDefined();
  });
});

describe('AcpSession plan updates', () => {
  /** Baseline ACP's `plan` update, as cursor-agent 2026.10.19 sends one. */
  const planUpdate = update({
    sessionUpdate: 'plan',
    entries: [
      { content: 'Create a.txt', priority: 'medium', status: 'completed' },
      { content: 'Create b.txt', priority: 'medium', status: 'in_progress' },
      { content: '', priority: 'low', status: 'pending' },
      { content: 'Create c.txt', priority: 'high', status: 'cancelled' },
    ],
  });
  const fromPlan = [
    {
      id: 'plan-1',
      title: 'Create a.txt',
      status: 'completed',
      activeForm: null,
    },
    {
      id: 'plan-2',
      title: 'Create b.txt',
      status: 'in_progress',
      activeForm: null,
    },
    // The blank entry is not a step; the next one keeps a contiguous id, and
    // a status outside ACP's three reads as unknown rather than coerced.
    { id: 'plan-3', title: 'Create c.txt', status: null, activeForm: null },
  ];

  it('draws the plan as the whole task list, after the words before it', () => {
    const h = harness();
    h.feed(chunk('agent_message_chunk', 'Here is the plan.'));

    // A snapshot — ACP: "the client MUST replace the current plan completely" —
    // and tied to no tool call, so it replaces no row. The text block closes
    // first, or the list would be written ahead of the words introducing it.
    expect(h.feed(planUpdate)).toEqual([
      { type: 'text', text: 'Here is the plan.' },
      {
        type: 'task_list',
        mode: 'snapshot',
        tasks: fromPlan,
        toolCallId: null,
      },
    ]);
  });

  it('draws nothing for a plan update with no entries list', () => {
    // An unreadable plan is not an empty one: an empty snapshot would wipe the
    // list the user is watching.
    const h = harness();
    expect(h.feed(update({ sessionUpdate: 'plan' }))).toEqual([]);
  });

  it('drops a plan the session/load replay streams back', () => {
    const h = harness({
      input: { ...BASE_INPUT, resumeSessionId: 'prior-7' },
    });
    h.feed(initializeReply(1, { loadSession: true }));
    expect(h.feed(planUpdate)).toEqual([]);
  });

  describe('for an agent that restates its plan with ids', () => {
    const PLAN = 'vendor/create_plan';
    const restated = [
      {
        id: 'make-a',
        title: 'Create a.txt',
        status: 'pending',
        activeForm: null,
      },
    ] as const;
    const todos = {
      method: 'vendor/update_todos',
      read: () => null,
      plan: {
        method: PLAN,
        read: (params: unknown) => {
          const rows = (params as { rows?: unknown } | null)?.rows;
          return Array.isArray(rows) ? (rows as never[]) : null;
        },
      },
    };
    const options = { todos, declinedWithoutNotice: [PLAN] };

    it('holds the plan update and draws the restatement, keyed by its ids', () => {
      // The duplication this prevents: the agent's later patches name the
      // tasks by ITS ids, so a list drawn with positional ids gains a second
      // copy of every task as soon as the agent works through it.
      const h = harness(options);
      expect(h.feed(planUpdate)).toEqual([]);

      const events = h.feed({
        id: 9,
        method: PLAN,
        params: { rows: restated },
      });

      expect(events).toEqual([
        {
          type: 'task_list',
          mode: 'snapshot',
          tasks: restated,
          toolCallId: null,
        },
      ]);
      // Still REFUSED: the reply is a verdict on the plan, never ours to give.
      expect(h.sent.find((frame) => frame.id === 9)?.error).toEqual({
        code: -32601,
        message: `${PLAN} is not implemented by this client`,
      });
    });

    it('falls back to the held plan update when the restatement is unreadable', () => {
      const warn = vi.fn();
      const h = harness({ ...options, logger: { warn } });
      h.feed(planUpdate);

      expect(h.feed({ id: 9, method: PLAN, params: { rows: 'nope' } })).toEqual(
        [
          {
            type: 'task_list',
            mode: 'snapshot',
            tasks: fromPlan,
            toolCallId: null,
          },
        ],
      );
      expect(warn).toHaveBeenCalledWith(
        `acp: ${PLAN} arrived in an unrecognized shape — its plan is drawn from the plan update instead`,
      );
      expect(h.sent.find((frame) => frame.id === 9)?.error).toBeDefined();
    });

    it('falls back to the held plan update, quietly, when the restatement names no tasks', () => {
      // cursor's CreatePlan with no todos still sends one stand-in entry naming
      // the plan on the `plan` update, while its restatement's list is empty.
      const warn = vi.fn();
      const h = harness({ ...options, logger: { warn } });
      h.feed(planUpdate);

      const events = h.feed({ id: 9, method: PLAN, params: { rows: [] } });

      expect(events[0]?.type === 'task_list' && events[0].tasks).toEqual(
        fromPlan,
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it('draws a held plan once, not again on a later restatement', () => {
      const h = harness(options);
      h.feed(planUpdate);
      h.feed({ id: 9, method: PLAN, params: { rows: 'nope' } });

      expect(h.feed({ id: 10, method: PLAN, params: { rows: [] } })).toEqual(
        [],
      );
    });
  });
});

describe('AcpSession — a message delivered into the running turn', () => {
  /** Drive the driver to a live session with its own prompt (id 3) already out. */
  function running(overrides: Partial<AcpDriverOptions> = {}): Harness {
    const h = harness(overrides);
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 'sess-1' } });
    return h;
  }

  /** Every `session/prompt` frame this turn has written, in order. */
  function prompts(h: Harness): Record<string, unknown>[] {
    return h.sent.filter((frame) => frame.method === 'session/prompt');
  }

  /** The agent confirming it stopped the turn's opening prompt. */
  const STOPPED = { id: 3, result: { stopReason: 'cancelled' } };

  it('stops the running prompt FIRST, and sends the message only once the agent confirms', () => {
    // A second `session/prompt` sent straight away is what this replaced, and
    // MEASURED on cursor-agent 2026.09.10-fd3934a it is wrong: a prompt that was
    // itself sent to interrupt another can never be stopped, and runs on beside
    // the one that replaced it — a QA member's seven reviewers became fourteen.
    const h = running();
    expect(h.driver.sendFollowUp({ text: 'actually, do X instead' })).toBe(
      true,
    );

    expect(h.sent.at(-1)).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'sess-1' },
    });
    expect(prompts(h)).toHaveLength(1);

    h.feed(STOPPED);

    const [, second] = prompts(h);
    expect(second?.params).toEqual({
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'actually, do X instead' }],
    });
  });

  it('does NOT settle the turn on the prompt its message stopped', () => {
    // Emitting a terminal on the `cancelled` reply settles the run while the
    // message the user just pushed through is about to be answered — and
    // badges it as a Stop nobody pressed.
    const h = running();
    h.feed(chunk('agent_message_chunk', 'counting: 1, 2, 3'));
    h.driver.sendFollowUp({ text: 'stop, answer this instead' });
    // Whatever the stopped stretch had already said is finished at the
    // interrupt, and is emitted THERE.
    expect(h.emitted).toContainEqual({
      type: 'text',
      text: 'counting: 1, 2, 3',
    });

    const stopped = h.feed(STOPPED);

    expect(stopped.map((e) => e.type)).not.toContain('turn_cancelled');
    expect(stopped.map((e) => e.type)).not.toContain('turn_complete');
  });

  it('closes a block the agent kept writing AFTER the cancel went out', () => {
    // The frame and the agent's reply are not simultaneous: chunks in that
    // window open a fresh block, and only the reply can close it.
    const h = running();
    h.driver.sendFollowUp({ text: 'stop' });
    h.feed(chunk('agent_message_chunk', 'one last word'));

    expect(h.feed(STOPPED)).toContainEqual({
      type: 'text',
      text: 'one last word',
    });
  });

  it('settles on the message’s own prompt', () => {
    const h = running();
    h.driver.sendFollowUp({ text: 'do X instead' });
    h.feed(STOPPED);

    const events = h.feed({ id: 4, result: { stopReason: 'end_turn' } });

    expect(events.map((e) => e.type)).toContain('turn_complete');
  });

  it('sends a second message that arrives during the cancel WITH the first, stopping nothing twice', () => {
    // The prompt the first message will be sent as does not exist yet, so
    // there is nothing for the second to interrupt — a second cancel would
    // either stop nothing or stop the prompt that has not been sent.
    const h = running();
    h.driver.sendFollowUp({ text: 'first thought' });
    expect(h.driver.sendFollowUp({ text: 'and a second one' })).toBe(true);

    h.feed(STOPPED);

    expect(h.sentAll('session/cancel')).toHaveLength(1);
    expect(prompts(h)).toHaveLength(2);
    expect(prompts(h)[1]?.params).toEqual({
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'first thought\n\nand a second one' }],
    });
  });

  it('answers a parked permission `cancelled` and withdraws its card', () => {
    // The protocol requires it of a `session/cancel`. The old path left the
    // request unanswered — MEASURED, the agent then drops it on its own side —
    // and its card stayed on screen with nothing behind a verdict.
    const h = running();
    const [card] = h.feed({
      id: 50,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 't-1', name: 'write_file', rawInput: {} },
        options: [{ optionId: 'o-allow', name: 'Allow', kind: 'allow_once' }],
      },
    });
    expect(card?.type).toBe('approval_request');

    h.driver.sendFollowUp({ text: 'never mind that file' });

    expect(h.sent.find((frame) => frame.id === 50)?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(h.emitted).toContainEqual({
      type: 'approval_withdrawn',
      id: card?.type === 'approval_request' ? card.id : '',
    });
  });

  it('marks an unwatchable delegate untracked when a follow-up interrupts its parent', () => {
    const h = running({ delegate: UNWATCHABLE_DELEGATE });
    h.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'delegate',
        title: 'Review',
        status: 'in_progress',
        rawInput: { _toolName: 'task' },
      }),
    );
    h.driver.sendFollowUp({ text: 'do something else' });
    const events = h.feed(STOPPED);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'delegate',
        backgroundOutcome: 'untracked',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        id: 'delegate',
        isError: false,
      }),
    );
  });

  it('closes the tool calls the stopped prompt left running, and only those', () => {
    // MEASURED: an interrupt aborts a running shell and a foreground
    // sub-agent, and the agent sends no update for either — so the row read as
    // running for the rest of the turn.
    const h = running();
    h.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't-done',
        name: 'read_file',
        status: 'in_progress',
        rawInput: { path: 'a.ts' },
      }),
    );
    h.feed(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't-done',
        status: 'completed',
        rawOutput: { ok: true },
      }),
    );
    h.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't-running',
        name: 'shell',
        status: 'in_progress',
        rawInput: { command: 'sleep 300' },
      }),
    );
    h.driver.sendFollowUp({ text: 'stop that' });

    const results = h.feed(STOPPED).filter((e) => e.type === 'tool_result');

    expect(results).toEqual([
      {
        type: 'tool_result',
        id: 't-running',
        name: 'shell',
        result: INTERRUPTED_TOOL_RESULT,
        isError: true,
      },
    ]);
  });

  it('ends the turn, and sends nothing, when Stop is pressed while the cancel is in flight', () => {
    vi.useFakeTimers();
    try {
      const h = running();
      h.driver.sendFollowUp({ text: 'do X instead' });
      h.driver.buildInterruptPayload();

      const events = h.feed(STOPPED);
      vi.advanceTimersByTime(INTERRUPT_ACK_DEADLINE_MS);

      expect(events.map((e) => e.type)).toContain('turn_cancelled');
      expect(prompts(h)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Where the drop sits relative to the event that ends the turn. */
  function dropBeforeTerminal(events: AgentEvent[]): void {
    const types = events.map((event) => event.type);
    const terminal = types.findIndex(
      (type) =>
        type === 'turn_cancelled' ||
        type === 'turn_complete' ||
        type === 'error',
    );
    expect(types.indexOf('follow_up_dropped')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('follow_up_dropped')).toBeLessThan(terminal);
  }

  // A message accepted while the cancel is in flight has already been written
  // as a sent row by its caller; a Stop landing before the agent confirms
  // drops it, so the turn has to say which messages never reached the agent.
  it.each([
    ['answers `cancelled`', STOPPED],
    ['fails', { id: 3, error: { code: -32603, message: 'Internal error' } }],
    ['ends normally', { id: 3, result: { stopReason: 'end_turn' } }],
  ])(
    'reports every message a Stop dropped from the cancel window when the stopped prompt %s',
    (_reply, reply) => {
      const h = running();
      const first = { text: 'do X instead', deliveryId: 'delivery-1' };
      const second = { text: 'and then Y', deliveryId: 'delivery-2' };
      expect(h.driver.sendFollowUp(first)).toBe(true);
      expect(h.driver.sendFollowUp(second)).toBe(true);
      h.driver.buildInterruptPayload();

      const events = h.feed(reply);

      expect(prompts(h)).toHaveLength(1);
      expect(events).toContainEqual({
        type: 'follow_up_dropped',
        deliveryIds: ['delivery-1', 'delivery-2'],
      });
      dropBeforeTerminal(events);
    },
  );

  it('reports the dropped message ahead of the failure the stopped prompt reported', () => {
    const h = running({
      agentFailure: {
        read: (text) => (text.startsWith('\n\nError: ') ? text.trim() : null),
      },
    });
    h.driver.sendFollowUp({ text: 'do X instead', deliveryId: 'delivery-1' });
    h.driver.buildInterruptPayload();
    h.feed(chunk('agent_message_chunk', '\n\nError: ProviderError: gone'));

    const events = h.feed({ id: 3, result: { stopReason: 'end_turn' } });

    expect(events).toContainEqual({
      type: 'follow_up_dropped',
      deliveryIds: ['delivery-1'],
    });
    dropBeforeTerminal(events);
  });

  it('sends the message anyway, and says so, when the agent never confirms', () => {
    // A message held forever is worse than the duplicated work the wait
    // prevents. The stopped prompt's reply, whenever it lands, then settles
    // nothing — nothing orders the two replies.
    vi.useFakeTimers();
    try {
      const h = running();
      h.driver.sendFollowUp({ text: 'do X instead' });
      expect(prompts(h)).toHaveLength(1);

      vi.advanceTimersByTime(INTERRUPT_ACK_DEADLINE_MS);

      expect(prompts(h)).toHaveLength(2);
      expect(h.emitted).toContainEqual(
        expect.objectContaining({ type: 'notice', severity: 'warning' }),
      );
      expect(
        h
          .feed({ id: 4, result: { stopReason: 'end_turn' } })
          .map((e) => e.type),
      ).toContain('turn_complete');
      const trailing = h.feed(STOPPED);
      expect(trailing.map((e) => e.type)).not.toContain('turn_cancelled');
      expect(trailing.map((e) => e.type)).not.toContain('turn_complete');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fail the message on a failure the STOPPED prompt reported', () => {
    // A failure is a message chunk with no prompt id on it. One the stopped
    // prompt reported before its own reply outlived that prompt, and turned the
    // message's clean `end_turn` into an `error`.
    const h = running({
      agentFailure: {
        read: (text) => (text.startsWith('\n\nError: ') ? text.trim() : null),
      },
    });
    h.driver.sendFollowUp({ text: 'do X instead' });
    h.feed(chunk('agent_message_chunk', '\n\nError: CancelledError: aborted'));
    h.feed(STOPPED);

    const events = h.feed({ id: 4, result: { stopReason: 'end_turn' } });

    expect(events.map((e) => e.type)).toContain('turn_complete');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('still fails the message on a failure reported AFTER the stopped prompt answered', () => {
    const h = running({
      agentFailure: {
        read: (text) => (text.startsWith('\n\nError: ') ? text.trim() : null),
      },
    });
    h.driver.sendFollowUp({ text: 'do X instead' });
    h.feed(STOPPED);
    h.feed(chunk('agent_message_chunk', '\n\nError: RetriableError: boom'));

    expect(h.feed({ id: 4, result: { stopReason: 'end_turn' } })).toEqual([
      { type: 'error', message: 'Error: RetriableError: boom' },
    ]);
  });

  it('sends the message, and does NOT settle, when the stopped prompt ERRORS', () => {
    // The prompt a message stops does not always answer `cancelled` — it can
    // fail. It has stopped either way, and an `error` is terminal downstream.
    const h = running();
    h.driver.sendFollowUp({ text: 'do X instead' });

    const stopped = h.feed({
      id: 3,
      error: { code: -32603, message: 'Internal error' },
    });
    expect(stopped.map((e) => e.type)).not.toContain('error');
    expect(prompts(h)).toHaveLength(2);

    expect(
      h.feed({ id: 4, result: { stopReason: 'end_turn' } }).map((e) => e.type),
    ).toContain('turn_complete');
  });

  it('DOES surface an error from the turn’s own prompt', () => {
    // The guard above must not swallow the ordinary failure — with no message
    // sent, the turn's own prompt IS the latest one.
    const h = running();

    expect(
      h
        .feed({ id: 3, error: { code: -32603, message: 'Internal error' } })
        .map((e) => e.type),
    ).toContain('error');
  });

  it('refuses while the turn’s OWN prompt is still held back', () => {
    // Nothing to interrupt yet — the opening prompt is waiting on a parameter
    // frame it must not overtake — and a follow-up would race it. False leaves
    // the message queued, which is safe and is what the chat route turns into
    // the RUN_BUSY the composer already handles.
    const h = harness({
      promptAwaitsConfig: true,
      input: { ...BASE_INPUT, model: 'claude-opus-5' },
      modelSelection: {
        model: 'claude-opus-5',
        parameters: [{ id: 'context', value: '1m' }],
      },
    });
    h.feed(initializeReply(1));
    h.feed({
      id: 2,
      result: {
        sessionId: 'sess-1',
        configOptions: [
          {
            id: 'context',
            category: 'model_config',
            currentValue: '300k',
            options: [
              { value: '300k', name: '300K' },
              { value: '1m', name: '1M' },
            ],
          },
        ],
      },
    });
    expect(prompts(h)).toHaveLength(0);

    expect(h.driver.sendFollowUp({ text: 'me first' })).toBe(false);
    expect(h.sentMethod('session/cancel')).toBeUndefined();
  });

  it('refuses before there is a session at all', () => {
    const h = harness();
    expect(h.driver.sendFollowUp({ text: 'too early' })).toBe(false);
  });

  it('hands back the message waiting behind an unconfirmed cancel when the process ends under the turn', () => {
    const h = running();
    h.driver.sendFollowUp({ text: 'do X instead', deliveryId: 'delivery-1' });
    h.driver.buildInterruptPayload();

    expect(h.driver.onProcessEnded()).toEqual([
      { type: 'follow_up_dropped', deliveryIds: ['delivery-1'] },
    ]);
  });

  it('reports the waiting message dropped when its prompt cannot be written after the agent confirms', () => {
    let writable = true;
    const h = harness({}, () => writable);
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 'sess-1' } });
    expect(
      h.driver.sendFollowUp({ text: 'do X instead', deliveryId: 'delivery-1' }),
    ).toBe(true);
    writable = false;

    const events = h.feed({ id: 3, result: { stopReason: 'cancelled' } });

    expect(prompts(h)).toHaveLength(1);
    expect(events).toContainEqual({
      type: 'follow_up_dropped',
      deliveryIds: ['delivery-1'],
    });
    dropBeforeTerminal(events);
  });

  it('reports the waiting message dropped when the agent never confirms and the late prompt cannot be written', () => {
    vi.useFakeTimers();
    try {
      let writable = true;
      const h = harness({}, () => writable);
      h.feed(initializeReply(1));
      h.feed({ id: 2, result: { sessionId: 'sess-1' } });
      h.driver.sendFollowUp({ text: 'do X instead', deliveryId: 'delivery-1' });
      writable = false;

      vi.advanceTimersByTime(INTERRUPT_ACK_DEADLINE_MS);

      expect(prompts(h)).toHaveLength(1);
      expect(h.emitted).toContainEqual({
        type: 'follow_up_dropped',
        deliveryIds: ['delivery-1'],
      });
      dropBeforeTerminal(h.emitted);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers FALSE when the cancel does not land, and stays settleable', () => {
    // An honest false is what keeps the message queued rather than committing a
    // user row nobody will answer. Nothing may be left waiting either: a
    // message parked behind a cancel that never went out would be sent into
    // whatever the turn does next.
    let writable = true;
    const h = harness({}, () => writable);
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 'sess-1' } });
    writable = false;

    expect(h.driver.sendFollowUp({ text: 'into a closed pipe' })).toBe(false);
    writable = true;

    expect(
      h.feed({ id: 3, result: { stopReason: 'end_turn' } }).map((e) => e.type),
    ).toContain('turn_complete');
    expect(prompts(h)).toHaveLength(1);
  });
});

describe('AcpSession — a SECOND turn on the same process', () => {
  /** A session that has handshaken and answered its first prompt. */
  function afterFirstTurn(overrides: Partial<AcpDriverOptions> = {}): Harness {
    const h = harness(overrides);
    h.feed(initializeReply(1, { image: true }));
    h.feed({
      id: 2,
      result: {
        sessionId: 'sess-1',
        modes: {
          currentModeId: 'agent',
          availableModes: [{ id: 'agent' }, { id: 'plan' }],
        },
        configOptions: [
          {
            id: 'context',
            category: 'model_config',
            currentValue: '300k',
            options: [{ value: '300k' }, { value: '1m' }],
          },
        ],
      },
    });
    // The first prompt's own reply, so the turn is genuinely over.
    h.feed({ id: 3, result: { stopReason: 'end_turn' } });
    return h;
  }

  it('prompts the LIVE session instead of handshaking again', () => {
    // The behaviour the whole split exists for: `initialize` and `session/new`
    // belong to the process, so a later turn sends neither — it sends its own
    // prompt into the conversation the first turn opened.
    const h = afterFirstTurn();
    h.openTurn({ prompt: 'and now the second thing', cwd: '/work' });

    expect(h.sentAll('initialize')).toHaveLength(1);
    expect(h.sentAll('session/new')).toHaveLength(1);
    const prompts = h.sentAll('session/prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.params).toMatchObject({ sessionId: 'sess-1' });
  });

  it('names the live session on a later turn, so a call it serves stays resumable', () => {
    // A team call continued on this kept process records the turn's
    // `session` event as its resume handle. The first turn announces it at
    // `session/new`; a later turn must announce it too, or the call is
    // recorded with no session and can never be continued.
    const h = afterFirstTurn();
    const before = h.emitted.length;

    h.openTurn({ prompt: 'and now the second thing', cwd: '/work' });

    expect(h.emitted.slice(before)).toContainEqual({
      type: 'session',
      sessionId: 'sess-1',
    });
  });

  it('sends the SECOND turn’s prompt, never the first’s', () => {
    // `input` was fixed at construction, so before the split this frame would
    // have carried `do the thing` — the first turn's words — a second time.
    const h = afterFirstTurn();
    h.openTurn({ prompt: 'and now the second thing', cwd: '/work' });

    const params = h.sentAll('session/prompt')[1]?.params as {
      prompt: { type: string; text?: string }[];
    };
    expect(params.prompt.some((block) => block.text === 'do the thing')).toBe(
      false,
    );
    expect(
      params.prompt.some((block) => block.text?.startsWith('and now')),
    ).toBe(true);
  });

  it('drops a reply the FIRST turn was still owed when the next one opened', () => {
    // It would otherwise settle the NEW turn under the first turn's stop reason
    // before the agent had answered a word of the second prompt.
    const h = harness();
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 'sess-1' } });
    h.openTurn({ prompt: 'second', cwd: '/work' });

    expect(h.feed({ id: 3, result: { stopReason: 'end_turn' } })).toEqual([]);
    // Only the second prompt's own reply settles the turn now running.
    expect(
      h.feed({ id: 4, result: { stopReason: 'end_turn' } }).map((e) => e.type),
    ).toContain('turn_complete');
  });

  it('does not re-send the FIRST turn’s attachments', () => {
    // The sharpest leak of the lot, and silent: the image blocks were read off
    // disk once, into a field that outlived the turn that owned them. A second
    // message with no attachment would have arrived carrying the first turn's
    // screenshot, and the agent would have answered about it.
    const dir = tempDir('acp-second-turn');
    const png = join(dir, 'shot.png');
    writeFileSync(png, Buffer.from([1, 2, 3]));
    const h = afterFirstTurn({
      input: {
        ...BASE_INPUT,
        images: [{ path: png, mediaType: 'image/png' }],
      },
    });
    expect(
      (h.sentAll('session/prompt')[0]?.params as { prompt: unknown[] }).prompt,
    ).toHaveLength(2);

    h.openTurn({ prompt: 'no picture this time', cwd: '/work' });
    expect(
      (h.sentAll('session/prompt')[1]?.params as { prompt: unknown[] }).prompt,
    ).toHaveLength(1);
  });

  /** The text of every `session/prompt` the harness wrote, oldest first. */
  function promptTexts(h: Harness): string[] {
    return h
      .sentAll('session/prompt')
      .map(
        (frame) =>
          (frame.params as { prompt: { text?: string }[] }).prompt.at(-1)
            ?.text ?? '',
      );
  }

  it('sends the instructions ONCE per session, not once per turn', () => {
    // Prompt text is part of the conversation here, so a block one turn
    // carries stays in the window for every turn after it. Sending the member's
    // instructions, its blocks and the user's instructions with every message put a
    // full copy of all of it into the window per turn.
    const h = afterFirstTurn({ composeSystemPrompt: () => 'THE BLOCK' });
    h.openTurn({ prompt: 'second', cwd: '/work' });
    h.feed({ id: 4, result: { stopReason: 'end_turn' } });
    h.openTurn({ prompt: 'third', cwd: '/work' });

    expect(promptTexts(h)).toEqual([
      `do the thing\n\n${hostBlock('THE BLOCK')}`,
      'second',
      'third',
    ]);
  });

  it('sends the instructions again when they changed between turns', () => {
    // A value rather than a flag on the session: a block that changed within
    // one conversation must reach the agent, not be withheld as "already sent".
    const h = afterFirstTurn({ composeSystemPrompt: () => 'OLD BLOCK' });
    h.openTurn(
      { prompt: 'second', cwd: '/work' },
      { composeSystemPrompt: () => 'NEW BLOCK' },
    );

    expect(promptTexts(h)[1]).toBe(`second\n\n${hostBlock('NEW BLOCK')}`);
  });

  it('does not count a prompt that was never written as delivered', () => {
    // Recorded on the WRITE: a prompt whose frame did not land told the agent
    // nothing, so the next prompt must still carry the block.
    let writable = true;
    const h = harness(
      { composeSystemPrompt: () => 'THE BLOCK' },
      () => writable,
    );
    h.feed(initializeReply(1));
    writable = false;
    h.feed({ id: 2, result: { sessionId: 'sess-1' } });
    writable = true;
    h.openTurn({ prompt: 'second', cwd: '/work' });

    expect(promptTexts(h)).toEqual([`second\n\n${hostBlock('THE BLOCK')}`]);
  });

  it('re-applies the model parameters the second turn asked for', () => {
    // `AgentAdapter.sessionKey` covers `model` and `effort`, so a change to
    // either respawns the process — and covers NOTHING else this transport can
    // set. A context window (or any other config option) changed between two
    // messages therefore reaches the agent only if the turn re-applies it,
    // which is what `beginTurn` is shared for.
    const h = afterFirstTurn();
    h.openTurn({
      prompt: 'second',
      cwd: '/work',
      // Supplied through the harness's own `turnOptions`, which re-derives the
      // per-turn half from whatever input the session hands it.
    });
    expect(h.sentAll('session/set_config_option')).toHaveLength(0);

    const wide = harness({
      modelSelection: {
        model: null,
        parameters: [{ id: 'context', value: '1m' }],
      },
    });
    wide.feed(initializeReply(1));
    wide.feed({
      id: 2,
      result: {
        sessionId: 'sess-2',
        configOptions: [
          {
            id: 'context',
            category: 'model_config',
            currentValue: '300k',
            options: [{ value: '300k' }, { value: '1m' }],
          },
        ],
      },
    });
    wide.feed({ id: 4, result: { stopReason: 'end_turn' } });
    expect(wide.sentAll('session/set_config_option')).toHaveLength(1);

    wide.openTurn({ prompt: 'second', cwd: '/work' });
    // TWICE: the second turn set it again rather than trusting a frame sent
    // before a turn the user may have changed the setting across.
    expect(wide.sentAll('session/set_config_option')).toHaveLength(2);
  });

  it('spends no frame on a mode the session is already in', () => {
    // The mode is a frame here rather than argv, which is why
    // `AgentAdapter.startTurn` hands the whole turn to the driver instead of
    // asking for a stdin line it cannot produce and refusing the turn. It is
    // also SESSION state, so a second turn wanting what turn 1 already set has
    // nothing to say — which is only knowable because an accepted `set_mode` is
    // recorded.
    const h = afterFirstTurn({ preferredModeId: 'plan' });
    expect(h.sentAll('session/set_mode')).toHaveLength(1);
    h.feed({ id: 3, result: {} }); // the mode frame's own acceptance
    h.openTurn({ prompt: 'second', cwd: '/work' });
    expect(h.sentAll('session/set_mode')).toHaveLength(1);
  });

  it('puts the session BACK when a later turn wants no special mode', () => {
    // The regression the session/turn split introduced, and it is a permission
    // one: a mode outlives the turn that set it, so a chat run under `plan` and
    // then switched back to `auto` sent nothing at all here — there being no
    // mode to ask for — and went on running read-only under a composer chip and
    // a run row that both read `auto`. Unreachable while every turn was a fresh
    // `session/new`, which is why one process per turn hid it completely.
    const h = afterFirstTurn({ preferredModeId: 'plan' });
    h.feed({ id: 3, result: {} });
    expect(h.sentAll('session/set_mode')[0]?.params).toMatchObject({
      modeId: 'plan',
    });

    // Turn 2 names no mode — so it wants the one the agent opened in.
    h.openTurn({ prompt: 'second', cwd: '/work' }, { preferredModeId: null });
    const frames = h.sentAll('session/set_mode');
    expect(frames).toHaveLength(2);
    expect(frames[1]?.params).toEqual({
      sessionId: 'sess-1',
      modeId: 'agent',
    });
  });

  it('answers a card raised in the PREVIOUS turn', () => {
    // `spawn-cli` re-holds an approval its turn settled without an answer and
    // re-offers it to the next turn, so a verdict routinely arrives while a
    // DIFFERENT turn is current. The parked payload is keyed by the JSON-RPC
    // request id — the session's namespace, not a turn's — and holding it on
    // the turn meant `buildApprovalResponse` found nothing and answered
    // undefined: the card read as answered and the agent stayed parked for
    // good. Unreachable while one process served one turn, because the session
    // died with the turn that raised it.
    const h = afterFirstTurn();
    const raised = h.feed({
      id: 'p-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 't-9', name: 'write_file', kind: 'edit' },
        options: [{ optionId: 'o-allow', name: 'Allow', kind: 'allow_once' }],
      },
    });
    const card = raised.find((event) => event.type === 'approval_request');
    expect(card).toBeDefined();

    // A whole turn later — the card was never answered while its own turn ran.
    h.openTurn({ prompt: 'second', cwd: '/work' });

    const reply = h.driver.buildApprovalResponse(card!.id, true);
    expect(reply).toBeDefined();
    expect(JSON.parse(reply!)).toMatchObject({
      id: 'p-1',
      result: { outcome: { outcome: 'selected', optionId: 'o-allow' } },
    });
  });

  it('fails only the turn whose attachment cannot be read', () => {
    // `openTurn` runs inside `spawn-cli`'s `startTurn`, after the turn is
    // registered as the session's current one — so a throw would leave a turn
    // nothing can settle and a session nobody can use again.
    const h = afterFirstTurn();
    expect(() =>
      h.openTurn({
        prompt: 'second',
        cwd: '/work',
        images: [{ path: '/nope/missing.png', mediaType: 'image/png' }],
      }),
    ).not.toThrow();
    expect(
      h.emitted.filter(
        (event) =>
          event.type === 'error' && event.message.includes('could not open'),
      ),
    ).toHaveLength(1);
    expect(h.sentAll('session/prompt')).toHaveLength(1);
  });
});

describe('AcpSession stop', () => {
  it('asks the agent to cancel in protocol rather than being killed', () => {
    // The turn's process now outlives it, so killing the group would destroy
    // the whole conversation and every delegate still out. `session/cancel` is
    // a NOTIFICATION — no id — and what actually ends the turn is the pending
    // `session/prompt` answering `cancelled`.
    const h = harness();
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 'sess-1' } });

    const frame = h.driver.buildInterruptPayload();
    expect(frame).toBeDefined();
    expect(JSON.parse(frame!)).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'sess-1' },
    });
  });

  it('has nothing to cancel before a session exists, and says so', () => {
    // `spawn-cli` reads undefined as "this turn can only be stopped by killing
    // it", which is the right answer for a process with no conversation to lose
    // — and the wrong one the moment there is, hence the arm above.
    expect(harness().driver.buildInterruptPayload()).toBeUndefined();
  });

  it('answers every parked permission request `cancelled` BEFORE the cancel goes out', () => {
    // ACP's schema on the Cancelled outcome: a client sending `session/cancel`
    // "MUST respond to all pending `session/request_permission` requests with
    // this `Cancelled` outcome". Left unanswered, the agent stayed parked on a
    // request whose card had been written off with the stopped turn.
    const h = harness();
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 'sess-1' } });
    h.feed({
      id: 7,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 't-1', kind: 'execute' },
        options: [
          { optionId: 'o-allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'o-reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    expect(h.sent.some((frame) => frame.id === 7)).toBe(false);

    const frame = h.driver.buildInterruptPayload();

    expect(h.sent.find((sent) => sent.id === 7)?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(JSON.parse(frame!)).toMatchObject({ method: 'session/cancel' });
    // Answered once: a verdict pressed on the stale card writes nothing.
    expect(h.driver.buildApprovalResponse('n:7', true)).toBeUndefined();
  });

  it('answers a parked vendor QUESTION with its own declined reply on Stop', () => {
    // A question has no `cancelled` in the vendor's shape, and its handler
    // waits on the reply with no deadline — so it is declined, not left.
    const question = {
      method: 'vendor/ask_question',
      toolName: 'vendor/ask_question',
      accepts: () => true,
      card: () => [],
      encodeReply: (_params: unknown, allow: boolean) => ({
        outcome: allow ? 'answered' : 'declined',
      }),
    };
    const h = harness({ question });
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 'sess-1' } });
    h.feed({ id: 9, method: 'vendor/ask_question', params: { questions: [] } });

    h.driver.buildInterruptPayload();

    expect(h.sent.find((sent) => sent.id === 9)?.result).toEqual({
      outcome: 'declined',
    });
  });

  it('does not resume a transient failure the user has already stopped', () => {
    // The resume answers a dropped connection with a fresh prompt. After Stop
    // that is work nobody asked for — and the failure may be the cancel itself.
    const h = harness({
      agentFailure: {
        read: (text) => (text.startsWith('\n\nError: ') ? text.trim() : null),
        resume: {
          isTransient: () => true,
          prompt: () => 'continue',
          delaysMs: [0, 0, 0],
          maxPerTurn: 10,
        },
      },
    });
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 's' } });
    h.feed(
      update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: '\n\nError: RetriableError: [canceled]',
        },
      }),
    );

    h.driver.buildInterruptPayload();
    const events = h.feed({ id: 3, result: { stopReason: 'end_turn' } });

    expect(h.sentAll('session/prompt')).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
  });
});

describe('AcpSession — a Stop that lands before the prompt went out', () => {
  /** A turn whose prompt waits on a parameter frame the agent has not answered. */
  function heldBehindConfig(): Harness {
    const h = harness({
      promptAwaitsConfig: true,
      input: { ...BASE_INPUT, model: 'claude-opus-5' },
      modelSelection: {
        model: 'claude-opus-5',
        parameters: [{ id: 'context', value: '1m' }],
      },
    });
    h.feed(initializeReply(1));
    h.feed({
      id: 2,
      result: {
        sessionId: 's-1',
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: 'claude-opus-5',
            options: [{ value: 'claude-opus-5', name: 'claude-opus-5' }],
          },
          {
            id: 'context',
            category: 'model_config',
            currentValue: '300k',
            options: [
              { value: '300k', name: '300K' },
              { value: '1m', name: '1M' },
            ],
          },
        ],
      },
    });
    expect(h.sentMethod('session/set_config_option')).toBeDefined();
    expect(h.sentMethod('session/prompt')).toBeUndefined();
    return h;
  }

  it('withdraws the held prompt, so the config reply can no longer release it', () => {
    // The agent has been asked nothing, so a `session/cancel` cancels no
    // prompt and the agent stays silent — so the held prompt is withdrawn, or
    // the config reply arriving next would send it INTO the stopped turn.
    const h = heldBehindConfig();

    expect(h.driver.withdrawHeldPrompt()).toBe(true);
    const events = h.feed({ id: 3, result: { configOptions: [] } });

    expect(h.sentMethod('session/prompt')).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('narrates nothing when the frame it was held behind is then REFUSED', () => {
    // A degrade sentence about a turn that no longer exists would reach the
    // owner as off-turn output, which a settled run reads as work resuming.
    const h = heldBehindConfig();
    h.driver.withdrawHeldPrompt();

    const events = h.feed({
      id: 3,
      error: { code: -32602, message: 'Invalid params' },
    });

    expect(events).toEqual([]);
    expect(h.sentMethod('session/prompt')).toBeUndefined();
  });

  it('has nothing to withdraw once the prompt is out, or before a session exists', () => {
    const before = harness();
    expect(before.driver.withdrawHeldPrompt()).toBe(false);

    const running = harness();
    running.feed(initializeReply(1));
    running.feed({ id: 2, result: { sessionId: 's-1' } });
    expect(running.sentMethod('session/prompt')).toBeDefined();
    expect(running.driver.withdrawHeldPrompt()).toBe(false);
  });
});

describe('AcpSession — whether the process can serve another turn', () => {
  it('cannot once its handshake failed and it holds no session', () => {
    // The process lives on after a refused handshake, and a later turn opened
    // on it wrote no frame at all — its prompt returns early on a null session
    // — then sat silent until the 30-minute deadline.
    const h = harness();
    h.feed({ id: 1, error: { code: -32603, message: 'boom' } });
    expect(h.driver.canOpenTurn()).toBe(false);

    const noId = harness();
    noId.feed(initializeReply(1));
    noId.feed({ id: 2, result: {} });
    expect(noId.driver.canOpenTurn()).toBe(false);
  });

  it('can once it holds a conversation', () => {
    const h = harness();
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 'sess-1' } });
    expect(h.driver.canOpenTurn()).toBe(true);
  });
});

describe('AcpSession — skipping unchanged parameters', () => {
  const selection = {
    model: 'gpt-5.6-sol',
    parameters: [{ id: 'effort', alternateIds: ['reasoning'], value: 'high' }],
  };
  function options(
    model: string,
    currentValue: string | null,
  ): Record<string, unknown> {
    return {
      sessionId: 's-1',
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: model,
          options: [{ value: 'gpt-5.6-sol' }, { value: 'other-model' }],
        },
        {
          id: 'reasoning',
          category: 'thought_level',
          currentValue,
          options: [{ value: 'medium' }, { value: 'high' }],
        },
      ],
    };
  }
  function open(
    currentValue: string | null,
    overrides: Partial<AcpDriverOptions> = {},
  ): Harness {
    const h = harness({
      promptAwaitsConfig: true,
      skipUnchangedParameters: true,
      modelSelection: selection,
      ...overrides,
    });
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: options('gpt-5.6-sol', currentValue) });
    return h;
  }

  it('skips the resolved option when it already matches, even when prompts await config', () => {
    const h = open('high');
    expect(h.sentAll('session/set_config_option')).toEqual([]);
    expect(h.sentAll('session/prompt')).toHaveLength(1);
  });

  it('sends a differing value, holds the prompt, and skips it on the next live turn after confirmation', () => {
    const h = open('medium');
    expect(h.sentMethod('session/set_config_option')?.params).toEqual({
      sessionId: 's-1',
      configId: 'reasoning',
      value: 'high',
    });
    expect(h.sentAll('session/prompt')).toEqual([]);
    h.feed({ id: 3, result: options('gpt-5.6-sol', 'high') });
    const prompt = h.sentMethod('session/prompt')!;
    h.feed({ id: prompt.id, result: { stopReason: 'end_turn' } });
    h.openTurn(BASE_INPUT);
    expect(h.sentAll('session/set_config_option')).toHaveLength(1);
    expect(h.sentAll('session/prompt')).toHaveLength(2);
  });

  it('uses the model frame reply at send time in both directions, rather than the session reply', () => {
    for (const [before, after] of [
      ['medium', 'high'],
      ['high', 'medium'],
    ] as const) {
      const h = open(before, {
        modelSelection: { ...selection, model: 'other-model' },
      });
      expect(h.sentAll('session/set_config_option')).toHaveLength(1);
      expect(h.sentAll('session/prompt')).toEqual([]);
      h.feed({ id: 3, result: options('other-model', after) });
      if (after === 'high') {
        expect(h.sentAll('session/set_config_option')).toHaveLength(1);
        expect(h.sentAll('session/prompt')).toHaveLength(1);
      } else {
        expect(h.sentAll('session/set_config_option')).toHaveLength(2);
        expect(h.sentAll('session/prompt')).toEqual([]);
        h.feed({ id: 4, result: options('other-model', 'high') });
        expect(h.sentAll('session/prompt')).toHaveLength(1);
      }
    }
  });

  it('sends again when a parameter reply describes no current values', () => {
    const h = open('high', {
      modelSelection: {
        ...selection,
        parameters: [
          ...selection.parameters,
          { id: 'reasoning', value: 'medium' },
        ],
      },
    });
    // The first frame is skipped. The second frame's reply says nothing about
    // current values, so a later turn must send again rather than reuse high.
    expect(h.sentAll('session/set_config_option')).toHaveLength(1);
    expect(h.sentMethod('session/set_config_option')?.params).toEqual({
      sessionId: 's-1',
      configId: 'reasoning',
      value: 'medium',
    });
    h.feed({ id: 3, result: {} });
    const prompt = h.sentMethod('session/prompt')!;
    h.feed({ id: prompt.id, result: { stopReason: 'end_turn' } });
    h.openTurn(BASE_INPUT, { modelSelection: selection });
    expect(h.sentAll('session/set_config_option')).toHaveLength(2);
    expect(h.sentAll('session/prompt')).toHaveLength(1);
  });

  it('uses each parameter reply for the next queued comparison', () => {
    const h = open('high', {
      modelSelection: {
        ...selection,
        parameters: [
          ...selection.parameters,
          { id: 'reasoning', value: 'medium' },
          { id: 'reasoning', value: 'high' },
        ],
      },
    });
    expect(h.sentAll('session/set_config_option')).toHaveLength(1);
    h.feed({ id: 3, result: options('gpt-5.6-sol', 'medium') });
    expect(h.sentAll('session/set_config_option')).toHaveLength(2);
    expect(h.sentAll('session/prompt')).toEqual([]);
    h.feed({ id: 4, result: options('gpt-5.6-sol', 'high') });
    expect(h.sentAll('session/prompt')).toHaveLength(1);
  });

  it('keeps sending equal values for an agent that has not opted in', () => {
    expect(open('high').sentAll('session/set_config_option')).toEqual([]);
    const h = open('high', { skipUnchangedParameters: false });
    expect(h.sentAll('session/set_config_option')).toHaveLength(1);
    expect(h.sentAll('session/prompt')).toEqual([]);
  });

  it('skips only a known match, still sending an option with no current value', () => {
    const known = open('high');
    expect(known.sentAll('session/set_config_option')).toEqual([]);
    const unknown = open(null);
    expect(unknown.sentMethod('session/set_config_option')?.params).toEqual({
      sessionId: 's-1',
      configId: 'reasoning',
      value: 'high',
    });
    expect(unknown.sentAll('session/prompt')).toEqual([]);
  });
});

describe('AcpSession — the result an MCP call is written with', () => {
  const opening = (id: string, tool: string, args: unknown) =>
    update({
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: `srv: ${tool}`,
      kind: 'other',
      status: 'in_progress',
      rawInput: { server: 'srv', tool, args },
    });
  const settled = (id: string, rawOutput: unknown) =>
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: 'completed',
      rawOutput,
    });
  const mcpToolCall: NonNullable<AcpSessionOptions['mcpToolCall']> = (call) => {
    const input = call.rawInput as {
      server?: string;
      tool?: string;
      args?: unknown;
    } | null;
    return input?.server === undefined || input.tool === undefined
      ? null
      : { server: input.server, tool: input.tool, args: input.args ?? null };
  };

  it('asks the reader for the result of a call it named, with the call and what was reported', () => {
    const seen: unknown[] = [];
    const h = harness({
      mcpToolCall,
      mcpToolResult: (call, reported) => {
        seen.push({ call, reported });
        return { served: call.tool };
      },
    });
    h.feed(opening('mcp-1', 'team_notes', { limit: 5 }));

    expect(h.feed(settled('mcp-1', { success: true }))).toEqual([
      {
        type: 'tool_result',
        id: 'mcp-1',
        name: 'mcp__srv__team_notes',
        result: { served: 'team_notes' },
        isError: false,
      },
    ]);
    expect(seen).toEqual([
      {
        call: { server: 'srv', tool: 'team_notes', args: { limit: 5 } },
        reported: { success: true },
      },
    ]);
  });

  it('asks only once per call, so a repeated settle writes what was reported', () => {
    let asked = 0;
    const h = harness({
      mcpToolCall,
      mcpToolResult: () => {
        asked += 1;
        return 'served';
      },
    });
    h.feed(opening('mcp-1', 'team_notes', {}));
    const first = h.feed(settled('mcp-1', { success: true }));
    const second = h.feed(settled('mcp-1', { success: true }));

    expect(asked).toBe(1);
    expect(first).toEqual([expect.objectContaining({ result: 'served' })]);
    expect(second).not.toContainEqual(
      expect.objectContaining({ result: 'served' }),
    );
  });

  it('leaves the result of a call no reader named as it was reported', () => {
    const h = harness({
      mcpToolCall,
      mcpToolResult: () => 'served',
    });
    h.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'sh-1',
        title: '`ls`',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls' },
      }),
    );

    expect(h.feed(settled('sh-1', { exitCode: 0 }))).toEqual([
      expect.objectContaining({ id: 'sh-1', result: { exitCode: 0 } }),
    ]);
  });
});
