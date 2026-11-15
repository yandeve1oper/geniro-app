import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { closeImportedShells } from '../../../utils/imported-shells';
import type { AgentEvent, AgentSessionRecord } from '../../adapter.types';
import {
  carryClaudeSession,
  deleteClaudeSession,
  eachJsonLine,
  findSessionFile,
  listClaudeSessions,
  readClaudeSessionHistory,
} from './claude-sessions.utils';

const roots: string[] = [];

/**
 * The listing's rows alone, with no search.
 *
 * `listClaudeSessions` answers with the rows AND how far a search reached; the
 * cases below are about the rows, so the envelope is unwrapped once here rather
 * than at every assertion. The search's own cases open it deliberately.
 */
async function listSessions(input: {
  profileDir: string;
  cwd: string | null;
  limit: number;
  query?: string | null;
}): Promise<AgentSessionRecord[]> {
  const { sessions } = await listClaudeSessions({
    ...input,
    query: input.query ?? null,
  });
  return sessions;
}

/**
 * A fixed epoch-seconds mark the ordered fixtures are stamped around.
 *
 * The listing sorts newest-first, so any test whose claim depends on the ORDER
 * files are decided in has to state that order rather than inherit it from how
 * fast the machine wrote them.
 */
const TS_BASE = 1_700_000_000;

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

