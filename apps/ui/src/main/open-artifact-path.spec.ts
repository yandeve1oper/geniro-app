import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openPath: vi.fn(async (_path: string) => ''),
  showItemInFolder: vi.fn(),
}));

vi.mock('electron', () => ({
  shell: {
    openPath: mocks.openPath,
    showItemInFolder: mocks.showItemInFolder,
  },
}));

const { openArtifactPath } = await import('./open-artifact-path');

let root: string;

beforeEach(() => {
  mocks.openPath.mockClear();
  mocks.showItemInFolder.mockClear();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'open-artifact-path-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function folder(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

describe('openArtifactPath', () => {
  it('opens a plain folder in Finder', async () => {
    const reports = folder('reports');

    expect(await openArtifactPath(reports)).toEqual({ shown: 'opened' });
    expect(mocks.openPath).toHaveBeenCalledWith(reports);
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

  it('reveals a file rather than opening it', async () => {
    const script = join(root, 'run.command');
    writeFileSync(script, '#!/bin/sh\n');

    expect(await openArtifactPath(script)).toEqual({ shown: 'revealed' });
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(script);
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('reveals a package folder, by its extension — a hidden name too — or a Contents folder, rather than launching it', async () => {
    const app = folder('Tool.app');
    const hidden = folder('.Tool.app');
    const bare = folder('Bare', 'Contents');

    await openArtifactPath(app);
    await openArtifactPath(hidden);
    await openArtifactPath(join(bare, '..'));

    expect(mocks.showItemInFolder.mock.calls).toEqual([
      [app],
      [hidden],
      [join(root, 'Bare')],
    ]);
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('judges a link by where it leads, so a plain name pointing at an app is only revealed', async () => {
    const app = folder('Tool.app');
    const link = join(root, 'Applications');
    symlinkSync(app, link);

    expect(await openArtifactPath(link)).toEqual({ shown: 'revealed' });
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(app);
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('opens a dot-folder, whose leading dot is not an extension', async () => {
    const hidden = folder('.config');

    expect(await openArtifactPath(hidden)).toEqual({ shown: 'opened' });
  });

  it('answers a reason for a path with nothing at it, and shows nothing', async () => {
    expect(await openArtifactPath(join(root, 'gone'))).toEqual({
      shown: null,
      reason: 'nothing is at that path',
    });
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

  it('passes on the reason Finder could not open a folder', async () => {
    mocks.openPath.mockResolvedValueOnce('Permission denied');

    expect(await openArtifactPath(folder('locked'))).toEqual({
      shown: null,
      reason: 'Permission denied',
    });
  });
});
