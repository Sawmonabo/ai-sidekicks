// Linux: `/bin/sh` is the shell the system starts for an account that names none, every bash reads
// a posix-mode start's `ENV`, and a terminal child starts behind the daemon-parent check.

import type { TerminalOperatingSystem } from "./contract.js";
import { requireDaemonParent } from "./parent-check.js";
import { XDG_DEFAULT_DATA_FOLDERS } from "./xdg-data-folders.js";

/** What the terminal takes from Linux. */
export const LINUX_TERMINAL_OPERATING_SYSTEM: TerminalOperatingSystem = {
  defaultShell: "/bin/sh",
  loginShellArgs: ["-l"],
  defaultXdgDataFolders: XDG_DEFAULT_DATA_FOLDERS,
  isBashSkippingPosixEnv: () => false,
  launchTerminalChild: requireDaemonParent,
};
