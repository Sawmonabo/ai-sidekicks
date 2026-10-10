// macOS: zsh is the system's shell, and its own `/bin/bash`, a 3.2 Apple patched, never reads `ENV`
// in a posix-mode start. A terminal child starts behind the daemon-parent check.

import type { TerminalOperatingSystem } from "./contract.js";
import { requireDaemonParent } from "./parent-check.js";
import { XDG_DEFAULT_DATA_FOLDERS } from "./xdg-data-folders.js";

// macOS's own bash, which skips a posix-mode start's `ENV`.
const APPLE_BASH_PATH = "/bin/bash";

/** What the terminal takes from macOS. */
export const DARWIN_TERMINAL_OPERATING_SYSTEM: TerminalOperatingSystem = {
  defaultShell: "/bin/zsh",
  loginShellArgs: ["-l"],
  defaultXdgDataFolders: XDG_DEFAULT_DATA_FOLDERS,
  isBashSkippingPosixEnv: (shellPath) => shellPath === APPLE_BASH_PATH,
  launchTerminalChild: requireDaemonParent,
};
