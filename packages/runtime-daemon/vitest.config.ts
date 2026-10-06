// Tests run under Node because `better-sqlite3` is a native binding.
import { defineConfig } from "vitest/config";

import { sharedCoverageOptions, sharedTestTimeouts } from "../../vitest.shared";

// The database writer's worker thread runs this package's TypeScript under plain Node, outside the
// test runner's own loading, so each test process registers the source loader its workers inherit.
const SOURCE_LOADER = new URL("./tests/helpers/typescript-source-loader.mjs", import.meta.url).href;

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    execArgv: [
      "--import",
      `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(SOURCE_LOADER)})`,
    ],
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
