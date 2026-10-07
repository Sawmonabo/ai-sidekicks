// The rate-limit middleware, driven through tRPC's real fetch adapter: the status, headers and body
// a caller reads on a 400, a 200, a 429 and a counter failure, over the self-hosted relay's real
// counter or a counter the test answers, and the identity each source address is counted under.

import { SOURCE_ADDRESS_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts/rate-limiter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RATE_LIMIT_ENDPOINT_GROUPS } from "../../rate-limit/endpoint-groups.js";
import {
  createAdmissionCheck,
  type AdmissionCheck,
} from "../../rate-limit/enforcement-pipeline.js";
import { createRateLimiterFactory } from "../../rate-limit/factory.js";
import { InMemoryRateLimiter } from "../../rate-limit/in-memory-limiter.js";
import type { RateLimitCheckRequest, RateLimitCheckResponse } from "../../rate-limit/limiter.js";
import {
  createSignInRequest,
  readErrorData,
  readRateLimitRefusal,
  sendSignIn,
  type SignInAnswer,
} from "./rate-limit.test-support.js";

const { limit, periodSeconds } = RATE_LIMIT_ENDPOINT_GROUPS["auth.endpoint"];
const WINDOW_MILLISECONDS = periodSeconds * 1000;
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const ADDRESS = "203.0.113.7";
// The counter's own failure text, which no caller may read.
const COUNTER_FAILURE_TEXT = "rate-limit counter unreachable";

const WINDOW_WITH_ROOM: RateLimitCheckResponse = {
  allowed: true,
  remaining: limit - 1,
  resetAt: "2026-10-07T12:01:00.000Z",
  limit,
};

function sendSignInFrom(
  sourceAddress: string | undefined,
  checkAdmission: AdmissionCheck,
): Promise<SignInAnswer> {
  return sendSignIn(createSignInRequest(), (responseHeaders) => ({
    requestId: "request-1",
    sourceAddress,
    responseHeaders,
    checkAdmission,
  }));
}

