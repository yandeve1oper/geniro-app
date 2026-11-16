import type { ArtifactEdit } from '../chat.types';

export type ArtifactEditsResult =
  { ok: true; text: string } | { ok: false; reason: string };

export function applyArtifactEdits(
  text: string,
  edits: readonly ArtifactEdit[],
  version: number,
  maxBytes: number,
): ArtifactEditsResult {
  let current = text;
  for (const [index, edit] of edits.entries()) {
    const label = `edit ${index + 1}`;
    const count = occurrences(current, edit.oldString);
    if (count === 0) {
      const where =
        index === 0
          ? `version ${version}`
          : `version ${version} once the edits before it were applied`;
      return {
        ok: false,
        reason: `${label}: old_string was not found in ${where} — copy it exactly from the page as you published it`,
      };
    }
    if (count > 1 && !edit.replaceAll) {
      return {
        ok: false,
        reason: `${label}: old_string occurs ${count} times — include more of the text around it so it names one place, or set replace_all`,
      };
    }
    const replaced = edit.replaceAll ? count : 1;
    const length =
      current.length +
      replaced * (edit.newString.length - edit.oldString.length);
    if (length > maxBytes) {
      return { ok: false, reason: oversize(label, maxBytes) };
    }
    current = edit.replaceAll
      ? current.split(edit.oldString).join(edit.newString)
      : replaceFirst(current, edit.oldString, edit.newString);
    if (Buffer.byteLength(current, 'utf8') > maxBytes) {
      return { ok: false, reason: oversize(label, maxBytes) };
    }
  }
  return { ok: true, text: current };
}

function oversize(label: string, maxBytes: number): string {
  return `${label}: the page would be over the ${Math.floor(maxBytes / 1024)}KB limit — publish a smaller one`;
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  for (
    let at = text.indexOf(needle);
    at !== -1;
    at = text.indexOf(needle, at + needle.length)
  ) {
    count += 1;
  }
  return count;
}

function replaceFirst(text: string, needle: string, replacement: string) {
  const at = text.indexOf(needle);
  return text.slice(0, at) + replacement + text.slice(at + needle.length);
}
