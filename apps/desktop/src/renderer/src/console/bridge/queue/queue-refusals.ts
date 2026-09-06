// How this family says a queue reading could not be taken.
//
// Split from `queue-reading.ts` because composing a refusal and holding a list are
// two jobs: the reading folds deliveries, seats snapshots, and tracks who is
// watching, and none of that is served by carrying the sentences it says when a
// stream will not open or a delivery will not parse. Both are pure functions of what
// failed, so they are testable without a bridge and readable without the fold.

import {
  normalizeWireRejection,
  refuse,
  refusedMemberPaths,
  type ConsoleRefusal,
} from "../../core/index.js";
import type { UnreadableDeliveryIssues } from "../readings/index.js";

/** The subsystem name every refusal the queue reading raises carries. */
export const QUEUE_REFUSAL_ORIGIN = "session-queue";

/**
 * The refusal an unopenable stream settles as.
 *
 * The console's ONE reading of a rejected promise, consumed rather than re-derived.
 * `normalizeWireRejection` already unwraps a `ConsoleRefusalError`'s carried refusal
 * structurally — which is what keeps the subscription wrapper's own unscoped-open
 * code intact instead of replacing it with this module's origin and a stringified
 * message — and already takes a typed envelope's dotted code off `data.type`, where
 * a `{ code: string }` guard cannot see it. All this module supplies is the one
 * thing that is its own: the origin.
 *
 * NO FALLBACK PAIR, deliberately. The fallback exists for a seam that knows its
 * failure better than the thrown value does, and this one does not: a stream that
 * would not open failed for a transport reason the transport already states — "the
 * preload is a stub" is the sentence someone acts on, and a house sentence about a
 * live tail would displace it with a paraphrase that names nothing to fix.
 */
export function streamRefusalFor(rejection: unknown): ConsoleRefusal {
  return normalizeWireRejection(QUEUE_REFUSAL_ORIGIN, rejection);
}

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
