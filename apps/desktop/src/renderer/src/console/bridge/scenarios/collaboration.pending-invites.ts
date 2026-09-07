// An invitation arriving on this window's deep link — to a DIFFERENT session than
// the one on screen, which is what a deep-link invitation always is: nobody is
// invited to a room they are already in. The members section draws the notice from
// the first tick, and the confirmation opens on a press rather than by itself.
//
// TWO OF THEM, so the queue's "behind it" reading is reachable, and the two settle
// differently on purpose: the first is the ordinary success, and the second is the
// authentication detour whose retry — the one arm where trying again is a remedy —
// has nowhere else to be shown. The retry succeeds, so the whole two-attempt path
// is walkable from this scenario alone.

import {
  INVITED_SESSION_AUDIT,
  INVITED_SESSION_DESIGN,
  MEMBERSHIP_FROM_INVITE,
  MEMBERSHIP_FROM_RETRY,
  PENDING_REFERENCE_AUDIT,
  PENDING_REFERENCE_DESIGN,
} from "./collaboration.identifiers.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

/** The two invitations this window's deep link delivers, and how each settles. */
export const COLLABORATION_PENDING_INVITES: NonNullable<ConsoleScenario["pendingInvites"]> = [
  {
    atMs: 0,
    invite: {
      reference: PENDING_REFERENCE_DESIGN,
      sessionId: INVITED_SESSION_DESIGN,
      joinMode: "collaborator",
      expiresAt: "2026-01-08T10:05:00.000Z",
      sessionName: "Design review — Q1 shell",
      inviterDisplayName: "Priya Raman",
    },
    onConfirm: {
      kind: "joined",
      reference: PENDING_REFERENCE_DESIGN,
      sessionId: INVITED_SESSION_DESIGN,
      membershipId: MEMBERSHIP_FROM_INVITE,
      role: "collaborator",
    },
  },
  {
    atMs: 0,
    invite: {
      // Both display facts absent, and `null` rather than omitted: the preview
      // ANSWERED and carried nothing — a different reading from a preview never
      // put, and the one the confirmation's absences are written for.
      reference: PENDING_REFERENCE_AUDIT,
      sessionId: INVITED_SESSION_AUDIT,
      joinMode: "viewer",
      expiresAt: "2026-01-02T10:05:00.000Z",
      sessionName: null,
      inviterDisplayName: null,
    },
    onConfirm: {
      kind: "authentication-required",
      reference: PENDING_REFERENCE_AUDIT,
    },
    onRetry: {
      kind: "joined",
      reference: PENDING_REFERENCE_AUDIT,
      sessionId: INVITED_SESSION_AUDIT,
      membershipId: MEMBERSHIP_FROM_RETRY,
      role: "viewer",
    },
  },
];
