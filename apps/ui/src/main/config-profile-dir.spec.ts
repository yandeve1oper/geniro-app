import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { configDirSlug, createConfigProfileDir } from './config-profile-dir';

describe('configDirSlug', () => {
  it('turns a display name into one safe path segment', () => {
    expect(configDirSlug('Manifest personal')).toBe('manifest-personal');
    expect(configDirSlug('  ../../etc/passwd ')).toBe('etc-passwd');
    expect(configDirSlug('Ünïcode Wörk')).toBe('unicode-work');
  });

  it('never answers an empty segment', () => {
    expect(configDirSlug('🙂')).toBe('configuration');
  });
});

describe('createConfigProfileDir', () => {
  it('creates the folder under the agent and suffixes a taken name instead of reusing it', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'geniro-config-dir-'));

    const first = await createConfigProfileDir(userData, 'codex', 'Work');
    const second = await createConfigProfileDir(userData, 'codex', 'work');

    expect(first).toBe(join(userData, 'agent-configs', 'codex', 'work'));
    expect(second).toBe(join(userData, 'agent-configs', 'codex', 'work-2'));
    expect(statSync(first).isDirectory()).toBe(true);
    expect(statSync(second).mode & 0o777).toBe(0o700);
  });

  it('skips a name held by a file, not only by a folder', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'geniro-config-dir-'));
    await createConfigProfileDir(userData, 'claude', 'seed');
    writeFileSync(join(userData, 'agent-configs', 'claude', 'home'), '');

    await expect(
      createConfigProfileDir(userData, 'claude', 'home'),
    ).resolves.toBe(join(userData, 'agent-configs', 'claude', 'home-2'));
  });
});
