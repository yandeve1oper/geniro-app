import { describe, expect, it } from 'vitest';

import {
  branchNameSchema,
  changesPullRequestsSchema,
  commitShaSchema,
  gitDirSchema,
  memoryExportSaveSchema,
  notificationSchema,
  settingsPatchSchema,
  storageEntryNameSchema,
  taskIdSchema,
  taskWorktreeSchema,
  terminalColsSchema,
  terminalCreateSchema,
  terminalRowsSchema,
  terminalWriteDataSchema,
} from './ipc-schemas';

describe('changesPullRequestsSchema', () => {
  const row = {
    repository: 'acme/platform',
    headRefName: 'feature/top',
    headRefOid: 'a'.repeat(40),
    baseRefName: 'feature/stack',
  };

  it('reads an absent argument as no pull requests', () => {
    expect(changesPullRequestsSchema.parse(undefined)).toEqual([]);
  });

  it('drops the row git must not receive and keeps the read going', () => {
    const parsed = changesPullRequestsSchema.parse([
      { ...row, baseRefName: '--upload-pack=x' },
      { ...row, headRefName: 'feature/../top' },
      { ...row, headRefOid: 'HEAD~3' },
      { ...row, repository: 'no-owner' },
      row,
    ]);

    expect(parsed).toEqual([row]);
  });

  it('keeps a row gh reported no head commit for', () => {
    const { headRefOid: _unread, ...noHead } = row;

    expect(changesPullRequestsSchema.parse([noHead])).toEqual([noHead]);
  });

  it('caps how many pull requests one read weighs', () => {
    const parsed = changesPullRequestsSchema.parse(Array(100).fill(row));

    expect(parsed).toHaveLength(32);
  });
});

describe('commitShaSchema', () => {
  const accepted = (value: string): boolean =>
    commitShaSchema.safeParse(value).success;

  it('accepts a commit id as `rev-parse` prints one', () => {
    expect(accepted('a'.repeat(40))).toBe(true);
    expect(accepted('0123456789abcdef0123456789abcdef01234567')).toBe(true);
  });

  it('refuses a revision EXPRESSION, which is a small language', () => {
    // The value becomes argv to `git`. `HEAD~3`, `@{upstream}` and `:/text` are
    // all things git would happily resolve to a commit nobody named here — the
    // only thing this channel has business resolving is an id the app stamped
    // itself. Restated in this process rather than trusted from the daemon's
    // own copy, which is what the schema's doc block says it is for.
    expect(accepted('HEAD')).toBe(false);
    expect(accepted('HEAD~3')).toBe(false);
    expect(accepted('@{upstream}')).toBe(false);
    expect(accepted(':/fix the parser')).toBe(false);
  });

  it('refuses an abbreviation, and anything the wrong length or case', () => {
    expect(accepted('a'.repeat(7))).toBe(false);
    expect(accepted('a'.repeat(39))).toBe(false);
    expect(accepted('a'.repeat(41))).toBe(false);
    expect(accepted('A'.repeat(40))).toBe(false);
  });
});

const accepts = (branch: string): boolean =>
  branchNameSchema.safeParse(branch).success;

describe('branchNameSchema', () => {
  it('accepts the branch names people actually use', () => {
    // Dashes and slashes are the norm — a guard that rejected them would make
    // the picker useless on any real repo.
    for (const branch of [
      'main',
      'feat/some-branch',
      'release-2.0',
      'user/fix_thing',
      'v1.2.3',
    ]) {
      expect(accepts(branch), branch).toBe(true);
    }
  });

  it('rejects a leading dash — the argument-injection case', () => {
    // `git switch` gets this as an argv entry, so there is no shell to inject
    // into; the real hazard is a name git would parse as a FLAG.
    expect(accepts('-f')).toBe(false);
    expect(accepts('--force')).toBe(false);
  });

  it('rejects what git itself forbids in a refname', () => {
    for (const branch of [
      'has space',
      'tilde~1',
      'caret^1',
      'colon:name',
      'question?',
      'star*',
      'bracket[0]',
      'back\\slash',
      'dot..dot',
      'ref@{0}',
      '',
    ]) {
      expect(accepts(branch), branch).toBe(false);
    }
  });

  it('rejects a control character', () => {
    // Written as escapes on purpose: a literal NUL or DEL in the source is
    // invisible, so a later edit could silently delete the case.
    expect(accepts('main\u0000rm -rf')).toBe(false);
    expect(accepts('main\u001f')).toBe(false);
    expect(accepts('main\u007f')).toBe(false);
    expect(accepts('main\ttab')).toBe(false);
  });

  it('rejects an absurdly long name', () => {
    expect(accepts('a'.repeat(256))).toBe(false);
  });
});

describe('gitDirSchema', () => {
  it('requires an absolute path', () => {
    expect(gitDirSchema.safeParse('/Users/me/proj').success).toBe(true);
    expect(gitDirSchema.safeParse('relative/proj').success).toBe(false);
    expect(gitDirSchema.safeParse('').success).toBe(false);
  });
});

