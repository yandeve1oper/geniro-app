import type { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { clearSecrets, redactSecrets } from '../../../diagnostics/utils/redact';
import { AgentKind } from '../../../runs/runs.types';
import { FakeChild, fakeSpawn } from '../../__tests__/fake-child';
import { MAX_ANSWER_LENGTH } from '../../chat.types';
import type { AgentVersionService } from '../../services/agent-version.service';
import type { ProcessRegistry } from '../../services/process-registry';
import { deliverApprovalAnswer } from '../../utils/approval-answer';
import { fakeGroupChild } from '../__tests__/fake-group-child';
import type {
  AgentEvent,
  AgentSession,
  AgentTurnInput,
  SubagentRecoveryRef,
  TurnDriver,
} from '../adapter.types';
import { CodexAdapter, type CodexAdapterOptions } from './codex.adapter';
import {
  CODEX_BUILTIN_SIGN_IN_REASON,
  CODEX_BUILTIN_TOGGLE_REASON,
  CODEX_SESSION_SEARCH_PAGE,
} from './codex.const';

const THREAD = '01a0e3aa-7dc4-7703-8a60-497958241fd1';

/** The protected turn hooks, reached the way the base reaches them. */
class ProbedCodexAdapter extends CodexAdapter {
  args(input: AgentTurnInput): string[] {
    return this.buildArgs(input);
  }
  env(input: AgentTurnInput): Record<string, string> {
    return this.buildEnv(input);
  }
  driver(input: AgentTurnInput): TurnDriver {
    return this.createTurnDriver(input);
  }
}

const versions = {
  resolve: () => Promise.resolve('0.157.1'),
} as unknown as AgentVersionService;

/** stdout of a one-shot app-server whose request answered `result`. */
function answered(result: unknown): string {
  return `{"id":1,"result":{"userAgent":"codex"}}\n${JSON.stringify({ id: 2, result })}\n`;
}

/**
 * A group spawn that answers each one-shot with `stdout` — given a list, the
 * n-th spawn gets the n-th entry and the last one repeats — recording each.
 */
function oneshotSpawn(stdout: string | readonly string[]): {
  groupSpawnFn: typeof spawn;
  calls: {
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    stdin: string[];
    stdinEnded: () => boolean;
  }[];
} {
  const calls: {
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    stdin: string[];
    stdinEnded: () => boolean;
  }[] = [];
  const replies = typeof stdout === 'string' ? [stdout] : stdout;
  const groupSpawnFn = ((
    _command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    const fake = fakeGroupChild(4242);
    const reply = replies[Math.min(calls.length, replies.length - 1)]!;
    calls.push({
      args,
      env: options.env ?? {},
      stdin: fake.stdinChunks,
      stdinEnded: () => fake.child.stdin?.writableEnded === true,
    });
    queueMicrotask(() => {
      fake.writeStdout(reply);
      fake.close(0);
    });
    return fake.child;
  }) as unknown as typeof spawn;
  return { groupSpawnFn, calls };
}

function adapterWith(
  options: Partial<CodexAdapterOptions> = {},
): ProbedCodexAdapter {
  return new ProbedCodexAdapter({
    versions,
    clientVersion: '1.0.0',
    ...options,
  });
}

function sentMethods(stdin: string[]): string[] {
  return stdin
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { method: string }).method);
}

/** The params of the one frame a one-shot sent for `method`. */
function paramsSentFor(stdin: string[], method: string): unknown {
  const frame = stdin
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; params?: unknown })
    .find((candidate) => candidate.method === method);
  expect(frame).toBeDefined();
  return frame?.params;
}

const USER_ORIGIN = {
  name: { type: 'user', file: '/Users/x/.codex/config.toml', profile: null },
  version: 'v1',
};

/** A `config/read` result whose USER config defines `linear`. */
const LINEAR_IN_USER_CONFIG = {
  config: { mcp_servers: { linear: { url: 'https://mcp.linear.app/mcp' } } },
  origins: { 'mcp_servers.linear.url': USER_ORIGIN },
};

/**
 * A group spawn that behaves like an app-server: it answers each request
 * frame written to its stdin, by method, as it arrives — so a dialogue whose
 * next frame depends on a reply is driven end to end through `runCommand`.
 */
function appServerSpawn(
  answer: (
    method: string,
    params: unknown,
  ) => { result: unknown } | { error: string },
): {
  groupSpawnFn: typeof spawn;
  calls: { args: readonly string[]; env: NodeJS.ProcessEnv; stdin: string[] }[];
} {
  const calls: {
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    stdin: string[];
  }[] = [];
  const groupSpawnFn = ((
    _command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    const fake = fakeGroupChild(9_200_000 + calls.length);
    calls.push({ args, env: options.env ?? {}, stdin: fake.stdinChunks });
    let pending = '';
    fake.child.stdin?.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      let at: number;
      while ((at = pending.indexOf('\n')) >= 0) {
        const frame = JSON.parse(pending.slice(0, at)) as {
          id?: number;
          method: string;
          params?: unknown;
        };
        pending = pending.slice(at + 1);
        if (frame.id === undefined) {
          continue;
        }
        const reply =
          frame.method === 'initialize'
            ? { result: {} }
            : answer(frame.method, frame.params);
        const line =
          'error' in reply
            ? { id: frame.id, error: { code: -32600, message: reply.error } }
            : { id: frame.id, result: reply.result };
        queueMicrotask(() => fake.writeStdout(`${JSON.stringify(line)}\n`));
      }
    });
    return fake.child;
  }) as unknown as typeof spawn;
  return { groupSpawnFn, calls };
}

