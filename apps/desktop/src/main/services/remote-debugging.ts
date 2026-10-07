// The Chromium switches that serve a debugging connection to every page and the browser target,
// which a release build refuses. Electron reads them once main's script has finished running, so
// a switch removed while the script runs is never served.

import type { CommandLine } from "electron";

import type { MainDiagnosticLog } from "./diagnostic-log.js";

/** The switches that start Chromium's debugging server: over a TCP port, or over a pipe. */
const REMOTE_DEBUGGING_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe"] as const;

/** One of the switches that start Chromium's debugging server. */
export type RemoteDebuggingSwitch = (typeof REMOTE_DEBUGGING_SWITCHES)[number];

/**
 * Removes both remote-debugging switches from this process's command line and answers the ones it
 * found. Call synchronously while main's script runs: a switch removed after it ends is served.
 */
export function refuseRemoteDebugging(
  commandLine: Pick<CommandLine, "hasSwitch" | "removeSwitch">,
): readonly RemoteDebuggingSwitch[] {
  const refused = REMOTE_DEBUGGING_SWITCHES.filter((switchName) =>
    commandLine.hasSwitch(switchName),
  );
  for (const switchName of refused) {
    commandLine.removeSwitch(switchName);
  }
  return refused;
}

/** Records each refused switch in main's log, once the log is open. */
export function logRefusedRemoteDebugging(
  refused: readonly RemoteDebuggingSwitch[],
  log: Pick<MainDiagnosticLog, "write">,
): void {
  for (const switchName of refused) {
    log.write({
      level: "warning",
      source: "main/remote-debugging",
      message: `--${switchName} was refused: a release build serves no debugging connection`,
    });
  }
}
