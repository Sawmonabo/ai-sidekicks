// How this family says a queue reading could not be taken.
//
// Split from `queue-reading.ts` because composing a refusal and holding a list are
// two jobs: the reading folds deliveries, seats snapshots, and tracks who is
// watching, and none of that is served by carrying the sentence it says when a
// delivery will not parse. That sentence is a pure function of what failed, so it is
// testable without a bridge and readable without the fold.
//
// WHAT IS HERE IS THIS STREAM'S WORDS, AND NOTHING ELSE IS. The unreadable-delivery
// refusal was written out here and again in `quotas/`, identical apart from the origin
// and the noun; `readings/` now composes it and this file binds it to what the queue
// says. Which stream refused and what it was reading is still this family's to say.

import {
  unreadableDeliveryRefusalComposerFor,
  type UnreadableDeliveryRefusalComposer,
} from "../readings/index.js";

/** The subsystem name every refusal the queue reading raises carries. */
export const QUEUE_REFUSAL_ORIGIN = "session-queue";

/** One unreadable queue delivery as the refusal a surface renders. */
export const unreadableQueueDeliveryRefusal: UnreadableDeliveryRefusalComposer =
  unreadableDeliveryRefusalComposerFor({
    origin: QUEUE_REFUSAL_ORIGIN,
    sentence: "A queue delivery did not match the registered row shape, so it changed no row here",
  });
