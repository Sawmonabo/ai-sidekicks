// How this family says a queue reading could not be taken.
//
// Split from `queue-reading.ts` because composing a refusal and holding a list are
// two jobs: the reading folds deliveries, seats snapshots, and tracks who is
// watching, and none of that is served by carrying the sentences it says when a
// stream will not open or a delivery will not parse. Both are pure functions of what
// failed, so they are testable without a bridge and readable without the fold.

import { refuse, refusedMemberPaths, type ConsoleRefusal } from "../../core/index.js";
import type { UnreadableDeliveryIssues } from "../readings/index.js";

/** The subsystem name every refusal the queue reading raises carries. */
export const QUEUE_REFUSAL_ORIGIN = "session-queue";

/**
 * One unreadable delivery as the refusal a surface renders.
 *
 * Names the failing MEMBER PATHS and never the payload: the payload is a frame
 * this build could not read, so quoting it would put an unbounded and unvalidated
 * value on screen to explain why an unvalidated value was refused. The path set is
 * fixed by the registered schema, which is what makes the sentence bounded without
 * a cap to spend.
 *
 * The parameter is the ledger's own issue shape: it declared `message` too and read
 * it nowhere, and a composer demanding a member it never reads is not admissible
 * where the ledger holds one.
 */
export function unreadableDeliveryRefusal(issues: UnreadableDeliveryIssues): ConsoleRefusal {
  const members = refusedMemberPaths(issues);
  return refuse(
    QUEUE_REFUSAL_ORIGIN,
    "delivery-unreadable",
    `A queue delivery did not match the registered row shape, so it changed no row here: ${members.join(", ")}.`,
  );
}
