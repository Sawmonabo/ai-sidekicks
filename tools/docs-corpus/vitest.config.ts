// Vitest config for the doc-corpus regression hooks.
//
// Sits outside `packages/*` because tools/ is build-tooling, not a published
// package, and `pnpm-workspace.yaml` only globs `packages/*` + `apps/*`. CI
// invokes vitest directly with this config so the workspace's `turbo run test`
// fan-out remains scoped to packages.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
  },
});
