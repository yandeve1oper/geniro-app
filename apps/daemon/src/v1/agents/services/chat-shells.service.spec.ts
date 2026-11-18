import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeEntityManager } from '../__tests__/fake-entity-manager';
import { NO_CALL_INDEX } from '../__tests__/no-call-index';
import type { ItemDao } from '../dao/item.dao';
import type { AgentEventBus } from './agent-events.bus';
import type { AgentSessionRegistry } from './agent-session.registry';
import type { ChatService } from './chat.service';
import { ChatShellsService } from './chat-shells.service';
import type { ItemSeqAllocator } from './item-seq.allocator';
import type { RunKindRowsCache } from './run-kind-rows.cache';

/**
 * The machine, faked at the two module seams `kill` reads it through — the
 * process table and the signals. Nothing here may signal a real process: this
 * suite runs beside whatever else the developer has open, and
 * `pidsRunningCommand` deliberately matches a PREFIX, so a needle that escaped
 * would not stop at the fixtures.
 *
 * `pidsRunningCommand` itself is the REAL one, because it is the whole of what
 * decides which pids a press reaches — faking it would leave every assertion
 * below describing the fake.
 */
const machine = vi.hoisted(() => ({
  processes: [] as {
    pid: number;
    ppid: number;
    args: string;
    pgid?: number;
    startedAt?: number;
  }[],
  signals: [] as { pid: number | undefined; signal: string }[],
}));

vi.mock('../utils/process-descendants', async (importActual) => ({
  ...(await importActual<object>()),
  listProcesses: async () => machine.processes,
}));

vi.mock('../utils/run-process-scan', async (importActual) => ({
  ...(await importActual<object>()),
  scanPlainTable: async () =>
    machine.processes.map((row) => ({
      ...row,
      pgid: row.pgid ?? row.pid,
      uid: 501,
      tty: null,
      startedAt: row.startedAt ?? 0,
    })),
}));

vi.mock('../utils/kill-tree', async (importActual) => ({
  ...(await importActual<object>()),
  killProcessGroup: (pid: number | undefined, signal: string) => {
    machine.signals.push({ pid, signal });
  },
}));

interface Row {
  seq: number;
  kind: string;
  payload: string;
  memberId: string | null;
  createdAt: Date;
}

function lifecycle(
  seq: number,
  kind: 'shell_open' | 'shell_info',
  id: string,
  memberId: string | null = null,
  callId: string | null = null,
): Row {
  return {
    seq,
    kind,
    payload: JSON.stringify({ id, workId: `w-${id}`, callId }),
    memberId,
    createdAt: new Date(seq * 1000),
  };
}

/** Every row `close` wrote — the `shell_info` a killed command owes. */
interface WrittenRow {
  runId: string;
  memberId: string | null;
  seq: number;
  kind: string;
  payload: unknown;
}

