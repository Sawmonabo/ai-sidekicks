// One invitation, one reading of it, and the scenario the adapter suites drive — built
// the same way by every suite that needs them.
//
// Hoisted on the second use: the unit suite renders the card in happy-dom and the
// browser tier renders it in Chromium, and two literals for one shape would be two
// places a member added to `GrowthPendingInvite` has to be remembered.

import type { GrowthInviteAttempt, GrowthPendingInvite } from "../../bridge/index.js";
// The three arm types by their declaring module rather than through the family door:
// nothing in production names an arm on its own — every reader takes the union — so a
// door line for them would be one the barrel census fails.
import type {
  GrowthPendingInviteReady,
  GrowthPendingInviteRefused,
  GrowthPendingInviteUnavailable,
} from "../../bridge/growth-values/invites.js";
import { createFixtureBridge } from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { PendingInviteAdapter } from "./pending-invite.js";
import {
  EMPTY_PENDING_INVITE_SNAPSHOT,
  type PendingInviteSnapshot,
} from "./pending-invite-reading.js";

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

/**
 * The attempt handle under test, and the one place this suite mints one.
 *
 * Branded with a cast HERE rather than at each case, because the brand's whole claim
 * is that nothing outside the wire mints one: a suite that cast at every use would be
 * demonstrating the opposite of what the type is for.
 */
export const PENDING_INVITE_ATTEMPT = "pending-attempt-under-test" as GrowthInviteAttempt;

/** The ready arm, as the pending feed carries it. */
export function readyPreview(
  overrides: Partial<GrowthPendingInvite> = {},
): GrowthPendingInviteReady {
  return { status: "ready", ...pendingInvite(overrides) };
}

/** A preview the control plane refused. Terminal, and it carries no reference. */
export function refusedPreview(
  overrides: Partial<Omit<GrowthPendingInviteRefused, "status">> = {},
): GrowthPendingInviteRefused {
  return {
    status: "refused",
    code: "invite.expired",
    detail: "Invite has expired and can no longer be accepted",
    ...overrides,
  };
}

/** A preview that could not be put at all, carrying the handle a retry is sent on. */
export function unavailablePreview(
  attempt: GrowthInviteAttempt = PENDING_INVITE_ATTEMPT,
): GrowthPendingInviteUnavailable {
  return { status: "unavailable", retryable: true, attempt };
}

/** One reading of that invitation, with nothing in flight and nothing settled. */
export function pendingInviteSnapshot(
  overrides: Partial<PendingInviteSnapshot> = {},
): PendingInviteSnapshot {
  return {
    ...EMPTY_PENDING_INVITE_SNAPSHOT,
    invite: pendingInvite(),
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

/**
 * A started adapter over the real fixture port, with both feeds drained once.
 *
 * Hoisted on the second use, like the scenario above it: three suites drive the
 * lifecycle and each of them needs it open before it can assert anything.
 */
export async function startedAdapter(
  scenario: ConsoleScenario = scenarioWithArrivals(),
): Promise<PendingInviteAdapter> {
  const adapter = new PendingInviteAdapter(createFixtureBridge({ scenario }));
  // The reading's own `subscribe` read, which is what opens both feeds.
  adapter.requestRead("subscribe");
  await settleFeeds();
  return adapter;
}

/** Let both feeds hand over whatever they are holding. */
export async function settleFeeds(): Promise<void> {
  await crossMacrotaskBoundary();
  await crossMacrotaskBoundary();
}
