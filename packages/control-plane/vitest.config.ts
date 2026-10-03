import { defineConfig } from "vitest/config";

import { sharedCoverageOptions, sharedTestTimeouts } from "../../vitest.shared";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    // `@electric-sql/pglite` is WASM with no native binding or browser-only API, so Node suffices.
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
    coverage: sharedCoverageOptions(),
    // The in-process WASM Postgres tests take about 2-5s each, around vitest's 5000ms default, so a
    // contended CI run would time out. 15000/30000 gives about 3x headroom.
    ...sharedTestTimeouts({ testTimeout: 15000, hookTimeout: 30000 }),
  },
  // Resolve workspace deps to TS source, not a stale dist/, through the `@ai-sidekicks/source`
  // export condition. Conditions replace vitest's defaults, so `import`/`default` are re-listed.
  ssr: {
    resolve: {
      conditions: ["@ai-sidekicks/source", "import", "default"],
    },
  },
});
