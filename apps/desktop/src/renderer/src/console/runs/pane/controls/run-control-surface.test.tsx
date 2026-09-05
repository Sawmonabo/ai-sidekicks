// One control per run in flight at a time, decided synchronously.
//
// The failure this file pins is a tick, not a render: two presses inside one frame
// both read the busy set from the render that produced their handler, so both find
// it empty and both dispatch. Two dispatches mint two idempotency keys against one
// run version, which makes them two distinct mutations rather than replays of one,
// and the loser's stale refusal can become the visible settlement. Every case here
// therefore calls `dispatch` twice inside ONE `act` and counts what reached the
// wire, rather than asserting on what the row rendered afterwards.
//
// The cases drive the real hook. What is supplied per case is `perform`, because
// that is the seam the surface settles on: the canned outcomes below stand in for a
// dispatcher answer, and the two arms that matter — a settlement and a rejection —
// are both driven through it.
//
// EVERY BRIDGE HERE IS MINTED ONCE AND HELD. The surface keys its records, its busy
// set and its latch on the bridge, so a stub rebuilt inside the hook callback would
// be a different transport on every render — which is a fact about the double, not
// about the surface. The last describe is the one that changes it deliberately.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { readRunId } from "../../../bridge/index.js";
import { RunControlDispatcher, type RunControlOutcome } from "./run-control-dispatch.js";
import {
  inFlightKeyFor,
  useRunControlSurface,
  type RunControlAdmission,
} from "./run-control-surface.js";
import { bridgeAnswering } from "../../../bridge/fixture-bridge.test-support.js";
import { OTHER_RUN_ID, RUN_ID } from "../runs-pane.test-support.js";

/**
 * The shipped fixture with a call arm that answers nothing readable.
 *
 * Most cases here never look at what was asked — the claims are about the surface's
 * latch — so the record goes unread rather than being threaded through an array each
 * one would have to declare. The one case that DOES assert on it destructures
 * `bridgeAnswering`'s own `calls` instead.
 *
 * A fresh bridge per call, which the re-render cases depend on: the surface keys its
 * holders on the bridge, so "a different transport" is spelled by handing them one.
 */
function answeringNothing(): ConsoleBridge {
  return bridgeAnswering(async () => undefined).bridge;
}

/** The branded identifier the registered acknowledgment carries, read once. */
const ACKNOWLEDGED_RUN_ID = readRunId(RUN_ID);
if (ACKNOWLEDGED_RUN_ID === undefined) {
  throw new Error("the acknowledgment fixture names a run identifier the wire refuses");
}

/**
 * A settlement the surface can record without the wire being involved.
 *
 * Parsed through the registered acknowledgment schema rather than cast, so the canned
 * answer is one the daemon could have sent.
 */
const ACKNOWLEDGED: RunControlOutcome = {
  kind: "acknowledged",
  control: "interrupt",
  ack: { runId: ACKNOWLEDGED_RUN_ID, currentState: "paused", runVersion: 7 },
};

