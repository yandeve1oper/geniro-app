import { randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { titleFromText } from '../../../utils/derive-title';
import { isPlainSessionId } from '../../../utils/session-id';
import type {
  AgentEvent,
  AgentSessionHistory,
  AgentSessionRecord,
} from '../../adapter.types';
import {
  searchTerms,
  snippetAround,
  unmatchedTerms,
} from '../../utils/session-search.utils';
import {
  CLAUDE_DETACHED_LAUNCH_KEYS,
  CLAUDE_SESSION_FILE_SUFFIX,
  CLAUDE_SESSION_HEAD_BUDGET_BYTES,
  CLAUDE_SESSION_SEARCH_BUDGET_BYTES,
  CLAUDE_SESSION_SEARCH_FILE_LIMIT,
  CLAUDE_SESSION_SNIPPET_MAX_CHARS,
  CLAUDE_SESSION_TITLE_MAX_CHARS,
  CLAUDE_SESSIONS_DIR_NAME,
} from '../claude.const';
import { mapClaudeMessage } from './claude-message.utils';
import { ClaudeSessionCostLedger } from './claude-usage.utils';

/**
 * Reading the conversations this CLI has already held, off its own profile.
 *
 * The whole store is `<configDir>/projects/<cwd-with-slashes-flattened>/<sessionId>.jsonl`
 * — one append-only JSONL per session, in exactly the envelope
 * `-p --output-format stream-json` writes to stdout. That is the fact this file
 * rests on and the reason claude needs no protocol call to be imported: the
 * transcript is already in the vocabulary {@link mapClaudeMessage} speaks, so an
 * imported thread is built by the same mapper as a live one rather than by a
 * second reader that could disagree with it about what a row means.
 *
 * The directory NAME is deliberately never parsed. It is the cwd with its
 * separators flattened to `-`, which is lossy (`/a/b-c` and `/a-b/c` collide)
 * and undocumented; every `cwd` here is read from the file's own lines, where
 * the CLI writes it verbatim on each one.
 *
 * Scale is the other constraint. The author's own profile holds 2,448 sessions
 * over 1.7GB, and one session runs to 11MB — so nothing here reads a whole file
 * to answer "what is this about": the listing stats every candidate (cheap) and
 * opens only as far as the first user message, bounded by
 * {@link CLAUDE_SESSION_HEAD_BUDGET_BYTES}.
 */

/**
 * Resolved paths, so one folder is compared once however many sessions name it.
 *
 * MODULE-scope on purpose. The map is keyed by the path itself, so it is
 * correct across calls — and the paths a listing asks about are the same
 * handful every time, which is what makes the filter cost one `realpath` per
 * folder for the life of the daemon rather than one per listing.
 */
const canonicalPaths = new Map<string, string>();

/**
 * The path with its symlinks resolved, or the path itself when it cannot be.
 *
 * This exists because of a spelling, and it is the difference between the
 * folder filter working and silently matching nothing on macOS: the CLI writes
 * `cwd` as the process saw it, and this app canonicalizes every folder it
 * holds. Measured here — a session recorded
 * `/private/var/folders/…/geniro-run-cwd` while the composer held
 * `/var/folders/…/geniro-run-cwd`, the same directory through the `/var`
 * symlink, so a string compare rejected every session in the folder the user
 * was sitting in.
 *
 * A path that no longer exists resolves to ITSELF rather than being dropped: a
 * session whose folder has since been deleted is still a session, and it
 * compares equal to another spelling of the same missing path.
 */
async function canonical(path: string | null): Promise<string | null> {
  if (path === null || path === '') {
    return null;
  }
  const cached = canonicalPaths.get(path);
  if (cached !== undefined) {
    return cached;
  }
  let resolved = path;
  try {
    resolved = await realpath(path);
  } catch {
    // Deleted, or unreadable — the raw path is the best answer there is.
  }
  canonicalPaths.set(path, resolved);
  return resolved;
}

/** One `<configDir>/projects/<dir>/<id>.jsonl`, with what `stat` alone knows. */
interface SessionFile {
  id: string;
  path: string;
  dir: string;
  updatedAt: number;
}

/**
 * How many session heads are opened at once.
 *
 * Eight because that is where the measured curve flattens on the real profile
 * (400 heads: 155ms sequential, 11ms at this width) and because each open head
 * is a file handle — the point of a batch rather than one `Promise.all` over
 * every file is that the second is unbounded in the size of the user's history.
 */
const HEAD_READ_BATCH = 8;

/** What one file's opening lines say about itself. */
interface SessionHead {
  cwd: string | null;
  /** First real user message, already trimmed to a single line. */
  title: string | null;
}

/**
 * List the sessions in one profile, newest first.
 *
 * `cwd` filtering is done against the value read from the FILES, not from the
 * directory name — but a directory holds one folder's sessions, so the first
 * file identifies the rest and the remaining files in a rejected directory are
 * skipped without being opened. That is what keeps a filtered listing over
 * thousands of sessions to a few hundred small reads.
 */
export async function listClaudeSessions(input: {
  profileDir: string;
  cwd: string | null;
  limit: number;
  query: string | null;
  /**
   * Override for {@link CLAUDE_SESSION_SEARCH_FILE_LIMIT}, test-only. Defaults
   * to the real constant so no production caller has anything to pass — it
   * exists so a spec can arrange "the cap bit" without writing hundreds of
   * fixture files to reach the real 600.
   */
  searchFileLimit?: number;
}): Promise<{
  sessions: AgentSessionRecord[];
  searchTruncated: boolean;
  /**
   * The cap this call actually ran under.
   *
   * Returned rather than left for the caller to re-derive from the constant:
   * the caller's `partialReason` states the number to the user, and reading it
   * from a second source is how the sentence comes to name a cap the search did
   * not use.
   */
  searchFileLimit: number;
}> {
  const files = await collectSessionFiles(input.profileDir);
  files.sort((a, b) => b.updatedAt - a.updatedAt);

  const terms = searchTerms(input.query);
  const searching = terms.length > 0;
  const searchFileLimit =
    input.searchFileLimit ?? CLAUDE_SESSION_SEARCH_FILE_LIMIT;
  // Two phases when searching, and the split is what keeps the answer the same
  // whatever order the disk happens to serve the reads in. Phase A is the
  // listing as it has always been — stat, head, folder filter — and it stops on
  // a DIFFERENT cap, since it can no longer tell which of its candidates the
  // search will keep. Phase B then opens bodies, in the candidates' own order,
  // and applies `limit`. Doing the body read inside phase A instead would work,
  // but its file cap would be spent in completion order rather than in
  // newest-first order — so which sessions a large profile searched would
  // change from one keystroke to the next.
  const candidateCap = searching ? searchFileLimit : input.limit;

  const wanted = input.cwd === null ? null : await canonical(input.cwd);
  const rows: Candidate[] = [];
  /** Folder per project directory, learned from its first readable file. */
  const dirCwd = new Map<string, string | null>();
  // Heads are read a BATCH at a time and then decided over IN ORDER. Both
  // halves matter: reading them one await at a time cost 155ms of the 183ms a
  // real 563-session listing took, while deciding out of order would break the
  // newest-first result AND the `dirCwd` short-circuit, which depends on a
  // rejected directory being known before its remaining files are reached.
  //
  // The map is consulted TWICE, and the second time is not redundant. The read
  // inside the batch runs against the state as of the batch's START, so it can
  // only spare a read; the read in the decision loop below runs against the
  // state as of that row, which is what makes the ANSWER the same however the
  // boundary falls. Without it, a directory rejected mid-batch still admits the
  // rows behind it in that batch — and a project directory genuinely can hold
  // two folders' sessions, because the directory name is the cwd with its
  // separators flattened and that is lossy (`/a/b-c` and `/a-b/c` collide, as
  // the file's own doc block records). A matching session in such a directory
  // would then appear or vanish from the picker depending only on how many
  // unrelated sessions happened to sort ahead of it.
  //
  // Concurrency is bounded rather than unleashed over `files`: a profile of
  // this size would otherwise open thousands of file handles at once.
  for (
    let start = 0;
    start < files.length && rows.length < candidateCap;
    start += HEAD_READ_BATCH
  ) {
    const batch = files.slice(start, start + HEAD_READ_BATCH);
    const probed = await Promise.all(
      batch.map(async (file) => {
        if (wanted !== null && dirCwd.get(file.dir) === null) {
          // Already established that this directory is some other folder's.
          return null;
        }
        const head = await readSessionHead(file.path);
        if (head === null) {
          return null;
        }
        return {
          head,
          cwd: wanted === null ? null : await canonical(head.cwd),
        };
      }),
    );
    for (const [index, file] of batch.entries()) {
      if (rows.length >= candidateCap) {
        break;
      }
      if (wanted !== null && dirCwd.get(file.dir) === null) {
        // Re-read, against the state as of THIS row: an earlier row in this
        // same batch may have rejected the directory after the batch's own
        // check had already let this one through.
        continue;
      }
      const found = probed[index];
      if (found === undefined || found === null) {
        continue;
      }
      const { head } = found;
      if (wanted !== null && found.cwd !== wanted) {
        // Only mark the directory rejected on a file that actually stated a
        // folder — a line-less file says nothing about its neighbours.
        if (head.cwd !== null) {
          dirCwd.set(file.dir, null);
        }
        continue;
      }
      if (head.title === null) {
        // No user message in the file's opening budget: a session with nothing
        // said in it is not one anybody meant to carry on. Skipped rather than
        // listed under its id, which would offer the user a row that means
        // nothing and resumes nothing.
        continue;
      }
      dirCwd.set(file.dir, head.cwd);
      rows.push({
        id: file.id,
        cwd: head.cwd,
        title: head.title,
        updatedAt: file.updatedAt,
        // Filled only by a body match — a row the title or the folder already
        // explains has nothing to add.
        snippet: null,
        path: file.path,
      });
    }
  }
  if (!searching) {
    return {
      sessions: rows.map(toRecord),
      searchTruncated: false,
      searchFileLimit,
    };
  }
  return {
    sessions: await searchCandidates(rows, terms, input.limit),
    // Only when the cap is what stopped it. A profile with fewer sessions than
    // the cap searched every one of them, and saying otherwise would put a
    // permanent "this is not everything" under a list that IS everything.
    searchTruncated: rows.length >= searchFileLimit,
    searchFileLimit,
  };
}

/** A session that passed the folder filter, with the file still to be opened. */
interface Candidate extends AgentSessionRecord {
  path: string;
}

function toRecord(candidate: Candidate): AgentSessionRecord {
  return {
    id: candidate.id,
    cwd: candidate.cwd,
    title: candidate.title,
    updatedAt: candidate.updatedAt,
    snippet: candidate.snippet,
  };
}

/**
 * Keep the candidates that answer every term, opening bodies only where the row
 * itself does not already say so.
 *
 * The cheap half first, and it is not merely an optimization: a term matching
 * the TITLE or the FOLDER is answered without opening anything, which is what
 * makes searching by project name cost the same as it did before this existed.
 * Only the terms still unaccounted for are carried into the file.
 */
async function searchCandidates(
  candidates: Candidate[],
  terms: string[],
  limit: number,
): Promise<AgentSessionRecord[]> {
  const kept: AgentSessionRecord[] = [];
  for (
    let start = 0;
    start < candidates.length && kept.length < limit;
    start += HEAD_READ_BATCH
  ) {
    const batch = candidates.slice(start, start + HEAD_READ_BATCH);
    const found = await Promise.all(
      batch.map(async (candidate) => {
        const missing = unmatchedTerms(terms, candidate);
        if (missing.length === 0) {
          return candidate;
        }
        const snippet = await searchSessionBody(candidate.path, missing);
        return snippet === null ? null : { ...candidate, snippet };
      }),
    );
    // Decided IN ORDER after the batch, like the head reads above: the results
    // arrive in whatever order the disk answered, and a picker whose newest
    // match is not its first row is a picker that looks broken.
    for (const candidate of found) {
      if (kept.length >= limit) {
        break;
      }
      if (candidate !== null) {
        kept.push(toRecord(candidate));
      }
    }
  }
  return kept;
}

/**
 * Read one session looking for every term, and answer with the line that shows
 * why it matched.
 *
 * Bounded twice — the byte budget here, the file count in the caller — and
 * abandoned the instant the last term lands, so the budget is only ever paid in
 * full by a session that does NOT match. Which is the common case, and is why
 * the caller's file cap exists at all.
 *
 * Searches what was SAID, not everything the file holds. A session's tool
 * inputs and outputs are most of its bytes — every file read, every command's
 * output — so including them would make ordinary words match nearly every
 * conversation, which is a search that returns the whole list.
 */
async function searchSessionBody(
  path: string,
  terms: string[],
): Promise<string | null> {
  const outstanding = new Set(terms);
  let snippet: string | null = null;
  await eachJsonLine(path, CLAUDE_SESSION_SEARCH_BUDGET_BYTES, (line) => {
    const text = spokenText(line);
    if (text === null) {
      return true;
    }
    const haystack = text.toLowerCase();
    let hit: string | null = null;
    for (const term of outstanding) {
      if (haystack.includes(term)) {
        outstanding.delete(term);
        hit ??= term;
      }
    }
    // The FIRST line that answered anything, kept rather than replaced: a later
    // line completing the last term is not more relevant, and a snippet that
    // moves as the read goes on is one the user cannot predict.
    if (hit !== null && snippet === null) {
      snippet = snippetAround(text, hit, CLAUDE_SESSION_SNIPPET_MAX_CHARS);
    }
    return outstanding.size > 0;
  });
  return outstanding.size === 0 ? snippet : null;
}

/** What a person or an agent SAID on one line, or null for anything else. */
function spokenText(line: Record<string, unknown>): string | null {
  if (line.type === 'user') {
    return userText(line);
  }
  if (line.type !== 'assistant') {
    return null;
  }
  const message = line.message;
  if (typeof message !== 'object' || message === null) {
    return null;
  }
  const text = joinTextBlocks(
    (message as Record<string, unknown>).content,
  ).trim();
  return text === '' ? null : text;
}

/**
 * The conversation itself, mapped through the live turn's own mapper.
 *
 * `limit` keeps the NEWEST events: an 11MB session is tens of thousands of
 * rows, and a thread that takes a minute to open is its own defect. It counts
 * the conversation alone: a detached command's `shell_open` rides free, so
 * background work never pushes visible history out, and is held only while
 * the call that launched it is. What was cut is reported rather than silently
 * absent — see {@link AgentSessionHistory.droppedBefore}.
 */
export async function readClaudeSessionHistory(input: {
  profileDir: string;
  sessionId: string;
  limit: number;
}): Promise<AgentSessionHistory | null> {
  const path = await findSessionFile(input.profileDir, input.sessionId);
  if (path === null) {
    return null;
  }
  const events: AgentEvent[] = [];
  let dropped = 0;
  // Inert by construction, and threaded only because the mapper's signature
  // requires one: the sole line type carrying session cost totals is `result`,
  // which `mapHistoryLine` drops before the mapper ever sees it (see its doc
  // block). Scoped to this import so it cannot outlive the file being read.
  const costLedger = new ClaudeSessionCostLedger();
  const shells = new DetachedShellLog();
  let conversation = 0;
  const heldCalls = new Set<string>();
  const heldOpens = new Set<string>();
  await eachJsonLine(path, null, (line) => {
    for (const event of mapHistoryLine(line, costLedger, shells)) {
      if (event.type === 'shell_open') {
        if (event.toolCallId !== null && heldCalls.has(event.toolCallId)) {
          events.push(event);
          heldOpens.add(event.toolCallId);
        }
        continue;
      }
      if (event.type === 'tool_call') {
        heldCalls.add(event.id);
      }
      events.push(event);
      conversation += 1;
    }
    // Trimmed as we go rather than at the end: the point of the cap is to bound
    // what is HELD, and a 60k-event array built first would defeat it.
    while (conversation > input.limit) {
      const gone = events.shift() as AgentEvent;
      conversation -= 1;
      dropped += 1;
      if (gone.type === 'tool_call') {
        heldCalls.delete(gone.id);
        if (heldOpens.delete(gone.id)) {
          events.splice(
            events.findIndex(
              (event) =>
                event.type === 'shell_open' && event.toolCallId === gone.id,
            ),
            1,
          );
        }
      }
    }
    return true;
  });
  return { events, droppedBefore: dropped };
}

/**
 * The events one stored line becomes.
 *
 * Only the two line types that carry the conversation are offered to the
 * mapper. The rest of what the CLI appends to a session is either its own
 * bookkeeping (`queue-operation`, `last-prompt`, `file-history-snapshot`) or
 * belongs to a turn that is over (`result`, whose cost and duration describe a
 * turn geniro did not run and must not attribute to one it did).
 *
 * `isSidechain` lines are a sub-agent's own conversation. They are dropped
 * here, and that is a decision rather than an omission: a delegate's rows join
 * the transcript through `parentToolUseId`, which stitches them under the tool
 * call that launched them — a call whose own row may be thousands of lines and
 * one `limit` trim away. Imported alone they would render as orphans in the
 * main thread. A delegate's own background commands go with it, which is the
 * live path's rule too.
 */
function mapHistoryLine(
  line: Record<string, unknown>,
  costLedger: ClaudeSessionCostLedger,
  shells: DetachedShellLog,
): AgentEvent[] {
  if (line.isSidechain === true) {
    return [];
  }
  const type = line.type;
  if (type === 'assistant') {
    shells.noteCalls(line);
    return mapClaudeMessage(line, costLedger);
  }
  if (type !== 'user') {
    return [];
  }
  // A user line carries BOTH halves of the turn boundary: the person's own
  // text, and the tool results the CLI attributes to them. The mapper knows the
  // second (it is the same line a live turn sees) and cannot know the first,
  // because in a live turn the daemon wrote it. So the text is read here and
  // the rest is left to the mapper — never both, or a line holding text and a
  // tool result would be read twice.
  const text = userText(line);
  if (text !== null) {
    return [{ type: 'user_message', text }];
  }
  // The open AFTER the tool result it decorates, the order a live turn writes.
  return [...mapClaudeMessage(line, costLedger), ...shells.opened(line)];
}

/**
 * Which tool calls of one stored conversation put a command in the background.
 * A live turn learns that from `system/task_*` frames, which a session file
 * does not hold, so it is read off the result line's structured
 * `toolUseResult`, never the English sentence. The import closes every launch
 * read here (`closeImportedShells`).
 */
class DetachedShellLog {
  private readonly toolNames = new Map<string, string>();

  noteCalls(line: Record<string, unknown>): void {
    for (const block of contentBlocks(line)) {
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        this.toolNames.set(block.id, block.name);
      }
    }
  }

  opened(line: Record<string, unknown>): AgentEvent[] {
    const result = line.toolUseResult;
    if (typeof result !== 'object' || result === null) {
      return [];
    }
    const callIds = contentBlocks(line)
      .filter((block) => block.type === 'tool_result')
      .map((block) => block.tool_use_id)
      .filter((id): id is string => typeof id === 'string');
    // `toolUseResult` describes ONE call, and nothing says which when a line
    // answers several, so such a line opens nothing rather than guessing.
    if (callIds.length !== 1) {
      return [];
    }
    const toolCallId = callIds[0] as string;
    const key = CLAUDE_DETACHED_LAUNCH_KEYS.get(
      this.toolNames.get(toolCallId) ?? '',
    );
    const workId =
      key === undefined ? undefined : (result as Record<string, unknown>)[key];
    if (typeof workId !== 'string' || workId === '') {
      return [];
    }
    return [{ type: 'shell_open', toolCallId, workId }];
  }
}

