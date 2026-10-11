// The facts main reads for the bridge's `app` namespace: the build, the machine, and the region
// and the 12- or 24-hour clock the machine itself is set to, which the operating system's
// `MachineClockReader` reads.

import { totalmem } from "node:os";

import { app } from "electron";

import { supportedArch, type AppFacts } from "#shared/app-facts.js";
import type { MainOperatingSystem } from "../operating-system/contract.js";

/**
 * The app's facts on `operatingSystem`, read from Electron and the machine through its clock
 * reader; call it after ready, when the locales are known. Throws a `RangeError` for an
 * unsupported architecture, or a region or clock the machine reports in a form no locale has, so a
 * launch never hands a page an unchecked value.
 */
export function readAppFacts(
  operatingSystem: Pick<MainOperatingSystem, "platform" | "machineClock">,
): AppFacts {
  return {
    version: app.getVersion(),
    platform: operatingSystem.platform,
    arch: supportedArch(process.arch),
    locale: app.getLocale(),
    physicalMemoryBytes: totalmem(),
    ...operatingSystem.machineClock.read(),
  };
}
