// A press puts the run and the operator's reason on the calls, and a served answer settles the
// control. Timing and address are in `useRunControlDispatch.flight.test.ts`; both share
// `useRunControlDispatch.test-support.tsx`.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RUN_A, heldCancelCalls, observeControls } from "./useRunControlDispatch.test-support.js";
import { settle } from "../../workflows-probe.test-support.js";

afterEach(() => {
  cleanup();
});

describe("a press reaches the calls", () => {
  it("sends the run and the operator's reason on the request the operation declares", async () => {
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel("superseded");
    });
    expect(held.requests).toStrictEqual([{ workflowRunId: RUN_A, reason: "superseded" }]);
  });

  it("omits the reason key entirely when the operator gave none", async () => {
    // Not `reason: undefined`: the member is optional under `exactOptionalPropertyTypes`, and
    // a key carrying nothing is a different request from one without the key.
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    expect(held.requests).toStrictEqual([{ workflowRunId: RUN_A }]);
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

  it("negative control: a pane naming no run puts nothing on the calls", async () => {
    // Both requests need a run id; a fabricated one would ask about a run that does not exist.
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, undefined);
    await act(async () => {
      controls.latest().cancel.cancel("superseded");
    });
    expect(held.requests).toStrictEqual([]);
    expect(controls.latest().cancel.outcome.kind).toBe("idle");
  });
});

describe("a served answer settles the control", () => {
  it("settles on the settled arm with the wire word verbatim", async () => {
    const held = heldCancelCalls();
    const controls = observeControls(held.calls, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    await act(async () => {
      held.serve();
    });
    await settle();
    const { outcome } = controls.latest().cancel;
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") {
      throw new Error("the cancel control settled on the wrong arm");
    }
    // The wire word verbatim, so the settlement and the run agree on one string.
    expect(outcome.runState).toBe("canceled");
  });
});