// A counter that answers every check with `window` and records what it was asked to count.
function counterAnswering(window: RateLimitCheckResponse) {
  const countedRequests: RateLimitCheckRequest[] = [];
  const checkAdmission = createAdmissionCheck({
    limiterFor: () => ({
      check: async (request) => {
        countedRequests.push(request);
        return window;
      },
    }),
  });
  return { countedRequests, checkAdmission };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rateLimitProcedure", () => {
  // `127.1` is a spelling ipaddr.js reads as 127.0.0.1; counting it apart would split one host.
  for (const sourceAddress of [undefined, "not-an-address", "127.1"]) {
    it(`refuses ${String(sourceAddress)} with a 400 before counting anything`, async () => {
      const counter = counterAnswering(WINDOW_WITH_ROOM);
      const answer = await sendSignInFrom(sourceAddress, counter.checkAdmission);

      expect(answer.status).toBe(400);
      expect(readErrorData(answer.body)).toEqual({
        code: SOURCE_ADDRESS_UNRESOLVABLE_CODE,
        message: expect.any(String),
      });
      expect(counter.countedRequests).toEqual([]);
      expect(answer.retryAfterHeader).toBeNull();
    });
  }

  it("refuses requests past the limit with 429 and Retry-After, and admits at the reported resetAt", async () => {
    const checkAdmission = createAdmissionCheck({
      limiterFor: createRateLimiterFactory({ kind: "node" }).forEndpoint,
    });
    const allowed: SignInAnswer[] = [await sendSignInFrom(ADDRESS, checkAdmission)];
    vi.setSystemTime(NOW + 10_000);
    for (let count = 2; count <= limit; count += 1) {
      allowed.push(await sendSignInFrom(ADDRESS, checkAdmission));
    }
    for (const answer of allowed) {
      expect(answer).toEqual({
        status: 200,
        retryAfterHeader: null,
        body: { result: { data: "signed in" } },
      });
    }

    // 29.5 seconds before the first request ages out, so `Retry-After` rounds up to 30. Requests
    // 21 to 25 are all refused, and a refusal never extends the window.
    vi.setSystemTime(NOW + WINDOW_MILLISECONDS - 29_500);
    for (let count = limit + 1; count <= 25; count += 1) {
      const refused = await sendSignInFrom(ADDRESS, checkAdmission);
      expect(refused.status).toBe(429);
      const refusal = readRateLimitRefusal(refused.body);
      expect(refusal).toEqual({
        code: "rate_limited",
        retryAfter: 30,
        limit,
        remaining: 0,
        resetAt: new Date(NOW + WINDOW_MILLISECONDS).toISOString(),
      });
      expect(refused.retryAfterHeader).toBe(String(refusal.retryAfter));
    }

    vi.setSystemTime(NOW + WINDOW_MILLISECONDS);
    expect(await sendSignInFrom(ADDRESS, checkAdmission)).toEqual({
      status: 200,
      retryAfterHeader: null,
      body: { result: { data: "signed in" } },
    });
  });

  it("answers Retry-After 0, never below, when the counter reports a window already freed", async () => {
    const resetAt = new Date(NOW - 5000).toISOString();
    const counter = counterAnswering({ allowed: false, remaining: 0, resetAt, limit });
    const answer = await sendSignInFrom(ADDRESS, counter.checkAdmission);

    expect(answer.status).toBe(429);
    expect(readRateLimitRefusal(answer.body)).toEqual({
      code: "rate_limited",
      retryAfter: 0,
      limit,
      remaining: 0,
      resetAt,
    });
    expect(answer.retryAfterHeader).toBe("0");
  });

  it("fails the one request the counter errors on, and counts the next", async () => {
    const counter = new InMemoryRateLimiter();
    const counterAnswers: RateLimitCheckResponse[] = [];
    let isCounterDown = true;
    const checkAdmission = createAdmissionCheck({
      limiterFor: () => ({
        check: async (request) => {
          if (isCounterDown) {
            isCounterDown = false;
            throw new Error(COUNTER_FAILURE_TEXT);
          }
          const counterAnswer = await counter.check(request);
          counterAnswers.push(counterAnswer);
          return counterAnswer;
        },
      }),
    });

    const failed = await sendSignInFrom(ADDRESS, checkAdmission);
    expect(failed.status).toBe(500);
    const failure = readErrorData(failed.body);
    expect(failure).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    // A caller with no credential reads a fixed message, never the relay's own text or stack.
    expect(failure).not.toHaveProperty("stack");
    expect(failed.body).toMatchObject({ error: { message: "Unexpected internal error" } });
    expect(JSON.stringify(failed.body)).not.toContain(COUNTER_FAILURE_TEXT);
    expect(failed.retryAfterHeader).toBeNull();

    const next = await sendSignInFrom(ADDRESS, checkAdmission);
    expect(next.status).toBe(200);
    expect(counterAnswers).toEqual([
      {
        allowed: true,
        remaining: limit - 1,
        resetAt: new Date(NOW + WINDOW_MILLISECONDS).toISOString(),
        limit,
      },
    ]);
  });

  const identityRows = [
    { sourceAddress: "2001:DB8:1:2:aaaa::1", identity: "2001:db8:1:2::/64" },
    { sourceAddress: "2001:db8:1:2:bbbb:cccc:dddd:eeee", identity: "2001:db8:1:2::/64" },
    { sourceAddress: "::ffff:203.0.113.7", identity: "203.0.113.7" },
    { sourceAddress: "203.0.113.7", identity: "203.0.113.7" },
  ];

  for (const row of identityRows) {
    it(`counts ${row.sourceAddress} as ${row.identity}`, async () => {
      const counter = counterAnswering(WINDOW_WITH_ROOM);
      await sendSignInFrom(row.sourceAddress, counter.checkAdmission);

      expect(counter.countedRequests).toEqual([
        { identity: row.identity, endpoint: "auth.endpoint" },
      ]);
    });
  }
});
