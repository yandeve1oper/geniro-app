import { useEffect, useState } from 'react';

import type { LessonsMode } from '../../shared/contracts';

/** The app's lessons mode from Settings, kept current; null until it is first read. */
export function useAppLessonsMode(): LessonsMode | null {
  const [mode, setMode] = useState<LessonsMode | null>(null);
  useEffect(() => {
    const read = (): void => {
      void window.geniro
        .getSettings()
        .then((settings) => setMode(settings.lessons.mode))
        .catch(() => undefined);
    };
    read();
    return window.geniro.onSettingsChanged(read);
  }, []);
  return mode;
}
