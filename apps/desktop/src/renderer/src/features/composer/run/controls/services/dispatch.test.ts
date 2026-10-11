// The chokepoint: both guards on every run call, a steer on a child's queue, the comparand
// read back off each answer and merged with the stream's reading, and a rejection handed to the
// caller untouched. A stale comparand is refused by the daemon, and a refusal carries no version
// to recover with, so every later control would be refused too. The real dispatcher runs over
// stub calls.

import { describe, expect, it } from "vitest";

import { RunControlDispatcher } from "./dispatch.js";
import { RUN_ID, STUB_ACK, appliedInterrupt } from "../commands.test-support.js";

/**
 * A pinned mint, so a case asserts the guard rather than a random value. Named without the
 * wire member's noun because the secret scan reads a high-entropy literal beside it as a
 * credential.
 */
const PINNED_IDEMPOTENCY = "6f1a0d3e-2c4b-4a7e-9f10-5b8c7d2e3a41";

/** The child whose queue a steer is sent to. */
const CHILD_HANDLE = "agent-builder-1";

interface RecordedCall {
  readonly method: "run.pause" | "run.resume" | "run.intervene" | "run.childSteer";
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
        childSteer: record("run.childSteer"),
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

  it("sends both guards on an interrupt", async () => {
    const { dispatcher, calls } = dispatcherOver(async () => appliedInterrupt(8));
    await dispatcher.interrupt({ runId: RUN_ID, expectedRunVersion: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("run.intervene");
    expect(calls[0]?.params).toMatchObject({
      expectedRunVersion: 7,
      clientIdempotencyKey: PINNED_IDEMPOTENCY,
      targetRunId: RUN_ID,
    });
  });

  it("sends both guards on a steer, to the child's queue", async () => {
    const { dispatcher, calls } = dispatcherOver(async () => ({
      queueItemId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
      state: "queued",
      createdAt: "2026-09-02T09:00:00.000Z",
    }));
    await dispatcher.steer(
      { runId: RUN_ID, expectedRunVersion: 7 },
      { childHandle: CHILD_HANDLE, content: "narrower" },
    );
    expect(calls).toStrictEqual([
      {
        method: "run.childSteer",
        params: {
          targetRunId: RUN_ID,
          expectedRunVersion: 7,
          clientIdempotencyKey: PINNED_IDEMPOTENCY,
          childHandle: CHILD_HANDLE,
          content: "narrower",
        },
      },
    ]);
  });
});

describe("the fresh comparand comes from the answer", () => {
  it("threads the acknowledgment's run version back out", async () => {
    const { dispatcher } = dispatcherOver(async () => STUB_ACK);
    expect(dispatcher.comparandFor(RUN_ID, undefined)).toBeUndefined();
    await dispatcher.pause({ runId: RUN_ID, expectedRunVersion: 6 });
    expect(dispatcher.comparandFor(RUN_ID, undefined)).toBe(7);
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
    // The answer can run ahead of the state stream, so the stream's reading is legitimately
    // older than the answer's for a while.
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
