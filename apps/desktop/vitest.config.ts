// Vitest 4.x config for @ai-sidekicks/desktop.
//
// Plan-001 Phase 5 T5.2 substrate completion (T-amend-002): introduces a
// renderer-unit-test surface alongside the existing main-process smoke test.
// The two surfaces have fundamentally different runtime environments and
// MUST NOT share a single `environment` setting:
//
//   • main suite: existing `test/launch.smoke.test.ts` spawns a real Electron
//     binary from a Node context — DOM/window globals would be wrong shape.
//   • renderer suite: new `src/renderer/**/__tests__/**` exercises React
//     components against `window.sidekicks` — needs a DOM environment.
//
// Vitest's `projects` API (stable in Vitest 3+, present in 4.1.5) lets us
// declare both inside a single config so `pnpm test` runs them in one
// invocation. Per-project `include` globs are disjoint, so there is no
// double-discovery risk.
//
// Renderer-untrusted boundary (Spec-023 §Trust Stance) note: happy-dom is a
// pure-JS DOM shim with no Node-IPC capabilities; it does NOT punch a hole
// in the renderer's process isolation at test time. The bridge surface
// (`window.sidekicks`) is mocked per test (see SessionBootstrap.test.tsx)
// rather than dispatched to the real preload — there is no `electron`
// runtime in this test surface.
//
// Plan-023 Phase 1C (T-023p-1C-1) registers the console's test tiers
// (`Spec-023 §Console Test Tiers`). Seven of the nine tiers are Vitest projects
// declared below; `end-to-end` and `endurance` need a real Electron window and
// live in `playwright.config.ts` beside this file. Every glob is disjoint —
// including the two NARROWINGS this phase makes to pre-existing projects, which
// are load-bearing rather than tidying:
//
//   • `main`'s `test/**/*.test.ts` would otherwise swallow every console tier
//     under `test/console/**` and run it in the smoke project's node
//     environment. It becomes `test/*.test.ts`, which is exactly the three
//     files directly under `test/` it has always meant.
//   • `renderer`'s `src/renderer/**/__tests__/**` is unchanged, but its
//     `exclude` now names the console and shell subtrees so a test co-located
//     under `src/renderer/src/console/**` or `src/renderer/src/shell/**`
//     belongs to `console-unit` alone.
import { defineConfig } from "vitest/config";

import { sharedCoverageOptions } from "../../vitest.shared";
import { WORKSPACE_SOURCE_CONDITIONS } from "./vitest/browser-mode";
import { CONSOLE_TIER_PROJECTS } from "./vitest/console-projects";

