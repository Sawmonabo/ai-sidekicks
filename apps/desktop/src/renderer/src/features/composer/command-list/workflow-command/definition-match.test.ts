// Two readings of one name, driven over the same definitions so the command list and the start
// path agree on what a name matches.

import { describe, expect, it } from "vitest";

import { matchWorkflowDefinition, workflowDefinitionCandidates } from "./definition-match.js";
import { workflowDefinition } from "./workflow-command.test-support.js";

const NIGHTLY = workflowDefinition({ name: "nightly" });
const DEPLOY = workflowDefinition({ name: "deploy" });
const DEPLOY_PRODUCTION = workflowDefinition({ name: "deploy-production" });

describe("matchWorkflowDefinition", () => {
  it("matches an exact name, folding case", () => {
    expect(matchWorkflowDefinition([NIGHTLY, DEPLOY], "NiGhTlY")).toStrictEqual({
      status: "matched",
      definition: NIGHTLY,
    });
  });

  it("does not start a longer definition off a shorter typed name", () => {
    // A run is not undoable by typing more, so `deploy` must not start `deploy-production`.
    expect(matchWorkflowDefinition([DEPLOY_PRODUCTION], "deploy")).toStrictEqual({
      status: "none",
    });
  });

  it("narrows several same-named definitions by the wire's own resolution flag", () => {
    const sessionScoped = workflowDefinition({ name: "nightly", resolvesAtThisContext: true });
    const sharedScoped = workflowDefinition({
      name: "nightly",
      resolvesAtThisContext: false,
      latestWorkflowVersionId: "version-nightly-shared",
    });

    expect(matchWorkflowDefinition([sharedScoped, sessionScoped], "nightly")).toStrictEqual({
      status: "matched",
      definition: sessionScoped,
    });
  });

  it("refuses to choose between two the wire resolves equally", () => {
    const first = workflowDefinition({ name: "nightly" });
    const second = workflowDefinition({
      name: "Nightly",
      latestWorkflowVersionId: "version-nightly-second",
    });

    expect(matchWorkflowDefinition([first, second], "nightly")).toStrictEqual({
      status: "ambiguous",
      count: 2,
    });
  });
});

describe("workflowDefinitionCandidates", () => {
  it("offers every definition a partly typed name could still become", () => {
    expect(
      workflowDefinitionCandidates([NIGHTLY, DEPLOY, DEPLOY_PRODUCTION], "dep").map(
        (definition) => definition.name,
      ),
    ).toStrictEqual(["deploy", "deploy-production"]);
  });

  it("offers everything for a verb typed with no name after it", () => {
    expect(workflowDefinitionCandidates([NIGHTLY, DEPLOY], undefined)).toHaveLength(2);
    expect(workflowDefinitionCandidates([NIGHTLY, DEPLOY], "")).toHaveLength(2);
  });

  it("negative control: the candidate reading is a PREFIX where the match is exact", () => {
    // The readings differ on the same input: `deploy` offers both and starts neither.
    expect(workflowDefinitionCandidates([DEPLOY_PRODUCTION], "deploy")).toHaveLength(1);
    expect(matchWorkflowDefinition([DEPLOY_PRODUCTION], "deploy").status).toBe("none");
  });

  it("folds case the same way the match does", () => {
    expect(workflowDefinitionCandidates([NIGHTLY], "NIGH")).toHaveLength(1);
  });
});
