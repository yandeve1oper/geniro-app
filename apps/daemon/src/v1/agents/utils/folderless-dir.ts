import { ensureOwnDataDir, ownDataDirPath } from './own-data-dir';

/** The directory's name under the userData dir. */
export const FOLDERLESS_DIR_NAME = 'mcp-folderless';

/**
 * Where a folder-INDEPENDENT MCP command runs.
 *
 * A team is edited long before it runs anywhere, so the builder has no
 * folder to ask about, and the honest answer to "which servers would this member
 * load" is the set that does not depend on one — the user's global servers plus
 * whatever the member's own profile directory brings. Running in geniro's own
 * empty directory is how that set is obtained: no project `.mcp.json` can
 * reach it, so nothing a folder would contribute is counted.
 *
 * It is shared rather than resolved twice because the LISTING and the SIGN-IN
 * have to agree about it. A CLI resolves a server NAME against the folder it
 * runs in, so a sign-in started anywhere else would authenticate a different
 * server or none at all — signing in from the same empty directory the listing
 * was taken in is what makes the rows and the action describe one thing.
 *
 * What must NOT be resolved here is the on/off TOGGLE: both CLIs store that
 * per folder (claude in `projects[<cwd>].disabledMcpServers`), so switching a
 * server off against this directory would write a decision about geniro's
 * scratch folder and change nothing about the folder the team actually
 * runs in.
 */
export function folderlessDirPath(userDataDir?: string): string {
  return ownDataDirPath(FOLDERLESS_DIR_NAME, userDataDir);
}

/** {@link folderlessDirPath}, created on first use. */
export function ensureFolderlessDir(
  path: string = folderlessDirPath(),
): string {
  return ensureOwnDataDir(path);
}
