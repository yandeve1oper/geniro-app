// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHECK_FOOTER,
  LESSON_BROKEN_AGAIN,
  LESSON_CORRECTION,
  LESSON_KNOWLEDGE_PROCEDURE,
  LESSON_MEMBER_RULE,
  LESSON_NO_PROJECT_PLACES,
  LESSON_PROJECT_RULE,
  LESSON_REFINES,
  PROJECT_DOCUMENTS,
  PROJECT_PLACES,
  REFLECTION_FOOTER,
} from '../__fixtures__/lessons';
import { formatUsd } from '../chats/agent-activity';
import { formatDuration } from '../stats/stats-format';
import {
  type LessonOutcomeView,
  LessonsCard,
  type LessonsCardProps,
} from './lessons-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LOOK = { formatDuration, formatUsd };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

async function render(
  props: Partial<LessonsCardProps> & Pick<LessonsCardProps, 'lessons'>,
): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <LessonsCard
        look={LOOK}
        outcomes={{}}
        reflection={REFLECTION_FOOTER}
        {...props}
      />,
    );
  });
  return container;
}

function buttonNamed(el: HTMLElement, name: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === name,
  );
  if (!found) {
    throw new Error(`no button named ${name}`);
  }
  return found;
}

function buttonContaining(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
  );
  if (!found) {
    throw new Error(`no button containing ${text}`);
  }
  return found;
}

function primaryButton(el: HTMLElement): HTMLButtonElement {
  const found = el.querySelector<HTMLButtonElement>(
    '[data-slot="split-button"] > button:first-child',
  );
  if (!found) {
    throw new Error('no primary action');
  }
  return found;
}

async function press(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
}

