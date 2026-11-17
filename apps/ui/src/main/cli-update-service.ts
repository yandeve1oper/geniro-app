import type { CliKind, CliUpdateResult, CliUpdates } from '../shared/contracts';

export interface CliUpdateService {
  getState(): CliUpdates;
  /** Runs the CLI's updater, or joins the run already going for it. */
  update(kind: CliKind): Promise<CliUpdateResult>;
  forgetResults(): CliUpdates;
}

/**
 * Main's record of CLI updates. A renderer screen is unmounted when hidden, so
 * a press's spinner kept there ended with the screen while the updater ran on.
 */
export function createCliUpdateService(deps: {
  run: (kind: CliKind) => Promise<CliUpdateResult>;
  broadcast: (state: CliUpdates) => void;
}): CliUpdateService {
  const running = new Map<CliKind, Promise<CliUpdateResult>>();
  let results: Partial<Record<CliKind, CliUpdateResult>> = {};

  const getState = (): CliUpdates => ({
    updating: [...running.keys()],
    results: { ...results },
  });
  const emit = (): void => deps.broadcast(getState());

  const settle = (kind: CliKind, result: CliUpdateResult): CliUpdateResult => {
    running.delete(kind);
    results = { ...results, [kind]: result };
    emit();
    return result;
  };

  return {
    getState,
    update(kind) {
      const current = running.get(kind);
      if (current) {
        return current;
      }
      const rest = { ...results };
      delete rest[kind];
      results = rest;
      const run = Promise.resolve()
        .then(() => deps.run(kind))
        .then(
          (result) => settle(kind, result),
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            return settle(kind, {
              kind,
              ok: false,
              previousVersion: null,
              version: null,
              output: message,
              reason: message,
            });
          },
        );
      running.set(kind, run);
      emit();
      return run;
    },
    forgetResults() {
      results = {};
      emit();
      return getState();
    },
  };
}
