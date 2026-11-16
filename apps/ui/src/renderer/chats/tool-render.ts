import {
  JSON_LANGUAGE,
  languageForPath,
  SHELL_LANGUAGE,
} from '../components/ui/code-language';
import { editDiffOf } from './diff-view';

/**
 * How one tool's input or result should be rendered.
 *
 * Dispatch is SHAPE-FIRST, name-second. The tool NAME is only a fast path:
 * what actually decides the rendering is the payload's shape, so a CLI that
 * calls its shell tool something else still gets a highlighted command, and an
 * unrecognized tool degrades to highlighted JSON rather than a wall of text.
 *
 * TWIN PARSER (shape half): these payloads are the CLIs' own tool arguments —
 * they never pass through a typed daemon response, so no generated type
 * describes them and every field is read defensively. The daemon's matching
 * knowledge lives in each CLI's own `apps/daemon/src/v1/agents/adapters/<cli>/`
 * (see `utils/card-questions.ts` `cardQuestions` for the same pattern on a
 * question card).
 */
export type ToolCodeBody = {
  kind: 'code';
  code: string;
  language: string | null;
  caption: string | null;
};

export type ToolBody =
  | ToolCodeBody
  | {
      kind: 'diff';
      oldText: string | null;
      newText: string;
      caption: string | null;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Pretty JSON that never throws (a payload can hold a cycle). */
function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The file a tool is acting on, under any of the spellings in use.
 *
 * TWIN PARSER: `searchableText` in
 * `apps/daemon/src/v1/agents/utils/searchable-text.ts` reads the same spellings
 * off the same payloads to build the search index. The two cannot share code —
 * this module is renderer-side and pulls in the syntax highlighter — so a
 * spelling added HERE must be added THERE, or the transcript will show a path
 * that a search over the same conversation cannot find.
 */
export function filePathOf(input: unknown): string | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }
  return (
    asText(record.file_path) ??
    asText(record.filePath) ??
    asText(record.path) ??
    asText(record.notebook_path)
  );
}

/**
 * The shell command a tool is running, under any of the spellings in use.
 *
 * Exported for `shell-activity.ts`, which asks the same question of the same
 * payloads for the panel's running-shells list: a second reading of these
 * spellings is how a CLI's `cmd` comes to be highlighted in the transcript and
 * missing from the panel.
 *
 * TWIN PARSER: `searchableText` in
 * `apps/daemon/src/v1/agents/utils/searchable-text.ts`, on the terms
 * {@link filePathOf} states — a spelling added here must be added there too, or
 * the command is searchable in one surface and not the other.
 */
export function commandOf(input: unknown): string | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }
  return asText(record.command) ?? asText(record.cmd) ?? asText(record.script);
}

/**
 * The files a tool call NAMED, when it named any — the ACP `locations` the
 * daemon puts on a `tool_call` row.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/utils/event-to-item.ts` writes this
 * key. An item payload is `z.unknown()` on the wire BY DESIGN, so no generated
 * type spans the two sides — renaming the key there means renaming it here.
 *
 * Read off the PAYLOAD rather than off the call's input, which is what makes it
 * worth having: an ACP agent routinely discloses no arguments at all, so
 * {@link filePathOf} finds nothing and the row names no file. This is the only
 * channel on which such a call says what it touched.
 */
export function toolLocations(
  payload: unknown,
): { path: string; line: number | null }[] {
  const record = asRecord(payload);
  if (!record || !Array.isArray(record.locations)) {
    return [];
  }
  const locations: { path: string; line: number | null }[] = [];
  for (const entry of record.locations) {
    const row = asRecord(entry);
    const path = row ? asText(row.path) : null;
    if (path === null) {
      continue;
    }
    const line = row ? row.line : null;
    locations.push({
      path,
      line: typeof line === 'number' && Number.isFinite(line) ? line : null,
    });
  }
  return locations;
}

/**
 * Those files as a body, for a call that disclosed nothing else.
 *
 * A LAST resort, never a first: a call that showed its diff, its command or its
 * contents has already said more than a path list would. What this covers is
 * the row that would otherwise render empty — which on an ACP agent is most of
 * them.
 *
 * A `code` body rather than a kind of its own: a path is monospace text and the
 * existing renderer already sets it that way, so a fourth `ToolBody` variant
 * would buy a second rendering of the same thing. `language: null` because a
 * path list is not code and highlighting one as though it were is a claim.
 */
export function toolLocationsBody(payload: unknown): ToolBody | null {
  const locations = toolLocations(payload);
  if (locations.length === 0) {
    return null;
  }
  return {
    kind: 'code',
    code: locations
      .map(({ path, line }) => (line === null ? path : `${path}:${line}`))
      .join('\n'),
    language: null,
    caption: null,
  };
}

