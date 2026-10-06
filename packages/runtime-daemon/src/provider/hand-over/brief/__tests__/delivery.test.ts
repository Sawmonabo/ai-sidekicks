// Delivering the hand-over brief: a target never takes a second brief, however its send ends, and
// only the coordinator holding a target sends into it.

import { describe, expect, it } from "vitest";

import { UnownedBriefTargetError } from "../projection.js";
import {
  BriefDeliveryCoordinator,
  type BriefDeliveryRequest,
  type BriefDeliverySettlement,
  type BriefOutboundFrame,
} from "../delivery.js";
import type { CanonicalTranscriptProjection } from "../../../driver/provider-driver.js";
import {
  projectionOf,
  requestFor,
  TARGET,
  turn,
  type DeliveryDraft,
} from "./projection.test-support.js";

const HELLO: CanonicalTranscriptProjection = projectionOf([
  turn(1, "user", [{ kind: "text", text: "hello" }]),
]);
const GROWN_HELLO: CanonicalTranscriptProjection = projectionOf([
  turn(1, "user", [{ kind: "text", text: "hello" }]),
  turn(2, "assistant", [{ kind: "text", text: "hello to you" }]),
]);

/** Establishes the draft's target on `coordinator`, which refuses a handle another one minted. */
function addressedTo(
  coordinator: BriefDeliveryCoordinator,
  draft: DeliveryDraft,
): BriefDeliveryRequest {
  return { ...draft, target: coordinator.establishTarget(draft.target) };
}

async function deliverVia(
  coordinator: BriefDeliveryCoordinator,
  draft: DeliveryDraft,
): Promise<BriefDeliverySettlement> {
  return await coordinator.deliver(addressedTo(coordinator, draft));
}

/** The target session; a failed send may or may not have landed, as on the real wire. */
class FakeTargetSession {
  isSendFailing = false;
  sendAttempts = 0;

  async sendBriefTurn(): Promise<void> {
    this.sendAttempts += 1;
    if (this.isSendFailing) {
      throw new Error("acknowledgment lost");
    }
  }
}

describe("brief delivery — a target takes one brief send", () => {
  it("never sends a second brief into a target, however the first send ended", async () => {
    // A duplicate brief corrupts the conversation, and nothing reads the target back to tell an
    // uncertain send apart from a refused one, so every later delivery reuses the first settlement.
    for (const [isSendFailing, disposition] of [
      [false, "delivered"],
      [true, "unconfirmed"],
    ] as const) {
      const target = new FakeTargetSession();
      target.isSendFailing = isSendFailing;
      const coordinator = new BriefDeliveryCoordinator(target);

      // Overlapping, then later with a grown projection and a target that now accepts.
      const [first, overlapping] = await Promise.all([
        deliverVia(coordinator, requestFor(HELLO)),
        deliverVia(coordinator, requestFor(HELLO)),
      ]);
      target.isSendFailing = false;
      const later = await deliverVia(coordinator, requestFor(GROWN_HELLO));

      expect(first.disposition, disposition).toBe(disposition);
      expect(overlapping, disposition).toBe(first);
      expect(later, disposition).toBe(first);
      expect(target.sendAttempts, disposition).toBe(1);
      expect(first.cause instanceof Error, disposition).toBe(isSendFailing);
    }
  });

  it("lets only the coordinator holding a target send into it", async () => {
    // A successor that inherits the handle has no record of the send already made into it.
    const target = new FakeTargetSession();
    target.isSendFailing = true;
    const original = new BriefDeliveryCoordinator(target);
    const request: BriefDeliveryRequest = addressedTo(original, requestFor(HELLO));
    expect((await original.deliver(request)).disposition).toBe("unconfirmed");

    await expect(new BriefDeliveryCoordinator(target).deliver(request)).rejects.toBeInstanceOf(
      UnownedBriefTargetError,
    );
    expect(target.sendAttempts).toBe(1);

    // Releasing a target at session end refuses its handle and drops its record, so a
    // long-running daemon keeps nothing for ended sessions.
    original.releaseTarget(TARGET.providerSessionId);
    await expect(original.deliver(request)).rejects.toBeInstanceOf(UnownedBriefTargetError);
    target.isSendFailing = false;
    expect((await deliverVia(original, requestFor(HELLO))).disposition).toBe("delivered");
    expect(target.sendAttempts).toBe(2);
  });

  it("sends the brief as system narration, never exempt from the command tripwire", async () => {
    // The brief carries an earlier conversation's text; only a driver command skips the tripwire.
    const sentFrames: BriefOutboundFrame[] = [];
    const coordinator = new BriefDeliveryCoordinator({
      sendBriefTurn: async (frame: BriefOutboundFrame): Promise<void> => {
        sentFrames.push(frame);
      },
    });

    await deliverVia(coordinator, requestFor(HELLO));

    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]?.frame.origin).toBe("system_narration");
    expect(sentFrames[0]?.frame.tripwireExempt).toBe(false);
  });
});