describe("one control per run is in flight at a time", () => {
  it("performs once and mints one key when the control is pressed twice in a tick", async () => {
    // The claim that fails on the unlatched body: it performed twice and minted two
    // keys, so the daemon saw two distinct mutations rather than one replayed.
    const mintIdempotencyKey = vi.fn(() => "6f1a0d3e-2c4b-4a7e-9f10-5b8c7d2e3a41");
    const { bridge, calls } = bridgeAnswering(async () => undefined);
    const { result } = renderHook(() => useRunControlSurface(bridge, mintIdempotencyKey));

    await act(async () => {
      const interrupt = (dispatcher: RunControlDispatcher): Promise<RunControlOutcome> =>
        dispatcher.interrupt({ runId: RUN_ID, expectedRunVersion: 4 });
      result.current.dispatch(RUN_ID, "interrupt", interrupt);
      result.current.dispatch(RUN_ID, "interrupt", interrupt);
    });

    expect(mintIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it("latches per run and control, so a second control on one run still performs", async () => {
    // The scope control for the case above: nothing about being inside one tick
    // suppresses a dispatch, and a run's other controls are not held behind the
    // one that is going.
    const perform = vi.fn(async () => ACKNOWLEDGED);
    const bridge = answeringNothing();
    const { result } = renderHook(() => useRunControlSurface(bridge));

    await act(async () => {
      result.current.dispatch(RUN_ID, "interrupt", perform);
      result.current.dispatch(RUN_ID, "cancel", perform);
      result.current.dispatch(OTHER_RUN_ID, "interrupt", perform);
    });

    expect(perform).toHaveBeenCalledTimes(3);
  });

  it("marks the pressed control busy and clears it on settlement", async () => {
    const settleWith = pendingOutcome();
    const bridge = answeringNothing();
    const { result } = renderHook(() => useRunControlSurface(bridge));

    act(() => {
      result.current.dispatch(RUN_ID, "interrupt", settleWith.perform);
    });
    expect(result.current.inFlightKeys.has(inFlightKeyFor(RUN_ID, "interrupt"))).toBe(true);

    await act(async () => {
      settleWith.resolve(ACKNOWLEDGED);
    });
    expect(result.current.inFlightKeys.has(inFlightKeyFor(RUN_ID, "interrupt"))).toBe(false);
  });

  it("releases the latch on a refusal, so the control can be pressed again", async () => {
    const perform = vi.fn(
      async (): Promise<RunControlOutcome> => ({
        kind: "refused",
        control: "interrupt",
        refusal: {
          origin: "run-controls",
          code: "run.invalid_transition",
          detail: "the run is not running",
        },
      }),
    );
    const bridge = answeringNothing();
    const { result } = renderHook(() => useRunControlSurface(bridge));

    await act(async () => {
      result.current.dispatch(RUN_ID, "interrupt", perform);
    });
    await act(async () => {
      result.current.dispatch(RUN_ID, "interrupt", perform);
    });

    expect(perform).toHaveBeenCalledTimes(2);
    expect(result.current.records).toHaveLength(2);
  });

  it("releases the latch on a rejected perform and records the rejection", async () => {
    // Without the rejection arm this control is busy for the rest of the window and
    // the rejection reaches no surface at all.
    const perform = vi.fn(
      async (): Promise<RunControlOutcome> =>
        Promise.reject({ code: "run.not_found", message: "no such run" }),
    );
    const bridge = answeringNothing();
    const { result } = renderHook(() => useRunControlSurface(bridge));

    await act(async () => {
      result.current.dispatch(RUN_ID, "interrupt", perform);
    });
    const [recorded] = result.current.records;
    expect(recorded?.outcome.kind).toBe("refused");
    expect(recorded?.outcome.kind === "refused" ? recorded.outcome.refusal.code : undefined).toBe(
      "run.not_found",
    );
    expect(result.current.inFlightKeys.has(inFlightKeyFor(RUN_ID, "interrupt"))).toBe(false);

    await act(async () => {
      result.current.dispatch(RUN_ID, "interrupt", perform);
    });
    expect(perform).toHaveBeenCalledTimes(2);
  });

  it("releases the latch on a perform that throws before it returns a promise", async () => {
    const perform = vi.fn((): Promise<RunControlOutcome> => {
      throw { code: "run.not_found", message: "no such run" };
    });
    const bridge = answeringNothing();
    const { result } = renderHook(() => useRunControlSurface(bridge));

    await act(async () => {
      result.current.dispatch(RUN_ID, "interrupt", perform);
    });
    await act(async () => {
      result.current.dispatch(RUN_ID, "interrupt", perform);
    });

    expect(perform).toHaveBeenCalledTimes(2);
    expect(result.current.records).toHaveLength(2);
  });
});

describe("the surface belongs to the bridge it dispatched through", () => {
  it("admits the same run and control at once through a replaced bridge", async () => {
    // The finding: only the dispatcher rotated on a swap. The held keys stayed with
    // the transport that was gone, so a retry through the new one was refused as
    // already in flight — until the old call settled, and forever where it never did.
    const pendingOnFirstBridge = pendingOutcome();
    const performOnSecondBridge = vi.fn(async () => ACKNOWLEDGED);
    const { result, rerender } = renderHook(({ bridge }) => useRunControlSurface(bridge), {
      initialProps: { bridge: answeringNothing() },
    });

    act(() => {
      result.current.dispatch(RUN_ID, "interrupt", pendingOnFirstBridge.perform);
    });
    rerender({ bridge: answeringNothing() });

    let admission: RunControlAdmission | undefined;
    await act(async () => {
      admission = result.current.dispatch(RUN_ID, "interrupt", performOnSecondBridge);
    });
    expect(admission?.admitted).toBe(true);
    expect(performOnSecondBridge).toHaveBeenCalledTimes(1);
  });

  it("shows the replaced bridge an empty surface rather than the previous one's", () => {
    // The busy set and the records are the other two holders. A row rendered under
    // the new transport would otherwise be marked busy by a call that transport
    // never made.
    const pendingOnFirstBridge = pendingOutcome();
    const { result, rerender } = renderHook(({ bridge }) => useRunControlSurface(bridge), {
      initialProps: { bridge: answeringNothing() },
    });

    act(() => {
      result.current.dispatch(RUN_ID, "interrupt", pendingOnFirstBridge.perform);
    });
    expect(result.current.inFlightKeys.has(inFlightKeyFor(RUN_ID, "interrupt"))).toBe(true);

    rerender({ bridge: answeringNothing() });

    expect(result.current.inFlightKeys.size).toBe(0);
    expect(result.current.records).toHaveLength(0);
  });

  it("appends nothing when a call made on the previous bridge settles late", async () => {
    const pendingOnFirstBridge = pendingOutcome();
    const { result, rerender } = renderHook(({ bridge }) => useRunControlSurface(bridge), {
      initialProps: { bridge: answeringNothing() },
    });

    act(() => {
      result.current.dispatch(RUN_ID, "interrupt", pendingOnFirstBridge.perform);
    });
    rerender({ bridge: answeringNothing() });
    await act(async () => {
      pendingOnFirstBridge.resolve(ACKNOWLEDGED);
    });

    expect(result.current.records).toHaveLength(0);
  });

  it("negative control: a settlement on the bridge that is still current is recorded", async () => {
    // Without this, a surface that had simply stopped recording anything would pass
    // every case above.
    const pending = pendingOutcome();
    const { result } = renderHook(({ bridge }) => useRunControlSurface(bridge), {
      initialProps: { bridge: answeringNothing() },
    });

    act(() => {
      result.current.dispatch(RUN_ID, "interrupt", pending.perform);
    });
    await act(async () => {
      pending.resolve(ACKNOWLEDGED);
    });

    expect(result.current.records).toHaveLength(1);
    expect(result.current.inFlightKeys.size).toBe(0);
  });

  it("negative control: one bridge still refuses the same run and control twice", async () => {
    // The rule the rotation must not be read as relaxing: a second press on the
    // transport that is still current is the same act, and is refused.
    const pending = pendingOutcome();
    const { result } = renderHook(({ bridge }) => useRunControlSurface(bridge), {
      initialProps: { bridge: answeringNothing() },
    });

    let second: RunControlAdmission | undefined;
    await act(async () => {
      result.current.dispatch(RUN_ID, "interrupt", pending.perform);
      second = result.current.dispatch(RUN_ID, "interrupt", pending.perform);
    });

    expect(second).toStrictEqual({ admitted: false, reason: "in-flight" });
    await act(async () => {
      pending.resolve(ACKNOWLEDGED);
    });
  });
});

/** A `perform` whose settlement the case decides, so busy state is observable. */
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
