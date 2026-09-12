// The node-roster sub-module's door: the three seams the absorbed pre-console surfaces take.
//
// `surface/absorbed-surfaces.ts` composes the shipped runtime-node mounts and is the
// one sibling that reads this directory; it takes `nodeAttachDraftFor` and
// `nodeAttachReadsFor` from the attach seam and `nodeRosterReadsFor` from the roster
// seam. The refresh policy and the trigger bindings have no sibling reader and stay
// off this line.
export { nodeAttachDraftFor, nodeAttachReadsFor } from "./node-attach-seam.js";
export { nodeRosterReadsFor } from "./node-roster-seam.js";
