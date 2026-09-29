// Dispatch: what a served reply actually settles, and what it does not.
//
// A resolved call is not a successful send: `run.intervene` answers with a lifecycle
// state that may say the run declined the message. The version kept off every
// response is what guards the next steer, and a rejected call propagates rather than
// being turned into a sentence.

import { describe, expect, it, vi } from "vitest";
import {
  SESSION_TARGET,
  RUN_TARGET,
  STEER_APPLIED,
  interventionResponse,
  routerWith,
} from "./send-router.test-support.js";

describe("ComposerSendRouter — a fulfilled intervention is not a successful send", () => {
  it("keeps the message for a steer the run rejected, and renders the daemon's cause", async () => {
    // The finding: fulfilment was treated as success, so a normally rejected steer
    // cleared the user's draft as if it had landed. The draft is the send
    // bar's to clear and it clears on `sent` alone, so a refusal here is what keeps
    // the words in the line.
    const call = vi
      .fn()
      .mockResolvedValue(
        interventionResponse("rejected", 7, { rejectionReason: "run.invalid_transition" }),
      );
    const outcome = await routerWith(call).send("try the other branch", RUN_TARGET);

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.refusal.origin).toBe("daemon");
    // The response's own machine-readable cause, in the slot the console renders in
    // mono — never a category this module invented for it.
    expect(outcome.status === "refused" && outcome.refusal.code).toBe("run.invalid_transition");
  });

  it("names the lifecycle state where the response carried no cause", async () => {
    // `rejectionReason` is optional on the steer arm, and an absent one still leaves
    // the daemon's own word for what happened.
    const call = vi.fn().mockResolvedValue(interventionResponse("expired", 11));
    const outcome = await routerWith(call).send("steer me", RUN_TARGET);

    expect(outcome.status === "refused" && outcome.refusal.code).toBe("expired");
  });

  it("negative control: the same call answering `applied` is a send", async () => {
    // Without this the cases above would hold over a router that had started
    // refusing every steer.
    const call = vi.fn().mockResolvedValue(STEER_APPLIED);
    const outcome = await routerWith(call).send("try the other branch", RUN_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "provider-bound" });
  });

  it("treats the two fallback states as sends, because the message travelled", async () => {
    // `accepted` is the daemon's admission and `degraded` is the orchestration layer
    // having fallen back — the transition table puts both on the path where the run
    // takes the message, so keeping the draft would invite a duplicate steer.
    for (const state of ["requested", "accepted", "degraded"]) {
      const call = vi.fn().mockResolvedValue(interventionResponse(state, 8));
      const outcome = await routerWith(call).send("try the other branch", RUN_TARGET);
      expect(outcome).toStrictEqual({ status: "sent", path: "provider-bound" });
    }
  });
});

describe("ComposerSendRouter — the next steer is guarded with the answer's own version", () => {
  it("sends the version the last intervention answered with", async () => {
    // An applied native steer advances the run version with no state event to
    // broadcast it, so the store's projection stays at 7 and every later steer under
    // it would be refused as stale. The response is the only place the fresh
    // comparand exists, and this is what keeps it.
    const call = vi.fn().mockResolvedValue(STEER_APPLIED);
    const router = routerWith(call);

    await router.send("first", RUN_TARGET);
    await router.send("second", RUN_TARGET);

    expect(call.mock.calls[0]?.[1]).toMatchObject({ expectedRunVersion: 7 });
    expect(call.mock.calls[1]?.[1]).toMatchObject({ expectedRunVersion: 8 });
  });

  it("keeps the version a refusal answered with, so the retry is guarded", async () => {
    // The reject-re-read-retry loop, closed without a re-read: a refused
    // intervention still answers with the run's current version.
    const call = vi
      .fn()
      .mockResolvedValueOnce(interventionResponse("expired", 12))
      .mockResolvedValue(STEER_APPLIED);
    const router = routerWith(call);

    await router.send("first", RUN_TARGET);
    await router.send("second", RUN_TARGET);

    expect(call.mock.calls[1]?.[1]).toMatchObject({ expectedRunVersion: 12 });
  });

  it("negative control: a projection ahead of the answer is the one that is sent", async () => {
    // The run advances through its own state stream with no control pressed, so
    // preferring the kept answer unconditionally would pin every later steer to the
    // version the last settlement saw — and a refusal carries no way back.
    const call = vi.fn().mockResolvedValue(interventionResponse("applied", 8));
    const router = routerWith(call);

    await router.send("first", RUN_TARGET);
    await router.send("second", { ...RUN_TARGET, expectedRunVersion: 40 });

    expect(call.mock.calls[1]?.[1]).toMatchObject({ expectedRunVersion: 40 });
  });

  it("guards a steer the store has never projected a version for", async () => {
    // Without a projection the router refuses; with an answer kept from an earlier
    // intervention there is a comparand, and it is a wire figure rather than a zero
    // this module invented.
    const call = vi.fn().mockResolvedValue(STEER_APPLIED);
    const router = routerWith(call);

    await router.send("first", RUN_TARGET);
    const outcome = await router.send("second", { ...RUN_TARGET, expectedRunVersion: undefined });

    expect(outcome.status).toBe("sent");
    expect(call.mock.calls[1]?.[1]).toMatchObject({ expectedRunVersion: 8 });
  });

  it("negative control: with no answer kept, an unprojected run still refuses", async () => {
    const call = vi.fn().mockResolvedValue(STEER_APPLIED);
    const outcome = await routerWith(call).send("steer me", {
      ...RUN_TARGET,
      expectedRunVersion: undefined,
    });

    expect(outcome.status === "refused" && outcome.refusal.code).toBe("run-version-unread");
    expect(call).not.toHaveBeenCalled();
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
