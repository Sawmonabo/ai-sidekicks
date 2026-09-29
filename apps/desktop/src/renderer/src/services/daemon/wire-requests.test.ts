// The three composed requests, read at the wire's edge so a surface can refuse in its
// own words before the door refuses in the door's.

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
    // The reading this buys the caller: a steer with no content is a request the
    // daemon would refuse, and the surface says so naming the control rather than
    // the method.
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
      readQueueItemCreateRequest({ sessionId: SESSION_ID, payload: { content: "ship it" } })
        ?.sessionId,
    ).toBe(SESSION_ID);
    expect(readInterruptRunParams({ runId: RUN_ID })?.runId).toBe(RUN_ID);
  });

  it("negative control: neither reader admits a shape the wire does not register", () => {
    expect(readQueueItemCreateRequest({ sessionId: SESSION_ID })).toBeUndefined();
    expect(readInterruptRunParams({})).toBeUndefined();
  });
});
