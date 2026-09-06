// One invitation and one reading of it, built the same way by every suite that needs
// them.
//
// Hoisted on the second use: the unit suite renders the card in happy-dom and the
// browser tier renders it in Chromium, and two literals for one shape would be two
// places a member added to `GrowthPendingInvite` has to be remembered.

import type { GrowthPendingInvite } from "../../bridge/index.js";
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
