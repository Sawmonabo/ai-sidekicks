// Windows: the command interpreter `ComSpec` names is the default shell, its shells have no login
// form, and a terminal child starts as it is, with no `/bin/sh` to run a parent check.

import type { TerminalOperatingSystem } from "./contract.js";

/** What the terminal takes from Windows, given `ComSpec` as the daemon's environment holds it. */
export function windowsTerminalOperatingSystem(
  commandInterpreter: string | undefined,
): TerminalOperatingSystem {
  return {
    defaultShell: commandInterpreter ?? "cmd.exe",
    loginShellArgs: [],
    isBashSkippingPosixEnv: () => false,
    launchTerminalChild: (command, args) => ({ command, args: [...args] }),
  };
}
