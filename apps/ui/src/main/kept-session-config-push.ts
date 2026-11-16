import { DaemonConfigPush } from './daemon-config-push';

/** The body of `PUT /v1/agents/sessions/config`. */
export interface KeptSessionConfig {
  idleMinutes: number;
  limit: number | null;
}

/**
 * Hands the daemon the user's kept-session idle window and limit
 * (`Settings.keptSessionIdleMinutes`, `Settings.keptSessionLimit`,
 * `PUT /v1/agents/sessions/config`) — see {@link DaemonConfigPush}. Until the
 * first push lands the daemon keeps its default hour and automatic limit.
 *
 * TWIN PARSER: `KeptSessionConfigSchema` in `apps/daemon/src/v1/agents/chat.types.ts`.
 */
export class KeptSessionConfigPush extends DaemonConfigPush<KeptSessionConfig> {
  constructor(
    report: (message: string) => void,
    fetchImpl: typeof fetch = fetch,
  ) {
    super(
      {
        path: '/v1/agents/sessions/config',
        what: 'the kept-session settings',
        untilSaved:
          'the daemon keeps its previous settings until they are saved again',
      },
      report,
      fetchImpl,
    );
  }
}
