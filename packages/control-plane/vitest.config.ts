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
