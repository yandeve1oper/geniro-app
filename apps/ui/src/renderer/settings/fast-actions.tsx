import { Pencil, Plus, Trash2, Zap } from 'lucide-react';
import * as React from 'react';

import type { FastAction } from '../../shared/contracts';
import {
  MAX_FAST_ACTION_NAME,
  MAX_FAST_ACTION_TEXT,
  MAX_FAST_ACTIONS,
} from '../../shared/contracts';
import { EmptyState } from '../components/empty-state';
import { ErrorText } from '../components/error-text';
import { ExpandableTextarea } from '../components/expandable-textarea';
import { SettingsGroup, SettingsGroups } from '../components/settings-group';
import { SettingsList, SettingsPanel } from '../components/settings-panel';
import { ShowAllButton, useShowAll } from '../components/show-all';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useLatestCallback } from '../components/use-latest-callback';

/** Everything about an action except its identity. */
export type FastActionDraft = Omit<FastAction, 'id'>;

const EMPTY_DRAFT: FastActionDraft = { name: '', description: '' };

const SHOWN_LIMIT = 8;

/**
 * Fast actions — the user's own buttons for writing a message.
 *
 * An action is a NAME and a DESCRIPTION and nothing else. Pressing its button
 * under the composer writes the description into the message box; it chooses no
 * folder, no agent and no model, so the same action is usable under whatever
 * setup the composer already carries.
 *
 * This is the second shape of the feature. The first bundled a whole new-chat
 * setup into each action — folder, branch, agent, model, approval mode — and
 * that was wrong twice over: it made every action usable in exactly one
 * configuration, and it gave the run's setup a second, invisible source that
 * moved chips the user had set by hand. The editor below is what is left once
 * that is taken out, and the smallness is the point rather than an omission.
 */
export function FastActionsPane({
  actions,
  onSave,
  onDelete,
}: {
  actions: readonly FastAction[];
  /** Create when the id is null, replace when it names an existing entry. */
  onSave: (draft: FastActionDraft, id: string | null) => void;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  /**
   * `null` is the list; anything else is the editor, carrying the id it will
   * save back to (`null` for an action that does not exist yet).
   */
  const [editing, setEditing] = React.useState<{
    id: string | null;
    draft: FastActionDraft;
  } | null>(null);
  /** The row whose Delete has been pressed once — the second press commits. */
  const [confirmingDelete, setConfirmingDelete] = React.useState<string | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const { shown, expanded, setExpanded } = useShowAll(actions, SHOWN_LIMIT);

  const commit = useLatestCallback((): void => {
    if (!editing) {
      return;
    }
    const name = editing.draft.name.trim();
    const description = editing.draft.description.trim();
    if (name === '') {
      setError('Give the action a name.');
      return;
    }
    if (description === '') {
      setError('Write what pressing this action should say.');
      return;
    }
    // Refuse here what the IPC schema would refuse anyway. That boundary
    // rejects the WHOLE settings patch by throwing, so without these guards an
    // over-long name or a 51st entry closes the editor, shows the row from
    // React state, and writes nothing.
    if (name.length > MAX_FAST_ACTION_NAME) {
      setError(
        `That name is ${name.length} characters — keep it to ${MAX_FAST_ACTION_NAME}.`,
      );
      return;
    }
    if (description.length > MAX_FAST_ACTION_TEXT) {
      setError(
        `That description is ${description.length} characters — keep it to ${MAX_FAST_ACTION_TEXT}.`,
      );
      return;
    }
    if (editing.id === null && actions.length >= MAX_FAST_ACTIONS) {
      setError(
        `You already have ${MAX_FAST_ACTIONS} actions — delete one before adding another.`,
      );
      return;
    }
    // Clear the refusal this save just resolved. The message renders above the
    // LIST as well as the editor, so a stale one sits over the row that proves
    // it wrong — the user is told to name an action that is on screen carrying
    // its name.
    setError(null);
    onSave({ name, description }, editing.id);
    if (editing.id === null) {
      setExpanded(true);
    }
    setEditing(null);
  }, [editing, actions.length, onSave, setExpanded]);

  return (
    <SettingsGroups>
      <SettingsGroup
        layout="stacked"
        icon={<Zap />}
        title="Your actions"
        description="Ready-made messages you can drop into a chat with one press."
        hint="A fast action is a message you write once and reuse, like “Review the branch and report findings”. Its button appears under the message box on the new-chat screen. Pressing it writes the text into the message box and sends nothing, so you can still edit it, add to it, or change the agent before you send."
        actions={
          editing ? undefined : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              title="Write a new fast action: a name for its button and the text it puts in the message box."
              onClick={() => {
                setError(null);
                setEditing({ id: null, draft: EMPTY_DRAFT });
              }}>
              <Plus className="size-4" />
              New action
            </Button>
          )
        }>
        {editing || actions.length === 0 ? null : (
          // The list has a ceiling the editor refuses a save against
          // (`MAX_FAST_ACTIONS`), so somebody filling it up learns that here
          // rather than from a refusal after writing an action. Silent on an
          // empty list, where the empty state says it better.
          <span className="text-xs text-muted-foreground">
            {`${actions.length} of ${MAX_FAST_ACTIONS}`}
          </span>
        )}
        {error ? <ErrorText>{error}</ErrorText> : null}
        {editing ? (
          <FastActionEditor
            draft={editing.draft}
            isNew={editing.id === null}
            onChange={(draft) => setEditing({ id: editing.id, draft })}
            onCancel={() => {
              setError(null);
              setEditing(null);
            }}
            onCommit={commit}
          />
        ) : actions.length === 0 ? (
          // Inside the SAME enclosure the list gets — see the twin note in
          // `chats/run-config-picker.tsx`.
          <SettingsPanel>
            <EmptyState className="flex-col gap-1 py-10">
              <span className="text-foreground">No fast actions yet</span>
              {/* `text-xs` — see the twin note in `chats/run-config-picker.tsx`. */}
              <span className="max-w-sm text-xs">
                Name one and write what it should say — its button appears under
                the composer, and a press drops that text into the message box.
              </span>
            </EmptyState>
          </SettingsPanel>
        ) : (
          // `overflow-hidden` so a row's hover fill clips to the card's radius —
          // the corner rows would otherwise paint square over a rounded edge. Safe
          // here and NOT on `SettingsPanel`, whose rows can hold a `Select` whose
          // panel would then be cut off.
          <SettingsList className="overflow-hidden">
            {shown.map((action) => (
              <FastActionRow
                key={action.id}
                action={action}
                confirmingDelete={confirmingDelete === action.id}
                onEdit={() => {
                  setError(null);
                  setConfirmingDelete(null);
                  const { id: _id, ...draft } = action;
                  setEditing({ id: action.id, draft });
                }}
                onDeletePress={() => setConfirmingDelete(action.id)}
                onDeleteCancel={() => setConfirmingDelete(null)}
                onDeleteConfirm={() => {
                  setConfirmingDelete(null);
                  onDelete(action.id);
                }}
              />
            ))}
          </SettingsList>
        )}
        {editing ? null : (
          <ShowAllButton
            total={actions.length}
            limit={SHOWN_LIMIT}
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
            noun="actions"
          />
        )}
      </SettingsGroup>
    </SettingsGroups>
  );
}