function service(
  rows: Row[],
  calls: {
    id: string;
    command?: string;
    name?: string;
    parentToolUseId?: string;
  }[],
  live: {
    /** Calls the CLI has already answered — a `tool_result` row exists. */
    answered?: string[];
    /** The pids of this run's live CLI processes. */
    roots?: number[];
    /**
     * The pids the session recorded running each call's command; a call
     * absent here is one no live process reports running.
     */
    recorded?: Record<string, number[]>;
    /** Whole groups, where a test needs more than one member or a dead leader. */
    recordedGroups?: Record<
      string,
      { pgid: number; members: { pid: number; startedAt: number }[] }[]
    >;
  } = {},
): {
  service: ChatShellsService;
  asked: string[][];
  written: WrittenRow[];
  published: WrittenRow[];
  uncounted: { runId: string; workId: string | null }[];
} {
  const asked: string[][] = [];
  const written: WrittenRow[] = [];
  const published: WrittenRow[] = [];
  const itemDao = {
    toolCallsByIds: async (_runId: string, ids: readonly string[]) => {
      asked.push([...ids]);
      return calls
        .filter((call) => ids.includes(call.id))
        .map((call) => ({
          payload: JSON.stringify({
            id: call.id,
            name: call.name ?? 'Bash',
            ...(call.command === undefined
              ? {}
              : { input: { command: call.command } }),
            ...(call.parentToolUseId === undefined
              ? {}
              : { parentToolUseId: call.parentToolUseId }),
          }),
          // Filed where the shell it launched was: a call and its shell are
          // the same conversation's rows.
          memberId:
            rows.find(
              (row) =>
                (JSON.parse(row.payload) as { id?: string }).id === call.id,
            )?.memberId ?? null,
          createdAt: new Date(0),
        }));
    },
    // The foreground arm's read: the call and, when answered, its reply.
    rowsByPayloadId: async (
      _runId: string,
      _kinds: readonly string[],
      ids: readonly string[],
    ) => [
      ...calls
        .filter((call) => ids.includes(call.id))
        .map((call) => ({
          kind: 'tool_call',
          payload: JSON.stringify({
            id: call.id,
            name: call.name ?? 'Bash',
            ...(call.command === undefined
              ? {}
              : { input: { command: call.command } }),
          }),
        })),
      ...(live.answered ?? [])
        .filter((id) => ids.includes(id))
        .map((id) => ({
          kind: 'tool_result',
          payload: JSON.stringify({ id, result: 'done' }),
        })),
    ],
    // What `persistItemAndEmit` writes through — the real helper runs, so the
    // close is pinned as the row it actually stores rather than as a call to a
    // doubled `close`.
    create: async (row: WrittenRow & { payload: string }) => {
      written.push({ ...row, payload: JSON.parse(row.payload) });
      return { id: `item-${written.length}`, createdAt: new Date(0) };
    },
  } as unknown as ItemDao;
  const bus = {
    publish: ({ item }: { item: WrittenRow }) => {
      published.push(item);
    },
  } as unknown as AgentEventBus;
  const seqs = {
    reserve: async () => 99,
    settle: () => undefined,
  } as unknown as ItemSeqAllocator;
  const uncounted: {
    runId: string;
    workId: string | null;
    memberId: string | null;
  }[] = [];
  const chats = {
    noteShellClosed: (
      runId: string,
      workId: string | null,
      memberId: string | null,
    ) => {
      uncounted.push({ runId, workId, memberId });
    },
  } as unknown as ChatService;
  return {
    service: new ChatShellsService(
      fakeEntityManager(),
      itemDao,
      bus,
      seqs,
      chats,
      {
        processRoots: () =>
          (live.roots ?? []).map((pid) => ({
            key: 'run-1',
            agent: 'codex',
            cwd: '/work',
            pid,
          })),
        recordedGroupsOf: (_runId: string, callId: string) =>
          live.recordedGroups?.[callId] ??
          live.recorded?.[callId]?.map((pid) => ({
            pgid: pid,
            members: [{ pid, startedAt: 0 }],
          })) ??
          null,
      } as unknown as AgentSessionRegistry,
      NO_CALL_INDEX,
      {
        rowsOf: async (
          _runId: string,
          kinds: readonly string[],
          atLeast: unknown,
        ) => {
          expect([kinds, atLeast]).toEqual([
            ['shell_open', 'shell_info'],
            'fresh',
          ]);
          return rows;
        },
      } as unknown as RunKindRowsCache,
    ),
    asked,
    written,
    published,
    uncounted,
  };
}

beforeEach(() => {
  machine.processes = [];
  machine.signals = [];
  vi.useRealTimers();
});

