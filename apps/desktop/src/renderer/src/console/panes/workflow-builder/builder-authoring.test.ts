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
//      different moments — no wire for a well-formed question, and no well-formed
//      question at all — and a consumer that could not tell them apart would render
//      "the operation is not on the bridge yet" for a pane pointed at the wrong
//      kind of thing.

import { describe, expect, it } from "vitest";

import {
  WORKFLOW_AUTHORING_ACTS,
  WORKFLOW_BUILDER_ORIGIN,
  WORKFLOW_BUILDER_PRIMARY_ACT,
  WORKFLOW_BUILDER_REFUSAL_CODES,
  WORKFLOW_BUILDER_SUBJECT_KIND,
  misaddressedBuilderPane,
  unregisteredAuthoringAct,
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

describe("the refusal a build with no wire raises", () => {
  it("carries this file's declared code and origin for every act", () => {
    for (const act of WORKFLOW_AUTHORING_ACTS) {
      const refusal = unregisteredAuthoringAct(act);
      expect(WORKFLOW_BUILDER_REFUSAL_CODES).toContain(refusal.code);
      expect(refusal.origin).toBe(WORKFLOW_BUILDER_ORIGIN);
    }
  });

  it("names the act in prose and never a method string", () => {
    for (const act of WORKFLOW_AUTHORING_ACTS) {
      const { detail } = unregisteredAuthoringAct(act);
      expect(detail).not.toContain("workflow.");
      expect(detail).toContain("not reachable from this build");
    }
  });

  it("negative control: the prose table is consulted, so the five details differ", () => {
    // Without this, a producer that ignored its argument and returned one constant
    // sentence would satisfy every assertion above.
    const details = WORKFLOW_AUTHORING_ACTS.map((act) => unregisteredAuthoringAct(act).detail);
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

  it("is not the same refusal as a missing wire, in code or in words", () => {
    // The two are rendered by the same grammar, so a producer that returned one
    // code for both would tell a person the operation is unregistered when what is
    // actually wrong is the address the deck handed the pane.
    const misaddressed = misaddressedBuilderPane("run");
    const unregistered = unregisteredAuthoringAct(WORKFLOW_BUILDER_PRIMARY_ACT);
    expect(misaddressed.code).not.toBe(unregistered.code);
    expect(misaddressed.detail).not.toBe(unregistered.detail);
  });

  it("negative control: the kind is read, so two wrong kinds do not share a sentence", () => {
    // Without this, a producer that ignored its argument and returned one constant
    // sentence would satisfy every assertion above.
    expect(misaddressedBuilderPane("run").detail).not.toBe(
      misaddressedBuilderPane("workflow-run").detail,
    );
  });
});
