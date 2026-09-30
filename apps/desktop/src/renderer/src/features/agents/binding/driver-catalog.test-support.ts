// The two catalog readings the binding suites drive against, shared so the suites cannot
// disagree about which driver declares what. The first keeps drivers apart (no shared model
// id) for asking which controls a driver produces; the second overlaps on purpose, for the
// dependent-axis chain. The flag record is derived from the contract's closed list.

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
 * Two drivers that differ on the axes the console branches on: `claude` declares model
 * mutation and an output-speed vocabulary, `codex` model mutation only. One model publishes
 * an effort vocabulary and its sibling none.
 */
export const DRIVER_CATALOG_FIXTURE: DriverCatalogReading = {
  models: {
    drivers: [
      {
        driverName: "claude",
        models: [
          {
            id: "claude-sonnet",
            name: "Sonnet",
            capabilities: [],
            effortLevels: ["low", "high"],
            fast: false,
          },
          { id: "claude-haiku", name: "Haiku", capabilities: [], fast: false },
        ],
      },
      {
        driverName: "codex",
        models: [{ id: "gpt-5.6", name: "GPT", capabilities: [], fast: true }],
      },
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
        outputSpeedLevels: ["off", "on"],
        builtInTools: ["Read", "Edit"],
      },
      {
        driverName: "codex",
        capabilities: {
          flags: driverCapabilityFlags({ model_mutation: true }),
          contractVersion: "1.0.0",
        },
        builtInTools: ["shell"],
      },
    ],
  },
};

/**
 * Two drivers that overlap on one model id and disagree about its effort levels, so a level
 * can be retired by moving either the driver or the model. Neither declares a speed axis.
 */
export const OVERLAPPING_DRIVER_CATALOG_FIXTURE: DriverCatalogReading = {
  models: {
    drivers: [
      {
        driverName: "claude",
        models: [
          {
            id: "shared-model",
            name: "Shared",
            capabilities: [],
            effortLevels: ["low", "high"],
            fast: false,
          },
          {
            id: "claude-only",
            name: "Claude only",
            capabilities: [],
            effortLevels: ["low"],
            fast: false,
          },
        ],
      },
      {
        driverName: "codex",
        models: [
          {
            id: "shared-model",
            name: "Shared",
            capabilities: [],
            effortLevels: ["low"],
            fast: true,
          },
        ],
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
      builtInTools: [],
    })),
  },
};
