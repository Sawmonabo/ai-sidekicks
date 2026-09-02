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

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunControlAckSchema } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../bridge/index.js";
import { RunControlDispatcher, type RunControlOutcome } from "./run-control-dispatch.js";
import { inFlightKeyFor, useRunControlSurface } from "./run-control-surface.js";

/** A canonical UUID: `RunIdSchema` is a branded UUID and refuses anything else. */
const RUN_ID = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
const OTHER_RUN_ID = "c4e1b2d3-5f60-4071-9b82-0d3e4f506172";

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

/** A bridge that records what it was asked and answers nothing readable. */
function recordingBridge(calls: RecordedCall[]): ConsoleBridge {
  return {
    sidekicks: {
      daemon: {
        call: async (method: string, params: unknown): Promise<unknown> => {
          calls.push({ method, params });
          return undefined;
        },
        subscribe: () => () => undefined,
      },
    },
    growth: {},
    source: "fixture",
    scenarioEngine: undefined,
  } as unknown as ConsoleBridge;
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
  ack: RunControlAckSchema.parse({ runId: RUN_ID, currentState: "paused", runVersion: 7 }),
};

describe("one control per run is in flight at a time", () => {
  it("performs once and mints one key when the control is pressed twice in a tick", async () => {
    // The claim that fails on the unlatched body: it performed twice and minted two
    // keys, so the daemon saw two distinct mutations rather than one replayed.
    const calls: RecordedCall[] = [];
    const mintIdempotencyKey = vi.fn(() => "6f1a0d3e-2c4b-4a7e-9f10-5b8c7d2e3a41");
    const { result } = renderHook(() =>
      useRunControlSurface(recordingBridge(calls), mintIdempotencyKey),
    );

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
    const { result } = renderHook(() => useRunControlSurface(recordingBridge([])));

    await act(async () => {
      result.current.dispatch(RUN_ID, "interrupt", perform);
      result.current.dispatch(RUN_ID, "cancel", perform);
      result.current.dispatch(OTHER_RUN_ID, "interrupt", perform);
    });

    expect(perform).toHaveBeenCalledTimes(3);
  });

  it("marks the pressed control busy and clears it on settlement", async () => {
    const settleWith = pendingOutcome();
    const { result } = renderHook(() => useRunControlSurface(recordingBridge([])));

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
    const { result } = renderHook(() => useRunControlSurface(recordingBridge([])));

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
    const { result } = renderHook(() => useRunControlSurface(recordingBridge([])));

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
    const { result } = renderHook(() => useRunControlSurface(recordingBridge([])));

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