describe('CodexAdapter config', () => {
  const config = adapterWith().getConfig();

  it('withholds codex’s credentials and account home from every other agent', () => {
    expect(config.auth.isolatedEnvKeys).toEqual(
      expect.arrayContaining(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME']),
    );
    // Only a credential the user exported comes back — never the home, which
    // is the run's own config directory's to decide.
    expect(config.auth.inheritedEnvKeys).toContain('OPENAI_API_KEY');
    expect(config.auth.inheritedEnvKeys).not.toContain('CODEX_HOME');
  });

  it('never sizes a turn from the catalog, whose window codex does not enforce', async () => {
    // models.dev states gpt-6.1-sol at 1,050,000; codex enforces 475,000 by
    // default and 828,400 at `872k` (measured 2026-10-16).
    const adapter = adapterWith({
      prices: {
        priceOf: () => ({
          input: 1,
          output: 5,
          cacheRead: null,
          cacheWrite: null,
          tiers: [],
          contextTokens: 1_050_000,
        }),
      },
    });
    expect(adapter.catalogWindow('gpt-6.1-sol')).toBeNull();
    // codex's model names are its ids: nothing to resolve.
    expect(await adapter.resolveModel('gpt-6.1-sol', null)).toBe('gpt-6.1-sol');
  });

  it('recognises codex’s own usage-limit wording and when it resets', () => {
    const adapter = adapterWith();
    expect(
      adapter.failureFrom(
        "You've hit your usage limit. Upgrade to Pro or try again at 6:10 PM.",
      ),
    ).toEqual({ class: 'rate_limited', resetsAt: '6:10 PM' });
    expect(
      adapter.errorRecovery(
        'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
      ),
    ).toBe('cli-login');
  });
});

describe('the turn', () => {
  it('spawns the app-server, with the compaction threshold as the one flag', () => {
    const adapter = adapterWith();
    expect(adapter.args({ prompt: 'x', cwd: '/repo' })).toEqual(['app-server']);
    expect(
      adapter.args({
        prompt: 'x',
        cwd: '/repo',
        autoCompact: { percent: 80, windowTokens: 258_400 },
      }),
    ).toEqual(['app-server', '-c', 'model_auto_compact_token_limit=206720']);
  });

  it('raises the context window with a spawn override when the turn picks one', () => {
    const adapter = adapterWith();
    expect(
      adapter.args({ prompt: 'x', cwd: '/repo', contextWindow: '872k' }),
    ).toEqual(['app-server', '-c', 'model_context_window=872000']);
    // A value no reader can place sends nothing rather than a guess.
    expect(
      adapter.args({ prompt: 'x', cwd: '/repo', contextWindow: 'huge' }),
    ).toEqual(['app-server']);
  });

  it('lists a model’s default and maximum windows from the profile’s own catalog', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const profile = join(home, 'profile');
    mkdirSync(profile);
    writeFileSync(
      join(profile, 'models_cache.json'),
      JSON.stringify({
        models: [
          {
            slug: 'gpt-6.1-sol',
            context_window: 272000,
            max_context_window: 872000,
          },
          {
            slug: 'gpt-5.5',
            context_window: 272000,
            max_context_window: 272000,
          },
        ],
      }),
    );
    const adapter = adapterWith({ homeDir: home });
    const listing = await adapter.listModelContextWindows('gpt-6.1-sol', {
      configDir: profile,
    });
    expect(listing.windows).toEqual([
      { id: '272k', label: '272k' },
      { id: '872k', label: '872k' },
    ]);
    expect(
      (await adapter.listModelContextWindows('gpt-5.5', { configDir: profile }))
        .unavailableKind,
    ).toBe('fixed-window');
    // No profile catalog and no default-home catalog: unreadable, not empty.
    expect(
      (await adapter.listModelContextWindows('gpt-6.1-sol')).unavailableKind,
    ).toBe('unreadable');
  });

  it('points codex at the run’s config directory', () => {
    const adapter = adapterWith();
    expect(
      adapter.env({
        prompt: 'x',
        cwd: '/repo',
        configDir: '/Users/x/.codex-work',
      }),
    ).toMatchObject({ CODEX_HOME: '/Users/x/.codex-work' });
  });

  it('adds geniro’s MCP endpoint beside the user’s servers, token in a header', () => {
    const adapter = adapterWith();
    const driver = adapter.driver({
      prompt: 'x',
      cwd: '/repo',
      mcpEndpoint: {
        url: 'http://127.0.0.1:47615/v1/mcp/run/node',
        token: 'call-token',
        serverName: 'geniro-0123abcd',
      },
    });
    const written: string[] = [];
    driver.onStdinReady?.({
      write: (payload) => {
        written.push(payload);
        return true;
      },
      emit: () => undefined,
    });
    const start = written
      .map(
        (line) =>
          JSON.parse(line) as {
            method?: string;
            params?: Record<string, unknown>;
          },
      )
      .find((frame) => frame.method === 'thread/start');
    expect(start?.params?.config).toEqual({
      'mcp_servers.geniro-0123abcd': {
        url: 'http://127.0.0.1:47615/v1/mcp/run/node',
        http_headers: { Authorization: 'Bearer call-token' },
        tool_timeout_sec: 86_400,
      },
    });
  });

  it('switches the CLI’s own memories off in the thread config only for a run that switches native memory off, endpoint or not', () => {
    const threadConfig = (input: AgentTurnInput): unknown => {
      const written: string[] = [];
      adapterWith()
        .driver(input)
        .onStdinReady?.({
          write: (payload) => {
            written.push(payload);
            return true;
          },
          emit: () => undefined,
        });
      return written
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: Record<string, unknown>;
            },
        )
        .find((frame) => frame.method === 'thread/start')?.params?.config;
    };
    const endpoint = {
      url: 'http://127.0.0.1:47615/v1/mcp/run/node',
      token: 'call-token',
      serverName: 'geniro-0123abcd',
    };

    expect(threadConfig({ prompt: 'x', cwd: '/repo' })).toBeUndefined();
    expect(
      threadConfig({ prompt: 'x', cwd: '/repo', nativeMemoryOff: true }),
    ).toEqual({ 'features.memories': false });
    expect(
      threadConfig({
        prompt: 'x',
        cwd: '/repo',
        nativeMemoryOff: true,
        mcpEndpoint: endpoint,
      }),
    ).toMatchObject({
      'features.memories': false,
      'mcp_servers.geniro-0123abcd': { url: endpoint.url },
    });
  });

  it('takes the shell away and runs read-only, outside plan mode, for a read-only turn', () => {
    const startFrame = (
      input: AgentTurnInput,
    ): Record<string, unknown> | undefined => {
      const written: string[] = [];
      adapterWith()
        .driver(input)
        .onStdinReady?.({
          write: (payload) => {
            written.push(payload);
            return true;
          },
          emit: () => undefined,
        });
      return written
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: Record<string, unknown>;
            },
        )
        .find((frame) => frame.method === 'thread/start')?.params;
    };

    const reading = startFrame({ prompt: 'x', cwd: '/repo', readOnly: true });
    expect(reading?.config).toEqual({ 'features.shell_tool': false });
    expect(reading).toMatchObject({
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
    });

    const open = startFrame({ prompt: 'x', cwd: '/repo' });
    expect(open?.config).toBeUndefined();
    expect(open).toMatchObject({ approvalPolicy: 'never' });
  });

  it('tells the agent about the call tools only when they are registered', () => {
    const instructionsFor = (input: AgentTurnInput): string => {
      const written: string[] = [];
      adapterWith()
        .driver(input)
        .onStdinReady?.({
          write: (payload) => {
            written.push(payload);
            return true;
          },
          emit: () => undefined,
        });
      const start = written
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: { developerInstructions?: string };
            },
        )
        .find((frame) => frame.method === 'thread/start');
      return start?.params?.developerInstructions ?? '';
    };
    const input: AgentTurnInput = {
      prompt: 'x',
      cwd: '/repo',
      systemPrompt: 'ROLE: review the parser',
      callSurfacePrompt: 'MAY CALL: researcher',
    };
    const granted = instructionsFor({
      ...input,
      mcpEndpoint: {
        url: 'http://127.0.0.1:47615/v1/mcp/run/node',
        token: 'call-token',
        serverName: 'geniro-0123abcd',
      },
    });
    expect(granted).toContain('ROLE: review the parser');
    expect(granted).toContain('MAY CALL: researcher');
    const withheld = instructionsFor(input);
    expect(withheld).toContain('ROLE: review the parser');
    expect(withheld).not.toContain('MAY CALL: researcher');
    // The thread's own instructions are where codex hears that its turn is
    // not held for sub-agents — the one CLI told to wait rather than end.
    expect(withheld).toContain(
      adapterWith().getConfig().backgroundWork.agentNote!,
    );
  });

  it('hands a conversation to the terminal as `codex -m <model> resume <id>`', () => {
    const adapter = adapterWith();
    expect(
      adapter.handoffTarget({
        sessionId: THREAD,
        model: 'gpt-5.5',
        configDir: '/Users/x/.codex-work',
      }),
    ).toEqual({
      ok: true,
      kind: 'command',
      command: 'codex',
      args: ['-m', 'gpt-5.5', 'resume', THREAD],
      env: { CODEX_HOME: '/Users/x/.codex-work' },
    });
    expect(
      adapter.handoffTarget({ sessionId: 'not-a-thread', model: null }),
    ).toEqual({ ok: false, reason: 'no-session' });
  });

  it('hands over a COPY while geniro’s own process still holds the thread', () => {
    // codex lets one process hold a thread: a terminal's `resume` would be
    // refused while the kept app-server has it, and `fork` is not.
    expect(
      adapterWith().handoffTarget({
        sessionId: THREAD,
        model: 'gpt-5.5',
        held: true,
      }),
    ).toMatchObject({ ok: true, args: ['-m', 'gpt-5.5', 'fork', THREAD] });
  });
});

