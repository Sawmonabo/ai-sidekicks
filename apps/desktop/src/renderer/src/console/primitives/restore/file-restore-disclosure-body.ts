// The file-restore disclosure's chunk root: the one module an `import()` names.
//
// WHY IT EXISTS. Nothing on any first paint is a restore. The disclosure is drawn by the
// runs pane's intervention history, under a settled rollback whose reading carries file
// enumerations — a pane that is itself loader-backed, inside a row a person has to reach.
// So `apps/desktop/AGENTS.md` §Module shape answers for it the way it answers for any
// body: not painted before somebody acts, therefore reached through a loader.
//
// IT RODE THE INITIAL IMPORT GRAPH ANYWAY, and the reason is the one that paragraph
// names out loud: a symbol reachable both statically and dynamically is assigned to the
// STATIC chunk. The primitives door is on the renderer's own entry graph, and its line
// for `FileRestoreDisclosure` was a static edge into this directory — so the disclosure,
// both enumeration lists, the path list with its windowed arm, the cell, and the
// enumeration reading all landed on the document every session downloads, for a surface
// only a rewind that touched the working tree ever draws. Measured at 1,863 B gzip.
//
// THE DOOR NOW NAMES A LOADER INSTEAD (`file-restore-disclosure-loader.ts`), which is the
// shape `bridge/wire-shapes/json-schema-check-loader.ts` already ships for the schema
// compiler: the cross-family rule is that a reader reaches this family through its door,
// and it is satisfied — `runs/` imports the door and nothing else — while the boundary is
// the `import()` inside the door's own module, which is where AGENTS.md puts it. This
// module is the split point that edge lands on.
//
// AND THE STYLESHEET TRAVELS WITH IT. `restore.css` dresses this directory and nothing
// else — all fourteen of its `meridian-restore-disclosure*` classes are declared by no
// other sheet in the tree and named by no module outside this directory — so it enters
// here rather than through the family door. That is the stylesheet rule read from the
// side it states: a directory carrying a lazily-loaded chunk has an owner of its own, and
// a sheet entering through the primitives door would put a restore's rules on every
// launch to dress a surface most sessions never reach. Nothing about the cascade turns on
// the move, which is the one risk it carries and the reason the collision was measured
// rather than assumed.
//
// Named `Body` because `seats/lazy-body.ts` fixes the export name a loader resolves.

import "./restore.css";

export { FileRestoreDisclosure as Body } from "./FileRestoreDisclosure.js";
