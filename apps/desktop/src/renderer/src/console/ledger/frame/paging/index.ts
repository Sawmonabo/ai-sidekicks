// The backward walk's door — what the viewport beside it mounts.
//
// TWO NAMES, AND THE COUNT IS THE POINT. A sub-module door publishes what a SIBLING
// takes, and the sibling here is `viewport/`, which mounts the head control and types
// the value it hands it. `useLedgerEarlierPaging` is deliberately absent: its only
// reader is the feed, which is outside this family and reaches it through the family
// door — and a door line no sibling reads is a dead export the barrel census fails.
//
// THE SHEET IS NOT HERE. The two classes this directory's control wears are the
// VIEWPORT's — `meridian-ledger-viewport__head` beside the tail affordance's own — and
// they live in `frame.css` with the surface they are positioned against, because two
// affordances floating at the two ends of one box are one piece of geometry and a
// second sheet declaring half of it would be a second owner of that box's insets.

export { LoadEarlierAffordance } from "./LoadEarlierAffordance.js";
export { type LedgerEarlierPaging } from "./paging-binding.js";
