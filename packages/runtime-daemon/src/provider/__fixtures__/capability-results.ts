// Capability readings for the registry, the capability writer and the suites that compose them.

import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilityFlag,
} from "@ai-sidekicks/contracts/provider-driver";

import type { DriverCapabilityHydrationResult } from "../driver-capabilities-writer.js";
import type { DriverCliVersionReport, GetCapabilitiesResult } from "../provider-driver.js";

/** The capability contract version every reading built here declares. */
export const CONTRACT_VERSION: string = "1.2.3";

/**
 * A full flag record built from `DRIVER_CAPABILITY_FLAGS`, so a widened union leaves no stale copy:
 * every flag false, then `resume` and `tool_calls` true, then the overrides.
 */
export function makeFlags(
  overrides: Partial<Record<DriverCapabilityFlag, boolean>> = {},
): Record<DriverCapabilityFlag, boolean> {
  const base = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, false])) as Record<
    DriverCapabilityFlag,
    boolean
  >;
  return { ...base, resume: true, tool_calls: true, ...overrides };
}

/**
 * The `cliVersion` reading every result carries. It describes the reading, not a capability, so
 * the writer persists it for `hydrate()` but keeps it out of change detection.
 */
export const CLI_VERSION_REPORT: DriverCliVersionReport = {
  rawVersion: "mock-provider-cli 2.1.234 (build 7)",
  parsedVersion: "2.1.234",
};

/** A capability result with the default flags, no tools and {@link CLI_VERSION_REPORT}. */
export function makeResult(overrides: Partial<GetCapabilitiesResult> = {}): GetCapabilitiesResult {
  return {
    capabilities: {
      flags: makeFlags(),
      contractVersion: CONTRACT_VERSION,
    },
    tools: [],
    cliVersion: CLI_VERSION_REPORT,
    ...overrides,
  };
}

/** Narrows a hydration result to its hit; throws naming the miss reason, so a miss cannot pass. */
export function expectHydrationHit(
  hydrated: DriverCapabilityHydrationResult,
): GetCapabilitiesResult {
  if (!hydrated.hit) {
    throw new Error(`expected a hydration HIT; got a miss with reason "${hydrated.reason}"`);
  }
  return hydrated.result;
}
