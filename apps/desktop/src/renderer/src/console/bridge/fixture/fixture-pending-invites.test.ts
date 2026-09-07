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
import type {
  GrowthInviteAttempt,
  GrowthInviteOutcome,
  GrowthPendingInviteState,
} from "../growth-values/index.js";
import { ScenarioEngine } from "../scenario-runtime/index.js";
import type {
  ConsoleScenario,
  ScenarioPendingInviteAttemptFrame,
  ScenarioPendingInviteFrame,
} from "../scenario-runtime/index.js";

/** The reference the frames below are keyed by. Opaque, as `I-023-5` requires. */
const LATE_REFERENCE = "pending-reference-late";
const IMMEDIATE_REFERENCE = "pending-reference-immediate";

/**
 * The handle a deep link that never reached the control plane is retried by.
 *
 * Branded once, here, because the brand's whole claim is that nothing outside the
 * wire mints one: a case that cast at every use would demonstrate the opposite.
 */
const UNREACHED_ATTEMPT = "pending-attempt-unreached" as GrowthInviteAttempt;

/** The reference the retry's own preview mints. Distinct from every attempt handle. */
const RECHECKED_REFERENCE = "pending-reference-rechecked";

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

/** One deep link that could not be checked, and the invitation retrying it mints. */
function attemptFrame(atMs: number): ScenarioPendingInviteAttemptFrame {
  return {
    atMs,
    attempt: UNREACHED_ATTEMPT,
    onRetry: {
      invite: {
        reference: RECHECKED_REFERENCE,
        sessionId: `session-for-${RECHECKED_REFERENCE}`,
        joinMode: "collaborator",
        expiresAt: "2026-01-08T10:05:00.000Z",
        sessionName: null,
        inviterDisplayName: null,
      },
      onConfirm: {
        kind: "joined",
        reference: RECHECKED_REFERENCE,
        sessionId: `session-for-${RECHECKED_REFERENCE}`,
        membershipId: `membership-from-${RECHECKED_REFERENCE}`,
        role: "collaborator",
      },
    },
  };
}

/** A scenario carrying exactly the attempt frames a case is about. */
function scenarioWithAttempts(
  frames: readonly ScenarioPendingInviteAttemptFrame[],
): ConsoleScenario {
  return { ...unscriptedScenario("pending-invite-retry"), pendingInviteAttempts: frames };
}

/**
 * Drain whatever a feed is holding right now, without waiting for more.
 *
 * `queuedCount` is read first and exactly that many frames are taken, because the
 * iteration PARKS on an open feed with nothing queued — a drain that asked for one
 * more would hang the case rather than fail it, which is the difference between a
 * red run and a timed-out one.
 */
async function drainFrames(
  feed: FixtureGrowthStream<GrowthPendingInviteState>,
): Promise<readonly GrowthPendingInviteState[]> {
  const taken: GrowthPendingInviteState[] = [];
  const waiting = feed.queuedCount;
  if (waiting === 0) {
    return taken;
  }
  for await (const arrival of feed.events) {
    taken.push(arrival);
    if (taken.length === waiting) {
      break;
    }
  }
  return taken;
}

/** The references an invitation-only feed served, refusing any other arm loudly. */
async function drain(
  feed: FixtureGrowthStream<GrowthPendingInviteState>,
): Promise<readonly string[]> {
  return (await drainFrames(feed)).map((arrival) => {
    // A frame table of invitations carries only the ready arm; any other frame here
    // is the fixture misbehaving, and the case should say so rather than skip it.
    if (arrival.status !== "ready") {
      throw new Error(`the pending feed served a ${arrival.status} frame`);
    }
    return arrival.reference;
  });
}

/** Everything one outcome feed is holding right now, without waiting for more. */
async function drainOutcomes(
  feed: FixtureGrowthStream<GrowthInviteOutcome>,
): Promise<readonly GrowthInviteOutcome[]> {
  const taken: GrowthInviteOutcome[] = [];
  const waiting = feed.queuedCount;
  if (waiting === 0) {
    return taken;
  }
  for await (const outcome of feed.events) {
    taken.push(outcome);
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
