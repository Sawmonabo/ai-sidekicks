// The rate-limit middleware inside workerd, over the Worker's own context builder and Durable
// Object binding: the address comes from `CF-Connecting-IP`, and the count is one per address
// whichever edge location serves a request.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RateLimitIdentityEnv } from "../../rate-limit/cloudflare-limiter.js";
import { RATE_LIMIT_ENDPOINT_GROUPS } from "../../rate-limit/endpoint-groups.js";
import { createControlPlaneContext } from "../../server/host.js";
import {
  createSignInRequest,
  readRateLimitRefusal,
  sendSignIn,
  type SignInAnswer,
} from "./rate-limit.test-support.js";

const { limit, periodSeconds } = RATE_LIMIT_ENDPOINT_GROUPS["auth.endpoint"];
const identityEnv = env as RateLimitIdentityEnv;

// One edge location: its own handler, building each request's context as the Worker does.
function openEdgeLocation(): (request: Request) => Promise<SignInAnswer> {
  let requestCount = 0;
  return (request) =>
    sendSignIn(request, (responseHeaders) => {
      requestCount += 1;
      return createControlPlaneContext({
        request,
        responseHeaders,
        env: identityEnv,
        requestId: `request-${requestCount}`,
      });
    });
}

// A day ahead of the real clock: workerd fires a due alarm on its own.
let startTime: number;

beforeEach(() => {
  startTime = Date.now() + 86_400_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(startTime);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rateLimitProcedure on the Workers relay", () => {
  it("refuses the request past the limit from one address whichever location serves it", async () => {
    const address = "198.51.100.21";
    const firstLocation = openEdgeLocation();
    const secondLocation = openEdgeLocation();
    const answers: SignInAnswer[] = [];
    // The last two land on different locations, so each location meets the shared count.
    for (let index = 0; index < limit + 2; index += 1) {
      const location = index % 2 === 0 ? firstLocation : secondLocation;
      answers.push(await location(createSignInRequest({ "CF-Connecting-IP": address })));
    }

    expect(answers.slice(0, limit).map((answer) => answer.status)).toEqual(
      Array.from({ length: limit }, () => 200),
    );
    for (const refused of answers.slice(limit)) {
      expect(refused.status).toBe(429);
      expect(readRateLimitRefusal(refused.body)).toEqual({
        code: "rate_limited",
        retryAfter: periodSeconds,
        limit,
        remaining: 0,
        resetAt: new Date(startTime + periodSeconds * 1000).toISOString(),
      });
      expect(refused.retryAfterHeader).toBe(String(periodSeconds));
    }
  });
});
