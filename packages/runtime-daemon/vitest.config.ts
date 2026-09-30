// Tests run under Node because `better-sqlite3` is a native binding.
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
  // Resolve workspace deps to TS source, not a stale dist/, through the `@ai-sidekicks/source`
  // export condition. Conditions replace vitest's defaults, so `import`/`default` are re-listed.
  ssr: {
    resolve: {
      conditions: ["@ai-sidekicks/source", "import", "default"],
    },
  },
});
