// The mounts family's form-reconciliation door.
//
// A SUB-MODULE DOOR AND NOT A SECOND FAMILY DOOR, on `bridge/growth-values/index.ts`'s
// rule: it publishes to its own directory's siblings only — `attach/attach-model.ts`
// and `bind/bind-model.ts`, the two form models that reconcile a pick against a served
// answer — and nothing here has a reader outside `repos/`, so nothing here is on
// `repos/index.ts` at all. `ServedSelectionInputs` is deliberately absent: both callers
// pass an object literal, so a door line for it would be a specifier no production
// module reads, which `barrel-census` fails and knip reports besides.
export {
  resolveServedSelection,
  selectedChoiceOf,
  type ServedSelection,
} from "./served-selection.js";