/** A throwaway profile holding `projects/<dir>/<id>.jsonl` files. */
function profile(
  sessions: { dir: string; id: string; lines: unknown[] }[],
): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-sessions-spec-'));
  roots.push(root);
  for (const session of sessions) {
    const dir = join(root, 'projects', session.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${session.id}.jsonl`),
      session.lines.map((line) => JSON.stringify(line)).join('\n'),
    );
  }
  return root;
}

/** The shape the CLI appends for a message the user typed. */
function userLine(cwd: string, text: string): unknown {
  return { type: 'user', cwd, message: { role: 'user', content: text } };
}

/**
 * A message typed in the VS Code / Cursor extension, in the shape it records:
 * each IDE context block a text block of its own, ahead of the user's words.
 */
function ideUserLine(cwd: string, blocks: (string | typeof IMAGE)[]): unknown {
  return {
    type: 'user',
    cwd,
    message: {
      role: 'user',
      content: blocks.map((block) =>
        typeof block === 'string' ? { type: 'text', text: block } : block,
      ),
    },
  };
}

const IMAGE = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
} as const;

const IDE_OPENED_FILE =
  '<ide_opened_file>The user opened the file /w/src/updater.ts in the IDE.</ide_opened_file>';
const IDE_SELECTION =
  '<ide_selection>The user selected the lines 10 to 12 from /w/src/updater.ts:\n' +
  'const feed = readFeed();\n</ide_selection>';

function assistantLine(cwd: string, text: string): unknown {
  return {
    type: 'assistant',
    cwd,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

describe('listClaudeSessions', () => {
  it('finds a folder through a DIFFERENT spelling of the same path', async () => {
    // The bug this pins, measured live: the CLI writes `cwd` as its process saw
    // it (`/private/var/…` on macOS) while the app canonicalizes every folder it
    // holds (`/var/…`) — the same directory through a symlink. A string compare
    // rejected every session in the folder the user was sitting in.
    const real = mkdtempSync(join(tmpdir(), 'claude-real-'));
    roots.push(real);
    const link = `${real}-link`;
    symlinkSync(real, link);
    roots.push(link);

    const root = profile([
      { dir: 'proj', id: 's1', lines: [userLine(real, 'the real spelling')] },
    ]);

    // Asked about the LINK, answered from a file that recorded the target.
    const rows = await listSessions({
      profileDir: root,
      cwd: link,
      limit: 10,
    });
    expect(rows.map((row) => row.id)).toEqual(['s1']);
  });

  it('keeps a folder filter honest — another folder is not offered', async () => {
    const root = profile([
      { dir: 'a', id: 'mine', lines: [userLine('/tmp/mine', 'here')] },
      { dir: 'b', id: 'theirs', lines: [userLine('/tmp/theirs', 'elsewhere')] },
    ]);
    const rows = await listSessions({
      profileDir: root,
      cwd: '/tmp/mine',
      limit: 10,
    });
    expect(rows.map((row) => row.id)).toEqual(['mine']);
  });

  it('titles a slash-command turn with the command, not its XML envelope', async () => {
    // Observed in the author's own profile: the whole turn is envelopes, so
    // showing it raw filled the row with markup and dropping it left the
    // session unnamed. Both are wrong; the command IS what the user typed.
    const root = profile([
      {
        dir: 'proj',
        id: 'slash',
        lines: [
          userLine(
            '/tmp/proj',
            '<command-message>geniro:implement</command-message>' +
              '<command-name>/geniro:implement</command-name>' +
              '<command-args>next milestone</command-args>',
          ),
        ],
      },
    ]);
    const rows = await listSessions({
      profileDir: root,
      cwd: null,
      limit: 10,
    });
    expect(rows[0]?.title).toBe('/geniro:implement next milestone');
  });

  it('does not offer a session nobody said anything in', async () => {
    const root = profile([
      {
        dir: 'proj',
        id: 'empty',
        lines: [
          { type: 'queue-operation', cwd: '/tmp/proj', operation: 'enqueue' },
        ],
      },
      { dir: 'proj', id: 'real', lines: [userLine('/tmp/proj', 'hello')] },
    ]);
    const rows = await listSessions({
      profileDir: root,
      cwd: null,
      limit: 10,
    });
    expect(rows.map((row) => row.id)).toEqual(['real']);
  });

  it('keeps newest-first order across the head-read batches', async () => {
    // Heads are read eight at a time now, so the ordering and the limit both
    // have to survive a boundary rather than falling out of a single sequential
    // walk. Twenty files with distinct mtimes puts two full boundaries inside
    // the answer.
    const root = mkdtempSync(join(tmpdir(), 'claude-sessions-spec-'));
    roots.push(root);
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 20; i += 1) {
      const file = join(dir, `s${i}.jsonl`);
      writeFileSync(file, JSON.stringify(userLine('/tmp/proj', `msg ${i}`)));
      // Newest LAST by index, so a reader that ignored mtime would answer in
      // the opposite order to the one asserted.
      utimesSync(file, new Date(1_000 + i), new Date(1_000 + i));
    }

    const rows = await listSessions({
      profileDir: root,
      cwd: null,
      limit: 12,
    });

    expect(rows.map((row) => row.id)).toEqual([
      's19',
      's18',
      's17',
      's16',
      's15',
      's14',
      's13',
      's12',
      's11',
      's10',
      's9',
      's8',
    ]);
  });

  it('rejects a whole folder from one file, and the rejection outlives a batch boundary', async () => {
    // One file identifies its directory and the rest are skipped, which is what
    // keeps a filtered listing over thousands of sessions to a few hundred
    // small reads. The rejection has to survive the boundary: nine files is one
    // more than a batch holds.
    //
    // The LAST file in the rejected folder carries the wanted cwd, and that is
    // what makes this a pin rather than a description. Without it the expected
    // answer is `['m1']` whether or not any rejection happens at all — every
    // other file in `theirs` names a folder that would be filtered out anyway
    // on its own merits, so the assertion held with the short-circuit deleted
    // wholesale. `t8` can ONLY be excluded by the directory-level rejection,
    // which is the behaviour the title claims.
    //
    // Excluding it is correct, not a loss: the directory name is the cwd with
    // its separators flattened, so one directory genuinely can hold two
    // folders' sessions — and the sibling test below pins that whichever answer
    // this gives, it gives the same one however the boundary falls.
    const root = mkdtempSync(join(tmpdir(), 'claude-sessions-spec-'));
    roots.push(root);
    const theirs = join(root, 'projects', 'theirs');
    mkdirSync(theirs, { recursive: true });
    for (let i = 0; i < 9; i += 1) {
      const path = join(theirs, `t${i}.jsonl`);
      writeFileSync(
        path,
        JSON.stringify(
          userLine(i === 8 ? '/tmp/mine' : '/tmp/theirs', 'elsewhere'),
        ),
      );
      // Stamped rather than left to the clock. The listing decides newest-first,
      // so what this test pins — a folder rejected by an EARLIER file, with the
      // wanted `t8` behind the rejection — only holds if `t8` sorts last. Nine
      // writes normally land inside one millisecond and the stable sort then
      // preserves this loop's order, but on a loaded machine they straddle a
      // tick, `t8` becomes the newest of the nine and is decided BEFORE anything
      // has rejected the directory: measured as an intermittent
      // `['m1','t8']` under the full suite, passing alone every time.
      utimesSync(path, TS_BASE - i, TS_BASE - i);
    }
    const mine = join(root, 'projects', 'mine');
    mkdirSync(mine, { recursive: true });
    const minePath = join(mine, 'm1.jsonl');
    writeFileSync(minePath, JSON.stringify(userLine('/tmp/mine', 'here')));
    // Newest of all, so the one row that must survive is decided first and the
    // assertion cannot pass by the rejection merely reaching it in time.
    utimesSync(minePath, TS_BASE + 1, TS_BASE + 1);

    const rows = await listSessions({
      profileDir: root,
      cwd: '/tmp/mine',
      limit: 10,
    });

    expect(rows.map((row) => row.id)).toEqual(['m1']);
  });

  it('answers one folder the same way however many neighbours precede it', async () => {
    // A project directory CAN hold two folders' sessions. The directory name is
    // the cwd with its separators flattened to `-`, which this module's own doc
    // block records as lossy — `/a/b-c` and `/a-b/c` collide onto one name — so
    // the "one directory, one folder" premise the rejection short-circuit rests
    // on is not something the store guarantees.
    //
    // Where the short-circuit is consulted is now what decides the answer. It
    // is read once per BATCH, before any of the eight heads is decided over, so
    // a directory rejected by its first file still spares only the files that
    // fall into a LATER batch. The same store therefore answers the same
    // question two different ways depending on how many unrelated sessions
    // happen to sort ahead of the one being asked about — a listing whose
    // contents turn on other files' mtimes.
    const listing = async (neighbours: number): Promise<string[]> => {
      const root = mkdtempSync(join(tmpdir(), 'claude-sessions-spec-'));
      roots.push(root);
      const shared = join(root, 'projects', 'a-b-c');
      const own = join(root, 'projects', 'mine');
      mkdirSync(shared, { recursive: true });
      mkdirSync(own, { recursive: true });
      // Newest first, one second apart, so the global sort order is stated by
      // the fixture rather than left to the filesystem.
      let at = 1_700_000_000_000;
      const write = (path: string, cwd: string, text: string): void => {
        writeFileSync(path, JSON.stringify(userLine(cwd, text)));
        utimesSync(path, new Date(at), new Date(at));
        at -= 1_000;
      };
      for (let i = 0; i < neighbours; i += 1) {
        write(join(shared, `o${i}.jsonl`), '/tmp/other', 'the other folder');
      }
      // Same collided directory, the user's OWN folder.
      write(join(shared, 'collided.jsonl'), '/tmp/mine', 'mine, in there too');
      // A second directory the collision does not touch, so neither answer can
      // be empty and the assertion below has something to be wrong about.
      write(join(own, 'm1.jsonl'), '/tmp/mine', 'mine, on its own');
      const rows = await listSessions({
        profileDir: root,
        cwd: '/tmp/mine',
        limit: 10,
      });
      return rows.map((row) => row.id);
    };

    // One neighbour puts `collided` in the first batch; eight push it past the
    // boundary. Nothing else about the two profiles differs.
    const sparse = await listing(1);
    const crowded = await listing(8);

    expect(sparse).toContain('m1');
    expect(crowded).toEqual(sparse);
  });

  it('does not offer a session whose first words are past the head budget', async () => {
    // Both this and the guard below are LIVE on a real profile — 7 of 563
    // sessions have their first user line past the 256KB budget — and neither
    // was reachable from the spec's five listing cases. The budget exists
    // because a session's opening routinely carries tens of kilobytes of hook
    // output and system-reminder blocks before anyone speaks.
    const root = mkdtempSync(join(tmpdir(), 'claude-sessions-spec-'));
    roots.push(root);
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    const filler = JSON.stringify({
      type: 'system',
      cwd: '/tmp/proj',
      text: 'x'.repeat(4_000),
    });
    const lines: string[] = [];
    // Past CLAUDE_SESSION_HEAD_BUDGET_BYTES (256KB) before the user speaks.
    for (let i = 0; i < 80; i += 1) {
      lines.push(filler);
    }
    lines.push(JSON.stringify(userLine('/tmp/proj', 'said far too late')));
    writeFileSync(join(dir, 'late.jsonl'), lines.join('\n'));
    writeFileSync(
      join(dir, 'prompt.jsonl'),
      JSON.stringify(userLine('/tmp/proj', 'said at once')),
    );

    const rows = await listSessions({
      profileDir: root,
      cwd: null,
      limit: 10,
    });

    expect(rows.map((row) => row.id)).toEqual(['prompt']);
  });

  it('leaves out the note geniro appended to a prompt it sent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-sessions-spec-'));
    roots.push(root);
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'noted.jsonl'),
      JSON.stringify(
        userLine(
          '/tmp/proj',
          'fix the build\n\n<geniro-note>\nThat stopped 1 background command\n</geniro-note>',
        ),
      ),
    );

    const rows = await listSessions({ profileDir: root, cwd: null, limit: 10 });

    expect(rows.map((row) => row.title)).toEqual(['fix the build']);
  });

  it('does not take a SYNTHETIC or REPLAYED line as something the user said', async () => {
    // The CLI injects a synthetic line after a compaction and re-appends
    // replayed ones with `isReplay`. Titling a row with either puts words in
    // the user's mouth — and the same reader feeds `user_message`, so a
    // regression replays injected text as the user's own in the transcript.
    const root = profile([
      {
        dir: 'proj',
        id: 'synthetic',
        lines: [
          {
            ...(userLine('/tmp/proj', 'injected') as object),
            isSynthetic: true,
          },
        ],
      },
      {
        dir: 'proj',
        id: 'replayed',
        lines: [
          { ...(userLine('/tmp/proj', 'replayed') as object), isReplay: true },
        ],
      },
      { dir: 'proj', id: 'real', lines: [userLine('/tmp/proj', 'typed')] },
    ]);

    const rows = await listSessions({
      profileDir: root,
      cwd: null,
      limit: 10,
    });

    expect(rows.map((row) => row.id)).toEqual(['real']);
  });

  it("titles a message sent from the IDE extension with the user's words, not the IDE's", async () => {
    const root = profile([
      {
        dir: 'proj',
        id: 'ide',
        lines: [ideUserLine('/w', [IDE_OPENED_FILE, IMAGE, 'see these'])],
      },
    ]);

    const rows = await listSessions({ profileDir: root, cwd: null, limit: 10 });

    expect(rows[0]?.title).toBe('see these');
  });

  it('keeps a selection that contains its own closing tag out of the title', async () => {
    // A selection is code copied verbatim, so it can hold `</ide_selection>`.
    const selection =
      '<ide_selection>The user selected the lines 1 to 2 from /w/a.spec.ts:\n' +
      "const close = '</ide_selection>';\n</ide_selection>";
    const root = profile([
      {
        dir: 'proj',
        id: 'ide',
        lines: [ideUserLine('/w', [selection, 'why does this fail?'])],
      },
    ]);

    const rows = await listSessions({ profileDir: root, cwd: null, limit: 10 });

    expect(rows[0]?.title).toBe('why does this fail?');
  });

  it('does not title a session with the IDE context of a message that is only a picture', async () => {
    const root = profile([
      {
        dir: 'proj',
        id: 'ide',
        lines: [
          ideUserLine('/w', [IDE_OPENED_FILE, IMAGE]),
          ideUserLine('/w', [IDE_OPENED_FILE, IMAGE, 'see these']),
        ],
      },
    ]);

    const rows = await listSessions({ profileDir: root, cwd: null, limit: 10 });

    expect(rows[0]?.title).toBe('see these');
  });

  it('titles a session with a message the user typed as nothing but an IDE tag', async () => {
    const typed = '<ide_selection>x</ide_selection>';
    const root = profile([
      { dir: 'proj', id: 'typed', lines: [userLine('/w', typed)] },
    ]);

    const rows = await listSessions({ profileDir: root, cwd: null, limit: 10 });

    expect(rows[0]?.title).toBe(typed);
  });

  it('answers an absent profile with an empty list rather than throwing', async () => {
    await expect(
      listSessions({
        profileDir: join(tmpdir(), 'claude-sessions-spec-nope'),
        cwd: null,
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });
});

describe('readClaudeSessionHistory', () => {
  it('keeps a character that STRADDLES a 64KB read boundary intact', async () => {
    // The reader pulls 64KB at a time, and a multi-byte character lands on that
    // boundary as arithmetic rather than bad luck: a session of the size this
    // file is built for (11MB) crosses ~170 of them. Decoded per chunk, the
    // straddling character becomes U+FFFD at both ends of the seam — and the
    // line still PARSES, because JSON's own syntax is all ASCII, so the
    // corruption reaches the transcript with nothing anywhere reporting it.
    //
    // The boundary is placed deliberately, not hoped for: everything ahead of
    // the text is ASCII, so its character offset is its byte offset, and the
    // padding is sized to start the first 2-byte character on the last byte of
    // chunk one.
    const CHUNK = 64 * 1024;
    const cwd = '/tmp/proj';
    const head = JSON.stringify(userLine(cwd, '')).indexOf('""}}') + 1;
    const text = `${'a'.repeat(CHUNK - head - 1)}${'я'.repeat(64)}`;
    const root = profile([
      { dir: 'proj', id: 's1', lines: [userLine(cwd, text)] },
    ]);

    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 100,
    });

    expect(history?.events).toEqual([{ type: 'user_message', text }]);
  });

  it('carries BOTH halves of the conversation', async () => {
    // The user's own words have no `AgentEvent` in a live turn — the daemon
    // wrote them — so without the `user_message` arm an imported thread is a
    // column of answers to questions nobody can see.
    const root = profile([
      {
        dir: 'proj',
        id: 's1',
        lines: [
          userLine('/tmp/proj', 'what is 2+2?'),
          assistantLine('/tmp/proj', '4'),
        ],
      },
    ]);
    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 100,
    });
    expect(history?.events).toEqual([
      { type: 'user_message', text: 'what is 2+2?' },
      { type: 'text', text: '4' },
    ]);
    expect(history?.droppedBefore).toBe(0);
  });

  it("shows only the user's own words for a message sent from the IDE extension", async () => {
    const root = profile([
      {
        dir: 'proj',
        id: 's1',
        lines: [
          ideUserLine('/w', [IDE_OPENED_FILE, IDE_SELECTION, 'explain this']),
        ],
      },
    ]);

    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 100,
    });

    expect(history?.events).toEqual([
      { type: 'user_message', text: 'explain this' },
    ]);
  });

  it('keeps the words of a user who TYPED such a tag in prose', async () => {
    const typed = 'why does <ide_selection>x</ide_selection> show as a title?';
    const root = profile([
      { dir: 'proj', id: 's1', lines: [ideUserLine('/w', [typed])] },
    ]);

    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 100,
    });

    expect(history?.events).toEqual([{ type: 'user_message', text: typed }]);
  });

  it('imports no IDE context for a message that is only a picture', async () => {
    const root = profile([
      {
        dir: 'proj',
        id: 's1',
        lines: [
          ideUserLine('/w', [IDE_OPENED_FILE, IDE_SELECTION, IMAGE]),
          ideUserLine('/w', [IDE_OPENED_FILE, IMAGE, 'explain this']),
        ],
      },
    ]);

    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 100,
    });

    expect(history?.events).toEqual([
      { type: 'user_message', text: 'explain this' },
    ]);
  });

  it('keeps a message the user typed as nothing but such a tag', async () => {
    const typed = '<ide_selection>x</ide_selection>';
    const root = profile([
      {
        dir: 'proj',
        id: 's1',
        lines: [
          userLine('/w', typed),
          ideUserLine('/w', [typed]),
          ideUserLine('/w', [IDE_OPENED_FILE, typed]),
        ],
      },
    ]);

    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 100,
    });

    expect(history?.events).toEqual([
      { type: 'user_message', text: typed },
      { type: 'user_message', text: typed },
      { type: 'user_message', text: typed },
    ]);
  });

  it("leaves a sub-agent's own conversation out of the main thread", async () => {
    const root = profile([
      {
        dir: 'proj',
        id: 's1',
        lines: [
          userLine('/tmp/proj', 'delegate this'),
          {
            ...(assistantLine('/tmp/proj', 'sidechain chatter') as object),
            isSidechain: true,
          },
          assistantLine('/tmp/proj', 'done'),
        ],
      },
    ]);
    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 100,
    });
    expect(history?.events).toEqual([
      { type: 'user_message', text: 'delegate this' },
      { type: 'text', text: 'done' },
    ]);
  });

  it('keeps the NEWEST events when the limit bites, and says how many it cut', async () => {
    const root = profile([
      {
        dir: 'proj',
        id: 's1',
        lines: [
          assistantLine('/tmp/proj', 'one'),
          assistantLine('/tmp/proj', 'two'),
          assistantLine('/tmp/proj', 'three'),
        ],
      },
    ]);
    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 2,
    });
    expect(history?.events).toEqual([
      { type: 'text', text: 'two' },
      { type: 'text', text: 'three' },
    ]);
    expect(history?.droppedBefore).toBe(1);
  });

  it('survives a half-written line instead of losing the transcript', async () => {
    // A session the CLI was appending to when the machine slept ends mid-JSON.
    const root = mkdtempSync(join(tmpdir(), 'claude-sessions-spec-'));
    roots.push(root);
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 's1.jsonl'),
      `${JSON.stringify(assistantLine('/tmp/proj', 'kept'))}\n{"type":"assis`,
    );
    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 100,
    });
    expect(history?.events).toEqual([{ type: 'text', text: 'kept' }]);
  });

  it('answers null for a session this profile does not hold', async () => {
    const root = profile([
      { dir: 'proj', id: 's1', lines: [userLine('/tmp/proj', 'hi')] },
    ]);
    await expect(
      readClaudeSessionHistory({
        profileDir: root,
        sessionId: 'not-here',
        limit: 100,
      }),
    ).resolves.toBeNull();
  });

  it('refuses an id that would climb out of the profile', async () => {
    // The id reaches a PATH now — the lookup joins it rather than matching it
    // against a scan — and it arrives over HTTP. A separator in it is refused
    // rather than resolved, so `../../../etc/passwd` cannot name a file the
    // profile does not hold.
    const root = profile([
      { dir: 'proj', id: 's1', lines: [userLine('/tmp/proj', 'hi')] },
    ]);
    const outside = join(root, 'projects', 'escaped');
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, 's1.jsonl'),
      JSON.stringify(assistantLine('/tmp/proj', 'should stay unreachable')),
    );

    await expect(
      readClaudeSessionHistory({
        profileDir: root,
        sessionId: '../escaped/s1',
        limit: 100,
      }),
    ).resolves.toBeNull();
  });

  it('finds a session in whichever project directory holds it', async () => {
    // The lookup is now one `stat` per directory rather than a full re-scan of
    // the profile, so it has to try every directory and not just the first.
    const root = profile([
      { dir: 'a', id: 'first', lines: [userLine('/tmp/a', 'one')] },
      { dir: 'b', id: 'second', lines: [assistantLine('/tmp/b', 'two')] },
    ]);

    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 'second',
      limit: 100,
    });

    expect(history?.events).toEqual([{ type: 'text', text: 'two' }]);
  });
});