/** A line's message content as records, whatever shape it took. */
function contentBlocks(
  line: Record<string, unknown>,
): Record<string, unknown>[] {
  const message = line.message;
  if (typeof message !== 'object' || message === null) {
    return [];
  }
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content)
    ? content.filter(
        (block): block is Record<string, unknown> =>
          typeof block === 'object' && block !== null,
      )
    : [];
}

/**
 * Envelopes the CLI wraps around things that are not the user speaking: the
 * plumbing of a slash command (`<command-name>`, `<command-message>`,
 * `<command-args>`), the output it splices back in (`<local-command-stdout>`,
 * `<local-command-caveat>`), and the context blocks it injects
 * (`<system-reminder>`). All observed in this profile's own files. Plus
 * geniro's own `<geniro-note>`, appended to a prompt it sent
 * (`utils/session-replacement-notes.ts`).
 */
const ENVELOPE_BLOCK =
  /<(command-[a-z-]+|local-command-[a-z-]+|system-reminder|task-notification|geniro-note)>([\s\S]*?)<\/\1>/g;
/**
 * A text block that is wholly the editor's state, which the VS Code / Cursor
 * extension sends with a message (`<ide_opened_file>`, `<ide_selection>`,
 * `<ide_diagnostics>`, matched as a family).
 *
 * The extension records every message as array content whose LAST block is
 * what the user typed, with each context block and picture ahead of it
 * (measured on 4,300 extension lines: none was context alone, none ended in a
 * picture). So a context block is kept only as the last block of the array,
 * where it can only be the user's own words; string content, which the
 * terminal CLI writes, is never filtered. Anchored and greedy because a
 * selection is copied code and may contain a closing tag.
 */
