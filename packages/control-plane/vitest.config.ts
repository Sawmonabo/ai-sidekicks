// Vitest 4.x config for @ai-sidekicks/control-plane.
//
// Mirrors the runtime-daemon and contracts package shapes (per ADR-022 the
// longer-term form is a root-level vitest.config.ts with `projects: [...]`).
// Tests run under Node — `@electric-sql/pglite` is pure WASM bundled into
// the package (no native binding, no browser-only API) so Node is the right
// environment.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
    // `@electric-sql/pglite` is WASM-backed in-process Postgres (the package
    // header above). Under the Node-24 CI matrix leg these in-process DB tests
    // run near vitest's bare 5000ms default — observed ~2.0-3.4s per test, with
    // the `applyMigrations` (v1 + v2) cases the heaviest — so a single contended
    // CI run tips one past the deadline (the presence-register-service
    // post-migration `%presence%` introspection timed out at 5000ms once on
    // `ubuntu-latest / node 24`). This is a pre-existing, PR-independent
    // fragility: the bare default is simply too tight for this WASM-DB test
    // class. 15000/30000 gives ~3x headroom over the worst-observed test plus
    // contention spikes, and aligns with vitest's own 2026 default bump
    // (test 5000 -> 15000, hook 10000 -> 30000). See vitest#7302 (the Node-22+
    // CI slowdown) and vitest#9751 (the default-unification raising these
    // values).
    testTimeout: 15000,
    hookTimeout: 30000,
  },
  // Resolve workspace deps to TS source (not stale dist/) under test via the
  // providers' `@ai-sidekicks/source` export condition. Node env = Vite SSR
  // pipeline → `ssr.resolve.conditions`; conditions replace vitest's defaults,
  // so `import`/`default` are re-listed.
  ssr: {
    resolve: {
      conditions: ["@ai-sidekicks/source", "import", "default"],
    },
  },
});
