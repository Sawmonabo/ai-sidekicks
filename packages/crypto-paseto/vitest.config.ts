import { defineConfig } from "vitest/config";

import { sharedCoverageOptions, sharedTestTimeouts } from "../../vitest.shared";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
    // Shared coverage options; see `vitest.shared.ts` for why they are not one root config.
    coverage: sharedCoverageOptions(),
    ...sharedTestTimeouts(),
  },
});
