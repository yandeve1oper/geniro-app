import { describe, expect, it, vi } from 'vitest';

import { AgentKind } from '../../runs/runs.types';
import type {
  AdapterConfig,
  AgentEvent,
  AgentSessionHistory,
  AgentSessionListing,
  AgentSessionsInput,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import { CliSessionsService } from './cli-sessions.service';
import type { ProcessRegistry } from './process-registry';

/** The slice of an adapter this service actually reaches for. */
interface FakeAdapter {
  listSessions: (input: AgentSessionsInput) => Promise<AgentSessionListing>;
  prepareSessionImport: () => Promise<void>;
  readSessionHistory: () => Promise<AgentSessionHistory | null>;
  getConfig: () => AdapterConfig;
}

function setup(over: Partial<FakeAdapter> = {}): {
  service: CliSessionsService;
  adapter: FakeAdapter;
  listed: AgentSessionsInput[];
} {
  const listed: AgentSessionsInput[] = [];
  const adapter: FakeAdapter = {
    listSessions: (input) => {
      listed.push(input);
      return Promise.resolve({
        sessions: [],
        unavailableReason: null,
        partialReason: null,
      });
    },
    prepareSessionImport: () => Promise.resolve(),
    readSessionHistory: () =>
      Promise.resolve({ events: [], droppedBefore: 0 } as AgentSessionHistory),
    getConfig: () =>
      ({
        kind: AgentKind.Claude,
        sessions: {
          listingUnavailableReason: null,
          listingPartialReason: null,
          historyUnavailableReason: null,
          contentSearchUnavailableReason: null,
        },
      }) as AdapterConfig,
    ...over,
  };
  const service = new CliSessionsService(
    {
      for: () => adapter as unknown as AgentAdapter,
    } as unknown as AgentAdapterRegistry,
    { register: () => undefined } as unknown as ProcessRegistry,
  );
  return { service, adapter, listed };
}

describe('CliSessionsService.list', () => {
  it("carries the adapter's own partial reason, which the listing cannot state", () => {
    const { service } = setup({
      getConfig: () =>
        ({
          kind: AgentKind.CursorAgent,
          sessions: {
            listingUnavailableReason: null,
            listingPartialReason: 'a second store is not reached',
            historyUnavailableReason: null,
          },
        }) as AdapterConfig,
    });
    return expect(
      service.list(AgentKind.CursorAgent, null, null, null),
    ).resolves.toMatchObject({
      partialReason: 'a second store is not reached',
    });
  });

  it('says so when the cap cut the list, rather than passing it off as all', async () => {
    // The picker asks ONE unfiltered question and searches what came back, so a
    // session past the cut cannot be found at all — a short list that looks
    // complete is the whole failure mode.
    const { service } = setup({
      listSessions: (input) =>
        Promise.resolve({
          sessions: Array.from({ length: input.limit }, (_unused, index) => ({
            id: `s${index}`,
            cwd: '/w',
            title: null,
            updatedAt: null,
            snippet: null,
          })),
          unavailableReason: null,
          partialReason: null,
        }),
    });
    const listing = await service.list(AgentKind.Claude, null, null, null);
    expect(listing.partialReason).toMatch(/most recent sessions/);
    // The overflow row is asked for so the two cases can be told apart, and
    // dropped before the answer goes out — the cap is still the cap.
    expect(listing.sessions).toHaveLength(400);
  });

  it('says nothing about a profile holding EXACTLY the cap', async () => {
    // The off-by-one. Asking for exactly the cap makes a full page and an
    // overflowing one identical, so a user looking at every session they have
    // was told the list had been cut. The extra row asked for above is what
    // separates them, and it must not leak into the answer either.
    const { service } = setup({
      listSessions: () =>
        Promise.resolve({
          sessions: Array.from({ length: 400 }, (_unused, index) => ({
            id: `s${index}`,
            cwd: '/w',
            title: null,
            updatedAt: null,
            snippet: null,
          })),
          unavailableReason: null,
          partialReason: null,
        }),
    });

    const listing = await service.list(AgentKind.Claude, null, null, null);

    expect(listing.sessions).toHaveLength(400);
    expect(listing.partialReason).toBeNull();
  });

  it('claims nothing about a list that fitted', async () => {
    const { service } = setup();
    await expect(
      service.list(AgentKind.Claude, null, null, null),
    ).resolves.toMatchObject({ partialReason: null });
  });

  it('joins two callers onto ONE listing', async () => {
    // cursor's listing SPAWNS a process; a picker re-asking as its folder
    // filter changes must not launch one per keystroke.
    let calls = 0;
    const { service } = setup({
      listSessions: () => {
        calls += 1;
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                sessions: [],
                unavailableReason: null,
                partialReason: null,
              }),
            5,
          ),
        );
      },
    });
    await Promise.all([
      service.list(AgentKind.Claude, '/w', null, null),
      service.list(AgentKind.Claude, '/w', null, null),
    ]);
    expect(calls).toBe(1);
    // A DIFFERENT question is its own ask, not a served cache hit.
    await service.list(AgentKind.Claude, '/other', null, null);
    expect(calls).toBe(2);
  });
});

