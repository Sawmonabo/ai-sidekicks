// Vitest config for @ai-sidekicks/contracts; coverage options come from the shared factory.
import { defineConfig } from "vitest/config";

import { sharedCoverageOptions, sharedTestTimeouts } from "../../vitest.shared";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
    // Coverage options are defined once in the repo-root factory, not in a root projects config.
    coverage: sharedCoverageOptions(),
    ...sharedTestTimeouts(),
  },
});
