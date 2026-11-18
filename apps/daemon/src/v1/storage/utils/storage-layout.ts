import { DAEMON_PIDFILE_NAME } from '../../../utils/handshake';
import { DAEMON_LOCK_FILE_NAME } from '../../../utils/instance-lock';
import type { AdapterConfig } from '../../agents/adapters/adapter.types';
import { ARTIFACTS_DIR_NAME } from '../../agents/services/artifact-store.service';
import { ATTACHMENTS_DIR_NAME } from '../../agents/services/attachment-store.service';
import { CHAT_UPLOADS_DIR_NAME } from '../../agents/services/chat-upload-store.service';
import { CONTEXT_WINDOWS_FILE_NAME } from '../../agents/services/context-window.store';
import { CALL_MEMBERSHIP_MARKER_FILE } from '../../agents/services/item-call-index.service';
import { MCP_HARVEST_FILE_NAME } from '../../agents/services/mcp-harvest.store';
import { MODEL_PRICES_FILE_NAME } from '../../agents/services/model-price-catalog.service';
import { MODEL_VOCABULARIES_FILE_NAME } from '../../agents/services/model-vocabulary.store';
import { SKILL_HARVEST_FILE_NAME } from '../../agents/services/skill-harvest.store';
import { WALL_WORK_MARKER_FILE } from '../../agents/services/wall-work.service';
import { CHILD_JOURNAL_FILE_NAME } from '../../agents/utils/child-journal';
import { FOLDERLESS_DIR_NAME } from '../../agents/utils/folderless-dir';
import { MANAGER_DIR_NAME } from '../../command-center/utils/manager-folder';
import { DEBUG_LOG_DIR_NAME } from '../../diagnostics/utils/debug-sink';
import { MEMORY_USAGE_MARKER_FILE } from '../../memory/services/memory-usage.service';
import {
  MIGRATION_BACKUPS_DIR,
  MIGRATION_ERROR_FILE,
} from '../../migrations/migrations.types';
import { LEGACY_LIBRARY_DIR } from '../../migrations/utils/m0003-team-library-files';
import { TASK_ATTACHMENTS_DIR_NAME } from '../../tasks/utils/task-attachments';
import { AVATARS_DIR_NAME } from '../../teams/services/avatar-store.service';
import { TEAMS_DIR_NAME } from '../../teams/services/team-store.service';
import type { StorageClassifier, StorageGroupId } from '../storage.types';

export { TEAMS_DIR_NAME };

/**
 * `<userData>/` file whose presence asks the next daemon start to compact the
 * database before it serves anything (`StorageService.compactIfScheduled`).
 *
 * TWIN: the desktop app's `DAEMON_COMPACTION_MARK_NAME` in
 * `apps/ui/src/main/daemon-pidfile.ts`, which waits longer for that start.
 */
export const COMPACTION_MARKER_FILE = 'compact-on-start';

/** The stores whose folders are named after the run that owns them. */
export const RUN_FILE_DIRS = [
  ATTACHMENTS_DIR_NAME,
  ARTIFACTS_DIR_NAME,
] as const;

/**
 * Every agent-agnostic top-level name under the data folder the daemon writes,
 * or that an older build wrote and nothing reads any more, by the group
 * Settings → Storage shows it in. Each CLI's own names come from its adapter
 * (`AdapterConfig.userData`). A name neither knows is the desktop app's
 * (`unclaimed`), never guessed at.
 */
const NAMED: Readonly<Record<string, StorageGroupId>> = {
  'geniro.db': 'database',
  'geniro.db-wal': 'database',
  'geniro.db-shm': 'database',
  'geniro.db-journal': 'database',
  [ATTACHMENTS_DIR_NAME]: 'chatFiles',
  [ARTIFACTS_DIR_NAME]: 'chatFiles',
  [CHAT_UPLOADS_DIR_NAME]: 'chatFiles',
  [TASK_ATTACHMENTS_DIR_NAME]: 'taskFiles',
  [TEAMS_DIR_NAME]: 'teams',
  [AVATARS_DIR_NAME]: 'teams',
  [DEBUG_LOG_DIR_NAME]: 'logs',
  [FOLDERLESS_DIR_NAME]: 'caches',
  [SKILL_HARVEST_FILE_NAME]: 'caches',
  [MCP_HARVEST_FILE_NAME]: 'caches',
  [MODEL_PRICES_FILE_NAME]: 'caches',
  [MODEL_VOCABULARIES_FILE_NAME]: 'caches',
  [CONTEXT_WINDOWS_FILE_NAME]: 'caches',
  [DAEMON_PIDFILE_NAME]: 'appState',
  [DAEMON_LOCK_FILE_NAME]: 'appState',
  [CHILD_JOURNAL_FILE_NAME]: 'appState',
  [CALL_MEMBERSHIP_MARKER_FILE]: 'appState',
  [WALL_WORK_MARKER_FILE]: 'appState',
  [MEMORY_USAGE_MARKER_FILE]: 'appState',
  [COMPACTION_MARKER_FILE]: 'appState',
  [MANAGER_DIR_NAME]: 'appState',
  [MIGRATION_ERROR_FILE]: 'appState',
  [MIGRATION_BACKUPS_DIR]: 'appState',
  [LEGACY_LIBRARY_DIR]: 'appState',
  'task-reports': 'leftovers',
  'task-artifacts': 'leftovers',
  'review-artifacts': 'leftovers',
  'runConfigs-recovered.json': 'leftovers',
  'search-text-backfilled': 'leftovers',
  'task-numbers-backfilled': 'leftovers',
  'workflow-titles-backfilled': 'leftovers',
};

/**
 * Copies of the settings file: the desktop app's own of one it could not read
 * (`settings.json.corrupt-*`, the only copy of what it held) and hand-made
 * ones. Kept apart from leftovers so they are never deleted with them.
 */
const SETTINGS_COPY = /^settings\.json\.(?:bak|corrupt)-[^/]+$/;

export function storageClassifier(
  adapters: readonly Pick<AdapterConfig, 'userData'>[],
): StorageClassifier {
  const named = new Map<string, StorageGroupId>(Object.entries(NAMED));
  const file = (names: readonly string[] | undefined, id: StorageGroupId) => {
    for (const name of names ?? []) {
      named.set(name, id);
    }
  };
  for (const { userData } of adapters) {
    file(userData?.conversations, 'agentSessions');
    file(userData?.caches, 'caches');
    file(userData?.state, 'appState');
    file(userData?.leftovers, 'leftovers');
  }
  return (name) =>
    named.get(name) ?? (SETTINGS_COPY.test(name) ? 'settingsCopies' : null);
}