/** One fast action: what it says, and the two things you can do to it. */
function FastActionRow({
  action,
  confirmingDelete,
  onEdit,
  onDeletePress,
  onDeleteCancel,
  onDeleteConfirm,
}: {
  action: FastAction;
  confirmingDelete: boolean;
  onEdit: () => void;
  onDeletePress: () => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: () => void;
}): React.JSX.Element {
  return (
    <li className="flex items-center gap-1 pr-2 hover:bg-sidebar-accent">
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit the fast action “${action.name}”`}
        title={action.description}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-4 py-3 text-left outline-none focus-visible:bg-sidebar-accent">
        <span className="w-full truncate text-sm text-foreground">
          {action.name}
        </span>
        {/* The first line of what it writes. Truncated at the END, unlike the
            paths this row used to carry: a sentence is identified by its
            opening, so the tail is the half to lose. */}
        <span className="w-full truncate text-xs text-muted-foreground">
          {action.description}
        </span>
      </button>
      {confirmingDelete ? (
        // Two presses rather than a nested dialog, which would fight this one
        // for the focus trap. Cancel is not decoration: the confirm button
        // replaces the delete button under the pointer, so a double-click would
        // otherwise land straight on it.
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0 text-muted-foreground"
            aria-label={`Keep ${action.name}`}
            title="Keep this action and do not delete it."
            onClick={onDeleteCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="shrink-0"
            aria-label={`Confirm delete ${action.name}`}
            title="Delete this action for good."
            onClick={onDeleteConfirm}>
            Delete?
          </Button>
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label={`Edit ${action.name}`}
            title="Change this action’s name or text."
            onClick={onEdit}>
            <Pencil className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label={`Delete ${action.name}`}
            title="Delete this action. You are asked once more first."
            onClick={onDeletePress}>
            <Trash2 className="size-4" />
          </Button>
        </>
      )}
    </li>
  );
}

/** Two fields, because an action is two things. */
function FastActionEditor({
  draft,
  isNew,
  onChange,
  onCancel,
  onCommit,
}: {
  draft: FastActionDraft;
  isNew: boolean;
  onChange: (next: FastActionDraft) => void;
  onCancel: () => void;
  onCommit: () => void;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Name</span>
        <Input
          value={draft.name}
          placeholder="Review the branch"
          aria-label="Fast action name"
          maxLength={MAX_FAST_ACTION_NAME}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
        <span className="text-xs text-muted-foreground">
          What the button says. Keep it short — it sits in a row of them.
        </span>
      </label>

      {/* `ExpandableTextarea` rather than a bare one: this is a whole brief, and
          the corner ⤢ opens it in the markdown editor. Safe here in a way the
          queued strip is not — nothing can send this row out from under the
          editor, so the component's own modal owns its lifetime. */}
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Description</span>
        <ExpandableTextarea
          value={draft.description}
          rows={4}
          title="Description"
          placeholder="Review what changed on this branch and report findings."
          onChange={(value) =>
            onChange({
              ...draft,
              // Capped where it is TYPED as well as where it is saved: the
              // editor refuses the save, so someone who has pasted 6000
              // characters would otherwise learn that only on Save.
              description: value.slice(0, MAX_FAST_ACTION_TEXT),
            })
          }
        />
        <span className="text-xs text-muted-foreground">
          Pressing the button writes this into the message box. Nothing is sent
          — you can edit it, add to it, or change the agent first.
        </span>
      </label>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title="Close the editor without saving."
          onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          title={
            isNew
              ? 'Add this action to your list.'
              : 'Save your changes to this action.'
          }
          onClick={onCommit}>
          {isNew ? 'Create' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
