// The one place the terminal's operating system is chosen, at the daemon's start.

import type { TerminalOperatingSystem } from "./contract.js";
import { DARWIN_TERMINAL_OPERATING_SYSTEM } from "./darwin.js";
import { LINUX_TERMINAL_OPERATING_SYSTEM } from "./linux.js";
import { windowsTerminalOperatingSystem } from "./windows.js";

/**
 * Picks what the terminal takes from `platform`, reading `ComSpec` from `environment` on Windows.
 * Throws for a platform the terminal does not run on.
 */
export function selectTerminalOperatingSystem(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): TerminalOperatingSystem {
  switch (platform) {
    case "darwin":
      return DARWIN_TERMINAL_OPERATING_SYSTEM;
    case "linux":
      return LINUX_TERMINAL_OPERATING_SYSTEM;
    case "win32":
      return windowsTerminalOperatingSystem(environment["ComSpec"]);
    default:
      throw new Error(`The terminal does not run on ${platform}`);
  }
}