function typeInto(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(field) as object,
    'value',
  )?.set;
  act(() => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function outcome(
  proposalId: string,
  patch: Partial<LessonOutcomeView> = {},
): LessonOutcomeView {
  return {
    proposalId,
    status: 'saved',
    by: 'user',
    title: LESSON_CORRECTION.title,
    rule: LESSON_CORRECTION.rule,
    target: { kind: 'memory', scope: 'project', type: 'feedback' },
    memoryHandle: 'm21',
    resultRef: null,
    reason: null,
    ...patch,
  };
}

describe('LessonsCard — a lesson with no decision yet', () => {
  it('saves it to the scope it was proposed for, when Save is pressed', async () => {
    const onSave = vi.fn(async () => undefined);
    const el = await render({ lessons: [LESSON_CORRECTION], onSave });

    await press(primaryButton(el));

    expect(onSave).toHaveBeenCalledWith(LESSON_CORRECTION.id, {
      target: { kind: 'memory', scope: 'project', type: 'feedback' },
    });
  });

  it('sends the edited title and rule when Save follows an Edit', async () => {
    const onSave = vi.fn(async () => undefined);
    const el = await render({ lessons: [LESSON_CORRECTION], onSave });

    await press(buttonNamed(el, 'Edit'));
    typeInto(
      el.querySelector<HTMLInputElement>('input[aria-label="Lesson title"]')!,
      'Use pnpm for tests',
    );
    await press(primaryButton(el));

    expect(onSave).toHaveBeenCalledWith(
      LESSON_CORRECTION.id,
      expect.objectContaining({ title: 'Use pnpm for tests' }),
    );
  });

  it('sends the reject reason when one is typed, and none when it is left empty', async () => {
    const onReject = vi.fn(async () => undefined);
    const el = await render({ lessons: [LESSON_REFINES], onReject });

    await press(buttonNamed(el, 'Reject'));
    typeInto(
      el.querySelector<HTMLInputElement>('input[aria-label="Reject reason"]')!,
      'Not a rule',
    );
    await press(buttonNamed(el, 'Reject'));

    expect(onReject).toHaveBeenCalledWith(LESSON_REFINES.id, 'Not a rule');
  });
});

describe('LessonsCard — a lesson saved to memory', () => {
  it('reads saved automatically as searchable only, with Undo and Edit', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION],
      outcomes: {
        [LESSON_CORRECTION.id]: outcome(LESSON_CORRECTION.id, { by: 'auto' }),
      },
      onUndo: vi.fn(async () => undefined),
      onEdit: vi.fn(async () => undefined),
    });

    expect(el.textContent).toContain(
      'Saved to memory · project · Searchable only',
    );
    expect(buttonNamed(el, 'Undo')).toBeTruthy();
    expect(buttonNamed(el, 'Edit')).toBeTruthy();
  });

  it('names the entry an Update rule changed, and offers no Undo or Edit on it', async () => {
    const el = await render({
      lessons: [LESSON_REFINES],
      outcomes: {
        [LESSON_REFINES.id]: outcome(LESSON_REFINES.id, {
          memoryHandle: 'm12',
          resultRef: 'm12',
        }),
      },
      onUndo: vi.fn(async () => undefined),
      onEdit: vi.fn(async () => undefined),
    });

    expect(el.textContent).toContain('Updated m12');
    expect(() => buttonNamed(el, 'Undo')).toThrow();
    expect(() => buttonNamed(el, 'Edit')).toThrow();
  });

  it('undoes the lesson when Undo is pressed', async () => {
    const onUndo = vi.fn(async () => undefined);
    const el = await render({
      lessons: [LESSON_CORRECTION],
      outcomes: {
        [LESSON_CORRECTION.id]: outcome(LESSON_CORRECTION.id, { by: 'auto' }),
      },
      onUndo,
    });

    await press(buttonNamed(el, 'Undo'));

    expect(onUndo).toHaveBeenCalledWith(LESSON_CORRECTION.id);
  });

  it('edits the title and rule inline, and after Save reads as saved without the searchable note', async () => {
    const onEdit = vi.fn(async () => undefined);
    const el = await render({
      lessons: [LESSON_CORRECTION],
      outcomes: {
        [LESSON_CORRECTION.id]: outcome(LESSON_CORRECTION.id, { by: 'auto' }),
      },
      onEdit,
    });

    await press(buttonNamed(el, 'Edit'));
    typeInto(
      el.querySelector<HTMLInputElement>('input[aria-label="Lesson title"]')!,
      'Run tests through pnpm',
    );
    await press(buttonNamed(el, 'Save'));

    expect(onEdit).toHaveBeenCalledWith(LESSON_CORRECTION.id, {
      title: 'Run tests through pnpm',
      rule: LESSON_CORRECTION.rule,
    });
    expect(el.textContent).toContain('Saved to memory · project');
    expect(el.textContent).not.toContain('Searchable only');
  });

  it('reads saved by the user as saved, with no searchable note', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION],
      outcomes: { [LESSON_CORRECTION.id]: outcome(LESSON_CORRECTION.id) },
    });

    expect(el.textContent).toContain('Saved to memory · project');
    expect(el.textContent).not.toContain('Searchable only');
  });
});

describe('LessonsCard — a lesson waiting for review', () => {
  it('reads waiting for review, with Approve and Undo', async () => {
    const onApprove = vi.fn(async () => undefined);
    const el = await render({
      lessons: [LESSON_REFINES],
      outcomes: {
        [LESSON_REFINES.id]: outcome(LESSON_REFINES.id, { status: 'pending' }),
      },
      onApprove,
      onUndo: vi.fn(async () => undefined),
    });

    expect(el.textContent).toContain('Waiting for review');
    await press(buttonNamed(el, 'Approve'));

    expect(onApprove).toHaveBeenCalledWith(LESSON_REFINES.id);
  });
});

