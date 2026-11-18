/**
 * What a turn tells the agent, and the transcript, when the process it would
 * have run on is kept past a change or was closed under running work.
 *
 * Both halves exist because they have different readers: the transcript row is
 * for the user, and the prompt line is the only way the AGENT learns that its
 * dev server is gone or that its MCP servers are not the ones now configured.
 */
import type { AgentTurnInput } from '../adapters/adapter.types';

/** One event's worth of telling: the transcript row and the prompt line. */
export interface SessionNote {
  transcript: string;
  prompt: string;
}

/** The tag a prompt line is wrapped in, so it never reads as the user's words. */
const NOTE_TAG = 'geniro-note';

/** A command line longer than this is cut, so one heredoc cannot flood a turn. */
const MAX_COMMAND_CHARS = 200;

/**
 * A slash command's opening — `/name`, not a path such as `/Users/x.ts`, which
 * is the user's own words and can carry the note.
 */
const SLASH_COMMAND = /^\/[^\s/]+(\s|$)/;

export function isSlashCommand(prompt: string): boolean {
  return SLASH_COMMAND.test(prompt.trimStart());
}

/** How many stopped commands are named before the rest are counted. */
const MAX_NAMED_COMMANDS = 10;

/**
 * The turn runs on the process that loaded the MCP servers configured before
 * `reasons` happened, because replacing it would stop its background work.
 * Says both directions: what was added is missing, and what was switched off
 * or removed is still loaded.
 */
export function deferredMcpChangeNote(reasons: readonly string[]): SessionNote {
  const change = reasons.map(oneLine).join('; ');
  return {
    transcript:
      `Kept this session's process for this turn: it was still working in the background, ` +
      `and replacing it would stop that work. The MCP change (${change}) applies from the ` +
      `first turn that starts after the background work ends. Until then the agent keeps ` +
      `the MCP servers it started with: newly connected ones are not available, and ones ` +
      `switched off or removed since are still loaded.`,
    prompt:
      `Your MCP configuration changed (${change}), but this turn runs on your existing ` +
      `process so the background work in it is not stopped. The change applies from the ` +
      `first turn that starts after that work has ended. Until then you keep the MCP ` +
      `servers you started with: newly connected tools are not available to you, and ` +
      `servers switched off or removed since are still loaded — do not use them.`,
  };
}

/**
 * The process was closed for `reason` while `running` detached commands ran
 * in it; `commands` holds the lines of those whose line was known.
 */
export function stoppedCommandsNote(
  reason: string,
  commands: readonly string[],
  running: number,
): SessionNote {
  const list = commandList(commands, running);
  const count = commandCount(running);
  const why = oneLine(reason);
  return {
    transcript: `This session's process was closed (${why}), which stopped ${count}:\n${list}`,
    prompt:
      `The process behind this conversation was closed before this turn (${why}). That ` +
      `stopped ${count} still running in it:\n${list}\nStart again any you still need.`,
  };
}

/**
 * The process ended on its own while `running` detached commands ran in it.
 * What was recorded of them is stopped (`RunProcessReaper.stopLeftGroups`), but
 * one never recorded may have outlived it — and an agent told to start a live
 * dev server again starts a second one.
 */
export function endedCommandsNote(
  commands: readonly string[],
  running: number,
): SessionNote {
  const list = commandList(commands, running);
  const count = commandCount(running);
  return {
    transcript: `This session's process ended on its own while running ${count}, which may have stopped with it:\n${list}`,
    prompt:
      `The process behind this conversation ended on its own before this turn. It was ` +
      `running ${count} that may have stopped with it:\n${list}\nCheck whether each is ` +
      `still running before starting it again.`,
  };
}

/**
 * The run sat unused for the kept-session window (`minutes`), so the
 * `processes` its agents had left running outside any CLI were stopped. The
 * user reads the `commands` that started the rest; the agent reads only their
 * `executables`, since the prompt leaves the machine.
 */
export function idleStoppedNote(
  minutes: number,
  commands: readonly string[],
  executables: readonly string[],
  processes: number,
): SessionNote {
  const window = `the kept-session window, ${minutes} min`;
  return leftRunningNote(
    `This conversation sat unused for ${window}`,
    `While this conversation sat unused (${window})`,
    commands,
    executables,
    processes,
  );
}

/**
 * The run's card was finished, so the `processes` its agents had left running
 * outside any CLI were stopped before its worktree is collected — told as
 * {@link idleStoppedNote} is.
 */
export function finishedStoppedNote(
  commands: readonly string[],
  executables: readonly string[],
  processes: number,
): SessionNote {
  return leftRunningNote(
    "This card's work is finished",
    "When this card's work was finished",
    commands,
    executables,
    processes,
  );
}

function leftRunningNote(
  why: string,
  when: string,
  commands: readonly string[],
  executables: readonly string[],
  processes: number,
): SessionNote {
  const count = processes === 1 ? '1 process' : `${processes} processes`;
  const named = executables.slice(0, MAX_NAMED_COMMANDS).map(clip);
  const more = executables.length - named.length;
  const starters =
    more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ');
  return {
    transcript:
      `${why}, so geniro stopped ${count} its agents ` +
      `had left running:\n${commandList(commands, commands.length)}\nThe next message ` +
      `lets the agent start again any it still needs.`,
    prompt:
      `${when}, geniro stopped ${count} its agents ` +
      `had left running outside their own processes, started by: ${starters}. ` +
      `If you started any of them and still need it, start it again.`,
  };
}

function commandCount(running: number): string {
  return running === 1
    ? '1 background command'
    : `${running} background commands`;
}

/** One `- ` line per command, the overflow and the unnamed ones counted. */
function commandList(commands: readonly string[], running: number): string {
  const lines = commands
    .slice(0, MAX_NAMED_COMMANDS)
    .map((command) => `- ${clip(command)}`);
  const overflow = commands.length - lines.length;
  if (overflow > 0) {
    lines.push(`- and ${overflow} more`);
  }
  const unreported = running - commands.length;
  if (unreported > 0) {
    lines.push(
      lines.length === 0
        ? `- ${unreported} whose command line was not reported`
        : `- and ${unreported} whose command line was not reported`,
    );
  }
  return lines.join('\n');
}

/**
 * This turn's input with `note` after the user's words, or the input unchanged
 * when the turn carries no prompt a line can ride on.
 *
 * After, never before: an ACP CLI names a conversation from its prompt's
 * opening. Withheld from a probe, a prompt-less resume and a slash command,
 * where an appended line would become the command's argument.
 */
export function withSessionNote(
  input: AgentTurnInput,
  note: string,
): AgentTurnInput {
  const prompt = input.prompt.trimStart();
  if (
    input.internalProbe === true ||
    input.commandListProbe === true ||
    input.resumeOnly === true ||
    prompt === '' ||
    isSlashCommand(prompt)
  ) {
    return input;
  }
  // A command line or server name quoting the closing tag would end the note
  // early and pass what follows off as the user's words.
  const body = note.replace(
    new RegExp(`<(\\s*/?\\s*${NOTE_TAG})`, 'gi'),
    '‹$1',
  );
  return {
    ...input,
    prompt: `${input.prompt}\n\n<${NOTE_TAG}>\n${body}\n</${NOTE_TAG}>`,
  };
}

/** One line of text, so a heredoc or a newline in a name cannot break a list. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(command: string): string {
  const line = oneLine(command);
  return line.length <= MAX_COMMAND_CHARS
    ? line
    : `${line.slice(0, MAX_COMMAND_CHARS)}…`;
}
