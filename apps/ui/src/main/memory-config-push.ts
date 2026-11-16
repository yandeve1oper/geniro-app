import type { MemorySettings, Settings } from '../shared/contracts';
import { DaemonConfigPush } from './daemon-config-push';

/** The body of `PUT /v1/memories/config`. */
export interface MemoryConfig extends MemorySettings {
  autoForgetAfterDays: number | null;
  removeNotUseful: boolean;
}

/** The memory settings and the two top-level sweep switches, as the daemon takes them. */
export function memoryConfigOf(
  settings: Pick<
    Settings,
    'memory' | 'memoryAutoForgetAfterDays' | 'memoryRemoveNotUseful'
  >,
): MemoryConfig {
  return {
    ...settings.memory,
    autoForgetAfterDays: settings.memoryAutoForgetAfterDays,
    removeNotUseful: settings.memoryRemoveNotUseful,
  };
}

/**
 * Hands the daemon the user's memory settings (`PUT /v1/memories/config`) — see
 * {@link DaemonConfigPush}. Until the first push lands the daemon keeps memory
 * on with agent writes active and no auto-forget.
 *
 * TWIN PARSER: `MemoryConfigSchema` in `apps/daemon/src/v1/memory/memory.types.ts`.
 */
export class MemoryConfigPush extends DaemonConfigPush<MemoryConfig> {
  constructor(
    report: (message: string) => void,
    fetchImpl: typeof fetch = fetch,
  ) {
    super(
      {
        path: '/v1/memories/config',
        what: 'the memory settings',
        untilSaved:
          'the daemon keeps its previous memory settings until they are saved again',
      },
      report,
      fetchImpl,
    );
  }
}
