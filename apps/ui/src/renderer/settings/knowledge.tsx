import { BookOpen } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  DEFAULT_KNOWLEDGE,
  type KnowledgeAgentWrites,
  type KnowledgeSettings,
} from '../../shared/contracts';
import { ErrorBanner } from '../components/error-banner';
import { SettingsGroup, SettingsGroups } from '../components/settings-group';
import { SettingsPanel, SettingsPanelRow } from '../components/settings-panel';
import { Select } from '../components/ui/select';
import { Switch } from '../components/ui/switch';

const AGENT_WRITES: { value: KnowledgeAgentWrites; label: string }[] = [
  { value: 'review', label: 'Wait for my review' },
  { value: 'direct', label: 'Saved at once' },
  { value: 'off', label: 'Agents only read' },
];

/**
 * Settings → Knowledge: whether agents get the knowledge tools and index, and
 * what happens to a document an agent saves.
 */
export function Knowledge(): React.JSX.Element {
  const [knowledge, setKnowledge] = useState<KnowledgeSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.geniro
      .getSettings()
      .then((settings) => setKnowledge(settings.knowledge))
      .catch((err: unknown) => setError(String(err)));
  }, []);

  const current = knowledge ?? DEFAULT_KNOWLEDGE;

  const saveSettings = (next: KnowledgeSettings): void => {
    const before = knowledge;
    setKnowledge(next);
    setError(null);
    void window.geniro
      .updateSettings({ knowledge: next })
      .catch((err: unknown) => {
        setKnowledge(before);
        setError(String(err));
      });
  };

  return (
    <SettingsGroups>
      {error !== null && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      )}
      <SettingsGroup
        icon={<BookOpen />}
        title="Knowledge"
        description="Documents agents can look up while they work."
        hint="Knowledge documents are longer notes, such as a project's rules, a design guide or a how-to, that you or an agent wrote once so it does not have to be explained again. Agents search and read them when a task needs them. You edit them in the Knowledge section of the app.">
        <SettingsPanel>
          <SettingsPanelRow
            label="Agent knowledge"
            hint="On: every agent, whichever program runs it, gets tools to search and read your documents, and a short index of them in its instructions. Off: agents do not know the documents exist; they stay here for you to read and edit. Turn it off if you want agents to work only from what you tell them in the chat."
            htmlFor="settings-knowledge-enabled"
            description="Agents find and read documents, whatever their CLI. Off, they get no knowledge tools and no index — the documents stay here to edit.">
            <Switch
              id="settings-knowledge-enabled"
              checked={current.enabled}
              disabled={knowledge === null}
              onCheckedChange={(on) =>
                saveSettings({ ...current, enabled: on })
              }
            />
          </SettingsPanelRow>
          <SettingsPanelRow
            label="Agent writes"
            hint="Decides what happens when an agent wants to save or change a document. Wait for my review: nothing changes until you approve it, so you see each proposal first. Saved at once: the document is written immediately and agents can find it by search, but it is not added to every chat's index until you load it there. Agents only read: agents cannot save or change documents at all. This setting only matters while Agent knowledge is on."
            htmlFor="settings-knowledge-agent-writes"
            description="Saved at once: agents find an agent's document by search right away; it stays out of every chat's index until you load it there. Wait for my review: a new document or change waits for you first.">
            <Select
              id="settings-knowledge-agent-writes"
              aria-label="Agent writes"
              className="w-48"
              value={current.agentWrites}
              disabled={knowledge === null || !current.enabled}
              groups={[{ label: 'Agent writes', items: AGENT_WRITES }]}
              onValueChange={(value) =>
                saveSettings({
                  ...current,
                  agentWrites: value as KnowledgeAgentWrites,
                })
              }
            />
          </SettingsPanelRow>
        </SettingsPanel>
      </SettingsGroup>
    </SettingsGroups>
  );
}
