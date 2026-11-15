import { useEffect, useState } from 'react';

import {
  DEFAULT_KNOWLEDGE,
  type KnowledgeAgentWrites,
  type KnowledgeSettings,
} from '../../shared/contracts';
import { ErrorBanner } from '../components/error-banner';
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
    <div data-slot="knowledge" className="flex flex-col gap-3">
      {error !== null && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      )}
      <SettingsPanel>
        <SettingsPanelRow
          label="Agent knowledge"
          htmlFor="settings-knowledge-enabled"
          description="Agents find and read documents, whatever their CLI. Off, they get no knowledge tools and no index — the documents stay here to edit.">
          <Switch
            id="settings-knowledge-enabled"
            checked={current.enabled}
            disabled={knowledge === null}
            onCheckedChange={(on) => saveSettings({ ...current, enabled: on })}
          />
        </SettingsPanelRow>
        <SettingsPanelRow
          label="Agent writes"
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
    </div>
  );
}
