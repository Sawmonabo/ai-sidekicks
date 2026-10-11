// Picks the operating system module main runs on, once, at main's start.

import { supportedPlatform, type SupportedPlatform } from "#shared/app-facts.js";
import type { MainOperatingSystem } from "./contract.js";
import { DARWIN_MAIN_OPERATING_SYSTEM } from "./darwin.js";
import { LINUX_MAIN_OPERATING_SYSTEM } from "./linux.js";
import { WINDOWS_MAIN_OPERATING_SYSTEM } from "./windows.js";

const MAIN_OPERATING_SYSTEMS: Readonly<Record<SupportedPlatform, MainOperatingSystem>> = {
  darwin: DARWIN_MAIN_OPERATING_SYSTEM,
  linux: LINUX_MAIN_OPERATING_SYSTEM,
  win32: WINDOWS_MAIN_OPERATING_SYSTEM,
};

/** What `platform`, in Node's spelling, supplies main. Throws a `RangeError` for one no build runs on. */
export function selectMainOperatingSystem(platform: string): MainOperatingSystem {
  return MAIN_OPERATING_SYSTEMS[supportedPlatform(platform)];
}
