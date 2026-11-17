import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ChildJournal,
  type ChildJournalFile,
  clearChildJournal,
  configureChildJournal,
  currentChildJournal,
  readChildJournal,
  resetChildJournal,
  trackDetachedChild,
} from './child-journal';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'geniro-journal-'));
  path = join(dir, 'children.json');
});

afterEach(() => {
  resetChildJournal();
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the slice of ChildProcess the journal touches. */
function fakeChild(pid: number | undefined): EventEmitter & { pid?: number } {
  return Object.assign(new EventEmitter(), { pid });
}

function readRaw(): ChildJournalFile {
  return JSON.parse(readFileSync(path, 'utf8')) as ChildJournalFile;
}

describe('ChildJournal', () => {
  it('writes a spawned group to disk immediately, stamped with this daemon', () => {
    // The whole contract: the record must be durable BEFORE the caller
    // continues, because the SIGKILL it guards against can land on the next tick.
    new ChildJournal(path, undefined, () => 1_700).record(4242, '/bin/claude');

    expect(readRaw()).toEqual({
      version: 2,
      ownerPid: process.pid,
      ownerStartedAt: expect.any(Number),
      children: [{ pid: 4242, startedAt: 1_700, command: '/bin/claude' }],
      commandGroups: [],
    });
  });

  it('stamps the owner with THIS process’s start time, not the moment it wrote', () => {
    // What lets the reaper tell a live owner from a recycled pid: the stamp
    // has to be when the daemon STARTED, which is what the kernel reports for
    // it. A write time would drift past the identity tolerance the moment the
    // daemon had been up a few seconds.
    const startedAt = Date.now() - process.uptime() * 1000;

    new ChildJournal(path).record(1, 'a');

    expect(Math.abs(readRaw().ownerStartedAt - startedAt)).toBeLessThan(50);
  });

  it('drops a group that exited', () => {
    const journal = new ChildJournal(path);
    journal.record(1, 'a');
    journal.record(2, 'b');

    journal.forget(1);

    expect(readRaw().children.map((c) => c.pid)).toEqual([2]);
  });

  it('reports an unwritable journal instead of failing the spawn', () => {
    const warn = vi.fn();
    // A directory where the file should be: the rename cannot succeed.
    const journal = new ChildJournal(dir, { warn });

    expect(() => journal.record(7, '/bin/claude')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('will not be reaped');
  });
});

describe('ChildJournal command groups', () => {
  const group = { pgid: 300, members: [{ pid: 301, startedAt: 9_000 }] };

  it('writes a session’s command groups under its CLI pid, with the run', () => {
    const journal = new ChildJournal(path);
    journal.record(30, 'claude');

    journal.recordCommandGroups(30, 'run-a', [group]);

    expect(readRaw().commandGroups).toEqual([
      { cliPid: 30, runId: 'run-a', groups: [group] },
    ]);
    expect(readRaw().children.map((c) => c.pid)).toEqual([30]);
  });

  it('keeps a CLI’s command groups after the CLI itself is forgotten', () => {
    const journal = new ChildJournal(path);
    journal.record(30, 'claude');
    journal.recordCommandGroups(30, 'run-a', [group]);

    journal.forget(30);

    expect(readRaw().children).toEqual([]);
    expect(readRaw().commandGroups).toEqual([
      { cliPid: 30, runId: 'run-a', groups: [group] },
    ]);
  });

  it('replaces the record, and drops the entry when none are left', () => {
    const journal = new ChildJournal(path);
    const other = { pgid: 400, members: [{ pid: 401, startedAt: 1 }] };
    journal.recordCommandGroups(30, null, [group]);

    journal.recordCommandGroups(30, null, [other]);
    expect(readRaw().commandGroups).toEqual([
      { cliPid: 30, runId: null, groups: [other] },
    ]);

    journal.recordCommandGroups(30, null, []);
    expect(readRaw().commandGroups).toEqual([]);
  });

  it('does not rewrite the file for a record that did not change', () => {
    const journal = new ChildJournal(path);
    journal.recordCommandGroups(30, 'run-a', [group]);
    rmSync(path);

    journal.recordCommandGroups(30, 'run-a', [
      { pgid: 300, members: [{ pid: 301, startedAt: 9_000 }] },
    ]);

    expect(() => readRaw()).toThrow();
  });

  it('forgets a CLI’s command groups', () => {
    const journal = new ChildJournal(path);
    journal.recordCommandGroups(30, 'run-a', [group]);
    journal.recordCommandGroups(31, 'run-b', [
      { pgid: 500, members: [{ pid: 501, startedAt: 2 }] },
    ]);

    journal.forgetCommandGroups(30);

    expect(readRaw().commandGroups?.map((entry) => entry.cliPid)).toEqual([31]);
  });
});

describe('readChildJournal', () => {
  it('round-trips what a previous launch wrote', () => {
    new ChildJournal(path, undefined, () => 55).record(99, '/bin/cursor-agent');

    expect(readChildJournal(path)).toEqual({
      version: 2,
      ownerPid: process.pid,
      ownerStartedAt: expect.any(Number),
      children: [{ pid: 99, startedAt: 55, command: '/bin/cursor-agent' }],
      commandGroups: [],
    });
  });

  it('reads a journal an older daemon wrote, with no command groups', () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        ownerPid: 1,
        ownerStartedAt: 2,
        children: [{ pid: 99, startedAt: 55, command: 'claude' }],
      }),
    );

    expect(readChildJournal(path)).toEqual({
      version: 2,
      ownerPid: 1,
      ownerStartedAt: 2,
      children: [{ pid: 99, startedAt: 55, command: 'claude' }],
      commandGroups: [],
    });
  });

  it('drops a malformed command-group entry on its own, keeping the rest', () => {
    const warn = vi.fn();
    const good = {
      cliPid: 7,
      runId: 'run-1',
      groups: [{ pgid: 70, members: [{ pid: 71, startedAt: 5 }] }],
    };
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        ownerPid: 1,
        ownerStartedAt: 2,
        children: [{ pid: 99, startedAt: 55, command: 'claude' }],
        commandGroups: [good, { cliPid: 8, runId: 3, groups: [] }],
      }),
    );

    const read = readChildJournal(path, { warn });

    expect(read?.children).toEqual([
      { pid: 99, startedAt: 55, command: 'claude' },
    ]);
    expect(read?.commandGroups).toEqual([good]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('1 malformed command-group entries'),
    );
  });

  it('refuses a journal that does not say when its owner started', () => {
    // Without it the owner can only be judged by pid, which is the recycled-
    // pid trap the field exists to close — so such a file is not acted on.
    writeFileSync(
      path,
      JSON.stringify({ version: 2, ownerPid: 1, children: [] }),
    );

    expect(readChildJournal(path)).toBeNull();
  });

  it('is silent about a missing file — a clean previous shutdown', () => {
    const warn = vi.fn();

    expect(readChildJournal(join(dir, 'absent.json'), { warn })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses unparseable JSON, and says so', () => {
    const warn = vi.fn();
    writeFileSync(path, '{not json');

    expect(readChildJournal(path, { warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a well-formed file of the wrong shape', () => {
    const warn = vi.fn();
    // A future version, or a hand-edited file. Reaping from a shape we do not
    // understand would mean SIGKILLing numbers we cannot vouch for.
    writeFileSync(
      path,
      JSON.stringify({ version: 99, ownerPid: 1, children: [] }),
    );

    expect(readChildJournal(path, { warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a file whose entries are not journaled children', () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        ownerPid: 1,
        ownerStartedAt: 1,
        children: [{ pid: 'x' }],
      }),
    );

    expect(readChildJournal(path)).toBeNull();
  });
});

describe('clearChildJournal', () => {
  it('removes the file, and tolerates one that is already gone', () => {
    new ChildJournal(path).record(1, 'a');

    clearChildJournal(path);
    expect(() => clearChildJournal(path)).not.toThrow();

    expect(readChildJournal(path)).toBeNull();
  });
});

describe('trackDetachedChild', () => {
  it('records nothing until a journal is configured', () => {
    // Pins the default-off state: a unit test that spawns a real child must
    // never write into a developer's userData dir.
    expect(currentChildJournal()).toBeNull();

    trackDetachedChild(fakeChild(123), '/bin/claude');

    expect(readChildJournal(path)).toBeNull();
  });

  it('records a spawned child, then erases it when the child exits', () => {
    configureChildJournal(path);
    const child = fakeChild(321);

    trackDetachedChild(child, '/bin/cursor-agent');
    expect(readChildJournal(path)?.children.map((c) => c.pid)).toEqual([321]);

    child.emit('exit');

    expect(readChildJournal(path)?.children).toEqual([]);
  });

  it('ignores a child that never got a pid', () => {
    configureChildJournal(path);

    trackDetachedChild(fakeChild(undefined), '/bin/claude');

    expect(readChildJournal(path)).toBeNull();
  });
});
