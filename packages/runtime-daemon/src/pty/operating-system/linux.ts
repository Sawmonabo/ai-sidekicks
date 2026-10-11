// Linux: `/bin/sh` is the shell the system starts for an account that names none, every bash reads
// a posix-mode start's `ENV`, and a terminal child starts behind the daemon-parent check and is
// ended by signal.

import { startBashThroughEnv } from "./bash-env-start.js";
import type { TerminalOperatingSystem } from "./contract.js";
import { requireDaemonParent } from "./parent-check.js";
import { endTerminalChildBySignal } from "./signal-ending.js";
import { XDG_DEFAULT_DATA_FOLDERS } from "./xdg-data-folders.js";

/** What the terminal takes from Linux. */
export const LINUX_TERMINAL_OPERATING_SYSTEM: TerminalOperatingSystem = {
  defaultShell: "/bin/sh",
  loginShellArgs: ["-l"],
  defaultXdgDataFolders: XDG_DEFAULT_DATA_FOLDERS,
  startBash: startBashThroughEnv,
  launchTerminalChild: requireDaemonParent,
  endTerminalChild: endTerminalChildBySignal,
};