describe('searching what was SAID in a conversation', () => {
  // REPORTED as "WE need to improve search bu threads - by content as well".
  // A row's title is the conversation's OPENING PROMPT, so a picker that
  // filtered on titles could only find a thread by how it was started — and
  // nobody remembers that. Every case below asserts on the ROWS, never on a
  // count of files opened, because what the user gets is the list.
  const talkedAboutAsar = (): string =>
    profile([
      {
        dir: 'proj',
        id: 'found',
        lines: [
          userLine('/w', 'help me with the updater'),
          assistantLine('/w', 'The app.asar archive is never deleted.'),
        ],
      },
      {
        dir: 'proj',
        id: 'other',
        lines: [
          userLine('/w', 'help me with the updater'),
          assistantLine('/w', 'The release feed is fine.'),
        ],
      },
    ]);

  it('finds a thread by a line from the MIDDLE of it', async () => {
    const rows = await listSessions({
      profileDir: talkedAboutAsar(),
      cwd: null,
      limit: 10,
      query: 'asar',
    });

    // Both sessions open with the same prompt, so a title search cannot tell
    // them apart at all — which is the defect, stated as a fixture.
    expect(rows.map((row) => row.id)).toEqual(['found']);
  });

  it('quotes the line that answered, since the title does not', async () => {
    const rows = await listSessions({
      profileDir: talkedAboutAsar(),
      cwd: null,
      limit: 10,
      query: 'asar',
    });

    expect(rows[0]?.snippet).toContain('app.asar archive');
    // The row still shows its own title — the quote is additional, not a
    // replacement, or a search result would stop naming the conversation.
    expect(rows[0]?.title).toBe('help me with the updater');
  });

  it('quotes NOTHING when the title or the folder already explains the row', async () => {
    // Otherwise every row of a folder search carries a redundant quote of a
    // line the user can already see one line above.
    const rows = await listSessions({
      profileDir: talkedAboutAsar(),
      cwd: null,
      limit: 10,
      query: 'updater',
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.snippet)).toEqual([null, null]);
  });

  it('requires EVERY term, across the row and the conversation together', async () => {
    // How somebody actually remembers a thread: one fragment from the project,
    // one from what was said. Neither half alone identifies it, and the two
    // live in different places — so a search that could only match one source
    // at a time would find nothing.
    const root = profile([
      {
        dir: 'a',
        id: 'mine',
        lines: [
          userLine('/work/geniro', 'the updater'),
          assistantLine(
            '/work/geniro',
            'The app.asar archive is never deleted.',
          ),
        ],
      },
      {
        dir: 'b',
        id: 'theirs',
        lines: [
          userLine('/work/other', 'the updater'),
          assistantLine(
            '/work/other',
            'The app.asar archive is never deleted.',
          ),
        ],
      },
    ]);

    const rows = await listSessions({
      profileDir: root,
      cwd: null,
      limit: 10,
      query: 'asar geniro',
    });

    expect(rows.map((row) => row.id)).toEqual(['mine']);
  });

  it("does not match the CLI's own injected blocks", async () => {
    // Found by searching the author's real profile: `asar` matched inside
    // `toolu_01YAsarpjpgHChBKeKgbDV`, a tool-use id inside a
    // `<task-notification>` envelope — a hit on a random identifier, quoted
    // back at the user as though somebody had said it.
    const root = profile([
      {
        dir: 'proj',
        id: 'noise',
        lines: [
          userLine('/w', 'hello'),
          userLine(
            '/w',
            '<task-notification><tool-use-id>toolu_01YAsarpjpgH</tool-use-id></task-notification>',
          ),
        ],
      },
    ]);

    const rows = await listSessions({
      profileDir: root,
      cwd: null,
      limit: 10,
      query: 'asar',
    });

    expect(rows).toEqual([]);
  });

  it('does not match the IDE context the extension sends with a message', async () => {
    const root = profile([
      {
        dir: 'proj',
        id: 'ide',
        lines: [
          ideUserLine('/w', [IDE_OPENED_FILE, 'explain this']),
          assistantLine('/w', 'sure'),
        ],
      },
    ]);
    const search = async (query: string): Promise<AgentSessionRecord[]> =>
      listSessions({ profileDir: root, cwd: null, limit: 10, query });

    expect(await search('updater.ts')).toEqual([]);
    expect((await search('explain')).map((row) => row.id)).toEqual(['ide']);
  });

  it('says nothing was truncated when the cap was never reached', async () => {
    // A bounded search that stays silent is indistinguishable from one that
    // read every conversation there was.
    const small = await listClaudeSessions({
      profileDir: talkedAboutAsar(),
      cwd: null,
      limit: 10,
      query: 'asar',
    });

    expect(small.searchTruncated).toBe(false);
  });

  it('says the cap DID bite once the candidate count reaches it', async () => {
    // The real cap is 600 files, and arranging that many fixtures just to
    // exercise the true branch would be its own liability. `searchFileLimit`
    // exists for exactly this: the same two-session profile, with the cap
    // lowered until it is the thing that stops the scan.
    const truncated = await listClaudeSessions({
      profileDir: talkedAboutAsar(),
      cwd: null,
      limit: 10,
      query: 'asar',
      searchFileLimit: 1,
    });

    expect(truncated.searchTruncated).toBe(true);
  });

  it('leaves an unsearched listing exactly as it was', async () => {
    const rows = await listSessions({
      profileDir: talkedAboutAsar(),
      cwd: null,
      limit: 10,
    });

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.snippet === null)).toBe(true);
  });

  it('quotes the part of a long line the search actually matched', async () => {
    // The row is 160 characters wide and a paragraph is not. Windowed on the
    // term rather than truncated from the start: measured against the author's
    // own profile, `asar` matched 400 characters into an answer, so the quote
    // showed a sentence with no visible connection to what had been typed.
    const padding = 'x'.repeat(400);
    const root = profile([
      {
        dir: 'proj',
        id: 'buried',
        lines: [
          userLine('/w', 'hello'),
          assistantLine('/w', `${padding} the app.asar archive ${padding}`),
        ],
      },
    ]);

    const rows = await listSessions({
      profileDir: root,
      cwd: null,
      limit: 10,
      query: 'asar',
    });

    expect(rows[0]?.snippet).toContain('asar');
    expect(rows[0]?.snippet?.length).toBeLessThanOrEqual(162);
  });
});

