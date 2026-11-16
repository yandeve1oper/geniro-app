import type { AgentApprovalMode } from '../../adapter.types';
import type { CodexSandboxPolicy, CodexTurnPolicy } from '../codex.types';

const READ_ONLY: CodexSandboxPolicy = {
  type: 'readOnly',
  networkAccess: false,
};

/**
 * The workspace-write sandbox codex runs under by default: writes confined to
 * the turn's folder (no extra roots), network off. A command that needs more
 * asks to run outside the sandbox, and that request is the approval the user
 * answers.
 */
const WORKSPACE_WRITE: CodexSandboxPolicy = {
  type: 'workspaceWrite',
  writableRoots: [],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
};

/**
 * A read-only turn's posture (`AgentTurnInput.readOnly`), whatever its mode:
 * the read-only sandbox under `untrusted`, so every write fails and every
 * command or patch outside codex's safe reads asks, outside plan mode.
 */
export const CODEX_READ_ONLY_TURN_POLICY: CodexTurnPolicy = {
  approvalPolicy: 'untrusted',
  sandbox: 'read-only',
  sandboxPolicy: READ_ONLY,
  plan: false,
  autoAcceptFileChanges: false,
};

/**
 * What one geniro approval mode means to codex.
 *
 * - `auto` — `never` asks, and no sandbox: the unattended posture, as claude's
 *   `--dangerously-skip-permissions` is.
 * - `ask` — `untrusted`: codex runs only the commands it classes as safe reads
 *   without asking, and asks before every other command and every patch.
 * - `acceptEdits` — `ask`'s gate with file changes answered `accept` by the
 *   driver, so edits land and commands still ask.
 * - `plan` — codex's own plan collaboration mode, under a read-only sandbox.
 *
 * No mode at all is a geniro-internal probe, which never reaches a tool: it
 * runs read-only with nothing to ask.
 */
export function codexTurnPolicy(
  mode: AgentApprovalMode | undefined,
): CodexTurnPolicy {
  switch (mode) {
    case 'auto':
      return {
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        sandboxPolicy: { type: 'dangerFullAccess' },
        plan: false,
        autoAcceptFileChanges: false,
      };
    case 'ask':
      return {
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        sandboxPolicy: WORKSPACE_WRITE,
        plan: false,
        autoAcceptFileChanges: false,
      };
    case 'acceptEdits':
      return {
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        sandboxPolicy: WORKSPACE_WRITE,
        plan: false,
        autoAcceptFileChanges: true,
      };
    case 'plan':
      return {
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
        sandboxPolicy: READ_ONLY,
        plan: true,
        autoAcceptFileChanges: false,
      };
    case undefined:
      return {
        approvalPolicy: 'never',
        sandbox: 'read-only',
        sandboxPolicy: READ_ONLY,
        plan: false,
        autoAcceptFileChanges: false,
      };
  }
}
