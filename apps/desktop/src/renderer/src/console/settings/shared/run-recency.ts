// One ordering over stored entities, for the two settings surfaces that ask which
// one a person was most recently looking at.
//
// HOISTED ON THE SECOND USE, which is the package rule. It was written inside
// `pages/application/updates/restart-impact.ts` for the restart confirmation's
// enumeration of moving runs, and the diagnostics page needs the identical ordering
// to pick which run it inspects. Both callers are inside this family, so this
// family's shared directory is the home; a second copy in either place would be two
// tie-breaks that agree until one of them is corrected.

import { compareInstants, parseInstant } from "../../core/index.js";
import type { ConsoleEntity } from "../../store/index.js";

/**
 * Newest `touchedAt` first; an entity with no timestamp sorts to the end.
 *
 * An absent stamp is not evidence of recency. Putting it at the head would make the
 * coldest row the one a surface names first, which is the opposite of what both
 * callers are asking for.
 *
 * TOTAL RATHER THAN MERELY CORRECT-ON-AVERAGE. Two entities touched in the same
 * millisecond are ordered by id, so the result does not depend on the key order of
 * the partition object — which moves when an unrelated entity arrives, and would
 * otherwise re-order a sentence nothing in it had changed.
 *
 * ORDERED BY THE MOMENT AND NEVER BY THE TEXT. Two RFC 3339 stamps naming one instant
 * differ as strings the moment one carries an offset and the other a `Z`, and a
 * `+01:00` stamp sorts AFTER the `Z` stamp it precedes — so a text comparison would
 * name the wrong row as the most recent whenever the two spellings met. The identical
 * string fast path above stays, because two identical strings are the same moment
 * however either is spelled.
 */
export function byNewestTouchedEntity(left: ConsoleEntity, right: ConsoleEntity): number {
  if (left.touchedAt === right.touchedAt) {
    return left.id.localeCompare(right.id);
  }
  if (left.touchedAt === undefined) {
    return 1;
  }
  if (right.touchedAt === undefined) {
    return -1;
  }
  return compareInstants(
    parseInstant(left.touchedAt),
    parseInstant(right.touchedAt),
    "newest-first",
  );
}
