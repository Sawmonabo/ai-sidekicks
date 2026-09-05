// The reader behind the `measuredBy` gate, held to its two halves.
//
// `bindingsHeldBy` decides whether a budget row's harness holds the symbol the
// row is about, so a reader that over-reports would make that gate vacuous — the
// exact failure the gate replaces, where `existsSync` passed over two rows whose
// harness never touched their subject. Every case here therefore comes with the
// input that must NOT produce the binding.

import { describe, expect, it } from "vitest";

import { bindingsHeldBy } from "./module-bindings.js";

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

  it("negative control: a commented-out import binds nothing", () => {
    // The property the line anchor buys, and the one that decides whether the
    // gate above it means anything: a file that only MENTIONS a symbol in prose
    // does not hold it.
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
});
