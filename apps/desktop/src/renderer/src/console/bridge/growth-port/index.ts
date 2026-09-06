// The growth port: the one object that refuses, by name, every wire the console is
// built against and the corpus has not registered.
//
// WHAT PUTS A MODULE HERE. The port itself, the slate rows its refusals cite, the
// operation entries that name each one, the prerequisite table, and the outcome
// vocabulary a served answer or a refusal travels in. Together they are the claim
// `Plan-023 §Console growth slate` is checkable against: a port whose every
// operation refuses plus a manifest that says which slate row each refusal serves.
//
// WHY IT IS NOT `growth-operations/`, `growth-signatures/` OR `growth-values/`.
// Those three are the per-plane TABLES — which operations exist, what each one's
// request and reply look like, and the named values those shapes are made of. This
// one is the mechanism they are read by. The four are siblings rather than nested,
// because a plane table is edited by the family landing that plane and the mechanism
// is edited by nobody once it works.
//
// A SUB-MODULE DOOR, NOT A SECOND FAMILY DOOR — `growth-values/index.ts` states the
// rule. `bridge/index.ts` re-exports the port's public face from the module that
// DECLARES each name, because `console-no-barrel-chain` fails a forward through here.
//
// AND THE PLANE TABLES DO NOT READ THIS DOOR. A door is an edge to every module it
// re-exports from, and this one re-exports `growth-port.ts`, which imports
// `growth-operations/index.js` and `growth-signatures/index.js`. So a plane table
// reaching this door closes `growth-operations/index.ts → growth-port/index.ts →
// growth-port.ts → growth-operations/index.ts`, which `no-circular` fails. Every
// `growth-operations/*` and `growth-signatures/*` reader therefore takes
// `growth-entry.js`, `growth-slate.js` and `growth-outcome.js` by their own
// specifier — the deep edge is the remedy for that one cycle, not an untidied
// import, and tidying it through this door turns the cruise red.

export type {
  GrowthOperationEntry,
  GrowthOperationId,
  GrowthPrerequisiteEntry,
} from "./growth-entry.js";

export type { GrowthOutcome } from "./growth-outcome.js";

export {
  createRefusingGrowthPort,
  growthScriptedReplyUnavailable,
  growthUnavailable,
  settledGrowthCall,
  type GrowthPort,
} from "./growth-port.js";

export { GROWTH_PREREQUISITES } from "./growth-prerequisites.js";

export { GROWTH_SLATE_ROWS, type GrowthSlateRow, type GrowthSlateRowId } from "./growth-slate.js";
