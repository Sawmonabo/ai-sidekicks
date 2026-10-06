// The cross-field rules a child's controls answer with: a lost hold never reads as paused, and
// only a failed stop carries a reason.
import { describe, expect, it } from "vitest";

import { ChildPauseSetResponseSchema, ChildrenStopResponseSchema } from "../children.js";

const RUN_ID = "0f2b4d5e-6666-4666-8666-666666666666";
const AGENT_ID = "0f2b4d5e-3333-4333-8333-333333333333";

describe("a child's controls", () => {
  it("reports a lost hold as a result that leaves the child not paused", () => {
    expect(
      ChildPauseSetResponseSchema.safeParse({
        childHandle: "task-7",
        paused: false,
        holdLost: true,
      }).success,
    ).toBe(true);
    expect(
      ChildPauseSetResponseSchema.safeParse({ childHandle: "task-7", paused: true, holdLost: true })
        .success,
    ).toBe(false);
  });
});

describe("run.childrenStop", () => {
  const provider = { kind: "providerChild", runId: RUN_ID, childHandle: "task-7" };
  const bridged = { kind: "agent", agentId: AGENT_ID };

  it("reports each child's own outcome, a failure with its reason", () => {
    const response = {
      children: [
        { child: provider, outcome: "stopped" },
        { child: bridged, outcome: "failed", reason: "The provider did not answer the stop." },
      ],
    };
    expect(ChildrenStopResponseSchema.safeParse(response).success).toBe(true);
  });

  it("refuses a failure with no reason and a reason on a stop that did not fail", () => {
    expect(
      ChildrenStopResponseSchema.safeParse({ children: [{ child: provider, outcome: "failed" }] })
        .success,
    ).toBe(false);
    expect(
      ChildrenStopResponseSchema.safeParse({
        children: [{ child: provider, outcome: "stopped", reason: "done" }],
      }).success,
    ).toBe(false);
  });
});
