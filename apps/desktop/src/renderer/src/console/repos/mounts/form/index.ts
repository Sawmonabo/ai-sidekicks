// The mounts family's form-reconciliation door.
//
// A SUB-MODULE DOOR AND NOT A SECOND FAMILY DOOR: it publishes to `bind/bind-model.ts`
// only, the form model that reconciles a pick against a served answer, and nothing here
// has a reader outside `repos/`, so nothing here is on `repos/index.ts` at all.
// `ServedSelectionInputs` is deliberately absent: the one caller passes an object
// literal, so a door line for it would be a specifier no production module reads, which
// knip reports.
export {
  resolveServedSelection,
  selectedChoiceOf,
  type ServedSelection,
} from "./served-selection.js";
