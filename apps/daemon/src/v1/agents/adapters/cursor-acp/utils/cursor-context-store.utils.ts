import { DatabaseSync } from 'node:sqlite';

import type {
  AgentContextCategory,
  AgentContextUsage,
} from '../../adapter.types';

/**
 * Reading cursor's OWN context accounting out of the session store it keeps on
 * disk.
 *
 * WHY THIS EXISTS RATHER THAN A PROTOCOL CALL. The CLI tells an ACP client
 * nothing about its window — measured twice, most recently on 2026-08-15
 * against a raw frame capture of a real tool-using turn (see the doc block at
 * `usage.breakdown` in the adapter). But it is not that the
 * figures do not exist: the CLI writes a complete breakdown into the session
 * store for every turn, which is what its own TUI renders. geniro already owns
 * that directory — `<configDir>/acp-sessions` is a symlink to
 * `<userData>/cursor-sessions` so a session survives the per-turn profile — so
 * reading it needs no new access, only a parser.
 *
 * WHAT IS THERE, probed on 2026.08.11-e8db854. One SQLite file per session
 * (`store.db`) holding two tables: `meta`, whose single row is a hex-encoded
 * JSON header carrying `latestRootBlobId`, and `blobs`, a content-addressed
 * store. The root blob is protobuf-encoded and carries, in one sub-message:
 *
 *     field 1 (varint)  tokens used          119801
 *     field 2 (varint)  the model's window   300000
 *     field 3 (repeated message, one per category)
 *         field 1 (string)  key      "system_prompt"
 *         field 2 (string)  label    "System prompt"
 *         field 3 (varint)  tokens   5214
 *         field 4 (varint)  characters 13858
 *
 * Eight categories on that reading — system_prompt, tools, rules, skills, mcp,
 * subagents, summarized_conversation, conversation — and their tokens sum to
 * EXACTLY the used total, which is the arithmetic this parser re-checks rather
 * than trusts.
 *
 * NO SCHEMA IS ASSUMED BEYOND THAT SHAPE. Field numbers are read structurally
 * and the breakdown is located by its own contents (a message holding rows of
 * string/string/varint), not by a byte offset — so a re-ordered or extended
 * message still parses, and one that has genuinely changed yields null rather
 * than a wrong number. Same expiry warning as every other probe block in this
 * adapter: an observation of one build. The header also carries a
 * `blobEncryptionKey`, unused on this build — blobs are plaintext — which is
 * the most likely way this stops working, and it stops by returning null.
 */

/** One field of a protobuf message: its number and its decoded payload. */
interface ProtoField {
  number: number;
  value: number | Uint8Array;
}

/**
 * Split a protobuf message into its fields.
 *
 * Returns what it managed to read rather than throwing: the input is another
 * program's private encoding, so a trailing byte it does not model must cost
 * the remainder of one message and never the whole reading.
 */
export function readProtoFields(bytes: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let i = 0;
  while (i < bytes.length) {
    const key = readVarint(bytes, i);
    if (!key) {
      break;
    }
    i = key.next;
    const number = key.value >>> 3;
    const wire = key.value & 7;
    if (wire === 0) {
      const v = readVarint(bytes, i);
      if (!v) {
        break;
      }
      out.push({ number, value: v.value });
      i = v.next;
    } else if (wire === 2) {
      const len = readVarint(bytes, i);
      if (!len || len.next + len.value > bytes.length) {
        break;
      }
      out.push({
        number,
        value: bytes.subarray(len.next, len.next + len.value),
      });
      i = len.next + len.value;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      // Groups (3/4) and anything unknown: this encoding has never been seen
      // to use them, and guessing a length would desynchronize the whole read.
      break;
    }
  }
  return out;
}

function readVarint(
  bytes: Uint8Array,
  start: number,
): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let i = start;
  while (i < bytes.length) {
    const byte = bytes[i];
    if (byte === undefined) {
      return null;
    }
    i += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { value, next: i };
    }
    shift += 7;
    // A token count needs 5 bytes at most; past that the read has
    // desynchronized and is walking through text.
    if (shift > 35) {
      return null;
    }
  }
  return null;
}

