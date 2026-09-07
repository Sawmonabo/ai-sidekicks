// The supervisor states both shell suites drive over, and the state one arm makes.
//
// Hoisted on second use, per `apps/desktop/AGENTS.md`. The vocabulary suite asserts a
// sentence per state and the mutation-block suite asserts a cause per state, so both
// need the same enumeration — and two copies of it would let one suite quietly stop
// covering an arm the other still did.

import { UNREPORTED_SHELL_STATE, type ShellConnection, type ShellState } from "./shell-state.js";

/** A window holding one connection and nothing else reported. */
export function stateWith(connection: ShellConnection): ShellState {
  return { ...UNREPORTED_SHELL_STATE, connection };
}

/**
 * Every arm a supervisor actually reports, `unreported` excluded.
 *
 * The absence is the point: `unreported` is what a window holds before anything has
 * said, and a suite quantifying over it beside the reported arms would be asserting
 * that silence means something.
 */
export const REPORTED_CONNECTIONS: readonly ShellConnection[] = [
  { kind: "probing" },
  { kind: "starting" },
  { kind: "connected" },
  { kind: "reconnecting", attempt: 2, attemptLimit: 5 },
  { kind: "version-incompatible" },
  { kind: "offline", attemptLimit: 5, lastError: "spawn ENOENT" },
  { kind: "stopped" },
];
