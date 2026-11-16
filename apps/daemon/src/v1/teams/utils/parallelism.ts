import { totalmem } from 'node:os';

import { sessionCeilingFor } from '../../agents/services/agent-session.registry';

/**
 * The floor, and it is the flat value both pools held before they were
 * derived: a smaller machine must not run its teams narrower than it did.
 */
const MIN_PARALLEL_AGENTS = 4;

/**
 * How many agents one team run drives at once, for a machine of this size
 * — the size of EACH of the executor's two pools (members' own turns, callee turns).
 *
 * It was a flat `4`, which is right for a 16GB laptop and absurd on the 128GB
 * machine it was reported from: a Manager fanning out to five workers ran four
 * of them and queued the rest while the session registry, already derived,
 * would have kept sixteen. So it is the SAME curve as
 * {@link sessionCeilingFor} — a running agent is the same ~1GB CLI process a
 * kept session is — never below the old flat value. Derived from TOTAL memory
 * for the reason that function gives: the same computer gets the same answer
 * on every launch.
 *
 * Two pools of this size can exceed the registry's ceiling between them, and
 * so can a lower limit the user set; the registry goes over its ceiling rather
 * than refuse a turn when no session may be closed (busy, or recently used),
 * so that costs memory, never a deadlock.
 */
export function parallelAgentsFor(totalMemoryBytes: number): number {
  return Math.max(MIN_PARALLEL_AGENTS, sessionCeilingFor(totalMemoryBytes));
}

/** The width this daemon runs teams at — {@link parallelAgentsFor} of this box. */
export const MAX_PARALLEL_AGENTS = parallelAgentsFor(totalmem());