describe('CliSessionsService.prepare', () => {
  it("turns an adapter's refusal into a 400 carrying its own sentence", async () => {
    const { service } = setup({
      prepareSessionImport: () =>
        Promise.reject(new Error('that session is no longer in this profile')),
    });
    await expect(
      service.prepare(AgentKind.CursorAgent, 's1', '/w', null),
    ).rejects.toThrow('that session is no longer in this profile');
  });
});

describe('CliSessionsService.importHistory', () => {
  it('says NOTHING when the whole conversation came across', async () => {
    // The transcript is its own evidence; a row announcing "this went fine" is
    // a line the user reads past forever to reach what they came for.
    const { service } = setup({
      readSessionHistory: () =>
        Promise.resolve({
          events: [{ type: 'text', text: 'hi' }],
          droppedBefore: 0,
        }),
    });
    const result = await service.importHistory(
      AgentKind.Claude,
      's1',
      '/w',
      null,
    );
    expect(result.notice).toBeNull();
    expect(result.events).toHaveLength(1);
  });

  it('says so when it left earlier messages out', async () => {
    const { service } = setup({
      readSessionHistory: () =>
        Promise.resolve({ events: [], droppedBefore: 12 }),
    });
    const { notice } = await service.importHistory(
      AgentKind.Claude,
      's1',
      '/w',
      null,
    );
    expect(notice).toContain('most recent part');
  });

  it("relays the CLI's own reason when it keeps no readable record", async () => {
    const { service } = setup({
      readSessionHistory: () => Promise.resolve(null),
      getConfig: () =>
        ({
          kind: AgentKind.CursorAgent,
          sessions: {
            listingUnavailableReason: null,
            listingPartialReason: null,
            historyUnavailableReason: 'this CLI keeps no readable transcript',
          },
        }) as AdapterConfig,
    });
    const { notice, events } = await service.importHistory(
      AgentKind.CursorAgent,
      's1',
      '/w',
      null,
    );
    expect(notice).toContain('this CLI keeps no readable transcript');
    expect(events).toEqual([]);
  });

  it('does not let a failed TRANSCRIPT read cost the import', async () => {
    // The contract says implementations do not throw; this is the belt on top —
    // the session itself resumes either way.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service } = setup({
      readSessionHistory: () => Promise.reject(new Error('disk gone')),
    });
    const { notice, events } = await service.importHistory(
      AgentKind.Claude,
      's1',
      '/w',
      null,
    );
    expect(events).toEqual([]);
    expect(notice).toContain('not shown here');
    warn.mockRestore();
  });
});

