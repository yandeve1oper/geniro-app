import type { LessonsSettings } from '../shared/contracts';
import { DaemonConfigPush } from './daemon-config-push';

/**
 * Hands the daemon the user's lessons settings (`PUT /v1/lessons/config`) — see
 * {@link DaemonConfigPush}. Until the first push lands the daemon offers
 * reflections and runs them with the thread's own CLI.
 *
 * TWIN PARSER: `LessonsConfigSchema` in `apps/daemon/src/v1/lessons/lessons.types.ts`.
 */
export class LessonsConfigPush extends DaemonConfigPush<LessonsSettings> {
  constructor(
    report: (message: string) => void,
    fetchImpl: typeof fetch = fetch,
  ) {
    super(
      {
        path: '/v1/lessons/config',
        what: 'the lessons settings',
        untilSaved:
          'the daemon keeps its previous lessons settings until they are saved again',
      },
      report,
      fetchImpl,
    );
  }
}