const IDE_CONTEXT_BLOCK = /^<(ide_[a-z_]+)>[\s\S]*<\/\1>$/;
/** The slash command itself, which IS what the user typed. */
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * The person's own words on a `user` line, or null when the line is something
 * else wearing the user role.
 *
 * Four things are NOT the user talking, and each was observed in this profile's
 * own files: a synthetic line the CLI injects after a compaction, a replayed
 * line it re-appends with `isReplay`, a line whose content is entirely
 * `tool_result` blocks, and a line that is only envelopes.
 *
 * A slash command is the interesting case, and it is neither kept whole nor
 * dropped. Whole, it reads as three lines of XML where the transcript wants one
 * line; dropped, a session whose every turn is `/geniro:implement …` becomes an
 * unnamed row in the picker and a transcript of answers to nothing. So the
 * envelopes are stripped and the command is reconstituted as the user typed it.
 * IDE blocks are dropped BEFORE that read, so a command quoted inside a
 * selection can never be taken for one the user ran.
 */
function userText(line: Record<string, unknown>): string | null {
  if (line.isSynthetic === true || line.isReplay === true) {
    return null;
  }
  const message = line.message;
  if (typeof message !== 'object' || message === null) {
    return null;
  }
  const content = (message as Record<string, unknown>).content;
  const raw = (
    typeof content === 'string' ? [content] : withoutIdeContext(content)
  )
    .join('\n')
    .trim();
  if (raw === '') {
    return null;
  }
  const spoken = raw.replace(ENVELOPE_BLOCK, '').trim();
  if (spoken !== '') {
    return spoken;
  }
  const name = COMMAND_NAME.exec(raw)?.[1]?.trim();
  if (name === undefined || name === '') {
    return null;
  }
  const args = COMMAND_ARGS.exec(raw)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

function withoutIdeContext(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const typed = content.length - 1;
  return content.flatMap((block: unknown, index) => {
    const text = blockText(block);
    return text === null ||
      (index !== typed && IDE_CONTEXT_BLOCK.test(text.trim()))
      ? []
      : [text];
  });
}

function joinTextBlocks(content: unknown): string {
  return textBlocks(content).join('\n');
}

/** The text of each `text` block in a message's content, in order. */
function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block: unknown) => {
    const text = blockText(block);
    return text === null ? [] : [text];
  });
}

