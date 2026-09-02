// The builder's authoring vocabulary, checked on the three claims it makes.
//
//   1. The act set is closed at five and the drawn act is one of them.
//   2. A refusal raised here carries a code from this file's own declared set and
//      this file's own origin — the two things that let a refusal surfacing three
//      layers away still name its author.
//   3. The refusal names the ACT and never a method string. No `workflow.*` method
//      is registered anywhere in the corpus, so printing one would be this surface
//      inventing the wire it exists to report the absence of.

import { describe, expect, it } from "vitest";

import {
  WORKFLOW_AUTHORING_ACTS,
  WORKFLOW_BUILDER_ORIGIN,
  WORKFLOW_BUILDER_PRIMARY_ACT,
  WORKFLOW_BUILDER_REFUSAL_CODES,
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
