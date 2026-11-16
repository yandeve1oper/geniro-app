import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  parseCursorContextBlob,
  parseStoreHeader,
  readCursorContextUsage,
} from './cursor-context-store.utils';

/**
 * The root blob of a REAL cursor session, captured on 2026.08.11-e8db854 from
 * a conversation run in this repository (one prompt, one file read).
 *
 * Verbatim bytes rather than a hand-built fixture, and that is the point: this
 * parser reads another program's private encoding, so a fixture written from
 * the parser's own assumptions would pin nothing. The figures asserted below
 * are the ones that CLI put on its own screen for that conversation.
 */
const ROOT_BLOB_BASE64 =
  'CiDPU6y/zNWB3X17FWrGIeMslXYzoOMZfoGQzdt8ru1cdwogPYpVFXc+l1a1E1UJ3okBWr5+U9U1' +
  'leEbdgPjs8RojRIKIESvcEcOMc8WGw8Sun8ww+IK9umLv9Lwoz5kgfPtuRXrCiAuhuqWjhTY5D/X' +
  'jqP14sV3h/RbxhXhoDGu5mQT6SMzEwogChPNv4/fbACenYDMxeA8Y4hfJGb0dzkKHAoAy7B+d10K' +
  'IPy6ukHACte32mZeXn2jz3e3y/TbodwqIQecBMpHUBRjCiBEbDDBjIRpGZANthNX5X6uKDD9r/63' +
  '8f41rb42csBxZwogi6yRIcO5Jeh+sT3lZTqK3d2qlER0YyNDcza9CR8EVlEqsQII+acHEOCnEhqm' +
  'Agj5pwcQ4KcSGiQKDXN5c3RlbV9wcm9tcHQSDVN5c3RlbSBwcm9tcHQY3iggomwaIQoFdG9vbHMS' +
  'EFRvb2wgZGVmaW5pdGlvbnMY9cIDIJWuCRoWCgVydWxlcxIFUnVsZXMYzvsCIIjxBxoWCgZza2ls' +
  'bHMSBlNraWxscxixDSDHIxogCgNtY3ASE01DUCAmIGR5bmFtaWMgdG9vbHMY9iAgwFcaJwoJc3Vi' +
  'YWdlbnRzEhRTdWJhZ2VudCBkZWZpbml0aW9ucxiNAiDKBRo0ChdzdW1tYXJpemVkX2NvbnZlcnNh' +
  'dGlvbhIXU3VtbWFyaXplZCBjb252ZXJzYXRpb24gABoiCgxjb252ZXJzYXRpb24SDENvbnZlcnNh' +
  'dGlvbhikECDcIUIgFE6buO+HTEFoh1DmeqbJMMUxnqdxCgS34XCVm5TZ019CIHfQTWXb4ske9Cix' +
  'x2N7Tdl3/MwRTNrMQHSF+xgD9FshSkJmaWxlOi8vL1VzZXJzL3NlcmdlaXJhenVtb3Zza2lqL0Rl' +
  'c2t0b3AvUHJvamVjdHMvR2VuaXJvL2dlbmlyby1hcHBQAZIBSC9Vc2Vycy9zZXJnZWlyYXp1bW92' +
  'c2tpai9EZXNrdG9wL1Byb2plY3RzL0dlbmlyby9nZW5pcm8tYXBwL3BhY2thZ2UuanNvbqoBUwo7' +
  'L1VzZXJzL3NlcmdlaXJhenVtb3Zza2lqL0Rlc2t0b3AvUHJvamVjdHMvR2VuaXJvL2dlbmlyby1h' +
  'cHASFGZlYXQvY29udGV4dC1tZXRyaWNzsgEDY2xp0AHOrt2ugDTaAQtBc2lhL0FsbWF0eQ==';

const ROOT = new Uint8Array(Buffer.from(ROOT_BLOB_BASE64, 'base64'));