function blockText(block: unknown): string | null {
  if (typeof block !== 'object' || block === null) {
    return null;
  }
  const record = block as Record<string, unknown>;
  return record.type === 'text' && typeof record.text === 'string'
    ? record.text
    : null;
}

/** Every session file under `<profileDir>/projects`, with its mtime. */
async function collectSessionFiles(profileDir: string): Promise<SessionFile[]> {
  const root = join(profileDir, CLAUDE_SESSIONS_DIR_NAME);
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No profile, or no conversations in it yet.
    return [];
  }
  // Concurrent rather than one await at a time: these are independent round
  // trips to the same disk with nothing between them, and awaiting each in turn
  // made the cost linear in the profile's SIZE — measured on a real profile
  // (380 directories, 563 sessions) the sequential scan took 28ms warm against
  // 5ms this way, and the picker pays it on every open, the listing being
  // deliberately uncached beyond its in-flight join.
  //
  // BOUNDED, at the same width the head reads use, and for the same reason: a
  // `Promise.all` over `dirs` opens one `readdir` per project directory and
  // then one `stat` per file inside it, so on the author's own profile (2,448
  // sessions) the unbounded form has thousands of descriptors outstanding at
  // once. Bounding the outer loop bounds the inner one with it, since each
  // directory's stats only run while that directory holds a slot.
  const perDir: SessionFile[][] = [];
  for (let start = 0; start < dirs.length; start += HEAD_READ_BATCH) {
    perDir.push(
      ...(await Promise.all(
        dirs.slice(start, start + HEAD_READ_BATCH).map(async (dir) => {
          const dirPath = join(root, dir);
          let names: string[];
          try {
            names = await readdir(dirPath);
          } catch {
            return [];
          }
          const stats = await Promise.all(
            names
              .filter((name) => name.endsWith(CLAUDE_SESSION_FILE_SUFFIX))
              .map(async (name): Promise<SessionFile | null> => {
                const path = join(dirPath, name);
                try {
                  const info = await stat(path);
                  if (!info.isFile()) {
                    return null;
                  }
                  return {
                    id: name.slice(0, -CLAUDE_SESSION_FILE_SUFFIX.length),
                    path,
                    dir,
                    updatedAt: Math.round(info.mtimeMs),
                  };
                } catch {
                  // Vanished between readdir and stat.
                  return null;
                }
              }),
          );
          return stats.filter((file): file is SessionFile => file !== null);
        }),
      )),
    );
  }
  return perDir.flat();
}