describe('LessonsCard — decided lessons with no actions left', () => {
  it('reads an undone lesson as undone, with no buttons', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION, LESSON_REFINES],
      outcomes: {
        [LESSON_CORRECTION.id]: outcome(LESSON_CORRECTION.id, {
          status: 'undone',
        }),
        [LESSON_REFINES.id]: outcome(LESSON_REFINES.id, {
          status: 'rejected',
          reason: 'Too broad',
        }),
      },
    });

    await press(buttonContaining(el, 'Lessons:'));

    expect(el.textContent).toContain('Undone');
    expect(el.textContent).toContain('✗ Rejected — Too broad');
    expect(el.querySelectorAll('button')).toHaveLength(1);
  });

  it('reads a duplicate as already in memory under its handle', async () => {
    const el = await render({
      lessons: [LESSON_BROKEN_AGAIN],
      outcomes: {
        [LESSON_BROKEN_AGAIN.id]: outcome(LESSON_BROKEN_AGAIN.id, {
          status: 'skipped_duplicate',
          memoryHandle: 'm7',
        }),
      },
    });

    await press(buttonContaining(el, 'Lessons:'));

    expect(el.textContent).toContain('Already in memory as m7');
  });
});

describe('LessonsCard — lessons the check dropped', () => {
  it('collapses them under one muted line that names the count', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION, LESSON_REFINES],
      outcomes: {
        [LESSON_CORRECTION.id]: outcome(LESSON_CORRECTION.id, {
          status: 'dropped_by_check',
          reason: 'Only a restatement of the repo docs',
        }),
        [LESSON_REFINES.id]: outcome(LESSON_REFINES.id, {
          status: 'dropped_by_check',
          reason: 'The user never corrected this',
        }),
      },
    });

    expect(el.textContent).toContain('2 dropped by the check');
    expect(el.textContent).not.toContain('Only a restatement of the repo docs');

    await press(buttonContaining(el, '2 dropped by the check'));

    expect(el.textContent).toContain('Only a restatement of the repo docs');
    expect(el.textContent).toContain('The user never corrected this');
  });
});

describe('LessonsCard — the footer', () => {
  it('reads the reflection with its CLI, model, effort, duration and cost', async () => {
    const el = await render({ lessons: [LESSON_CORRECTION] });

    expect(el.textContent).toContain(
      `Reflection: Claude · claude-haiku-5-5 · high · ${formatDuration(38_000)} · ${formatUsd(0.02)}`,
    );
  });

  it('adds a second line for the check when one ran', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION],
      check: CHECK_FOOTER,
    });

    expect(el.textContent).toContain(
      `Check: Claude · claude-opus-5-5 · high · ${formatDuration(21_000)} · ${formatUsd(0.27)}`,
    );
  });

  it('says the cost was not reported where the run reports none, never $0', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION],
      reflection: {
        ...REFLECTION_FOOTER,
        figures: { working: false, durationMs: 1_000, costUsd: null },
      },
    });

    expect(el.textContent).toContain('cost not reported');
    expect(el.textContent).not.toContain('$0');
  });

  it('says it is working while the run is still going', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION],
      reflection: {
        ...REFLECTION_FOOTER,
        figures: { working: true, durationMs: null, costUsd: null },
      },
    });

    expect(el.textContent).toContain(
      'Reflection: Claude · claude-haiku-5-5 · high · working…',
    );
  });
});

describe('LessonsCard — header', () => {
  it('counts undecided lessons as proposed', async () => {
    const el = await render({ lessons: [LESSON_CORRECTION, LESSON_REFINES] });

    expect(el.textContent).toContain('Lessons from this thread · 2 proposed');
  });

  it('counts a saved lesson as saved, not proposed', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION],
      outcomes: {
        [LESSON_CORRECTION.id]: outcome(LESSON_CORRECTION.id, { by: 'auto' }),
      },
    });

    expect(el.textContent).toContain('Lessons from this thread · 1 saved');
    expect(el.textContent).not.toContain('proposed');
  });

  it('counts each state on its own: proposed, saved and waiting for review', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION, LESSON_REFINES],
      outcomes: {
        [LESSON_REFINES.id]: outcome(LESSON_REFINES.id, { status: 'pending' }),
      },
    });

    expect(el.textContent).toContain(
      'Lessons from this thread · 1 proposed · 1 waiting for review',
    );
  });
});

