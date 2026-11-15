import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentEvent, TurnIo } from '../../adapter.types';
import {
  BACKGROUND_AGENT,
  BACKGROUND_CALL,
  backgroundDelegateLines,
  backgroundLaunchAck,
  backgroundTranscriptLines,
  FOREGROUND_AGENT,
  FOREGROUND_CALL,
  foregroundClose,
  mainThreadLines,
  SESSION,
  taskNotification,
} from './__tests__/claude-subagent-stream';
import type { ClaudeListPrices } from './claude-delegate-cost.utils';
import {
  ClaudeDelegateSettler,
  type ClaudeDelegateTotals,
  readDelegateEnd,
  readDelegateTranscriptFile,
} from './claude-delegate-spend.utils';
import { mapClaudeMessage } from './claude-message.utils';
import { ClaudeSessionCostLedger } from './claude-usage.utils';

/** One dollar per million of each kind, so a figure reads as its token sum. */
const FLAT: ClaudeListPrices = (model) =>
  model === 'claude-haiku-5-5'
    ? {
        input: 1,
        output: 1,
        cacheRead: 1,
        cacheWrite: 1,
        tiers: [],
        contextTokens: null,
      }
    : null;

const launchOf =
  (ledger: ClaudeSessionCostLedger) =>
  (taskId: string, toolCallId: string | null) =>
    ledger.launchOfTask(taskId, toolCallId);

function settlerFor(
  ledger: ClaudeSessionCostLedger,
  readTranscript: (
    sessionId: string,
    agentId: string,
  ) => Promise<ClaudeDelegateTotals | null>,
): ClaudeDelegateSettler {
  return new ClaudeDelegateSettler({
    tracker: ledger.delegateSpend,
    launchOfTask: launchOf(ledger),
    priceNow: (sessionId, spend) => ledger.delegates.priceNow(sessionId, spend),
    record: (sessionId, delegateId, spend) =>
      ledger.delegates.record(sessionId, delegateId, spend),
    readTranscript,
  });
}

function progressOf(events: AgentEvent[]) {
  return events.flatMap((event) =>
    event.type === 'delegate_progress' ? [event] : [],
  );
}

const transcriptTotals: ClaudeDelegateTotals = {
  requests: 2,
  inputTokens: 4,
  outputTokens: 165,
  cacheReadTokens: 35_605,
  cacheCreationTokens: 39_793,
  contextTokens: 39_883,
  model: 'claude-haiku-5-5',
};

describe('a delegate’s requests off the stream', () => {
  it('counts a response split over several lines once, tokens and all', () => {
    const ledger = new ClaudeSessionCostLedger(FLAT);
    const progress = progressOf(
      backgroundDelegateLines.flatMap((line) => mapClaudeMessage(line, ledger)),
    );

    expect(progress).toHaveLength(2);
    expect(progress[1]).toMatchObject({
      delegateId: BACKGROUND_CALL,
      final: false,
      figures: {
        requests: 2,
        inputTokens: 4,
        outputTokens: 20,
        cacheReadTokens: 35_605,
        cacheCreationTokens: 39_793,
        contextTokens: 2 + 3 + 35_605 + 4_188,
        model: 'claude-haiku-5-5',
        costUsd: null,
      },
    });
    expect(progress[1]?.figures.estimatedCostUsd).toBeCloseTo(
      (4 + 20 + 35_605 + 39_793) / 1_000_000,
      9,
    );
  });

  it('reports the main thread’s request ONCE however many lines it is split into', () => {
    const ledger = new ClaudeSessionCostLedger(FLAT);
    const usage = mainThreadLines
      .flatMap((line) => mapClaudeMessage(line, ledger))
      .filter((event) => event.type === 'usage_progress');

    expect(usage).toEqual([
      {
        type: 'usage_progress',
        inputTokens: 2,
        outputTokens: 2,
        cacheReadTokens: 27_662,
        cacheCreationTokens: 19_091,
      },
    ]);
  });

  it('does not count the closing request twice when its response WAS streamed', () => {
    const ledger = new ClaudeSessionCostLedger(FLAT);
    for (const line of backgroundDelegateLines) {
      mapClaudeMessage(line, ledger);
    }
    const close = {
      ...foregroundClose,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: BACKGROUND_CALL, content: [] },
        ],
      },
      tool_use_result: {
        ...(foregroundClose.tool_use_result as Record<string, unknown>),
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          cache_read_input_tokens: 35_605,
          cache_creation_input_tokens: 4_188,
        },
      },
    };

    expect(progressOf(mapClaudeMessage(close, ledger))).toEqual([]);
    expect(
      ledger.delegateSpend.totalsOf(SESSION, BACKGROUND_CALL)?.requests,
    ).toBe(2);
  });

  it('leaves an unpriced model without a cost rather than at zero', () => {
    const ledger = new ClaudeSessionCostLedger(() => null);
    const [progress] = progressOf(
      mapClaudeMessage(backgroundDelegateLines[0] ?? {}, ledger),
    );

    expect(progress?.figures.estimatedCostUsd).toBeNull();
    expect(progress?.figures.costUsd).toBeNull();
  });
});

