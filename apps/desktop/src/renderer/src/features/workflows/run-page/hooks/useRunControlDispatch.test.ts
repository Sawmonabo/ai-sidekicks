// The run controls' dispatch: a press puts the run and the person's reason on the call, one act
// per run and action is in flight, an answer lands only on the run that asked, and a rejected call
// gives its key back.

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

describe("a press reaches the calls", () => {
  it("sends the run and the person's reason on the request the operation declares", async () => {
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel("superseded");
    });
    expect(held.requests).toStrictEqual([{ workflowRunId: RUN_A, reason: "superseded" }]);
  });

  it("carries the chosen re-pin as the resume request's optional member", async () => {
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, RUN_A);
    await act(async () => {
      controls.latest().resume.resume({ targetWorkflowVersionId: "wfv-02" });
    });
    expect(held.resumeRequests).toStrictEqual([
      { workflowRunId: RUN_A, versionRepin: { targetWorkflowVersionId: "wfv-02" } },
    ]);
  });
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

  it("gives the key back when the call rejects, and advances no round", async () => {
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
    // Run A's answer lands nowhere: settling it under run B would tell the person that the
    // run in front of them had been canceled when it had not.
    expect(controls.latest().cancel.outcome.kind).toBe("idle");
    expect(controls.latest().servedActCount).toBe(0);
  });
});
