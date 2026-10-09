// Picks the operating system module the daemon runs on, once, where the daemon is composed.

import type { ProviderOperatingSystem } from "./contract.js";
import { DARWIN_PROVIDER_OPERATING_SYSTEM } from "./darwin.js";
import { LINUX_PROVIDER_OPERATING_SYSTEM } from "./linux.js";
import { WINDOWS_PROVIDER_OPERATING_SYSTEM } from "./windows.js";

/** What `platform` supplies the drivers. Throws for a platform the daemon is not built for. */
export function selectProviderOperatingSystem(platform: NodeJS.Platform): ProviderOperatingSystem {
  switch (platform) {
    case "darwin":
      return DARWIN_PROVIDER_OPERATING_SYSTEM;
    case "linux":
      return LINUX_PROVIDER_OPERATING_SYSTEM;
    case "win32":
      return WINDOWS_PROVIDER_OPERATING_SYSTEM;
    default:
      throw new Error(`The provider drivers are not built for platform ${platform}`);
  }
}
