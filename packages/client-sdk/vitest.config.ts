// Runs the tests under `src/**/__tests__/`, which drive the clients over a scripted daemon
// transport.
import { defineConfig } from "vitest/config";

import { sharedCoverageOptions, sharedTestTimeouts } from "../../vitest.shared";

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
  // `@ai-sidekicks/source` export condition. The list replaces Vitest's defaults, so `import` and
  // `default` are repeated.
  ssr: {
    resolve: {
      conditions: ["@ai-sidekicks/source", "import", "default"],
    },
  },
});