/**
 * The context breakdown inside cursor's root blob, or null when the blob does
 * not hold one this parser recognises.
 *
 * The breakdown is found by SHAPE rather than by field number: the whole
 * message tree is walked, and a candidate is any sub-message carrying rows of
 * (string key, string label, varint tokens). That is what survives a vendor
 * adding a field or moving the block, and it is also what makes a genuinely
 * changed encoding fail closed — nothing matches, and the caller shows no
 * breakdown rather than a number read out of unrelated bytes.
 */
export function parseCursorContextBlob(
  blob: Uint8Array,
): AgentContextUsage | null {
  for (const message of walkMessages(blob)) {
    const usage = readBreakdown(message);
    if (usage) {
      return usage;
    }
  }
  return null;
}

/**
 * How deep the walk goes before it stops looking.
 *
 * The real root blob nests three levels; the ceiling is generous enough that a
 * vendor moving the block cannot fall foul of it, and low enough that a blob
 * this parser did not write cannot drive the walk into the stack. Which matters
 * because the bytes are FOREIGN: a length-delimited field is only "a nested
 * message" by guess — any run of bytes can look like one — so a corrupt or
 * hostile blob can present arbitrarily deep nesting, and the walk is
 * synchronous on a request path.
 *
 * A RangeError would be CAUGHT: `readCursorContextUsage` wraps this whole call
 * and answers null. So the cap is not the difference between a crash and a
 * degrade — it bounds the work spent reaching that degrade, on a path the panel
 * opens on demand.
 */
const MAX_BLOB_DEPTH = 12;

/** Every length-delimited payload in the tree, outermost first. */
function* walkMessages(bytes: Uint8Array, depth = 0): Generator<ProtoField[]> {
  const fields = readProtoFields(bytes);
  yield fields;
  if (depth >= MAX_BLOB_DEPTH) {
    return;
  }
  for (const field of fields) {
    if (field.value instanceof Uint8Array && field.value.length > 4) {
      yield* walkMessages(field.value, depth + 1);
    }
  }
}

function readBreakdown(fields: ProtoField[]): AgentContextUsage | null {
  const categories: AgentContextCategory[] = [];
  for (const field of fields) {
    if (!(field.value instanceof Uint8Array)) {
      continue;
    }
    const row = readCategory(field.value);
    if (row) {
      categories.push(row);
    }
  }
  if (categories.length === 0) {
    return null;
  }
  const used = firstVarint(fields, 1);
  const window = firstVarint(fields, 2);
  // The arithmetic the probe found to hold exactly, re-checked here rather
  // than trusted: the categories must account for the stated total. A message
  // that merely LOOKS like the breakdown — a different block whose rows happen
  // to be string/string/varint — will not add up, and is rejected.
  const sum = categories.reduce((total, row) => total + row.tokens, 0);
  if (used === null || sum !== used) {
    return null;
  }
  return {
    categories,
    totalTokens: used,
    // A window of 0 is not a window. Left null rather than divided by, which
    // is the rule `ContextMeter` already documents for an unreported one.
    maxTokens: window !== null && window > 0 ? window : null,
    // The store names no model, and this parser will not infer one from the id
    // the run happens to be set to — the reading would then claim to describe
    // a model nobody wrote down.
    model: null,
    // Neither is on this wire. Cursor's `rules` category is the counterpart of
    // claude's memory files, but it is reported as ONE total with no per-file
    // rows, so there is nothing to list.
    autoCompactAtTokens: null,
    autoCompactEnabled: null,
    memoryFiles: [],
    servers: [],
  };
}

/** One category row, or null when this payload is not one. */
function readCategory(bytes: Uint8Array): AgentContextCategory | null {
  const fields = readProtoFields(bytes);
  const key = firstString(fields, 1);
  const label = firstString(fields, 2);
  const tokens = firstVarint(fields, 3);
  if (key === null || label === null || tokens === null) {
    return null;
  }
  return {
    // The LABEL, which is the CLI's own display name for the row — the same
    // rule the claude reader follows, so a user comparing geniro's readout to
    // their agent's own screen sees the same words.
    name: label,
    tokens,
    // Cursor draws no distinction between loaded and available: every category
    // it reports is counted in the total it states.
    deferred: false,
  };
}

