// An invitation arriving on this window's deep link — to a DIFFERENT session than
// the one on screen, which is what a deep-link invitation always is: nobody is
// invited to a room they are already in. The members section draws the notice from
// the first tick, and the confirmation opens on a press rather than by itself.
//
// THREE OF THEM AND ONE OUTSTANDING LINK, so the queue's "behind it" reading is
// reachable and every arm of the outcome union has a beat somebody can actually press
// their way to. They settle differently on purpose: the first is the ordinary
// success; the second is the authentication detour, a ceremony main drives while
// holding the reference across it, so the confirmation stays open on a progress
// reading with nothing to press; the third is the handle that stopped resolving,
// which is what a person meets when this window held its place longer than the bound
// allows and is the terminal that lets such a prompt be put away at all.
//
// AND THE FOURTH ARRIVAL IS NOT AN INVITATION. A deep link whose preview never
// reached the control plane mints no reference, so it arrives on its own table keyed
// by the opaque attempt handle a retry is dispatched on. Pressing that retry re-drives
// the preview and publishes the invitation below it, whose first confirmation could
// not be PUT — nothing was decided — and whose second one joins. That chain is the
// only way the two handle-side outcome arms are reachable from a fixture at all, and
// it is scripted here rather than described because a surface built against arms no
// scenario can reach is a surface nobody has looked at.

import {
  INVITED_SESSION_AUDIT,
  INVITED_SESSION_DESIGN,
  INVITED_SESSION_INCIDENT,
  INVITED_SESSION_ROADMAP,
  MEMBERSHIP_FROM_INVITE,
  MEMBERSHIP_FROM_RETRY,
  PENDING_ATTEMPT_UNREACHED,
  PENDING_REFERENCE_AUDIT,
  PENDING_REFERENCE_DESIGN,
  PENDING_REFERENCE_LAPSED,
  PENDING_REFERENCE_RECHECKED,
} from "./identifiers.js";
import type { ConsoleScenario } from "../../scenario-runtime/index.js";

/** The three invitations this window's deep link delivers, and how each settles. */
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
  },
  {
    atMs: 0,
    invite: {
      reference: PENDING_REFERENCE_LAPSED,
      sessionId: INVITED_SESSION_INCIDENT,
      joinMode: "viewer",
      expiresAt: "2026-01-09T10:05:00.000Z",
      sessionName: "Incident review — relay sweep",
      inviterDisplayName: "Tomás Herrera",
    },
    // The reference's own bound is shorter than the invitation's, so a card left open
    // outlives the handle behind it while the link itself is still good. Terminal, and
    // about the HANDLE — which is why the reading it draws says to follow the link
    // again rather than to ask for a fresh one.
    onConfirm: {
      kind: "reference-invalid",
      reference: PENDING_REFERENCE_LAPSED,
      reason: "expired",
    },
  },
];

/** The one deep link this window could not check, and what re-driving it produces. */
export const COLLABORATION_PENDING_INVITE_ATTEMPTS: NonNullable<
  ConsoleScenario["pendingInviteAttempts"]
> = [
  {
    atMs: 0,
    attempt: PENDING_ATTEMPT_UNREACHED,
    onRetry: {
      invite: {
        reference: PENDING_REFERENCE_RECHECKED,
        sessionId: INVITED_SESSION_ROADMAP,
        joinMode: "collaborator",
        expiresAt: "2026-01-08T10:05:00.000Z",
        sessionName: "Roadmap sync — V1 shell",
        inviterDisplayName: "Priya Raman",
      },
      // The acceptance that could not be PUT, which is neither a join nor a refusal:
      // nothing about this invitation was decided, so the wire marks it retryable and
      // the act that answers it is the same confirmation put again.
      onConfirm: {
        kind: "unavailable",
        reference: PENDING_REFERENCE_RECHECKED,
        retryable: true,
      },
      // What the same confirmation, put again, produces. The recovery reaches an end
      // here rather than looping: main still held the reference, so the second act is
      // the one that joins.
      onReconfirm: {
        kind: "joined",
        reference: PENDING_REFERENCE_RECHECKED,
        sessionId: INVITED_SESSION_ROADMAP,
        membershipId: MEMBERSHIP_FROM_RETRY,
        role: "collaborator",
      },
    },
  },
];