/**
 * Where one session id lives, or null when this profile does not hold it.
 *
 * The id is a FILENAME, so the answer is one `stat` per project directory
 * rather than a full listing: the caller already knows which session it wants,
 * and re-scanning every file in the profile — plus mtime-ing each — to rediscover
 * a name it was handed is work with no result to show for it.
 *
 * The id therefore reaches a path, which the scan it replaced never let it do,
 * so a separator in it is refused rather than joined. It arrives over HTTP.
 *
 * `cwd`, when the caller has it, names the directory to try FIRST: one `stat`
 * instead of one per project directory. It is only a hint. The flattening is
 * the CLI's undocumented and lossy rule, so a miss — a spelling that differs
 * (`/var` vs `/private/var`), a long path the CLI shortens — falls through to
 * the scan, and a hit is still the file named by the id.
 */
export async function findSessionFile(
  profileDir: string,
  sessionId: string,
  cwd?: string | null,
): Promise<string | null> {
  if (!isPlainSessionId(sessionId)) {
    return null;
  }
  const name = `${sessionId}${CLAUDE_SESSION_FILE_SUFFIX}`;
  const root = join(profileDir, CLAUDE_SESSIONS_DIR_NAME);
  if (cwd !== undefined && cwd !== null && cwd !== '') {
    const guess = join(root, claudeProjectDirName(cwd), name);
    try {
      if ((await stat(guess)).isFile()) {
        return guess;
      }
    } catch {
      // Not filed under that spelling: scan below.
    }
  }
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const hits = await Promise.all(
    dirs.map(async (dir) => {
      const path = join(root, dir, name);
      try {
        return (await stat(path)).isFile() ? path : null;
      } catch {
        return null;
      }
    }),
  );
  return hits.find((path) => path !== null) ?? null;
}