export default defineConfig({
  test: {
    // BL-123 Stage 1 measurement substrate. Vitest 4 resolves `coverage`
    // root-only when `projects` are declared, so this block sits beside
    // `projects`, not inside one.
    //
    // The denominator is deliberately the renderer sub-tree alone. The `main`
    // project's one test spawns a real Electron binary as a child process
    // (test/launch.smoke.test.ts); v8 coverage instruments this process, not
    // that one, so `src/main/**` and `src/preload/**` would report ~0% and drag
    // the package number toward a figure that measures the harness rather than
    // the code. Widening this include is the correct move only once the main
    // process is exercised in-process — see BL-131's renderer/E2E leg.
    coverage: sharedCoverageOptions({
      include: ["src/renderer/**/*.{ts,tsx}"],
    }),
    projects: [
      {
        test: {
          name: "main",
          environment: "node",
          // The three files directly under `test/`, and only those: the two
          // Electron-spawning probes and the sidecar unit that has always sat
          // beside them. Narrowed from `test/**/*.test.ts` by Plan-023 Phase 1C
          // so the console tiers under `test/console/**` are not
          // double-discovered here in a node environment that would fail them
          // for the wrong reason.
          //
          // The count is held by `vitest-project-globs.test.ts` rather than
          // stated here and read never. A pure unit that landed at this address
          // paid the whole tier for two `process.kill(pid, 0)` assertions — the
          // Electron download, the smoke bundle, and the serialized queue below
          // — so a fourth file here is now a red check rather than a slow one.
          include: ["test/*.test.ts"],
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
        // Plan-023 Phase 1B (T-023p-1B-3). Named `main-unit` because `main` is
        // already taken by the smoke project above — these are the in-process
        // units for `src/main/**`, which neither existing project reaches.
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
          // `src/main/window-reveal.ts` reads both flags; substituted for the same
          // reason as the one above.
          __SIDEKICKS_CONSOLE_FIXTURES__: "false",
        },
        // `src/main/window.ts` imports `SessionIdSchema` from the contracts
        // `./session` subpath as a VALUE, so this project must resolve the
        // provider to TS source rather than a possibly-stale `dist/`. Node
        // environment → the SSR resolver is the one that decides, but both are
        // set for the same Vite-6 reason the renderer block below records.
        // Conditions replace vitest's defaults, so `import` / `default` are
        // re-listed.
        resolve: {
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
          // Disjoint from `test/*.test.ts` (the smoke project) and from
          // `src/renderer/**/__tests__/**` (the renderer project), so the
          // posture's no-double-discovery property still holds. `src/shared/**`
          // joins the set because that subtree is imported by BOTH processes
          // (see `src/shared/auxiliary-routes.ts`), and a shared module no test
          // project reaches would be a subtree with no home for its own units.
          // `build/**` and `scripts/**` are the package's two executable trees,
          // and their units are co-located beside the executable exactly as
          // `src/main/**`'s are; both are spawned as commands from a node
          // environment, which is this project's.
          include: [
            "src/main/**/*.test.ts",
            "src/shared/**/*.test.ts",
            "build/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
        },
      },
      {
        // Resolve workspace *value* imports (e.g. `NotImplementedAtTier1Error`
        // from @ai-sidekicks/contracts in SessionBootstrap.test.tsx) to TS source,
        // not stale dist/, via the provider's `@ai-sidekicks/source` export
        // condition. happy-dom is Vite's *client* environment → the knob is
        // `resolve.conditions`; per vitest-dev/vitest#8431 (Vite 6 can wrongly apply
        // node conditions in happy-dom resolution passes) we set `ssr.resolve.*` too.
        // Conditions replace vitest's defaults, so `import`/`default` are re-listed.
        // (The node `main` smoke project imports contracts type-only → erased →
        // needs none. The `main-unit` project above DOES need them — see its
        // own block.)
        // A Tier-1 renderer component consumes the console's subject-scoped holder —
        // `runtime-node-attach/NodeRoster.tsx` holds its roster per session and per
        // transport — and that holder reaches the console's `core` door, which
        // carries the tripwire module's fixture branch. So this project compiles
        // console source even though it runs no console test, and the flag has to be
        // substituted here for the same reason `main-unit` above substitutes it:
        // without it the bare identifier is a ReferenceError at import time. `false`,
        // matching the release bundle, so the branch is statically dead.
        define: { __SIDEKICKS_CONSOLE_FIXTURES__: "false" },
        resolve: {
          conditions: WORKSPACE_SOURCE_CONDITIONS,
        },
        ssr: {
          resolve: {
            conditions: WORKSPACE_SOURCE_CONDITIONS,
          },
        },
        test: {
          name: "renderer",
          environment: "happy-dom",
          // Co-locate renderer unit tests under `src/renderer/**/__tests__/**`
          // to mirror the per-package convention used by `packages/contracts`
          // and `packages/client-sdk` (renderer is its own composite TS
          // project; its tests live inside that project's source tree).
          include: ["src/renderer/**/__tests__/**/*.test.{ts,tsx}"],
          // The console owns its own tier; a console or shell test never runs here.
          exclude: ["src/renderer/src/console/**", "src/renderer/src/shell/**"],
          // `globals: true` populates `vi`, `expect`, `describe`, `it`,
          // `afterEach` etc. on the global scope so the test file can rely
          // on `vitest/globals` types (configured in
          // `src/renderer/tsconfig.test.json` — kept separate from the
          // production renderer `tsconfig.json` so vitest globals never leak
          // into renderer production code's typegraph).
          globals: true,
        },
      },

      // --- Console test tiers (`Spec-023 §Console Test Tiers`) --------------
      //
      // Declared in `vitest/console-projects.ts`, spread here. The seven tiers are
      // one subject and this file composes rather than declares them.
      ...CONSOLE_TIER_PROJECTS,
    ],
  },
});
