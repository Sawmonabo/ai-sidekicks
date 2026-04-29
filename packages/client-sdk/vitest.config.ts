// Vitest 4.x config for @ai-sidekicks/client-sdk.
//
// Mirrors `packages/contracts/vitest.config.ts` and
// `packages/runtime-daemon/vitest.config.ts`. Per ADR-022 the longer-term
// form is a root-level `vitest.config.ts` with `projects: [...]`; until
// that lands the per-package configs share the same `include` glob so the
// universal `src/**/__tests__/**/*.test.ts` discovery contract holds.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
  },
});