describe('listings', () => {
  const MODELS = {
    data: [
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'high' },
        ],
      },
    ],
  };

  it('lists models from a one-shot model/list under the run’s profile', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(answered(MODELS));
    const adapter = adapterWith({ groupSpawnFn });
    await expect(
      adapter.listModels({ configDir: '/Users/x/.codex-work' }),
    ).resolves.toEqual([{ id: 'gpt-5.5', label: 'GPT-5.5', source: 'cli' }]);
    expect(calls[0]?.args).toEqual(['app-server']);
    expect(calls[0]?.env.CODEX_HOME).toBe('/Users/x/.codex-work');
    expect(sentMethods(calls[0]!.stdin)).toEqual([
      'initialize',
      'initialized',
      'model/list',
    ]);
  });

  it('narrows the efforts to what one model accepts, and asks codex once', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(answered(MODELS));
    const adapter = adapterWith({ groupSpawnFn });
    await expect(adapter.listModelEfforts('gpt-5.5')).resolves.toEqual({
      efforts: [
        { id: 'low', label: 'low' },
        { id: 'high', label: 'high' },
      ],
      unavailableReason: null,
      exact: true,
    });
    const superset = await adapter.listModelEfforts('unknown-model');
    expect(superset.exact).toBe(false);
    expect(superset.efforts.map((effort) => effort.id)).toContain('ultra');
    expect(calls).toHaveLength(1);
  });

  it('offers the speed tiers one model states, under the profile asked about', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(
      answered({
        data: [
          {
            id: 'gpt-6.1-sol',
            displayName: 'GPT-6.1-Sol',
            isDefault: true,
            serviceTiers: [
              {
                id: 'priority',
                name: 'Fast',
                description: '2x speed, increased usage',
              },
            ],
          },
          { id: 'gpt-5.5', displayName: 'GPT-5.5', serviceTiers: [] },
        ],
      }),
    );
    const adapter = adapterWith({ groupSpawnFn });
    const options = { configDir: '/Users/x/.codex-work' };

    const fast = await adapter.listModelParameters('gpt-6.1-sol', options);
    expect(fast.parameters[0]).toMatchObject({
      id: 'service_tier',
      label: 'Fast mode',
    });
    expect(calls[0]?.env.CODEX_HOME).toBe('/Users/x/.codex-work');
    await expect(
      adapter.listModelParameters('gpt-5.5', options),
    ).resolves.toMatchObject({ parameters: [], exact: true });
    await expect(
      adapter.listModelParameters(null, options),
    ).resolves.toMatchObject({ parameters: [{ id: 'service_tier' }] });
  });

  it('asks codex for no settings of a local model', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(answered(MODELS));
    await expect(
      adapterWith({ groupSpawnFn }).listModelParameters('ollama/llama4'),
    ).resolves.toMatchObject({ parameters: [] });
    expect(calls).toHaveLength(0);
  });

  it('does not cache an empty model list, so the next listing asks codex again', async () => {
    // An empty answer is a failure to ask, not "this account has no models".
    const { groupSpawnFn, calls } = oneshotSpawn([
      answered({ data: [] }),
      answered(MODELS),
    ]);
    const adapter = adapterWith({ groupSpawnFn });
    await expect(adapter.listModels({ configDir: null })).resolves.toEqual([]);
    await expect(adapter.listModels({ configDir: null })).resolves.toEqual([
      { id: 'gpt-5.5', label: 'GPT-5.5', source: 'cli' },
    ]);
    expect(calls).toHaveLength(2);
  });

  it('does not file a model listing that was still running when the account changed', async () => {
    // A sign-in or sign-out geniro ran (`CacheResetService.forgetAgent`) makes
    // an ask already in flight one taken under the OLD credentials: the caller
    // that is waiting still gets its answer, but the next listing must ask
    // again instead of serving the previous account's models from the cache.
    const children: ReturnType<typeof fakeGroupChild>[] = [];
    const groupSpawnFn = (() => {
      // Pids past the kernel's range, so the group reap on settle signals
      // nothing real on the machine running the suite.
      const fake = fakeGroupChild(9_100_000 + children.length);
      children.push(fake);
      return fake.child;
    }) as unknown as typeof spawn;
    const spawned = async (count: number): Promise<void> => {
      while (children.length < count) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    const adapter = adapterWith({ groupSpawnFn });

    const before = adapter.listModels({ configDir: null });
    await spawned(1);
    adapter.forgetAccountCaches();
    children[0]!.writeStdout(answered(MODELS));
    children[0]!.close(0);
    await expect(before).resolves.toEqual([
      { id: 'gpt-5.5', label: 'GPT-5.5', source: 'cli' },
    ]);

    const after = adapter.listModels({ configDir: null });
    await spawned(2);
    children[1]!.writeStdout(answered(MODELS));
    children[1]!.close(0);
    await after;
    expect(children).toHaveLength(2);
  });

  it('lists the skills codex reports, leaving out one that is switched off', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(
      answered({
        data: [
          {
            cwd: '/somewhere',
            skills: [
              { name: 'review', description: 'Review a diff', enabled: true },
              { name: 'deploy', description: 'Ship it', enabled: false },
              { name: 'lint' },
              { description: 'has no name' },
            ],
          },
        ],
      }),
    );
    await expect(
      adapterWith({ groupSpawnFn }).listReportedCommands(),
    ).resolves.toEqual([
      { name: 'review', description: 'Review a diff' },
      { name: 'lint', description: null },
    ]);
    expect(sentMethods(calls[0]!.stdin)).toContain('skills/list');
  });

  it('reads a wider page when searching, matches locally, and says when more exist than were read', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(
      answered({
        data: [
          { id: 'a', name: 'Fix the parser', cwd: '/repo', updatedAt: 10 },
          { id: 'b', name: 'Write docs', cwd: '/repo', updatedAt: 9 },
        ],
        nextCursor: 'more',
      }),
    );
    const listing = await adapterWith({ groupSpawnFn }).listSessions({
      cwd: '/repo',
      configDir: null,
      limit: 20,
      query: 'parser',
    });
    expect(listing.sessions.map((session) => session.id)).toEqual(['a']);
    // The query is matched here rather than by codex, so the page it is matched
    // over is wider than the rows returned.
    expect(paramsSentFor(calls[0]!.stdin, 'thread/list')).toEqual({
      limit: CODEX_SESSION_SEARCH_PAGE,
      cwd: '/repo',
    });
    expect(listing.partialReason).toBe(
      `only the ${CODEX_SESSION_SEARCH_PAGE} most recent conversations were read`,
    );
  });

  it('reads only the rows asked for when it is not searching', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(
      answered({
        data: [
          { id: 'a', name: 'Fix the parser', cwd: '/repo', updatedAt: 10 },
        ],
        nextCursor: 'more',
      }),
    );
    const listing = await adapterWith({ groupSpawnFn }).listSessions({
      cwd: '/repo',
      configDir: null,
      limit: 20,
      query: null,
    });
    expect(paramsSentFor(calls[0]!.stdin, 'thread/list')).toEqual({
      limit: 20,
      cwd: '/repo',
    });
    expect(listing.partialReason).toBe(
      'only the 20 most recent conversations were read',
    );
  });

  it('lists every MCP server codex loads, by asking an ephemeral thread', async () => {
    const { groupSpawnFn, calls } = appServerSpawn((method) => {
      switch (method) {
        case 'config/read':
          return {
            result: {
              config: { mcp_servers: { fs: { command: 'npx' } } },
              origins: { 'mcp_servers.fs.command': USER_ORIGIN },
            },
          };
        case 'thread/start':
          return { result: { thread: { id: 'T-list' } } };
        case 'mcpServerStatus/list':
          return {
            result: {
              data: [
                {
                  name: 'fs',
                  runtimeStatus: 'connected',
                  pluginId: null,
                  httpOrigin: null,
                  tools: { read: {}, write: {} },
                  toolsError: null,
                  authStatus: 'unsupported',
                },
                {
                  name: 'codex_apps',
                  runtimeStatus: 'connected',
                  pluginId: null,
                  httpOrigin: 'https://chatgpt.com',
                  tools: { a: {} },
                  toolsError: null,
                  authStatus: 'bearerToken',
                },
              ],
              nextCursor: null,
            },
          };
        default:
          return { result: {} };
      }
    });
    const listing = await adapterWith({ groupSpawnFn }).listMcpServers({
      cwd: '/repo',
      configDir: '/Users/x/.codex-work',
    });
    expect(calls[0]?.args).toEqual(['app-server']);
    expect(calls[0]?.env.CODEX_HOME).toBe('/Users/x/.codex-work');
    // The status question names the thread the reply to `thread/start` opened
    // — it can only have been written in answer to that reply.
    expect(
      paramsSentFor(calls[0]!.stdin, 'mcpServerStatus/list'),
    ).toMatchObject({ threadId: 'T-list' });
    expect(listing).toMatchObject({
      ok: true,
      servers: [
        {
          name: 'fs',
          status: 'connected',
          toolCount: 2,
          toggleUnavailableReason: null,
        },
        {
          name: 'codex_apps',
          status: 'connected',
          toolCount: 1,
          toggleUnavailableReason: CODEX_BUILTIN_TOGGLE_REASON,
          signInUnavailableReason: CODEX_BUILTIN_SIGN_IN_REASON,
        },
      ],
    });
  });

  it('says why when codex will not open the thread it lists from', async () => {
    const { groupSpawnFn } = appServerSpawn((method) =>
      method === 'thread/start'
        ? { error: 'workspace not trusted' }
        : { result: {} },
    );
    await expect(
      adapterWith({ groupSpawnFn }).listMcpServers({ cwd: '/repo' }),
    ).resolves.toEqual({
      ok: false,
      reason:
        'codex could not open a thread to list from: workspace not trusted',
    });
  });

  it('reads one server’s health by the same ask, narrowed to its name', async () => {
    const { groupSpawnFn, calls } = appServerSpawn((method) => {
      if (method === 'thread/start') {
        return { result: { thread: { id: 'T-one' } } };
      }
      if (method === 'mcpServerStatus/list') {
        return {
          result: {
            data: [
              {
                name: 'linear',
                runtimeStatus: 'authenticationRequired',
                tools: {},
                authStatus: 'notLoggedIn',
              },
            ],
            nextCursor: null,
          },
        };
      }
      return { result: {} };
    });
    await expect(
      adapterWith({ groupSpawnFn }).readMcpServerHealth({
        cwd: '/repo',
        server: 'linear',
      }),
    ).resolves.toEqual({ status: 'needs_auth', detail: null });
    expect(
      paramsSentFor(calls[0]!.stdin, 'mcpServerStatus/list'),
    ).toMatchObject({ serverName: 'linear' });
  });
});

