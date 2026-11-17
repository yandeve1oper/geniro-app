import {
  CLAUDE_CROSS_SESSION_INBOUND_KEY,
  CLAUDE_CROSS_SESSION_INBOUND_REFUSE,
  CLAUDE_DENIED_MCP_SERVER_NAME_FIELD,
  CLAUDE_DENIED_MCP_SERVERS_KEY,
  CLAUDE_FAST_MODE_PARAMETER_ID,
  CLAUDE_LANGUAGE_SETTING_KEY,
  CLAUDE_SETTINGS_FLAG,
} from '../claude.const';
import { wantsFastMode } from './claude-fast-mode.utils';

/** What one turn hands the CLI's settings layer. */
export interface ClaudeTurnSettings {
  modelParameters?: Record<string, string> | null;
  replyLanguage?: string | null;
  /**
   * The env an Ollama model routes through (`modelConfiguration(...).env`),
   * empty for every other model. Folded in because this object replaces the
   * `--settings {"env"}` the base puts ahead of it.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * The config names of the servers this turn switches off
   * (`claudeSwitchedOffServers`), which the CLI is told never to start
   * (`CLAUDE_DENIED_MCP_SERVERS_KEY`). Empty or absent, the key is left out.
   */
  deniedMcpServers?: readonly string[];
}

/**
 * The turn's own `--settings` flag, on every turn: other claude sessions are
 * refused whatever else the turn sets.
 *
 * It lands after the base's env-only `--settings` for an Ollama model
 * (`AgentAdapter.startSession` puts `modelConfiguration(...).args` ahead of
 * `buildArgs`), and a later `--settings` replaces an earlier one wholesale
 * (see `CLAUDE_SETTINGS_FLAG`) — so this object repeats that env, or the
 * model's routing would be dropped.
 */
export function claudeSettingsArgs(settings: ClaudeTurnSettings): string[] {
  const value: Record<string, unknown> = {
    [CLAUDE_CROSS_SESSION_INBOUND_KEY]: CLAUDE_CROSS_SESSION_INBOUND_REFUSE,
  };
  if (wantsFastMode(settings.modelParameters)) {
    value[CLAUDE_FAST_MODE_PARAMETER_ID] = true;
  }
  const language = settings.replyLanguage?.trim();
  if (language) {
    value[CLAUDE_LANGUAGE_SETTING_KEY] = language;
  }
  if (settings.env && Object.keys(settings.env).length > 0) {
    value.env = settings.env;
  }
  if (settings.deniedMcpServers && settings.deniedMcpServers.length > 0) {
    value[CLAUDE_DENIED_MCP_SERVERS_KEY] = settings.deniedMcpServers.map(
      (name) => ({ [CLAUDE_DENIED_MCP_SERVER_NAME_FIELD]: name }),
    );
  }
  return [CLAUDE_SETTINGS_FLAG, JSON.stringify(value)];
}
