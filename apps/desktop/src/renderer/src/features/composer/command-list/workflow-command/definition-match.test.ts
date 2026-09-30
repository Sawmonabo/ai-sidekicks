// A typed name matches a definition exactly: a run is not undone by typing more, so a prefix
// never starts a longer name.

import { describe, expect, it } from "vitest";

import { matchWorkflowDefinition } from "./definition-match.js";
import { workflowDefinition } from "./workflow-command.test-support.js";

const DEPLOY_PRODUCTION = workflowDefinition({ name: "deploy-production" });

describe("matchWorkflowDefinition", () => {
  it("does not start a longer definition off a shorter typed name", () => {
    // A run is not undoable by typing more, so `deploy` must not start `deploy-production`.
    expect(matchWorkflowDefinition([DEPLOY_PRODUCTION], "deploy")).toStrictEqual({
      status: "none",
    });
  });
});