describe('switching an MCP server', () => {
  it('asks codex to write its own config', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn([
      answered(LINEAR_IN_USER_CONFIG),
      answered({
        status: 'ok',
        version: 'v2',
        filePath: '/Users/x/.codex/config.toml',
      }),
    ]);
    await adapterWith({ groupSpawnFn }).setMcpServerEnabled(
      '/repo',
      'linear',
      false,
      { configDir: '/Users/x/.codex-work' },
    );
    // The switch is per PROFILE: written anywhere but the profile the panel
    // listed, it would edit another account's config and change nothing here.
    expect(calls[1]?.env.CODEX_HOME).toBe('/Users/x/.codex-work');
    // Where the server is defined is asked first, in the folder.
    expect(paramsSentFor(calls[0]!.stdin, 'config/read')).toEqual({
      cwd: '/repo',
    });
    const request = calls[1]!.stdin
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: unknown })
      .find((frame) => frame.method === 'config/value/write');
    expect(request?.params).toEqual({
      keyPath: 'mcp_servers.linear.enabled',
      value: false,
      mergeStrategy: 'upsert',
    });
  });

  it('surfaces codex’s refusal instead of reporting success', async () => {
    const { groupSpawnFn } = oneshotSpawn([
      answered(LINEAR_IN_USER_CONFIG),
      '{"id":1,"result":{}}\n{"id":2,"error":{"code":-32600,"message":"config is read-only"}}\n',
    ]);
    await expect(
      adapterWith({ groupSpawnFn }).setMcpServerEnabled(
        '/repo',
        'linear',
        true,
      ),
    ).rejects.toThrow('config is read-only');
  });

  it('refuses a name its config key could not address, before spawning', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(answered({}));
    await expect(
      adapterWith({ groupSpawnFn }).setMcpServerEnabled('/repo', 'a.b', true),
    ).rejects.toThrow('ambiguous');
    expect(calls).toHaveLength(0);
  });

  it('refuses a server codex’s user config does not define, and writes nothing', async () => {
    // A plugin's, a project's or a built-in server would only gain a stray
    // `[mcp_servers.<name>]` table — and go on loading.
    const { groupSpawnFn, calls } = oneshotSpawn(
      answered({ config: { mcp_servers: {} }, origins: {} }),
    );
    await expect(
      adapterWith({ groupSpawnFn }).setMcpServerEnabled(
        '/repo',
        'codex_apps',
        false,
      ),
    ).rejects.toThrow('is not defined in codex');
    expect(calls).toHaveLength(1);
    expect(sentMethods(calls[0]!.stdin)).not.toContain('config/value/write');
  });

  it('registers its app-server for shutdown, like every other one-shot', async () => {
    // Handed no `onSpawn`, the switch's own child must still be reapable.
    const { groupSpawnFn } = oneshotSpawn([
      answered(LINEAR_IN_USER_CONFIG),
      answered({ status: 'ok' }),
    ]);
    const registered: string[] = [];
    const processes = {
      register: (key: string) => void registered.push(key),
    } as unknown as ProcessRegistry;
    await adapterWith({ groupSpawnFn, processes }).setMcpServerEnabled(
      '/repo',
      'linear',
      true,
    );
    expect(registered).toEqual([
      expect.stringMatching(/^codex-app-server:/),
      expect.stringMatching(/^codex-app-server:/),
    ]);
  });
});

/** A `config/read {includeLayers}` result whose USER layer holds `servers`. */
function userLayer(
  servers: Record<string, unknown>,
  version = 'sha256:v1',
): unknown {
  return {
    // The EFFECTIVE config carries defaults and a plugin's server the user
    // never wrote — none of which the editor may show or write back.
    config: {
      mcp_servers: {
        ...Object.fromEntries(
          Object.entries(servers).map(([name, entry]) => [
            name,
            { ...(entry as object), environment_id: 'local', enabled: true },
          ]),
        ),
        plugin_server: { command: 'from-a-plugin' },
      },
    },
    origins: {},
    layers: [
      {
        name: {
          type: 'user',
          file: '/Users/x/.codex-work/config.toml',
          profile: null,
        },
        version,
        config: { model: 'gpt-5.5', mcp_servers: servers },
        disabledReason: null,
      },
      {
        name: { type: 'system', file: '/etc/codex/config.toml' },
        version: 'sha256:system',
        config: {},
        disabledReason: null,
      },
    ],
  };
}

/** An `execFile` double for `codex mcp add`, recording what it was run with. */
function fakeExecFile(output: string): {
  execFileFn: NonNullable<CodexAdapterOptions['execFileFn']>;
  calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[];
} {
  const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const execFileFn = ((
    _command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv },
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ args, env: options.env ?? {} });
    queueMicrotask(() => callback(null, output, ''));
    return { pid: 4343, on: () => undefined, once: () => undefined };
  }) as unknown as NonNullable<CodexAdapterOptions['execFileFn']>;
  return { execFileFn, calls };
}

const PROFILE = '/Users/x/.codex-work';
const STDIO_SPEC = {
  name: 'geniro-probe',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@acme/mcp'],
  env: { ACME_TOKEN: 'secret-value-123' },
  url: null,
  headers: {},
};

