import { Loader2, LogIn } from 'lucide-react';
import { useEffect, useState } from 'react';

import { type CliKind, MAX_CONFIG_PROFILE_NAME } from '../../shared/contracts';
import { Field } from '../components/field';
import { HelpHint } from '../components/help-hint';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { OptionList } from '../components/ui/option-list';
import {
  collectMcpServerChoices,
  type McpServerChoice,
  type McpSource,
  type McpSourceDocument,
} from './new-config-profile';

export interface NewConfigProfileRequest {
  name: string;
  servers: readonly McpServerChoice[];
}

type ServerListing =
  | { state: 'loading' }
  | {
      state: 'ready';
      choices: McpServerChoice[];
      unreadable: string[];
      shared: boolean;
    };

/**
 * Names a new configuration of one CLI, offers the MCP servers its other
 * configurations define, and hands both to `onCreate`, which makes the folder
 * and starts that CLI's sign-in in it.
 */
export function NewConfigProfileDialog({
  agent,
  open,
  sources,
  readSource,
  onCreate,
  onClose,
}: {
  agent: CliKind;
  open: boolean;
  /** The configurations to offer servers from, the CLI's default first. */
  sources: readonly McpSource[];
  readSource: (source: McpSource) => Promise<McpSourceDocument>;
  onCreate: (request: NewConfigProfileRequest) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [listing, setListing] = useState<ServerListing>({ state: 'loading' });
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setName('');
    setPicked([]);
    setError(null);
    setCreating(false);
    setListing({ state: 'loading' });
    let live = true;
    void collectMcpServerChoices(sources, readSource).then((result) => {
      if (live) {
        setListing({ state: 'ready', ...result });
      }
    });
    return () => {
      live = false;
    };
  }, [open, sources, readSource]);

  const trimmed = name.trim();
  const choices = listing.state === 'ready' ? listing.choices : [];

  const submit = async (): Promise<void> => {
    if (trimmed === '' || creating) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await onCreate({
        name: trimmed,
        servers: choices.filter((choice) => picked.includes(choice.name)),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!creating) {
          onClose();
        }
      }}
      title={`New ${agent} configuration`}
      className="max-w-lg">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}>
        <p className="text-sm text-muted-foreground">
          Geniro makes a folder for it in its own data folder and opens the{' '}
          {agent} sign-in there, so this login stays apart from your other ones.
        </p>
        <Field
          label="Name"
          htmlFor="new-config-profile-name"
          help="Only for you: the name this configuration shows under when you pick it for a chat or a team member. You can rename it later.">
          <Input
            id="new-config-profile-name"
            value={name}
            maxLength={MAX_CONFIG_PROFILE_NAME}
            placeholder="Work, Personal, Client…"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            MCP servers to bring along
            <HelpHint subject="MCP servers to bring along">
              <p>
                MCP servers are add-on tools an agent can call, set up in{' '}
                {agent}&apos;s own settings. A new configuration starts without
                any of them.
              </p>
              <p className="text-muted-foreground">
                Ticked ones are copied from your other {agent} configurations
                into the new one. A server the new one already has is never
                overwritten. Some carry secret keys, and those are copied too.
              </p>
            </HelpHint>
          </span>
          {listing.state === 'loading' ? (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Reading your other configurations…
            </span>
          ) : listing.state === 'ready' && listing.shared ? (
            <span
              data-slot="mcp-servers-shared"
              className="text-sm text-muted-foreground">
              Every {agent} configuration reads the same MCP servers, so the new
              one has them already.
            </span>
          ) : choices.length === 0 ? (
            <span
              data-slot="no-mcp-servers"
              className="text-sm text-muted-foreground">
              Your other {agent} configurations define no MCP servers.
            </span>
          ) : (
            <OptionList
              label="MCP servers"
              arity="many"
              options={choices.map((choice) => choice.name)}
              details={choices.map((choice) =>
                choice.carriesKeys
                  ? `From ${choice.from} · copies its keys too`
                  : `From ${choice.from}`,
              )}
              selected={picked}
              disabled={creating}
              onPick={(server) =>
                setPicked((prev) =>
                  prev.includes(server)
                    ? prev.filter((entry) => entry !== server)
                    : [...prev, server],
                )
              }
            />
          )}
          {listing.state === 'ready' && listing.unreadable.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              Could not read {listing.unreadable.join(', ')}.
            </span>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={creating}
            title="Closes this without creating anything."
            onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={trimmed === '' || creating}
            title={`Makes the folder, copies the ticked MCP servers into it, then opens the ${agent} sign-in there in your browser.`}>
            {creating ? (
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            ) : (
              <LogIn aria-hidden="true" className="size-3.5" />
            )}
            {creating ? 'Creating…' : 'Create and sign in'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