/**
 * The directory the CLI files a folder's sessions under: every character that
 * is not a letter or digit becomes `-` (`/Users/me/.x` → `-Users-me--x`).
 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Session files read at most when {@link readClaudeProjectFolder} looks for a folder. */
const PROJECT_FOLDER_SESSIONS_READ = 3;

/**
 * The folder a project directory stands for, read from a session filed in it,
 * or null when none of its sessions names one that flattens back to it.
 */
export async function readClaudeProjectFolder(
  projectDir: string,
): Promise<string | null> {
  let names: string[];
  try {
    names = (await readdir(projectDir, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(CLAUDE_SESSION_FILE_SUFFIX),
      )
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const dirName = basename(projectDir);
  for (const name of names.slice(0, PROJECT_FOLDER_SESSIONS_READ)) {
    const head = await readSessionHead(join(projectDir, name));
    if (head?.cwd && claudeProjectDirName(head.cwd) === dirName) {
      return head.cwd;
    }
  }
  return null;
}

/**
 * Read a file's opening lines for its folder and its first user message,
 * stopping as soon as both are known.
 *
 * The budget is what makes a 2,448-session listing affordable. It is not a
 * guess about line count: a session's first lines routinely include hook output
 * and a system-reminder block running to tens of kilobytes, so the budget is
 * set in BYTES and a file whose first user message sits past it is treated as
 * having none.
 */
async function readSessionHead(path: string): Promise<SessionHead | null> {
  const head: SessionHead = { cwd: null, title: null };
  const read = await eachJsonLine(
    path,
    CLAUDE_SESSION_HEAD_BUDGET_BYTES,
    (line) => {
      if (
        head.cwd === null &&
        typeof line.cwd === 'string' &&
        line.cwd !== ''
      ) {
        head.cwd = line.cwd;
      }
      if (head.title === null && line.type === 'user') {
        const text = userText(line);
        if (text !== null) {
          head.title = toTitle(text);
        }
      }
      return head.cwd === null || head.title === null;
    },
  );
  return read ? head : null;
}

/** One line of a multi-line prompt, short enough for a picker row. */
function toTitle(text: string): string {
  return titleFromText(text, CLAUDE_SESSION_TITLE_MAX_CHARS);
}

/**
 * Feed each parseable JSON line of a file to `onLine`, stopping when it returns
 * false or `budgetBytes` is spent.
 *
 * Chunked by hand rather than through `readline` so the budget is enforced on
 * BYTES READ — the thing that actually costs — and so a file with no newline in
 * it cannot buffer 11MB while waiting for one. Returns false only when the file
 * could not be opened: an unparseable line is skipped, because one truncated
 * append (a session the CLI was writing when the machine slept) must not cost
 * the whole transcript.
 *
 * `onMalformed` fires for a line that does not parse, and for an unterminated
 * final line even when it parses (the CLI may still be appending to it, so it
 * is not a complete record). The line is still fed to `onLine` when it parses.
 *
 * `contains` skips the `JSON.parse` of every line that lacks that substring,
 * for a caller after a handful of records in a long transcript. A skipped line
 * is not parsed, so it counts as malformed when it is not one balanced object
 * (`isBalancedObject`) — which a torn write never is. The substring is matched
 * against the raw line, so it is ignored when JSON would spell it differently
 * (a quote, backslash or control char).
 */
export async function eachJsonLine(
  path: string,
  budgetBytes: number | null,
  onLine: (line: Record<string, unknown>) => boolean,
  onMalformed?: () => void,
  contains?: string,
): Promise<boolean> {
  const needle =
    contains !== undefined && JSON.stringify(contains).slice(1, -1) === contains
      ? contains
      : undefined;
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return false;
  }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    // Decoded ACROSS reads, never per read. A 64KB boundary falls wherever the
    // byte count lands, so it routinely lands INSIDE a multi-byte character —
    // and `Buffer.toString('utf8')` on a chunk ending mid-character yields
    // U+FFFD for it and drops the trailing bytes, so the next chunk starts on
    // the remainder and mangles that too. The damage is silent, because JSON's
    // own syntax is all ASCII: the line still parses, and the corruption lands
    // in the transcript as a replacement character in whatever the user or the
    // agent actually wrote. A session of the size this file is built for (11MB)
    // crosses ~170 of those boundaries. `StringDecoder` holds the partial bytes
    // back until the read that completes them.
    const decoder = new StringDecoder('utf8');
    let rest = '';
    let read = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      read += bytesRead;
      rest += decoder.write(chunk.subarray(0, bytesRead));
      let cut = rest.indexOf('\n');
      while (cut >= 0) {
        const line = rest.slice(0, cut);
        rest = rest.slice(cut + 1);
        if (line.trim() !== '' && !feed(line, onLine, onMalformed, needle)) {
          return true;
        }
        cut = rest.indexOf('\n');
      }
      if (budgetBytes !== null && read >= budgetBytes) {
        break;
      }
    }
    // Whatever the decoder is still holding: bytes of a character the file (or
    // the byte budget) ended in the middle of. `end()` renders them as U+FFFD,
    // which is the honest reading of a genuinely truncated character — unlike
    // the per-chunk decode above, where the rest of the character was in the
    // very next read.
    rest += decoder.end();
    // The last line of a file the CLI is still appending to has no newline yet.
    if (rest.trim() !== '') {
      onMalformed?.();
      feed(rest, onLine, onMalformed, needle);
    }
    return true;
  } finally {
    await handle.close();
  }
}

