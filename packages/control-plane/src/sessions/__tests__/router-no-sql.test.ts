// Plan-008 §Phase 1 §T-008b-1-4 / §T-008b-1-T10 / §T-008b-1-T11: dual-layer
// enforcement of I-008-3 #2 — the session router CRUD factory + SSE
// subscription factory + their declaration siblings MUST NOT import the
// `pg` driver directly. They are required to route 100% through
// `SessionDirectoryService` (the wrapper Plan-001 owns).
//
// This file holds two complementary checks against that invariant:
//   * §T-008b-1-T11 — AST-walker over the LIVE source files, verifying
//     no `pg` / `pg/*` import currently exists. Catches regressions even
//     if lint is bypassed (e.g. a local `--no-verify` push past the
//     pre-commit hook).
//   * §T-008b-1-T10 — programmatic ESLint check that the
//     `no-restricted-imports` rule itself fires on a synthetic regression
//     for each of the 4 forbidden file paths. T10 + T11 together prove
//     "the rule has teeth AND the live source is clean".
//
// What we check, file-by-file:
//   - No `ImportDeclaration` whose moduleSpecifier matches /^pg(\/.*)?$/
//   - No dynamic `import("pg")` / `import("pg/...")` call expression
// The codebase is ESM-only (`"type": "module"`) — `require()` is not in
// scope. CJS-style requires would be flagged by tsc anyway under
// `module: "nodenext"`.
//
// A positive-control test verifies the introspection logic itself
// correctly fires on a synthetic source. Without it, a passing suite is
// ambiguous between "no violations were found" and "introspector silently
// matched nothing".
//
// Refs: docs/plans/008-control-plane-relay-and-session-join.md §I-008-3 #2,
//       docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-4,
//       docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-T10,
//       docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-T11.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SESSIONS_DIR = resolve(import.meta.dirname, "..");
// Workspace root holds eslint.config.mjs — five hops above this file:
//   __tests__/ → sessions/ → src/ → control-plane/ → packages/ → root.
const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../../..");

// The set of files governed by I-008-3 #2. Mirrors the `files` array in
// eslint.config.mjs's `no-restricted-imports` block — keep them in sync.
const FORBIDDEN_PG_IMPORT_FILES = [
  "session-router.ts",
  "session-router.factory.ts",
  "session-subscribe-sse.ts",
  "session-subscribe-sse.factory.ts",
] as const;

// Matches both bare `pg` and `pg/*` subpath imports (e.g. `pg/native`).
const PG_IMPORT_PATTERN = /^pg(\/.*)?$/;

interface ImportFinding {
  readonly moduleSpecifier: string;
  readonly line: number;
  readonly kind: "static" | "dynamic";
}

function collectImports(source: ts.SourceFile): readonly ImportFinding[] {
  const findings: ImportFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const { line } = source.getLineAndCharacterOfPosition(node.moduleSpecifier.getStart(source));
      findings.push({
        moduleSpecifier: node.moduleSpecifier.text,
        line: line + 1,
        kind: "static",
      });
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) {
        const { line } = source.getLineAndCharacterOfPosition(arg.getStart(source));
        findings.push({
          moduleSpecifier: arg.text,
          line: line + 1,
          kind: "dynamic",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return findings;
}

function parseSourceFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
  );
}