describe('readDelegateTranscriptFile', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  async function transcript(lines: unknown[]): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'delegate-transcript-'));
    const path = join(dir, `agent-${BACKGROUND_AGENT}.jsonl`);
    await writeFile(
      path,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
    return path;
  }

  it('reads every request once, with the output tokens the stream never had', async () => {
    const totals = await readDelegateTranscriptFile(
      await transcript(backgroundTranscriptLines),
    );

    expect(totals).toEqual({
      requests: 2,
      inputTokens: 4,
      outputTokens: 77 + 88,
      cacheReadTokens: 35_605,
      cacheCreationTokens: 35_605 + 4_188,
      contextTokens: 2 + 88 + 35_605 + 4_188,
      model: 'claude-haiku-5-5',
      // One response carried text ("BETA"); the tool_use one did not.
      messages: 1,
    });
  });

  it('answers null for a missing file and for one recording no request', async () => {
    expect(
      await readDelegateTranscriptFile('/nonexistent/agent-x.jsonl'),
    ).toBeNull();
    expect(
      await readDelegateTranscriptFile(
        await transcript([backgroundTranscriptLines[0]]),
      ),
    ).toBeNull();
  });

  it('keeps every complete request when the last line is still being written', async () => {
    const path = await transcript(backgroundTranscriptLines);
    await writeFile(path, '{"type":"assistant","message":{"id":"msg_torn"', {
      flag: 'a',
    });
    expect((await readDelegateTranscriptFile(path))?.requests).toBe(2);
  });
});

describe('readDelegateEnd', () => {
  it('reads a terminal task_notification as the end of the delegate it names', () => {
    const ledger = new ClaudeSessionCostLedger();
    expect(
      readDelegateEnd(
        taskNotification(BACKGROUND_AGENT, BACKGROUND_CALL, 'completed'),
        launchOf(ledger),
      ),
    ).toEqual({
      sessionId: SESSION,
      delegateId: BACKGROUND_CALL,
      agentId: BACKGROUND_AGENT,
    });
  });

  it('credits a RESUMED delegate’s end to the call that first launched it', () => {
    const ledger = new ClaudeSessionCostLedger();
    ledger.launchOfTask(BACKGROUND_AGENT, BACKGROUND_CALL);
    expect(
      readDelegateEnd(
        taskNotification(BACKGROUND_AGENT, 'toolu_send_message', 'completed'),
        launchOf(ledger),
      )?.delegateId,
    ).toBe(BACKGROUND_CALL);
  });

  it('reads a foreground delegate’s closing tool_use_result as its end', () => {
    expect(
      readDelegateEnd(foregroundClose, launchOf(new ClaudeSessionCostLedger())),
    ).toEqual({
      sessionId: SESSION,
      delegateId: FOREGROUND_CALL,
      agentId: FOREGROUND_AGENT,
    });
  });

  it('never reads a background launch acknowledgement or a running status as an end', () => {
    const launch = launchOf(new ClaudeSessionCostLedger());
    expect(readDelegateEnd(backgroundLaunchAck, launch)).toBeNull();
    expect(
      readDelegateEnd(
        taskNotification(BACKGROUND_AGENT, BACKGROUND_CALL, 'running'),
        launch,
      ),
    ).toBeNull();
  });
});

