// When a scripted pending invitation reaches the feed that is listening for it.
//
// The defect this file exists for: a frame's `atMs` was read exactly once, at the
// moment a feed opened, and never again. Every invitation scripted to arrive after
// that instant was filtered out and delivered by nothing — the fixture subscribed to
// neither the engine nor the clock — so a deep link that lands while a console is
// already on screen, which is the ordinary case for anything a person navigates to,
// produced a permanently empty notice. The cases below drive the real namespace
// against a real `ScenarioEngine`, because the whole claim is about which of the two
// objects moves the other.
//
// THE CLOCK IS MOVED BY THE CASE AND BY NOTHING ELSE, which is what makes each of
// these exact rather than timing-dependent: `ScenarioEngine` is frozen, so "the feed
// was open across the tick" and "the feed was closed across the tick" are two
// statements about one deterministic run rather than a race.

import { describe, expect, it } from "vitest";

import { FixturePendingInvites } from "./fixture-pending-invites.js";
import {
  IMMEDIATE_REFERENCE,
  LATE_FRAME_TICK_MS,
  LATE_REFERENCE,
  RECHECKED_REFERENCE,
  UNREACHED_ATTEMPT,
  attemptFrame,
  drain,
  drainFrames,
  drainOutcomes,
  pendingFrame,
  scenarioWithAttempts,
  scenarioWithFrames,
} from "./fixture-pending-invites.test-support.js";
import type { GrowthInviteAttempt } from "../growth-values/index.js";
import { ScenarioEngine } from "../scenario-runtime/index.js";
import type { ScenarioPendingInviteFrame } from "../scenario-runtime/index.js";

describe("fixture pending invites — a frame whose tick has not come yet", () => {
  it("delivers it to an open feed once the scenario advances past its tick", async () => {
    const engine = new ScenarioEngine({
      scenario: scenarioWithFrames([pendingFrame(LATE_REFERENCE, LATE_FRAME_TICK_MS)]),
    });
    const pendingInvites = new FixturePendingInvites(engine);
    const feed = pendingInvites.openPendingFeed();
    expect(feed.queuedCount).toBe(0);

    engine.advance(LATE_FRAME_TICK_MS);

    await expect(drain(feed)).resolves.toStrictEqual([LATE_REFERENCE]);
  });

  it("delivers it exactly once, however far past its tick the scenario runs", async () => {
    // A second advance re-walking the whole table would hand the notice the same
    // invitation again, and a surface keyed by reference cannot tell the second copy
    // from a re-delivery it is supposed to fold.
    const engine = new ScenarioEngine({
      scenario: scenarioWithFrames([pendingFrame(LATE_REFERENCE, LATE_FRAME_TICK_MS)]),
    });
    const pendingInvites = new FixturePendingInvites(engine);
    const feed = pendingInvites.openPendingFeed();

    engine.advance(LATE_FRAME_TICK_MS);
    engine.advance(LATE_FRAME_TICK_MS);
    engine.advance(0);

    await expect(drain(feed)).resolves.toStrictEqual([LATE_REFERENCE]);
  });

  it("negative control: a feed closed before the tick receives nothing", async () => {
    // Without it, a namespace that pushed into every feed it had ever handed out
    // would pass every case above. A released feed drops what is pushed into it, so
    // the reading has to be taken on the feed itself rather than on the push.
    const engine = new ScenarioEngine({
      scenario: scenarioWithFrames([pendingFrame(LATE_REFERENCE, LATE_FRAME_TICK_MS)]),
    });
    const pendingInvites = new FixturePendingInvites(engine);
    const feed = pendingInvites.openPendingFeed();
    feed.close();

    engine.advance(LATE_FRAME_TICK_MS);

    expect(feed.queuedCount).toBe(0);
  });
});

describe("fixture pending invites — a feed opened after the tick", () => {
  it("still takes the frame, and the advance that preceded it does not double it", async () => {
    // The two triggers meet here: the advance served the feeds that were open, and
    // this feed was not one of them, so its own open-time walk is what covers it —
    // and neither delivery may reach the other's audience.
    const engine = new ScenarioEngine({
      scenario: scenarioWithFrames([pendingFrame(LATE_REFERENCE, LATE_FRAME_TICK_MS)]),
    });
    const pendingInvites = new FixturePendingInvites(engine);
    const alreadyOpen = pendingInvites.openPendingFeed();

    engine.advance(LATE_FRAME_TICK_MS);
    const openedAfter = pendingInvites.openPendingFeed();

    await expect(drain(alreadyOpen)).resolves.toStrictEqual([LATE_REFERENCE]);
    await expect(drain(openedAfter)).resolves.toStrictEqual([LATE_REFERENCE]);
  });

  it("hands an already-due frame over at open, and never again on a later advance", async () => {
    const engine = new ScenarioEngine({
      scenario: scenarioWithFrames([pendingFrame(IMMEDIATE_REFERENCE, 0)]),
    });
    const pendingInvites = new FixturePendingInvites(engine);
    const feed = pendingInvites.openPendingFeed();
    expect(feed.queuedCount).toBe(1);

    engine.advance(LATE_FRAME_TICK_MS);

    await expect(drain(feed)).resolves.toStrictEqual([IMMEDIATE_REFERENCE]);
  });
});

