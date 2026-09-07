// The runtime-node read seams' sub-module door.
//
// A SUB-MODULE AND NOT A FAMILY. Everything here reads one subject — the machines a
// session can run on — and hands the answer to the Tier-1 surfaces
// `src/renderer/src/runtime-node-attach/` owns: the roster read and its observation
// (`node-roster-seam.ts`), what a burst of read reasons costs (`node-roster-refresh.ts`),
// which signals become reasons at all (`node-roster-triggers.ts`), and the attach
// draft and reads a declaration is resolved through (`node-attach-seam.ts`). None of
// them is a seat: a seat is a slot one view family hands another, and these are the
// reads the absorbed surfaces beside them are mounted over. They sit inside `seats/`
// because `absorbed-surfaces.ts` is the module that mounts those surfaces, and a
// read seam belongs beside its one mount rather than in a family of its own — the
// family door already publishes what a page outside `seats/` takes.
//
// THIS DOOR EXISTS BECAUSE A SIBLING TAKES FROM THE DIRECTORY. `apps/desktop/AGENTS.md`
// §Module shape: a sub-module directory whose modules no sibling reads carries no
// `index.ts` at all, and one with a sibling reader carries a door publishing what that
// sibling takes. `absorbed-surfaces.ts` is that reader and these three names are what
// it takes — so the door is exactly three lines wide and is never widened for
// symmetry, which is also what keeps `barrel-census` green over it: a fourth line
// would be a published name no sibling reaches.
//
// WHAT THE FAMILY DOOR PUBLISHES IS NOT ROUTED THROUGH HERE. `useNodeRosterObservation`
// and `useNodeRosterReReadTriggers` are read by the runtime-nodes settings page, which
// is another family, so `seats/index.ts` re-exports them from the modules that DECLARE
// them — a door re-exporting from a door is the barrel chain `console-no-barrel-chain`
// fails, and it is why those two names are absent from this file.

export { nodeAttachDraftFor, nodeAttachReadsFor } from "./node-attach-seam.js";
export { nodeRosterReadsFor } from "./node-roster-seam.js";
