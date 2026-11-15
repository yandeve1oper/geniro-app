import { act } from 'react';

/** The labels a memory row's ⋯ menu offers, read by opening and closing it. */
export async function memoryRowActions(row: HTMLElement): Promise<string[]> {
  const trigger = row.querySelector<HTMLButtonElement>(
    'button[aria-label^="Actions for"]',
  );
  if (!trigger) {
    return [];
  }
  await act(async () => {
    trigger.click();
  });
  const labels = [
    ...document.querySelectorAll<HTMLElement>(
      '[role="listbox"] [role="option"]',
    ),
  ].map((option) => option.textContent?.trim() ?? '');
  await act(async () => {
    trigger.click();
  });
  return labels;
}

/** Open a memory row's ⋯ menu and press the entry labelled `label`. */
export async function pressMemoryRowAction(
  row: HTMLElement,
  label: string,
): Promise<void> {
  const trigger = row.querySelector<HTMLButtonElement>(
    'button[aria-label^="Actions for"]',
  );
  if (!trigger) {
    throw new Error('the row has no actions menu');
  }
  await act(async () => {
    trigger.click();
  });
  const option = [
    ...document.querySelectorAll<HTMLElement>(
      '[role="listbox"] [role="option"]',
    ),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!option) {
    throw new Error(`no "${label}" in the row's menu`);
  }
  await act(async () => {
    option.click();
  });
}
