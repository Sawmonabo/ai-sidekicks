// The approval readings' sub-module door: what a SIBLING of this directory takes.
//
// A door because two siblings read from here — `growth-signatures/approvals.ts` takes
// the four narrowed row types the approval plane's operations answer with, and
// `fixture/fixture-growth-port.ts` takes the two readers that produce them — and the
// package's door rule keys on exactly that: a sub-module directory whose modules no
// sibling takes from carries no door, and one that a sibling reads from carries one.
// `bridge/queue/`, `bridge/quotas/` and `bridge/driver-capabilities/` are the other
// side of that same rule and are deliberately door-less.
//
// IT IS ACYCLIC FROM WHERE EITHER SIBLING STANDS, which is the condition the rule
// attaches to a door rather than an assumption about one. Nothing this door reaches
// climbs back into `bridge/`: `approval-records.ts` imports `zod` and its own sibling,
// `approval-vocabulary.ts` imports `primitives/`, and `approval-flow-projection.ts`
// imports `store/` — every one of them strictly below this family. So neither sibling
// needs the deep-specifier escape the family door records for `scenario-runtime/`.
//
// AND IT PUBLISHES WHAT A SIBLING TAKES AND NOTHING ELSE. The family door
// (`bridge/index.ts`) re-exports from the modules that DECLARE these symbols, never
// through this file, so a name here whose only reader is outside the family would be
// a specifier no production module reads — which the barrel census fails. The
// projector registrar and the whole approval vocabulary are therefore absent: both are
// reached through the family door by surfaces outside `bridge/`, and no sibling of
// this directory asks for either.

export {
  readApprovalProjection,
  readRememberedRuleList,
  type ApprovalRecord,
  type ApprovalResolveRequest,
  type ParsedRows,
  type RememberedRule,
} from "./approval-records.js";
