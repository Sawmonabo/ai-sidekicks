// The catalog readings the binding suites drive against. The first has one model with an
// effort vocabulary and one without; the second's drivers overlap on purpose, for the
// dependent-axis chain; the third publishes speed tiers per model. The flag record is derived
// from the contract's closed list.

import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilityFlag,
} from "@ai-sidekicks/contracts/provider/driver/capabilities";
import { PROVIDER_NAMES } from "@ai-sidekicks/contracts/provider/name";

import type { DriverCatalogReading } from "./driver-catalog.js";

/** Every capability flag `false` except the ones named. */
function driverCapabilityFlags(
  declared: Partial<Record<DriverCapabilityFlag, boolean>>,
): Record<DriverCapabilityFlag, boolean> {
  const flags = {} as Record<DriverCapabilityFlag, boolean>;
  for (const flag of DRIVER_CAPABILITY_FLAGS) {
    flags[flag] = declared[flag] ?? false;
  }
  return flags;
}

/** One driver whose first model publishes an effort vocabulary and whose second publishes none. */
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
            largerWindow: false,
          },
          { id: "claude-haiku", name: "Haiku", capabilities: [], fast: false, largerWindow: false },
        ],
      },
    ],
  },
  capabilities: {
    drivers: [
      {
        driverName: "claude",
        capabilities: {
          flags: driverCapabilityFlags({ model_mutation: true }),
          contractVersion: "1.0.0",
        },
        builtInTools: [],
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
            largerWindow: false,
          },
          {
            id: "claude-only",
            name: "Claude only",
            capabilities: [],
            effortLevels: ["low"],
            fast: false,
            largerWindow: false,
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
            largerWindow: false,
          },
        ],
      },
    ],
  },
  capabilities: {
    drivers: PROVIDER_NAMES.map((driverName) => ({
      driverName,
      capabilities: {
        flags: driverCapabilityFlags({ model_mutation: true }),
        contractVersion: "1.0.0",
      },
      builtInTools: [],
    })),
  },
};

/**
 * A driver that declares the speed axis and publishes its tiers per model, as the Codex catalog
 * read does: two models with different tiers and one with none. Its report carries no list.
 */
export const SPEED_TIER_CATALOG_FIXTURE: DriverCatalogReading = {
  models: {
    drivers: [
      {
        driverName: "codex",
        models: [
          {
            id: "tiered",
            name: "Tiered",
            capabilities: [],
            outputSpeedLevels: ["priority"],
            fast: true,
            largerWindow: false,
          },
          {
            id: "flex-only",
            name: "Flex only",
            capabilities: [],
            outputSpeedLevels: ["flex"],
            fast: true,
            largerWindow: false,
          },
          { id: "untiered", name: "Untiered", capabilities: [], fast: false, largerWindow: false },
        ],
      },
    ],
  },
  capabilities: {
    drivers: [
      {
        driverName: "codex",
        capabilities: {
          flags: driverCapabilityFlags({ output_speed: true }),
          contractVersion: "1.0.0",
        },
        builtInTools: [],
      },
    ],
  },
};