describe('editing the MCP servers', () => {
  it('reads the USER layer’s table under the profile — never the effective config', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(
      answered(userLayer({ linear: { url: 'https://mcp.linear.app/mcp' } })),
    );
    await expect(
      adapterWith({ groupSpawnFn }).readMcpConfigDocument({
        configDir: PROFILE,
      }),
    ).resolves.toEqual({
      servers: { linear: { url: 'https://mcp.linear.app/mcp' } },
      path: '/Users/x/.codex-work/config.toml',
      version: 'sha256:v1',
      unavailableReason: null,
    });
    expect(paramsSentFor(calls[0]!.stdin, 'config/read')).toEqual({
      includeLayers: true,
    });
    expect(calls[0]?.env.CODEX_HOME).toBe(PROFILE);
  });

  it('says why when codex refuses the read, rather than answering no servers', async () => {
    const { groupSpawnFn } = oneshotSpawn(
      '{"id":1,"result":{}}\n{"id":2,"error":{"code":-32600,"message":"bad toml"}}\n',
    );
    await expect(
      adapterWith({ groupSpawnFn }).readMcpConfigDocument({ configDir: null }),
    ).resolves.toEqual({
      servers: null,
      path: null,
      version: null,
      unavailableReason: 'codex refused to read its config: bad toml',
    });
  });

  it('replaces the whole table through codex’s own writer, at the version it read', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn([
      answered(userLayer({ linear: { url: 'https://mcp.linear.app/mcp' } })),
      answered({ status: 'ok', version: 'sha256:v2' }),
    ]);
    await expect(
      adapterWith({ groupSpawnFn }).writeMcpConfigDocument({
        configDir: PROFILE,
        servers: { other: { command: 'true' } },
        expectedVersion: 'sha256:v1',
      }),
    ).resolves.toEqual({ ok: true, changed: true });
    expect(paramsSentFor(calls[1]!.stdin, 'config/batchWrite')).toEqual({
      edits: [
        {
          keyPath: 'mcp_servers',
          value: { other: { command: 'true' } },
          mergeStrategy: 'replace',
        },
      ],
      expectedVersion: 'sha256:v1',
    });
    expect(calls[1]?.env.CODEX_HOME).toBe(PROFILE);
  });

  it('refuses a document that moved since the editor read it, and writes nothing', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(
      answered(userLayer({}, 'sha256:v9')),
    );
    await expect(
      adapterWith({ groupSpawnFn }).writeMcpConfigDocument({
        configDir: null,
        servers: {},
        expectedVersion: 'sha256:v1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/changed since/),
    });
    expect(calls).toHaveLength(1);
  });

  it('writes nothing when the document is already as asked', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(
      answered(userLayer({ a: { command: 'true' } })),
    );
    await expect(
      adapterWith({ groupSpawnFn }).writeMcpConfigDocument({
        configDir: null,
        servers: { a: { command: 'true' } },
        expectedVersion: 'sha256:v1',
      }),
    ).resolves.toEqual({ ok: true, changed: false });
    expect(calls).toHaveLength(1);
  });

  it('surfaces codex’s own validation refusal of a write', async () => {
    const { groupSpawnFn } = oneshotSpawn([
      answered(userLayer({})),
      '{"id":1,"result":{}}\n{"id":2,"error":{"code":-32600,"message":"invalid transport"}}\n',
    ]);
    await expect(
      adapterWith({ groupSpawnFn }).writeMcpConfigDocument({
        configDir: null,
        servers: { bad: { command: 'x' } },
        expectedVersion: 'sha256:v1',
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'codex refused the change: invalid transport',
    });
  });

  it('adds a stdio server with `codex mcp add`, under the profile, and checks it landed', async () => {
    const { groupSpawnFn } = oneshotSpawn([
      answered(userLayer({})),
      answered(userLayer({ 'geniro-probe': { command: 'npx' } }, 'sha256:v2')),
    ]);
    const exec = fakeExecFile("Added global MCP server 'geniro-probe'.\n");
    await expect(
      adapterWith({
        groupSpawnFn,
        execFileFn: exec.execFileFn,
      }).addMcpServer({ configDir: PROFILE, server: STDIO_SPEC }),
    ).resolves.toEqual({ ok: true, changed: true });
    expect(exec.calls[0]?.args).toEqual([
      'mcp',
      'add',
      'geniro-probe',
      '--env',
      'ACME_TOKEN=secret-value-123',
      '--',
      'npx',
      '-y',
      '@acme/mcp',
    ]);
    expect(exec.calls[0]?.env.CODEX_HOME).toBe(PROFILE);
  });

  it('reports the CLI’s own words when the server did not land', async () => {
    const { groupSpawnFn } = oneshotSpawn(answered(userLayer({})));
    const exec = fakeExecFile('Error: something codex said\n');
    await expect(
      adapterWith({
        groupSpawnFn,
        execFileFn: exec.execFileFn,
      }).addMcpServer({ configDir: null, server: STDIO_SPEC }),
    ).resolves.toEqual({
      ok: false,
      reason: 'codex did not add the server: Error: something codex said',
    });
  });

  it('refuses a name the profile already defines — `codex mcp add` would overwrite it — without running it', async () => {
    const { groupSpawnFn } = oneshotSpawn(
      answered(userLayer({ 'geniro-probe': { command: 'mine' } })),
    );
    const exec = fakeExecFile('');
    await expect(
      adapterWith({
        groupSpawnFn,
        execFileFn: exec.execFileFn,
      }).addMcpServer({ configDir: null, server: STDIO_SPEC }),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already exists/),
    });
    expect(exec.calls).toHaveLength(0);
  });

  it('writes an http server through the config writer — never `mcp add --url`, which starts an OAuth flow', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn([
      answered(userLayer({})),
      answered({ status: 'ok', version: 'sha256:v2' }),
    ]);
    const exec = fakeExecFile('');
    await expect(
      adapterWith({
        groupSpawnFn,
        execFileFn: exec.execFileFn,
      }).addMcpServer({
        configDir: null,
        server: {
          name: 'acme',
          transport: 'http',
          command: null,
          args: [],
          env: {},
          url: 'https://acme.example/mcp',
          headers: { 'X-Api-Key': 'k' },
        },
      }),
    ).resolves.toEqual({ ok: true, changed: true });
    expect(exec.calls).toHaveLength(0);
    expect(paramsSentFor(calls[1]!.stdin, 'config/batchWrite')).toEqual({
      edits: [
        {
          keyPath: 'mcp_servers.acme',
          value: {
            url: 'https://acme.example/mcp',
            http_headers: { 'X-Api-Key': 'k' },
          },
          mergeStrategy: 'upsert',
        },
      ],
      expectedVersion: 'sha256:v1',
    });
  });

  it('refuses a name its dotted config key could not address, before spawning', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(answered(userLayer({})));
    await expect(
      adapterWith({ groupSpawnFn }).addMcpServer({
        configDir: null,
        server: { ...STDIO_SPEC, name: 'a.b' },
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/ambiguous/),
    });
    expect(calls).toHaveLength(0);
  });
});