describe('LessonsCard — settled', () => {
  it('folds into one summary line once nothing is left to decide, and opens on a press', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION, LESSON_REFINES],
      outcomes: {
        [LESSON_CORRECTION.id]: outcome(LESSON_CORRECTION.id, {
          status: 'rejected',
        }),
        [LESSON_REFINES.id]: outcome(LESSON_REFINES.id, {
          status: 'rejected',
        }),
      },
    });

    expect(el.textContent).toContain('Lessons: 2 rejected');
    expect(el.textContent).not.toContain('Reflection:');

    await press(buttonContaining(el, 'Lessons: 2 rejected'));

    expect(el.textContent).toContain('Reflection:');
  });

  it('stays open while a saved lesson can still be undone or edited', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION],
      outcomes: {
        [LESSON_CORRECTION.id]: outcome(LESSON_CORRECTION.id, { by: 'auto' }),
      },
    });

    expect(el.textContent).toContain('Reflection:');
  });
});

function optionNamed(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent?.includes(label));
  if (!found) {
    throw new Error(`no option named ${label}`);
  }
  return found;
}

function targetTrigger(el: HTMLElement): HTMLElement {
  const trigger = el.querySelector<HTMLElement>(
    '[aria-label="Choose where it goes"]',
  );
  if (!trigger) {
    throw new Error('no target picker');
  }
  return trigger;
}

