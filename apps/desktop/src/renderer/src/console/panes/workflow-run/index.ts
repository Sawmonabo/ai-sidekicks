// The run pane's door.
//
// One export, and the directory exists anyway rather than the component sitting
// loose beside the seat board: `Spec-023 §Console Design (Meridian)` closes the
// pane-kind set, and a kind whose body has a home of its own is a kind a reader can
// find from the set. The workflows family's shared vocabulary — the chrome, the
// slot mount, the state union — lives in `console/workflows/` and is reached deep
// from here, because those two directories are one family under one task and a
// barrel between them would be a seam where there is no boundary.

// The props type is deliberately NOT re-exported: the only caller is the family
// barrel's own descriptor table, which constructs the props inline, so an exported
// alias here would be a name nothing reads.
export { WorkflowRunPane } from "./WorkflowRunPane.js";
