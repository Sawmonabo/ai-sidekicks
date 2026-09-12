// The confirmation sub-module's door.
//
// It carries one because two SIBLINGS take from it — `attach/ReattachControl.tsx` and
// `roots/RootDisposalConfirmation.tsx`, the family's two alert dialogs — which is the
// condition a sub-module door is keyed on.
//
// IT PUBLISHES THE HOOK AND NOT ITS RETURN TYPE. Both consumers reach the two handlers
// straight off the value, so a `ConfirmationLifecycle` line here would be a door widened
// for symmetry — which the barrel census fails, and did.

export { useConfirmationLifecycle } from "./confirmation-lifecycle.js";