describe('carryClaudeSession', () => {
  const CWD = '/private/tmp/carry';

  it('puts the conversation where the OTHER profile will look for it', async () => {
    // The mechanism behind switching an open chat to another account, and it
    // is a measurement rather than a hope: probed on claude 2.1.237 across two
    // real profiles, `--resume <id>` under a profile that does not hold the
    // file answers "No conversation found with session ID: …", and answers the
    // conversation's own codeword the moment the `.jsonl` is copied in.
    //
    // What this pins is the PLACEMENT, which is the half a copy can get wrong
    // silently: the project directory name is the cwd with its separators
    // flattened, which this module's own doc block records as lossy and
    // undocumented — so the target must be the SOURCE's directory name, never
    // one composed here. A copy one directory off is a file the CLI never
    // opens, and the switch then looks exactly like a CLI that forgot.
    const from = profile([
      {
        dir: '-private-tmp-carry',
        id: 'aaaaaaaa-1111-2222-3333-444444444444',
        lines: [userLine(CWD, 'the codeword is PLUM')],
      },
    ]);
    const to = profile([]);

    const result = await carryClaudeSession({
      sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
      fromProfileDir: from,
      toProfileDir: to,
    });

    expect(result).toEqual({ carried: true });
    const landed = join(
      to,
      'projects',
      '-private-tmp-carry',
      'aaaaaaaa-1111-2222-3333-444444444444.jsonl',
    );
    expect(readFileSync(landed, 'utf8')).toContain('the codeword is PLUM');
    // A COPY: the account the user switched AWAY from keeps the conversation
    // it genuinely held, which is what they see in that account's own `claude`.
    expect(
      readFileSync(
        join(
          from,
          'projects',
          '-private-tmp-carry',
          'aaaaaaaa-1111-2222-3333-444444444444.jsonl',
        ),
        'utf8',
      ),
    ).toContain('the codeword is PLUM');
  });

  it('leaves a conversation the target ALREADY holds exactly as it is', async () => {
    // Switching back and forth between two accounts reaches this, and so does
    // a retry. The id is the CLI's own, so a file of that name in the target is
    // the same thread — carried once and appended to since. Overwriting would
    // replace those later turns with an older prefix of themselves, which is a
    // silent loss of the user's own conversation, so the longer copy is kept
    // and that reads as success.
    const id = 'bbbbbbbb-1111-2222-3333-444444444444';
    const from = profile([
      { dir: '-private-tmp-carry', id, lines: [userLine(CWD, 'first turn')] },
    ]);
    const to = profile([
      {
        dir: '-private-tmp-carry',
        id,
        lines: [userLine(CWD, 'first turn'), userLine(CWD, 'and a later one')],
      },
    ]);

    expect(
      await carryClaudeSession({
        sessionId: id,
        fromProfileDir: from,
        toProfileDir: to,
      }),
    ).toEqual({ carried: true });
    expect(
      readFileSync(
        join(to, 'projects', '-private-tmp-carry', `${id}.jsonl`),
        'utf8',
      ),
    ).toContain('and a later one');
  });

  it('A→B→A brings back the turns made on B, with the sidecar folder', async () => {
    // The target still holds the OLD copy from before the move away. Keeping
    // it resumed A without every turn made on B while the move reported
    // success.
    const id = 'dddddddd-1111-2222-3333-444444444444';
    const dir = '-private-tmp-carry';
    const a = profile([{ dir, id, lines: [userLine(CWD, 'turn on A')] }]);
    const b = profile([]);
    await carryClaudeSession({
      sessionId: id,
      fromProfileDir: a,
      toProfileDir: b,
    });
    writeFileSync(
      join(b, 'projects', dir, `${id}.jsonl`),
      [userLine(CWD, 'turn on A'), userLine(CWD, 'turn on B')]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    // A sub-agent transcript the turn on B wrote.
    mkdirSync(join(b, 'projects', dir, id, 'subagents'), { recursive: true });
    writeFileSync(
      join(b, 'projects', dir, id, 'subagents', 'agent-1.jsonl'),
      'sub',
    );

    expect(
      await carryClaudeSession({
        sessionId: id,
        fromProfileDir: b,
        toProfileDir: a,
      }),
    ).toEqual({ carried: true });
    expect(
      readFileSync(join(a, 'projects', dir, `${id}.jsonl`), 'utf8'),
    ).toContain('turn on B');
    expect(
      readFileSync(
        join(a, 'projects', dir, id, 'subagents', 'agent-1.jsonl'),
        'utf8',
      ),
    ).toBe('sub');
  });

  it('refuses, and overwrites nothing, when the two copies have diverged', async () => {
    const id = 'ffffffff-1111-2222-3333-444444444444';
    const dir = '-private-tmp-carry';
    const from = profile([
      { dir, id, lines: [userLine(CWD, 'shared'), userLine(CWD, 'from side')] },
    ]);
    const to = profile([
      { dir, id, lines: [userLine(CWD, 'shared'), userLine(CWD, 'to side')] },
    ]);

    const result = await carryClaudeSession({
      sessionId: id,
      fromProfileDir: from,
      toProfileDir: to,
    });

    expect(result.carried).toBe(false);
    expect(result.carried === false ? result.reason : '').toContain(
      'different continuations',
    );
    expect(
      readFileSync(join(to, 'projects', dir, `${id}.jsonl`), 'utf8'),
    ).toContain('to side');
  });

  it('leaves the file alone when both profiles share ONE projects folder through a symlink', async () => {
    // The source and the target are then the same file, and copying it onto
    // itself (or truncating it first) would destroy the conversation.
    const id = 'eeeeeeee-1111-2222-3333-444444444444';
    const dir = '-private-tmp-carry';
    const main = profile([{ dir, id, lines: [userLine(CWD, 'shared turn')] }]);
    mkdirSync(join(main, 'projects', dir, id), { recursive: true });
    writeFileSync(join(main, 'projects', dir, id, 'tool-result.txt'), 'kept');
    const alt = profile([]);
    rmSync(join(alt, 'projects'), { recursive: true, force: true });
    symlinkSync(join(main, 'projects'), join(alt, 'projects'));
    const before = readFileSync(
      join(main, 'projects', dir, `${id}.jsonl`),
      'utf8',
    );

    for (const [from, to] of [
      [main, alt],
      [alt, main],
    ] as const) {
      expect(
        await carryClaudeSession({
          sessionId: id,
          fromProfileDir: from,
          toProfileDir: to,
        }),
      ).toEqual({ carried: true });
    }
    expect(
      readFileSync(join(main, 'projects', dir, `${id}.jsonl`), 'utf8'),
    ).toBe(before);
    expect(
      readFileSync(join(main, 'projects', dir, id, 'tool-result.txt'), 'utf8'),
    ).toBe('kept');
  });

  it('says so when the old profile no longer holds the conversation', async () => {
    // A refusal is DATA here and never a thrown error: the switch itself is
    // still legitimate, and this sentence is what the transcript prints so the
    // user knows the agent is starting fresh rather than silently forgetting
    // the thread.
    const result = await carryClaudeSession({
      sessionId: 'cccccccc-1111-2222-3333-444444444444',
      fromProfileDir: profile([]),
      toProfileDir: profile([]),
    });

    expect(result.carried).toBe(false);
    expect(result.carried === false ? result.reason : '').toContain(
      'no longer holds this conversation',
    );
  });

  it('refuses an id that is not one, rather than joining it into a path', async () => {
    // The id reaches here from geniro's own `node_state` row, so this is not a
    // guard against user input — it is a guard against a path segment being
    // built from a value whose shape nothing downstream re-checks, in somebody
    // else's directory. `findSessionFile` owns the check; this pins that the
    // carry goes through it rather than around it.
    const result = await carryClaudeSession({
      sessionId: '../../escape',
      fromProfileDir: profile([
        {
          dir: '-private-tmp-carry',
          id: 'dddddddd-1111-2222-3333-444444444444',
          lines: [userLine(CWD, 'hi')],
        },
      ]),
      toProfileDir: profile([]),
    });

    expect(result.carried).toBe(false);
  });
});

describe('deleteClaudeSession', () => {
  const RUN_CREATED = new Date('2026-10-01T12:00:00.000Z');
  /** A line the CLI stamps, as every line of a real transcript is. */
  const stamped = (timestamp: string): unknown => ({
    ...(userLine('/work', 'hello') as object),
    timestamp,
  });
  /** A profile holding one conversation, with a sub-agent folder beside it. */
  const withSession = (lines: unknown[]): { root: string; file: string } => {
    const root = profile([{ dir: '-work', id: 'sess-1', lines }]);
    const sideDir = join(root, 'projects', '-work', 'sess-1', 'subagents');
    mkdirSync(sideDir, { recursive: true });
    writeFileSync(join(sideDir, 'agent-a.jsonl'), '{}');
    return { root, file: join(root, 'projects', '-work', 'sess-1.jsonl') };
  };

  it('deletes a conversation this chat began, with its sub-agent folder', async () => {
    const { root, file } = withSession([
      // Out of order, as the CLI writes them: the EARLIEST is what dates it.
      stamped('2026-10-01T12:00:09.000Z'),
      stamped('2026-10-01T12:00:01.000Z'),
    ]);

    const result = await deleteClaudeSession({
      profileDir: root,
      sessionId: 'sess-1',
      notBefore: RUN_CREATED,
    });

    expect(result).toEqual({ deleted: true });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(root, 'projects', '-work', 'sess-1'))).toBe(false);
  });

  it('keeps a conversation that began before the chat — one imported from the terminal', async () => {
    const { root, file } = withSession([
      stamped('2026-10-01T12:00:05.000Z'),
      // One line earlier than the run is enough: the file was not this chat's.
      stamped('2026-09-30T08:00:00.000Z'),
    ]);

    const result = await deleteClaudeSession({
      profileDir: root,
      sessionId: 'sess-1',
      notBefore: RUN_CREATED,
    });

    expect(result.deleted).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(root, 'projects', '-work', 'sess-1'))).toBe(true);
  });

  it('keeps a conversation none of whose lines can be dated', async () => {
    const { root, file } = withSession([userLine('/work', 'no stamp')]);

    const result = await deleteClaudeSession({
      profileDir: root,
      sessionId: 'sess-1',
      notBefore: RUN_CREATED,
    });

    expect(result.deleted).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it('answers a refusal for a conversation the profile does not hold', async () => {
    const { root } = withSession([stamped('2026-10-01T12:00:01.000Z')]);

    await expect(
      deleteClaudeSession({
        profileDir: root,
        sessionId: 'sess-other',
        notBefore: RUN_CREATED,
      }),
    ).resolves.toMatchObject({ deleted: false });
  });

  it('refuses an id carrying a path separator, deleting nothing', async () => {
    const { root, file } = withSession([stamped('2026-10-01T12:00:01.000Z')]);

    const result = await deleteClaudeSession({
      profileDir: root,
      sessionId: '../-work/sess-1',
      notBefore: RUN_CREATED,
    });

    expect(result.deleted).toBe(false);
    expect(existsSync(file)).toBe(true);
  });
});

