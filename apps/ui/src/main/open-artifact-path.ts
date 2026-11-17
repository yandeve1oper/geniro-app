import { existsSync, realpathSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import { shell } from 'electron';

import type { ArtifactPathOutcome } from '../shared/contracts';

/**
 * Show a folder or file a button on an agent's page named, in Finder.
 *
 * A plain folder OPENS in a Finder window; anything else is REVEALED — selected in
 * its folder, never handed to LaunchServices, so a button cannot start a program.
 * That is why the test is on the real path (a link named like a folder can lead to
 * an app) and why a folder whose name carries an extension (`Tool.app`,
 * `.Tool.app`, `Notes.bundle`, `v1.2` too) or that holds a `Contents` folder counts
 * as a package: opening a package is what launches it, and a dotted name is the
 * one LaunchServices reads as one.
 *
 * The path is the agent's, and the page is not trusted: the renderer passes one on
 * only for a click inside the page, and the worst a path can do here is show a
 * Finder window.
 */
export async function openArtifactPath(
  target: string,
): Promise<ArtifactPathOutcome> {
  let real: string;
  let isDirectory: boolean;
  try {
    real = realpathSync(target);
    isDirectory = statSync(real).isDirectory();
  } catch {
    return { shown: null, reason: 'nothing is at that path' };
  }
  if (isDirectory && !isPackage(real)) {
    const failure = await shell.openPath(real);
    return failure === ''
      ? { shown: 'opened' }
      : { shown: null, reason: failure };
  }
  shell.showItemInFolder(real);
  return { shown: 'revealed' };
}

function isPackage(dir: string): boolean {
  return extname(dir) !== '' || existsSync(join(dir, 'Contents'));
}
