// The builder's authoring vocabulary, checked on the three claims it makes.
//
//   1. The act set is closed at five and the drawn act is one of them.
//   2. A refusal raised here carries a code from this file's own declared set and
//      this file's own origin — the two things that let a refusal surfacing three
//      layers away still name its author.
//   3. The refusal names the ACT and never a method string. No `workflow.*` method
//      is registered anywhere in the corpus, so printing one would be this surface
//      inventing the wire it exists to report the absence of.
//   4. The two locally-raised refusals are distinguishable. They refuse at two
//      different moments — nothing to submit for a well-formed question, and no
//      well-formed question at all — and a consumer that could not tell them apart
//      would render "the canvas is reserved" for a pane pointed at the wrong kind of
//      thing.
//   5. Neither of them names the port's own code. The create these acts ride is on the
//      growth port now, so a refusal composed here that said `wire-unregistered` would
//      be this surface asserting something about a bridge it never asked.

import { describe, expect, it } from "vitest";

import {
  WORKFLOW_AUTHORING_ACTS,
  WORKFLOW_BUILDER_ORIGIN,
  WORKFLOW_BUILDER_PRIMARY_ACT,
  WORKFLOW_BUILDER_REFUSAL_CODES,
  WORKFLOW_BUILDER_SUBJECT_KIND,
  misaddressedBuilderPane,
  reservedCanvasAct,
} from "./builder-authoring.js";

describe("the authoring act set", () => {
  it("is the five acts the module claims, in the order it declares them", () => {
    expect(WORKFLOW_AUTHORING_ACTS).toStrictEqual([
      "save",
      "new-version",
      "import",
      "promote",
      "fork",
    ]);
  });

  it("draws exactly one of them", () => {
    expect(WORKFLOW_AUTHORING_ACTS).toContain(WORKFLOW_BUILDER_PRIMARY_ACT);
  });
});

describe("the refusal a build with no authoring canvas raises", () => {
  it("carries this file's declared code and origin for every act", () => {
    for (const act of WORKFLOW_AUTHORING_ACTS) {
      const refusal = reservedCanvasAct(act);
      expect(WORKFLOW_BUILDER_REFUSAL_CODES).toContain(refusal.code);
      expect(refusal.origin).toBe(WORKFLOW_BUILDER_ORIGIN);
    }
  });

  it("names the act in prose and never a method string", () => {
    for (const act of WORKFLOW_AUTHORING_ACTS) {
      const { detail } = reservedCanvasAct(act);
      expect(detail).not.toContain("workflow.");
      expect(detail).toContain("not reachable from this build");
    }
  });

  it("does not claim the wire is missing, because the create is on the port", () => {
    // The regression this pins: the refusal said "the operation is not on the bridge
    // yet" while `workflowDefinitionCreate` sat on the growth port — a surface
    // composing its own answer to a question the port already answers, and answering
    // it wrongly. What stops saving is upstream of any call.
    for (const act of WORKFLOW_AUTHORING_ACTS) {
      const refusal = reservedCanvasAct(act);
      expect(refusal.code).not.toBe("wire-unregistered");
      expect(refusal.detail).not.toContain("on the bridge");
    }
  });

  it("negative control: the prose table is consulted, so the five details differ", () => {
    // Without this, a producer that ignored its argument and returned one constant
    // sentence would satisfy every assertion above.
    const details = WORKFLOW_AUTHORING_ACTS.map((act) => reservedCanvasAct(act).detail);
    expect(new Set(details).size).toBe(WORKFLOW_AUTHORING_ACTS.length);
  });
});

describe("the refusal a pane pointed at the wrong kind raises", () => {
  it("carries this file's declared code and origin, as the act refusal does", () => {
    // The parameter is typed to the store's own kind union, so which kinds exist is
    // the compiler's claim and not this file's. What a test can add is that the
    // refusal a wrong kind produces is one this module declares.
    for (const kind of ["workflow-run", "run", "session"] as const) {
      const refusal = misaddressedBuilderPane(kind);
      expect(WORKFLOW_BUILDER_REFUSAL_CODES).toContain(refusal.code);
      expect(refusal.origin).toBe(WORKFLOW_BUILDER_ORIGIN);
    }
  });

  it("names both kinds, so the message says what was asked for and what arrived", () => {
    const { detail } = misaddressedBuilderPane("workflow-run");
    expect(detail).toContain(WORKFLOW_BUILDER_SUBJECT_KIND);
    expect(detail).toContain("workflow-run");
    // No method string, for the same reason the act refusal carries none: no
    // `workflow.*` method is registered, and printing one would invent the wire.
    expect(detail).not.toContain("workflow.");
  });

  it("is not the same refusal as a reserved canvas, in code or in words", () => {
    // The two are rendered by the same grammar, so a producer that returned one
    // code for both would tell a person the canvas is reserved when what is
    // actually wrong is the address the deck handed the pane.
    const misaddressed = misaddressedBuilderPane("run");
    const reserved = reservedCanvasAct(WORKFLOW_BUILDER_PRIMARY_ACT);
    expect(misaddressed.code).not.toBe(reserved.code);
    expect(misaddressed.detail).not.toBe(reserved.detail);
  });

  it("negative control: the kind is read, so two wrong kinds do not share a sentence", () => {
    // Without this, a producer that ignored its argument and returned one constant
    // sentence would satisfy every assertion above.
    expect(misaddressedBuilderPane("run").detail).not.toBe(
      misaddressedBuilderPane("workflow-run").detail,
    );
  });
});