/**
 * Whether `line` is one object whose braces and brackets close, read outside
 * string literals — the check a skipped line gets in place of a parse. A
 * write cut off part way leaves something unclosed, even when it happens to
 * end on a nested `}`.
 */
function isBalancedObject(line: string): boolean {
  const text = line.trim();
  if (!text.startsWith('{')) {
    return false;
  }
  let depth = 0;
  let inString = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (inString) {
      if (char === '\\') {
        at += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0 && at !== text.length - 1) {
        return false;
      }
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0 && !inString;
}

function feed(
  line: string,
  onLine: (line: Record<string, unknown>) => boolean,
  onMalformed?: () => void,
  contains?: string,
): boolean {
  if (contains !== undefined && !line.includes(contains)) {
    if (!isBalancedObject(line)) {
      onMalformed?.();
    }
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    onMalformed?.();
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return true;
  }
  return onLine(parsed as Record<string, unknown>);
}

/**
 * Make one conversation readable from a SECOND profile, by putting its file
 * where that profile looks for it.
 *
 * The mechanism behind `ClaudeAdapter.carrySessionToConfigDir`, and it is the
 * whole of what a resume needs: probed on 2.1.237 across two real accounts,
 * `--resume <id>` under a profile that does not hold the file answers
 * `No conversation found with session ID: …`, and answers the conversation’s own
 * codeword the moment the `.jsonl` is copied in.
 *
 * The target directory is the SOURCE file’s own directory NAME, never one
 * composed here — this file’s doc block records that the name is the cwd with
 * its separators flattened, which is lossy and undocumented, so re-deriving it
 * is how a copy would land somewhere the CLI never looks. {@link
 * findSessionFile} is what makes that available: the caller names a session and
 * the store says where it lives, id guard included.
 *
 * A COPY, not a move. The old profile keeps the conversation it genuinely held,
 * which is what the user sees if they open that account’s own `claude` — and a
 * switch that deleted history out of an account nobody asked about would be
 * doing something no button was pressed for. A target that already holds the
 * conversation is brought up to date rather than skipped ({@link carryFile}),
 * or the carry is refused when the two copies have diverged.
 */
export async function carryClaudeSession(input: {
  sessionId: string;
  fromProfileDir: string;
  toProfileDir: string;
}): Promise<{ carried: true } | { carried: false; reason: string }> {
  const { sessionId, fromProfileDir, toProfileDir } = input;
  const source = await findSessionFile(fromProfileDir, sessionId);
  if (source === null) {
    return {
      carried: false,
      reason:
        'the previous profile no longer holds this conversation, so there was nothing to bring across',
    };
  }
  const targetDir = join(
    toProfileDir,
    CLAUDE_SESSIONS_DIR_NAME,
    basename(dirname(source)),
  );
  try {
    await mkdir(targetDir, { recursive: true });
    // The `<id>/` folder beside the transcript holds the sub-agents'
    // transcripts and the tool results the turns spilled to disk (measured on
    // 2.1.284). A resume reads them, so it comes along on the same rule.
    const diverged =
      (await carryFile(source, join(targetDir, basename(source)))) ===
        'diverged' ||
      (await carryTree(
        join(dirname(source), sessionId),
        join(targetDir, sessionId),
      )) === 'diverged';
    if (diverged) {
      return {
        carried: false,
        reason:
          'the two profiles hold different continuations of this conversation',
      };
    }
  } catch (error) {
    return {
      carried: false,
      reason: `the conversation could not be copied into the new profile: ${(error as Error).message}`,
    };
  }
  return { carried: true };
}

/**
 * Copy one transcript file into the other profile, or bring an older copy
 * there up to date.
 *
 * A file of that name already in the target is the SAME conversation (the ids
 * are the CLI's own), carried there before. The files are append-only, so
 * which copy is current is a question of which one extends the other: a target
 * that is a shorter prefix of the source is the copy the conversation moved
 * AWAY from (A→B→A) and is replaced, while one that is as long or longer was
 * appended to since and is kept. Two copies that differ inside their shared
 * length are different continuations, and neither is overwritten. The same
 * rule as codex's carry (`carryCodexSession`).
 *
 * A replacement is written beside the target and renamed over it, so a failure
 * never leaves half a transcript. Two profiles sharing one projects folder
 * through a symlink reach the same file here, which is never shorter than
 * itself, so it is left alone.
 */
async function carryFile(
  from: string,
  to: string,
): Promise<'carried' | 'diverged'> {
  try {
    await copyFile(from, to, constants.COPYFILE_EXCL);
    return 'carried';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const [latest, existing] = await Promise.all([readFile(from), readFile(to)]);
  const shared = Math.min(latest.length, existing.length);
  if (!latest.subarray(0, shared).equals(existing.subarray(0, shared))) {
    return 'diverged';
  }
  if (existing.length >= latest.length) {
    return 'carried';
  }
  const staged = join(dirname(to), `.geniro-carry-${randomUUID()}.tmp`);
  try {
    await writeFile(staged, latest, { flag: 'wx' });
    await rename(staged, to);
  } finally {
    await rm(staged, { force: true });
  }
  return 'carried';
}

/**
 * {@link carryFile} over a whole directory, file by file. An absent folder is
 * fine: a conversation that never delegated or spilled a result has none.
 */
async function carryTree(
  from: string,
  to: string,
): Promise<'carried' | 'diverged'> {
  let entries: Dirent[];
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'carried';
    }
    throw error;
  }
  await mkdir(to, { recursive: true });
  let outcome: 'carried' | 'diverged' = 'carried';
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    const carried = entry.isDirectory()
      ? await carryTree(source, target)
      : entry.isFile()
        ? await carryFile(source, target)
        : 'carried';
    if (carried === 'diverged') {
      outcome = 'diverged';
    }
  }
  return outcome;
}

