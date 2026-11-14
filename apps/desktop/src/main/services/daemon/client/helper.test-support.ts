// The addon as the client helper's suites play it: their own connect and wait, the client's bounds
// and a status file's place; none of these suites ends the service or reads a process's identity.

import type { ClientHelperAddon } from "./addon.js";

const NO_ENDING = "No suite of the helper's link ends the service.";

/** The addon over `answers`, which connect and wait as the suite scripts them. */
export function scriptedAddon(
  answers: Pick<ClientHelperAddon, "connect" | "waitForDaemon">,
): ClientHelperAddon {
  return {
    ...answers,
    endDaemon: () => Promise.reject(new Error(NO_ENDING)),
    endDaemonProcess: () => Promise.reject(new Error(NO_ENDING)),
    readProcessIdentity: () => {
      throw new Error(NO_ENDING);
    },
    daemonStatusFilePath: () => "status.json",
    HANDSHAKE_DEADLINE_MS: 8_000,
    DAEMON_FLUSH_WAIT_MS: 1_000,
  };
}
