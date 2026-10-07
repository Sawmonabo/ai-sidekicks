// Runs the tests under `src/**/__tests__/`, which drive the clients over a scripted daemon
// transport.
import { defineConfig } from "vitest/config";

import {
  sharedCoverageOptions,
  sharedTestTimeouts,
  WORKSPACE_SOURCE_CONDITIONS,
} from "../../vitest.shared";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
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
