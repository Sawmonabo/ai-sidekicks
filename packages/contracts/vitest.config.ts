// Vitest 4.x config for @ai-sidekicks/contracts.
//
// PR #1 wires a single sanity test that actually exercises Vitest's runtime
// (mock + assertion), proving the workspace's test surface is healthy. Per ADR-022
// the longer-term shape is a root-level `vitest.config.ts` with `projects: [...]`
// covering Node + browser packages — that lands in PR #2+ when test surface widens.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
  },
});
