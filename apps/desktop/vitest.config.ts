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

export default defineConfig({
  test: {
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
          // on `vitest/globals` types (configured in `src/renderer/tsconfig.json`).
          globals: true,
        },
      },
    ],
  },
});
