// One invitation, one reading of it, and the scenario the adapter suites drive — built
// the same way by every suite that needs them.
//
// Hoisted on the second use: the unit suite renders the card in happy-dom and the
// browser tier renders it in Chromium, and two literals for one shape would be two
// places a member added to `GrowthPendingInvite` has to be remembered.

import type { GrowthPendingInvite } from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import type { PendingInviteSnapshot } from "./pending-invite.js";

/** The reference under test. Opaque, as `Plan-023 §Invariants` I-023-10 requires. */
export const PENDING_INVITE_REFERENCE = "pending-ref-under-test";

/** The session the invitation is to. This window is not in it. */
export const INVITED_SESSION_ID = "019b7910-0009-7000-8000-000000000001";

/**
 * One invitation, with both display facts absent.
 *
 * ABSENT BY DEFAULT rather than filled in, because that is the reading a case is most
 * likely to get wrong: a preview that answered and carried no name is a different fact
 * from a preview never put, and a builder that supplied a name would let every case
 * pass over a card that never rendered the absence.
 */
export function pendingInvite(overrides: Partial<GrowthPendingInvite> = {}): GrowthPendingInvite {
  return {
    reference: PENDING_INVITE_REFERENCE,
    sessionId: INVITED_SESSION_ID,
    joinMode: "collaborator",
    expiresAt: "2026-01-08T10:05:00.000Z",
    sessionName: null,
    inviterDisplayName: null,
    ...overrides,
  };
}

/** One reading of that invitation, with nothing in flight and nothing settled. */
export function pendingInviteSnapshot(
  overrides: Partial<PendingInviteSnapshot> = {},
): PendingInviteSnapshot {
  return {
    invite: pendingInvite(),
    waitingBehind: 0,
    outcome: undefined,
    actInFlight: undefined,
    actRefusal: undefined,
    feedRefusal: undefined,
    ...overrides,
  };
}

// THE ADAPTER SUITES' OWN SCAFFOLDING, hoisted on the second use when the feed cases
// moved to `pending-invite.feeds.test.ts`. The scenario below and the settle helper
// under it are what BOTH suites drive the adapter with, and two copies of a scenario
// would be two invitation tables a member added to `GrowthPendingInvite` has to be
// remembered in — the failure this module already exists to prevent for one literal.

const SECOND_SESSION = "019b7914-0002-7000-8000-000000000002";

/** The first arrival's reference. Its outcome is a join. */
export const FIRST_REFERENCE = "pending-ref-first";

/** The second arrival's reference. Its outcome needs authentication, then joins. */
export const SECOND_REFERENCE = "pending-ref-second";

/** The session the first arrival is to. */
export const FIRST_SESSION = "019b7914-0001-7000-8000-000000000001";

/** The membership either arrival lands on, once it joins. */
export const MEMBERSHIP = "019b7914-0003-7000-8000-000000000003";

/**
 * A scenario carrying two arrivals: one that joins, one that needs authentication.
 *
 * Two rather than one, because half of what this adapter does is decide WHICH
 * invitation an answer is about — a suite with a single reference could not tell a
 * matched outcome from an assumed one.
 */
export function scenarioWithArrivals(): ConsoleScenario {
  return {
    id: "collaboration-pending-invite-test",
    label: "Two invitations waiting",
    purpose: "Drives the deep-link lifecycle: arrival, confirmation, retry, dismissal.",
    sessionId: "session-pending-invite-test",
    participantIdsInJoinOrder: [],
    beats: [],
    replies: [],
    startedAtIso: "2026-01-01T10:05:00.000Z",
    pendingInvites: [
      {
        atMs: 0,
        invite: {
          reference: FIRST_REFERENCE,
          sessionId: FIRST_SESSION,
          joinMode: "collaborator",
          expiresAt: "2026-01-08T10:05:00.000Z",
          sessionName: "Design review",
          inviterDisplayName: "Priya Raman",
        },
        onConfirm: {
          kind: "joined",
          reference: FIRST_REFERENCE,
          sessionId: FIRST_SESSION,
          membershipId: MEMBERSHIP,
          role: "collaborator",
        },
      },
      {
        atMs: 0,
        invite: {
          reference: SECOND_REFERENCE,
          sessionId: SECOND_SESSION,
          joinMode: "viewer",
          expiresAt: "2026-01-02T10:05:00.000Z",
          sessionName: null,
          inviterDisplayName: null,
        },
        onConfirm: { kind: "authentication-required", reference: SECOND_REFERENCE },
        onRetry: {
          kind: "joined",
          reference: SECOND_REFERENCE,
          sessionId: SECOND_SESSION,
          membershipId: MEMBERSHIP,
          role: "viewer",
        },
      },
    ],
  };
}

/** Let both feeds hand over whatever they are holding. */
export async function settleFeeds(): Promise<void> {
  await crossMacrotaskBoundary();
  await crossMacrotaskBoundary();
}
