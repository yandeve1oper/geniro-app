import type { EntityManager } from '@mikro-orm/sqlite';

import type { ItemDao } from '../../agents/dao/item.dao';
import type { LessonSignal } from '../lessons.types';
import {
  foldLessonSignals,
  LESSON_SIGNAL_ITEM_KINDS,
  type LessonSignalItem,
} from './lesson-signals.fold';

const SIGNAL_PAGE_SIZE = 500;

/** The learning signals of a run after `afterSeq`, up to and including `maxSeq`, paged off the store. */
export async function readLessonSignals(
  itemDao: ItemDao,
  runId: string,
  afterSeq: number,
  maxSeq: number,
  em: EntityManager,
): Promise<LessonSignal[]> {
  const items: LessonSignalItem[] = [];
  let cursor = afterSeq;
  for (;;) {
    const page = await itemDao.analysisPage(
      runId,
      {
        afterSeq: cursor,
        maxSeq,
        limit: SIGNAL_PAGE_SIZE,
        kinds: LESSON_SIGNAL_ITEM_KINDS,
      },
      em,
    );
    items.push(...page);
    if (page.length < SIGNAL_PAGE_SIZE) {
      break;
    }
    cursor = page[page.length - 1]!.seq;
  }
  return foldLessonSignals(items, { afterFinishedTurn: afterSeq >= 0 });
}
