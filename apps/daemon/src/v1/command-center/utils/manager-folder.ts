import {
  ensureOwnDataDir,
  ownDataDirPath,
} from '../../agents/utils/own-data-dir';

/** The manager chat's working folder's name under the userData dir. */
export const MANAGER_DIR_NAME = 'command-center';

/**
 * Where the manager chat runs: an empty folder of geniro's own, so no
 * project's files, instructions or MCP config reach it, and the folder it
 * names is not the user's home.
 */
export function managerFolderPath(userDataDir?: string): string {
  return ownDataDirPath(MANAGER_DIR_NAME, userDataDir);
}

/** {@link managerFolderPath}, created when missing. */
export function ensureManagerFolder(
  path: string = managerFolderPath(),
): string {
  return ensureOwnDataDir(path);
}