/**
 * Whether a tool call disclosed any arguments at all.
 *
 * TWIN PARSER: `disclosedInput` in
 * `apps/daemon/src/v1/agents/adapters/acp/acp-driver.ts` makes the same
 * judgement on the daemon side, normalizing an agent-sent empty bag to null
 * before it is persisted. A tool payload never passes through a typed daemon
 * response — every item kind carries a different shape, so the payload is
 * `z.unknown()` on the wire BY DESIGN and no generated type spans the two sides.
 * Both readings must agree: widen one and the other must widen with it.
 *
 * Kept here rather than inlined at each call site because BOTH renderer surfaces
 * that show a call's arguments — the transcript row and the approval card — have
 * to answer it the same way. They did not, briefly: the daemon started sending
 * null and the card rendered the word `null` where it used to render `{}`.
 */
export function disclosesInput(input: unknown): boolean {
  if (input === null || input === undefined) {
    return false;
  }
  const record = asRecord(input);
  return record === null || Object.keys(record).length > 0;
}

/**
 * How to render a tool CALL's input: a diff for an edit, the command for a
 * shell tool, the contents for a write, else the payload as JSON.
 *
 * Null when the call disclosed no arguments at all, so the caller renders NO
 * body rather than a body whose whole content is `{}` or `null`. An ACP agent
 * may name a call and withhold its arguments (measured on cursor-agent for its
 * read/search/edit calls — see `disclosedInput` in the daemon's `acp-driver.ts`),
 * and printing the empty bag stated those as the arguments; the row's header
 * already carries the tool's name, which is the part that is actually known.
 */
export function toolInputBody(
  toolName: string,
  input: unknown,
): ToolBody | null {
  // Reuse the existing edit detection rather than re-deriving it — DiffView is
  // already the shared rendering for Edit/Write on the tool row AND the
  // approval card.
  const diff = editDiffOf(toolName, input);
  if (diff) {
    return {
      kind: 'diff',
      oldText: diff.oldText,
      newText: diff.newText,
      caption: filePathOf(input),
    };
  }
  const command = commandOf(input);
  if (command !== null) {
    const record = asRecord(input);
    return {
      kind: 'code',
      code: command,
      language: SHELL_LANGUAGE,
      caption: record ? asText(record.description) : null,
    };
  }
  const path = filePathOf(input);
  const record = asRecord(input);
  const content = record ? asText(record.content) : null;
  if (path !== null && content !== null) {
    return {
      kind: 'code',
      code: content,
      language: languageForPath(path),
      caption: path,
    };
  }
  // Nothing was disclosed: no diff, no command, no contents, no target, and no
  // remaining payload to show. `prettyJson` would render this as the literal
  // `{}` or `null` — a body that asserts the arguments were empty rather than
  // absent. There is no body.
  if (!disclosesInput(input)) {
    return null;
  }
  // A read/glob/grep-shaped call has nothing but its target — the header line
  // already says the tool name, so show the path as the body's caption and let
  // the rest be the payload.
  return {
    kind: 'code',
    code: prettyJson(input),
    language: JSON_LANGUAGE,
    caption: path,
  };
}

/**
 * The diffs an agent reported as a call's RESULT, or an empty list.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/adapters/acp/acp-driver.ts` normalizes
 * ACP's `{type:'diff', path, oldText, newText}` content blocks into this
 * `{diffs}` shape. A tool payload never passes through a typed daemon response —
 * every item kind carries a different shape, so it is `z.unknown()` on the wire
 * BY DESIGN and no generated type spans the two sides. Rename the key there and
 * this reader must change with it.
 *
 * This is the ONLY thing a cursor edit discloses about itself: its arguments
 * arrive empty and never fill in, while the completing update carries the whole
 * diff, path included. Rendered as JSON it was a wall of escaped newlines; read
 * here it is the same red/green diff a claude `Edit` gets.
 */
export function resultDiffsOf(
  result: unknown,
): { path: string | null; oldText: string | null; newText: string }[] {
  const record = asRecord(result);
  if (!record || !Array.isArray(record.diffs)) {
    return [];
  }
  const diffs: {
    path: string | null;
    oldText: string | null;
    newText: string;
  }[] = [];
  for (const entry of record.diffs) {
    const block = asRecord(entry);
    const newText = block ? block.newText : null;
    if (typeof newText !== 'string') {
      continue;
    }
    diffs.push({
      path: block ? asText(block.path) : null,
      oldText:
        block && typeof block.oldText === 'string' ? block.oldText : null,
      newText,
    });
  }
  return diffs;
}

/**
 * A long absolute path shortened from the FRONT: `…/chat-cwd/notes.txt`.
 *
 * The end is the half that identifies the file, and CSS truncation cuts exactly
 * that off — a row captioned
 * `/private/tmp/claude-501/-Users-…-7d4eb474-…/scrat…` named a directory prefix
 * and never reached the filename. Elided with a leading `…` so it is visible that
 * something was dropped, and callers put the full path on the element's `title`.
 *
 * Short paths are returned verbatim: there is nothing to gain by eliding a path
 * that already fits, and the full one is always the better label.
 */
