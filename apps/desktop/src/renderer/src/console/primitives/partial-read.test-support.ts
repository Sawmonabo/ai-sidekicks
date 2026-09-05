// The reading fixtures the partial-read suites share.
//
// Four suites around this module built the same three constants: the subject a notice
// names, the refusal a delivery failed with, and one reading state per kind. The
// refusal was byte-identical in all four and the state record byte-identical in two —
// which is the shape `apps/desktop/AGENTS.md`'s hoist-on-second-use rule is about, and
// a shape with a specific cost here rather than a general one.
//
// WHY A DUPLICATED FIXTURE IS WORSE THAN A DUPLICATED HELPER. `READING_STATE_KINDS` is
// a closed tuple, and the record below is total over it BY CONSTRUCTION: a kind added
// to the union fails to compile here until somebody writes the state for it. Four
// copies means four places that have to fail to compile and four places somebody can
// satisfy with a placeholder — and the vacuity guards in those suites walk the tuple,
// so a copy that fell behind would walk a shorter set than the one under test and
// report a pass over the kinds it still knew about.

import { refuse, type ConsoleRefusal } from "../core/index.js";
import { type ReadingState, type ReadingStateKind } from "./partial-read.js";

/** What the notices under test are notices ABOUT. */
export const READING_SUBJECT = "the queue";

/** The refusal a delivery failed with, and the one every suite here quotes. */
export const PARSE_REFUSAL: ConsoleRefusal = refuse(
  "session-queue",
  "delivery-unreadable",
  "A queue delivery did not match the registered row shape.",
);

/**
 * One state per kind, total over the tuple by construction.
 *
 * A record rather than an array so a kind added to `READING_STATE_KINDS` fails to
 * compile here — the vacuity guards that walk the tuple would otherwise walk a shorter
 * set than the one under test.
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
