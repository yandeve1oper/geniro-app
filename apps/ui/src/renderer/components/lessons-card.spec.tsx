// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LESSON_BROKEN_AGAIN,
  LESSON_CORRECTION,
  LESSON_REFINES,
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

async function choose(
  el: HTMLElement,
  label: string,
  option: string,
): Promise<void> {
  const trigger = el.querySelector<HTMLElement>(
    `[data-menu-trigger][aria-label="${label}"]`,
  );
  if (!trigger) {
    throw new Error(`no select ${label}`);
  }
  await press(trigger);
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((candidate) => candidate.textContent?.trim() === option);
  if (!item) {
    throw new Error(`no option ${option}`);
  }
  await press(item);
}

const SAVED: LessonOutcomeView = {
  proposalId: LESSON_CORRECTION.id,
  status: 'saved',
  title: LESSON_CORRECTION.title,
  target: { kind: 'memory', scope: 'project', type: 'feedback' },
  memoryHandle: 'm12',
  reason: null,
};

async function optionsOf(el: HTMLElement, label: string): Promise<string[]> {
  const trigger = el.querySelector<HTMLElement>(
    `[data-menu-trigger][aria-label="${label}"]`,
  );
  if (!trigger) {
    throw new Error(`no select ${label}`);
  }
  await press(trigger);
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
    (option) => option.textContent?.trim() ?? '',
  );
}

