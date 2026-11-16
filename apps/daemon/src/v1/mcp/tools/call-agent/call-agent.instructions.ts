import {
  ANSWERING_A_CALL,
  ANSWERING_WITH_CALLS_OUT,
  CALL_RESULT_ACTIONS,
  CALL_RESULT_PAGES,
} from '../../../teams/utils/callee-text';

/**
 * What a model reads about `call_agent`.
 *
 * `callable` is the one-line roster of this member's callees
 * (`calleeSummary`, joined) — each callee's public role is the routing
 * signal, so no role has to carry a hand-written roster. `answeringACall` is
 * true when the asker is itself a callee, answering a call.
 */
export function callAgentInstructions(
  callable: string,
  answeringACall: boolean,
): string {
  return (
    `Invoke another member of your team and get its result envelope. Callable now: ${callable}. A member waiting on your own answer cannot be called. ` +
    'Choose by what each agent says it does; when none of them fits the task, do it yourself or ask the user rather than forcing it on the closest one. ' +
    'PREFER mode "async" for any task that is not a quick lookup: a sync call blocks you for the whole of the callee\'s work, and you are the one the user and your other callees are waiting on. ' +
    'After an async call you do NOT wait for it: carry on with other work, launch more calls in parallel, or END YOUR TURN — when a callee finishes or asks you a question after your turn has ended, you are started again with a message naming the call, and you collect it with await_agent. ' +
    // A callee reads "end your turn" as leave-with-what-you-have;
    // for it, the turn ending is not the call ending.
    (answeringACall ? `${ANSWERING_A_CALL} ${ANSWERING_WITH_CALLS_OUT} ` : '') +
    'Use sync only when you cannot take your next step without the answer and expect it quickly. ' +
    'A sync call that outlasts one tool call\'s window answers {"status":"pending"} with its call_id — not a failure: the call carries on, and you collect it with await_agent. ' +
    'An envelope of {"status":"question",...} means the callee PAUSED to ask you something: answer it with answer_agent ' +
    'only when your role/context makes you confident; otherwise ask the user yourself and relay their answer. ' +
    'After answering, collect the final result with await_agent(call_id). ' +
    'Check the envelope\'s call_id: a question from ANOTHER of your calls can arrive here too, and then "still_running" names this call, which you collect later with await_agent. ' +
    `${CALL_RESULT_PAGES} ` +
    `${CALL_RESULT_ACTIONS} ` +
    'An agent listed with an "agent pool" runs on numbered configurations (CLI, model, account) in priority order: a new conversation uses member 1 first, skipping members with a recent usage limit or lapsed sign-in while they recover. If a member hits a usage limit, is signed out, or fails before doing any work, the call falls back to the next member in priority order — the envelope\'s "member" says which ran it and "pool_skipped" which failed. ' +
    'Omit member unless the user requests a specific pool member, CLI, model, or account; then pass its member number: the call starts there, still falls back the same way when that member is spent, and returns to it once it is available again.'
  );
}