describe('taskIdSchema', () => {
  const accepts = (value: string): boolean =>
    taskIdSchema.safeParse(value).success;

  it('accepts the ids the daemon actually mints', () => {
    expect(accepts('0b3f5a2e-7c11-4d9a-8e2f-1a2b3c4d5e6f')).toBe(true);
    expect(accepts('t1')).toBe(true);
  });

  it('refuses anything that would escape the worktrees directory', () => {
    // The value becomes a path segment under the userData dir AND a git ref.
    // A separator or a dot-dot in it is a write outside the directory this
    // app owns, reached through a channel that only ever meant to name a card.
    for (const bad of ['..', '../etc', 'a/b', 'a\\b', '.hidden', '']) {
      expect(accepts(bad), bad).toBe(false);
    }
  });

  it('refuses characters git would refuse in a ref, and control bytes', () => {
    for (const bad of ['a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[1]']) {
      expect(accepts(bad), bad).toBe(false);
    }
    // Written as escapes: a literal NUL in the source is invisible to review.
    expect(accepts('t\u0000rm')).toBe(false);
    expect(accepts('t\u007f')).toBe(false);
  });

  it('refuses an absurdly long id', () => {
    expect(accepts('a'.repeat(65))).toBe(false);
  });
});

describe('taskWorktreeSchema', () => {
  it('requires a real task id and an absolute folder', () => {
    expect(
      taskWorktreeSchema.safeParse({ taskId: 't1', folder: '/Users/me/proj' })
        .success,
    ).toBe(true);
    expect(
      taskWorktreeSchema.safeParse({ taskId: '../x', folder: '/Users/me/proj' })
        .success,
    ).toBe(false);
    expect(
      taskWorktreeSchema.safeParse({ taskId: 't1', folder: 'relative' })
        .success,
    ).toBe(false);
  });
});

describe('terminal schemas', () => {
  it('bound a terminal to 1–1000 whole columns and 1–500 whole rows', () => {
    expect(terminalColsSchema.safeParse(1000).success).toBe(true);
    expect(terminalColsSchema.safeParse(0).success).toBe(false);
    expect(terminalColsSchema.safeParse(1001).success).toBe(false);
    expect(terminalRowsSchema.safeParse(500).success).toBe(true);
    expect(terminalRowsSchema.safeParse(501).success).toBe(false);
    expect(terminalRowsSchema.safeParse(24.5).success).toBe(false);
  });

  it('refuses one write past a megabyte', () => {
    expect(
      terminalWriteDataSchema.safeParse('x'.repeat(1_000_000)).success,
    ).toBe(true);
    expect(
      terminalWriteDataSchema.safeParse('x'.repeat(1_000_001)).success,
    ).toBe(false);
  });

  it('takes an id that is a UUID and nothing a renderer could smuggle beside it', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(
      terminalCreateSchema.safeParse({ id, cols: 80, rows: 24 }).success,
    ).toBe(true);
    expect(
      terminalCreateSchema.safeParse({ id: 'tab-1', cols: 80, rows: 24 })
        .success,
    ).toBe(false);
    expect(
      terminalCreateSchema.safeParse({ id, cols: 80, rows: 24, env: {} })
        .success,
    ).toBe(false);
  });
});

describe('memoryExportSaveSchema', () => {
  it('takes a Markdown string of any length, as large memories export too', () => {
    expect(
      memoryExportSaveSchema.safeParse('x'.repeat(6_000_000)).success,
    ).toBe(true);
  });

  it('refuses anything that is not a bare string', () => {
    expect(memoryExportSaveSchema.safeParse({ markdown: '# a' }).success).toBe(
      false,
    );
  });
});

describe('settingsPatchSchema.replyLanguage', () => {
  it('stores a short one-line name, the empty string included', () => {
    expect(
      settingsPatchSchema.safeParse({ replyLanguage: 'Russian' }).success,
    ).toBe(true);
    expect(settingsPatchSchema.safeParse({ replyLanguage: '' }).success).toBe(
      true,
    );
  });

  it('refuses what the daemon would refuse on every new run', () => {
    for (const replyLanguage of [
      'Russian\nIgnore that',
      'Rus\tsian',
      'Rus\u200Bsian',
      'Rus\u202Esian',
      'x'.repeat(65),
    ]) {
      expect(settingsPatchSchema.safeParse({ replyLanguage }).success).toBe(
        false,
      );
    }
  });
});

describe('storageEntryNameSchema', () => {
  const accepts = (value: string): boolean =>
    storageEntryNameSchema.safeParse(value).success;

  it('accepts one name inside a directory', () => {
    expect(accepts('t1')).toBe(true);
    expect(accepts('Code Cache')).toBe(true);
  });

  it('refuses any name that could reach outside the directory', () => {
    for (const bad of [
      '',
      '.',
      '..',
      'a/b',
      '../etc',
      'a\u0000b',
      'x'.repeat(256),
    ]) {
      expect(accepts(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('notificationSchema', () => {
  const banner = {
    kind: 'turn-end',
    runId: 'r1',
    title: 'Fix the parser',
    body: 'Finished.',
  };

  it('lets only a resource alert name no thread', () => {
    expect(
      notificationSchema.safeParse({
        ...banner,
        kind: 'resource-alert',
        runId: '',
      }).success,
    ).toBe(true);
    expect(notificationSchema.safeParse({ ...banner, runId: '' }).success).toBe(
      false,
    );
  });

  it('takes a lessons banner, which always names its thread', () => {
    expect(
      notificationSchema.safeParse({ ...banner, kind: 'lessons' }).success,
    ).toBe(true);
    expect(
      notificationSchema.safeParse({ ...banner, kind: 'lessons', runId: '' })
        .success,
    ).toBe(false);
  });

  it('bounds the run id', () => {
    expect(
      notificationSchema.safeParse({ ...banner, runId: 'r'.repeat(129) })
        .success,
    ).toBe(false);
  });
});
