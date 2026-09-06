// One act at a time, about the run in front of the operator, and a re-read only when
// one of them changed something.
//
// SEPARATE FROM `run-control-dispatch.test.tsx` BECAUSE THE SUBJECT IS DIFFERENT. That
// file is about whether a press composes and arrives; every case here holds the call
// still and varies the TIMING or the ADDRESS — a second press while one is outstanding,
// an answer landing after the pane was retargeted, the round a served act advances.
//
// EACH GROUP RULES OUT A DIFFERENT SILENT FAILURE. A rendered `dispatching` flag read
// inside a press handler is the value from the render that produced the handler, so
// two presses in one frame both find the control idle and the daemon takes two
// cancellations for one intended act. An answer installed without regard for the
// address settles run A's cancellation under run B. And a round advanced by anything
// but a served act is the beginning of a refresh cadence this read forbids.
//
// WHICH IS WHY THE FIRST CASE PRESSES INSIDE ONE `act` AND FROM ONE CAPTURED CONTROL.
// The distinction being tested lives entirely inside a single frame: across two `act`
// scopes a rendered flag and a dispatch-time latch behave identically, so a case
// written that way passes over the very implementation it exists to reject.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { type GrowthPort } from "../../../bridge/index.js";
import { createRefusingGrowthPort } from "../../../bridge/growth-port/growth-port.js";
import {
  RUN_A,
  RUN_B,
  heldCancelPort,
  observeControls,
} from "./run-control-dispatch.test-support.js";
import { settle } from "../../WorkflowsBrowser.test-support.js";

afterEach(() => {
  cleanup();
});

describe("one act per run and action is in flight, and a second press is told so", () => {
  it("refuses the second press instead of dispatching it", async () => {
    const port = heldCancelPort();
    const controls = observeControls(port.growth, RUN_A);
    // ONE CAPTURED CONTROL, PRESSED TWICE INSIDE ONE `act`, which is the whole subject.
    // Two presses in two `act` scopes are two frames: the second reads a control the
    // first press has already re-rendered, so a rendered `dispatching` flag refuses it
    // exactly as the latch does and the case cannot tell the two apart. Held still,
    // this is the frame a flag cannot see — both handlers are the ones the first render
    // produced, both would read `dispatching: false`, and only a latch claimed at
    // dispatch stops the second call.
    const pressed = controls.latest().cancel;
    await act(async () => {
      pressed.cancel(undefined);
      pressed.cancel(undefined);
    });
    // One call, not two: the daemon would otherwise take two cancellations for one
    // intended act.
    expect(port.requests).toHaveLength(1);
    const { outcome } = controls.latest().cancel;
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") {
      throw new Error("the second press was not refused");
    }
    expect(outcome.refusal.code).toBe("act-already-in-flight");
  });

  it("frees the key once the first act settles, so the next press dispatches", async () => {
    const port = heldCancelPort();
    const controls = observeControls(port.growth, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    await act(async () => {
      port.serve();
    });
    await settle();
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    expect(port.requests).toHaveLength(2);
  });

  it("negative control: an outstanding cancel does not refuse a resume", async () => {
    // The two controls are separately grantable and separately in flight. A single key
    // for the run would make an outstanding cancel look like a reason to refuse the
    // other act entirely.
    const resumeRequests: Parameters<GrowthPort["workflowRunResume"]>[0][] = [];
    const port = heldCancelPort();
    const growth: GrowthPort = {
      ...port.growth,
      workflowRunResume: async (request) => {
        resumeRequests.push(request);
        return { status: "served", value: { workflowRunId: RUN_A, state: "running" } };
      },
    };
    const controls = observeControls(growth, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    await act(async () => {
      controls.latest().resume.resume(undefined);
    });
    expect(resumeRequests).toHaveLength(1);
  });
});

describe("an answer is about the run that asked", () => {
  it("drops an in-flight act when the pane is retargeted in place", async () => {
    const port = heldCancelPort();
    const controls = observeControls(port.growth, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });

    controls.retarget(RUN_B);
    // The new run starts clean rather than inheriting the previous one's dispatch.
    expect(controls.latest().cancel.outcome.kind).toBe("idle");

    await act(async () => {
      port.serve();
    });
    await settle();
    // And run A's answer lands nowhere: settling it under run B would tell an operator
    // that the run in front of them had been cancelled when it had not.
    expect(controls.latest().cancel.outcome.kind).toBe("idle");
    expect(controls.latest().servedActCount).toBe(0);
  });

  it("lets the newly addressed run be cancelled while the old one's act is outstanding", async () => {
    // The run belongs in the single-flight key, not just the action. Without it, run A's
    // outstanding cancel would refuse run B's FIRST press — a pane that retargets in
    // place would offer a control the operator cannot use, for a reason about a run
    // that is no longer on screen.
    const port = heldCancelPort();
    const controls = observeControls(port.growth, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    controls.retarget(RUN_B);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    expect(port.requests).toStrictEqual([{ workflowRunId: RUN_A }, { workflowRunId: RUN_B }]);
  });

  it("negative control: without a retarget the same act settles on the control", async () => {
    // Without this the case above would be satisfied by a dispatcher whose settlements
    // never installed at all.
    const port = heldCancelPort();
    const controls = observeControls(port.growth, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    await act(async () => {
      port.serve();
    });
    await settle();
    expect(controls.latest().cancel.outcome.kind).toBe("settled");
  });
});

describe("the run read's round advances for served acts and for nothing else", () => {
  it("advances once per served act", async () => {
    const port = heldCancelPort();
    const controls = observeControls(port.growth, RUN_A);
    expect(controls.latest().servedActCount).toBe(0);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    await act(async () => {
      port.serve();
    });
    await settle();
    expect(controls.latest().servedActCount).toBe(1);
  });

  it("negative control: a refused act advances no round", async () => {
    // The re-arm exists because a served act CHANGED the run. A refused one changed
    // nothing, so re-reading after it would be a read nobody's act justified — the
    // first step towards a cadence.
    const controls = observeControls(createRefusingGrowthPort(), RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    await settle();
    expect(controls.latest().cancel.outcome.kind).toBe("refused");
    expect(controls.latest().servedActCount).toBe(0);
  });
});