/**
 * Delete one conversation from a profile: its transcript, and the directory of
 * the same name beside it, which holds the transcripts of the sub-agents it ran
 * and the tool results it spilled to disk (`<id>/subagents`, `<id>/tool-results`
 * — measured on 2.1.284).
 *
 * KEPT, never deleted, when its earliest line predates `notBefore` — the moment
 * the geniro run was created. Every conversation geniro starts begins after its
 * run exists, so one that began earlier was IMPORTED from the user's own
 * terminal, and its file is their CLI history rather than this chat's. Kept as
 * well when no line can be dated: deleting is the irreversible direction, so a
 * file this cannot read about is a file this does not delete.
 *
 * The EARLIEST timestamp in the head, not the first line's: the CLI does not
 * write them in order (a `queue-operation` line stamped after the `attachment`
 * lines it precedes, measured on 2.1.284).
 */
export async function deleteClaudeSession(input: {
  profileDir: string;
  sessionId: string;
  notBefore: Date;
}): Promise<{ deleted: true } | { deleted: false; reason: string }> {
  const { profileDir, sessionId, notBefore } = input;
  const path = await findSessionFile(profileDir, sessionId);
  if (path === null) {
    return { deleted: false, reason: 'the profile holds no such conversation' };
  }
  let earliest: number | null = null;
  await eachJsonLine(path, CLAUDE_SESSION_HEAD_BUDGET_BYTES, (line) => {
    const at =
      typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
    if (Number.isFinite(at) && (earliest === null || at < earliest)) {
      earliest = at;
    }
    return true;
  });
  if (earliest === null) {
    return {
      deleted: false,
      reason: 'the conversation could not be dated, so it was kept',
    };
  }
  if (earliest < notBefore.getTime()) {
    return {
      deleted: false,
      reason:
        'the conversation began before this chat — it was imported from the CLI, so it was kept',
    };
  }
  try {
    await rm(path, { force: true });
    await rm(join(dirname(path), sessionId), { recursive: true, force: true });
  } catch (error) {
    return {
      deleted: false,
      reason: `the conversation could not be deleted: ${(error as Error).message}`,
    };
  }
  return { deleted: true };
}