describe('LessonsCard', () => {
  it('draws each lesson with its title, why, chips and an evidence disclosure', async () => {
    const el = await render({ lessons: [LESSON_CORRECTION] });

    expect(el.textContent).toContain('Lessons from this thread · 1 proposed');
    expect(el.textContent).toContain(LESSON_CORRECTION.title);
    expect(el.textContent).toContain(LESSON_CORRECTION.why);
    expect(el.textContent).toContain('User correction');
    expect(el.textContent).toContain('New');
    expect(el.textContent).toContain('→ Memory · project');
    expect(el.textContent).not.toContain('не запускай vitest');

    await press(buttonContaining(el, 'Evidence · message #31'));

    expect(el.textContent).toContain('не запускай vitest');
  });

  it('jumps the transcript to the evidence row from Show in thread, and draws no link without a jump', async () => {
    const onShowInThread = vi.fn();
    const el = await render({ lessons: [LESSON_CORRECTION], onShowInThread });

    await press(buttonContaining(el, 'Evidence · message #31'));
    await press(buttonNamed(el, 'Show in thread'));

    expect(onShowInThread).toHaveBeenCalledWith(31);

    const bare = await render({ lessons: [LESSON_CORRECTION] });
    await press(buttonContaining(bare, 'Evidence · message #31'));
    expect(() => buttonNamed(bare, 'Show in thread')).toThrow();
  });

  it('shows the rule in full under its title when the two differ', async () => {
    const el = await render({
      lessons: [
        {
          ...LESSON_CORRECTION,
          rule: 'Run tests through the package script only.',
        },
      ],
    });

    expect(el.textContent).toContain(
      'Run tests through the package script only.',
    );
  });

  it('names the dedup verdict with the memory entry it refines or breaks', async () => {
    const el = await render({
      lessons: [LESSON_REFINES, LESSON_BROKEN_AGAIN],
    });

    expect(el.textContent).toContain('Refines m12');
    expect(el.textContent).toContain('Broken again m7');
    expect(el.textContent).toContain('Failing step, then fixed');
    expect(el.textContent).toContain('Review finding');
  });

  it('saves with the scope picked and the title and rule as edited', async () => {
    const onSave = vi.fn(async () => undefined);
    const el = await render({ lessons: [LESSON_CORRECTION], onSave });

    await press(buttonNamed(el, 'Edit'));
    typeInto(
      el.querySelector<HTMLInputElement>('input[aria-label="Lesson title"]')!,
      'Run tests through the package filter',
    );
    typeInto(
      el.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Lesson rule"]',
      )!,
      'Use the package filter for every test run.',
    );
    await choose(el, 'Save to', 'Memory · team');
    await press(buttonNamed(el, 'Save'));

    expect(onSave).toHaveBeenCalledWith(LESSON_CORRECTION.id, {
      target: { kind: 'memory', scope: 'team', type: 'feedback' },
      title: 'Run tests through the package filter',
      rule: 'Use the package filter for every test run.',
    });
  });

  it('sends only the target when the lesson was not edited', async () => {
    const onSave = vi.fn(async () => undefined);
    const el = await render({ lessons: [LESSON_CORRECTION], onSave });

    await press(buttonNamed(el, 'Save'));

    expect(onSave).toHaveBeenCalledWith(LESSON_CORRECTION.id, {
      target: { kind: 'memory', scope: 'project', type: 'feedback' },
    });
  });

  it('sends the typed reason with Reject', async () => {
    const onReject = vi.fn(async () => undefined);
    const el = await render({ lessons: [LESSON_CORRECTION], onReject });

    await press(buttonNamed(el, 'Reject'));
    typeInto(
      el.querySelector<HTMLInputElement>('input[aria-label="Reject reason"]')!,
      '  too narrow  ',
    );
    await press(buttonNamed(el, 'Reject'));

    expect(onReject).toHaveBeenCalledWith(LESSON_CORRECTION.id, 'too narrow');
  });

  it('sends no reason when Reject is confirmed with the field left empty', async () => {
    const onReject = vi.fn(async () => undefined);
    const el = await render({ lessons: [LESSON_CORRECTION], onReject });

    await press(buttonNamed(el, 'Reject'));
    await press(buttonNamed(el, 'Reject'));

    expect(onReject).toHaveBeenCalledWith(LESSON_CORRECTION.id, null);
  });

  it('shows a saved lesson as its verdict line, named, with the memory it became', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION, LESSON_REFINES],
      outcomes: { [LESSON_CORRECTION.id]: SAVED },
    });

    expect(el.textContent).toContain(
      `✓ “${LESSON_CORRECTION.title}” saved to memory · project as m12`,
    );
    expect(el.textContent).not.toContain('Evidence · message #31');
  });

  it('shows a rejected lesson as its verdict line, named, with the reason', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION, LESSON_REFINES],
      outcomes: {
        [LESSON_CORRECTION.id]: {
          proposalId: LESSON_CORRECTION.id,
          status: 'rejected',
          title: LESSON_CORRECTION.title,
          target: LESSON_CORRECTION.target,
          memoryHandle: null,
          reason: 'too narrow',
        },
      },
    });

    expect(el.textContent).toContain(
      `✗ “${LESSON_CORRECTION.title}” rejected — too narrow`,
    );
  });

  it('tells two decided lessons apart by their titles', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION, LESSON_REFINES],
      outcomes: {
        [LESSON_CORRECTION.id]: SAVED,
        [LESSON_REFINES.id]: {
          proposalId: LESSON_REFINES.id,
          status: 'rejected',
          title: LESSON_REFINES.title,
          target: LESSON_REFINES.target,
          memoryHandle: null,
          reason: null,
        },
      },
    });
    await press(buttonContaining(el, 'Lessons: 1 saved · 1 rejected'));

    expect(el.textContent).toContain(`“${LESSON_CORRECTION.title}” saved`);
    expect(el.textContent).toContain(`✗ “${LESSON_REFINES.title}” rejected`);
  });

  it('collapses to a summary once every lesson is handled, and opens on press', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION, LESSON_REFINES],
      outcomes: {
        [LESSON_CORRECTION.id]: SAVED,
        [LESSON_REFINES.id]: {
          proposalId: LESSON_REFINES.id,
          status: 'rejected',
          title: LESSON_REFINES.title,
          target: LESSON_REFINES.target,
          memoryHandle: null,
          reason: null,
        },
      },
    });

    expect(el.textContent).toContain('Lessons: 1 saved · 1 rejected');
    expect(el.textContent).not.toContain(`“${LESSON_CORRECTION.title}” saved`);

    await press(buttonContaining(el, 'Lessons: 1 saved · 1 rejected'));

    expect(el.textContent).toContain(`“${LESSON_CORRECTION.title}” saved`);
    expect(el.textContent).toContain(`✗ “${LESSON_REFINES.title}” rejected`);
  });

  it('keeps the hint that nothing reaches agents until a lesson is decided, and drops it once all are', async () => {
    const undecided = await render({ lessons: [LESSON_CORRECTION] });
    expect(undecided.textContent).toContain(
      "Nothing reaches agents' instructions until you save it.",
    );

    const decided = await render({
      lessons: [LESSON_CORRECTION],
      outcomes: { [LESSON_CORRECTION.id]: SAVED },
    });
    await press(buttonContaining(decided, 'Lessons: 1 saved · 0 rejected'));

    expect(decided.textContent).not.toContain(
      "Nothing reaches agents' instructions until you save it.",
    );
  });

  it('offers only the scopes the thread has a place for, and global', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION],
      onSave: vi.fn(async () => undefined),
      places: { project: false, team: true },
    });

    expect(await optionsOf(el, 'Save to')).toEqual([
      'Memory · team',
      'Memory · global',
    ]);
  });

  it('offers the project scope on a thread that has one, and not the team', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION],
      onSave: vi.fn(async () => undefined),
      places: { project: true, team: false },
    });

    expect(await optionsOf(el, 'Save to')).toEqual([
      'Memory · project',
      'Memory · global',
    ]);
  });

  it('offers every scope when the thread’s places are not known', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION],
      onSave: vi.fn(async () => undefined),
    });

    expect(await optionsOf(el, 'Save to')).toEqual([
      'Memory · project',
      'Memory · team',
      'Memory · global',
    ]);
  });

  it('starts on global when the lesson’s own scope has no place in the thread, and saves there', async () => {
    const onSave = vi.fn(async () => undefined);
    const el = await render({
      lessons: [LESSON_CORRECTION],
      onSave,
      places: { project: false, team: true },
    });

    expect(el.textContent).toContain('→ Memory · global');
    expect(
      el.querySelector('[data-menu-trigger][aria-label="Save to"]')
        ?.textContent,
    ).toContain('Memory · global');

    await press(buttonNamed(el, 'Save'));

    expect(onSave).toHaveBeenCalledWith(LESSON_CORRECTION.id, {
      target: { kind: 'memory', scope: 'global', type: 'feedback' },
    });
  });

  it('says nothing passed the bar when a reflection proposed no lesson', async () => {
    const el = await render({ lessons: [] });

    expect(el.textContent).toContain('Lessons from this thread · 0 proposed');
    expect(el.textContent).toContain(
      'No lessons from this stretch — nothing passed the bar.',
    );
    expect(el.textContent).not.toContain('Lessons: 0 saved');
  });

  it('never shows $0 for a reflection whose cost is unknown', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION],
      reflection: { ...REFLECTION_FOOTER, costUsd: null, tokens: 4200 },
    });

    expect(el.textContent).toContain('≈4200 tokens');
    expect(el.textContent).not.toContain('$0');
  });

  it('shows the measured cost when the CLI reports one', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION],
      reflection: { ...REFLECTION_FOOTER, costUsd: 0.02 },
    });

    expect(el.textContent).toContain(
      'Reflection: Claude · claude-haiku-5-5 · 38s · $0.02',
    );
  });

  it('reads working while the reflection is still running', async () => {
    const el = await render({
      lessons: [LESSON_CORRECTION],
      reflection: { ...REFLECTION_FOOTER, working: true },
    });

    expect(el.textContent).toContain(
      'Reflection: Claude · claude-haiku-5-5 · working…',
    );
  });

  it('disables every action when there is no API to call', async () => {
    const el = await render({ lessons: [LESSON_CORRECTION] });

    expect(buttonNamed(el, 'Save').disabled).toBe(true);
    expect(buttonNamed(el, 'Edit').disabled).toBe(true);
    expect(buttonNamed(el, 'Reject').disabled).toBe(true);
  });

  it('shows the message of a save the daemon refused, under the lesson', async () => {
    const onSave = vi.fn(() =>
      Promise.reject(new Error('Pick a project first')),
    );
    const el = await render({ lessons: [LESSON_CORRECTION], onSave });

    await press(buttonNamed(el, 'Save'));

    expect(el.textContent).toContain('Pick a project first');
    expect(buttonNamed(el, 'Save').disabled).toBe(false);
  });

  it('holds the buttons disabled and says Saving while a save is in flight', async () => {
    const onSave = vi.fn(() => new Promise<void>(() => undefined));
    const el = await render({ lessons: [LESSON_CORRECTION], onSave });

    await press(buttonNamed(el, 'Save'));

    expect(buttonNamed(el, 'Saving…').disabled).toBe(true);
    expect(buttonNamed(el, 'Edit').disabled).toBe(true);
    expect(buttonNamed(el, 'Reject').disabled).toBe(true);
  });
});
