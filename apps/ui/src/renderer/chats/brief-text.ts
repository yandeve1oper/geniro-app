/** Emphasis markers only count at word edges, so `src/**\/*.ts` and `__init__` survive. */
const OPEN_EDGE = String.raw`(^|[\s(\[{"'«—])`;
// Punctuation closes emphasis only when the sentence goes on after it — the
// `.` in `__init__.py` is a file extension, not the end of a phrase.
const CLOSE_EDGE = String.raw`(?=$|[\s)\]}"'»—…]|[.,;:!?](?:[\s)\]}"'»—…]|$))`;
const PAIRED_EMPHASIS = [
  new RegExp(
    String.raw`${OPEN_EDGE}(\*\*|__)(?=\S)(.+?)(?<=\S)\2${CLOSE_EDGE}`,
    'g',
  ),
  new RegExp(
    String.raw`${OPEN_EDGE}(\*|_)(?=\S)([^*_\n]+?)(?<=\S)\2${CLOSE_EDGE}`,
    'g',
  ),
];

/** Unwrap one emphasis match — except `__x__` around a bare identifier, a dunder name. */
function unwrap(
  match: string,
  edge: string,
  marker: string,
  content: string,
): string {
  return marker === '__' && /^\w+$/.test(content) ? match : edge + content;
}

/** One line's markers removed, with inline code left exactly as written. */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}>\s?/, '')
    .split(/(`[^`\n]+`)/)
    .map((part) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 1
        ? part.slice(1, -1)
        : PAIRED_EMPHASIS.reduce(
            (text, pattern) => text.replace(pattern, unwrap),
            part
              // An IMAGE first, or the link rule below leaves its `!` behind.
              .replace(/!\[([^\]\n]*)\]\([^)\s]+\)/g, '$1')
              .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1'),
          ),
    )
    .join('');
}

/**
 * Agent-written markdown as plain text — its MARKERS removed, its words and
 * line breaks kept. For single-line and clamped places where a markdown
 * renderer does not belong (a call's brief, its latest words), where
 * `**DO NOT PARK A QUESTION.**` otherwise reaches the screen with its
 * asterisks. Emphasis is only removed where it is PAIRED at word edges, and
 * never inside a code span, so paths, globs and identifiers survive intact.
 */
export function plainMarkdownText(markdown: string): string {
  return markdown.split('\n').map(plainLine).join('\n');
}

/**
 * Agent-written markdown as ONE line of plain text — the sidebar's preview.
 *
 * The row printed the message raw and let CSS collapse it, so a reply opening
 * with a bolded heading and a bullet list read `**Google Docs read:** -
 * **Read:** Sag…`, and one showing a picture read `![the app i…`. Markers go,
 * list bullets go, code fences go, and the lines are joined with a space.
 */
export function plainPreview(markdown: string): string {
  const unfenced = markdown
    .split('\n')
    .filter((line) => !/^\s*(?:`{3,}|~{3,})/.test(line))
    .join('\n');
  return plainMarkdownText(unfenced)
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length > 0 && !/^(?:[-*_]\s*){3,}$/.test(line))
    .join(' ');
}

/** A brief split for a heading: its first line, and whatever follows it. */
export interface BriefParts {
  /** The first non-blank line — what the heading states. */
  title: string;
  /** The lines after it, blank ends trimmed; empty when the brief is one line. */
  rest: string[];
}

export function briefParts(markdown: string): BriefParts {
  const lines = plainMarkdownText(markdown)
    .split('\n')
    .map((line) => line.trim());
  const first = lines.findIndex((line) => line.length > 0);
  if (first === -1) {
    return { title: '', rest: [] };
  }
  const rest = lines.slice(first + 1);
  while (rest.length > 0 && rest[0] === '') {
    rest.shift();
  }
  while (rest.length > 0 && rest.at(-1) === '') {
    rest.pop();
  }
  return { title: lines[first]!, rest };
}

/**
 * The line as a web link when it is NOTHING but one — a ticket URL a caller
 * pasted on its own line, which wrapped across three lines of a 280px panel.
 */
export function bareUrl(line: string): URL | null {
  if (!/^https?:\/\/\S+$/.test(line)) {
    return null;
  }
  try {
    return new URL(line);
  } catch {
    return null;
  }
}
