// Tests run under Node because `better-sqlite3` is a native binding. Two projects with disjoint
// globs: the unit tests beside the code they prove, which `pnpm test` runs, and the endurance tier.
import { defineConfig } from "vitest/config";

import {
  sharedCoverageOptions,
  sharedTestTimeouts,
  WORKSPACE_SOURCE_CONDITIONS,
} from "../../vitest.shared";

// The database writer's worker thread runs this package's TypeScript under plain Node, outside the
// test runner's own loading, so each test process registers the source loader its workers inherit.
const SOURCE_LOADER = new URL("./tests/helpers/typescript-source-loader.mjs", import.meta.url).href;

// The endurance tier seeds a database for minutes, so its runs are bounded at ten minutes.
const ENDURANCE_TIMEOUT_MS = 600_000;

// A mutation run reruns every test that reaches a mutant, and the endurance tier reaches the
// session search for minutes a run, so a mutation run takes the unit tests alone.
const isMutationRun = process.env["STRYKER_MUTATOR_WORKER"] !== undefined;

export default defineConfig({
  test: {
    environment: "node",
    execArgv: [
      "--import",
      `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(SOURCE_LOADER)})`,
    ],
    passWithNoTests: false,
    reporters: ["default"],
    // Coverage is read only at the root once projects are declared.
    coverage: sharedCoverageOptions(),
    ...sharedTestTimeouts(),
    projects: [
      { extends: true, test: { name: "unit", include: ["src/**/__tests__/**/*.test.ts"] } },
      ...(isMutationRun
        ? []
        : [
            {
              // Tier: endurance. The session directory's budgets on a seeded set of a million
              // messages, timed. Runs only by name, outside `pnpm test` and CI, and one file at a
              // time, so no other test shares the machine it measures.
              extends: true,
              test: {
                name: "endurance",
                include: ["tests/endurance/**/*.test.ts"],
                testTimeout: ENDURANCE_TIMEOUT_MS,
                hookTimeout: ENDURANCE_TIMEOUT_MS,
                fileParallelism: false,
              },
            },
          ]),
    ],
  },
  // Resolve workspace deps to TS source, not a stale dist/, through the `@ai-sidekicks/source`
  // export condition.
  ssr: {
    resolve: {
      conditions: WORKSPACE_SOURCE_CONDITIONS,
    },
  },
});
