// The reading fixtures the partial-read suites share: the subject a notice names, the refusal a
// delivery failed with, and one reading state per kind.
//
// A duplicated fixture is worse than a duplicated helper here. `READING_STATE_KINDS` is a closed
// tuple and the record below is total over it, so a new kind fails to compile until its state is
// written. Copies would each need to fail and could be satisfied with a placeholder, and the
// vacuity guards walk the tuple, so a copy that fell behind would pass over fewer kinds.

import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import { type ReadingState, type ReadingStateKind } from "@renderer/lib/partial-read.js";

/** What the notices under test are notices about. */
export const READING_SUBJECT = "the queue";

/** The refusal a delivery failed with, and the one every suite here quotes. */
export const PARSE_REFUSAL: Refusal = refuse(
  "session-queue",
  "delivery-unreadable",
  "A queue delivery did not match the registered row shape.",
);

/**
 * One state per kind, total over the tuple: a kind added to `READING_STATE_KINDS` fails to
 * compile here instead of the vacuity guards walking a shorter set than the one under test.
 */
export const STATE_BY_KIND: Readonly<Record<ReadingStateKind, ReadingState>> = {
  served: { kind: "served" },
  reading: { kind: "reading" },
  refused: { kind: "refused", scope: "beside-an-answer", refusal: PARSE_REFUSAL },
  stale: { kind: "stale", refusal: PARSE_REFUSAL },
  partial: { kind: "partial", unreadableCount: 3, newestRefusal: PARSE_REFUSAL },
  cut: { kind: "cut", servedCount: 12 },
  unchecked: { kind: "unchecked", uncheckedCount: 4, newestRefusal: PARSE_REFUSAL },
};
