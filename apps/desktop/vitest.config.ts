// Vitest 4.x config for @ai-sidekicks/desktop.
//
// The main-process projects and the renderer's tiers run in different environments and must not
// share one `environment`: the smoke suite spawns a real Electron binary from a Node context, where
// DOM globals would be the wrong shape, while the renderer's unit tier runs React under happy-dom.
// Vitest's `projects` API declares them all in one config, and every project's `include` globs are
// disjoint, so nothing is discovered twice. `smoke`'s glob is `tests/*.test.ts`, exactly the files
// directly under `tests/`, because `tests/**/*.test.ts` would swallow every tier under
// `tests/<tier>/**` and run it in the smoke project's node environment.
//
// The renderer's test tiers are Vitest projects declared in `vitest/tier-projects.ts` and spread
// below; there is no `playwright.config.ts`. `e2e` and `endurance` run in a node environment where
// the test file is the driver, launching the main process through
// `tests/helpers/electron-harness.ts`, which holds the single `_electron` call site. Playwright is
// a library on both halves of this package rather than a second runner: browser mode drives it for
// the three page tiers, and the harness drives it for the two window ones.

import { configDefaults, defineConfig } from "vitest/config";

import { sharedCoverageOptions } from "../../vitest.shared";
import { RENDERER_TESTS_OUTSIDE_SOURCE, TIER_PROJECTS } from "./vitest/tier-projects";
import { PATH_ALIASES } from "./vitest/path-aliases";

export default defineConfig({
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
        resolve: { alias: PATH_ALIASES },
        test: {
          name: "smoke",
          environment: "node",
          // The files directly under `tests/`, and only those: the Electron-spawning probes.
          // Narrowed from `tests/**/*.test.ts` so the tiers under `tests/<tier>/**` are not
          // double-discovered here in a node environment that would fail them for the wrong reason.
          //
          // Nothing checks the count; a reviewer does, on the diff that adds a file here. A pure
          // unit at this address pays the whole tier (the Electron download, the smoke bundle, the
          // serialized queue below) for a trivial assertion. A file that does not spawn Electron
          // belongs in `main-unit`.
          include: ["tests/*.test.ts"],
          // Two files under this glob each spawn a full Electron/Chromium process tree:
          // `launch.smoke.test.ts` and `lifecycle.gc.test.ts`. Vitest's default
          // `fileParallelism: true` runs them concurrently, and on a 4-vCPU hosted runner that is
          // the documented cause of this suite's intermittent boot timeout: `lifecycle.gc.test.ts`
          // drives 80 forced stop-the-world full GCs over ~160 MB of allocation churn while
          // `launch.smoke.test.ts` is trying to complete a cold Chromium boot against its spawn
          // deadline, and both are the runner's first Electron launches, so they contend for the
          // same cold per-`$HOME` Chromium initialization (fontconfig cache build, NSS DB
          // creation).
          //
          // Measured on the failing CI run: vitest reported `tests 41.32s` against a wall
          // `Duration 27.58s`, so the two files overlapped by at least 13.7 s of the smoke test's
          // 15.08 s window; `lifecycle.gc.test.ts` took 26.04 s against its own ~5 s expectation,
          // and the smoke boot, measured at 462-510 ms unloaded, never reached `did-finish-load`.
          //
          // Serializing costs ~14 s of wall time in this project and removes the contention
          // outright; a longer timeout would not. The cross-package half of the same contention
          // (turbo scheduling this project beside the daemon suite) is removed in
          // `.github/workflows/ci.yml`, not here.
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
          __SIDEKICKS_SMOKE_BUILD__: "false",
          // `main/index.ts`'s fixture-launch check and `src/main/windows/window-reveal.ts`'s hidden
          // windows; substituted for the same reason as above.
          __FIXTURE_BUILD__: "false",
          __TEST_TIER_BUILD__: "false",
        },
        // `src/main/**` imports contracts values, so this project must resolve the provider to TS
        // source rather than a possibly stale `dist/`. In a node environment the SSR resolver
        // decides, but both are set because Vite 6 can apply node conditions in either resolution
        // pass (vitest-dev/vitest#8431). Conditions replace vitest's defaults, so `import` and
        // `default` are re-listed.
        resolve: {
          alias: PATH_ALIASES,
          conditions: ["@ai-sidekicks/source", "import", "default"],
        },
        ssr: {
          resolve: {
            conditions: ["@ai-sidekicks/source", "import", "default"],
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
          // and `scripts/**` are the package's two executable trees, with units co-located beside
          // the executable as in `src/main/**`, spawned as commands from a node environment.
          // `tests/helpers/**` joins them because a helper's own suite drives Node scaffolding with
          // no DOM and no need for a renderer bundle. The renderer helpers' tests in the same folder
          // run under the renderer project's DOM and are excluded here.
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
