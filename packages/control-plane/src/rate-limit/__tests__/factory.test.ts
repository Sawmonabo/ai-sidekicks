import { describe, expect, it } from "vitest";

import { RATE_LIMIT_ENDPOINT_GROUPS } from "../endpoint-groups.js";
import { createRateLimiterFactory } from "../factory.js";

const { limit } = RATE_LIMIT_ENDPOINT_GROUPS["auth.endpoint"];

describe("createRateLimiterFactory", () => {
  it("counts every check through a node factory in one shared window", async () => {
    const factory = createRateLimiterFactory({ kind: "node" });
    const allowed: boolean[] = [];
    // The admission check asks the factory for the counter on every request.
    for (let index = 0; index <= limit; index += 1) {
      const limiter = factory.forEndpoint("auth.endpoint");
      allowed.push(
        (await limiter.check({ identity: "192.0.2.10", endpoint: "auth.endpoint" })).allowed,
      );
    }

    expect(allowed).toEqual([...Array.from({ length: limit }, () => true), false]);
  });
});
