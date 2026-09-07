// The pending-invite namespace's harness: the frames a case scripts, and the drains
// that read a feed without waiting on it.
//
// It is here rather than inside either test file because both of them drive the same
// namespace through the same scripted shapes. `fixture-pending-invites.test.ts` is
// about WHEN a frame reaches a feed — the two triggers, the single-use rule, the two
// brands — and `fixture-pending-invites.ordering.test.ts` is about the ORDER a feed
// releases what is due in. A second copy of `pendingFrame` would be a second answer to
// what a scripted invitation looks like, and the two files would drift in exactly the
// place a merge rule is decided.

import type { FixtureGrowthStream } from "./fixture-growth-stream.js";
import { unscriptedScenario } from "./fixture-bridge.test-support.js";
import type {
  GrowthInviteAttempt,
  GrowthInviteOutcome,
  GrowthPendingInviteState,
} from "../growth-values/index.js";
import type {
  ConsoleScenario,
  ScenarioPendingInviteAttemptFrame,
  ScenarioPendingInviteFrame,
} from "../scenario-runtime/index.js";

/** The reference the frames below are keyed by. Opaque, as `I-023-5` requires. */
export const LATE_REFERENCE = "pending-reference-late";
export const IMMEDIATE_REFERENCE = "pending-reference-immediate";

/**
 * The handle a deep link that never reached the control plane is retried by.
 *
 * Branded once, here, because the brand's whole claim is that nothing outside the
 * wire mints one: a case that cast at every use would demonstrate the opposite.
 */
export const UNREACHED_ATTEMPT = "pending-attempt-unreached" as GrowthInviteAttempt;

/** The reference the retry's own preview mints. Distinct from every attempt handle. */
export const RECHECKED_REFERENCE = "pending-reference-rechecked";

/** The tick the late frame is scripted at, comfortably past a console's first paint. */
export const LATE_FRAME_TICK_MS = 400;

/** One scripted invitation, arriving at the tick the case names. */
export function pendingFrame(reference: string, atMs: number): ScenarioPendingInviteFrame {
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
export function scenarioWithFrames(frames: readonly ScenarioPendingInviteFrame[]): ConsoleScenario {
  return { ...unscriptedScenario("pending-invite-delivery"), pendingInvites: frames };
}

/** One deep link that could not be checked, and the invitation retrying it mints. */
export function attemptFrame(atMs: number): ScenarioPendingInviteAttemptFrame {
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
export function scenarioWithAttempts(
  frames: readonly ScenarioPendingInviteAttemptFrame[],
): ConsoleScenario {
  return { ...unscriptedScenario("pending-invite-retry"), pendingInviteAttempts: frames };
}

/**
 * A scenario carrying both tables, so one advance can make an entry in each due.
 *
 * The shape the ordering rule is about: two tables, one feed, and a tick apiece.
 */
export function scenarioWithBothTables(
  invitations: readonly ScenarioPendingInviteFrame[],
  attempts: readonly ScenarioPendingInviteAttemptFrame[],
): ConsoleScenario {
  return {
    ...unscriptedScenario("pending-invite-ordering"),
    pendingInvites: invitations,
    pendingInviteAttempts: attempts,
  };
}

/**
 * Drain whatever a feed is holding right now, without waiting for more.
 *
 * `queuedCount` is read first and exactly that many frames are taken, because the
 * iteration PARKS on an open feed with nothing queued — a drain that asked for one
 * more would hang the case rather than fail it, which is the difference between a
 * red run and a timed-out one.
 */
export async function drainFrames(
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
export async function drain(
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
export async function drainOutcomes(
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
