// The growth-values barrel hands its value exports back at runtime.
//
// The values were split into one module per wire domain, and this file is the door's
// suite. Types are erased before it runs, so what a runtime `import *` sees is the
// value half of the surface — which is what these cases drive: the module object
// really carries those names, and each one really holds the vocabulary its consumers
// read off it. Which names survive erasure is `VALUE_EXPORTS` and not a figure
// written here.

import { describe, expect, it } from "vitest";

import * as growthValues from "./index.js";

/** The names that survive erasure, so the runtime module object carries them. */
const VALUE_EXPORTS: readonly string[] = [
  "GROWTH_ARTIFACT_TYPES",
  "GROWTH_PR_PREPARATION_STATES",
  "mcpBindingKeyOf",
];

describe("the growth-values barrel at runtime", () => {
  it("hands back exactly the names that survive erasure", () => {
    // The half erasure leaves behind, driven against the imported module object: a
    // barrel that named a value in its text and re-exported nothing fails here.
    expect(Object.keys(growthValues).sort()).toStrictEqual([...VALUE_EXPORTS].sort());
    expect(growthValues.GROWTH_ARTIFACT_TYPES).toContain("workflow_output");
    expect(growthValues.GROWTH_PR_PREPARATION_STATES).toStrictEqual(["draft", "ready"]);
  });
});
