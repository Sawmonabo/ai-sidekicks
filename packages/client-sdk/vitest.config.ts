// Runs the tests under `tests/`, which load the built addon and drive it against the daemon's own
// program.
import { defineConfig } from "vitest/config";

import { sharedTestTimeouts, WORKSPACE_SOURCE_CONDITIONS } from "../../vitest.shared.js";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
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
