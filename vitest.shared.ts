// Shared Vitest coverage options for every first-party test surface (BL-123 Stage 1).
//
// Why a factory rather than a root `vitest.config.ts` with `projects: [...]`:
// under Vitest 4 the `coverage` key is resolved ROOT-ONLY when projects are in
// play — a project-level `coverage` block is ignored. Collapsing the seven
// per-package configs into one root projects config would therefore make
// per-package numbers (and, at Stage 2, per-package floors) inexpressible.
// Each package keeps its own config and calls this factory, so the options stay
// defined once while the measurement stays per-package.
//
// Why `include` is spelled out at every call site rather than left to default:
// Vitest 4 inverted the coverage default. In v3 `coverage.all: true` measured
// every file matching the include globs whether or not a test imported it; v4
// removed `all` and defaults the denominator to "files that were imported
// during the run". A baseline collected under that default reports the coverage
// of the code the tests already reach, which is close to 100% by construction
// and useless as a floor. An explicit `include` restores the whole-source
// denominator, so an unreferenced file counts against the number.
//
// No `thresholds` here: BL-123 exit criteria (b)-(d) require the floors to be
// derived from a >=5-PR sample before any number is enforced. Stage 1 is
// measurement only.

import type { TestUserConfig } from "vitest/config";

type CoverageOptions = NonNullable<TestUserConfig["coverage"]>;

export interface SharedCoverageOverrides {
  /**
   * Source denominator for this package, relative to the package root.
   * Defaults to the whole TypeScript source tree. Packages whose config
   * declares `projects` (apps/desktop) narrow this to the sub-tree the
   * measured project owns, since coverage is resolved root-only.
   */
  readonly include?: readonly string[];
  /** Package-specific exclusions appended to the shared list. */
  readonly exclude?: readonly string[];
}

/**
 * Exclusions shared by every package. Test material is excluded because it is
 * the instrument, not the subject; `src/migrations/**` is excluded because
 * those modules are inline-SQL DDL literals whose "uncovered lines" measure
 * nothing about behaviour (they execute wholesale or not at all through
 * `migration-runner.ts`, which IS measured).
 */
const SHARED_COVERAGE_EXCLUDES: readonly string[] = [
  "**/__tests__/**",
  "**/*.test.{ts,tsx}",
  "**/*.test-d.ts",
  "**/*.d.ts",
  "**/dist/**",
  "**/out/**",
  "**/node_modules/**",
  "src/migrations/**",
];

export function sharedCoverageOptions(overrides: SharedCoverageOverrides = {}): CoverageOptions {
  return {
    provider: "v8",
    // Explicit denominator — see the header note on the v4 default inversion.
    include: [...(overrides.include ?? ["src/**/*.{ts,tsx}"])],
    exclude: [...SHARED_COVERAGE_EXCLUDES, ...(overrides.exclude ?? [])],
    // `text-summary` keeps the terminal output to one block per package;
    // `json-summary` is what CI reads to build the per-package table;
    // `json` + `lcov` are the durable artifacts BL-123 exit criterion (b)
    // requires as report pointers.
    reporter: ["text-summary", "json-summary", "json", "lcov"],
    reportsDirectory: "./coverage",
    // A failing suite still writes a report, so a red CI run is still a
    // measurable data point for the baseline sample.
    reportOnFailure: true,
    clean: true,
  };
}
