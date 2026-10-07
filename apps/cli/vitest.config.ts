// Runs the tests beside their subjects under `src/`.
import { defineConfig, type ViteUserConfig } from "vitest/config";

import {
  sharedCoverageOptions,
  sharedTestTimeouts,
  WORKSPACE_SOURCE_CONDITIONS,
} from "../../vitest.shared.js";

const config: ViteUserConfig = defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
    coverage: sharedCoverageOptions(),
    ...sharedTestTimeouts(),
  },
  // Resolve workspace dependencies to TypeScript source, not a stale `dist/`, through the
  // `@ai-sidekicks/source` export condition.
  ssr: {
    resolve: {
      conditions: WORKSPACE_SOURCE_CONDITIONS,
    },
  },
});

export default config;
