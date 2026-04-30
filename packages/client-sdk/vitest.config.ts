// Vitest 4.x config for @ai-sidekicks/client-sdk.
//
// Mirrors `packages/contracts/vitest.config.ts` and
// `packages/runtime-daemon/vitest.config.ts` for unit tests; extends the
// universal `src/**/__tests__/**/*.test.ts` discovery glob with a second
// root for cross-workspace integration tests at `test/**/*.test.ts`. Per
// Plan-008 §T-008b-1-5 line 222, the SSE round-trip test
// (`test/transport/sse-roundtrip.test.ts`) lives under `test/` to signal
// "integration test crossing a workspace boundary" — distinct from
// in-package unit tests under `src/transport/__tests__/`. Per ADR-022 the
// longer-term form is a root-level `vitest.config.ts` with `projects: [...]`;
// until that lands the per-package configs carry the discovery globs they
// need.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
  },
});
