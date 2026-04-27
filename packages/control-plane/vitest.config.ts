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
});
