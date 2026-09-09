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
//
// NOR IS THE FIFTH, AND THE FIFTH IS THE ONE WITH NOTHING TO PRESS. A link the control
// plane REFUSED previews as far as the transport is concerned and is answered with a
// typed code, so it mints neither a reference nor an attempt handle: the person is owed
// the explanation and no act at all. The three below are the codes a followed link
// actually meets — one past its expiry, one the sender took back, and one somebody has
// already accepted — and they are three rather than one because the acceptance-side
// copy is a sentence per code, so a deck carrying one would leave the other two
// renderings reachable from nowhere. Every code is registered on this plane and its
// `detail` is the sentence the wire would have sent, verbatim: the notice prints the
// wire's own words beside the console's, and a fixture composing a sentence for a code
// no plane mints would be teaching a shape the surface will never meet.

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
import type { ConsoleScenario } from "../runtime/index.js";

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

/**
 * The three links this window followed and the control plane turned down.
 *
 * NO HANDLE ON ANY ROW, which is why the table is a list and why nothing here scripts
 * an outcome: a refused preview admits no act, so there is no confirmation to answer
 * and no retry to re-drive. The ticks are staggered rather than shared so the queue
 * reaches them one at a time — each is its own terminal explanation, and three arriving
 * on one tick would put two of them behind a head nobody had read yet.
 */
export const COLLABORATION_PENDING_INVITE_REFUSALS: NonNullable<
  ConsoleScenario["pendingInviteRefusals"]
> = [
  {
    // The reading a person meets most: a link whose invitation is past the instant it
    // carried. The sentence names that instant, because "expired" without one leaves a
    // reader unable to tell a link they sat on from one that was stale when it arrived.
    atMs: 220,
    refusal: {
      code: "invite.expired",
      detail: "This invitation expired on 2 January 2026 at 10:05 UTC.",
    },
  },
  {
    // The sender took it back. Terminal in the other direction — nothing about the
    // link was wrong and there is still nothing to press.
    atMs: 260,
    refusal: {
      code: "invite.revoked",
      detail: "The person who sent this invitation revoked it.",
    },
  },
  {
    // The invitation WORKED — possibly for this very person on another machine — which
    // is the one refusal whose honest reading points at a session rather than at a
    // failure, and it is unreachable from a deck that carries no refused row.
    atMs: 300,
    refusal: {
      code: "invite.already_accepted",
      detail: "This invitation has already been accepted.",
    },
  },
];
