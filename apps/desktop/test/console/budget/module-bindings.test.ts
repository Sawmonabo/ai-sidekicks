// The reader behind the `measuredBy` gate, held to its two halves.
//
// `bindingsHeldBy` decides whether a budget row's harness holds the symbol the
// row is about, so a reader that over-reports would make that gate vacuous — the
// exact failure the gate replaces, where `existsSync` passed over two rows whose
// harness never touched their subject. Every case here therefore comes with the
// input that must NOT produce the binding.
//
// The last case re-plants the pattern this reader replaced, over the one input
// that separates them. Without it "the parser reports nothing here" is a claim
// about an input nothing was ever wrong about.

import { describe, expect, it } from "vitest";

import { bindingsHeldBy } from "./module-bindings.js";

/**
 * The input the pattern got wrong, kept as one constant.
 *
 * A side-effect import binds nothing and carries no `from`, so a pattern
 * scanning forward from `import` for the next `from` ran past the semicolon,
 * through the blank line, and into a comment — reporting whatever identifiers it
 * found there. Both readers below are driven with exactly these bytes.
 */
const SIDE_EFFECT_IMPORT_THEN_PROSE: string = [
  'import "./setup.js";',
  "",
  "// The witness this suite does not drive:",
  '// `FrameWitness from "../frame-witness.js"` is held in its own file.',
  "export const HARNESS_NAME = 'launch deadline';",
].join("\n");

describe("module bindings — what a file holds", () => {
  it("reads a single-line named import", () => {
    expect(bindingsHeldBy('import { FrameWitness } from "../frame-witness.js";')).toContain(
      "FrameWitness",
    );
  });

  it("reads a brace list spread over lines, type-only members included", () => {
    const source = [
      "import {",
      "  FrameWitness,",
      "  MEASURED_WORST_LOCAL_MS,",
      "  type RendererFrameSource,",
      '} from "../frame-witness.js";',
    ].join("\n");
    const bindings = bindingsHeldBy(source);
    expect([...bindings].sort()).toStrictEqual([
      "FrameWitness",
      "MEASURED_WORST_LOCAL_MS",
      "RendererFrameSource",
    ]);
  });

  it("reads a renamed import under both names", () => {
    // Either is a defensible thing for a row to name, and neither is wrong.
    const bindings = bindingsHeldBy('import { _electron as electron } from "@playwright/test";');
    expect([...bindings].sort()).toStrictEqual(["_electron", "electron"]);
  });

  it("reads a default import and a namespace import", () => {
    expect(bindingsHeldBy('import process from "node:process";')).toContain("process");
    expect(bindingsHeldBy('import * as pathModule from "node:path";')).toContain("pathModule");
  });

  it("reads a declaration the file makes itself", () => {
    // A measuring script declares its measurer rather than importing one, so a
    // rule that read imports alone would refuse an honest row.
    expect(bindingsHeldBy("export class RendererBundleMeasurer {}")).toContain(
      "RendererBundleMeasurer",
    );
    expect(bindingsHeldBy("export const LAUNCH_BUDGET_MS: number = 1;")).toContain(
      "LAUNCH_BUDGET_MS",
    );
    expect(bindingsHeldBy("export async function runBundleBudgetCommand() {}")).toContain(
      "runBundleBudgetCommand",
    );
  });

  it("reads the names a destructured declaration binds", () => {
    // A spelling difference, not a difference in what the file holds.
    expect([...bindingsHeldBy("const { measure, report } = harness;")].sort()).toStrictEqual([
      "measure",
      "report",
    ]);
  });

  it("does not count a name bound inside a function body", () => {
    // What a row claims is that the harness OBTAINS its subject. A local three
    // scopes down is that scope's, and counting it would admit a row pointed at
    // a file whose only mention of its subject is a variable that shares the name.
    expect([...bindingsHeldBy("function run() { const FrameWitness = 1; }")]).toStrictEqual([
      "run",
    ]);
  });

  it("reports no binding for a side-effect import followed by prose naming a symbol", () => {
    // THE FINDING, as a case. `import "./setup.js";` binds nothing, and the words
    // after it are a comment — so the only name this file holds is the one it
    // declares.
    expect([...bindingsHeldBy(SIDE_EFFECT_IMPORT_THEN_PROSE)]).toStrictEqual(["HARNESS_NAME"]);
  });

  it("negative control: a commented-out import binds nothing", () => {
    // A file that only MENTIONS a symbol in prose does not hold it, whichever
    // comment form the prose takes.
    const source = [
      '// import { FrameWitness } from "../frame-witness.js";',
      "//",
      "// The witness that BoundedCleanup races is its own subject.",
      "/*",
      ' * import { BoundedCleanup } from "../bounded-cleanup.js";',
      " * const BoundedCleanup = null;",
      " */",
    ].join("\n");
    expect([...bindingsHeldBy(source)]).toStrictEqual([]);
  });

  it("negative control: a call site is not a binding", () => {
    // Naming a symbol in an expression is what a file does with something it
    // already holds; a file that never obtained it holds nothing.
    expect([...bindingsHeldBy("await new FrameWitness(source).witness();")]).toStrictEqual([]);
  });

  it("negative control: the pattern this replaced reports the phantom", () => {
    // The case that decides whether the parser was worth pulling in. This is the
    // reader as it stood — a clause pattern scanning from `import` to the next
    // `from`, anchored at a line start, which was argued to keep comments out and
    // did not. Driven over the same bytes the case above passes, it names a
    // binding the file does not hold, and `measured-by.test.ts` would go green on
    // a row re-pointed at that file.
    const importClausePattern = /^[\t ]*import\b([\s\S]*?)\bfrom\b/gm;
    const identifierPattern = /[A-Za-z_$][\w$]*/gu;
    const patternBindings = new Set<string>();
    for (const clauseMatch of SIDE_EFFECT_IMPORT_THEN_PROSE.matchAll(importClausePattern)) {
      for (const identifier of clauseMatch[1]?.match(identifierPattern) ?? []) {
        patternBindings.add(identifier);
      }
    }
    expect(patternBindings, "the pattern read a symbol out of the prose").toContain("FrameWitness");
    expect(bindingsHeldBy(SIDE_EFFECT_IMPORT_THEN_PROSE)).not.toContain("FrameWitness");
  });
});
