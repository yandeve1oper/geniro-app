/** What a model reads about `ask_user_question`. */
export function askUserQuestionInstructions(answeringACall: boolean): string {
  return (
    'Ask the USER a multiple-choice question and WAIT for their answer. ' +
    'Use it when a choice is genuinely theirs to make — an ambiguous requirement, a decision between real alternatives, ' +
    'anything where guessing wrong would waste the work. Do NOT use it for questions you can answer from the code, ' +
    'and never to check in on something already decided. ' +
    (answeringACall
      ? 'You are answering a call, so the question goes to the agent that called you, which answers it or puts it to the user. '
      : '') +
    'The answer comes back as text; when it cannot be put to them the result says so and you continue in your reply instead. ' +
    'If the call times out, the card is STILL on screen and the person may still be answering it: call this tool again with the ' +
    'IDENTICAL title and questions to keep waiting — that re-attaches to the same card and returns their answer as soon as it ' +
    'arrives, including one given while you were not waiting. Changing a word raises a second card and asks them twice.'
  );
}
