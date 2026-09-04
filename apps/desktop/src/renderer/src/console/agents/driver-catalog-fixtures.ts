// The two catalog readings this family's suites drive against.
//
// Hoisted on their second use rather than copied: `driver-catalog.test.ts` measures
// the selectors over the first and `ProviderSwitch.test.tsx` measures which controls
// it produces, and two copies would eventually disagree about which driver declares
// what — which is the exact distinction both suites exist to hold.
//
// TWO READINGS BECAUSE TWO QUESTIONS. The first keeps its drivers APART — they share
// no model id at all — which is what makes it the right fixture for asking which
// controls a driver produces, and the wrong one for asking what survives a change of
// driver or model, where the whole question is the overlap. The second overlaps on
// purpose, and is driven by every suite that measures the dependent-axis chain.
//
// The flag record is TOTAL by construction, derived from the contract's own closed
// list, so a flag added upstream cannot leave a fixture silently missing a member.

import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import type { DriverCatalogReading } from "./driver-catalog.js";

/** Every capability flag `false` except the ones named. */
export function driverCapabilityFlags(
  declared: Partial<Record<DriverCapabilityFlag, boolean>>,
): Record<DriverCapabilityFlag, boolean> {
  const flags = {} as Record<DriverCapabilityFlag, boolean>;
  for (const flag of DRIVER_CAPABILITY_FLAGS) {
    flags[flag] = declared[flag] ?? false;
  }
  return flags;
}

/**
 * Two drivers that differ on exactly the axes the console branches on.
 *
 * `claude` declares model mutation AND an output-speed vocabulary; `codex` declares
 * model mutation and no speed axis at all. One model publishes an effort vocabulary
 * and its sibling publishes none, which is the per-model shape the wire actually has.
 */
export const DRIVER_CATALOG_FIXTURE: DriverCatalogReading = {
  models: {
    drivers: [
      {
        driverName: "claude",
        models: [
          { id: "claude-sonnet", name: "Sonnet", capabilities: [], effortLevels: ["low", "high"] },
          { id: "claude-haiku", name: "Haiku", capabilities: [] },
        ],
      },
      { driverName: "codex", models: [{ id: "gpt-5.6", name: "GPT", capabilities: [] }] },
    ],
  },
  capabilities: {
    drivers: [
      {
        driverName: "claude",
        capabilities: {
          flags: driverCapabilityFlags({ model_mutation: true, output_speed: true }),
          contractVersion: "1.0.0",
        },
        outputSpeedLevels: ["standard", "fast"],
      },
      {
        driverName: "codex",
        capabilities: {
          flags: driverCapabilityFlags({ model_mutation: true }),
          contractVersion: "1.0.0",
        },
      },
    ],
  },
};

/**
 * Two drivers that OVERLAP on one model id and disagree about its effort levels.
 *
 * `shared-model` is carried by both drivers; `claude-only` by one; and the shared
 * model publishes a wider vocabulary under `claude` than under `codex`, so a level
 * can be retired by moving either the driver or the model. Both drivers declare model
 * mutation and neither declares a speed axis, which keeps every case here about the
 * chain rather than about a capability gate.
 */
export const OVERLAPPING_DRIVER_CATALOG_FIXTURE: DriverCatalogReading = {
  models: {
    drivers: [
      {
        driverName: "claude",
        models: [
          { id: "shared-model", name: "Shared", capabilities: [], effortLevels: ["low", "high"] },
          { id: "claude-only", name: "Claude only", capabilities: [], effortLevels: ["low"] },
        ],
      },
      {
        driverName: "codex",
        models: [{ id: "shared-model", name: "Shared", capabilities: [], effortLevels: ["low"] }],
      },
    ],
  },
  capabilities: {
    drivers: ["claude", "codex"].map((driverName) => ({
      driverName,
      capabilities: {
        flags: driverCapabilityFlags({ model_mutation: true }),
        contractVersion: "1.0.0",
      },
    })),
  },
};