describe('parseStoreHeader', () => {
  it('reads the root blob id out of the hex-encoded meta row', () => {
    const hex = Buffer.from(
      JSON.stringify({ agentId: 'a', latestRootBlobId: 'root-1' }),
    ).toString('hex');

    expect(parseStoreHeader(hex)).toBe('root-1');
  });

  it('reads a plain JSON header too, in case the encoding drops', () => {
    expect(parseStoreHeader('{"latestRootBlobId":"root-2"}')).toBe('root-2');
  });

  it('reads the empty id of a session with no checkpoint yet as empty, not unreadable', () => {
    const hex = Buffer.from(
      JSON.stringify({ agentId: 'a', latestRootBlobId: '' }),
    ).toString('hex');

    expect(parseStoreHeader(hex)).toBe('');
  });

  it('answers null for anything it cannot read', () => {
    expect(parseStoreHeader('not json')).toBeNull();
    expect(parseStoreHeader('{"agentId":"a"}')).toBeNull();
    expect(parseStoreHeader('')).toBeNull();
  });
});

describe('parseCursorContextBlob', () => {
  it('reads the window this conversation actually reported', () => {
    const usage = parseCursorContextBlob(ROOT);

    expect(usage?.totalTokens).toBe(119_801);
    expect(usage?.maxTokens).toBe(300_000);
  });

  it('reads the CLI’s own category names and figures', () => {
    const usage = parseCursorContextBlob(ROOT);

    expect(usage?.categories).toEqual([
      { name: 'System prompt', tokens: 5214, deferred: false },
      { name: 'Tool definitions', tokens: 57_717, deferred: false },
      { name: 'Rules', tokens: 48_590, deferred: false },
      { name: 'Skills', tokens: 1713, deferred: false },
      { name: 'MCP & dynamic tools', tokens: 4214, deferred: false },
      { name: 'Subagent definitions', tokens: 269, deferred: false },
      { name: 'Conversation', tokens: 2084, deferred: false },
    ]);
  });

  it('has categories that account for the total exactly', () => {
    // The arithmetic the parser itself checks before believing a message is
    // the breakdown — asserted here so the check cannot be quietly dropped.
    const usage = parseCursorContextBlob(ROOT);
    const sum = (usage?.categories ?? []).reduce(
      (total, row) => total + row.tokens,
      0,
    );

    expect(sum).toBe(usage?.totalTokens);
  });

  it('claims nothing it was not told', () => {
    // The store names no model and lists no per-file or per-server rows. An
    // earlier draft filled `model` from the run's own setting, which made the
    // reading claim to describe a model nobody had written down.
    const usage = parseCursorContextBlob(ROOT);

    expect(usage?.model).toBeNull();
    expect(usage?.memoryFiles).toEqual([]);
    expect(usage?.servers).toEqual([]);
    expect(usage?.autoCompactAtTokens).toBeNull();
  });

  it('rejects bytes that are not a breakdown, rather than guessing', () => {
    expect(parseCursorContextBlob(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(parseCursorContextBlob(new Uint8Array())).toBeNull();
    expect(
      parseCursorContextBlob(new TextEncoder().encode('{"role":"user"}')),
    ).toBeNull();
  });

  it('rejects a message whose rows do not add up to the total it states', () => {
    // The guard that separates the real breakdown from a block that merely has
    // the same shape — and the tamper is built to leave the ENCODING intact, so
    // that the arithmetic is the only thing that can reject it. An earlier
    // draft flipped a byte of the stated total to a value with no continuation
    // bit, which truncated the varint and desynchronized every field after it:
    // the parser then found no categories at all and answered null for a
    // reason that had nothing to do with this check, which is a false pin.
    // Bumping the low byte of System prompt's token count keeps the varint the
    // same width and the message readable, and moves the sum by one.
    const tampered = new Uint8Array(ROOT);
    bump(tampered, bumpableAt(SYSTEM_PROMPT_TOKENS));

    expect(parseCursorContextBlob(tampered)).toBeNull();

    // The control that proves the bytes above were still parseable: state the
    // new total as well, and the same message is accepted again. Both copies
    // of the total are bumped — the blob nests the used/window pair twice, and
    // the categories sit beside the inner one.
    const repaired = new Uint8Array(tampered);
    for (const at of allOf(USED_TOTAL)) {
      bump(repaired, at + 1);
    }

    expect(parseCursorContextBlob(repaired)?.totalTokens).toBe(119_802);
    expect(parseCursorContextBlob(repaired)?.categories[0]).toEqual({
      name: 'System prompt',
      tokens: 5215,
      deferred: false,
    });
  });

  it('stops descending past its depth ceiling', () => {
    // These bytes are FOREIGN and the walk is synchronous on a request path. A
    // length-delimited field is only a nested message by GUESS — any run of
    // bytes can look like one — so a corrupt or hostile blob can present
    // nesting without bound.
    //
    // The ceiling itself is what is asserted, rather than a crash: a stack
    // limit is environment-dependent and slow to reach, while burying the real
    // breakdown one layer too deep observes exactly the bound and nothing else.
    // The two depths STRADDLE the cap with nothing between them: measured
    // against this fixture, 10 wrappings is the deepest that still resolves and
    // 11 the shallowest that does not (the breakdown sits two levels inside
    // ROOT, so those are depths 12 and 13). Raising OR lowering
    // `MAX_BLOB_DEPTH` by one therefore fails this test — a wider margin would
    // have pinned only one side of the bound, or neither.
    const shallow = bury(ROOT, 10);
    const deep = bury(ROOT, 11);

    expect(parseCursorContextBlob(shallow)?.totalTokens).toBe(119_801);
    expect(parseCursorContextBlob(deep)).toBeNull();
  });

  it('leaves the window null when the store reports one of zero', () => {
    // A window of 0 is not a window, and this is the one place the figure is
    // divided by. The rest of the blob is the real one, so nothing else about
    // the reading changes — only the denominator the meter would have used.
    const zeroed = new Uint8Array(ROOT);
    for (const at of allOf(WINDOW_TOTAL)) {
      // Re-encoded as zero at the SAME WIDTH (`80 80 00` is a legal three-byte
      // varint for 0). Writing a short `00` instead would truncate the varint
      // and desynchronize every field after it — the false pin the tamper above
      // documents, where the parser answers null for an unrelated reason.
      zeroed[at + 1] = 0x80;
      zeroed[at + 2] = 0x80;
      zeroed[at + 3] = 0x00;
    }

    const usage = parseCursorContextBlob(zeroed);

    expect(usage?.totalTokens).toBe(119_801);
    expect(usage?.maxTokens).toBeNull();
  });
});

describe('readCursorContextUsage', () => {
  /**
   * The id the header names. Deliberately NOT a round name a bypass could
   * plausibly hardcode: an earlier draft called it `root-1`, and replacing the
   * whole header read with that literal left every assertion green.
   */
  const ROOT_ID = '3d8a5515-773e-9756-b513-5509de89015a';

  /**
   * A store shaped exactly like the CLI's: the hex-JSON header row in `meta`,
   * the root blob content-addressed in `blobs`.
   *
   * Built through sqlite rather than checked in as a binary, so the fixture
   * states the schema this reader depends on in a form a reader can see. It
   * also carries a DECOY blob, which is what makes the header read observable
   * — a reader that grabbed any row would find the wrong one first.
   */
  function writeStore(options: { readable: boolean }): string {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-store-'));
    const path = join(dir, 'store.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE meta (value TEXT)');
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    db.prepare('INSERT INTO meta (value) VALUES (?)').run(
      Buffer.from(
        JSON.stringify({ latestRootBlobId: ROOT_ID, agentId: 'a' }),
      ).toString('hex'),
    );
    const insert = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
    insert.run('00000000-decoy', new Uint8Array([1, 2, 3, 4]));
    insert.run(ROOT_ID, options.readable ? ROOT : new Uint8Array([1, 2, 3, 4]));
    db.close();
    return path;
  }

  it('reads one session’s breakdown end to end', () => {
    const usage = readCursorContextUsage(writeStore({ readable: true }));

    expect(usage?.totalTokens).toBe(119_801);
    expect(usage?.categories).toHaveLength(7);
  });

  it('creates nothing when the session has no store yet', () => {
    // The observable half of "opened read-only". SQLite silently DOWNGRADES a
    // read-write open of an unwritable file to read-only, so the flag cannot
    // be caught that way — but it also governs O_CREAT, and a read-write open
    // of a missing path leaves an empty `store.db` behind. That matters beyond
    // tidiness: this path is `<userData>/cursor-sessions/<id>/`, the CLI's own
    // directory, and every readout of a reaped session would seed a file there.
    const path = join(mkdtempSync(join(tmpdir(), 'cursor-store-')), 'store.db');
    const warnings: string[] = [];

    expect(
      readCursorContextUsage(path, (message) => warnings.push(message)),
    ).toBeNull();
    expect(existsSync(path)).toBe(false);
    // The failure is SAID out loud — when the format moves, a quiet panel is
    // the only symptom, and this line is how anyone learns why.
    expect(warnings).toHaveLength(1);
  });

  it('treats an unreadable root blob as no reading, not a failure', () => {
    const warnings: string[] = [];

    // Nothing threw and nothing is broken — the blob is simply not a breakdown
    // this parser recognises, so there is nothing to warn about.
    expect(
      readCursorContextUsage(writeStore({ readable: false }), (message) =>
        warnings.push(message),
      ),
    ).toBeNull();
    expect(warnings).toEqual([]);
  });
});

/**
 * Wrap `payload` in `layers` nested `{field 1: <message>}` envelopes.
 *
 * The length is a real varint rather than one byte, which is the whole reason
 * this helper exists: a single-byte prefix caps a payload at 127 bytes, so a
 * naive nesting stops long before any depth bound and pins nothing.
 */
function bury(payload: Uint8Array, layers: number): Uint8Array {
  let bytes = payload;
  for (let i = 0; i < layers; i += 1) {
    const length: number[] = [];
    let rest = bytes.length;
    do {
      const byte = rest & 0x7f;
      rest >>>= 7;
      length.push(rest > 0 ? byte | 0x80 : byte);
    } while (rest > 0);
    bytes = new Uint8Array([0x0a, ...length, ...bytes]);
  }
  return bytes;
}

/** `{field 1: varint}` opening the used/window pair — 119801, twice over. */
const USED_TOTAL = [0x08, 0xf9, 0xa7, 0x07];
/** `{field 2: varint}` closing it — the window, 300000, likewise twice. */
const WINDOW_TOTAL = [0x10, 0xe0, 0xa7, 0x12];
/** `{field 3: varint}` of the System prompt category — 5214. */
const SYSTEM_PROMPT_TOKENS = [0x18, 0xde, 0x28];

/**
 * Raise one byte by one, in place.
 *
 * The bounds check is the point rather than ceremony: an offset the fixture
 * does not hold would otherwise be a silent no-op, and the tamper this test
 * rests on would stop tampering with anything.
 */
function bump(bytes: Uint8Array, at: number): void {
  const before = bytes[at];
  expect(before).toBeDefined();
  bytes[at] = (before ?? 0) + 1;
}

/** Every offset at which `needle` occurs in the fixture. */
function allOf(needle: number[]): number[] {
  const found: number[] = [];
  for (let i = 0; i <= ROOT.length - needle.length; i += 1) {
    if (needle.every((byte, j) => ROOT[i + j] === byte)) {
      found.push(i);
    }
  }
  expect(found.length).toBeGreaterThan(0);
  return found;
}

/**
 * The offset of the varint byte to raise by one, for a field that occurs
 * exactly once. Uniqueness is asserted rather than assumed: silently editing
 * the first of several matches would tamper with a field the test does not
 * name, and the assertion would then be pinning something else entirely.
 */
function bumpableAt(needle: number[]): number {
  const found = allOf(needle);
  expect(found).toHaveLength(1);
  return (found[0] ?? 0) + 1;
}
