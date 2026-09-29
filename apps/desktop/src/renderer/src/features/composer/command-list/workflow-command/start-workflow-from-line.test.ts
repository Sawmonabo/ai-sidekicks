// What the accelerator sends, and what it refuses to send.
//
// Every refusal below names what was typed, because on each of those paths nothing
// was asked.

import { describe, expect, it } from "vitest";

import type { DirectiveLine } from "../../types.js";
import { startWorkflowFromLine } from "@renderer/shell/composer/commands/workflow-start/start-dispatch.js";
import {
  fixtureWorkflowStartOperations,
  recordedWorkflowCalls,
  WORKFLOW_TEST_SESSION_ID,
} from "./workflow-command.test-support.js";

/** One line as the router hands it over. */
function line(text: string): DirectiveLine {
  return { commandName: "workflow", text };
}

describe("startWorkflowFromLine", () => {
  it("starts the pinned version of the definition it found", async () => {
    const calls = recordedWorkflowCalls();
    const operations = fixtureWorkflowStartOperations({
      definitions: [{ name: "nightly" }],
      calls,
    });

    const outcome = await startWorkflowFromLine(line("/workflow start nightly"), {
      operations,
      sessionId: WORKFLOW_TEST_SESSION_ID,
    });

    expect(outcome).toStrictEqual({ status: "applied" });
    expect(calls.started).toStrictEqual([
      { workflowVersionId: "version-nightly", sessionId: WORKFLOW_TEST_SESSION_ID },
    ]);
  });

  it("starts the definition found on a later page of the enumeration", async () => {
    // The whole reason the read follows the cursor: this name is unreachable from the
    // first page, and refusing it would be a refusal about a name the daemon carries.
    const calls = recordedWorkflowCalls();
    const operations = fixtureWorkflowStartOperations({
      pages: [{ definitions: [{ name: "nightly" }] }, { definitions: [{ name: "release" }] }],
      calls,
    });

    const outcome = await startWorkflowFromLine(line("/workflow start release"), {
      operations,
      sessionId: WORKFLOW_TEST_SESSION_ID,
    });

    expect(outcome).toStrictEqual({ status: "applied" });
    expect(calls.started.map((request) => request.workflowVersionId)).toStrictEqual([
      "version-release",
    ]);
  });

  it("refuses a line that named no definition, and asks for nothing", async () => {
    const calls = recordedWorkflowCalls();
    const operations = fixtureWorkflowStartOperations({
      definitions: [{ name: "nightly" }],
      calls,
    });

    const outcome = await startWorkflowFromLine(line("/workflow start"), {
      operations,
      sessionId: WORKFLOW_TEST_SESSION_ID,
    });

    expect(refusalCodeOf(outcome)).toBe("command-argument-invalid");
    expect(calls.listed).toHaveLength(0);
    expect(calls.started).toHaveLength(0);
  });

  it("refuses a verb this command does not take, naming the verb", async () => {
    const outcome = await startWorkflowFromLine(line("/workflow stop nightly"), {
      operations: fixtureWorkflowStartOperations({ definitions: [{ name: "nightly" }] }),
      sessionId: WORKFLOW_TEST_SESSION_ID,
    });

    expect(refusalCodeOf(outcome)).toBe("command-argument-invalid");
    expect(refusalDetailOf(outcome)).toContain("stop");
  });

  it("refuses a name no definition carries, and starts nothing", async () => {
    const calls = recordedWorkflowCalls();
    const operations = fixtureWorkflowStartOperations({
      definitions: [{ name: "nightly" }],
      calls,
    });

    const outcome = await startWorkflowFromLine(line("/workflow start weekly"), {
      operations,
      sessionId: WORKFLOW_TEST_SESSION_ID,
    });

    expect(refusalCodeOf(outcome)).toBe("command-argument-invalid");
    expect(calls.started).toHaveLength(0);
  });

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

  it("refuses where the composer is addressed within no session", async () => {
    const calls = recordedWorkflowCalls();
    const operations = fixtureWorkflowStartOperations({
      definitions: [{ name: "nightly" }],
      calls,
    });

    const outcome = await startWorkflowFromLine(line("/workflow start nightly"), {
      operations,
      sessionId: undefined,
    });

    expect(refusalCodeOf(outcome)).toBe("command-unavailable-here");
    expect(calls.listed).toHaveLength(0);
  });
});

/** The refusal code one outcome carried, or a loud failure if it applied. */
function refusalCodeOf(outcome: Awaited<ReturnType<typeof startWorkflowFromLine>>): string {
  if (outcome.status !== "refused") {
    throw new Error("this line must not have started a workflow");
  }
  return outcome.refusal.code;
}

/** The sentence one refusal carried, read the same guarded way. */
function refusalDetailOf(outcome: Awaited<ReturnType<typeof startWorkflowFromLine>>): string {
  if (outcome.status !== "refused") {
    throw new Error("this line must not have started a workflow");
  }
  return outcome.refusal.detail;
}
