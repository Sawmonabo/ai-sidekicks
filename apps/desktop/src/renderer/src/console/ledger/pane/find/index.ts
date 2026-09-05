// The narrowing seam: showing less of this log, and reaching a row that is not on
// screen.
//
// THE SEAM THIS DIRECTORY OWNS. A find field, a facet filter, and a jump to an event
// id look like three surfaces and are one job: each of them decides which rows a
// person is asking for, and each has to answer honestly when the row they asked for
// exists and is not reachable. That honesty is why the classifier and the act sit
// together here — a jump that steps to a row the viewport does not hold reports a
// success nobody can see — and why the readings that count what the cap and the replay
// position hid are beside the walk that could not reach them.
//
// WHAT LEAVES. Everything these five modules export, which is unusual for a door and
// is the honest reading here: the feed composes all of it — the find state and its
// walk, the filter and the window it narrows, the jump's reach and the three acts that
// perform one, the reading a header renders, and the id-entry control. What the door
// buys is not concealment but a name: a sibling reads one seam instead of five files,
// and a name added here is a decision rather than a reachable file.

export { LedgerEventIdJump } from "./LedgerEventIdJump.js";
export { matchWalkReading } from "./ledger-find-readings.js";
export { useLedgerFind, type LedgerFindState } from "./ledger-find.js";
export {
  chapterRunIdOf,
  jumpOutcomeRowId,
  useDeferredRowJump,
  useEventIdJumpOutcome,
  useLedgerJumpReach,
  type LedgerJumpReach,
} from "./ledger-jump.js";
export {
  useFilteredLedgerWindow,
  useLedgerFilter,
  type LedgerFilterState,
} from "./ledger-narrowing.js";
