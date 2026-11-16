import { SettingRow } from './setting-row';
import { SegmentedControl } from './ui/segmented-control';

/** A scope's choice: its own value, or whatever the scope above it resolves to. */
export type LessonsChoice = 'inherit' | 'on' | 'off';

const CHOICES: readonly { id: LessonsChoice; label: string }[] = [
  { id: 'inherit', label: 'Inherit' },
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
];

export const LESSONS_APP_OFF_REASON =
  'Off in Settings → Memory — turn it on there first';

export function LessonsOverrideControl({
  value,
  onChange,
  inheritedLabel,
  disabled = false,
  disabledReason,
}: {
  value: LessonsChoice;
  onChange: (next: LessonsChoice) => void;
  /** What inherit resolves to right now, e.g. "Inherit (On — app setting)". */
  inheritedLabel: string;
  /** Locks the control while the app's own setting makes the choice moot. */
  disabled?: boolean;
  /** Replaces the hint while the control is locked. */
  disabledReason?: string;
}): React.JSX.Element {
  const hint =
    disabled && disabledReason !== undefined ? disabledReason : inheritedLabel;
  return (
    <SettingRow label="Lessons" hint={hint}>
      <SegmentedControl
        ariaLabel="Lessons"
        options={CHOICES}
        value={value}
        disabled={disabled}
        onSelect={(next) => {
          if (next !== value) {
            onChange(next);
          }
        }}
      />
    </SettingRow>
  );
}