describe('LessonsCard — the target a waiting lesson goes to', () => {
  it('names a project-instructions lesson in words, and saves it there', async () => {
    const onSave = vi.fn(async () => undefined);
    const el = await render({
      lessons: [LESSON_PROJECT_RULE],
      places: PROJECT_PLACES,
      onSave,
    });

    expect(primaryButton(el).textContent).toBe('Save to Project instructions');
    await press(primaryButton(el));

    expect(onSave).toHaveBeenCalledWith(LESSON_PROJECT_RULE.id, {
      target: { kind: 'project_instructions' },
    });
  });

  it('names a member lesson by the member, and saves it to that member', async () => {
    const onSave = vi.fn(async () => undefined);
    const el = await render({
      lessons: [LESSON_MEMBER_RULE],
      places: PROJECT_PLACES,
      onSave,
    });

    expect(primaryButton(el).textContent).toBe(
      'Save to Instructions of Reviewer',
    );
    await press(primaryButton(el));

    expect(onSave).toHaveBeenCalledWith(LESSON_MEMBER_RULE.id, {
      target: { kind: 'member_instructions', memberId: 'member-reviewer' },
    });
  });

  it('sends the target picked in the picker, not the one proposed', async () => {
    const onSave = vi.fn(async () => undefined);
    const el = await render({
      lessons: [LESSON_CORRECTION],
      places: PROJECT_PLACES,
      onSave,
    });

    await press(targetTrigger(el));
    await press(optionNamed('Project instructions'));
    await press(primaryButton(el));

    expect(onSave).toHaveBeenCalledWith(LESSON_CORRECTION.id, {
      target: { kind: 'project_instructions' },
    });
  });

  it('offers no project or member targets for a thread with no project', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION],
      places: LESSON_NO_PROJECT_PLACES,
      onSave: vi.fn(async () => undefined),
    });

    await press(targetTrigger(el));

    expect(optionNamed('Memory · global')).toBeTruthy();
    expect(
      [...document.querySelectorAll('[role="option"]')].some((option) =>
        option.textContent?.includes('Project instructions'),
      ),
    ).toBe(false);
  });

  it('never selects a target the thread has no place for: it falls back to memory and names the proposed one as unavailable', async () => {
    const onSave = vi.fn(async () => undefined);
    const el = await render({
      lessons: [LESSON_PROJECT_RULE],
      places: LESSON_NO_PROJECT_PLACES,
      onSave,
    });

    expect(primaryButton(el).textContent).toBe('Save to Memory · global');
    expect(el.textContent).toContain(
      'Proposed for Project instructions, which is unavailable: this thread belongs to no project.',
    );
    await press(targetTrigger(el));
    expect(
      (optionNamed('Project instructions') as HTMLButtonElement).disabled,
    ).toBe(true);
    await press(targetTrigger(el));
    await press(primaryButton(el));

    expect(onSave).toHaveBeenCalledWith(LESSON_PROJECT_RULE.id, {
      target: { kind: 'memory', scope: 'global', type: 'feedback' },
    });
  });

  it('reads the project documents only once the picker is opened', async () => {
    const readDocuments = vi.fn(async () => PROJECT_DOCUMENTS);
    const el = await render({
      lessons: [LESSON_KNOWLEDGE_PROCEDURE],
      places: PROJECT_PLACES,
      readDocuments,
    });

    expect(readDocuments).not.toHaveBeenCalled();

    await act(async () => {
      targetTrigger(el).dispatchEvent(
        new Event('pointerdown', { bubbles: true }),
      );
    });

    expect(readDocuments).toHaveBeenCalledWith('proj-1');
    expect(primaryButton(el).textContent).toBe(
      'Save to Knowledge · new document',
    );
  });

  it('never reads documents for a thread with no project', async () => {
    const readDocuments = vi.fn(async () => PROJECT_DOCUMENTS);
    const el = await render({
      lessons: [LESSON_KNOWLEDGE_PROCEDURE],
      places: LESSON_NO_PROJECT_PLACES,
      readDocuments,
    });

    await act(async () => {
      targetTrigger(el).dispatchEvent(
        new Event('pointerdown', { bubbles: true }),
      );
    });

    expect(readDocuments).not.toHaveBeenCalled();
  });

  it('lists a project document in the picker, and saves the lesson to it', async () => {
    const onSave = vi.fn(async () => undefined);
    const el = await render({
      lessons: [LESSON_KNOWLEDGE_PROCEDURE],
      places: PROJECT_PLACES,
      readDocuments: vi.fn(async () => PROJECT_DOCUMENTS),
      onSave,
    });

    await act(async () => {
      targetTrigger(el).dispatchEvent(
        new Event('pointerdown', { bubbles: true }),
      );
    });
    await press(targetTrigger(el));
    await press(optionNamed('k-release'));
    await press(primaryButton(el));

    expect(onSave).toHaveBeenCalledWith(LESSON_KNOWLEDGE_PROCEDURE.id, {
      target: { kind: 'knowledge', handle: 'k-release' },
    });
  });

  it('shows the daemon message in the card when Save is refused', async () => {
    const el = await render({
      lessons: [LESSON_MEMBER_RULE],
      places: PROJECT_PLACES,
      onSave: vi.fn(async () => {
        throw new Error('the member is gone from this team');
      }),
    });

    await press(primaryButton(el));

    expect(el.textContent).toContain('the member is gone from this team');
  });
});