describe('ClaudeDelegateSettler', () => {
  it('replaces the stream estimate with the transcript and announces it as final and cumulative', async () => {
    const ledger = new ClaudeSessionCostLedger(FLAT);
    for (const line of backgroundDelegateLines) {
      mapClaudeMessage(line, ledger);
    }
    const asked: string[] = [];
    const settler = settlerFor(ledger, (sessionId, agentId) => {
      asked.push(`${sessionId}/${agentId}`);
      return Promise.resolve(transcriptTotals);
    });

    const events = await settler.settle({
      sessionId: SESSION,
      delegateId: BACKGROUND_CALL,
      agentId: BACKGROUND_AGENT,
    });

    expect(asked).toEqual([`${SESSION}/${BACKGROUND_AGENT}`]);
    expect(events[0]).toMatchObject({
      type: 'delegate_progress',
      delegateId: BACKGROUND_CALL,
      final: true,
      figures: {
        requests: 2,
        outputTokens: 165,
        contextTokens: 39_883,
        costUsd: null,
      },
    });
    expect(events[1]).toMatchObject({
      type: 'subagent_info',
      id: BACKGROUND_CALL,
      requests: 2,
      tokens: 4 + 165 + 35_605 + 39_793,
      outputTokens: 165,
      contextTokens: 39_883,
      cumulative: true,
    });
  });

  it('falls back to the stream figures when the transcript cannot be read', async () => {
    const ledger = new ClaudeSessionCostLedger(FLAT);
    for (const line of backgroundDelegateLines) {
      mapClaudeMessage(line, ledger);
    }

    const events = await settlerFor(ledger, () => Promise.resolve(null)).settle(
      {
        sessionId: SESSION,
        delegateId: BACKGROUND_CALL,
        agentId: BACKGROUND_AGENT,
      },
    );

    expect(progressOf(events)[0]?.figures).toMatchObject({
      requests: 2,
      outputTokens: 20,
    });
  });

  it('reads the transcript again while it lags the stream, then takes it once it has caught up', async () => {
    const ledger = new ClaudeSessionCostLedger(FLAT);
    for (const line of backgroundDelegateLines) {
      mapClaudeMessage(line, ledger);
    }
    const lagging: ClaudeDelegateTotals = { ...transcriptTotals, requests: 1 };
    const reads = [lagging, lagging, transcriptTotals];
    const waits: number[] = [];
    const settler = new ClaudeDelegateSettler({
      tracker: ledger.delegateSpend,
      launchOfTask: launchOf(ledger),
      priceNow: () => null,
      record: () => undefined,
      readTranscript: () => Promise.resolve(reads.shift() ?? null),
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });

    const events = await settler.settle({
      sessionId: SESSION,
      delegateId: BACKGROUND_CALL,
      agentId: BACKGROUND_AGENT,
    });

    expect(waits).toHaveLength(2);
    expect(progressOf(events)[0]?.figures).toMatchObject({
      requests: 2,
      outputTokens: 165,
    });
  });

  it('never states fewer requests than the stream saw when the transcript never catches up', async () => {
    const ledger = new ClaudeSessionCostLedger(FLAT);
    for (const line of backgroundDelegateLines) {
      mapClaudeMessage(line, ledger);
    }
    const settler = new ClaudeDelegateSettler({
      tracker: ledger.delegateSpend,
      launchOfTask: launchOf(ledger),
      priceNow: () => null,
      record: () => undefined,
      readTranscript: () =>
        Promise.resolve({ ...transcriptTotals, requests: 1 }),
      wait: () => Promise.resolve(),
    });

    const events = await settler.settle({
      sessionId: SESSION,
      delegateId: BACKGROUND_CALL,
      agentId: BACKGROUND_AGENT,
    });

    expect(progressOf(events)[0]?.figures).toMatchObject({
      requests: 2,
      outputTokens: 20,
    });
  });

  it('says nothing for a unit it holds no figures for', async () => {
    const ledger = new ClaudeSessionCostLedger(FLAT);
    const events = await settlerFor(ledger, () => Promise.resolve(null)).settle(
      { sessionId: SESSION, delegateId: 'toolu_bash', agentId: 'bash_1' },
    );
    expect(events).toEqual([]);
  });

  it('prices an ended delegate with the session’s last calibration, and the next result re-prices it', async () => {
    const ledger = new ClaudeSessionCostLedger(FLAT);
    const result = (costUsd: number): Record<string, unknown> => ({
      type: 'result',
      subtype: 'success',
      session_id: SESSION,
      result: 'DONE',
      total_cost_usd: costUsd,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        'claude-haiku-5-5': {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: costUsd,
        },
      },
    });
    mapClaudeMessage(result(1.5), ledger);
    const list = (4 + 165 + 35_605 + 39_793) / 1_000_000;

    const ended = await settlerFor(ledger, () =>
      Promise.resolve(transcriptTotals),
    ).settle({
      sessionId: SESSION,
      delegateId: BACKGROUND_CALL,
      agentId: BACKGROUND_AGENT,
    });
    expect(progressOf(ended)[0]?.figures.costUsd).toBeCloseTo(list * 1.5, 9);

    const settled = mapClaudeMessage(result(2), ledger);
    expect(settled).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: BACKGROUND_CALL,
        costUsd: expect.closeTo(list * 2, 9),
      }),
    );
    expect(progressOf(settled)[0]).toMatchObject({
      delegateId: BACKGROUND_CALL,
      final: true,
      figures: { costUsd: expect.closeTo(list * 2, 9) },
    });
  });

  it('never holds a delegate a result line already priced, so a later end bills no later turn', async () => {
    const ledger = new ClaudeSessionCostLedger(FLAT);
    const result: Record<string, unknown> = {
      type: 'result',
      subtype: 'success',
      session_id: SESSION,
      result: 'DONE',
      total_cost_usd: 1.5,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        'claude-haiku-5-5': {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 1.5,
        },
      },
    };
    const settler = settlerFor(ledger, () => Promise.resolve(transcriptTotals));
    const end = {
      sessionId: SESSION,
      delegateId: BACKGROUND_CALL,
      agentId: BACKGROUND_AGENT,
    };
    await settler.settle(end);
    expect(
      mapClaudeMessage(result, ledger).some(
        (event) =>
          event.type === 'subagent_info' && event.id === BACKGROUND_CALL,
      ),
    ).toBe(true);

    const again = await settler.settle(end);
    expect(progressOf(again)[0]?.figures.costUsd).toBeCloseTo(
      ((4 + 165 + 35_605 + 39_793) / 1_000_000) * 1.5,
      9,
    );
    expect(
      mapClaudeMessage(result, ledger).some(
        (event) =>
          event.type === 'subagent_info' && event.id === BACKGROUND_CALL,
      ),
    ).toBe(false);
  });

  it('emits through the process it is attached to, once per end, re-reading an end that arrives mid-read', async () => {
    const ledger = new ClaudeSessionCostLedger(FLAT);
    for (const line of backgroundDelegateLines) {
      mapClaudeMessage(line, ledger);
    }
    const emitted: AgentEvent[] = [];
    let release: (() => void) | null = null;
    let reads = 0;
    const settler = settlerFor(ledger, () => {
      reads += 1;
      return new Promise((resolve) => {
        release = () => resolve(transcriptTotals);
      });
    });
    settler.attach({
      write: () => true,
      emit: (event: AgentEvent) => emitted.push(event),
    } as unknown as TurnIo);

    const end = taskNotification(
      BACKGROUND_AGENT,
      BACKGROUND_CALL,
      'completed',
    );
    settler.observe(end);
    settler.observe(end);
    expect(reads).toBe(1);
    (release as (() => void) | null)?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(2);
    (release as (() => void) | null)?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(progressOf(emitted)).toHaveLength(2);
    expect(progressOf(emitted).every((event) => event.final)).toBe(true);
  });
});
