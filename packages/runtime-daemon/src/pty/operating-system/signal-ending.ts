// How macOS and Linux end a terminal child: each ending is its signal, sent to the child alone, as
// `node-pty`'s own kill sends one; the programs it runs in the foreground get the terminal's hangup
// once it ends.

import type { TerminalChildEnding, TerminalChildProcess } from "./contract.js";

// The signal each ending sends.
const ENDING_SIGNALS = {
  hangup: "SIGHUP",
  stop: "SIGTERM",
  kill: "SIGKILL",
} as const satisfies Record<TerminalChildEnding, NodeJS.Signals>;

/** Sends `child` the signal for `ending`. */
export function endTerminalChildBySignal(
  child: TerminalChildProcess,
  ending: TerminalChildEnding,
): void {
  child.kill(ENDING_SIGNALS[ending]);
}