describe('CliSessionsService.importHistory — detached commands', () => {
  it('closes a historical command whose ending the session never recorded, last', async () => {
    // A command started outside Geniro is not Geniro's to track: left open it
    // read `running · detached` for the life of the thread.
    const launch: AgentEvent[] = [
      {
        type: 'tool_call',
        id: 'call-1',
        name: 'Bash',
        input: { command: 'sleep 300' },
      },
      {
        type: 'tool_result',
        id: 'call-1',
        name: null,
        result: 'running as b1',
        isError: false,
      },
      { type: 'shell_open', toolCallId: 'call-1', workId: 'b1' },
    ];
    const { service } = setup({
      readSessionHistory: () =>
        Promise.resolve({ events: launch, droppedBefore: 0 }),
    });

    const { events } = await service.importHistory(
      AgentKind.Claude,
      's1',
      '/w',
      null,
    );

    expect(events).toEqual([
      ...launch,
      { type: 'shell_info', toolCallId: 'call-1', workId: 'b1' },
    ]);
  });
});

describe('searching the conversations', () => {
  // REPORTED as "improve search bu threads - by content as well". The search
  // is a QUESTION for the adapter, which is the only side that can read what
  // was said inside a conversation — never a filter this service applies to an
  // answer it was given.
  it('hands the query to the adapter rather than filtering its answer', async () => {
    const { service, listed } = setup();

    await service.list(AgentKind.Claude, null, null, 'asar geniro');

    expect(listed[0]?.query).toBe('asar geniro');
  });

  it('asks for EVERYTHING when the box is empty', async () => {
    const { service, listed } = setup();

    await service.list(AgentKind.Claude, null, null, null);

    expect(listed[0]?.query).toBeNull();
  });

  it('does not answer a search with a listing taken for a DIFFERENT one', async () => {
    // The in-flight join exists so two callers asking the same thing launch one
    // read. The query is part of the thing being asked, so a search typed while
    // the unfiltered listing was still out must not be joined to it and handed
    // back the whole list.
    let release: (listing: AgentSessionListing) => void = () => {};
    const { service, listed } = setup({
      listSessions: (input) => {
        listed.push(input);
        return new Promise<AgentSessionListing>((resolve) => {
          release = resolve;
        });
      },
    });

    void service.list(AgentKind.Claude, null, null, null);
    void service.list(AgentKind.Claude, null, null, 'asar');
    release({ sessions: [], unavailableReason: null, partialReason: null });

    expect(listed.map((input) => input.query)).toEqual([null, 'asar']);
  });

  it('carries what THIS call could not reach, beside the standing fact', async () => {
    // Two independently true things — a bounded content search, and a store
    // the CLI cannot open at all — and dropping either leaves a partial answer
    // reading as a complete one.
    const { service } = setup({
      listSessions: () =>
        Promise.resolve({
          sessions: [],
          unavailableReason: null,
          partialReason: 'Searched the 600 most recent conversations.',
        }),
      getConfig: () =>
        ({
          kind: AgentKind.Claude,
          sessions: {
            listingUnavailableReason: null,
            listingPartialReason: 'Only ACP sessions are listed.',
            historyUnavailableReason: null,
            contentSearchUnavailableReason: null,
          },
        }) as AdapterConfig,
    });

    const listing = await service.list(AgentKind.Claude, null, null, 'asar');

    expect(listing.partialReason).toContain('Only ACP sessions');
    expect(listing.partialReason).toContain('600 most recent');
  });

  it('says a CLI searches titles only WHILE searching, and not before', async () => {
    // A limitation of searching, stated over a list nobody has searched, is a
    // caveat about a feature the user has not reached for.
    const build = (): ReturnType<typeof setup> =>
      setup({
        getConfig: () =>
          ({
            kind: AgentKind.Claude,
            sessions: {
              listingUnavailableReason: null,
              listingPartialReason: null,
              historyUnavailableReason: null,
              contentSearchUnavailableReason: 'titles and folders only',
            },
          }) as AdapterConfig,
      });

    await expect(
      build().service.list(AgentKind.Claude, null, null, 'asar'),
    ).resolves.toMatchObject({ partialReason: 'titles and folders only' });
    await expect(
      build().service.list(AgentKind.Claude, null, null, null),
    ).resolves.toMatchObject({ partialReason: null });
  });
});
