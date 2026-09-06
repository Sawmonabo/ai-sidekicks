// Dispatch: what a served reply actually settles, and what it does not.
//
// Split along the seam the module was. A fulfilled call is not a successful send —
// `run.intervene` answers with a lifecycle state that may say the run declined the
// message, and `run.queueCreate` answers with a shape that has to parse before a
// draft may be cleared. The version kept off every parsed response is what guards
// the next steer, and a daemon refusal is carried rather than paraphrased.

import { describe, expect, it, vi } from "vitest";
import { COMPOSER_REFUSAL_CODES } from "./send-refusals.js";
import {
  CHANNEL_TARGET,
  QUEUE_CREATED,
  RUN_TARGET,
  STEER_APPLIED,
  interventionResponse,
  routerWith,
} from "./send-router.test-support.js";

describe("ComposerSendRouter — a fulfilled intervention is not a successful send", () => {
  it("keeps the message for a steer the run rejected, and renders the daemon's cause", async () => {
    // The finding: fulfilment was treated as success, so a normally rejected steer
    // cleared the participant's draft as if it had landed. The draft is the send
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

  it("keeps the message where the answer did not parse as the registered response", async () => {
    // The call was answered and the answer is unreadable, so the console cannot
    // confirm the steer reached the run. Losing the participant's words to that
    // ambiguity is worse than letting them decide to send again.
    //
    // The code is the DOOR's, not this router's. `callDaemon` parses every reply
    // against the registry before the router sees one, so the router no longer mints
    // a per-call-site unreadable code — there is one reading of an unreadable reply
    // for the whole console, and it names the seam that did the reading.
    const call = vi.fn().mockResolvedValue({ state: "applied" });
    const outcome = await routerWith(call).send("try the other branch", RUN_TARGET);

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.refusal.code).toBe("reply-unreadable");
    expect(outcome.status === "refused" && outcome.refusal.origin).toBe("daemon-call");
  });
});

describe("ComposerSendRouter — a fulfilled queue-create is not a successful send", () => {
  it("keeps the message where the queue reply did not parse as the registered response", async () => {
    // The finding: the new-turn path returned an unconditional success, so a reply
    // outside `QueueItemCreateResponse` — a protocol-version mismatch is the case
    // that produces one — was reported as sent and the controller cleared the
    // participant's draft with no readable queue-item confirmation behind it.
    const call = vi.fn().mockResolvedValue({ queued: true });
    const outcome = await routerWith(call).send("ship the fix", CHANNEL_TARGET);

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.refusal.code).toBe("reply-unreadable");
    // Door-origin, like its steer sibling: the call was answered and nothing was
    // carried, so what refused is the one parse every console call goes through, and
    // the refusal names that seam rather than whichever surface happened to call.
    expect(outcome.status === "refused" && outcome.refusal.origin).toBe("daemon-call");
    // The half the participant acts on is the surface's, not the refusal's: a refused
    // send never clears the draft, which `ComposerSendBar.test.tsx` holds directly.
    expect(outcome.status === "refused" && outcome.refusal.detail).toContain("run.queueCreate");
  });

  it("refuses a reply that carries the members with a state the wire does not admit", async () => {
    // `.strict()` and a closed state union, both load-bearing: a reply shaped like
    // the response but reporting a state no queue item can hold is exactly the
    // half-understood payload a version mismatch produces, and it is not a
    // confirmation.
    const call = vi.fn().mockResolvedValue({ ...QUEUE_CREATED, state: "draining" });
    const outcome = await routerWith(call).send("ship the fix", CHANNEL_TARGET);

    expect(outcome.status === "refused" && outcome.refusal.code).toBe("reply-unreadable");
  });

  it("negative control: the registered reply is a send", async () => {
    // Without this the cases above would hold over a router that had started
    // refusing every new turn.
    const call = vi.fn().mockResolvedValue(QUEUE_CREATED);
    const outcome = await routerWith(call).send("ship the fix", CHANNEL_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "channel-message" });
  });

  it("leaves the stop settled by its fulfilment, because its ack carries nothing", async () => {
    // The negative control for the parse's SCOPE. `driver.interruptRun` answers with
    // `DriverAckResult` — the empty object — so a stop that fulfilled is a stop that
    // was taken, and a parse applied here would refuse nothing a rejection has not
    // already refused.
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call).stop(RUN_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "provider-bound" });
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

describe("ComposerSendRouter — a daemon refusal is carried, never paraphrased", () => {
  it("renders the daemon's own code and message", async () => {
    const call = vi
      .fn()
      .mockRejectedValue({ code: "run.version_conflict", message: "the run moved on" });
    const outcome = await routerWith(call).send("go", RUN_TARGET);

    expect(outcome).toStrictEqual({
      status: "refused",
      refusal: {
        // The door's origin, because the door is what read the rejection. What the
        // composer must not do is PARAPHRASE, and it does not: the daemon's own code
        // and its own sentence come through untouched.
        origin: "daemon-call",
        code: "run.version_conflict",
        detail: "the run moved on",
      },
    });
    // The negative control: the carried code is NOT one the composer mints, so a
    // console-side translation table would have had to invent it.
    expect(COMPOSER_REFUSAL_CODES).not.toContain(
      outcome.status === "refused" && outcome.refusal.code,
    );
  });

  it("renders an envelope-less rejection as what it was, not as a sentence of its own", async () => {
    const call = vi.fn().mockRejectedValue("socket closed");
    const outcome = await routerWith(call).send("go", CHANNEL_TARGET);

    // The synthesized terminal pair, named after the seam that read the rejection:
    // nothing machine-readable arrived, so the code says where rather than what.
    expect(outcome.status === "refused" && outcome.refusal.code).toBe("call-rejected");
    expect(outcome.status === "refused" && outcome.refusal.detail).toBe(
      "run.queueCreate was rejected.",
    );
  });
});