describe('context readout', () => {
  it('serves what the thread reported, beside the servers its live process names', async () => {
    const adapter = adapterWith();
    // A turn on this adapter's own driver — the session hands the thread's
    // facts back to the adapter as they arrive.
    const driver = adapter.driver({
      prompt: 'hi',
      cwd: '/repo',
      autoCompact: { percent: 80, windowTokens: 250_000 },
    });
    const written: string[] = [];
    driver.onStdinReady?.({
      write: (payload) => {
        written.push(payload);
        return true;
      },
      emit: () => undefined,
    });
    const start = written
      .map((line) => JSON.parse(line) as { id?: number; method?: string })
      .find((frame) => frame.method === 'thread/start')!;
    driver.onMessage?.({
      id: start.id,
      result: {
        thread: { id: THREAD },
        model: 'gpt-5.5',
        instructionSources: ['/repo/AGENTS.md'],
      },
    });
    const breakdown = {
      totalTokens: 30_000,
      inputTokens: 29_000,
      cachedInputTokens: 20_000,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000,
      reasoningOutputTokens: 200,
    };
    driver.onMessage?.({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: THREAD,
        turnId: 't',
        tokenUsage: {
          total: breakdown,
          last: breakdown,
          modelContextWindow: 258_400,
        },
      },
    });

    let asked: string | null = null;
    const live = {
      ask: (request: { line: string; read: (obj: unknown) => unknown }) => {
        asked = request.line;
        const { id } = JSON.parse(request.line) as { id: string };
        return Promise.resolve(
          request.read({
            id,
            result: {
              data: [
                {
                  name: 'fs',
                  runtimeStatus: 'connected',
                  tools: { a: {}, b: {} },
                },
              ],
            },
          }),
        );
      },
    } as unknown as AgentSession;
    const usage = await adapter.readContextUsage({
      live,
      sessionId: THREAD,
      configDir: null,
    });
    expect(JSON.parse(asked!)).toMatchObject({
      method: 'mcpServerStatus/list',
      params: { threadId: THREAD },
    });
    expect(usage).toMatchObject({
      totalTokens: 30_000,
      maxTokens: 258_400,
      model: 'gpt-5.5',
      // 80% of a 250k window — the threshold the process was spawned with.
      autoCompactAtTokens: 200_000,
      memoryFiles: [{ path: '/repo/AGENTS.md', tokens: null }],
      servers: [{ name: 'fs', toolCount: 2, tokens: null }],
      lastRequest: { inputTokens: 9_000, cachedInputTokens: 20_000 },
    });
  });

  it('has nothing to ask without a live process', async () => {
    await expect(
      adapterWith().readContextUsage({
        live: null,
        sessionId: THREAD,
        configDir: null,
      }),
    ).resolves.toBeNull();
  });

  it('declares the breakdown as read from the running process', () => {
    expect(adapterWith().getConfig().usage.breakdown).toEqual({
      kind: 'reads',
      channel: 'live-process',
    });
  });
});

describe('plan limits', () => {
  it('are asked of the running process, whose answer is the run’s own account', async () => {
    const adapter = adapterWith();
    await expect(
      adapter.readPlanLimits({
        live: null,
        sessionId: THREAD,
        configDir: null,
      }),
    ).resolves.toBeNull();
    let asked: { line: string; read: (obj: unknown) => unknown } | null = null;
    const live = {
      ask: (request: { line: string; read: (obj: unknown) => unknown }) => {
        asked = request;
        const { id } = JSON.parse(request.line) as { id: string };
        return Promise.resolve(
          request.read({
            id,
            result: {
              rateLimits: {
                primary: {
                  usedPercent: 12,
                  windowDurationMins: 300,
                  resetsAt: null,
                },
                planType: 'plus',
              },
            },
          }),
        );
      },
    } as unknown as AgentSession;
    const limits = await adapter.readPlanLimits({
      live,
      sessionId: THREAD,
      configDir: null,
    });
    expect(asked).not.toBeNull();
    expect(limits).toEqual({
      plan: 'plus',
      estimated: false,
      windows: [
        { key: 'primary', label: '5-hour limit', percent: 12, resetsAt: null },
      ],
    });
  });
});

describe('naming a chat', () => {
  it('asks a throwaway `codex exec` turn and registers it for shutdown', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn('Refactor the parser\n');
    const registered: string[] = [];
    const processes = {
      register: (key: string) => void registered.push(key),
    } as unknown as ProcessRegistry;
    const title = await adapterWith({ groupSpawnFn, processes }).generateTitle({
      opening: 'Please refactor parser.ts',
      reply: null,
      latest: null,
      configDir: '/Users/x/.codex-work',
    });
    expect(title).toBe('Refactor the parser');
    expect(calls[0]?.args.slice(0, 3)).toEqual([
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
    ]);
    // The user's own config.toml — their MCP servers, their default model —
    // stays out of a turn that only names the chat; the login still applies.
    expect(calls[0]?.args).toContain('--ignore-user-config');
    expect(calls[0]?.env.CODEX_HOME).toBe('/Users/x/.codex-work');
    // `codex exec` reads stdin to EOF even with its prompt in argv.
    expect(calls[0]?.stdinEnded()).toBe(true);
    // The title service hands no `onSpawn`; the adapter still registers the
    // child, since a turn it starts on its own must be reapable.
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatch(/^codex-exec:/);
  });
});

describe('a one-off question', () => {
  it('asks a throwaway `codex exec` turn and answers its whole reply', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(
      '[{"id":"n1"}]\nsecond line\n',
    );
    const answer = await adapterWith({ groupSpawnFn }).askOnce({
      prompt: 'Sort these',
      model: 'gpt-5.4-mini',
      configDir: '/Users/x/.codex-work',
    });
    expect(answer).toBe('[{"id":"n1"}]\nsecond line');
    expect(calls[0]?.args).toContain('--ignore-user-config');
    expect(calls[0]?.args.slice(-3)).toEqual([
      '-m',
      'gpt-5.4-mini',
      'Sort these',
    ]);
    expect(calls[0]?.env.CODEX_HOME).toBe('/Users/x/.codex-work');
    expect(calls[0]?.stdinEnded()).toBe(true);
  });

  it('asks at the chosen effort and context window, low effort when none is chosen', async () => {
    const chosen = oneshotSpawn('[]');
    await adapterWith({ groupSpawnFn: chosen.groupSpawnFn }).askOnce({
      prompt: 'Sort these',
      model: 'gpt-5.4',
      configDir: null,
      effort: 'high',
      contextWindow: '272k',
    });
    const args = chosen.calls[0]!.args;
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).not.toContain('model_reasoning_effort="low"');
    expect(args).toContain('model_context_window=272000');
    expect(args.some((arg) => arg.startsWith('service_tier='))).toBe(false);

    const unchosen = oneshotSpawn('[]');
    await adapterWith({ groupSpawnFn: unchosen.groupSpawnFn }).askOnce({
      prompt: 'Sort these',
      model: null,
      configDir: null,
    });
    expect(unchosen.calls[0]!.args).toContain('model_reasoning_effort="low"');
    expect(
      unchosen.calls[0]!.args.some((arg) =>
        arg.startsWith('model_context_window='),
      ),
    ).toBe(false);
  });

  it('asks at the chosen speed tier', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn('[]');
    await adapterWith({ groupSpawnFn }).askOnce({
      prompt: 'Sort these',
      model: 'gpt-6.1-sol',
      configDir: null,
      modelParameters: { service_tier: 'priority' },
    });
    expect(calls[0]!.args).toContain('service_tier="priority"');
  });

  it('answers null for an empty reply', async () => {
    const { groupSpawnFn } = oneshotSpawn('\n');
    await expect(
      adapterWith({ groupSpawnFn }).askOnce({
        prompt: 'Sort these',
        model: null,
        configDir: null,
      }),
    ).resolves.toBeNull();
  });
});

