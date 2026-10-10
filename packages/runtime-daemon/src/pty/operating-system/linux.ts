// Linux: `/bin/sh` is the shell the system starts for an account that names none, every bash reads
// a posix-mode start's `ENV`, and a terminal child starts behind the daemon-parent check.

import { requireDaemonParent } from "../host/parent-check.js";
import type { TerminalOperatingSystem } from "./contract.js";

/** What the terminal takes from Linux. */
export const LINUX_TERMINAL_OPERATING_SYSTEM: TerminalOperatingSystem = {
  defaultShell: "/bin/sh",
  loginShellArgs: ["-l"],
  isBashSkippingPosixEnv: () => false,
  launchTerminalChild: requireDaemonParent,
};
