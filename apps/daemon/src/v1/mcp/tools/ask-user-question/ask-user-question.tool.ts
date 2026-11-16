import { HOST_QUESTION_TOOL } from '../../../agents/chat.types';
import type { UserQuestionBroker } from '../../../agents/services/user-question.broker';
import { readHostQuestions } from '../../../agents/utils/host-question';
import { callerKey } from '../../../teams/utils/caller-key';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { askUserQuestionInstructions } from './ask-user-question.instructions';
import {
  hostQuestionResultText,
  readHostQuestionTitle,
} from './ask-user-question.reader';
import { askUserQuestionSchema } from './ask-user-question.schema';

/**
 * `ask_user_question` — put a multiple-choice question to the USER and wait for the answer.
 *
 * Asked per CONVERSATION: a team member's callee conversations each register
 * their own asker under `callerKey(member, conversation)`, which is the bare
 * member id for its own conversation and for a chat.
 */
export class AskUserQuestionTool extends BaseMcpTool {
  readonly name = HOST_QUESTION_TOOL;

  constructor(private readonly questions: UserQuestionBroker) {
    super();
  }

  protected isOffered({
    runId,
    memberId,
    conversationId,
  }: McpListContext): boolean {
    return this.questions.canAsk(runId, callerKey(memberId, conversationId));
  }

  protected instructions({ conversationId }: McpListContext): string {
    return askUserQuestionInstructions(conversationId !== null);
  }

  protected inputSchema(): Record<string, unknown> {
    return askUserQuestionSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, caller } = context;
    // Answered ahead of the call tools and in its OWN shape: the call
    // envelope is a contract between two AGENTS, and a question put to a
    // person has no status, no call_id and nothing to collect later. The
    // agent reads plain words back.
    const questions = readHostQuestions(args);
    if (questions.length === 0) {
      return this.invalidArgs(
        "'questions' must be a non-empty array, each entry carrying a 'question' string and at least one option.",
      );
    }
    const title = readHostQuestionTitle(args);
    const outcome = await context.whileCancellable((signal) =>
      this.questions.ask(runId, caller, questions, title, signal),
    );
    // None of the three outcomes is a tool FAILURE: a dismissal and an
    // unavailable channel are both answers the agent carries on from,
    // and flagging them as errors is how a model comes to retry a
    // question the user has already declined.
    return this.text(hostQuestionResultText(outcome));
  }
}
