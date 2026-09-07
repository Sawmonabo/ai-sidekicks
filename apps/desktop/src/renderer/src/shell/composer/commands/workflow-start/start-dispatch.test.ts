// What the accelerator sends, and what it refuses to send.
//
// `Spec-017 §Chat-start surface (SA-38)`: "A start issued from a channel carries the
// originating channel as an additive-optional `channelId` on `WorkflowRunStartRequest`
// — provenance and progress-surface binding only." The composer already knows which
// channel it is addressed within, so the field travels from that address; these cases
// hold both halves of it, since a `channelId` sent from a composer that is NOT
// addressed at a channel would be provenance the console invented.
//
// Every refusal below names what was typed rather than what a daemon said, because on
// each of those paths nothing was asked — and the one arm that DOES reach the daemon
// carries the daemon's own refusal through untouched.

import { describe, expect, it } from "vitest";

import type { DirectiveLine } from "../../router/command-executor.js";
import { startWorkflowFromLine } from "./start-dispatch.js";
import {
  fixtureGrowthPort,
  recordedWorkflowCalls,
  WORKFLOW_TEST_SESSION_ID,
} from "./workflow-start.test-support.js";

const CHANNEL_ID = "channel-nightly-standup";

/** One line as the router hands it over. */
function line(text: string): DirectiveLine {
  return { commandName: "workflow", text };
}

describe("startWorkflowFromLine", () => {
  it("carries the originating channel on a start typed into a channel composer", async () => {
    const calls = recordedWorkflowCalls();
    const growth = fixtureGrowthPort({ definitions: [{ name: "nightly" }], calls });

    const outcome = await startWorkflowFromLine(line("/workflow start nightly"), {
      growth,
      sessionId: WORKFLOW_TEST_SESSION_ID,
      channelId: CHANNEL_ID,
    });

    expect(outcome).toStrictEqual({ status: "applied" });
    expect(calls.started).toStrictEqual([
      {
        workflowVersionId: "version-nightly",
        sessionId: WORKFLOW_TEST_SESSION_ID,
        channelId: CHANNEL_ID,
      },
    ]);
  });

  it("negative control: a start from a composer addressed at no channel carries none", async () => {
    // The member is additive-OPTIONAL, and an absent channel is absent rather than
    // empty: a `channelId` this module composed would be provenance nobody supplied.
    const calls = recordedWorkflowCalls();
    const growth = fixtureGrowthPort({ definitions: [{ name: "nightly" }], calls });

    await startWorkflowFromLine(line("/workflow start nightly"), {
      growth,
      sessionId: WORKFLOW_TEST_SESSION_ID,
      channelId: undefined,
    });

    expect(calls.started).toStrictEqual([
      { workflowVersionId: "version-nightly", sessionId: WORKFLOW_TEST_SESSION_ID },
    ]);
    expect(calls.started[0]).not.toHaveProperty("channelId");
  });

  it("starts the definition found on a later page of the enumeration", async () => {
    // The whole reason the read follows the cursor: this name is unreachable from the
    // first page, and refusing it would be a refusal about a name the daemon carries.
    const calls = recordedWorkflowCalls();
    const growth = fixtureGrowthPort({
      pages: [{ definitions: [{ name: "nightly" }] }, { definitions: [{ name: "release" }] }],
      calls,
    });

    const outcome = await startWorkflowFromLine(line("/workflow start release"), {
      growth,
      sessionId: WORKFLOW_TEST_SESSION_ID,
      channelId: undefined,
    });

    expect(outcome).toStrictEqual({ status: "applied" });
    expect(calls.started.map((request) => request.workflowVersionId)).toStrictEqual([
      "version-release",
    ]);
  });

  it("refuses a line that named no definition, and asks for nothing", async () => {
    const calls = recordedWorkflowCalls();
    const growth = fixtureGrowthPort({ definitions: [{ name: "nightly" }], calls });

    const outcome = await startWorkflowFromLine(line("/workflow start"), {
      growth,
      sessionId: WORKFLOW_TEST_SESSION_ID,
      channelId: undefined,
    });

    expect(refusalCodeOf(outcome)).toBe("command-argument-invalid");
    expect(calls.listed).toHaveLength(0);
    expect(calls.started).toHaveLength(0);
  });

  it("refuses a verb this command does not take, naming the verb", async () => {
    const outcome = await startWorkflowFromLine(line("/workflow stop nightly"), {
      growth: fixtureGrowthPort({ definitions: [{ name: "nightly" }] }),
      sessionId: WORKFLOW_TEST_SESSION_ID,
      channelId: undefined,
    });

    expect(refusalCodeOf(outcome)).toBe("command-argument-invalid");
    expect(refusalDetailOf(outcome)).toContain("stop");
  });

  it("refuses a name no definition carries, and starts nothing", async () => {
    const calls = recordedWorkflowCalls();
    const growth = fixtureGrowthPort({ definitions: [{ name: "nightly" }], calls });

    const outcome = await startWorkflowFromLine(line("/workflow start weekly"), {
      growth,
      sessionId: WORKFLOW_TEST_SESSION_ID,
      channelId: undefined,
    });

    expect(refusalCodeOf(outcome)).toBe("command-argument-invalid");
    expect(calls.started).toHaveLength(0);
  });

  it("refuses to choose between two definitions of one name", async () => {
    const calls = recordedWorkflowCalls();
    const growth = fixtureGrowthPort({
      definitions: [
        { name: "nightly" },
        { name: "nightly", latestWorkflowVersionId: "version-nightly-other" },
      ],
      calls,
    });

    const outcome = await startWorkflowFromLine(line("/workflow start nightly"), {
      growth,
      sessionId: WORKFLOW_TEST_SESSION_ID,
      channelId: undefined,
    });

    expect(refusalDetailOf(outcome)).toContain("2 workflows");
    expect(calls.started).toHaveLength(0);
  });

  it("refuses where the composer is addressed within no session", async () => {
    const calls = recordedWorkflowCalls();
    const growth = fixtureGrowthPort({ definitions: [{ name: "nightly" }], calls });

    const outcome = await startWorkflowFromLine(line("/workflow start nightly"), {
      growth,
      sessionId: undefined,
      channelId: undefined,
    });

    expect(refusalCodeOf(outcome)).toBe("command-unavailable-here");
    expect(calls.listed).toHaveLength(0);
  });

  it("carries the daemon's own refusal of the start, rather than re-wording it", async () => {
    // `workflow.start_denied` is the refusal this path exists to surface: it reaches
    // the composer as the port's own value, with its own code and sentence.
    const outcome = await startWorkflowFromLine(line("/workflow start nightly"), {
      growth: fixtureGrowthPort({ definitions: [{ name: "nightly" }], startRefuses: true }),
      sessionId: WORKFLOW_TEST_SESSION_ID,
      channelId: undefined,
    });

    expect(refusalCodeOf(outcome)).toBe("wire-unregistered");
  });

  it("carries a refused enumeration rather than reporting no such workflow", async () => {
    const outcome = await startWorkflowFromLine(line("/workflow start nightly"), {
      growth: fixtureGrowthPort({ pages: [{ refuses: true }] }),
      sessionId: WORKFLOW_TEST_SESSION_ID,
      channelId: undefined,
    });

    expect(refusalCodeOf(outcome)).toBe("wire-unregistered");
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
