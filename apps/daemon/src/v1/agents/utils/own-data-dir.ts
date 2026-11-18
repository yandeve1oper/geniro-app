import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { environment } from '../../../environments';

/** A directory of geniro's own, directly under the userData dir. */
export function ownDataDirPath(
  name: string,
  userDataDir: string = environment.userDataDir,
): string {
  return join(userDataDir, name);
}

/** Create an {@link ownDataDirPath} if it is missing, and answer it. */
export function ensureOwnDataDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