describe('questions', () => {
  it('carries the card’s answer into the reply', () => {
    const adapter = adapterWith();
    const params = {
      questions: [
        { id: 'q1', question: 'Which DB?', options: [{ label: 'SQLite' }] },
      ],
    };
    expect(adapter.questionFrom(params)).toEqual({
      text: 'Which DB?',
      options: ['SQLite'],
    });
    const driver = adapter.driver({
      prompt: 'x',
      cwd: '/repo',
      approvalMode: 'plan',
    });
    const events: AgentEvent[] = [];
    driver.onStdinReady?.({
      write: () => true,
      emit: (event) => events.push(event),
    });
    events.push(
      ...driver.onMessage({
        id: 9,
        method: 'item/tool/requestUserInput',
        params,
      }),
    );
    const reply = driver.buildApprovalResponse?.(
      'n:9',
      true,
      adapter.withAnswer(params, 'SQLite'),
    );
    expect(JSON.parse(reply!)).toMatchObject({
      id: 9,
      result: { answers: { q1: { answers: ['SQLite'] } } },
    });
  });

  /**
   * Answer a two-question codex card whose second question is secret, and
   * return the reply frame as the debug log records it at the moment of the
   * write.
   */
  function answerSecretCard(answer: string): {
    frame: string;
    record: { answer?: string };
  } {
    const adapter = adapterWith();
    const params = {
      questions: [
        { id: 'region', question: 'Which region?', options: [] },
        { id: 'token', question: 'Your token?', isSecret: true, options: [] },
      ],
    };
    const driver = adapter.driver({
      prompt: 'x',
      cwd: '/repo',
      approvalMode: 'plan',
    });
    const events: AgentEvent[] = [];
    driver.onStdinReady?.({
      write: () => true,
      emit: (event) => events.push(event),
    });
    events.push(
      ...driver.onMessage({
        id: 9,
        method: 'item/tool/requestUserInput',
        params,
      }),
    );
    const request = events.find(
      (event): event is Extract<AgentEvent, { type: 'approval_request' }> =>
        event.type === 'approval_request',
    );
    if (request === undefined) {
      throw new Error('codex raised no question card');
    }
    let frame = '';
    const { record } = deliverApprovalAnswer(
      adapter,
      request,
      true,
      answer,
      (input) => {
        frame = redactSecrets(
          driver.buildApprovalResponse?.(request.id, true, input) ?? '',
        );
        return true;
      },
    );
    return { frame, record };
  }

  it('keeps a secret out of the debug log in the frame that answers codex', () => {
    // The stdio channel records the reply FRAME, where each question carries
    // its own value JSON-escaped — the secret may survive there in no spelling.
    onTestFinished(clearSecrets);

    const { frame, record } = answerSecretCard(
      'Which region?: eu-west\nYour token?: tok"en-0123456789',
    );

    expect(record).toEqual({});
    expect(frame).toContain('secret answer redacted');
    expect(frame).not.toContain('0123456789');
    // …and the token alone, when the agent repeats it in a later line.
    expect(
      redactSecrets(JSON.stringify({ command: 'echo tok"en-0123456789' })),
    ).not.toContain('0123456789');
  });

  it('masks a short secret in the slot codex receives it in, and nowhere after', () => {
    onTestFinished(clearSecrets);

    const { frame } = answerSecretCard(
      'Which region?: eu-west\nYour token?: 4821',
    );

    expect(frame).toContain('"token":{"answers":["‹secret answer redacted›"]}');
    expect(redactSecrets('item seq=4821')).toBe('item seq=4821');
  });

  it('offers a calling agent exactly what the question card shows', () => {
    // One reading of the payload: the header the card shows reaches the
    // caller, and a label the card drops — longer than the answer channel
    // carries — is not offered to it either.
    expect(
      adapterWith().questionFrom({
        questions: [
          {
            id: 'q1',
            header: 'Database',
            question: 'Which database should the service use?',
            options: [
              { label: 'SQLite' },
              { label: 'x'.repeat(MAX_ANSWER_LENGTH + 1) },
            ],
          },
        ],
      }),
    ).toEqual({
      text: '[Database] Which database should the service use?',
      options: ['SQLite'],
    });
  });
});

describe('CodexAdapter.carrySessionToConfigDir', () => {
  function homeFixture(): {
    homeDir: string;
    fromHome: string;
    toHome: string;
    sourcePath: string;
    targetPath: string;
  } {
    const homeDir = mkdtempSync(join(tmpdir(), 'codex-carry-adapter-'));
    onTestFinished(() => rmSync(homeDir, { recursive: true, force: true }));
    const fromHome = join(homeDir, '.codex');
    const toHome = join(homeDir, '.codex-work');
    const rollout = `rollout-2026-10-08T21-04-37-${THREAD}.jsonl`;
    mkdirSync(join(fromHome, 'sessions'), { recursive: true });
    mkdirSync(toHome);
    const sourcePath = join(fromHome, 'sessions', rollout);
    writeFileSync(sourcePath, 'the full conversation\n');
    return {
      homeDir,
      fromHome,
      toHome,
      sourcePath,
      targetPath: join(toHome, 'sessions', rollout),
    };
  }

  it('locates the thread in the default home and verifies the copy under the selected home', async () => {
    const fixture = homeFixture();
    const { groupSpawnFn, calls } = oneshotSpawn([
      answered({ thread: { id: THREAD, path: fixture.sourcePath } }),
      answered({ thread: { id: THREAD, path: fixture.targetPath } }),
    ]);
    const adapter = adapterWith({ groupSpawnFn, homeDir: fixture.homeDir });

    expect(
      await adapter.carrySessionToConfigDir({
        sessionId: THREAD,
        from: null,
        to: fixture.toHome,
      }),
    ).toEqual({ carried: true });
    expect(
      adapter.getConfig().configDir.sessionCarryUnavailableReason,
    ).toBeNull();
    expect(readFileSync(fixture.targetPath, 'utf8')).toBe(
      readFileSync(fixture.sourcePath, 'utf8'),
    );
    expect(calls.map((call) => call.env.CODEX_HOME)).toEqual([
      fixture.fromHome,
      fixture.toHome,
    ]);
    for (const call of calls) {
      expect(paramsSentFor(call.stdin, 'thread/read')).toEqual({
        threadId: THREAD,
        includeTurns: false,
      });
    }
  });

  it('does not claim the conversation followed when the source cannot locate it', async () => {
    const fixture = homeFixture();
    const { groupSpawnFn, calls } = oneshotSpawn(answered({}));

    expect(
      await adapterWith({ groupSpawnFn }).carrySessionToConfigDir({
        sessionId: THREAD,
        from: fixture.fromHome,
        to: fixture.toHome,
      }),
    ).toMatchObject({ carried: false });
    expect(calls).toHaveLength(1);
    expect(existsSync(fixture.targetPath)).toBe(false);
  });

  it('does not claim success when the target cannot read the copied thread', async () => {
    const fixture = homeFixture();
    const { groupSpawnFn } = oneshotSpawn([
      answered({ thread: { id: THREAD, path: fixture.sourcePath } }),
      answered({}),
    ]);

    expect(
      await adapterWith({ groupSpawnFn }).carrySessionToConfigDir({
        sessionId: THREAD,
        from: fixture.fromHome,
        to: fixture.toHome,
      }),
    ).toMatchObject({
      carried: false,
      reason: expect.stringContaining('could not reopen'),
    });
    expect(readFileSync(fixture.sourcePath, 'utf8')).toBe(
      'the full conversation\n',
    );
  });
});

describe('CodexAdapter.deleteSessionTranscript', () => {
  const RUN_CREATED = new Date('2026-10-01T12:00:00.000Z');
  /** `thread/read`'s reply for a thread codex says began at `createdAt`. */
  const threadBegan = (createdAt: number): string =>
    answered({ thread: { id: THREAD, createdAt } });
  /** codex's refusal, as a one-shot carries it. */
  const refused = (message: string): string =>
    `{"id":1,"result":{"userAgent":"codex"}}\n${JSON.stringify({ id: 2, error: { code: -32600, message } })}\n`;

  it('asks codex to delete a thread the chat began, under the chat’s profile', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn([
      threadBegan(RUN_CREATED.getTime() / 1000 + 3),
      answered({}),
    ]);

    const result = await adapterWith({ groupSpawnFn }).deleteSessionTranscript({
      sessionId: THREAD,
      configDir: '/profiles/codex',
      runCreatedAt: RUN_CREATED,
    });

    expect(result).toEqual({ deleted: true });
    expect(sentMethods(calls[1]!.stdin)).toContain('thread/delete');
    expect(paramsSentFor(calls[1]!.stdin, 'thread/delete')).toEqual({
      threadId: THREAD,
    });
    expect(calls[1]!.env.CODEX_HOME).toBe('/profiles/codex');
  });

  it('allows the second codex rounds a thread started in the run’s first second down by', async () => {
    // `createdAt` is whole seconds: a run created at :00.400 and a thread
    // started at :00.700 reads as a thread begun at :00.000 — before the run.
    const { groupSpawnFn } = oneshotSpawn([
      threadBegan(RUN_CREATED.getTime() / 1000),
      answered({}),
    ]);

    const result = await adapterWith({ groupSpawnFn }).deleteSessionTranscript({
      sessionId: THREAD,
      configDir: null,
      runCreatedAt: new Date(RUN_CREATED.getTime() + 400),
    });

    expect(result).toEqual({ deleted: true });
  });

  it('keeps a thread that began before the chat — one imported from codex', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn([
      threadBegan(RUN_CREATED.getTime() / 1000 - 3600),
      answered({}),
    ]);

    const result = await adapterWith({ groupSpawnFn }).deleteSessionTranscript({
      sessionId: THREAD,
      configDir: null,
      runCreatedAt: RUN_CREATED,
    });

    expect(result.deleted).toBe(false);
    // Nothing is deleted: the only process spawned was the read.
    expect(calls).toHaveLength(1);
  });

  it('keeps a thread codex cannot date, and deletes nothing', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(answered({}));

    const result = await adapterWith({ groupSpawnFn }).deleteSessionTranscript({
      sessionId: THREAD,
      configDir: null,
      runCreatedAt: RUN_CREATED,
    });

    expect(result.deleted).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('reports codex’s own refusal of the delete', async () => {
    const { groupSpawnFn } = oneshotSpawn([
      threadBegan(RUN_CREATED.getTime() / 1000 + 3),
      refused(`no rollout found for thread id ${THREAD}`),
    ]);

    const result = await adapterWith({ groupSpawnFn }).deleteSessionTranscript({
      sessionId: THREAD,
      configDir: null,
      runCreatedAt: RUN_CREATED,
    });

    expect(result).toEqual({
      deleted: false,
      reason: `codex refused: no rollout found for thread id ${THREAD}`,
    });
  });
});

