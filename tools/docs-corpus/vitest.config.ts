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
    // BL-123 Stage 1 measurement substrate. This is the one tree that does NOT
    // consume the repo-root `sharedCoverageOptions()` factory: `tsc -p
    // tools/docs-corpus` pins `rootDir` to this directory, so importing a file
    // above it fails the enforced `docs-corpus-typecheck` screen with TS6059.
    // The values below are the factory's, adapted to a tree that has no `src/`.
    // Keep them in step with `vitest.shared.ts` by hand.
    //
    // This tree also has no package.json, so it carries no `test:coverage`
    // script and turbo cannot fan out to it; it is measured by invoking vitest
    // directly with `--root tools/docs-corpus --coverage`, the same shape
    // .github/workflows/docs-corpus.yml already uses to run these tests.
    coverage: {
      provider: "v8",
      // Explicit denominator: Vitest 4 removed `coverage.all` and defaults to
      // "files imported during the run", under which an untested file is
      // invisible rather than a zero.
      include: ["bin/**/*.ts", "harness/**/*.ts", "lib/**/*.ts"],
      exclude: ["**/__tests__/**", "**/*.test.ts", "**/*.d.ts", "**/node_modules/**"],
      reporter: ["text-summary", "json-summary", "json", "lcov"],
      reportsDirectory: "./coverage",
      reportOnFailure: true,
      clean: true,
    },
  },
});
