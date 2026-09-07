// The MCP fixture shell's door, and the reason it exists at all.
//
// THIS DOOR EXISTS TO GIVE THE STYLESHEET A DROPPABLE HOME, and for no other reason.
// It is not here because a sibling reads the directory — every reader of this shell is
// `mcp-servers-slot.ts` one level up, which is the same structural relation the four
// `settings/pages/diagnostics/` sub-directories have to their own page root, and none
// of those carries a door. What is different here is the SHEET.
//
// A stylesheet enters through the barrel of the directory that owns it and through no
// component, so `McpShell.tsx` may not import its own rules. Before this file existed
// the sheet entered through `settings/settings-surface-body.ts` with the twelve page
// sheets — the only other barrel in reach — and that put it on the initial document of
// every session, because the settings chunk root is not `define`-gated and this shell
// is. `McpShell` folds to `undefined` in a release renderer and its JavaScript leaves
// the bundle; its rules were staying behind.
//
// A DECLARATION ALONE COULD NOT MOVE THEM. `electron.vite.config.ts` names this
// directory side-effect-free, but Vite's own `vite:css-post` transform returns
// `moduleSideEffects: "no-treeshake"` for a plain stylesheet in a build, which
// overrides that declaration for the sheet's own module. What the declaration CAN drop
// is an ordinary `.ts` module — so the sheet is given one to hang from: nothing takes
// this door's one export in a release renderer, the door goes, and the edge to the
// sheet goes with it. That is the whole reason for the file, and it is why the
// published set is `McpShell` alone — a name added here for symmetry would be a dead
// export the barrel census fails.
//
// THE WHOLE DIRECTORY IS DELETED by the task that fills the slot with the real body,
// this file included. Nothing here is a seam the owner inherits.

import "./mcp-servers-shell.css";

export { McpShell } from "./McpShell.js";
