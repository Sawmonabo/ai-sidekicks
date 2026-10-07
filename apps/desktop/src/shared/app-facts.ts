// The facts about this build and this machine that main hands every window at start. The
// machine's region and clock can change while the app runs; main pushes each change after.
//
// Main passes them as renderer switches through `webPreferences.additionalArguments`. The
// sandboxed preload cannot import Electron's `app`, so it reads the switches off its own
// `process.argv` and exposes them as the bridge's `app` namespace. Both spellings of each
// switch live here once.

import { readRequiredSwitchValue } from "./renderer-switch.js";

/** The operating systems a build runs on. */
const SUPPORTED_PLATFORMS = ["darwin", "linux", "win32"] as const;

/** The processor architectures a build runs on. */
const SUPPORTED_ARCHES = ["arm64", "x64"] as const;

/** One supported operating system, in Node's spelling. */
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

/** One supported processor architecture, in Node's spelling. */
export type SupportedArch = (typeof SUPPORTED_ARCHES)[number];

/** The two clocks a machine is set to, in `Intl`'s spelling: 12-hour and 24-hour. */
const HOUR_CYCLES = ["h12", "h23"] as const;

/** A machine's 12- or 24-hour clock, in `Intl`'s spelling. */
export type HourCycle = (typeof HOUR_CYCLES)[number];

/** The facts the bridge's `app` namespace carries, as they stood when the window started. */
export interface AppFacts {
  readonly version: string;
  readonly platform: SupportedPlatform;
  readonly arch: SupportedArch;
  /** The app's UI language, which carries no hour cycle and never decides a clock or a date. */
  readonly locale: string;
  /** The machine's physical memory in bytes; the screen's cache budgets are a share of it. */
  readonly physicalMemoryBytes: number;
  /** The canonical BCP 47 locale the machine writes dates in, from its region settings. */
  readonly regionLocale: string;
  /** The machine's 12- or 24-hour clock, which every clock figure is written in. */
  readonly hourCycle: HourCycle;
}

/** The machine's region and 12- or 24-hour clock, the two facts that change while the app runs. */
export type MachineClock = Pick<AppFacts, "regionLocale" | "hourCycle">;

const VERSION_SWITCH = "--sidekicks-app-version=";
const PLATFORM_SWITCH = "--sidekicks-app-platform=";
const ARCH_SWITCH = "--sidekicks-app-arch=";
const LOCALE_SWITCH = "--sidekicks-app-locale=";
const PHYSICAL_MEMORY_SWITCH = "--sidekicks-app-physical-memory=";
const REGION_LOCALE_SWITCH = "--sidekicks-app-region-locale=";
const HOUR_CYCLE_SWITCH = "--sidekicks-app-hour-cycle=";

/** `platform` as a supported one; throws for any other. */
export function supportedPlatform(platform: string): SupportedPlatform {
  const supported = SUPPORTED_PLATFORMS.find((candidate) => candidate === platform);
  if (supported === undefined) {
    throw new RangeError(`This build does not run on the ${platform} platform.`);
  }
  return supported;
}

/** `arch` as a supported one; throws for any other. */
export function supportedArch(arch: string): SupportedArch {
  const supported = SUPPORTED_ARCHES.find((candidate) => candidate === arch);
  if (supported === undefined) {
    throw new RangeError(`This build does not run on the ${arch} architecture.`);
  }
  return supported;
}

/** `hourCycle` as one of the two clocks; throws for any other. */
function supportedHourCycle(hourCycle: string): HourCycle {
  const supported = HOUR_CYCLES.find((candidate) => candidate === hourCycle);
  if (supported === undefined) {
    throw new RangeError(`${hourCycle} is not a 12- or 24-hour clock.`);
  }
  return supported;
}

/** `locale` as the canonical BCP 47 tag `Intl` spells it. Throws a `RangeError` for no tag. */
export function canonicalLocale(locale: string): string {
  const [canonical] = Intl.getCanonicalLocales(locale);
  if (canonical === undefined) {
    throw new RangeError(`${locale} is not a locale.`);
  }
  return canonical;
}

/** The renderer switches that carry the facts into a window; each value is URI-encoded. */
export function appFactsSwitches(facts: AppFacts): string[] {
  return [
    `${VERSION_SWITCH}${encodeURIComponent(facts.version)}`,
    `${PLATFORM_SWITCH}${facts.platform}`,
    `${ARCH_SWITCH}${facts.arch}`,
    `${LOCALE_SWITCH}${encodeURIComponent(facts.locale)}`,
    `${PHYSICAL_MEMORY_SWITCH}${String(facts.physicalMemoryBytes)}`,
    `${REGION_LOCALE_SWITCH}${encodeURIComponent(facts.regionLocale)}`,
    `${HOUR_CYCLE_SWITCH}${facts.hourCycle}`,
  ];
}

/**
 * The facts a window's switches carry. Throws when one is missing or out of range: main always
 * passes all seven, and a made-up value would be a fact nobody read.
 */
export function readAppFactsSwitches(argv: readonly string[]): AppFacts {
  const physicalMemoryBytes = Number(readRequiredSwitchValue(argv, PHYSICAL_MEMORY_SWITCH));
  if (!Number.isSafeInteger(physicalMemoryBytes) || physicalMemoryBytes <= 0) {
    throw new RangeError("The physical memory switch is not a positive whole number of bytes.");
  }
  return {
    version: readRequiredSwitchValue(argv, VERSION_SWITCH),
    platform: supportedPlatform(readRequiredSwitchValue(argv, PLATFORM_SWITCH)),
    arch: supportedArch(readRequiredSwitchValue(argv, ARCH_SWITCH)),
    locale: readRequiredSwitchValue(argv, LOCALE_SWITCH),
    physicalMemoryBytes,
    regionLocale: canonicalLocale(readRequiredSwitchValue(argv, REGION_LOCALE_SWITCH)),
    hourCycle: supportedHourCycle(readRequiredSwitchValue(argv, HOUR_CYCLE_SWITCH)),
  };
}
