// The rate-limit middleware inside workerd, over the Worker's own context builder and Durable
// Object binding: the address comes from `CF-Connecting-IP`, and every request resolves the
// address's one Durable Object by name, as each edge location does. Local workerd runs a single
// location, so this proves the shared count by that name, not across real locations.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RATE_LIMIT_ENDPOINT_GROUPS } from "../../rate-limit/endpoint-groups.js";
import { createControlPlaneContext } from "../../server/host.js";
import {
  createSignInRequest,
  readRateLimitRefusal,
  sendSignIn,
  type SignInAnswer,
} from "./rate-limit.test-support.js";

const { limit, periodSeconds } = RATE_LIMIT_ENDPOINT_GROUPS["auth.endpoint"];

// Serves one sign-in request through the context the Worker builds for it.
function sendSignInThroughWorker(request: Request, requestId: string): Promise<SignInAnswer> {
  return sendSignIn(request, (responseHeaders) =>
    createControlPlaneContext({ request, responseHeaders, env, requestId }),
  );
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
  it("refuses the 21st request from one address, each request reaching its counter by name", async () => {
    const address = "198.51.100.21";
    const answers: SignInAnswer[] = [];
    for (let index = 0; index < limit + 2; index += 1) {
      const request = createSignInRequest({ "CF-Connecting-IP": address });
      answers.push(await sendSignInThroughWorker(request, `request-${index}`));
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
