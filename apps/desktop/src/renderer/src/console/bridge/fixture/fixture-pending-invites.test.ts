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
import type { FixtureGrowthStream } from "./fixture-growth-stream.js";
import { unscriptedScenario } from "./fixture-bridge.test-support.js";
import type { GrowthPendingInvite } from "../growth-values/index.js";
import { ScenarioEngine } from "../scenario-runtime/index.js";
import type { ConsoleScenario, ScenarioPendingInviteFrame } from "../scenario-runtime/index.js";

/** The reference the frames below are keyed by. Opaque, as `I-023-5` requires. */
const LATE_REFERENCE = "pending-reference-late";
const IMMEDIATE_REFERENCE = "pending-reference-immediate";

/** The tick the late frame is scripted at, comfortably past a console's first paint. */
const LATE_FRAME_TICK_MS = 400;

/** One scripted invitation, arriving at the tick the case names. */
function pendingFrame(reference: string, atMs: number): ScenarioPendingInviteFrame {
  return {
    atMs,
    invite: {
      reference,
      sessionId: `session-for-${reference}`,
      joinMode: "collaborator",
      expiresAt: "2026-01-08T10:05:00.000Z",
      sessionName: "Design review — Q1 shell",
      inviterDisplayName: "Priya Raman",
    },
    onConfirm: {
      kind: "joined",
      reference,
      sessionId: `session-for-${reference}`,
      membershipId: `membership-from-${reference}`,
      role: "collaborator",
    },
  };
}

/** A scenario carrying exactly the frames a case is about, and nothing else. */
function scenarioWithFrames(frames: readonly ScenarioPendingInviteFrame[]): ConsoleScenario {
  return { ...unscriptedScenario("pending-invite-delivery"), pendingInvites: frames };
}

/**
 * Drain whatever a feed is holding right now, without waiting for more.
 *
 * `queuedCount` is read first and exactly that many frames are taken, because the
 * iteration PARKS on an open feed with nothing queued — a drain that asked for one
 * more would hang the case rather than fail it, which is the difference between a
 * red run and a timed-out one.
 */
async function drain(feed: FixtureGrowthStream<GrowthPendingInvite>): Promise<readonly string[]> {
  const taken: string[] = [];
  const waiting = feed.queuedCount;
  if (waiting === 0) {
    return taken;
  }
  for await (const invite of feed.events) {
    taken.push(invite.reference);
    if (taken.length === waiting) {
      break;
    }
  }
  return taken;
}

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