describe('CodexAdapter.recoverSubagent', () => {
  const ref: SubagentRecoveryRef = {
    agentKind: AgentKind.Codex,
    sessionId: THREAD,
    childSessionId: '01a0e3aa-7dc4-7703-8a60-497958241fd2',
    toolCallId: 'spawn-1',
    launchedAtMs: 1_800_000_000_500,
    configDir: '/selected-codex-profile',
    cwd: '/selected-repo',
  };
  const result = {
    thread: {
      id: ref.childSessionId,
      parentThreadId: ref.sessionId,
      status: { type: 'notLoaded' },
      turns: [
        {
          status: 'completed',
          startedAt: 1_800_000_000,
          completedAt: 1_800_000_001,
        },
      ],
    },
  };

  it('only reads the child thread in its saved profile after the task directory was collected', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-recovery-home-'));
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const collected = join(home, 'collected-task');
    mkdirSync(collected);
    rmSync(collected, { recursive: true });
    const calls: { cwd?: string | URL; env?: NodeJS.ProcessEnv }[] = [];
    const server = oneshotSpawn(answered(result));
    const spawnFn = ((...args: Parameters<typeof spawn>) => {
      calls.push(args[2] ?? {});
      return server.groupSpawnFn(...args);
    }) as typeof spawn;
    const adapter = adapterWith({ groupSpawnFn: spawnFn, homeDir: home });
    expect(await adapter.recoverSubagent({ ...ref, cwd: collected })).toBe(
      'completed',
    );
    expect(server.calls).toHaveLength(1);
    expect(sentMethods(server.calls[0]!.stdin)).toEqual([
      'initialize',
      'initialized',
      'thread/read',
    ]);
    expect(paramsSentFor(server.calls[0]!.stdin, 'thread/read')).toEqual({
      threadId: ref.childSessionId,
      includeTurns: true,
    });
    expect(calls[0]?.cwd).toBe(home);
    expect(calls[0]?.env?.CODEX_HOME).toBe(ref.configDir);
  });

  it.each([
    '',
    '{bad}\n',
    '{"id":1,"result":{}}\n{"id":2,"error":{"code":-32600,"message":"unavailable"}}\n',
    answered({ thread: null }),
  ])('leaves unavailable or malformed reads unknown: %j', async (stdout) => {
    const server = oneshotSpawn(stdout);
    const adapter = adapterWith({ groupSpawnFn: server.groupSpawnFn });
    expect(await adapter.recoverSubagent(ref)).toBeNull();
    expect(server.calls).toHaveLength(1);
  });

  it('leaves a spawn failure unknown', async () => {
    let spawns = 0;
    const spawnFn = (() => {
      spawns += 1;
      throw new Error('codex unavailable');
    }) as typeof spawn;
    expect(
      await adapterWith({ groupSpawnFn: spawnFn }).recoverSubagent(ref),
    ).toBeNull();
    expect(spawns).toBe(1);
  });

  it.each([
    { childSessionId: null },
    { childSessionId: 'not-a-uuid' },
    { sessionId: '../escape' },
    { launchedAtMs: Number.NaN },
    { launchedAtMs: Number.POSITIVE_INFINITY },
    { launchedAtMs: -1 },
  ])('does not spawn for an invalid reference: %j', async (invalid) => {
    const server = oneshotSpawn(answered(result));
    const adapter = adapterWith({ groupSpawnFn: server.groupSpawnFn });
    expect(await adapter.recoverSubagent({ ...ref, ...invalid })).toBeNull();
    expect(server.calls).toHaveLength(0);
  });
});

describe('CodexAdapter sub-agent recovery references', () => {
  const CHILD = '01a0e3aa-7dc4-7703-8a60-497958241fd2';
  const TURN = '01a0e3aa-959f-7493-8c1f-01cff8862a2a';

  /** A turn past its handshake and thread start, with the child to feed. */
  function openTurn(): { child: FakeChild; events: AgentEvent[] } {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    adapterWith({ spawn }).start({ prompt: 'go', cwd: '/repo' }, (event) =>
      events.push(event),
    );
    const sent = (method: string): { id: number } =>
      child.stdin.written
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { id: number; method?: string })
        .find((frame) => frame.method === method)!;
    const reply = (id: number, result: unknown): void =>
      child.stdout.emitData(`${JSON.stringify({ id, result })}\n`);
    reply(sent('initialize').id, {});
    reply(sent('thread/start').id, { thread: { id: THREAD } });
    reply(sent('turn/start').id, { turn: { id: TURN } });
    return { child, events };
  }

  function itemStarted(child: FakeChild, item: Record<string, unknown>): void {
    child.stdout.emitData(
      `${JSON.stringify({
        method: 'item/started',
        params: { threadId: THREAD, turnId: TURN, item },
      })}\n`,
    );
  }

  function infoOf(events: AgentEvent[], id: string): unknown {
    return events.find(
      (event) => event.type === 'subagent_info' && event.id === id,
    ) as { recovery?: SubagentRecoveryRef | null } | undefined;
  }

  it('names the native child thread on the reference of a subAgentActivity launch', () => {
    const { child, events } = openTurn();
    itemStarted(child, {
      type: 'subAgentActivity',
      id: 'call_activity',
      kind: 'started',
      agentThreadId: CHILD,
      agentPath: '/root/worker',
    });

    expect(infoOf(events, 'call_activity')).toMatchObject({
      recovery: {
        agentKind: AgentKind.Codex,
        sessionId: THREAD,
        toolCallId: 'call_activity',
        childSessionId: CHILD,
      },
    });
  });

  it('names the native child thread on the reference of a collab spawn', () => {
    const { child, events } = openTurn();
    child.stdout.emitData(
      `${JSON.stringify({
        method: 'item/completed',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: {
            type: 'collabAgentToolCall',
            id: 'call_spawn',
            tool: 'spawnAgent',
            status: 'completed',
            receiverThreadIds: [CHILD],
            agentsStates: { [CHILD]: { status: 'running' } },
          },
        },
      })}\n`,
    );

    expect(
      events.filter(
        (event) => event.type === 'subagent_info' && event.id === 'call_spawn',
      ),
    ).toContainEqual(
      expect.objectContaining({
        recovery: expect.objectContaining({
          sessionId: THREAD,
          toolCallId: 'call_spawn',
          childSessionId: CHILD,
        }),
      }),
    );
  });
});