describe('LessonsCard — a refines or broken-again lesson in memory', () => {
  it('offers Update rule naming the entry, and calls onUpdateRule', async () => {
    const onUpdateRule = vi.fn(async () => undefined);
    const el = await render({ lessons: [LESSON_REFINES], onUpdateRule });

    await press(buttonNamed(el, 'Update m12'));

    expect(onUpdateRule).toHaveBeenCalledWith(LESSON_REFINES.id, {});
  });

  it('sends the edited title and rule with Update rule', async () => {
    const onUpdateRule = vi.fn(async () => undefined);
    const el = await render({
      lessons: [LESSON_REFINES],
      onSave: vi.fn(async () => undefined),
      onUpdateRule,
    });

    await press(buttonNamed(el, 'Edit'));
    typeInto(
      el.querySelector<HTMLInputElement>('input[aria-label="Lesson title"]')!,
      'Regenerate the client first',
    );
    await press(buttonNamed(el, 'Update m12'));

    expect(onUpdateRule).toHaveBeenCalledWith(
      LESSON_REFINES.id,
      expect.objectContaining({ title: 'Regenerate the client first' }),
    );
  });

  it('offers saving as a new entry from the primary menu, which turns the button into that save', async () => {
    const onSave = vi.fn(async () => undefined);
    const onUpdateRule = vi.fn(async () => undefined);
    const el = await render({
      lessons: [LESSON_REFINES],
      onSave,
      onUpdateRule,
    });

    expect(() => buttonNamed(el, 'Save as new')).toThrow();
    await press(targetTrigger(el));
    await press(optionNamed('Memory · project'));
    expect(primaryButton(el).textContent).toBe('Save to Memory · project');
    await press(primaryButton(el));

    expect(onUpdateRule).not.toHaveBeenCalled();

    expect(onSave).toHaveBeenCalledWith(LESSON_REFINES.id, {
      target: { kind: 'memory', scope: 'project', type: 'feedback' },
    });
  });

  it('offers Move up for a broken-again lesson, into the memory index without a project', async () => {
    const onMoveUp = vi.fn(async () => undefined);
    const el = await render({
      lessons: [LESSON_BROKEN_AGAIN],
      places: LESSON_NO_PROJECT_PLACES,
      onMoveUp,
    });

    await press(buttonNamed(el, 'Move up to the memory index'));

    expect(onMoveUp).toHaveBeenCalledWith(LESSON_BROKEN_AGAIN.id);
  });

  it('keeps Move up on the memory index when the thread has a project, with the project instructions one pick away', async () => {
    const onSave = vi.fn(async () => undefined);
    const el = await render({
      lessons: [LESSON_BROKEN_AGAIN],
      places: PROJECT_PLACES,
      onMoveUp: vi.fn(async () => undefined),
      onSave,
    });

    expect(primaryButton(el).textContent).toBe('Move up to the memory index');

    await press(targetTrigger(el));
    await press(optionNamed('Project instructions'));
    await press(primaryButton(el));

    expect(onSave).toHaveBeenCalledWith(LESSON_BROKEN_AGAIN.id, {
      target: { kind: 'project_instructions' },
    });
  });
});

describe('LessonsCard — saved outside memory', () => {
  it('reads a project-instructions save as saved there, with no Undo or Edit', async () => {
    const el = await render({
      lessons: [LESSON_PROJECT_RULE],
      places: PROJECT_PLACES,
      outcomes: {
        [LESSON_PROJECT_RULE.id]: outcome(LESSON_PROJECT_RULE.id, {
          target: { kind: 'project_instructions' },
          memoryHandle: null,
        }),
      },
      onUndo: vi.fn(async () => undefined),
      onEdit: vi.fn(async () => undefined),
    });

    expect(el.textContent).toContain('Saved to project instructions');
    expect(el.querySelector('button')).toBeNull();
  });

  it('names the member a member-instructions save went to', async () => {
    const el = await render({
      lessons: [LESSON_MEMBER_RULE],
      places: PROJECT_PLACES,
      outcomes: {
        [LESSON_MEMBER_RULE.id]: outcome(LESSON_MEMBER_RULE.id, {
          target: { kind: 'member_instructions', memberId: 'member-reviewer' },
          memoryHandle: null,
        }),
      },
    });

    expect(el.textContent).toContain('Saved to Reviewer instructions');
  });

  it('names the document a knowledge save was appended to', async () => {
    const el = await render({
      lessons: [LESSON_KNOWLEDGE_PROCEDURE],
      places: PROJECT_PLACES,
      outcomes: {
        [LESSON_KNOWLEDGE_PROCEDURE.id]: outcome(
          LESSON_KNOWLEDGE_PROCEDURE.id,
          {
            target: { kind: 'knowledge', handle: 'k-release' },
            resultRef: 'k-release',
            memoryHandle: null,
          },
        ),
      },
    });

    expect(el.textContent).toContain('Saved to knowledge · k-release');
  });
});