export function shortenPath(path: string, maxLength = 52): string {
  if (path.length <= maxLength) {
    return path;
  }
  const segments = path.split('/').filter((segment) => segment !== '');
  const tail: string[] = [];
  for (const segment of [...segments].reverse()) {
    // Keep taking segments from the end while the result still fits — so a deep
    // path shows as much CONTEXT as it can rather than the filename alone.
    const candidate = [segment, ...tail].join('/');
    if (candidate.length + 2 > maxLength && tail.length > 0) {
      break;
    }
    tail.unshift(segment);
  }
  return `…/${tail.join('/')}`;
}

/**
 * A tool result as ONE string: a plain string as it stands, a CLI's
 * content-block array collapsed to its texts, anything else as pretty JSON.
 *
 * Lives here rather than in `transcript-groups` (which re-exports it for its
 * existing importers) because `toolResultBody` has to normalize the result
 * ITSELF: a diff cannot survive being stringified before the body is chosen, and
 * a caller passing the text in was the reason it could not be.
 */
export function toolResultText(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (Array.isArray(result)) {
    const texts = result
      .map((block) =>
        block && typeof block === 'object' && 'text' in block
          ? String((block as { text: unknown }).text)
          : null,
      )
      .filter((text): text is string => text !== null);
    if (texts.length > 0 && texts.length === result.length) {
      return texts.join('\n');
    }
  }
  return prettyJson(result);
}

/** What a settled call whose CLI reported no result shows in its place. */
const NO_RESULT_REPORTED = 'No result reported';

/**
 * How to render a tool RESULT: the diff the agent reported, else its text with
 * the language the CALL'S INPUT implies — a file's contents come back bare, with
 * no hint of what they are, so only the path that was read can say. (Which is why
 * the input is a parameter here at all: the result alone is not enough.)
 */
export function toolResultBody(input: unknown, result: unknown): ToolBody {
  if (result === null || result === undefined) {
    return {
      kind: 'code',
      code: NO_RESULT_REPORTED,
      language: null,
      caption: null,
    };
  }
  const diffs = resultDiffsOf(result);
  const [first, ...rest] = diffs;
  if (first) {
    // A body is ONE diff (a `ToolBody` has no list form, and no call site renders
    // several), and every cursor edit call measured carries exactly one. A second
    // is therefore not dropped quietly: the caption SAYS what is not on screen,
    // rather than leaving a reader to believe they have seen the whole change.
    return {
      kind: 'diff',
      oldText: first.oldText,
      newText: first.newText,
      caption:
        rest.length === 0
          ? first.path
          : `${first.path ?? 'diff'} · ${rest.length} more file${rest.length === 1 ? '' : 's'} changed, not shown`,
    };
  }
  const text = toolResultText(result);
  if (commandOf(input) !== null) {
    // Command OUTPUT is not shell source — highlighting it as bash would paint
    // arbitrary words as keywords. Plain, but still in the code surface.
    return { kind: 'code', code: text, language: null, caption: null };
  }
  const path = filePathOf(input);
  if (path !== null && typeof result === 'string') {
    return {
      kind: 'code',
      code: stripLineNumbers(text),
      language: languageForPath(path),
      caption: null,
    };
  }
  return {
    kind: 'code',
    code: text,
    language: typeof result === 'string' ? null : JSON_LANGUAGE,
    caption: null,
  };
}

/**
 * Drop the `cat -n` gutter a file read comes back with (`␣␣␣␣␣1→body`), so the
 * contents highlight as the language they are instead of as numbered noise.
 * Only applied when EVERY non-empty line carries one — a file that happens to
 * start with numbers keeps its text.
 */
export function stripLineNumbers(text: string): string {
  const lines = text.split('\n');
  const gutter = /^\s*\d+\t(.*)$/;
  const stripped: string[] = [];
  for (const line of lines) {
    if (line === '') {
      stripped.push(line);
      continue;
    }
    const match = gutter.exec(line);
    if (!match) {
      return text;
    }
    stripped.push(match[1] ?? '');
  }
  return stripped.join('\n');
}

/**
 * A tool identifier as a reader should see it: `mcp__linear__get_issue` →
 * "Linear: Get issue".
 *
 * Ported from geniro web's `formatToolName` (`components/ui/thread-blocks.tsx`)
 * so a tool row reads the same in both apps. Only the MCP triple-underscore
 * shape is rewritten — every other name is returned verbatim, because a
 * built-in's identifier (`Bash`, `WebFetch`) is the name the user knows it by
 * and "prettifying" it would only make it harder to match against the CLI's own
 * output.
 */
export function formatToolName(toolName: string): string {
  const parsed = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (!parsed) {
    return toolName;
  }
  const [, server = '', tool = ''] = parsed;
  const capitalize = (text: string): string =>
    text.length > 0 ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
  return `${capitalize(server)}: ${capitalize(tool.replace(/_/g, ' '))}`;
}
