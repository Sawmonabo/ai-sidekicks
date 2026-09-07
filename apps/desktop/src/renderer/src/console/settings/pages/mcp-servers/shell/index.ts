// The MCP fixture shell's door, and the reason it exists at all.
//
// A SUB-MODULE DOOR, ON THE CONDITION `apps/desktop/AGENTS.md` STATES. This directory
// has exactly one sibling reader — `mcp-servers-slot.ts`, which names the shell as the
// slot's fixture body — and a sub-module directory one sibling takes from carries a
// door publishing what that sibling takes. What that sibling takes is `McpShell` and
// nothing else, so that is the whole published set; a name added here for symmetry
// would be a dead export the barrel census fails.
//
// AND THE STYLESHEET ENTERS HERE BECAUSE THE DOOR IS WHAT MAKES THIS DIRECTORY AN
// OWNER. The rule reads from both sides: a sheet enters through the barrel of the
// directory that owns it, and a directory carrying a door has an owner of its own that
// a parent may not reach into. Before this file existed the sheet entered through
// `settings/settings-surface-body.ts` with the twelve page sheets, which was correct
// while this directory had no door and wrong the moment it did — and wrong in a way a
// person could measure, because the settings chunk root is not `define`-gated and the
// shell is. `McpShell` folds to `undefined` in a release renderer and its JavaScript
// leaves the bundle; its rules were staying behind. They now leave with it, because
// nothing takes this door's one export and `electron.vite.config.ts` declares the
// directory side-effect-free, so the door goes and the edge to the sheet goes with it.
//
// THE WHOLE DIRECTORY IS DELETED by the task that fills the slot with the real body,
// this file included. Nothing here is a seam the owner inherits.

import "./mcp-servers-shell.css";

export { McpShell } from "./McpShell.js";
