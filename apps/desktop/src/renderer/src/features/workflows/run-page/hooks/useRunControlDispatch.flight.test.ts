// Single flight and addressing for the run controls: a second press while one is outstanding,
// an answer landing after a retarget, and the round a served act advances. Every case holds
// the call still and varies timing or address; `useRunControlDispatch.test.ts` covers whether
// a press composes and arrives.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { unhandledRejectionsDuring } from "@test/helpers/unhandled-rejection.js";
import {
  CANCEL_FAILURE,
  RUN_A,
  RUN_B,
  heldCancelCalls,
  observeControls,
  rejectingCancelCalls,
} from "./useRunControlDispatch.test-support.js";
import { settle } from "../../workflows-probe.test-support.js";

afterEach(() => {
  cleanup();
});

describe("one act per run and action is in flight, and a second press is told so", () => {
  it("refuses the second press instead of dispatching it", async () => {
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, RUN_A);
    // One captured control pressed twice inside one `act`: across two `act` scopes a rendered
    // `dispatching` flag refuses the second press just as the latch does, so only a single
    // frame tells them apart. Both handlers read `dispatching: false`; only a latch claimed at
    // dispatch stops the second call.
    const pressed = controls.latest().cancel;
    await act(async () => {
      pressed.cancel(undefined);
      pressed.cancel(undefined);
    });
    // One call, not two: the daemon would otherwise take two cancellations for one act.
    expect(held.requests).toHaveLength(1);
    const { outcome } = controls.latest().cancel;
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") {
      throw new Error("the second press was not refused");
    }
    expect(outcome.refusal.code).toBe("act-already-in-flight");
  });

  it("frees the key once the first act settles, so the next press dispatches", async () => {
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    await act(async () => {
      held.serve();
    });
    await settle();
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    expect(held.requests).toHaveLength(2);
  });

  it("negative control: an outstanding cancel does not refuse a resume", async () => {
    // The two controls are separately grantable and separately in flight, so a per-run key
    // would let an outstanding cancel refuse the resume.
    // other act entirely.
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    await act(async () => {
      controls.latest().resume.resume(undefined);
    });
    expect(held.resumeRequests).toHaveLength(1);
  });
});

describe("an answer is about the run that asked", () => {
  it("drops an in-flight act when the pane is retargeted in place", async () => {
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });

    controls.retarget(RUN_B);
    // The new run starts clean rather than inheriting the previous one's dispatch.
    expect(controls.latest().cancel.outcome.kind).toBe("idle");

    await act(async () => {
      held.serve();
    });
    await settle();
    // Run A's answer lands nowhere: settling it under run B would tell an operator that the
    // run in front of them had been canceled when it had not.
    expect(controls.latest().cancel.outcome.kind).toBe("idle");
    expect(controls.latest().servedActCount).toBe(0);
  });

  it("lets the newly addressed run be canceled while the old one's act is outstanding", async () => {
    // The run belongs in the single-flight key, not just the action: otherwise run A's
    // outstanding cancel would refuse run B's first press after an in-place retarget.
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    controls.retarget(RUN_B);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    expect(held.requests).toStrictEqual([{ workflowRunId: RUN_A }, { workflowRunId: RUN_B }]);
  });

  it("negative control: without a retarget the same act settles on the control", async () => {
    // Without this the case above would be satisfied by a dispatcher that never installed
    // a settlement.
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    await act(async () => {
      held.serve();
    });
    await settle();
    expect(controls.latest().cancel.outcome.kind).toBe("settled");
  });
});

describe("the run read's round advances for served acts and for nothing else", () => {
  it("advances once per served act", async () => {
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, RUN_A);
    expect(controls.latest().servedActCount).toBe(0);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    await act(async () => {
      held.serve();
    });
    await settle();
    expect(controls.latest().servedActCount).toBe(1);
  });

  it("negative control: a refused press advances no round", async () => {
    // A served act changed the run; a refused press changed nothing, so re-reading after it
    // would be a read nobody's act justified.
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, RUN_A);
    const pressed = controls.latest().cancel;
    await act(async () => {
      pressed.cancel(undefined);
      pressed.cancel(undefined);
    });
    expect(controls.latest().cancel.outcome.kind).toBe("refused");
    expect(controls.latest().servedActCount).toBe(0);
  });

  it("advances the same round for an act recorded outside the controls", async () => {
    // A submission the daemon recorded moves the run as a served cancel does, so it advances
    // the one count rather than a second number.
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    await act(async () => {
      controls.latest().recordServedAct();
    });
    expect(controls.latest().servedActCount).toBe(1);
    // An act performed elsewhere answers neither control here.
    expect(controls.latest().cancel.outcome.kind).toBe("dispatching");
    expect(controls.latest().resume.outcome.kind).toBe("idle");

    await act(async () => {
      held.serve();
    });
    await settle();
    expect(controls.latest().servedActCount).toBe(2);
  });

  it("negative control: a call that rejects advances no round and frees the key", async () => {
    // No reply was served, so no read is owed; the key must go back or every later press
    // would be refused as a duplicate.
    const failing = rejectingCancelCalls();
    const controls = observeControls(failing.calls, RUN_A);
    // The dispatcher does not catch the rejection, so the runner reports it; the witness
    // reads that report instead of letting it fail the run.
    const escaped = await unhandledRejectionsDuring(async () => {
      await act(async () => {
        controls.latest().cancel.cancel(undefined);
      });
      await act(async () => {
        controls.latest().cancel.cancel(undefined);
      });
    });
    expect(escaped).toStrictEqual([CANCEL_FAILURE, CANCEL_FAILURE]);
    expect(failing.requests).toHaveLength(2);
    expect(controls.latest().servedActCount).toBe(0);
  });
});