describe('readClaudeSessionHistory — background commands', () => {
  // The shapes below are the CLI's own, copied from real session files
  // (2.1.292): a launch's result line carries a structured `toolUseResult`
  // naming the unit. The session file holds none of the `system/task_*`
  // frames a live turn reads.
  const CWD = '/tmp/proj';

  function toolUseLine(id: string, name: string, input: unknown): unknown {
    return {
      type: 'assistant',
      cwd: CWD,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
      },
    };
  }

  function toolResultLine(
    id: string,
    text: string,
    toolUseResult: unknown,
  ): unknown {
    return {
      type: 'user',
      cwd: CWD,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: text }],
      },
      toolUseResult,
    };
  }

  function bashLaunch(id: string, workId: string, command: string): unknown[] {
    return [
      toolUseLine(id, 'Bash', { command, run_in_background: true }),
      toolResultLine(
        id,
        `Command running in background with ID: ${workId}. Output is being written to: /tmp/${workId}.output`,
        {
          stdout: '',
          stderr: '',
          interrupted: false,
          backgroundTaskId: workId,
        },
      ),
    ];
  }

  async function read(lines: unknown[]) {
    const root = profile([{ dir: 'proj', id: 's1', lines }]);
    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 100,
    });
    return history?.events ?? [];
  }

  const shellEvents = (events: { type: string }[]) =>
    events.filter((event) => event.type === 'shell_open');

  const callIds = (events: AgentEvent[]): string[] =>
    events.flatMap((event) => (event.type === 'tool_call' ? [event.id] : []));

  it('marks a detached launch OPEN, right after the reply that detached it', async () => {
    const events = await read(bashLaunch('toolu_A', 'bxyz', 'pnpm dev'));

    const types = events.map((event) => event.type);
    expect(types.indexOf('shell_open')).toBe(types.indexOf('tool_result') + 1);
    expect(shellEvents(events)).toEqual([
      { type: 'shell_open', toolCallId: 'toolu_A', workId: 'bxyz' },
    ]);
  });

  it("does not count a command's open against the history cap", async () => {
    // A session that backgrounded many commands would otherwise lose that many
    // of its oldest VISIBLE rows to bookkeeping about calls already counted.
    const root = profile([
      {
        dir: 'proj',
        id: 's1',
        lines: bashLaunch('toolu_A', 'bxyz', 'pnpm dev'),
      },
    ]);
    // Two conversation events — the call and its result — under a cap of two.
    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 2,
    });

    expect(history?.droppedBefore).toBe(0);
    expect(history?.events.map((event) => event.type)).toEqual([
      'tool_call',
      'tool_result',
      'shell_open',
    ]);
  });

  it("trims a command's open with its call without counting it as dropped", async () => {
    // The cap falls right after the call's result, so the open is the first
    // row left behind the cut.
    const root = profile([
      {
        dir: 'proj',
        id: 's1',
        lines: [
          ...bashLaunch('toolu_A', 'bxyz', 'pnpm dev'),
          assistantLine(CWD, 'last'),
          assistantLine(CWD, 'end'),
        ],
      },
    ]);
    const whole = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 100,
    });
    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 2,
    });

    expect(shellEvents(whole?.events ?? [])).toEqual([
      { type: 'shell_open', toolCallId: 'toolu_A', workId: 'bxyz' },
    ]);
    expect(history?.events).toEqual([
      { type: 'text', text: 'last' },
      { type: 'text', text: 'end' },
    ]);
    expect(closeImportedShells(history?.events ?? [])).toEqual(history?.events);
    // The call and its result, not the open.
    expect(history?.droppedBefore).toBe(2);
  });

  it("trims a command's open with its call when the cut leaves the call's result", async () => {
    const root = profile([
      {
        dir: 'proj',
        id: 's1',
        lines: [
          ...bashLaunch('toolu_A', 'bA', 'pnpm dev'),
          ...bashLaunch('toolu_B', 'bB', 'pnpm test --watch'),
        ],
      },
    ]);
    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 3,
    });
    const events = history?.events ?? [];

    expect(callIds(events)).toEqual(['toolu_B']);
    expect(closeImportedShells(events).slice(events.length)).toEqual([
      { type: 'shell_info', toolCallId: 'toolu_B', workId: 'bB' },
    ]);
    expect(shellEvents(events)).toEqual([
      { type: 'shell_open', toolCallId: 'toolu_B', workId: 'bB' },
    ]);
    expect(history?.droppedBefore).toBe(1);
  });

  it('holds no open for a call the cap cut before its result arrived', async () => {
    // Conversation rows stay ahead of the open, so it never reaches the head.
    const [launch, launched] = bashLaunch('toolu_A', 'bA', 'pnpm dev');
    const root = profile([
      {
        dir: 'proj',
        id: 's1',
        lines: [
          launch,
          toolUseLine('toolu_R1', 'Read', { file_path: '/w/a.ts' }),
          toolUseLine('toolu_R2', 'Read', { file_path: '/w/b.ts' }),
          toolUseLine('toolu_R3', 'Read', { file_path: '/w/c.ts' }),
          launched,
        ],
      },
    ]);
    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 3,
    });
    const events = history?.events ?? [];

    expect(callIds(events)).toEqual(['toolu_R2', 'toolu_R3']);
    expect(shellEvents(events)).toEqual([]);
    expect(closeImportedShells(events)).toEqual(events);
    expect(history?.droppedBefore).toBe(2);
  });

  describe('two launches whose calls both arrive before either result', () => {
    const lines = (): unknown[] => {
      const [launchA, launchedA] = bashLaunch('toolu_A', 'bA', 'pnpm dev');
      const [launchB, launchedB] = bashLaunch('toolu_B', 'bB', 'pnpm test');
      return [launchA, launchB, launchedA, launchedB];
    };
    const open = (id: string, workId: string) => ({
      type: 'shell_open',
      toolCallId: id,
      workId,
    });

    it.each([
      {
        limit: 4,
        calls: ['toolu_A', 'toolu_B'],
        opens: [open('toolu_A', 'bA'), open('toolu_B', 'bB')],
        dropped: 0,
      },
      {
        limit: 3,
        calls: ['toolu_B'],
        opens: [open('toolu_B', 'bB')],
        dropped: 1,
      },
      { limit: 2, calls: [], opens: [], dropped: 2 },
      { limit: 1, calls: [], opens: [], dropped: 3 },
    ])(
      'keeps only the opens of the calls held under a cap of $limit',
      async ({ limit, calls, opens, dropped }) => {
        const root = profile([{ dir: 'proj', id: 's1', lines: lines() }]);
        const history = await readClaudeSessionHistory({
          profileDir: root,
          sessionId: 's1',
          limit,
        });
        const events = history?.events ?? [];

        expect(callIds(events)).toEqual(calls);
        expect(shellEvents(events)).toEqual(opens);
        expect(closeImportedShells(events).slice(events.length)).toEqual(
          opens.map((shell) => ({ ...shell, type: 'shell_info' })),
        );
        expect(history?.droppedBefore).toBe(dropped);
      },
    );
  });

  it("counts Monitor's task as a detached command, and TaskUpdate's as nothing", async () => {
    // Both results carry a `taskId`; only one of them started a command.
    const events = await read([
      toolUseLine('toolu_M', 'Monitor', { command: 'tail -f log' }),
      toolResultLine('toolu_M', 'Monitoring…', { taskId: 'bmon' }),
      toolUseLine('toolu_T', 'TaskUpdate', {
        taskId: '3',
        status: 'completed',
      }),
      toolResultLine('toolu_T', 'Updated task #3', { taskId: '3' }),
    ]);

    expect(shellEvents(events)).toEqual([
      { type: 'shell_open', toolCallId: 'toolu_M', workId: 'bmon' },
    ]);
  });
});

