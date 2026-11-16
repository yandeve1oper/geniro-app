import { type ComponentProps, useState } from 'react';

import { ErrorText } from '../components/error-text';
import { McpDialogButton } from '../components/mcp-dialog-button';
import { NoteBox } from '../components/note-box';
import { withNodeSwitches } from './node-mcp-switches';
import { type RowScope, ScopedSettingRow } from './overridable-row';
import type { NodeMcpState } from './use-node-mcp';

type DialogActions = Pick<
  ComponentProps<typeof McpDialogButton>,
  | 'onSetEnabled'
  | 'onSignIn'
  | 'signingIn'
  | 'loginServer'
  | 'loginPanel'
  | 'configActions'
>;

/**
 * A member's MCP row: the servers its profile loads with its own switches laid
 * over them, or the daemon's refusal of its config directory. In a project's
 * scope the switches are an override of the team's, marked as one.
 */
export function MemberMcpRow({
  title,
  mcp,
  mcpDisabled,
  hint,
  configDir,
  configDirUnavailableReason,
  scope = null,
  ...actions
}: {
  title: string;
  mcp: NodeMcpState;
  mcpDisabled: readonly string[] | undefined;
  hint: string;
  configDir: string | null;
  configDirUnavailableReason: string | null | undefined;
  scope?: RowScope | null;
} & DialogActions): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      {mcp.invalidConfigDir === null ? (
        <div className="@container flex flex-col rounded-card bg-card ring-1 ring-border">
          <ScopedSettingRow label="MCP" scope={scope}>
            <McpDialogButton
              variant="chip"
              chipNamesItself={false}
              title={title}
              open={open}
              onOpenChange={setOpen}
              listing={withNodeSwitches(mcp.listing, mcpDisabled)}
              loading={mcp.loading}
              hint={hint}
              onRefresh={mcp.refresh}
              {...actions}
            />
          </ScopedSettingRow>
        </div>
      ) : (
        <ErrorText id="member-config-dir-error" className="text-xs break-words">
          {mcp.invalidConfigDir}
        </ErrorText>
      )}
      {configDir && configDirUnavailableReason ? (
        <NoteBox aria-label="Config directory" className="text-xs">
          <span className="block">{configDirUnavailableReason}</span>
          <span className="block text-warning">
            This member names {configDir}, which will be ignored when it runs.
          </span>
        </NoteBox>
      ) : null}
    </>
  );
}
