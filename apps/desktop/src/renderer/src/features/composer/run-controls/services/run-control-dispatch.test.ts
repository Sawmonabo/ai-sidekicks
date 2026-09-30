// The chokepoint: both guards on every call, one key per body, and the daemon's answer as the
// only settlement. The real dispatcher runs over stub calls standing in for the daemon. Nothing
// here decides whether the person may act: a control sent at a completed run still goes out.

import { describe, expect, it } from "vitest";

import { RunControlDispatcher } from "./run-control-dispatch.js";
import { RUN_ID, STUB_ACK, appliedIntervention } from "../run-control-commands.test-support.js";

/**
 * A pinned mint, so a case asserts the guard rather than a random value. Named without the
 * wire member's noun because the secret scan reads a high-entropy literal beside it as a
 * credential.
 */
const PINNED_IDEMPOTENCY = "6f1a0d3e-2c4b-4a7e-9f10-5b8c7d2e3a41";

interface RecordedCall {
  readonly method: "run.pause" | "run.resume" | "run.intervene";
  readonly params: unknown;
}

function dispatcherOver(answer: (call: RecordedCall) => Promise<unknown>): {
  dispatcher: RunControlDispatcher;
  calls: readonly RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const record =
    (method: RecordedCall["method"]) =>
    async (params: unknown): Promise<never> => {
      calls.push({ method, params });
      // The stub answers with whatever the case scripts; the parsed fixtures carry the members
      // the dispatcher reads.
      return (await answer({ method, params })) as never;
    };
  return {
    dispatcher: new RunControlDispatcher(
      {
        pause: record("run.pause"),
        resume: record("run.resume"),
        intervene: record("run.intervene"),
      },
      () => PINNED_IDEMPOTENCY,
    ),
    calls,
  };
}

describe("both guards, on every call", () => {
  it("sends the comparand on pause and resume", async () => {
    const { dispatcher, calls } = dispatcherOver(async () => STUB_ACK);
    await dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 });
    await dispatcher.resume({ runId: RUN_ID, expectedRunVersion: 7 });
    expect(calls.map((call) => call.method)).toStrictEqual(["run.pause", "run.resume"]);
    expect(calls.map((call) => call.params)).toMatchObject([
      { expectedRunVersion: 6 },
      { expectedRunVersion: 7 },
    ]);
  });

  it("sends both guards on every intervention arm", async () => {
    const { dispatcher, calls } = dispatcherOver(async () => appliedIntervention("steer", 8));
    await dispatcher.steer({ runId: RUN_ID, expectedRunVersion: 7 }, { content: "narrower" });
    await dispatcher.interrupt({ runId: RUN_ID, expectedRunVersion: 7 });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.method).toBe("run.intervene");
      expect(call.params).toMatchObject({
        expectedRunVersion: 7,
        clientIdempotencyKey: PINNED_IDEMPOTENCY,
        targetRunId: RUN_ID,
      });
    }
  });

  it("rejects a run identifier the contract would not accept, before any call", async () => {
    const { dispatcher, calls } = dispatcherOver(async () => STUB_ACK);
    await expect(dispatcher.pause({ runId: "not-a-run", expectedRunVersion: 1 })).rejects.toThrow(
      "not-a-run",
    );
    await expect(
      dispatcher.steer({ runId: "not-a-run", expectedRunVersion: 1 }, { content: "narrower" }),
    ).rejects.toThrow("not-a-run");
    expect(calls).toHaveLength(0);
  });
});

describe("the fresh comparand comes from the answer", () => {
  it("threads the acknowledgment's run version back out", async () => {
    const { dispatcher } = dispatcherOver(async () => STUB_ACK);
    expect(dispatcher.freshComparandFor(RUN_ID)).toBeUndefined();
    await dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 });
    expect(dispatcher.freshComparandFor(RUN_ID)).toBe(7);
  });

  it("threads an applied steer's run version back out, which no event carries", async () => {
    const { dispatcher } = dispatcherOver(async () => appliedIntervention("steer", 11));
    await dispatcher.steer({ runId: RUN_ID, expectedRunVersion: 10 }, { content: "narrower" });
    expect(dispatcher.freshComparandFor(RUN_ID)).toBe(11);
  });

  it("negative control: a rejected call leaves the held comparand alone", async () => {
    const { dispatcher } = dispatcherOver(async () => {
      throw { code: "run.invalid_transition", message: "the run is not running" };
    });
    await expect(dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 })).rejects.toMatchObject({
      code: "run.invalid_transition",
    });
    expect(dispatcher.freshComparandFor(RUN_ID)).toBeUndefined();
  });
});

describe("the comparand is the newer of the two readings", () => {
  it("sends the stream's reading once it has passed the cached one", async () => {
    const { dispatcher, calls } = dispatcherOver(async () => STUB_ACK);
    await dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 });
    // The run then advances on `run.subscribeState`, which no control caused.
    const comparand = dispatcher.comparandFor(RUN_ID, 8);
    await dispatcher.resume({ runId: RUN_ID, expectedRunVersion: comparand });
    expect(calls[1]?.params).toMatchObject({ expectedRunVersion: 8 });
  });

  it("negative control: the cached reading alone would have sent the stale version", async () => {
    // The wrong expression, written out: prefer the cache, fall back to the stream. It sends 7,
    // a version the daemon has moved past, and every later guarded control is refused as stale.
    const { dispatcher } = dispatcherOver(async () => STUB_ACK);
    await dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 });
    expect(dispatcher.freshComparandFor(RUN_ID) ?? 8).toBe(7);
    expect(dispatcher.comparandFor(RUN_ID, 8)).toBe(8);
  });

  it("keeps the cached reading when the stream is behind it", async () => {
    // An applied native steer advances the run and emits no state event, so the stream's
    // reading is legitimately older than the answer's for a while.
    const { dispatcher, calls } = dispatcherOver(async () => STUB_ACK);
    await dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 });
    const comparand = dispatcher.comparandFor(RUN_ID, 6);
    await dispatcher.resume({ runId: RUN_ID, expectedRunVersion: comparand });
    expect(calls[1]?.params).toMatchObject({ expectedRunVersion: 7 });
  });

  it("sends the stream's reading when no control has settled yet", () => {
    const { dispatcher } = dispatcherOver(async () => STUB_ACK);
    expect(dispatcher.comparandFor(RUN_ID, 3)).toBe(3);
  });

  it("answers nothing when neither reading exists, so the caller dispatches nothing", () => {
    const { dispatcher, calls } = dispatcherOver(async () => STUB_ACK);
    expect(dispatcher.comparandFor(RUN_ID, undefined)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("the daemon's answer is the only settlement", () => {
  it("carries a rejection through to the caller untouched", async () => {
    const rejection = { code: "intervention.idempotency_conflict", message: "the key was reused" };
    const { dispatcher } = dispatcherOver(async () => {
      throw rejection;
    });
    await expect(dispatcher.interrupt({ runId: RUN_ID, expectedRunVersion: 6 })).rejects.toBe(
      rejection,
    );
  });

  it("dispatches at a completed run rather than deciding eligibility itself", async () => {
    // Eligibility is the daemon's: the dispatcher holds no run state, so the call goes out and
    // the daemon's rejection comes back.
    const { dispatcher, calls } = dispatcherOver(async () => {
      throw { code: "run.invalid_transition", message: "the run has already completed" };
    });
    await expect(
      dispatcher.interrupt({ runId: RUN_ID, expectedRunVersion: 42 }),
    ).rejects.toMatchObject({ code: "run.invalid_transition" });
    expect(calls).toHaveLength(1);
  });
});
