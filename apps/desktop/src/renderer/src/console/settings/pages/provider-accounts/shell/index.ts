// The provider-account fixture shell's door. See `mcp-servers/shell/index.ts` on the
// shape — the two shells are the same arrangement, and the reasoning is written once
// there rather than paraphrased here.
//
// The door is here to give the stylesheet a module the fixture-corpus declaration can
// drop, not because a sibling reads the directory; one published name, because that is
// what the slot takes; and the whole directory, this file included, is deleted by the
// task that fills the slot.

import "./provider-accounts-shell.css";

export { AccountsShell } from "./AccountsShell.js";
