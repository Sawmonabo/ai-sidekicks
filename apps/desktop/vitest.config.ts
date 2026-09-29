// Vitest 4.x config for @ai-sidekicks/desktop.
//
// The main-process projects and the renderer's tiers have fundamentally different
// runtime environments and MUST NOT share a single `environment` setting: the smoke
// suite spawns a real Electron binary from a Node context, where DOM globals would be
// the wrong shape, while the renderer's unit tier runs React under happy-dom. Vitest's
// `projects` API declares them all inside one config, and per-project `include` globs
// are disjoint, so there is no double-discovery risk.
//
// The renderer's test tiers are all Vitest projects,
// declared in `vitest/tier-projects.ts` and spread below — there is no
// `playwright.config.ts` anywhere in this repository, and the two tiers that
// need a real Electron window do not want one: `e2e` and `endurance` run in a
// NODE environment where the test file is the DRIVER, and they launch the shell
// through `tests/helpers/electron-harness.ts`,
// which holds the single `_electron` call site. Playwright is a library on both
// halves of this package rather than a second runner — browser mode drives it
// for the three page tiers, and the harness drives it for the two window ones.
//
// Every glob is disjoint. `smoke`'s `tests/**/*.test.ts` would otherwise swallow every
// tier under `tests/<tier>/**` and run it in the smoke project's node environment, so
// it is `tests/*.test.ts`: exactly the files directly under `tests/`.

import { configDefaults, defineConfig } from "vitest/config";

import { sharedCoverageOptions } from "../../vitest.shared";
import { RENDERER_TESTS_OUTSIDE_SOURCE, TIER_PROJECTS } from "./vitest/tier-projects";
import { PATH_ALIASES } from "./vitest/path-aliases";

