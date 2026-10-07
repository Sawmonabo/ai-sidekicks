import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, defineProject } from "vitest/config";

import {
  sharedCoverageOptions,
  sharedTestTimeouts,
  WORKSPACE_SOURCE_CONDITIONS,
} from "../../vitest.shared";

// A `.workers.test.ts` file runs inside workerd against the Worker's own bindings from
// `wrangler.toml`; every other test runs on Node. Each file runs in one project only.
const WORKERS_TESTS = ["src/**/__tests__/**/*.workers.test.ts"];

// Resolve workspace deps to TS source, not a stale dist/, through the `@ai-sidekicks/source`
// export condition.
const ssr = { resolve: { conditions: WORKSPACE_SOURCE_CONDITIONS } };

export default defineConfig({
  test: {
    passWithNoTests: false,
    reporters: ["default"],
    coverage: sharedCoverageOptions(),
    projects: [
      defineProject({
        test: {
          name: "node",
          include: ["src/**/__tests__/**/*.test.ts"],
          exclude: WORKERS_TESTS,
          // `@electric-sql/pglite` is WASM with no native binding or browser-only API, so Node
          // suffices.
          environment: "node",
          // The in-process WASM Postgres tests take about 2-5s each, around vitest's 5000ms
          // default, so a contended CI run would time out. 15000/30000 gives about 3x headroom.
          ...sharedTestTimeouts({ testTimeout: 15000, hookTimeout: 30000 }),
        },
        ssr,
      }),
      defineProject({
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
        test: {
          name: "workers",
          include: WORKERS_TESTS,
          ...sharedTestTimeouts(),
        },
        ssr,
      }),
    ],
  },
});
