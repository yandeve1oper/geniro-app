import { describe, expect, it } from 'vitest';

import { CLAUDE_SETTINGS_FLAG } from '../claude.const';
import { claudeSettingsArgs } from './claude-settings.utils';

const REFUSE = { crossSessionInbound: 'refuse' };

function settingsOf(args: string[]): Record<string, unknown> {
  expect(args[0]).toBe(CLAUDE_SETTINGS_FLAG);
  expect(args).toHaveLength(2);
  return JSON.parse(args[1]!) as Record<string, unknown>;
}

describe('claudeSettingsArgs', () => {
  it('refuses other claude sessions on a turn with nothing else to set', () => {
    expect(settingsOf(claudeSettingsArgs({}))).toEqual(REFUSE);
    expect(
      settingsOf(
        claudeSettingsArgs({
          modelParameters: { fastMode: 'false' },
          replyLanguage: '  ',
        }),
      ),
    ).toEqual(REFUSE);
  });

  it('carries fast mode only when it is explicitly ON', () => {
    expect(
      settingsOf(claudeSettingsArgs({ modelParameters: { fastMode: 'true' } })),
    ).toEqual({ ...REFUSE, fastMode: true });
  });

  it('carries the reply language under the CLI’s own key, trimmed', () => {
    expect(
      settingsOf(claudeSettingsArgs({ replyLanguage: ' Russian ' })),
    ).toEqual({ ...REFUSE, language: 'Russian' });
  });

  it('puts fast mode and the language in ONE flag, since a second would replace the first', () => {
    expect(
      settingsOf(
        claudeSettingsArgs({
          modelParameters: { fastMode: 'true' },
          replyLanguage: 'Russian',
        }),
      ),
    ).toEqual({ ...REFUSE, fastMode: true, language: 'Russian' });
  });

  it('repeats an Ollama env, since this flag replaces the base one wholesale', () => {
    const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' };
    expect(
      settingsOf(claudeSettingsArgs({ replyLanguage: 'Russian', env })),
    ).toEqual({ ...REFUSE, language: 'Russian', env });
    expect(settingsOf(claudeSettingsArgs({ env }))).toEqual({ ...REFUSE, env });
  });

  it('names each switched-off server in deniedMcpServers, in the CLI’s own shape', () => {
    expect(
      settingsOf(
        claudeSettingsArgs({
          deniedMcpServers: ['codegraph', 'plugin:playwright:playwright'],
        }),
      ),
    ).toEqual({
      ...REFUSE,
      deniedMcpServers: [
        { serverName: 'codegraph' },
        { serverName: 'plugin:playwright:playwright' },
      ],
    });
  });

  it('leaves the key out, byte for byte, when nothing is switched off', () => {
    expect(claudeSettingsArgs({ deniedMcpServers: [] })).toEqual(
      claudeSettingsArgs({}),
    );
    expect(settingsOf(claudeSettingsArgs({}))).not.toHaveProperty(
      'deniedMcpServers',
    );
  });
});
