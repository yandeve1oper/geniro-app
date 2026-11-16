import { useEffect, useRef, useState } from 'react';

import type { CliKind } from '../../shared/contracts';
import { mcpConfigActions } from '../chats/mcp-config-actions';
import {
  CliLoginProgress,
  CliServerLoginProgress,
} from '../components/cli-login-progress';
import { ErrorText } from '../components/error-text';
import { McpDialogButton } from '../components/mcp-dialog-button';
import { Dialog } from '../components/ui/dialog';
import { useLatestCallback } from '../components/use-latest-callback';
import type { DaemonApis } from '../daemon-api';
import {
  type CliLoginController,
  isLoginOver,
  useCliLogin,
} from '../use-cli-login';
import type { MemberProblem } from './member-problems';
import { useNodeMcp } from './use-node-mcp';

export interface MemberFix {
  label: string;
  run: () => void;
}

interface McpTarget {
  agent: CliKind;
  configDir: string | null;
}

function McpFixDialog({
  apis,
  target,
  login,
  settledToken,
  onClose,
}: {
  apis: DaemonApis;
  target: McpTarget;
  login: CliLoginController;
  settledToken: number;
  onClose: () => void;
}): React.JSX.Element {
  const mcp = useNodeMcp(apis.agents, target.agent, target.configDir);
  const seenToken = useRef(settledToken);
  const refresh = mcp.refresh;
  useEffect(() => {
    if (seenToken.current !== settledToken) {
      seenToken.current = settledToken;
      refresh();
    }
  }, [settledToken, refresh]);
  return (
    <McpDialogButton
      variant="chip"
      className="hidden"
      title="MCP servers"
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      listing={mcp.listing}
      loading={mcp.loading}
      hint={
        target.configDir
          ? 'The servers in this profile’s own config directory.'
          : 'Global servers.'
      }
      onRefresh={mcp.refresh}
      onSignIn={(server) =>
        void login.startMcp({
          kind: target.agent,
          server,
          configDir: target.configDir,
        })
      }
      signingIn={login.starting?.server ?? login.login?.server ?? null}
      loginServer={login.login?.server ?? null}
      loginPanel={<CliServerLoginProgress login={login} />}
      configActions={mcpConfigActions(apis.agents, {
        agent: target.agent,
        configDir: target.configDir,
      })}
    />
  );
}

function AccountSignInDialog({
  login,
  onClose,
}: {
  login: CliLoginController;
  onClose: () => void;
}): React.JSX.Element {
  const account =
    login.login !== null && login.login.server === null ? login.login : null;
  const starting = login.starting !== null && login.starting.server === null;
  const refused =
    login.errorTarget !== null && login.errorTarget.server === null;
  return (
    <Dialog
      open={account !== null || starting || refused}
      onClose={onClose}
      title="Sign in"
      className="max-w-md">
      {account !== null ? (
        <CliLoginProgress
          session={account.session}
          onSubmitCode={(code) => void login.submitCode(code)}
          onCancel={() => void login.cancel()}
          onDismiss={onClose}
          error={login.error}
          variant="inline"
          scope="account"
        />
      ) : starting ? (
        <p className="text-sm text-muted-foreground">Starting sign-in…</p>
      ) : (
        <ErrorText>{login.error}</ErrorText>
      )}
    </Dialog>
  );
}

/**
 * The button that fixes each kind of member problem, and the dialogs those
 * buttons open (the shared MCP dialog, the sign-in panel). Render `dialogs`
 * once, anywhere in the screen. `onFixed` fires when a sign-in settles and when
 * the MCP dialog closes, so the caller can read health again.
 */
export function useMemberFixes({
  apis,
  openMember,
  openSettings,
  onFixed,
}: {
  apis: DaemonApis | null;
  openMember: (memberId: string) => void;
  openSettings: (section: 'general') => void;
  onFixed: () => void;
}): {
  fixOf: (problem: MemberProblem) => MemberFix | undefined;
  dialogs: React.ReactNode;
} {
  const [mcpTarget, setMcpTarget] = useState<McpTarget | null>(null);
  const [settledToken, setSettledToken] = useState(0);
  const login = useCliLogin(apis, (settled) => {
    if (settled.server === null) {
      onFixed();
    } else {
      setSettledToken((token) => token + 1);
    }
  });

  const endSignIn = useLatestCallback(async (): Promise<void> => {
    if (login.login !== null && !isLoginOver(login.login.session)) {
      await login.cancel();
    }
    login.dismiss();
  }, [login]);

  const closeMcp = useLatestCallback(() => {
    setMcpTarget(null);
    void endSignIn();
    onFixed();
  }, [endSignIn, onFixed]);

  const fixOf = (problem: MemberProblem): MemberFix | undefined => {
    const agent = problem.agent;
    switch (problem.kind) {
      case 'mcp_failed':
      case 'mcp_disconnected':
        return agent === null || apis === null
          ? undefined
          : {
              label: 'Open MCP',
              run: () => setMcpTarget({ agent, configDir: problem.configDir }),
            };
      case 'mcp_needs_auth':
        return agent === null || apis === null
          ? undefined
          : {
              label: problem.server === null ? 'Open MCP' : 'Sign in',
              run: () => {
                setMcpTarget({ agent, configDir: problem.configDir });
                if (problem.server !== null) {
                  void login.startMcp({
                    kind: agent,
                    server: problem.server,
                    configDir: problem.configDir,
                  });
                }
              },
            };
      case 'signed_out':
      case 'sign_in_unknown':
        return agent === null || apis === null
          ? undefined
          : {
              label: 'Sign in',
              run: () => void login.start(agent, problem.configDir),
            };
      case 'cli_missing':
      case 'cli_unknown':
        return { label: 'Open Settings', run: () => openSettings('general') };
      case 'profile_missing':
        return {
          label: 'Choose profile',
          run: () => openMember(problem.memberId),
        };
      case 'model_not_offered':
        return {
          label: 'Choose model',
          run: () => openMember(problem.memberId),
        };
      case 'effort_not_offered':
        return {
          label: 'Choose effort',
          run: () => openMember(problem.memberId),
        };
      case 'no_trigger':
      case 'stage_member_missing':
        return undefined;
      default: {
        const unhandled: never = problem.kind;
        return unhandled;
      }
    }
  };

  const dialogs = (
    <>
      {apis !== null && mcpTarget !== null ? (
        <McpFixDialog
          apis={apis}
          target={mcpTarget}
          login={login}
          settledToken={settledToken}
          onClose={closeMcp}
        />
      ) : null}
      <AccountSignInDialog login={login} onClose={() => void endSignIn()} />
    </>
  );

  return { fixOf, dialogs };
}
