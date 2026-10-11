// Picks the operating system module the daemon runs on, once, at the daemon's start.

import { supportedPlatform } from "@ai-sidekicks/contracts/platform";

import type { DaemonOperatingSystem } from "./contract.js";
import { LINUX_DAEMON_OPERATING_SYSTEM } from "./linux.js";
import { MAC_DAEMON_OPERATING_SYSTEM } from "./mac.js";
import { windowsDaemonOperatingSystem } from "./windows.js";

/**
 * What `platform`, in Node's spelling, supplies the daemon, reading `environment` on Windows.
 * Throws a `RangeError` for a platform the daemon does not run on.
 */
export function selectDaemonOperatingSystem(
  platform: string,
  environment: NodeJS.ProcessEnv,
): DaemonOperatingSystem {
  switch (supportedPlatform(platform)) {
    case "darwin":
      return MAC_DAEMON_OPERATING_SYSTEM;
    case "linux":
      return LINUX_DAEMON_OPERATING_SYSTEM;
    case "win32":
      return windowsDaemonOperatingSystem(environment);
  }
}
