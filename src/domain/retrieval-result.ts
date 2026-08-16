/**
 * What a search finally hands back, per Memory.
 *
 * This module owns the shape of a retrieval result and nothing else. It exists
 * because that shape is assembled by several stages in turn — ranking decides
 * the order, the revalidation contract says what to re-establish, dead-end
 * handling says where not to look, conflict handling says what disagrees —
 * and each of those has its own module with its own concerns. Putting the
 * envelope in any one of them would make that one the home of a type the
 * others keep adding to.
 *
 * The envelope started in the revalidation module, which was the right place
 * while revalidation was the only thing hanging off a ranked candidate. It is
 * here now because it stopped being that, and the fields are nested rather
 * than flattened so a reader can see which stage each answer came from.
 */

import type { ConflictContext } from './retrieval-conflict.js';
import type { DeadEndWarning } from './retrieval-dead-end.js';
import type { RankedMemoryCandidate } from './retrieval-ranking.js';
import type { RevalidationContext } from './retrieval-revalidation.js';

/**
 * A ranked Memory with its historical context attached, before dead-end
 * handling has run.
 *
 * An intermediate shape rather than a stage in a taxonomy: it exists because
 * the revalidation service genuinely returns this and the dead-end service
 * genuinely takes it, and naming it is cheaper than either passing the final
 * type around half-built or having a service return something anonymous.
 */
export interface RevalidatedMemoryCandidate {
  readonly ranking: RankedMemoryCandidate;
  readonly revalidation: RevalidationContext;
}

/**
 * A ranked Memory with its history and its dead ends, before conflict handling
 * has run.
 *
 * The same kind of intermediate as the one above, and here for the same
 * reason: the dead-end service returns exactly this and the conflict service
 * takes exactly this.
 *
 * Empty warnings mean nothing was recorded as a dead end. That is not a
 * recommendation: an unexplored direction and one nobody wrote down look
 * identical from here.
 */
export interface DeadEndAwareMemoryCandidate extends RevalidatedMemoryCandidate {
  readonly deadEndWarnings: readonly DeadEndWarning[];
}

/**
 * One Memory as a search offers it.
 *
 * `ranking` is why it is here and in this position. `revalidation` is what was
 * true when it was recorded and what to re-establish before believing it.
 * `deadEndWarnings` is where it has already been shown not to lead.
 * `conflict` is where another Memory disagrees with it, and the material for
 * working out which applies here.
 *
 * Every one of the four is material rather than a verdict. Between them they
 * say why this Memory came up, what it was true of, where it does not lead,
 * and what contradicts it — and none of them says what to do, because that
 * depends on conditions this process cannot see.
 */
export interface RetrievalMemoryCandidate extends DeadEndAwareMemoryCandidate {
  readonly conflict: ConflictContext;
}
