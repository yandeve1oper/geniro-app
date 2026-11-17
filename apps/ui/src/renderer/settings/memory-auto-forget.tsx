import { useRef, useState } from 'react';

import { ConfirmDialog } from '../components/confirm-dialog';
import { SettingsPanelRow } from '../components/settings-panel';
import { Select, type SelectGroup } from '../components/ui/select';
import { describeDaemonError } from '../daemon-api';
import { entries } from './use-memory-cleanup';

/** What the sweep with one window would take now, as the daemon counts it. */
export interface AutoForgetFigure {
  forget: number;
  warned: number;
  /** Earlier chats are still being counted, so `forget` may be high. */
  provisional: boolean;
}

const AUTO_FORGET_OFF = 'off';

/**
 * The windows the sweep can be armed with. Discrete rows, like the archive
 * retention's, so a typo cannot arm a far shorter window than meant; Off leads
 * because it is the default and forgets nothing.
 */
const AUTO_FORGET_OPTIONS: SelectGroup[] = [
  {
    items: [
      { value: AUTO_FORGET_OFF, label: 'Off' },
      { value: '30', label: 'After 30 days' },
      { value: '90', label: 'After 90 days' },
      { value: '180', label: 'After 180 days' },
    ],
  },
];

/**
 * The Clean up panel's automatic sweep: off by default, and armed only after a
 * confirm naming what it would forget now. Turning it off asks nothing, since
 * that forgets nothing. The caller leaves it out on a paired device.
 */
export function MemoryAutoForgetRow({
  days,
  figure,
  preview,
  onChange,
}: {
  /** The armed window; null when off, undefined until the setting is read. */
  days: number | null | undefined;
  /** What the armed window would take now; null while unknown. */
  figure: AutoForgetFigure | null;
  preview: (days: number) => Promise<AutoForgetFigure | null>;
  /** Saves the window; rejects, after reporting it, when it was not saved. */
  onChange: (days: number | null) => Promise<void>;
}): React.JSX.Element {
  const [pickedDays, setPickedDays] = useState<number | null>(null);
  const [counted, setCounted] = useState<AutoForgetFigure | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const question = useRef(0);

  const pick = (value: string): void => {
    setError(null);
    if (value === AUTO_FORGET_OFF) {
      void onChange(null).catch(() => undefined);
      return;
    }
    const picked = Number(value);
    const mine = ++question.current;
    setPickedDays(picked);
    setCounted(null);
    void preview(picked)
      .then((answer) => {
        if (mine === question.current) {
          setCounted(answer ?? { forget: 0, warned: 0, provisional: false });
        }
      })
      .catch((err: unknown) => {
        if (mine === question.current) {
          setError(describeDaemonError(err));
        }
      });
  };

  const cancel = (): void => {
    question.current += 1;
    setPickedDays(null);
    setCounted(null);
    setError(null);
  };

  const confirm = (): void => {
    if (pickedDays === null) {
      return;
    }
    setBusy(true);
    void onChange(pickedDays)
      .then(cancel)
      .catch((err: unknown) => setError(describeDaemonError(err)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <SettingsPanelRow
        label="Forget cold entries automatically"
        htmlFor="settings-memory-auto-forget"
        hint="Entries nobody has read, edited or restored for the chosen number of days are moved to Forgotten once a day, so the memory does not fill up with stale notes. Nothing is deleted, entries you marked Keep are left alone, and every run can be undone from Clean up. Off does nothing on its own."
        description={
          days === null || days === undefined
            ? 'Moves them to Forgotten, with Undo. Never deletes, never asks a model, never touches kept entries or entries with a warning.'
            : `Runs once a day and moves them to Forgotten, with Undo.${figure === null ? '' : ` Would forget ${entries(figure.forget)} now.`}`
        }>
        <Select
          id="settings-memory-auto-forget"
          className="w-44"
          groups={AUTO_FORGET_OPTIONS}
          value={
            days === null || days === undefined ? AUTO_FORGET_OFF : String(days)
          }
          disabled={days === undefined}
          onValueChange={pick}
          aria-label="Forget cold entries automatically"
        />
      </SettingsPanelRow>
      <ConfirmDialog
        open={pickedDays !== null}
        busy={busy}
        error={error}
        title="Forget cold entries automatically?"
        confirmLabel="Turn on"
        confirmVariant="default"
        busyLabel="Turning on…"
        confirmDisabled={counted === null}
        onCancel={cancel}
        onConfirm={confirm}>
        {counted === null ? (
          'Counting what it would forget…'
        ) : (
          <>
            Right now this would forget {entries(counted.forget)} that nobody
            has read, edited or restored for {pickedDays} days, and more over
            time.
            {counted.warned > 0
              ? ` ${entries(counted.warned)} with a warning ${counted.warned === 1 ? 'is' : 'are'} left alone.`
              : ''}
            {counted.provisional
              ? ' Earlier chats are still being counted, so the first run waits for that and may forget fewer.'
              : ''}{' '}
            Each run stays in Recent cleanups with Undo. It never deletes.
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
