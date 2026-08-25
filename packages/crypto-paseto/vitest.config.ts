import { defineConfig } from "vitest/config";

import { sharedCoverageOptions } from "../../vitest.shared";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
    // BL-123 Stage 1 measurement substrate. Options live in the repo-root
    // factory so all seven test surfaces share one definition; see
    // `vitest.shared.ts` for why coverage cannot be hoisted into a single
    // root config.
    coverage: sharedCoverageOptions(),
  },
});