describe("I-008-3 #2: session router + SSE factories MUST NOT import pg directly", () => {
  for (const fileName of FORBIDDEN_PG_IMPORT_FILES) {
    it(`${fileName} has no \`pg\` or \`pg/*\` imports`, () => {
      const filePath = resolve(SESSIONS_DIR, fileName);
      const source = parseSourceFile(filePath);
      const violations = collectImports(source).filter((finding) =>
        PG_IMPORT_PATTERN.test(finding.moduleSpecifier),
      );
      // The asserted-empty array carries enough detail (specifier + line +
      // static/dynamic) for a future regression failure to point the reader
      // at the exact offending statement without rerunning the harness.
      expect(violations).toEqual([]);
    });
  }

  it("positive control: introspector detects synthetic static + dynamic `pg` imports", () => {
    // Without this control, a passing suite is ambiguous between "the
    // introspector ran and found no violations" and "the introspector
    // silently never fired". The control proves the rule has teeth.
    const synthetic = ts.createSourceFile(
      "synthetic.ts",
      `import { Pool } from "pg";\nconst dyn = import("pg/native");\n`,
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ true,
    );
    const violations = collectImports(synthetic).filter((finding) =>
      PG_IMPORT_PATTERN.test(finding.moduleSpecifier),
    );
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.kind).sort()).toEqual(["dynamic", "static"]);
    expect(violations.map((v) => v.moduleSpecifier).sort()).toEqual(["pg", "pg/native"]);
  });

  it("positive control: introspector ignores non-pg imports + comment/string mentions of pg", () => {
    // Negative-of-positive: the introspector must NOT flag `pg` appearing
    // inside a comment or a non-import string literal. AST-walking gives us
    // this for free; a naive grep would false-positive.
    const synthetic = ts.createSourceFile(
      "synthetic.ts",
      [
        `// using the pg module would violate I-008-3 #2`,
        `import { something } from "./local-module.js";`,
        `const note = "we never import pg here";`,
        `const dyn = import("./other.js");`,
      ].join("\n"),
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ true,
    );
    const violations = collectImports(synthetic).filter((finding) =>
      PG_IMPORT_PATTERN.test(finding.moduleSpecifier),
    );
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §T-008b-1-T10: ESLint rule fires programmatically on synthetic regression
// ---------------------------------------------------------------------------
//
// The AST walker above (§T11) verifies the LIVE source files are clean.
// This block verifies the LINT RULE catches a regression — i.e., that the
// rule's `files` glob in eslint.config.mjs is wired to the right paths and
// the `paths` / `patterns` blocks fire on a `pg` import. Together T10 + T11
// form the enforcement-side coverage of I-008-3 #2 (#1 being constructor
// injection, verified in session-router.test.ts).
//
// Synthetic source: a single static `import { Pool } from "pg";` plus a
// `pg/native` dynamic import in the negative-of-positive test. The ESLint
// rule's `paths` entry catches the bare specifier; the `patterns` entry
// catches the subpath. We pin `filePath` to each of the 4 forbidden files
// so the `files` glob in the rule scope matches.

const PG_VIOLATION_SOURCE = `import { Pool } from "pg";\nexport const x = new Pool();\n`;

describe("§T-008b-1-T10: ESLint no-restricted-imports rule fires programmatically on each forbidden file path", () => {
  // Single ESLint instance, reused across rows — config discovery is
  // expensive and constructor invocation reads from disk every time.
  // `cwd` pins config discovery to the workspace root so the
  // eslint.config.mjs at that location is the active config.
  const eslint = new ESLint({ cwd: WORKSPACE_ROOT });

  for (const fileName of FORBIDDEN_PG_IMPORT_FILES) {
    it(`flags \`import "pg"\` when filePath = ${fileName}`, async () => {
      const targetPath = resolve(SESSIONS_DIR, fileName);
      const results = await eslint.lintText(PG_VIOLATION_SOURCE, {
        filePath: targetPath,
      });

      expect(results).toHaveLength(1);
      const messages = results[0]!.messages;
      const restrictedImportViolations = messages.filter(
        (m) => m.ruleId === "no-restricted-imports",
      );
      expect(restrictedImportViolations).toHaveLength(1);
      // The rule's message string carries the I-008-3 #2 reference — that
      // citation is operator-facing diagnostic. Pin on it so a future
      // edit that loosens the message into something generic surfaces.
      expect(restrictedImportViolations[0]!.message).toContain("Plan-008 I-008-3 #2");
    });
  }

  it("does NOT flag the same import when filePath is outside the restricted set", async () => {
    // Negative control. `session-directory-service.ts` IS allowed to
    // import `pg` — that's its job (it's the wrapper the forbidden files
    // route through). The rule's `files` glob excludes it; this test
    // proves the exclusion is real, not just absence of inclusion.
    const allowedPath = resolve(SESSIONS_DIR, "session-directory-service.ts");
    const results = await eslint.lintText(PG_VIOLATION_SOURCE, {
      filePath: allowedPath,
    });
    const restrictedImportViolations = results[0]!.messages.filter(
      (m) => m.ruleId === "no-restricted-imports",
    );
    expect(restrictedImportViolations).toEqual([]);
  });
});
