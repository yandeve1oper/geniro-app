import type { EntityManager } from '@mikro-orm/sqlite';

import type { ItemDao } from '../../agents/dao/item.dao';
import { parseJsonColumn } from '../../agents/utils/json-util';
import type { Run } from '../../runs/entity/run.entity';

const REASON_MAX_CHARS = 300;

/**
 * Why a hidden lessons chat ended without its answer, in words the Settings
 * readout can show: the newest error it wrote (a signed-out profile, a model
 * the account cannot use), else `fallback`.
 */
export async function runFailureOf(
  itemDao: ItemDao,
  run: Pick<Run, 'id'> | null,
  fallback: string,
  em: EntityManager,
): Promise<string> {
  if (run === null) {
    return fallback;
  }
  const items = await itemDao.getByRun(run.id, -1, em);
  const error = items.findLast((item) => item.kind === 'error');
  if (error === undefined) {
    return fallback;
  }
  const payload = parseJsonColumn(error.payload);
  const message =
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as Record<string, unknown>).message === 'string'
      ? ((payload as Record<string, unknown>).message as string)
      : null;
  if (message === null || message.trim() === '') {
    return fallback;
  }
  const line = message.trim().replace(/\s+/g, ' ');
  return line.length > REASON_MAX_CHARS
    ? `${line.slice(0, REASON_MAX_CHARS - 1)}…`
    : line;
}
