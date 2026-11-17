import * as React from 'react';

import { HelpHint } from './help-hint';
import { Label } from './ui/label';

/**
 * A labelled form control with an optional hint line. Wraps any input/select in
 * the standard label + control + hint stack so every form field — onboarding,
 * settings, the future graph builder — is assembled identically.
 *
 * `htmlFor` is optional because a field's content is not always a labelable
 * control: a field that renders an explanation instead of an input must omit
 * it rather than point the label at an element that cannot receive focus.
 */
export function Field({
  label,
  htmlFor,
  hint,
  help,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: React.ReactNode;
  /** A longer plain-language explanation, behind a "?" beside the label. */
  help?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {help ? (
        <div className="flex items-center gap-1.5">
          <Label htmlFor={htmlFor}>{label}</Label>
          <HelpHint subject={label}>{help}</HelpHint>
        </div>
      ) : (
        <Label htmlFor={htmlFor}>{label}</Label>
      )}
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
