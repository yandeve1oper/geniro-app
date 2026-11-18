import type { Run } from '../../runs/entity/run.entity';
import {
  HOST_NOTE_THREAD_TOOL,
  HOST_START_THREAD_TOOL,
  HOST_TELL_THREADS_TOOL,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/** Whether a run is the command center's manager chat. */
export function isCommandCenterChat(run: Pick<Run, 'commandCenter'>): boolean {
  return run.commandCenter === true;
}

/**
 * Whether a permission request names one of the manager's own tools,
 * `tell_threads`, `note_thread` or `start_thread`. Auto-approved in the
 * manager's chat only (user decision): there the user delegated messaging the
 * threads it manages, every send is a row with the manager as sender on both
 * transcripts, and a `start_thread` call only raises its Start card, which is
 * what decides whether the thread starts.
 */
export function isHostCommandCenterCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return (
    isHostToolCall(serverName, toolName, HOST_TELL_THREADS_TOOL) ||
    isHostToolCall(serverName, toolName, HOST_NOTE_THREAD_TOOL) ||
    isHostToolCall(serverName, toolName, HOST_START_THREAD_TOOL)
  );
}
