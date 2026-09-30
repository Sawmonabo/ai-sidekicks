// The three composed requests, read at the wire's edge so the view can refuse in its own words.

import { describe, expect, it } from "vitest";

import {
  readInterruptRunParams,
  readInterventionRequest,
  readQueueItemCreateRequest,
} from "./wire-requests.js";

const RUN_ID = "019b7a11-1100-740e-8110-d1a4c1150311";
const SESSION_ID = "019b7a11-1100-75e5-8510-ada11a5a33a5";
const IDEMPOTENCY_KEY = "019b7a11-1100-7c1d-8510-ada11a5a3401";

describe("the composed-request readers", () => {
  it("reads a steer arm with every member its discriminant requires", () => {
    const request = readInterventionRequest({
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 4,
      clientIdempotencyKey: IDEMPOTENCY_KEY,
      content: "try the other branch",
    });

    expect(request?.type).toBe("steer");
  });

  it("refuses an arm missing what its own discriminant requires", () => {
    // A steer with no content would be refused by the daemon; the view names the control instead.
    expect(
      readInterventionRequest({
        type: "steer",
        targetRunId: RUN_ID,
        expectedRunVersion: 4,
        clientIdempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).toBeUndefined();
  });

  it("reads a queue create and an interrupt in their registered shapes", () => {
    expect(
      readQueueItemCreateRequest({
        sessionId: SESSION_ID,
        clientIdempotencyKey: IDEMPOTENCY_KEY,
        content: "ship it",
      })?.sessionId,
    ).toBe(SESSION_ID);
    expect(readInterruptRunParams({ runId: RUN_ID })?.runId).toBe(RUN_ID);
  });

  it("negative control: neither reader admits a shape the wire does not register", () => {
    expect(readQueueItemCreateRequest({ sessionId: SESSION_ID })).toBeUndefined();
    expect(readInterruptRunParams({})).toBeUndefined();
  });
});
