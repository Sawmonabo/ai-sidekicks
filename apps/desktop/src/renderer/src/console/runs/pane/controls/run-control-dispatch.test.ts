// The chokepoint: both guards on every call, one key per body, and the daemon's
// answer as the only settlement.
//
// The cases drive the real dispatcher against a stub bridge rather than a local
// stand-in for it — the module under test is the one imported. What the stub stands
// in for is the WIRE, which is the boundary the dispatcher exists to cross.
//
// The claim that matters most here is the negative one: no control in this file
// decides whether the person MAY act. Every dispatch reaches the wire and a refusal
// comes back as a rendered value, so the case below sends a control at a completed
// run and asserts the request went out anyway.

import { describe, expect, it, vi } from "vitest";
import {
  RUN_CONTROLS,
  RunControlDispatcher,
  type RunControlOutcome,
} from "./run-control-dispatch.js";
import {
  bridgeAnswering,
  type RecordedDaemonCall,
} from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { RUN_ID } from "../runs-pane.test-support.js";

/**
 * A pinned mint, so a case asserts the guard rather than a random value. Named
 * without the wire member's own noun: the secret-scanning screen reads a
 * high-entropy literal beside that noun as a credential.
 */
const PINNED_IDEMPOTENCY = "6f1a0d3e-2c4b-4a7e-9f10-5b8c7d2e3a41";

function dispatcherOver(answer: (call: RecordedDaemonCall) => Promise<unknown>): {
  dispatcher: RunControlDispatcher;
  calls: readonly RecordedDaemonCall[];
} {
  const { bridge, calls } = bridgeAnswering(answer);
  return {
    dispatcher: new RunControlDispatcher({ bridge, mintIdempotencyKey: () => PINNED_IDEMPOTENCY }),
    calls,
  };
}

const ACK = { runId: RUN_ID, currentState: "paused", runVersion: 7 };

describe("the closed set of six", () => {
  it("declares exactly six controls", () => {
    expect([...RUN_CONTROLS]).toStrictEqual([
      "pause",
      "resume",
      "steer",
      "interrupt",
      "cancel",
      "rollback",
    ]);
  });
});

describe("both guards, on every call", () => {
  it("sends the comparand on pause and resume", async () => {
    const { dispatcher, calls } = dispatcherOver(async () => ACK);
    await dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 });
    await dispatcher.resume({ runId: RUN_ID, expectedRunVersion: 7 });
    expect(calls.map((call) => call.method)).toStrictEqual(["run.pause", "run.resume"]);
    expect(calls[0]?.params).toMatchObject({ expectedRunVersion: 6 });
    expect(calls[1]?.params).toMatchObject({ expectedRunVersion: 7 });
  });

  it("sends both guards on every intervention arm", async () => {
    const { dispatcher, calls } = dispatcherOver(async () => ({
      interventionId: "c4e1b2d3-5f60-4071-9b82-0d3e4f506172",
      interventionType: "steer",
      state: "applied",
      runVersion: 8,
    }));
    await dispatcher.steer({ runId: RUN_ID, expectedRunVersion: 7 }, { content: "narrower" });
    await dispatcher.interrupt({ runId: RUN_ID, expectedRunVersion: 7 });
    await dispatcher.cancel({ runId: RUN_ID, expectedRunVersion: 7 });
    await dispatcher.rollback({ runId: RUN_ID, expectedRunVersion: 7 }, { targetPosition: 3 });
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.method).toBe("run.intervene");
      expect(call.params).toMatchObject({
        expectedRunVersion: 7,
        clientIdempotencyKey: PINNED_IDEMPOTENCY,
        targetRunId: RUN_ID,
      });
    }
  });

  it("negative control: a request with no comparand never reaches the wire", async () => {
    // The schema parse is what refuses it. Without this the case above would pass
    // over a dispatcher that assembled the request and let the daemon decide, which
    // is exactly the fail-open direction the mandatory guard exists to close.
    const { dispatcher, calls } = dispatcherOver(async () => ACK);
    const outcome = await dispatcher.steer(
      { runId: RUN_ID, expectedRunVersion: Number.NaN },
      { content: "narrower" },
    );
    expect(calls).toHaveLength(0);
    expect(outcome.kind).toBe("refused");
  });

  it("refuses a run identifier the registered schema would not accept", async () => {
    const { dispatcher, calls } = dispatcherOver(async () => ACK);
    const outcome = await dispatcher.pause({ runId: "not-a-run", expectedRunVersion: 1 });
    expect(calls).toHaveLength(0);
    expect(refusalCodeOf(outcome)).toBe("identifier-unparseable");
  });
});

describe("the composite is selected by presence alone", () => {
  it("omits `replacementSend` on a bare rollback and carries it on the composite", async () => {
    const { dispatcher, calls } = dispatcherOver(async () => ({
      interventionId: "c4e1b2d3-5f60-4071-9b82-0d3e4f506172",
      interventionType: "rollback",
      state: "applied",
      runVersion: 9,
      result: { disposition: "conversation-only" },
    }));
    await dispatcher.rollback({ runId: RUN_ID, expectedRunVersion: 8 }, { targetPosition: 4 });
    await dispatcher.rollback(
      { runId: RUN_ID, expectedRunVersion: 9 },
      { targetPosition: 4, replacementSend: { content: "try this instead" } },
    );
    expect(calls[0]?.params).not.toHaveProperty("replacementSend");
    expect(calls[1]?.params).toMatchObject({ replacementSend: { content: "try this instead" } });
  });
});

