// How far a wire reading has got, and what it could not read on the way.
//
// WHAT PUTS A MODULE HERE. A module that is about the READING rather than about any
// one wire: the phases a push-driven read passes through and the refusal it settles
// on, and the ledger that counts a delivery the console could not narrow instead of
// dropping it. Both were duplicated in `queue/` and in `quotas/` before they had a
// home — two folds of two different wires that had independently arrived at the same
// lifecycle — which is what makes this a directory rather than a pair of helpers
// parked beside one of its readers. The harness that settles a scheduled read sits
// here for the same reason and is published by nobody: it is about when a reading has
// finished, which is this subject and no one wire's.
//
// WHY THE FEEDS ARE NOT HERE. `queue/`, `quotas/` and `driver-capabilities/` each fold
// ONE wire; this folds none. A directory that held the mechanism and one of its
// consumers would make the second consumer's import read as a borrow from the first.
//
// A SUB-MODULE DOOR, NOT A SECOND FAMILY DOOR — `growth-values/index.ts` states the
// rule. `bridge/index.ts` re-exports from the declaring module, never through here.
//
// WHAT IS PUBLISHED IS WHAT A SIBLING TAKES. `readRefusalOf` and `WireReadPhase` are
// reached by co-located suites through their own deep specifiers and leave the console
// through `bridge/index.ts`; a door line for either would be an export no module
// reaches, which the dead-code gate reports and the barrel census counts.

export { WireReadLifecycle, type WireReadState } from "./reading-lifecycle.js";

export {
  UnreadableDeliveryLedger,
  type UnreadableDeliveryIssues,
  type UnreadableDeliveryReading,
} from "./unreadable-deliveries.js";
