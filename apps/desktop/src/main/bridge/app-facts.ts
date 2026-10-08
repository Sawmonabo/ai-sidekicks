// The facts main reads for the bridge's `app` namespace: the build, the machine, and the region
// and the 12- or 24-hour clock the machine itself is set to, which this platform's
// `MachineClockReader` reads.

import { totalmem } from "node:os";

import { app } from "electron";

import { supportedArch, type AppFacts, type SupportedPlatform } from "#shared/app-facts.js";
import type { MachineClockReader } from "./machine-clock/reader.js";

/**
 * The app's facts on `platform`, read from Electron and the machine through `machineClock`; call
 * it after ready, when the locales are known. Throws a `RangeError` for an unsupported
 * architecture, or a region or clock the machine reports in a form no locale has, so a launch
 * never hands a page an unchecked value.
 */
export function readAppFacts(
  platform: SupportedPlatform,
  machineClock: MachineClockReader,
): AppFacts {
  return {
    version: app.getVersion(),
    platform,
    arch: supportedArch(process.arch),
    locale: app.getLocale(),
    physicalMemoryBytes: totalmem(),
    ...machineClock.read(),
  };
}
