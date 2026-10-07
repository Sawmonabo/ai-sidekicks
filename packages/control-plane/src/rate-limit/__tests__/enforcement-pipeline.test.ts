// A counter failure reaches the admission check's caller unchanged, so the request fails rather
// than slipping through uncounted. The admit and refuse answers are proven through tRPC's real
// adapter in the middleware's tests.

import { describe, expect, it } from "vitest";

import { createAdmissionCheck } from "../enforcement-pipeline.js";

describe("createAdmissionCheck", () => {
  it("rejects with the counter's own error when the counter fails", async () => {
    const counterFailure = new Error("rate-limit counter unreachable");
    const checkAdmission = createAdmissionCheck({
      limiterFor: () => ({
        check: async () => {
          throw counterFailure;
        },
      }),
    });

    await expect(
      checkAdmission({ identity: "203.0.113.7", endpoint: "auth.endpoint" }),
    ).rejects.toBe(counterFailure);
  });
});
