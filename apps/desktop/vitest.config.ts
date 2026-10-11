// Vitest config for @ai-sidekicks/desktop.
//
// The main-process projects and the renderer's tiers need different environments: the smoke suite
// spawns a real Electron binary from Node, where DOM globals would be the wrong shape, while the
// renderer's unit tier runs React under happy-dom. Every project's `include` globs are disjoint, so
// nothing is discovered twice.
//
// The renderer's tiers are declared in `vitest/tier-projects.ts` and spread below. Playwright is a
// library here, not a second runner: browser mode drives it for the page tiers, and
// `tests/helpers/electron/harness.ts` drives it for the window tiers.

import { configDefaults, defineConfig, type ViteUserConfig } from "vitest/config";

import { sharedCoverageOptions, WORKSPACE_SOURCE_CONDITIONS } from "../../vitest.shared.js";
import { RENDERER_TESTS_OUTSIDE_SOURCE, TIER_PROJECTS } from "./vitest/tier-projects.js";

const config: ViteUserConfig = defineConfig({
  test: {
    // Coverage is root-only in Vitest 4 when `projects` are declared, so this block sits beside
    // `projects`, not inside one.
    //
    // The denominator is the renderer sub-tree alone: the `smoke` project's tests spawn a real
    // Electron binary as a child process (`tests/launch.smoke.test.ts`), and v8 coverage
    // instruments this process, not that one, so `src/main/**` and `src/preload/**` would report
    // ~0% and drag the number toward a figure that measures the harness rather than the code. Widen
    // the include only once the main process is exercised in-process.
    coverage: sharedCoverageOptions({
      include: ["src/renderer/**/*.{ts,tsx}"],
    }),
    projects: [
      {
        test: {
          name: "smoke",
          environment: "node",
          // The files directly under `tests/`, and only those: the Electron-spawning probes.
          // `tests/**/*.test.ts` would pull every tier under `tests/<tier>/**` into this node
          // environment. A file that does not spawn Electron belongs in `main-unit`.
          include: ["tests/*.test.ts"],
          // Serial: `launch.smoke.test.ts` and `lifecycle.gc.test.ts` each spawn a full Electron
          // process tree, and run together on a 4-vCPU runner the GC probe's forced full
          // collections starve the smoke test's cold Chromium boot past its spawn deadline (the
          // two contend for the same per-`$HOME` Chromium initialization). Serializing costs about
          // 14 s here; a longer timeout would not remove the contention. The cross-package half is
          // handled in `.github/workflows/ci.yml`.
          fileParallelism: false,
        },
      },
      {
        // The in-process units for `src/main/**` and the package's other Node code, which the smoke
        // project above does not reach. Not hung off `build:smoke` in `turbo.json`: these are plain
        // TypeScript units that need no `electron-vite` bundle, and hanging them off the smoke
        // build would re-impose the ~25-30 s cost the two-project posture exists to avoid.
        define: {
          // Mirrors the release substitution in `electron.vite.config.ts`, so `main/index.ts`'s
          // probe branch is statically dead here exactly as in a release bundle. Without it the
          // bare identifier is a ReferenceError the moment the ready continuation runs.
          __SMOKE_BUILD__: "false",
          // `main/index.ts`'s fixture-launch check and remote-debugging refusal, and
          // `src/main/windows/reveal.ts`'s hidden windows; substituted for the same reason.
          __FIXTURE_BUILD__: "false",
          __TEST_TIER_BUILD__: "false",
        },
        // `src/main/**` imports contracts values, so this project must resolve the provider to TS
        // source rather than a possibly stale `dist/`. In a node environment the SSR resolver
        // decides, but both are set because Vite 6 can apply node conditions in either resolution
        // pass (vitest-dev/vitest#8431).
        resolve: {
          conditions: WORKSPACE_SOURCE_CONDITIONS,
        },
        ssr: {
          resolve: {
            conditions: WORKSPACE_SOURCE_CONDITIONS,
          },
        },
        test: {
          name: "main-unit",
          environment: "node",
          // Disjoint from `tests/*.test.ts` (the smoke project) and from the tiers, so nothing is
          // discovered twice.
          //
          // `src/shared/**` is imported by both processes, and a shared module no test project
          // reaches would have no home for its own units. `src/preload/**` follows the same
          // reasoning: `index.ts` is the expose call and holds nothing to check, and a module
          // beside it is a plain unit whose environment is this project's, not a DOM's. `build/**`
          // and `scripts/**` are the package's two executable trees, where a unit sits beside its
          // executable as in `src/main/**`, spawned as commands from a node environment.
          // `tests/helpers/**` joins them because a helper's own suite drives Node scaffolding with
          // no DOM and no need for a renderer bundle. A helper test that needs the DOM runs in the
          // renderer project and is excluded here.
          include: [
            "src/main/**/*.test.ts",
            "src/preload/**/*.test.ts",
            "src/shared/**/*.test.ts",
            "build/**/*.test.ts",
            "scripts/**/*.test.ts",
            "tests/helpers/**/*.test.ts",
          ],
          exclude: [...configDefaults.exclude, ...RENDERER_TESTS_OUTSIDE_SOURCE],
        },
      },
      // --- Renderer test tiers ---------------------------------------------
      //
      // Declared in `vitest/tier-projects.ts` and spread here. The tiers are one subject and this
      // file composes rather than declares them, so the count lives beside the projects it counts.
      ...TIER_PROJECTS,
    ],
  },
});

export default config;
