import {
  answersByQuestion,
  asksForSecret,
  type CardQuestionDraft,
  cardQuestions,
} from '../../../utils/card-questions';
import { asArray, asRecord, asString } from '../../../utils/json-util';
import { mcpToolName } from '../../../utils/mcp-tool-name';
import {
  hasOtherHardLinks,
  writeContainment,
} from '../../../utils/write-containment';
import type { ApprovalOption, CardQuestion } from '../../adapter.types';
import { approvalOption } from '../../utils/approval-options.utils';
import {
  CODEX_ACCEPT_FOR_SESSION_DECISION,
  CODEX_MCP_APPROVAL_PERSIST_KEY,
  CODEX_MCP_TOOL_APPROVAL_KIND,
  CODEX_PERMISSION_SESSION_SCOPE,
  CODEX_QUESTION_TOOL_NAME,
  CODEX_SERVER_REQUESTS,
  CODEX_SESSION_APPROVAL_OPTION_ID,
  CODEX_TOOL_NAMES,
} from '../codex.const';
import type { CodexItem } from '../codex.types';
import { changeTargets, fileChangeDiffs } from './codex-items.utils';

/**
 * The key the card's free-text answer rides on between `withCodexAnswer` and
 * `encodeCodexReply` — both ends of this adapter, and nowhere else.
 */
const ANSWER_KEY = '__geniroAnswer';

/** What an approval card shows for one of codex's server requests. */
export interface CodexApprovalCard {
  toolName: string;
  input: unknown;
  /** A question for the user rather than a permission to grant. */
  question: boolean;
  /** The question card, for a question; absent for a permission. */
  questions?: CardQuestion[];
  /** What codex would remember past this call, for a permission. */
  options?: ApprovalOption[];
}

/** codex's session-long approval, as a card option (see `codex.const.ts`). */
function sessionOption(): ApprovalOption[] {
  return [approvalOption(CODEX_SESSION_APPROVAL_OPTION_ID, true, 'session')];
}

/**
 * Whether an MCP tool approval accepts a session-long answer: its `_meta`
 * lists the persistence it takes, and an answer it did not list is not one it
 * promised to keep.
 */
function mcpPersistsForSession(
  record: Readonly<Record<string, unknown>>,
): boolean {
  const persist = asRecord(record._meta)?.[CODEX_MCP_APPROVAL_PERSIST_KEY];
  return (
    persist === CODEX_SESSION_APPROVAL_OPTION_ID ||
    asArray(persist).includes(CODEX_SESSION_APPROVAL_OPTION_ID)
  );
}

/**
 * The questions of a `requestUserInput` that a card can show and a reply can
 * key — an id and text, each — with the card draft of each. Read in ONE pass,
 * so the ids a reply is keyed by and the card the user answered line up by
 * position and cannot come apart.
 */
function codexQuestionEntries(
  params: unknown,
): { id: string; draft: CardQuestionDraft }[] {
  return asArray(asRecord(params)?.questions).flatMap((entry) => {
    const record = asRecord(entry);
    const id = record ? asString(record.id) : null;
    const question = record ? asString(record.question) : null;
    if (record === null || !id || !question) {
      return [];
    }
    return [
      {
        id,
        draft: {
          question,
          header: asString(record.header),
          multiSelect: false,
          secret: record.isSecret === true,
          options: asArray(record.options).map((value) => {
            const option = asRecord(value);
            return {
              label: asString(option?.label),
              description: asString(option?.description),
              preview: null,
            };
          }),
        },
      },
    ];
  });
}

/**
 * The card for one server request, or null for a request that is not an
 * approval or a question this adapter shows.
 *
 * `items` is the session's open items by id: a file-change request names only
 * its item, so the changes the user is being asked about are read off the
 * item's start, and an MCP tool approval names only its server, so the call it
 * approves is the one that server has open.
 */
