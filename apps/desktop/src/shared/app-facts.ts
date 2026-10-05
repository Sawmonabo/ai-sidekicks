// The facts about this build and this machine that main hands every window once, at start.
//
// Main passes them as renderer switches through `webPreferences.additionalArguments`. The
// sandboxed preload cannot import Electron's `app`, so it reads the switches off its own
// `process.argv` and exposes them as the bridge's `app` namespace. Both spellings of each
// switch live here once.

import { readRequiredSwitchValue } from "./renderer-switch.js";

/** The operating systems a build runs on. */
export const SUPPORTED_PLATFORMS = ["darwin", "linux", "win32"] as const;

/** The processor architectures a build runs on. */
export const SUPPORTED_ARCHES = ["arm64", "x64"] as const;

/** One supported operating system, in Node's spelling. */
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

/** One supported processor architecture, in Node's spelling. */
export type SupportedArch = (typeof SUPPORTED_ARCHES)[number];

/** What the bridge's `app` namespace carries. Values only, no calls. */
export interface AppFacts {
  readonly version: string;
  readonly platform: SupportedPlatform;
  readonly arch: SupportedArch;
  readonly locale: string;
  /** The machine's physical memory in bytes; the screen's cache budgets are a share of it. */
  readonly physicalMemoryBytes: number;
}

const VERSION_SWITCH = "--sidekicks-app-version=";
const PLATFORM_SWITCH = "--sidekicks-app-platform=";
const ARCH_SWITCH = "--sidekicks-app-arch=";
const LOCALE_SWITCH = "--sidekicks-app-locale=";
const PHYSICAL_MEMORY_SWITCH = "--sidekicks-app-physical-memory=";

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

/** The renderer switches that carry the facts into a window; each value is URI-encoded. */
export function appFactsSwitches(facts: AppFacts): string[] {
  return [
    `${VERSION_SWITCH}${encodeURIComponent(facts.version)}`,
    `${PLATFORM_SWITCH}${facts.platform}`,
    `${ARCH_SWITCH}${facts.arch}`,
    `${LOCALE_SWITCH}${encodeURIComponent(facts.locale)}`,
    `${PHYSICAL_MEMORY_SWITCH}${String(facts.physicalMemoryBytes)}`,
  ];
}

/**
 * The facts a window's switches carry. Throws when one is missing or out of range: main always
 * passes all five, and a made-up value would be a fact nobody read.
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
  };
}
