// The provider-account fixture shell's door. See `mcp-servers/shell/index.ts` on the
// shape — the two shells are the same arrangement, and the reasoning is written once
// there rather than paraphrased here.
//
// One sibling reader (`provider-accounts-slot.ts`), so one published name; the sheet
// enters through the door because the door is what makes this directory an owner; and
// the whole directory, this file included, is deleted by the task that fills the slot.

import "./provider-accounts-shell.css";

export { AccountsShell } from "./AccountsShell.js";
