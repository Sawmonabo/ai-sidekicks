// Plan-008 §Phase 1 §T-008b-1-4 / §T-008b-1-T11: AST-walker test that
// re-asserts I-008-3 enforcement #2 — the session router CRUD factory + SSE
// subscription factory + their declaration siblings MUST NOT import the
// `pg` driver directly. They are required to route 100% through
// `SessionDirectoryService` (the wrapper Plan-001 owns).
//
// The corresponding ESLint `no-restricted-imports` rule layered in
// eslint.config.mjs catches the violation at lint time; this test catches
// it at test time so CI rejects the regression even if lint is bypassed
// (e.g. a local `--no-verify` push past the pre-commit hook).
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
//       docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-T11.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SESSIONS_DIR = resolve(import.meta.dirname, "..");

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
