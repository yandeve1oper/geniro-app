import { describe, expect, it } from 'vitest';

import {
  CODEX_READ_ONLY_TURN_POLICY,
  codexTurnPolicy,
} from './codex-policy.utils';

// Every case compares the WHOLE policy: an extra writable root, or an
// auto-accept where none was meant, widens where an agent writes without asking
// and would pass a check that named only the fields it expected.

describe('codexTurnPolicy', () => {
  it('runs `auto` unattended: never asks and leaves the sandbox off', () => {
    expect(codexTurnPolicy('auto')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
      plan: false,
      autoAcceptFileChanges: false,
    });
  });

  it('gates `ask` on every untrusted command and patch, inside the workspace sandbox', () => {
    expect(codexTurnPolicy('ask')).toEqual({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      plan: false,
      autoAcceptFileChanges: false,
    });
  });

  it('keeps `ask`’s gate for `acceptEdits` and lets file changes through', () => {
    // The per-turn sandbox is what every turn/start carries, so it is pinned
    // with the thread's: widening it would run each turn unsandboxed.
    expect(codexTurnPolicy('acceptEdits')).toEqual({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      plan: false,
      autoAcceptFileChanges: true,
    });
  });

  it('runs `plan` in codex’s plan mode under a read-only sandbox', () => {
    expect(codexTurnPolicy('plan')).toEqual({
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      plan: true,
      autoAcceptFileChanges: false,
    });
  });

  it('runs a turn naming no mode (an internal probe) read-only with nothing to ask', () => {
    expect(codexTurnPolicy(undefined)).toEqual({
      approvalPolicy: 'never',
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      plan: false,
      autoAcceptFileChanges: false,
    });
  });

  it('runs a read-only turn in the read-only sandbox under untrusted, outside plan mode', () => {
    expect(CODEX_READ_ONLY_TURN_POLICY).toEqual({
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      plan: false,
      autoAcceptFileChanges: false,
    });
  });
});