describe("the fresh comparand comes from the answer", () => {
  it("threads the acknowledgment's run version back out", async () => {
    const { dispatcher } = dispatcherOver(async () => ACK);
    expect(dispatcher.freshComparandFor(RUN_ID)).toBeUndefined();
    await dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 });
    expect(dispatcher.freshComparandFor(RUN_ID)).toBe(7);
  });

  it("threads an applied steer's run version back out, which no event carries", async () => {
    const { dispatcher } = dispatcherOver(async () => ({
      interventionId: "c4e1b2d3-5f60-4071-9b82-0d3e4f506172",
      interventionType: "steer",
      state: "applied",
      runVersion: 11,
    }));
    await dispatcher.steer({ runId: RUN_ID, expectedRunVersion: 10 }, { content: "narrower" });
    expect(dispatcher.freshComparandFor(RUN_ID)).toBe(11);
  });

  it("negative control: a refused call leaves the held comparand alone", async () => {
    const { dispatcher } = dispatcherOver(async () => {
      throw { code: "run.invalid_transition", message: "the run is not running" };
    });
    await dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 });
    expect(dispatcher.freshComparandFor(RUN_ID)).toBeUndefined();
  });
});

describe("the comparand is the newer of the two readings", () => {
  it("sends the stream's reading once it has passed the cached one", async () => {
    const { dispatcher, calls } = dispatcherOver(async () => ACK);
    await dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 });
    // The run then advances on `run.subscribeState`, which no control caused and
    // whose advance the cache therefore never saw.
    const comparand = dispatcher.comparandFor(RUN_ID, 8);
    await dispatcher.resume({ runId: RUN_ID, expectedRunVersion: comparand });
    expect(calls[1]?.params).toMatchObject({ expectedRunVersion: 8 });
  });

  it("negative control: the cached reading alone would have sent the stale version", async () => {
    // The superseded expression, written out: prefer the cache, fall back to the
    // stream. Over the same two readings it sends 7 — the version the daemon has
    // already moved past — and every later guarded control is refused as stale.
    const { dispatcher } = dispatcherOver(async () => ACK);
    await dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 });
    expect(dispatcher.freshComparandFor(RUN_ID) ?? 8).toBe(7);
    expect(dispatcher.comparandFor(RUN_ID, 8)).toBe(8);
  });

  it("keeps the cached reading when the stream is behind it", async () => {
    // An applied native steer advances the run and emits no state event, so the
    // stream's reading is legitimately older than the answer's for a while.
    const { dispatcher, calls } = dispatcherOver(async () => ACK);
    await dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 });
    const comparand = dispatcher.comparandFor(RUN_ID, 6);
    await dispatcher.resume({ runId: RUN_ID, expectedRunVersion: comparand });
    expect(calls[1]?.params).toMatchObject({ expectedRunVersion: 7 });
  });

  it("sends the stream's reading when no control has settled yet", () => {
    const { dispatcher } = dispatcherOver(async () => ACK);
    expect(dispatcher.comparandFor(RUN_ID, 3)).toBe(3);
  });

  it("answers nothing when neither reading exists, so the caller dispatches nothing", () => {
    const { dispatcher, calls } = dispatcherOver(async () => ACK);
    expect(dispatcher.comparandFor(RUN_ID, undefined)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("the daemon's answer is the only settlement", () => {
  it("carries a typed wire refusal through verbatim", async () => {
    const { dispatcher } = dispatcherOver(async () => {
      throw { code: "intervention.idempotency_conflict", message: "the key was reused" };
    });
    const outcome = await dispatcher.cancel({ runId: RUN_ID, expectedRunVersion: 6 });
    expect(refusalCodeOf(outcome)).toBe("intervention.idempotency_conflict");
    expect(outcome.kind === "refused" ? outcome.refusal.detail : "").toBe("the key was reused");
  });

  it("refuses a reply that does not match the registered shape", async () => {
    const { dispatcher } = dispatcherOver(async () => ({ runId: RUN_ID }));
    const outcome = await dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 });
    expect(refusalCodeOf(outcome)).toBe("reply-unreadable");
  });

  it("dispatches at a completed run rather than deciding eligibility itself", async () => {
    // Eligibility is the daemon's. The dispatcher holds no run state at all — it is
    // handed a comparand and a run id — so there is nothing here that COULD refuse
    // on a run's state, and the call goes out and comes back refused.
    const answer = vi.fn(async () => {
      throw { code: "run.invalid_transition", message: "the run has already completed" };
    });
    const { dispatcher, calls } = dispatcherOver(answer);
    const outcome = await dispatcher.interrupt({ runId: RUN_ID, expectedRunVersion: 42 });
    expect(calls).toHaveLength(1);
    expect(refusalCodeOf(outcome)).toBe("run.invalid_transition");
  });
});

function refusalCodeOf(outcome: RunControlOutcome): string | undefined {
  return outcome.kind === "refused" ? outcome.refusal.code : undefined;
}
