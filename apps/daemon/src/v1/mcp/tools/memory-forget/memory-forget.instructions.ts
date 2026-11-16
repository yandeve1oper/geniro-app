/** What a model reads about `memory_forget`. */
export function memoryForgetInstructions(): string {
  return (
    'Retire a shared memory entry that is wrong or no longer true, so no agent reads it again. Use ' +
    'it when you verified the entry is out of date or mistaken and there is nothing to keep; when ' +
    'it is only partly wrong, correct it with memory_save instead. Give the reason in one line — ' +
    'the user reads it, and the entry is kept so they can bring it back. While the user reviews ' +
    'agent writes, forgetting is refused: tell the user instead. Do NOT use it to tidy up ' +
    'entries you merely find unhelpful — mark those not_useful with memory_feedback.'
  );
}
