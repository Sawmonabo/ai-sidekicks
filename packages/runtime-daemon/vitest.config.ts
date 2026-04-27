// Vitest 4.x config for @ai-sidekicks/runtime-daemon.
//
// Mirrors the contracts-package shape (per ADR-022 the longer-term form
// is a root-level vitest.config.ts with `projects: [...]`). Tests run
// under Node — `better-sqlite3` is a native binding and must not run in
// a browser-like environment.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
  },
});
