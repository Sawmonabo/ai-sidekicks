// Plan-008 §I-008-3 #2 — the enforcement's own negative control.
//
// The invariant is that the tRPC session router, the SSE subscription factory, and
// their declaration siblings route 100% through `SessionDirectoryService` and never
// reach a database driver themselves. That claim is carried entirely by the repo-root
// `eslint.config.mjs`: a `no-restricted-imports` block for the static `import` and
// `export … from` forms, and a `no-restricted-syntax` `ImportExpression` selector
// beside it for the dynamic `import("pg")` the first rule cannot see.
//
// WHAT THIS FILE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. It asserts the rule has
// TEETH — that the `files` glob is wired to the right four paths, that all three
// import forms are refused, and that the one module which legitimately imports `pg`
// is genuinely outside the scope rather than merely unmentioned. It does NOT read
// this package's source text to check the live files are clean: that is the `lint`
// script's, which runs this same config at `error` over the whole workspace. Without
// a control here a green `lint` is ambiguous between "the rule has teeth" and "the
// rule silently matched nothing" — which is exactly what a `files` glob typo
// produces, and what a deleted config object produces.
//
// The sources below are SYNTHETIC and are handed to ESLint as text under a pinned
// `filePath`. Nothing is written to disk, and the real config is loaded from disk by
// `ESLint` itself rather than restated here — a test that re-encoded the ban would
// pass with the config deleted, which is the failure mode it exists to prevent.
//
// The sibling of this file is `apps/desktop/src/renderer/src/runtime-node-attach/
// __tests__/renderer-import-boundary.test.ts`, which drives the desktop package's
// flat config the same way.

import { resolve } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it, vi } from "vitest";

/** `packages/control-plane/src/sessions/`, the directory the four files live in. */
const SESSIONS_DIRECTORY = resolve(import.meta.dirname, "..");

/**
 * The workspace root, which holds the `eslint.config.mjs` under test.
 *
 * Five hops: `__tests__/` → `sessions/` → `src/` → `control-plane/` → `packages/`.
 */
const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../../..");

/**
 * The files I-008-3 #2 governs, mirroring the `files` array in the root config.
 *
 * Deliberately restated rather than imported: the config is the subject, so reading
 * the list out of it would make every case tautological — a typo in the glob would
 * move both sides together and nothing would report it.
 */
const FORBIDDEN_PG_IMPORT_FILES = [
  "session-router.ts",
  "session-router.factory.ts",
  "session-subscribe-sse.ts",
  "session-subscribe-sse.factory.ts",
] as const;

/** The three spellings of the same reach, each refused by a different rule half. */
const PG_IMPORT_FORMS: readonly (readonly [string, string, string])[] = [
  [
    "a bare static import",
    'import { Pool } from "pg";\nexport const pool = new Pool();\n',
    "no-restricted-imports",
  ],
  [
    "a subpath static import",
    'import { Pool } from "pg/native";\nexport const pool = new Pool();\n',
    "no-restricted-imports",
  ],
  [
    // The form `no-restricted-imports` structurally cannot see, and the reason the
    // `ImportExpression` selector sits beside it. Measured against ESLint 10.2.1:
    // planting all three forms reported only the two static ones.
    "a dynamic import",
    'export const load = async (): Promise<unknown> => import("pg");\n',
    "no-restricted-syntax",
  ],
];

/**
 * One ESLint instance for every case.
 *
 * Config discovery reads from disk on construction, and the first `lintText` pays the
 * whole flat-config resolution; sharing it keeps that cost to once per file.
 */
const eslint = new ESLint({ cwd: WORKSPACE_ROOT });

/**
 * The budget for a case that drives ESLint.
 *
 * The first `lintText` loads and resolves the workspace flat config, which is a
 * cold-start cost rather than a per-case one; under an instrumented coverage run it
 * is several seconds. Sized as headroom over that warm-up rather than as a ceiling
 * for the assertions, which settle instantly either way.
 */
const ESLINT_CASE_TIMEOUT_MS = 30_000;

vi.setConfig({ testTimeout: ESLINT_CASE_TIMEOUT_MS });

describe("I-008-3 #2 — the `pg` ban fires on every governed file", () => {
  for (const fileName of FORBIDDEN_PG_IMPORT_FILES) {
    for (const [formLabel, source, expectedRuleId] of PG_IMPORT_FORMS) {
      it(`refuses ${formLabel} in ${fileName}`, async () => {
        const results = await eslint.lintText(source, {
          filePath: resolve(SESSIONS_DIRECTORY, fileName),
        });

        const violations = (results[0]?.messages ?? []).filter(
          (message) => message.ruleId === expectedRuleId,
        );

        expect(violations).toHaveLength(1);
        // The message carries the invariant id, which is operator-facing
        // diagnostic: an edit that loosens it into something generic surfaces here.
        expect(violations[0]?.message).toContain("Plan-008 I-008-3 #2");
      });
    }
  }
});

describe("I-008-3 #2 — the scope is a boundary and not an absence", () => {
  it("leaves the wrapper that legitimately imports `pg` alone", async () => {
    // `session-directory-service.ts` IS the module the four route through, so
    // importing the driver is its job. Without this the cases above would hold over
    // a config that banned `pg` package-wide, which would be a different rule with a
    // different consequence — and the wrapper would not compile.
    const results = await eslint.lintText(PG_IMPORT_FORMS[0]?.[1] ?? "", {
      filePath: resolve(SESSIONS_DIRECTORY, "session-directory-service.ts"),
    });

    expect(
      (results[0]?.messages ?? []).filter((message) => message.ruleId === "no-restricted-imports"),
    ).toStrictEqual([]);
  });

  it("leaves an import that is not the driver alone, inside the scope", async () => {
    // The other direction: a config that reported every import from these four files
    // would pass every case above and refuse the router's own dependencies.
    const results = await eslint.lintText(
      'import { z } from "zod";\nexport const schema = z.string();\n',
      { filePath: resolve(SESSIONS_DIRECTORY, "session-router.ts") },
    );

    expect(
      (results[0]?.messages ?? []).filter(
        (message) =>
          message.ruleId === "no-restricted-imports" || message.ruleId === "no-restricted-syntax",
      ),
    ).toStrictEqual([]);
  });
});