export function codexApprovalCard(
  method: string,
  params: unknown,
  items: ReadonlyMap<string, CodexItem>,
): CodexApprovalCard | null {
  const record = asRecord(params) ?? {};
  const reason = asString(record.reason);
  switch (method) {
    case CODEX_SERVER_REQUESTS.commandApproval: {
      const item = items.get(asString(record.itemId) ?? '');
      const network = asRecord(record.networkApprovalContext);
      const host = asString(network?.host);
      const writesStdin = asString(record.kind) === 'writeStdin';
      return {
        // Input for a command already running is not a new command, and a card
        // drawing it as one would have the user approve something else.
        toolName: writesStdin
          ? CODEX_TOOL_NAMES.writeStdin
          : CODEX_TOOL_NAMES.command,
        input: {
          command:
            asString(record.command) ?? asString(item?.record.command) ?? '',
          cwd: asString(record.cwd) ?? asString(item?.record.cwd),
          ...(reason ? { reason } : {}),
          ...(host
            ? { network: { host, protocol: asString(network?.protocol) } }
            : {}),
        },
        question: false,
        // Not for input to a running command: what "this command for the
        // session" means for a keystroke was never measured.
        ...(writesStdin ? {} : { options: sessionOption() }),
      };
    }
    case CODEX_SERVER_REQUESTS.mcpElicitation:
      return mcpToolApprovalCard(record, items);
    case CODEX_SERVER_REQUESTS.fileChangeApproval: {
      const item = items.get(asString(record.itemId) ?? '');
      return {
        toolName: CODEX_TOOL_NAMES.fileChange,
        input: {
          diffs: fileChangeDiffs(item?.record.changes),
          ...(reason ? { reason } : {}),
          ...(asString(record.grantRoot)
            ? { grantRoot: asString(record.grantRoot) }
            : {}),
        },
        question: false,
        options: sessionOption(),
      };
    }
    case CODEX_SERVER_REQUESTS.permissionsApproval:
      return {
        toolName: CODEX_TOOL_NAMES.permissions,
        input: {
          permissions: record.permissions ?? {},
          ...(reason ? { reason } : {}),
        },
        question: false,
        options: sessionOption(),
      };
    case CODEX_SERVER_REQUESTS.userInput: {
      const questions = codexCardQuestions(params);
      return questions.length > 0
        ? {
            toolName: CODEX_QUESTION_TOOL_NAME,
            input: params,
            question: true,
            questions,
          }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Whether a file-change request asks for nothing beyond the turn's folder: no
 * extra write root, and every path it touches inside `cwd` — each change's own
 * path AND the destination of a move (`changeTargets`). That is the only change
 * `acceptEdits` takes without asking — a request that names a `grantRoot` is
 * codex asking to write somewhere its sandbox does not reach.
 *
 * Each target goes through `writeContainment`, the check `applyHostPatch` uses
 * too, on codex's RAW path: it must land inside both as written and resolved,
 * since how codex's own writer reads a `link/..` is not ours to rely on — a
 * path whose two readings disagree is a card rather than a guess. A target that
 * already exists must not share its file with another name either
 * ({@link hasOtherHardLinks}): writing it would change the other one, which may
 * sit outside the folder.
 */
export function fileChangeStaysIn(
  params: unknown,
  items: ReadonlyMap<string, CodexItem>,
  cwd: string,
): boolean {
  const record = asRecord(params) ?? {};
  if (asString(record.grantRoot)) {
    return false;
  }
  const item = items.get(asString(record.itemId) ?? '');
  const targets = changeTargets(item?.record.changes);
  return (
    targets.length > 0 &&
    targets.every(
      (target) =>
        target !== null &&
        writeContainment(cwd, target) === 'inside' &&
        !hasOtherHardLinks(cwd, target),
    )
  );
}

/**
 * The card for an elicitation that asks to run one MCP tool call, or null for
 * any other elicitation (a form the server wants filled, a URL to open).
 *
 * Named `mcp__<server>__<tool>`, the name the call's own row carries, so the
 * permission gate reads it like any MCP call — geniro's own tools included.
 * The tool is only named on the call's item, never on the request, so a call
 * that cannot be told apart from another keeps the bare server name and shows
 * codex's own sentence naming the tool: still answerable, and never labelled
 * with a tool it might not be.
 *
 * TWIN PARSER: the renderer's `namesGeniroMonitor`
 * (`apps/ui/src/renderer/chats/geniro-tool.ts`) reads both names this writes —
 * `mcp__<server>__<tool>`, and the bare `mcp__<server>` — to warn that
 * remembering a monitor approves every later monitor command.
 */
function mcpToolApprovalCard(
  record: Readonly<Record<string, unknown>>,
  items: ReadonlyMap<string, CodexItem>,
): CodexApprovalCard | null {
  const meta = asRecord(record._meta);
  if (asString(meta?.codex_approval_kind) !== CODEX_MCP_TOOL_APPROVAL_KIND) {
    return null;
  }
  const server = asString(record.serverName) ?? '';
  const call = openMcpCall(items, server, meta?.tool_params);
  const tool = call ? asString(call.record.tool) : null;
  const args = meta?.tool_params ?? call?.record.arguments ?? {};
  const message = asString(record.message);
  const options = mcpPersistsForSession(record) ? sessionOption() : [];
  return {
    ...(tool
      ? { toolName: mcpToolName(server, tool), input: args }
      : {
          toolName: `mcp__${server}`,
          input: message ? { message, arguments: args } : args,
        }),
    question: false,
    ...(options.length > 0 ? { options } : {}),
  };
}

/**
 * The MCP call on `server` this approval is for — the ONE running call whose
 * arguments match the approval's, or the only call running there at all — or
 * null when that is ambiguous: two calls with the same arguments cannot be told
 * apart, and a card naming the wrong one has the user approve another tool.
 */
function openMcpCall(
  items: ReadonlyMap<string, CodexItem>,
  server: string,
  args: unknown,
): CodexItem | null {
  const wanted = JSON.stringify(args ?? null);
  const running = [...items.values()].filter(
    (item) =>
      item.type === 'mcpToolCall' &&
      asString(item.record.server) === server &&
      asString(item.record.status) === 'inProgress',
  );
  const matching = running.filter(
    (item) => JSON.stringify(item.record.arguments ?? null) === wanted,
  );
  if (matching.length === 1) {
    return matching[0] ?? null;
  }
  return matching.length === 0 && running.length === 1
    ? (running[0] ?? null)
    : null;
}

/**
 * A `requestUserInput` params object as the user's question card — every
 * question with an id to answer it by, each option's description, and whether
 * codex marked the answer a secret. Codex offers no multi-select.
 */
export function codexCardQuestions(params: unknown): CardQuestion[] {
  return cardQuestions(codexQuestionEntries(params).map(({ draft }) => draft));
}

/** Stash the card's free-text answer for {@link encodeCodexReply}. */
export function withCodexAnswer(params: unknown, answer: string): unknown {
  return { ...(asRecord(params) ?? {}), [ANSWER_KEY]: answer };
}

/**
 * The reply codex expects for a server request, given the user's verdict.
 *
 * A question's answers are free text on this protocol, and the card collects
 * ONE reply — for several questions, a labelled entry each — so each question
 * is sent its own entry's value (`answersByQuestion`). The whole reply stands
 * in where an entry cannot be found (a caller's free-text answer has none),
 * but never on a card that asks for a secret: there an unfound entry is sent
 * no answer, so the secret reaches its own slot and no other. A denied
 * question sends no answers, which codex reads as the user declining to say.
 *
 * `decline` rather than `cancel` for a refused approval: `cancel` also ends
 * the turn, where the user said no to one action and the agent may carry on.
 *
 * `option` is the card's session-long answer when the user picked it; every
 * other verdict — and every auto-approval, which never passes one — is the
 * one-time `accept`, `scope: "turn"` or unpersisted MCP accept.
 */
export function encodeCodexReply(
  method: string,
  params: unknown,
  allow: boolean,
  updatedInput: unknown,
  option?: ApprovalOption,
): unknown {
  const forSession = allow && option?.id === CODEX_SESSION_APPROVAL_OPTION_ID;
  switch (method) {
    case CODEX_SERVER_REQUESTS.permissionsApproval:
      return allow
        ? {
            permissions: asRecord(params)?.permissions ?? {},
            scope: forSession ? CODEX_PERMISSION_SESSION_SCOPE : 'turn',
          }
        : { permissions: {}, scope: 'turn' };
    case CODEX_SERVER_REQUESTS.mcpElicitation:
      // The approval's schema is an empty object, so an accept carries an
      // empty one back.
      return allow
        ? {
            action: 'accept',
            content: {},
            _meta: forSession
              ? {
                  [CODEX_MCP_APPROVAL_PERSIST_KEY]:
                    CODEX_SESSION_APPROVAL_OPTION_ID,
                }
              : null,
          }
        : { action: 'decline', content: null, _meta: null };
    case CODEX_SERVER_REQUESTS.userInput: {
      if (!allow) {
        return { answers: {} };
      }
      const source = asRecord(updatedInput) ?? asRecord(params);
      const answer = asString(source?.[ANSWER_KEY]);
      const entries = codexQuestionEntries(params);
      // Every entry carries text, so the card keeps each of them and the two
      // lists stay aligned by position.
      const cards = cardQuestions(entries.map(({ draft }) => draft));
      const own = answer ? answersByQuestion(answer, cards) : [];
      const fallback = asksForSecret(cards) ? null : answer;
      const answers: Record<string, { answers: string[] }> = {};
      entries.forEach(({ id }, index) => {
        const value = answer ? (own[index] ?? fallback) : null;
        answers[id] = { answers: value ? [value] : [] };
      });
      return { answers };
    }
    default:
      return {
        decision: forSession
          ? CODEX_ACCEPT_FOR_SESSION_DECISION
          : allow
            ? 'accept'
            : 'decline',
      };
  }
}