describe('ChatShellsService', () => {
  it('answers the commands still running over the WHOLE conversation', async () => {
    // The point of the route. The renderer folds the same list from the loaded
    // transcript window, so a command detached before it drops off the list
    // while the run keeps counting it — the reported `working` badge over an
    // empty shelf. Here the open row sits at seq 1 of a conversation whose
    // newest rows are thousands later, which is exactly the case a client fold
    // cannot reach.
    const { service: svc } = service(
      [
        lifecycle(1, 'shell_open', 'call-old'),
        lifecycle(2, 'shell_open', 'call-closed'),
        lifecycle(3, 'shell_info', 'call-closed'),
      ],
      [
        { id: 'call-old', command: 'pnpm dev' },
        { id: 'call-closed', command: 'pnpm build' },
      ],
    );

    const answer = await svc.read('run-1');

    expect(answer.shells).toEqual([
      {
        id: 'call-old',
        command: 'pnpm dev',
        memberId: null,
        callId: null,
        startedAt: 1000,
      },
    ]);
  });

  it('asks for the words of the OPEN commands alone', async () => {
    // The join is addressed, never scanned: the thread this was measured on
    // holds thousands of tool calls and, at the moment of the report, one open
    // command. A scan would read the whole run to answer about one row.
    const { service: svc, asked } = service(
      [
        lifecycle(1, 'shell_open', 'a'),
        lifecycle(2, 'shell_open', 'b'),
        lifecycle(3, 'shell_info', 'b'),
      ],
      [{ id: 'a', command: 'sleep 300' }],
    );

    await svc.read('run-1');

    expect(asked).toEqual([['a']]);
  });

  it('keeps a command whose call it could not read, named by its id', async () => {
    // It is still RUNNING. Dropping it would put the badge's count back over
    // the list, which is the whole defect this answers — so an unreadable call
    // costs the words and never the row.
    const { service: svc } = service([lifecycle(1, 'shell_open', 'ghost')], []);

    const answer = await svc.read('run-1');

    expect(answer.shells).toEqual([
      {
        id: 'ghost',
        command: 'ghost',
        memberId: null,
        callId: null,
        startedAt: 1000,
      },
    ]);
  });

  it('carries the team NODE that started it', async () => {
    // The shelf labels a team's rows by agent, and that is the only place
    // the question arises — a 1:1 chat writes null here.
    const { service: svc } = service(
      [lifecycle(1, 'shell_open', 'c', 'qa')],
      [{ id: 'c', command: 'pnpm test' }],
    );

    const answer = await svc.read('run-1');

    expect(answer.shells[0]?.memberId).toBe('qa');
  });

  it('leaves out a command a DELEGATE started — the list is the agent’s own', async () => {
    const { service: svc } = service(
      [lifecycle(1, 'shell_open', 'own'), lifecycle(2, 'shell_open', 'sub')],
      [
        { id: 'own', command: 'pnpm dev' },
        { id: 'sub', command: 'pnpm build', parentToolUseId: 'toolu_task' },
      ],
    );

    const answer = await svc.read('run-1');

    expect(answer.shells.map((shell) => shell.id)).toEqual(['own']);
  });

  it('carries the agent CALL whose turn started it', async () => {
    // A member called several times files each command under its conversation,
    // and a command started above the loaded window has no other row to say
    // which one.
    const { service: svc } = service(
      [lifecycle(1, 'shell_open', 'c', 'qa', 'call-7')],
      [{ id: 'c', command: 'pnpm test' }],
    );

    const answer = await svc.read('run-1');

    expect(answer.shells[0]?.callId).toBe('call-7');
  });

  it('answers nothing for a run whose commands have all finished', async () => {
    const { service: svc, asked } = service(
      [lifecycle(1, 'shell_open', 'a'), lifecycle(2, 'shell_info', 'a')],
      [{ id: 'a', command: 'ls' }],
    );

    const answer = await svc.read('run-1');

    expect(answer.shells).toEqual([]);
    // …and it does not go looking for words it has no rows to attach them to.
    expect(asked).toEqual([]);
  });
});

