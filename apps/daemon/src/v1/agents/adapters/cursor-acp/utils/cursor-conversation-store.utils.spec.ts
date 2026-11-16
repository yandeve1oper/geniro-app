import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  cursorConversationMessageIds,
  cursorUserMessageText,
  readCursorConversation,
} from './cursor-conversation-store.utils';

const ROOT_ID = '7f1c0e2a-root-of-this-session';

const idOf = (label: string): string =>
  createHash('sha256').update(label).digest('hex');

function rootOf(
  messageIds: readonly string[],
  extra: number[] = [],
): Uint8Array {
  const parts = messageIds.flatMap((id) => [
    0x0a,
    0x20,
    ...Buffer.from(id, 'hex'),
  ]);
  return new Uint8Array([...parts, ...extra]);
}

const message = (role: string, content: unknown): Uint8Array =>
  new Uint8Array(Buffer.from(JSON.stringify({ role, content })));

function writeStore(
  root: Uint8Array,
  blobs: Record<string, Uint8Array>,
  latestRootBlobId: string = ROOT_ID,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-conversation-'));
  const path = join(dir, 'store.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE meta (value TEXT)');
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  db.prepare('INSERT INTO meta (value) VALUES (?)').run(
    Buffer.from(JSON.stringify({ latestRootBlobId, agentId: 'a' })).toString(
      'hex',
    ),
  );
  const insert = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
  insert.run(ROOT_ID, root);
  for (const [id, data] of Object.entries(blobs)) {
    insert.run(id, data);
  }
  db.close();
  return path;
}

describe('cursorConversationMessageIds', () => {
  it('lists the field-1 blob ids in order and skips the root’s other fields', () => {
    const ids = [idOf('system'), idOf('user'), idOf('assistant')];

    expect(cursorConversationMessageIds(rootOf(ids, [0x18, 0x07]))).toEqual(
      ids,
    );
  });

  it('reads a root whose field 1 is not a blob id as unrecognised', () => {
    expect(
      cursorConversationMessageIds(new Uint8Array([0x0a, 0x02, 0x61, 0x62])),
    ).toBeNull();
  });
});

describe('cursorUserMessageText', () => {
  it('joins the text parts of a user message', () => {
    expect(
      cursorUserMessageText(
        message('user', [
          { type: 'text', text: '<user_query>\ndo the thing\n</user_query>' },
          { type: 'image', data: 'x' },
        ]),
      ),
    ).toBe('<user_query>\ndo the thing\n</user_query>');
  });

  it('reads a user message whose content is a plain string', () => {
    expect(cursorUserMessageText(message('user', '<user_info>'))).toBe(
      '<user_info>',
    );
  });

  it('ignores every other role and anything that is not JSON', () => {
    expect(
      cursorUserMessageText(
        message('assistant', [{ type: 'text', text: 'do the thing' }]),
      ),
    ).toBeNull();
    expect(
      cursorUserMessageText(new Uint8Array([0x0a, 0x20, 0x01])),
    ).toBeNull();
  });
});

describe('readCursorConversation', () => {
  const ids = [
    idOf('system'),
    idOf('user-info'),
    idOf('wake'),
    idOf('assistant'),
    idOf('continue'),
  ];
  const blobs = {
    [ids[0]!]: message('system', 'You are an AI coding assistant.'),
    [ids[1]!]: message('user', '<user_info>'),
    [ids[2]!]: message('user', [{ type: 'text', text: 'the wake prompt' }]),
    [ids[3]!]: message('assistant', [
      { type: 'text', text: 'the wake prompt' },
    ]),
    [ids[4]!]: message('user', [{ type: 'text', text: 'continue' }]),
  };

  it('answers the length and the user messages from the index on', () => {
    const path = writeStore(rootOf(ids), blobs);

    expect(readCursorConversation(path, 2)).toEqual({
      messages: 5,
      userTexts: ['the wake prompt', 'continue'],
    });
    expect(readCursorConversation(path, 3)).toEqual({
      messages: 5,
      userTexts: ['continue'],
    });
    expect(readCursorConversation(path, Number.MAX_SAFE_INTEGER)).toEqual({
      messages: 5,
      userTexts: [],
    });
  });

  it('skips a message whose blob is missing', () => {
    const { [ids[2]!]: _wake, ...withoutWake } = blobs;
    const path = writeStore(rootOf(ids), withoutWake);

    expect(readCursorConversation(path, 0)?.userTexts).toEqual([
      '<user_info>',
      'continue',
    ]);
  });

  it('answers an empty conversation for a session with no checkpoint yet', () => {
    const path = writeStore(rootOf(ids), blobs, '');

    expect(readCursorConversation(path, 0)).toEqual({
      messages: 0,
      userTexts: [],
    });
  });

  it('answers null for a root it does not recognise', () => {
    const path = writeStore(new Uint8Array([0x0a, 0x02, 0x61, 0x62]), blobs);

    expect(readCursorConversation(path, 0)).toBeNull();
  });

  it('answers null and creates nothing for a store that is not there', () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'cursor-conversation-')),
      'store.db',
    );

    expect(readCursorConversation(path, 0)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });
});
