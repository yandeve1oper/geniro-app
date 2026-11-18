import type { EntityManager } from '@mikro-orm/sqlite';

/**
 * A manager for specs whose DAOs are fakes: every fork is the same manager, so
 * code that forks again (the item insert seam) and clears after a write runs
 * as it does on a real one.
 */
export function fakeEntityManager(): EntityManager {
  const em = {
    clear: () => undefined,
    fork: () => em,
  };
  return em as unknown as EntityManager;
}
