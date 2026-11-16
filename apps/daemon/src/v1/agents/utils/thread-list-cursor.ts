import { z } from 'zod';

import type { ThreadListCursor } from '../chat.types';

const CursorSchema = z.object({
  rank: z.number().int().min(0),
  sortAt: z.number().int(),
  id: z.string().min(1),
});

export function encodeThreadListCursor(cursor: ThreadListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeThreadListCursor(text: string): ThreadListCursor | null {
  try {
    const parsed = CursorSchema.safeParse(
      JSON.parse(Buffer.from(text, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
