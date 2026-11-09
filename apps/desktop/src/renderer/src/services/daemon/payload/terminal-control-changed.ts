// A shell's control move, decoded at the bridge. Every check of a wire value happens in
// `services/`, so the terminal lease reads what this returns and never the check. The check's
// rules matter: a take that names no holder, a release that names no holder it ended, a disconnect
// or a closed pane that names one after it, or a release that names a run has no trustworthy
// holder, so the lease treats it as a move it could not read.

import {
  validateTerminalControlChangedPayload,
  type TerminalControlChangedPayload,
} from "@ai-sidekicks/contracts/terminal";

/** Read a `terminal.control.changed` payload, or `undefined` where the wire's is off contract. */
export function readTerminalControlChangedPayload(
  payload: unknown,
): TerminalControlChangedPayload | undefined {
  return validateTerminalControlChangedPayload(payload) ? payload : undefined;
}