describe('eachJsonLine', () => {
  /** Reads `body` through `eachJsonLine`, returning what each callback saw. */
  async function scan(
    body: string,
    contains?: string,
  ): Promise<{ seen: Record<string, unknown>[]; malformed: number }> {
    const root = profile([]);
    const path = join(root, 'transcript.jsonl');
    writeFileSync(path, body);
    const seen: Record<string, unknown>[] = [];
    let malformed = 0;
    await eachJsonLine(
      path,
      null,
      (line) => {
        seen.push(line);
        return true;
      },
      () => {
        malformed += 1;
      },
      contains,
    );
    return { seen, malformed };
  }

  it('flags an unparseable line as malformed and keeps reading', async () => {
    const { seen, malformed } = await scan('{"a":1}\n{"a":\n{"a":2}\n');
    expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
    expect(malformed).toBe(1);
  });

  it('flags an unterminated final line as malformed even when it parses', async () => {
    const { seen, malformed } = await scan('{"a":1}\n{"a":2}');
    expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
    expect(malformed).toBe(1);
  });

  it('does not flag a complete, parseable file', async () => {
    const { malformed } = await scan('{"a":1}\n{"a":2}\n');
    expect(malformed).toBe(0);
  });

  describe('with a substring to look for', () => {
    it('hands over only the parseable lines that carry it', async () => {
      const { seen } = await scan(
        '{"id":"keep-me"}\n{"id":"other"}\n{"id":"keep-me","n":2}\n',
        'keep-me',
      );
      expect(seen).toEqual([{ id: 'keep-me' }, { id: 'keep-me', n: 2 }]);
    });

    it('does not parse a line without it, so an object-shaped one is not judged', async () => {
      const { seen, malformed } = await scan(
        '{"id":"keep-me"}\n{not json but object-shaped}\n',
        'keep-me',
      );
      expect(seen).toEqual([{ id: 'keep-me' }]);
      expect(malformed).toBe(0);
    });

    it('still flags a line without it that is not object-shaped, as a torn write', async () => {
      const { malformed } = await scan(
        '{"id":"keep-me"}\n{"id":"other","partial\n{"id":"keep-me"}\n',
        'keep-me',
      );
      expect(malformed).toBe(1);
    });

    it('flags a torn line without it even when it ends on a nested brace', async () => {
      const { malformed } = await scan(
        '{"id":"keep-me"}\n{"id":"other","msg":{"a":1}\n{"id":"keep-me"}\n',
        'keep-me',
      );
      expect(malformed).toBe(1);
    });

    it('does not flag a whole nested line without it, braces inside strings included', async () => {
      const { malformed } = await scan(
        '{"id":"keep-me"}\n{"id":"other","msg":{"text":"a } and a {"},"list":[1,{"b":"\\\\\\"}"}]}\n',
        'keep-me',
      );
      expect(malformed).toBe(0);
    });

    it('still flags an unparseable line that carries it', async () => {
      const { seen, malformed } = await scan(
        '{"id":"keep-me"}\n{"id":"keep-me",\n',
        'keep-me',
      );
      expect(seen).toEqual([{ id: 'keep-me' }]);
      expect(malformed).toBe(1);
    });

    it('reads every line when the substring would be spelled differently in JSON', async () => {
      const { seen } = await scan('{"id":"a\\"b"}\n{"id":"c"}\n', 'a"b');
      expect(seen).toEqual([{ id: 'a"b' }, { id: 'c' }]);
    });
  });
});

describe('findSessionFile', () => {
  const ID = 'eeeeeeee-1111-2222-3333-444444444444';

  it('prefers the directory its cwd flattens to over a scan hit elsewhere', async () => {
    // The decoy sorts first, so a scan that ran before the derived directory
    // was tried would return it.
    const root = profile([
      { dir: '-0-decoy', id: ID, lines: [] },
      { dir: '-Users-me--x', id: ID, lines: [] },
    ]);
    expect(await findSessionFile(root, ID, '/Users/me/.x')).toBe(
      join(root, 'projects', '-Users-me--x', `${ID}.jsonl`),
    );
  });

  it('falls back to the scan when the cwd names the wrong directory', async () => {
    const root = profile([{ dir: '-private-var-x', id: ID, lines: [] }]);
    expect(await findSessionFile(root, ID, '/var/x')).toBe(
      join(root, 'projects', '-private-var-x', `${ID}.jsonl`),
    );
  });
});
