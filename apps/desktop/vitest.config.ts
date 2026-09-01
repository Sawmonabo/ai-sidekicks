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
import { defineConfig } from "vitest/config";

import { sharedCoverageOptions } from "../../vitest.shared";

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
          // The existing smoke test spawns Electron from the package root.
          // Keep its discovery glob narrow so the renderer-suite glob below
          // does not pick it up under happy-dom by accident.
          include: ["test/**/*.test.ts"],
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
          // Disjoint from `test/**/*.test.ts` (the smoke project) and from
          // `src/renderer/**/__tests__/**` (the renderer project), so the
          // posture's no-double-discovery property still holds.
          include: ["src/main/**/*.test.ts", "build/**/*.test.ts"],
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
        resolve: {
          conditions: ["@ai-sidekicks/source", "import", "default"],
        },
        ssr: {
          resolve: {
            conditions: ["@ai-sidekicks/source", "import", "default"],
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
          // `globals: true` populates `vi`, `expect`, `describe`, `it`,
          // `afterEach` etc. on the global scope so the test file can rely
          // on `vitest/globals` types (configured in
          // `src/renderer/tsconfig.test.json` — kept separate from the
          // production renderer `tsconfig.json` so vitest globals never leak
          // into renderer production code's typegraph).
          globals: true,
        },
      },
    ],
  },
});
