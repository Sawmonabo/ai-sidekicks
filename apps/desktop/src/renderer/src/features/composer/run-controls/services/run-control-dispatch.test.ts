// The chokepoint: both guards on every call, the comparand read back off each answer and merged
// with the stream's reading, and a rejection handed to the caller untouched. A stale comparand
// is refused by the daemon, and a refusal carries no version to recover with, so every later
// control would be refused too. The real dispatcher runs over stub calls.

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

  it("keeps the cached reading when the stream is behind it", async () => {
    // An applied native steer advances the run and emits no state event, so the stream's
    // reading is legitimately older than the answer's for a while.
    const { dispatcher, calls } = dispatcherOver(async () => STUB_ACK);
    await dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 });
    const comparand = dispatcher.comparandFor(RUN_ID, 6);
    await dispatcher.resume({ runId: RUN_ID, expectedRunVersion: comparand });
    expect(calls[1]?.params).toMatchObject({ expectedRunVersion: 7 });
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
});
