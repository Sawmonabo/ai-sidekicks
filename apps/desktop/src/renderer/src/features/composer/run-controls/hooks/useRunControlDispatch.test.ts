// One control per run in flight at a time, decided synchronously.
//
// Two presses inside one frame both read the busy set from the render that produced their
// handler and both dispatch, minting two idempotency keys against one run version, so the latch
// cases call `dispatch` twice inside one `act` and count what reached the wire. `perform` is the
// per-case seam. Each bridge is minted once and held, because the hook keys its state on the
// bridge; only the last describe changes it deliberately.

import type { RunControlAck } from "@ai-sidekicks/contracts";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  RunControlDispatcher,
  type RunControlCalls,
  type RunControlOutcome,
} from "../services/run-control-dispatch.js";
import { useRunControlDispatch, type RunControlAdmission } from "./useRunControlDispatch.js";
import { inFlightKeyFor } from "../run-control-keys.js";
import { inertBridge } from "../../composer.test-support.js";
import {
  OTHER_RUN_ID,
  RUN_ID,
  STUB_ACK,
  appliedIntervention,
} from "../run-control-commands.test-support.js";

/** Calls no latch case reaches: each hands `dispatch` its own `perform`. */
const UNUSED_CALLS: RunControlCalls = {
  pause: () => Promise.reject(new Error("this case dispatches through its own perform")),
  resume: () => Promise.reject(new Error("this case dispatches through its own perform")),
  intervene: () => Promise.reject(new Error("this case dispatches through its own perform")),
};

const ACKNOWLEDGED: RunControlOutcome = {
  kind: "acknowledged",
  control: "interrupt",
  ack: STUB_ACK satisfies RunControlAck,
};

describe("one control per run is in flight at a time", () => {
  it("performs once and mints one key when the control is pressed twice in a tick", async () => {
    // Fails on the unlatched body: it performed twice and minted two keys.
    const mintIdempotencyKey = vi.fn(() => "6f1a0d3e-2c4b-4a7e-9f10-5b8c7d2e3a41");
    const requests: unknown[] = [];
    const calls: RunControlCalls = {
      ...UNUSED_CALLS,
      intervene: (request) => {
        requests.push(request);
        return Promise.resolve(appliedIntervention("interrupt", 5));
      },
    };
    const bridge = inertBridge();
    const { result } = renderHook(() => useRunControlDispatch(bridge, calls, mintIdempotencyKey));

    await act(async () => {
      const interrupt = (dispatcher: RunControlDispatcher): Promise<RunControlOutcome> =>
        dispatcher.interrupt({ runId: RUN_ID, expectedRunVersion: 4 });
      result.current.dispatch(RUN_ID, "interrupt", interrupt);
      result.current.dispatch(RUN_ID, "interrupt", interrupt);
    });

    expect(mintIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it("latches per run and control, so a second control on one run still performs", async () => {
    // Scope control: being inside one tick suppresses nothing, and a run's other controls are
    // not held behind the one that is going.
    const perform = vi.fn(async () => ACKNOWLEDGED);
    const bridge = inertBridge();
    const { result } = renderHook(() => useRunControlDispatch(bridge, UNUSED_CALLS));

    await act(async () => {
      result.current.dispatch(RUN_ID, "interrupt", perform);
      result.current.dispatch(RUN_ID, "pause", perform);
      result.current.dispatch(OTHER_RUN_ID, "interrupt", perform);
    });

    expect(perform).toHaveBeenCalledTimes(3);
  });

  it("releases the latch on a rejected perform and hands the rejection to the caller", async () => {
    // Without the release the control is busy for the window; without the rethrow the
    // rejection reaches nobody.
    const rejection = { code: "run.not_found", message: "no such run" };
    const perform = vi.fn((): Promise<RunControlOutcome> => Promise.reject(rejection));
    const bridge = inertBridge();
    const { result } = renderHook(() => useRunControlDispatch(bridge, UNUSED_CALLS));

    await act(async () => {
      const admission = result.current.dispatch(RUN_ID, "interrupt", perform);
      expect(admission.admitted).toBe(true);
      if (admission.admitted) {
        await expect(admission.settled).rejects.toBe(rejection);
      }
    });
    expect(result.current.records).toHaveLength(0);
    expect(result.current.inFlightKeys.has(inFlightKeyFor(RUN_ID, "interrupt"))).toBe(false);

    await act(async () => {
      const again = result.current.dispatch(RUN_ID, "interrupt", perform);
      if (again.admitted) {
        await expect(again.settled).rejects.toBe(rejection);
      }
    });
    expect(perform).toHaveBeenCalledTimes(2);
  });
});

describe("the run controls' state belongs to the bridge it dispatched through", () => {
  it("admits the same run and control at once through a replaced bridge", async () => {
    // Only the dispatcher rotated on a swap, so the held keys stayed with the gone transport
    // and a retry through the new one was refused as in flight.
    const pendingOnFirstBridge = pendingOutcome();
    const performOnSecondBridge = vi.fn(async () => ACKNOWLEDGED);
    const { result, rerender } = renderHook(
      ({ bridge }) => useRunControlDispatch(bridge, UNUSED_CALLS),
      {
        initialProps: { bridge: inertBridge() },
      },
    );

    act(() => {
      result.current.dispatch(RUN_ID, "interrupt", pendingOnFirstBridge.perform);
    });
    rerender({ bridge: inertBridge() });

    let admission: RunControlAdmission | undefined;
    await act(async () => {
      admission = result.current.dispatch(RUN_ID, "interrupt", performOnSecondBridge);
    });
    expect(admission?.admitted).toBe(true);
    expect(performOnSecondBridge).toHaveBeenCalledTimes(1);
  });
});

function pendingOutcome(): {
  perform: () => Promise<RunControlOutcome>;
  resolve: (outcome: RunControlOutcome) => void;
} {
  let settle: (outcome: RunControlOutcome) => void = () => undefined;
  const pending = new Promise<RunControlOutcome>((resolvePending) => {
    settle = resolvePending;
  });
  return {
    perform: () => pending,
    resolve: (outcome) => {
      settle(outcome);
    },
  };
}
