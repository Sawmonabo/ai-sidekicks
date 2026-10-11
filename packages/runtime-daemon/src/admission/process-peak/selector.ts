// The one place the memory gate's peak read is chosen, at the daemon's start.

import type { ProcessPeakReader } from "./contract.js";
import { DARWIN_PROCESS_PEAK_READER } from "./darwin.js";
import { LINUX_PROCESS_PEAK_READER } from "./linux.js";
import { WINDOWS_PROCESS_PEAK_READER } from "./windows.js";

/** Picks the peak read of `platform`; throws for a platform the daemon does not run on. */
export function selectProcessPeakReader(platform: NodeJS.Platform): ProcessPeakReader {
  switch (platform) {
    case "darwin":
      return DARWIN_PROCESS_PEAK_READER;
    case "linux":
      return LINUX_PROCESS_PEAK_READER;
    case "win32":
      return WINDOWS_PROCESS_PEAK_READER;
    default:
      throw new Error(`No peak memory read is written for ${platform}`);
  }
}