describe('ChatShellsService.kill', () => {
  /** A detached command's launch, answered at once — claude's and cursor's. */
  const LAUNCH_ANSWERED = { answered: ['call-1'] };

  it('SIGTERMs every process running that command, then SIGKILLs', async () => {
    // The GROUP and not the pid, and every match rather than the first: a CLI
    // wraps what it runs, so one command is routinely two rows — here the zsh
    // preamble cursor puts in front of it and the command itself. Killing the
    // leaf alone would leave the wrapper holding the terminal.
    vi.useFakeTimers();
    machine.processes = [
      { pid: 41, ppid: 1, args: '/bin/zsh -lc -- pnpm dev' },
      { pid: 42, ppid: 41, args: 'pnpm dev' },
      { pid: 43, ppid: 1, args: 'pnpm build' },
    ];
    const { service: svc } = service(
      [lifecycle(1, 'shell_open', 'call-1')],
      [{ id: 'call-1', command: 'pnpm dev' }],
      LAUNCH_ANSWERED,
    );

    const answer = await svc.kill('run-1', 'call-1');

    expect(answer).toEqual({ killed: true, reason: null });
    expect(machine.signals).toEqual([
      { pid: 41, signal: 'SIGTERM' },
      { pid: 42, signal: 'SIGTERM' },
    ]);
    // Asked to stop before being made to — the courtesy every other kill path
    // here extends, since a `pnpm dev` holds children and writes files.
    await vi.advanceTimersByTimeAsync(2000);
    expect(machine.signals.slice(2)).toEqual([
      { pid: 41, signal: 'SIGKILL' },
      { pid: 42, signal: 'SIGKILL' },
    ]);
  });

  it('stops only the background command pressed, not one written alike that its session did not record', async () => {
    // Two `pnpm dev` the agent detached in different folders read the same in
    // the table; the live session recorded which processes each one runs in.
    machine.processes = [
      { pid: 41, ppid: 1, args: '/bin/zsh -c pnpm dev' },
      { pid: 42, ppid: 41, args: 'pnpm dev' },
      { pid: 51, ppid: 1, args: '/bin/zsh -c pnpm dev' },
      { pid: 52, ppid: 51, args: 'pnpm dev' },
    ];
    const { service: svc } = service(
      [
        lifecycle(1, 'shell_open', 'call-1'),
        lifecycle(2, 'shell_open', 'call-2'),
      ],
      [
        { id: 'call-1', command: 'pnpm dev' },
        { id: 'call-2', command: 'pnpm dev' },
      ],
      { answered: ['call-1', 'call-2'], recorded: { 'call-2': [51] } },
    );

    expect(await svc.kill('run-1', 'call-2')).toEqual({
      killed: true,
      reason: null,
    });
    expect(machine.signals).toEqual([
      { pid: 51, signal: 'SIGTERM' },
      { pid: 52, signal: 'SIGTERM' },
    ]);
  });

  it('stops the recorded group of a command whose text is not in the table', async () => {
    // A heredoc: the wrapper takes the line over a descriptor, so nothing in
    // the table reads as what the agent wrote. The wrapper has gone too, so the
    // group's id names no live process: only a signal to the group reaches it.
    machine.processes = [{ pid: 42, ppid: 1, pgid: 41, args: 'Python' }];
    const { service: svc } = service(
      [lifecycle(1, 'shell_open', 'call-1')],
      [{ id: 'call-1', command: "python3 << 'PY'\nprint(1)\nPY" }],
      {
        answered: ['call-1'],
        recordedGroups: {
          'call-1': [{ pgid: 41, members: [{ pid: 42, startedAt: 0 }] }],
        },
      },
    );

    expect(await svc.kill('run-1', 'call-1')).toEqual({
      killed: true,
      reason: null,
    });
    expect(machine.signals).toEqual([{ pid: 41, signal: 'SIGTERM' }]);
  });

  it('never signals a recorded group whose member is another process by now', async () => {
    machine.processes = [
      { pid: 42, ppid: 1, pgid: 41, args: 'stranger', startedAt: 999_000 },
    ];
    const { service: svc, written } = service(
      [lifecycle(1, 'shell_open', 'call-1')],
      [{ id: 'call-1', command: "python3 << 'PY'\nprint(1)\nPY" }],
      {
        answered: ['call-1'],
        recordedGroups: {
          'call-1': [{ pgid: 41, members: [{ pid: 42, startedAt: 5_000 }] }],
        },
      },
    );

    expect(await svc.kill('run-1', 'call-1')).toEqual({
      killed: false,
      reason: expect.stringContaining('already stopped'),
    });
    expect(machine.signals).toEqual([]);
    expect(written).toHaveLength(1);
  });

  it('writes the close itself, since nothing else will', async () => {
    // The row that would have announced the ending is the CLI's own bracket,
    // and the CLI is gone. Without this the command would go on being listed
    // as running by the very fold that just killed it.
    machine.processes = [{ pid: 42, ppid: 1, args: 'pnpm dev' }];
    const {
      service: svc,
      written,
      published,
      uncounted,
    } = service(
      [lifecycle(1, 'shell_open', 'call-1', 'qa')],
      [{ id: 'call-1', command: 'pnpm dev' }],
      LAUNCH_ANSWERED,
    );

    await svc.kill('run-1', 'call-1');

    expect(written).toEqual([
      {
        runId: 'run-1',
        // The member that STARTED it, carried over from the open — a close filed
        // at the wrong member is the defect item 5 fixed one level up.
        memberId: 'qa',
        seq: 99,
        kind: 'shell_info',
        role: null,
        payload: {
          id: 'call-1',
          // The CLI's own handle, carried from the open so this close is the
          // same shape every other one has — `shell-activity.ts` matches by
          // call, ELSE by this.
          workId: 'w-call-1',
          killedByUser: true,
        },
        searchText: expect.anything(),
        inCall: '',
      },
    ]);
    // Persist THEN emit, so a reconnecting client replays a durable row.
    expect(published).toHaveLength(1);
    // And the run's LIVE count comes down with it. Nothing else will bring it
    // down: the count is kept off the CLI's own brackets and the CLI already
    // answered this command's launch, so without this the badge reads
    // `working · waiting on background work` for the rest of the session.
    // Under the member that opened it: the count is keyed by member and work id.
    expect(uncounted).toEqual([
      { runId: 'run-1', workId: 'w-call-1', memberId: 'qa' },
    ]);
  });

  it('takes a row off the list when the machine says it already stopped', async () => {
    // The transcript says open and `ps` says otherwise — a command that died
    // with no one to write its close. Recording it is the useful answer, and it
    // is what takes the row off the list.
    const { service: svc, written } = service(
      [lifecycle(1, 'shell_open', 'call-1')],
      [{ id: 'call-1', command: 'pnpm dev' }],
      LAUNCH_ANSWERED,
    );

    const answer = await svc.kill('run-1', 'call-1');

    expect(answer.killed).toBe(false);
    expect(answer.reason).toContain('already stopped');
    expect(machine.signals).toEqual([]);
    expect(written).toHaveLength(1);
  });

  it('signals NOTHING for a command this run never had open', async () => {
    // The list a user pressed from is a snapshot, so a command that finished on
    // its own between the render and the press is the ordinary race — and a
    // command from ANOTHER conversation must never be reachable by id alone,
    // which is what makes this the load-bearing half.
    machine.processes = [{ pid: 42, ppid: 1, args: 'pnpm dev' }];
    const { service: svc, written } = service(
      [lifecycle(1, 'shell_open', 'call-1')],
      [{ id: 'call-1', command: 'pnpm dev' }],
    );

    const answer = await svc.kill('run-1', 'someone-elses-call');

    expect(answer).toEqual({
      killed: false,
      reason: 'that command is no longer running',
    });
    expect(machine.signals).toEqual([]);
    expect(written).toEqual([]);
  });

  it('REFUSES a command whose call could not be read, rather than guessing', async () => {
    // Such a row is DRAWN under its id, because it is still running and the
    // count would otherwise outrun the list. An id is not a command, and the
    // match is a PREFIX — so signalling on one can only hit by accident, and
    // what it hits is somebody else's process. Here `ghost --serve` is exactly
    // that accident: a process the row has nothing to do with, which a fold
    // that let the display fallback through to the kill would have killed.
    machine.processes = [{ pid: 42, ppid: 1, args: 'ghost --serve' }];
    const { service: svc, written } = service(
      [lifecycle(1, 'shell_open', 'ghost')],
      [],
    );

    const answer = await svc.kill('run-1', 'ghost');

    expect(machine.signals).toEqual([]);
    expect(answer.killed).toBe(false);
    expect(answer.reason).toContain('cannot tell which process');
    // And the row STAYS: it is still running, so writing its close would take
    // it off a list it belongs on.
    expect(written).toEqual([]);
  });

  it('stops a shell whose call is still unanswered inside the run, as a foreground one', async () => {
    // codex keeps a background terminal's call open until the command exits,
    // and its written `/bin/zsh -lc '…'` is exec'd away: matched as a detached
    // command across the table it found nothing and said "already stopped"
    // over a server that ran on.
    vi.useFakeTimers();
    machine.processes = [
      { pid: 100, ppid: 1, args: 'codex app-server' },
      { pid: 102, ppid: 100, args: 'node /opt/homebrew/bin/pnpm dev' },
      { pid: 200, ppid: 1, args: 'node /opt/homebrew/bin/pnpm dev' },
    ];
    const { service: svc, written } = service(
      [lifecycle(1, 'shell_open', 'exec-1')],
      [{ id: 'exec-1', command: "/bin/zsh -lc 'pnpm dev'" }],
      { roots: [100] },
    );

    const answer = await svc.kill('run-1', 'exec-1');

    expect(answer).toEqual({ killed: true, reason: null });
    expect(machine.signals).toEqual([{ pid: 102, signal: 'SIGTERM' }]);
    // codex completes the item once its command exits, which closes the row.
    expect(written).toEqual([]);
  });

  it('stops only the codex shell pressed, not a sibling started alike in another folder', async () => {
    // Both read `/bin/zsh -lc 'pnpm dev'` — codex passes the folder apart —
    // and zsh exec'd both into `node …/pnpm dev`.
    machine.processes = [
      { pid: 100, ppid: 1, args: 'codex app-server' },
      { pid: 102, ppid: 100, args: 'node /opt/homebrew/bin/pnpm dev' },
      { pid: 103, ppid: 102, args: 'node vite' },
      { pid: 202, ppid: 100, args: 'node /opt/homebrew/bin/pnpm dev' },
    ];
    const { service: svc } = service(
      [
        lifecycle(1, 'shell_open', 'exec-1'),
        lifecycle(2, 'shell_open', 'exec-2'),
      ],
      [
        { id: 'exec-1', command: "/bin/zsh -lc 'pnpm dev'" },
        { id: 'exec-2', command: "/bin/zsh -lc 'pnpm dev'" },
      ],
      { roots: [100], recorded: { 'exec-1': [102], 'exec-2': [202] } },
    );

    expect(await svc.kill('run-1', 'exec-2')).toEqual({
      killed: true,
      reason: null,
    });
    expect(machine.signals).toEqual([{ pid: 202, signal: 'SIGTERM' }]);
  });

  it('never stops a sibling written alike while the pressed shell’s recorded process runs outside the agent’s tree', async () => {
    // exec-2's own process left codex's tree; the `pnpm dev` still under codex
    // is exec-1's, whatever its text.
    machine.processes = [
      { pid: 100, ppid: 1, args: 'codex app-server' },
      { pid: 102, ppid: 100, args: 'node /opt/homebrew/bin/pnpm dev' },
      { pid: 300, ppid: 1, args: 'node /opt/homebrew/bin/pnpm dev' },
    ];
    const { service: svc } = service(
      [
        lifecycle(1, 'shell_open', 'exec-1'),
        lifecycle(2, 'shell_open', 'exec-2'),
      ],
      [
        { id: 'exec-1', command: "/bin/zsh -lc 'pnpm dev'" },
        { id: 'exec-2', command: "/bin/zsh -lc 'pnpm dev'" },
      ],
      { roots: [100], recorded: { 'exec-2': [300] } },
    );

    await svc.kill('run-1', 'exec-2');

    expect(machine.signals).toEqual([]);
  });

  it('keeps a codex shell listed while codex reports it running, though no process reads as it', async () => {
    // zsh and python3's framework launcher both exec: what runs reads
    // `…/Python.app/Contents/MacOS/Python -m http.server 8000`, matching no
    // needle of what the agent wrote.
    machine.processes = [
      { pid: 100, ppid: 1, args: 'codex app-server' },
      {
        pid: 102,
        ppid: 100,
        args: '/opt/homebrew/Cellar/python@3.14/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python -m http.server 8000',
      },
    ];
    const { service: svc, written } = service(
      [lifecycle(1, 'shell_open', 'exec-1')],
      [{ id: 'exec-1', command: "/bin/zsh -lc 'python3 -m http.server 8000'" }],
      { roots: [100], recorded: { 'exec-1': [] } },
    );

    const answer = await svc.kill('run-1', 'exec-1');

    expect(answer).toEqual({
      killed: false,
      reason:
        'geniro could not tell which of the agent’s processes runs this command — ask the agent to stop it',
    });
    expect(machine.signals).toEqual([]);
    expect(written).toEqual([]);
  });

  it('takes a codex shell off the list when nothing of it runs any more', async () => {
    machine.processes = [{ pid: 100, ppid: 1, args: 'codex app-server' }];
    const { service: svc, written } = service(
      [lifecycle(1, 'shell_open', 'exec-1')],
      [{ id: 'exec-1', command: "/bin/zsh -lc 'pnpm dev'" }],
      { roots: [100] },
    );

    const answer = await svc.kill('run-1', 'exec-1');

    expect(answer).toEqual({
      killed: false,
      reason: 'that command had already stopped — the list is now up to date',
    });
    expect(machine.signals).toEqual([]);
    expect(written).toEqual([
      expect.objectContaining({
        kind: 'shell_info',
        payload: expect.objectContaining({ id: 'exec-1', killedByUser: true }),
      }),
    ]);
  });

  describe('a FOREGROUND command — one the agent is still waiting on', () => {
    // The reported case: a codex `pnpm dev` the agent never got an answer from,
    // listed as running, and a Stop that answered "no longer running" because
    // only detached commands (`shell_open` rows) were ever looked for.
    const COMMAND =
      "/bin/zsh -lc 'env -u ELECTRON_RUN_AS_NODE GENIRO_UI_USER_DATA=/tmp/review pnpm dev -- --remoteDebuggingPort 9341 > /tmp/dev.log 2>&1'";
    const DEV = 'node /opt/homebrew/bin/pnpm dev -- --remoteDebuggingPort 9341';
    // 100 is this run's CLI. zsh and env exec'd, so 102 reads as `pnpm dev`;
    // 103/104 are what the dev server started. 200 is the user's OWN
    // `pnpm dev` in another terminal, byte-for-byte the same command line.
    const TABLE = [
      { pid: 100, ppid: 1, args: 'codex app-server' },
      { pid: 101, ppid: 100, args: 'node /mcp/server.js' },
      { pid: 102, ppid: 100, args: DEV },
      { pid: 103, ppid: 102, args: 'node electron-vite dev' },
      { pid: 104, ppid: 103, args: '/Applications/Electron.app/Electron .' },
      { pid: 200, ppid: 1, args: DEV },
    ];

    it('stops the command and everything it started, inside the run alone', async () => {
      vi.useFakeTimers();
      machine.processes = TABLE;
      const { service: svc, written } = service(
        [],
        [{ id: 'call-fg', command: COMMAND }],
        { roots: [100] },
      );

      const answer = await svc.kill('run-1', 'call-fg');

      expect(answer).toEqual({ killed: true, reason: null });
      expect(machine.signals).toEqual([
        { pid: 102, signal: 'SIGTERM' },
        { pid: 103, signal: 'SIGTERM' },
        { pid: 104, signal: 'SIGTERM' },
      ]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(
        machine.signals.filter((sent) => sent.signal === 'SIGKILL'),
      ).toEqual([
        { pid: 102, signal: 'SIGKILL' },
        { pid: 103, signal: 'SIGKILL' },
        { pid: 104, signal: 'SIGKILL' },
      ]);
      // The CLI answers the call itself once its command exits; a close
      // written here would be a second, invented ending.
      expect(written).toEqual([]);
    });

    it('signals nothing once the CLI has answered the call', async () => {
      machine.processes = TABLE;
      const { service: svc } = service(
        [],
        [{ id: 'call-fg', command: COMMAND }],
        { roots: [100], answered: ['call-fg'] },
      );

      const answer = await svc.kill('run-1', 'call-fg');

      expect(answer).toEqual({
        killed: false,
        reason: 'that command is no longer running',
      });
      expect(machine.signals).toEqual([]);
    });

    it('signals nothing when the run holds no live CLI to search under', async () => {
      // Without a root the only match left is the user's own `pnpm dev` (200),
      // which is exactly what attribution exists to keep out of reach.
      machine.processes = TABLE;
      const { service: svc } = service(
        [],
        [{ id: 'call-fg', command: COMMAND }],
      );

      const answer = await svc.kill('run-1', 'call-fg');

      expect(answer.killed).toBe(false);
      expect(answer.reason).toContain(
        'agent process that started this command is gone',
      );
      expect(machine.signals).toEqual([]);
    });

    it("says so when the command is not among the run's processes", async () => {
      machine.processes = TABLE.filter((row) => row.pid !== 102);
      const { service: svc } = service(
        [],
        [{ id: 'call-fg', command: COMMAND }],
        { roots: [100] },
      );

      const answer = await svc.kill('run-1', 'call-fg');

      expect(answer.killed).toBe(false);
      expect(answer.reason).toContain('stop the turn');
      expect(machine.signals).toEqual([]);
    });
  });
});