describe("fixture pending invites — a reference an act has already spent", () => {
  it("reaches neither the open-time walk nor a later advance", async () => {
    // The single-use rule stated from the delivery side: confirming consumes the
    // entry, and either walk re-offering it would put a reference nobody can act on
    // back in front of a person. The spend happens BEFORE the feed opens, so the two
    // triggers are both under test rather than only the second.
    const engine = new ScenarioEngine({
      scenario: scenarioWithFrames([
        pendingFrame(IMMEDIATE_REFERENCE, 0),
        pendingFrame(LATE_REFERENCE, LATE_FRAME_TICK_MS),
      ]),
    });
    const pendingInvites = new FixturePendingInvites(engine);
    expect(pendingInvites.confirm(IMMEDIATE_REFERENCE).status).toBe("served");

    const feed = pendingInvites.openPendingFeed();
    expect(feed.queuedCount).toBe(0);
    engine.advance(LATE_FRAME_TICK_MS);

    await expect(drain(feed)).resolves.toStrictEqual([LATE_REFERENCE]);
  });
});

describe("fixture pending invites — a deep link whose preview could not be put", () => {
  it("delivers it on the same feed, carrying the handle a retry is sent on", async () => {
    const engine = new ScenarioEngine({ scenario: scenarioWithAttempts([attemptFrame(0)]) });
    const pendingInvites = new FixturePendingInvites(engine);
    const feed = pendingInvites.openPendingFeed();

    await expect(drainFrames(feed)).resolves.toStrictEqual([
      { status: "unavailable", retryable: true, attempt: UNREACHED_ATTEMPT },
    ]);
  });

  it("serves the retry on that handle and publishes the preview it re-drove", async () => {
    // The defect: the retry looked its ATTEMPT up in the table of invitation
    // REFERENCES, so every legitimate retry found nothing and took the unscripted
    // refusal — the one path a person can act on from this arm was unreachable.
    const engine = new ScenarioEngine({ scenario: scenarioWithAttempts([attemptFrame(0)]) });
    const pendingInvites = new FixturePendingInvites(engine);
    const feed = pendingInvites.openPendingFeed();

    expect(pendingInvites.retry(UNREACHED_ATTEMPT).status).toBe("served");

    // Drained once, because a `break` out of the iteration closes the feed: what the
    // case is about is that both frames reached the SAME feed, the deep link and the
    // preview its retry re-drove, in that order.
    await expect(drainFrames(feed)).resolves.toMatchObject([
      { status: "unavailable", attempt: UNREACHED_ATTEMPT },
      { status: "ready", reference: RECHECKED_REFERENCE },
    ]);
  });

  it("hands the replacement to the acts an invitation admits", async () => {
    const engine = new ScenarioEngine({ scenario: scenarioWithAttempts([attemptFrame(0)]) });
    const pendingInvites = new FixturePendingInvites(engine);
    const outcomes = pendingInvites.openOutcomeFeed();
    pendingInvites.retry(UNREACHED_ATTEMPT);

    expect(pendingInvites.confirm(RECHECKED_REFERENCE).status).toBe("served");

    await expect(drainOutcomes(outcomes)).resolves.toMatchObject([
      { kind: "joined", reference: RECHECKED_REFERENCE },
    ]);
  });

  it("negative control: a retry finds nothing on a reference, or on a handle twice", async () => {
    // Without it the cases above would pass over a fixture that served every string
    // it was handed — which is the conflation that produced the defect: one table,
    // two brands, and whichever entry collided answering the act.
    const engine = new ScenarioEngine({
      scenario: {
        ...scenarioWithAttempts([attemptFrame(0)]),
        pendingInvites: [pendingFrame(IMMEDIATE_REFERENCE, 0)],
      },
    });
    const pendingInvites = new FixturePendingInvites(engine);

    expect(pendingInvites.retry(IMMEDIATE_REFERENCE as GrowthInviteAttempt).status).toBe(
      "unavailable",
    );
    expect(pendingInvites.retry(UNREACHED_ATTEMPT).status).toBe("served");
    expect(pendingInvites.retry(UNREACHED_ATTEMPT).status).toBe("unavailable");
  });
});

describe("fixture pending invites — a second confirmation on one reference", () => {
  /** One invitation whose first acceptance could not be put and whose second joins. */
  function reconfirmableFrame(): ScenarioPendingInviteFrame {
    return {
      ...pendingFrame(IMMEDIATE_REFERENCE, 0),
      onConfirm: { kind: "unavailable", reference: IMMEDIATE_REFERENCE, retryable: true },
      onReconfirm: {
        kind: "joined",
        reference: IMMEDIATE_REFERENCE,
        sessionId: `session-for-${IMMEDIATE_REFERENCE}`,
        membershipId: `membership-from-${IMMEDIATE_REFERENCE}`,
        role: "collaborator",
      },
    };
  }

  it("serves it where the scenario scripts one, which is how a recovery reaches an end", async () => {
    const engine = new ScenarioEngine({ scenario: scenarioWithFrames([reconfirmableFrame()]) });
    const pendingInvites = new FixturePendingInvites(engine);
    const outcomes = pendingInvites.openOutcomeFeed();

    expect(pendingInvites.confirm(IMMEDIATE_REFERENCE).status).toBe("served");
    expect(pendingInvites.confirm(IMMEDIATE_REFERENCE).status).toBe("served");

    await expect(drainOutcomes(outcomes)).resolves.toMatchObject([
      { kind: "unavailable" },
      { kind: "joined" },
    ]);
  });

  it("negative control: a reference with no second answer scripted stays single-use", () => {
    const engine = new ScenarioEngine({
      scenario: scenarioWithFrames([pendingFrame(IMMEDIATE_REFERENCE, 0)]),
    });
    const pendingInvites = new FixturePendingInvites(engine);

    expect(pendingInvites.confirm(IMMEDIATE_REFERENCE).status).toBe("served");
    expect(pendingInvites.confirm(IMMEDIATE_REFERENCE).status).toBe("unavailable");
  });
});