export default defineConfig({
  test: {
    // Coverage measurement. Vitest 4 resolves `coverage` root-only when
    // `projects` are declared, so this block sits beside `projects`, not
    // inside one.
    //
    // The denominator is deliberately the renderer sub-tree alone. The `smoke`
    // project's tests spawn a real Electron binary as a child process
    // (tests/launch.smoke.test.ts); v8 coverage instruments this process, not
    // that one, so `src/main/**` and `src/preload/**` would report ~0% and drag
    // the package number toward a figure that measures the harness rather than
    // the code. Widening this include is the correct move only once the main
    // process is exercised in-process.
    coverage: sharedCoverageOptions({
      include: ["src/renderer/**/*.{ts,tsx}"],
    }),
    projects: [
      {
        resolve: { alias: PATH_ALIASES },
        test: {
          name: "smoke",
          environment: "node",
          // The files directly under `tests/`, and only those: the
          // Electron-spawning probes. Narrowed from `tests/**/*.test.ts` so the
          // tiers under `tests/<tier>/**` are not double-discovered here in a
          // node environment that would fail them for the wrong reason.
          //
          // NOTHING CHECKS THE COUNT — a reviewer does, on the diff that adds
          // a file here. A pure unit that landed at this address paid the whole
          // tier for two `process.kill(pid, 0)` assertions: the Electron
          // download, the smoke bundle, and the serialized queue below. A file
          // that does not spawn Electron belongs in `main-unit`.
          include: ["tests/*.test.ts", "test/*.test.ts"],
          // Two files under this glob each spawn a full Electron/Chromium
          // process tree — `launch.smoke.test.ts` and `lifecycle.gc.test.ts`.
          // Vitest's default `fileParallelism: true` runs them CONCURRENTLY,
          // and on a 4-vCPU hosted runner that is the documented cause of this
          // suite's intermittent boot timeout: `lifecycle.gc.test.ts` drives 80
          // forced stop-the-world full GCs over ~160 MB of allocation churn
          // while `launch.smoke.test.ts` is trying to complete a cold Chromium
          // boot against its spawn deadline, and both are also the runner's FIRST
          // Electron launches, so they contend for the same cold per-`$HOME`
          // Chromium initialisation (fontconfig cache build, NSS DB creation).
          //
          // Measured on the failing run (GitHub Actions run 33571210321):
          // vitest reported `tests 41.32s` against a wall `Duration 27.58s`,
          // so the two files provably overlapped by >=13.7 s of the smoke
          // test's 15.08 s window; `lifecycle.gc.test.ts` took 26.04 s against
          // its own header's ~5 s expectation, and the smoke boot — measured at
          // 462-510 ms unloaded — never reached `did-finish-load`.
          //
          // Serialising costs ~14 s of wall time in this project and removes
          // the contention outright. It is deliberately NOT a longer timeout —
          // this change alters no budget. (`SPAWN_TIMEOUT_MS` was separately
          // re-derived 15 s -> 30 s from the CI numbers this fix's own runs
          // produced; see that constant's comment for why the two are not the
          // same act.) The cross-PACKAGE half of the same contention — turbo
          // scheduling this project beside the daemon suite — is removed in
          // `.github/workflows/ci.yml`, not here.
          fileParallelism: false,
        },
      },
      {
        // The in-process units for `src/main/**` and the package's other Node
        // code, which the smoke project above does not reach.
        //
        // Deliberately NOT hung off `build:smoke` in `turbo.json`: these are
        // plain-TypeScript units that need no `electron-vite` bundle, and
        // hanging them off the smoke build would re-impose the ~25-30 s cost the
        // two-project posture exists to avoid.
        define: {
          // Mirrors the release substitution in `electron.vite.config.ts`, so
          // `main/index.ts`'s probe branch is statically dead here exactly as it
          // is in a release bundle. Without it the bare identifier is a
          // ReferenceError the moment the ready continuation runs.
          __SIDEKICKS_SMOKE_BUILD__: "false",
          // `src/main/windows/window-reveal.ts` reads both flags; substituted for the same
          // reason as the one above.
          __SIDEKICKS_CONSOLE_FIXTURES__: "false",
        },
        // `src/main/**` imports contracts values, so this project must resolve the
        // provider to TS source rather than a possibly-stale `dist/`. Node
        // environment → the SSR resolver is the one that decides, but both are
        // set because Vite 6 can apply node conditions in either resolution pass
        // (vitest-dev/vitest#8431). Conditions replace vitest's defaults, so
        // `import` / `default` are re-listed.
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
          // Disjoint from `tests/*.test.ts` (the smoke project) and from the
          // tiers, so the no-double-discovery property still holds.
          // `src/shared/**` joins the set because that subtree is imported by BOTH
          // processes, and a shared module no test project reaches would be a
          // subtree with no home for its own units.
          // `src/preload/**` joins it on the same reasoning: `index.ts` is the
          // expose call and holds nothing to check, but the modules beside it —
          // `shell-signals.ts` is the first — are plain units over an injected
          // receiver, and the environment they need is this project's rather
          // than a DOM's.
          // `build/**` and `scripts/**` are the package's two executable trees,
          // and their units are co-located beside the executable exactly as
          // `src/main/**`'s are; both are spawned as commands from a node
          // environment, which is this project's.
          // `tests/helpers/**` joins them for the same reason: those suites drive
          // the cross-process scaffolding — the managed Electron child, the
          // process-tree readers, the bounded cleanup, the launch deadline — and
          // the artifact readers driven with doubles, the heap-snapshot writer and
          // the release fuse wire, which read a packaged artifact or a synthetic
          // temp root of their own. All of it is Node code with no DOM, and none of
          // it needs a renderer bundle behind it — which is the property this
          // project's include list keys on. Read the directory rather than this
          // sentence for the roster. The renderer helpers' tests in the same folder
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
      // Declared in `vitest/tier-projects.ts`, spread here. The tiers are one
      // subject and this file composes rather than declares them, so the count
      // lives there beside the projects it counts rather than here, where a reader
      // would have to trust it.
      ...TIER_PROJECTS,
    ],
  },
});
