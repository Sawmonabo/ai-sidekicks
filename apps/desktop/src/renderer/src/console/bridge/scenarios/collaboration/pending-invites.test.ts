// Every deep-link arm this room scripts, reached the way a person reaches it.
//
// WHAT THIS FILE IS FOR. The outcome union carries six arms, and two of them — the
// handle that stopped resolving and the acceptance that never reached the control
// plane — could be rendered by no fixture at all: the scenario scripted neither, and
// the retry that produces the second one was dispatched on an attempt handle the
// fixture looked up in its table of invitation references, so it took the unscripted
// refusal every time. A surface built against arms no scenario can reach is a surface
// nobody has looked at.
//
// DRIVEN THROUGH THE REAL BRIDGE rather than the namespace object, because the defect
// lived on the path from a call to an answer: the growth port hands `request.attempt`
// to the fixture, and a case that called the fixture directly would have passed over
// exactly the seam that was wrong.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../fixture/fixture-bridge.js";
import type { ConsoleBridge } from "../../console-bridge.js";
import type { GrowthOutcome, GrowthStream } from "../../growth-port/growth-outcome.js";
import type {
  GrowthInviteAttempt,
  GrowthInviteOutcome,
  GrowthPendingInviteState,
} from "../../growth-values/index.js";
import { COLLABORATION_SCENARIO } from "../collaboration.js";
import {
  PENDING_ATTEMPT_UNREACHED,
  PENDING_REFERENCE_LAPSED,
  PENDING_REFERENCE_RECHECKED,
} from "./identifiers.js";

/**
 * Exactly `count` frames off one feed, then done with it.
 *
 * An exact count rather than a drain, because breaking out of the iteration closes
 * the stream: everything a case wants from one feed is taken in one pass, which is
 * also how the surface that owns a feed reads it.
 */
async function takeExactly<TEvent>(
  stream: GrowthStream<TEvent>,
  count: number,
): Promise<readonly TEvent[]> {
  const taken: TEvent[] = [];
  for await (const event of stream.events) {
    taken.push(event);
    if (taken.length === count) {
      break;
    }
  }
  return taken;
}

/** One served subscription, or a failed case rather than a silently empty one. */
function subscribed<TEvent>(outcome: GrowthOutcome<GrowthStream<TEvent>>): GrowthStream<TEvent> {
  if (outcome.status !== "served") {
    throw new Error(`the fixture refused a subscription this scenario scripts: ${outcome.code}`);
  }
  return outcome.value;
}

/** A bridge over the real room, with both deep-link feeds open. */
async function openedFeeds(bridge: ConsoleBridge): Promise<{
  readonly pending: GrowthStream<GrowthPendingInviteState>;
  readonly outcomes: GrowthStream<GrowthInviteOutcome>;
}> {
  const pending = subscribed<GrowthPendingInviteState>(
    await bridge.growth.invitePendingSubscribe({}),
  );
  const outcomes = subscribed<GrowthInviteOutcome>(await bridge.growth.inviteOutcomeSubscribe({}));
  return { pending, outcomes };
}

describe("the collaboration room's deep-link arrivals", () => {
  it("delivers three invitations and the one link it could not check", async () => {
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });
    const { pending } = await openedFeeds(bridge);

    const arrivals = await takeExactly(pending, 4);

    expect(arrivals.map((arrival) => arrival.status)).toStrictEqual([
      "ready",
      "ready",
      "ready",
      "unavailable",
    ]);
  });

  it("re-drives the unchecked link on its own handle and publishes the invitation", async () => {
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });
    const { pending } = await openedFeeds(bridge);

    const retried = await bridge.growth.inviteRetryPending({ attempt: PENDING_ATTEMPT_UNREACHED });

    expect(retried.status).toBe("served");
    const arrivals = await takeExactly(pending, 5);
    expect(arrivals[4]).toMatchObject({ status: "ready", reference: PENDING_REFERENCE_RECHECKED });
  });

  it("reaches the acceptance that could not be put, and the join its second attempt lands", async () => {
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });
    const { outcomes } = await openedFeeds(bridge);
    await bridge.growth.inviteRetryPending({ attempt: PENDING_ATTEMPT_UNREACHED });

    await bridge.growth.inviteConfirmPending({ reference: PENDING_REFERENCE_RECHECKED });
    await bridge.growth.inviteConfirmPending({ reference: PENDING_REFERENCE_RECHECKED });

    expect(await takeExactly(outcomes, 2)).toMatchObject([
      { kind: "unavailable", reference: PENDING_REFERENCE_RECHECKED, retryable: true },
      { kind: "joined", reference: PENDING_REFERENCE_RECHECKED },
    ]);
  });

  it("reaches the handle that stopped resolving, with the reason main names", async () => {
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });
    const { outcomes } = await openedFeeds(bridge);

    await bridge.growth.inviteConfirmPending({ reference: PENDING_REFERENCE_LAPSED });

    expect(await takeExactly(outcomes, 1)).toMatchObject([
      { kind: "reference-invalid", reference: PENDING_REFERENCE_LAPSED, reason: "expired" },
    ]);
  });

  it("negative control: a retry finds nothing on an invitation's own reference", async () => {
    // Without it the retry case above would pass over a fixture that served whatever
    // string it was handed — the conflation that produced the defect, since a
    // reference and an attempt are different brands answered by different acts.
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });
    await openedFeeds(bridge);

    const retried = await bridge.growth.inviteRetryPending({
      attempt: PENDING_REFERENCE_LAPSED as GrowthInviteAttempt,
    });

    expect(retried.status).toBe("unavailable");
  });
});
