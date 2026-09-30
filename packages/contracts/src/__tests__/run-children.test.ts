// A child's own controls: each accepts the call a child's view makes and refuses invalid ones.
import { describe, expect, it } from "vitest";

import {
  ChildInterruptRequestSchema,
  ChildInterruptResponseSchema,
  ChildPauseSetRequestSchema,
  ChildPauseSetResponseSchema,
  ChildrenStopResponseSchema,
  ChildSteerRequestSchema,
  RunChildControlRefusedDetailsSchema,
} from "../run-children.js";

const RUN_ID = "0f2b4d5e-6666-4666-8666-666666666666";
const IDEMPOTENCY_KEY = "0f2b4d5e-9999-4999-8999-999999999999";
const AGENT_ID = "0f2b4d5e-3333-4333-8333-333333333333";

const control = {
  targetRunId: RUN_ID,
  childHandle: "task-7",
  expectedRunVersion: 4,
  clientIdempotencyKey: IDEMPOTENCY_KEY,
};

describe("a child's controls", () => {
  it("steers, interrupts and pauses one named child under the parent run's guards", () => {
    expect(
      ChildSteerRequestSchema.safeParse({ ...control, content: "Skip the docs" }).success,
    ).toBe(true);
    expect(ChildInterruptRequestSchema.safeParse(control).success).toBe(true);
    expect(ChildPauseSetRequestSchema.safeParse({ ...control, paused: true }).success).toBe(true);
  });

  it("refuses a control that names no child or omits the parent run's comparand", () => {
    const { childHandle: _handle, ...withoutChild } = control;
    expect(ChildInterruptRequestSchema.safeParse(withoutChild).success).toBe(false);
    const { expectedRunVersion: _version, ...withoutComparand } = control;
    expect(
      ChildSteerRequestSchema.safeParse({ ...withoutComparand, content: "Skip the docs" }).success,
    ).toBe(false);
  });

  it("answers an interrupt with where the child stands, a finished child with its finished state", () => {
    expect(
      ChildInterruptResponseSchema.safeParse({ childHandle: "task-7", state: "completed" }).success,
    ).toBe(true);
    expect(
      ChildInterruptResponseSchema.safeParse({ childHandle: "task-7", state: "already_ended" })
        .success,
    ).toBe(false);
  });

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

  it("names why a child control was refused", () => {
    for (const reason of ["child_unknown", "child_ended", "provider_refused"]) {
      expect(RunChildControlRefusedDetailsSchema.safeParse({ reason }).success).toBe(true);
    }
    expect(RunChildControlRefusedDetailsSchema.safeParse({ reason: "hold_lost" }).success).toBe(
      false,
    );
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
