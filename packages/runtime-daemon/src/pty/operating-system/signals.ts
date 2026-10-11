// How macOS and Linux reach a terminal child by signal: a client's signal passes through as itself,
// each ending is its signal, sent to the child alone as `node-pty`'s own kill sends one, and the
// programs it runs in the foreground get the terminal's hangup once it ends. A child the orphan
// registry could not record has its whole process group killed. A terminal host that stopped
// answering is killed alone: its closed terminals hang up the children it started in sessions of
// their own, which a group kill would miss.

import { killTerminalHostAlone } from "./host-kill.js";
import type {
  TerminalChildEnding,
  TerminalChildProcess,
  TerminalOperatingSystem,
} from "./contract.js";

// The signal each ending sends.
const ENDING_SIGNALS = {
  hangup: "SIGHUP",
  stop: "SIGTERM",
  kill: "SIGKILL",
} as const satisfies Record<TerminalChildEnding, NodeJS.Signals>;

/** How macOS and Linux deliver, end and kill a terminal child, and kill a terminal host. */
export const POSIX_TERMINAL_SIGNALS: Pick<
  TerminalOperatingSystem,
  "endTerminalChild" | "deliverSignal" | "killChildGroup" | "killTerminalHost"
> = {
  endTerminalChild: (child: TerminalChildProcess, ending: TerminalChildEnding) => {
    child.kill(ENDING_SIGNALS[ending]);
  },
  deliverSignal: ({ child, signal }) => {
    child.kill(signal);
    return Promise.resolve();
  },
  // The child leads its own process group.
  killChildGroup: (leaderId) => {
    process.kill(-leaderId, "SIGKILL");
  },
  killTerminalHost: killTerminalHostAlone,
};