function firstVarint(fields: ProtoField[], number: number): number | null {
  for (const field of fields) {
    if (field.number === number && typeof field.value === 'number') {
      return field.value;
    }
  }
  return null;
}

/** Anything unprintable — the tell that a payload is not text at all. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function firstString(fields: ProtoField[], number: number): string | null {
  for (const field of fields) {
    if (field.number === number && field.value instanceof Uint8Array) {
      const text = new TextDecoder('utf8', { fatal: false }).decode(
        field.value,
      );
      // Printable, non-empty text only. A varint-heavy payload decodes to
      // control characters, and letting that through is how an unrelated
      // sub-message would pass for a category row.
      return text.length > 0 && !CONTROL_CHARS.test(text) ? text : null;
    }
  }
  return null;
}

/**
 * The root blob id in the header row cursor writes into `meta`: `''` while the
 * session has no checkpoint yet (cursor writes the header with an empty id at
 * `session/new`), null when the row does not read as a header.
 */
export function parseStoreHeader(hexOrJson: string): string | null {
  let text = hexOrJson;
  if (/^[0-9a-f]+$/i.test(hexOrJson) && hexOrJson.length % 2 === 0) {
    text = Buffer.from(hexOrJson, 'hex').toString('utf8');
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const id = (parsed as { latestRootBlobId?: unknown }).latestRootBlobId;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

/** Read one session's breakdown off disk, or null for every way that can fail. */
export function readCursorContextUsage(
  storePath: string,
  warn?: (message: string) => void,
): AgentContextUsage | null {
  return readCursorStoreRoot(storePath, warn, (root) =>
    parseCursorContextBlob(root),
  );
}

/** One blob of an open store, or null when it is missing or not bytes. */
export function readStoreBlob(db: DatabaseSync, id: string): Uint8Array | null {
  const row = db.prepare('SELECT data FROM blobs WHERE id = ?').get(id) as
    { data?: unknown } | undefined;
  const blob = row?.data;
  return blob instanceof Uint8Array || Buffer.isBuffer(blob)
    ? new Uint8Array(blob)
    : null;
}

/**
 * Open one session's store, hand its root blob to `read` — or answer
 * `withoutRoot` for a session with no checkpoint yet — and answer null for
 * every way that can fail: the ONE impure reader in this adapter's store
 * utils, kept apart from the parsers so they stay drivable by a spec with no
 * database. A session the CLI has not written yet, a store whose schema has
 * moved, a database held open by a running CLI: all of them are "no reading".
 *
 * Opened READ-ONLY. geniro owns this directory (the per-turn profile symlinks
 * into it so a conversation survives the profile) but not the format, and
 * nothing here may ever write to another program's store.
 */
export function readCursorStoreRoot<T>(
  storePath: string,
  warn: ((message: string) => void) | undefined,
  read: (root: Uint8Array, db: DatabaseSync) => T | null,
  withoutRoot: T | null = null,
): T | null {
  let db: DatabaseSync | null = null;
  try {
    // node's OWN sqlite, not the daemon's `better-sqlite3`: this reads a file
    // that has nothing to do with geniro's ORM, and the built-in costs no
    // dependency and no native rebuild against Electron's ABI.
    db = new DatabaseSync(storePath, { readOnly: true });
    const meta = db.prepare('SELECT value FROM meta LIMIT 1').get() as
      { value?: unknown } | undefined;
    const header = typeof meta?.value === 'string' ? meta.value : null;
    const rootId = header === null ? null : parseStoreHeader(header);
    if (rootId === null) {
      return null;
    }
    if (rootId === '') {
      return withoutRoot;
    }
    const root = readStoreBlob(db, rootId);
    return root === null ? null : read(root, db);
  } catch (err) {
    // Debug-level in spirit, warn in practice for the same reason the rest of
    // this adapter warns: when the format moves, the panel goes quiet, and the
    // only way anyone learns why is a line saying so.
    warn?.(
      `cursor-agent: could not read the session store at ${storePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // A close that fails leaves a handle the process will drop on exit;
      // there is nothing to tell the user and nothing to retry.
    }
  }
}
