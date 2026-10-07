// The Workers limiter inside workerd, over the Worker's own Durable Object binding.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { CloudflareWorkersRateLimiter, type RateLimitIdentityEnv } from "../cloudflare-limiter.js";
import { createRateLimiterFactory } from "../factory.js";
import { describeRateLimiterContract } from "../limiter-contract-suite.js";

const identityEnv = env as RateLimitIdentityEnv;

describe("CloudflareWorkersRateLimiter", () => {
  it("rejects the check when the address's counter fails, rather than allowing it", async () => {
    const address = "198.51.100.1";
    const namespace = identityEnv.RATE_LIMIT_IDENTITY;
    // State that does not parse makes the counter throw, as any failed round trip would.
    await runInDurableObject(namespace.get(namespace.idFromName(address)), (_instance, state) => {
      state.storage.kv.put("auth.endpoint", { windowMilliseconds: 60_000, hits: "unreadable" });
    });

    const limiter = new CloudflareWorkersRateLimiter(identityEnv);
    await expect(limiter.check({ identity: address, endpoint: "auth.endpoint" })).rejects.toThrow(
      /stored rate-limit window "auth\.endpoint" does not parse:.*hits/s,
    );
  });
});

describeRateLimiterContract(async () =>
  createRateLimiterFactory({ kind: "workers", env: identityEnv }).forEndpoint("auth.endpoint"),
);
