// A name two definitions share starts nothing, since the line cannot say which one was meant.

import { describe, expect, it } from "vitest";

import type { ComposerCommandLine } from "../../types.js";
import { startWorkflowFromLine } from "./start-workflow-from-line.js";
import {
  fixtureWorkflowStartOperations,
  recordedWorkflowCalls,
  WORKFLOW_TEST_SESSION_ID,
} from "./workflow-command.test-support.js";

function line(text: string): ComposerCommandLine {
  return { commandName: "workflow", text };
}

describe("startWorkflowFromLine", () => {
  it("refuses to choose between two definitions of one name", async () => {
    const calls = recordedWorkflowCalls();
    const operations = fixtureWorkflowStartOperations({
      definitions: [
        { name: "nightly" },
        { name: "nightly", latestWorkflowVersionId: "version-nightly-other" },
      ],
      calls,
    });

    const outcome = await startWorkflowFromLine(line("/workflow start nightly"), {
      operations,
      sessionId: WORKFLOW_TEST_SESSION_ID,
    });

    expect(refusalDetailOf(outcome)).toContain("2 workflows");
    expect(calls.started).toHaveLength(0);
  });
});

function refusalDetailOf(outcome: Awaited<ReturnType<typeof startWorkflowFromLine>>): string {
  if (outcome.status !== "refused") {
    throw new Error("this line must not have started a workflow");
  }
  return outcome.refusal.detail;
}
