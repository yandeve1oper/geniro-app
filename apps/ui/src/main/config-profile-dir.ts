import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { CliKind } from '../shared/contracts';

/** Where geniro keeps the configuration folders it creates itself. */
export const CONFIG_PROFILES_DIR_NAME = 'agent-configs';

const MAX_SUFFIX = 999;

/** A folder name from a configuration's display name: lowercase words joined by `-`. */
export function configDirSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug.length > 0 ? slug : 'configuration';
}

/**
 * Creates `<userData>/agent-configs/<agent>/<slug>` and answers its path. The
 * leaf is made without `recursive`, so a folder that already exists is never
 * reused: it may already hold another configuration's login.
 */
export async function createConfigProfileDir(
  userData: string,
  agent: CliKind,
  name: string,
): Promise<string> {
  const parent = join(userData, CONFIG_PROFILES_DIR_NAME, agent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const slug = configDirSlug(name);
  for (let attempt = 1; attempt <= MAX_SUFFIX; attempt += 1) {
    const dir = join(parent, attempt === 1 ? slug : `${slug}-${attempt}`);
    try {
      await mkdir(dir, { mode: 0o700 });
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
  }
  throw new Error(`No free folder name for "${name}" in ${parent}.`);
}
