import type { AcpConversationReading } from '../../acp/acp-driver';
import {
  readCursorStoreRoot,
  readProtoFields,
  readStoreBlob,
} from './cursor-context-store.utils';

/**
 * The conversation cursor has SAVED for a session, read from the same store
 * as the context breakdown. Observed on 2026.11.05-86047df across 60 stores:
 * the root blob opens with one field-1 entry per message, each the 32-byte id
 * of a blob holding that message as JSON (`{role, content}`), in order.
 */
const ROOT_MESSAGE_FIELD = 1;
const BLOB_ID_BYTES = 32;

/** The message blob ids the root lists, in order, or null when one is not an id. */
export function cursorConversationMessageIds(
  root: Uint8Array,
): string[] | null {
  const ids: string[] = [];
  for (const field of readProtoFields(root)) {
    if (field.number !== ROOT_MESSAGE_FIELD) {
      continue;
    }
    if (
      !(field.value instanceof Uint8Array) ||
      field.value.length !== BLOB_ID_BYTES
    ) {
      return null;
    }
    ids.push(Buffer.from(field.value).toString('hex'));
  }
  return ids;
}

/** The text of a user message blob, or null for any other role or shape. */
export function cursorUserMessageText(blob: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(blob).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const { role, content } = parsed as { role?: unknown; content?: unknown };
  if (role !== 'user') {
    return null;
  }
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const texts = content.flatMap((part: unknown) => {
    const text = (part as { type?: unknown; text?: unknown } | null)?.text;
    return (part as { type?: unknown } | null)?.type === 'text' &&
      typeof text === 'string'
      ? [text]
      : [];
  });
  return texts.length > 0 ? texts.join('\n') : null;
}

/**
 * How long the saved conversation is, and the text of its user messages from
 * `fromMessage` on — only those blobs are read. A session with no checkpoint
 * yet has saved nothing.
 */
export function readCursorConversation(
  storePath: string,
  fromMessage: number,
  warn?: (message: string) => void,
): AcpConversationReading | null {
  return readCursorStoreRoot(
    storePath,
    warn,
    (root, db) => {
      const ids = cursorConversationMessageIds(root);
      if (ids === null) {
        return null;
      }
      const userTexts: string[] = [];
      for (const id of ids.slice(fromMessage)) {
        const blob = readStoreBlob(db, id);
        const text = blob === null ? null : cursorUserMessageText(blob);
        if (text !== null) {
          userTexts.push(text);
        }
      }
      return { messages: ids.length, userTexts };
    },
    { messages: 0, userTexts: [] },
  );
}
