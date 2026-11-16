import type { RunListPage } from '../chat.types';
import type { ListChatsQueryDto } from '../dto/chat.dto';
import { activityWindowOf } from './run-activity';

/** The DAO page a listing query names. */
export function runListPageOf(query: ListChatsQueryDto): RunListPage {
  const active = activityWindowOf(query);
  return {
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.beforeCreatedAt === undefined || query.beforeId === undefined
      ? {}
      : {
          before: {
            createdAt: new Date(query.beforeCreatedAt),
            id: query.beforeId,
          },
        }),
    ...(query.runId === undefined ? {} : { runId: query.runId }),
    ...(active === undefined ? {} : { active }),
  };
}
