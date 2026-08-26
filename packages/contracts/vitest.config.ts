// Vitest 4.x config for @ai-sidekicks/contracts.
//
// PR #1 wires a single sanity test that actually exercises Vitest's runtime
// (mock + assertion), proving the workspace's test surface is healthy. Per ADR-022
// the longer-term shape is a root-level `vitest.config.ts` with `projects: [...]`
// covering Node + browser packages — that lands in PR #2+ when test surface widens.
// The coverage half of that root-projects shape is foreclosed under Vitest 4,
// which resolves `coverage` root-only once `projects` exist — see the header
// of `vitest.shared.ts`. Discovery is unaffected; only coverage is.
import { defineConfig } from "vitest/config";

import { sharedCoverageOptions } from "../../vitest.shared";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
    // BL-123 Stage 1 measurement substrate. Options live in the repo-root
    // factory so all seven test surfaces share one definition; see
    // `vitest.shared.ts` for why coverage cannot be hoisted into a single
    // root config.
    coverage: sharedCoverageOptions(),
  },
});
