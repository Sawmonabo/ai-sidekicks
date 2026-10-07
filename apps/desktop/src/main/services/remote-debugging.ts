// The Chromium switches that serve a debugging connection to every page and to main, which a
// release build refuses. Electron starts that server after main's script has finished running, so
// a switch removed at the script's top level is never served.

import type { CommandLine } from "electron";

import type { MainDiagnosticLog } from "./diagnostic-log.js";

/** The switches that start Chromium's debugging server: over a TCP port, or over a pipe. */
const REMOTE_DEBUGGING_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe"] as const;

/**
 * Removes both remote-debugging switches from this process's command line and logs each one it
 * found. Call at main's top level, before `app.ready`: a switch removed later is already served.
 */
export function refuseRemoteDebugging(
  commandLine: Pick<CommandLine, "hasSwitch" | "removeSwitch">,
  log: Pick<MainDiagnosticLog, "write">,
): void {
  for (const switchName of REMOTE_DEBUGGING_SWITCHES) {
    if (commandLine.hasSwitch(switchName)) {
      commandLine.removeSwitch(switchName);
      log.write({
        level: "warning",
        source: "main/remote-debugging",
        message: `--${switchName} was refused: a release build serves no debugging connection`,
      });
    }
  }
}
