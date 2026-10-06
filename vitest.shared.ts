// Coverage options and test limits shared by every first-party test surface. A factory rather
// than one root config with `projects`, because Vitest 4 reads `coverage` only at the root once
// projects exist, which would lose per-package numbers. Each package calls it from its own config.

import type { TestUserConfig } from "vitest/config";

type CoverageOptions = NonNullable<TestUserConfig["coverage"]>;

/** A package's changes to the shared coverage options. */
export interface SharedCoverageOverrides {
  /**
   * Source files measured, relative to the package root; defaults to the whole TypeScript source
   * tree. A config that declares `projects` narrows it to what the measured project owns.
   */
  readonly include?: readonly string[];
  /** Package-specific exclusions appended to the shared list. */
  readonly exclude?: readonly string[];
}

/**
 * Exclusions shared by every package: test material, build output, and the two schema modules,
 * each one SQL string that runs whole or not at all through the measured migration runner.
 */
const SHARED_COVERAGE_EXCLUDES: readonly string[] = [
  "**/__tests__/**",
  "**/*.test.{ts,tsx}",
  "**/*.test-d.ts",
  "**/*.d.ts",
  "**/dist/**",
  "**/out/**",
  "**/node_modules/**",
  "src/session/daemon-schema.ts",
  "src/database/control-plane-schema.ts",
];

interface TestTimeouts {
  readonly testTimeout?: number;
  readonly hookTimeout?: number;
}

/**
 * The package's own test and hook limits, lifted to five minutes in a Stryker mutation run, where
 * instrumented code runs many times slower. Stryker's per-mutant timeout still ends a hang.
 */
export function sharedTestTimeouts(limits: TestTimeouts = {}): TestTimeouts {
  return process.env["STRYKER_MUTATOR_WORKER"] === undefined
    ? limits
    : { testTimeout: 300_000, hookTimeout: 300_000 };
}

/**
 * The v8 coverage options every package uses. `include` is explicit because Vitest 4 otherwise
 * measures only files a test imported, which hides untested files.
 */
export function sharedCoverageOptions(overrides: SharedCoverageOverrides = {}): CoverageOptions {
  return {
    provider: "v8",
    include: [...(overrides.include ?? ["src/**/*.{ts,tsx}"])],
    exclude: [...SHARED_COVERAGE_EXCLUDES, ...(overrides.exclude ?? [])],
    // `json-summary` feeds CI's per-package table; `json` and `lcov` are the kept reports.
    reporter: ["text-summary", "json-summary", "json", "lcov"],
    reportsDirectory: "./coverage",
    // A failing suite still writes a report.
    reportOnFailure: true,
    clean: true,
  };
}
