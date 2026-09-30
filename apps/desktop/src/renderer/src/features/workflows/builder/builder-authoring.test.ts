// The refusal a pane pointed at the wrong kind raises: it carries this file's origin, names
// both kinds, and reads its argument so two wrong kinds do not share a sentence.

import { describe, expect, it } from "vitest";

import { PANE_ADDRESS_INVALID_CODE } from "../pane-addressing.js";
import {
  WORKFLOW_BUILDER_ORIGIN,
  WORKFLOW_BUILDER_SUBJECT_KIND,
  misaddressedBuilderPane,
} from "./builder-authoring.js";

describe("the refusal a pane pointed at the wrong kind raises", () => {
  it("carries this file's origin and the pane-address code", () => {
    // The parameter is typed to the store's kind union, so which kinds exist is the compiler's.
    for (const kind of ["workflow-run", "run", "session"] as const) {
      const refusal = misaddressedBuilderPane(kind);
      expect(refusal.code).toBe(PANE_ADDRESS_INVALID_CODE);
      expect(refusal.origin).toBe(WORKFLOW_BUILDER_ORIGIN);
    }
  });

  it("names both kinds, so the message says what was asked for and what arrived", () => {
    const { detail } = misaddressedBuilderPane("workflow-run");
    expect(detail).toContain(WORKFLOW_BUILDER_SUBJECT_KIND);
    expect(detail).toContain("workflow-run");
    // No `workflow.*` method is registered, so the message must not print one.
    expect(detail).not.toContain("workflow.");
  });

  it("negative control: the kind is read, so two wrong kinds do not share a sentence", () => {
    // Guards against a producer that ignores its argument and returns one constant sentence.
    expect(misaddressedBuilderPane("run").detail).not.toBe(
      misaddressedBuilderPane("workflow-run").detail,
    );
  });
});
