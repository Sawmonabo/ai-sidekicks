// Picks this operating system's reader of the machine's region and clock.

import type { SupportedPlatform } from "#shared/app-facts.js";
import { MacMachineClockReader } from "./mac.js";
import { SystemLocaleClockReader, type MachineClockReader } from "./reader.js";

/**
 * This operating system's reader: macOS reads its Region and 24-Hour Time settings, and Windows
 * and Linux read the system locale and its region's clock.
 */
export function machineClockReaderFor(platform: SupportedPlatform): MachineClockReader {
  return platform === "darwin" ? new MacMachineClockReader() : new SystemLocaleClockReader();
}
