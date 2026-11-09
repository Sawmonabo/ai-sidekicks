// The catalog readings the binding suites drive against. The first has one model with an
// effort vocabulary and one without; the second's drivers overlap on purpose, for the
// dependent-axis chain; the third publishes speed tiers per model.

import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";

import type { DriverCatalogReading } from "./driver-catalog.js";

/** One driver whose first model publishes an effort vocabulary and whose second publishes none. */
export const DRIVER_CATALOG_FIXTURE: DriverCatalogReading = {
  models: {
    providers: [
      {
        providerName: "claude" as ProviderId,
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
};

/**
 * Two drivers that overlap on one model id and disagree about its effort levels, so a level
 * can be retired by moving either the driver or the model.
 */
export const OVERLAPPING_DRIVER_CATALOG_FIXTURE: DriverCatalogReading = {
  models: {
    providers: [
      {
        providerName: "claude" as ProviderId,
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
        providerName: "codex" as ProviderId,
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
};

/**
 * A driver that publishes its speed tiers per model, as the Codex catalog read does: two models
 * with different tiers and one with none. Its section carries no list of its own.
 */
export const SPEED_TIER_CATALOG_FIXTURE: DriverCatalogReading = {
  models: {
    providers: [
      {
        providerName: "codex" as ProviderId,
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
};
