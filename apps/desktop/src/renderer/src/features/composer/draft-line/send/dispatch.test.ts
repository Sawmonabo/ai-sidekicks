// Dispatch: a resolved call is not a successful send, since `run.intervene` answers with a
// lifecycle state that may decline the message. The version kept off every response guards
// the next steer, and a rejected call propagates.

import { describe, expect, it, vi } from "vitest";
import {
  SESSION_TARGET,
  RUN_TARGET,
  STEER_APPLIED,
  interventionResponse,
  routerWith,
} from "./router.test-support.js";
import { isUndeliveredMessage } from "./refusals.js";

describe("ComposerSendRouter — a fulfilled intervention is not a successful send", () => {
  it("names the lifecycle state where the response carried no cause", async () => {
    // `rejectionReason` is optional; an absent one still leaves the lifecycle state as the code.
    const call = vi.fn().mockResolvedValue(interventionResponse("expired", 11));
    const outcome = await routerWith(call).send("steer me", RUN_TARGET);

    expect(outcome.status === "refused" && outcome.refusal.code).toBe("expired");
  });

  it("refuses a failed steer under its failure reason, so the draft stays", async () => {
    // The dispatch threw before the run took the text, so sending it again is the person's call.
    const call = vi
      .fn()
      .mockResolvedValue(
        interventionResponse("failed", 7, { failureReason: "driver.transport_closed" }),
      );
    const outcome = await routerWith(call).send("steer me", RUN_TARGET);

    expect(outcome.status === "refused" && outcome.refusal.code).toBe("driver.transport_closed");
    expect(outcome.status === "refused" && isUndeliveredMessage(outcome.refusal)).toBe(true);
  });

  it("treats the two fallback states as sends, because the message traveled", async () => {
    // Both states have the run taking the message, so keeping the draft would invite a
    // duplicate steer.
    for (const state of ["requested", "accepted", "degraded"]) {
      const call = vi.fn().mockResolvedValue(interventionResponse(state, 8));
      const outcome = await routerWith(call).send("try the other branch", RUN_TARGET);
      expect(outcome).toStrictEqual({ status: "sent", path: "provider-bound" });
    }
  });
});

describe("ComposerSendRouter — the next steer is guarded with the answer's own version", () => {
  it("sends the version the last intervention answered with", async () => {
    // An applied native steer advances the run version with no state event, so the
    // projection stays at 7 and only the response holds the fresh comparand.
    const call = vi.fn().mockResolvedValue(STEER_APPLIED);
    const router = routerWith(call);

    await router.send("first", RUN_TARGET);
    await router.send("second", RUN_TARGET);

    expect(call.mock.calls[0]?.[1]).toMatchObject({ expectedRunVersion: 7 });
    expect(call.mock.calls[1]?.[1]).toMatchObject({ expectedRunVersion: 8 });
  });

  it("negative control: a projection ahead of the answer is the one that is sent", async () => {
    // The run advances through its state stream too, so preferring the kept answer would pin
    // every later steer to a stale version.
    const call = vi.fn().mockResolvedValue(interventionResponse("applied", 8));
    const router = routerWith(call);

    await router.send("first", RUN_TARGET);
    await router.send("second", { ...RUN_TARGET, expectedRunVersion: 40 });

    expect(call.mock.calls[1]?.[1]).toMatchObject({ expectedRunVersion: 40 });
  });
});

describe("ComposerSendRouter — a rejected call is not caught", () => {
  it("propagates a rejected steer to the caller of send", async () => {
    const rejection = { code: "run.version_conflict", message: "the run moved on" };
    const call = vi.fn().mockRejectedValue(rejection);

    await expect(routerWith(call).send("go", RUN_TARGET)).rejects.toBe(rejection);
  });

  it("propagates a rejected queue-create to the caller of send", async () => {
    const rejection = new Error("socket closed");
    const call = vi.fn().mockRejectedValue(rejection);

    await expect(routerWith(call).send("go", SESSION_TARGET)).rejects.toBe(rejection);
  });
});
