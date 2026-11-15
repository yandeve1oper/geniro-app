import { describe, expect, it } from 'vitest';

import { memorySearchInstructions } from './memory-search.instructions';

describe('memorySearchInstructions', () => {
  const text = memorySearchInstructions();

  it('makes a search the default at the start of any non-trivial task', () => {
    expect(text).toContain(
      'Search it by default at the start of any non-trivial task in this project',
    );
  });

  it('names what may skip it, with examples, and settles doubt with one quick search', () => {
    expect(text).toContain(
      'Skip it only for a request that stands on its own, such as the current date, a plain translation, or a question with nothing to do with this project.',
    );
    expect(text).toContain('If you are unsure, run one quick search.');
  });

  it('keeps the search short and lets the task go on without a match', () => {
    expect(text).toContain('Use one or two short queries');
    expect(text).toContain('with no match, carry on with the task');
  });

  it('asks for another search after an unexpected failure and before asking or guessing', () => {
    expect(text).toContain(
      'Search again when something fails in a way you did not expect, and before you ask the user a question or pick a convention on a guess',
    );
  });
});
