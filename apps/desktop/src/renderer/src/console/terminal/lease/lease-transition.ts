// What ONE `pty.control_changed` event says, and nothing about what a log of them
// folds to.
//
// The two questions were one module, and they are not one job. This half is a
// READER: it holds the wire vocabulary the daemon sends, the shape each reason
// obliges the payload to have, the two ways an event is read off that payload, and
// the sentence one transition renders as. It knows nothing about a viewer, a holding
// node, a ledger cap, or which of five holdings the surface settles into — all of
// which are `lease-model.ts`'s, because all of them are properties of the SEQUENCE
// rather than of the event.
//
// The split is along that seam and not along a line count. A reader can be driven
// with one event and no session; the fold cannot be driven at all without a log. So
// each side is testable on its own terms, and the fold imports the reader rather
// than restating any part of it.
//
// `Spec-023 §Console Design (Meridian)` 8.8 gives both halves their one hard rule —
// **the holder is a wire field and is never derived from the last observed claim** —
// and this is where that rule is enforced, because this is where a payload becomes a
// reading at all.
//
// THREE AUTOMATIC REASONS, KEPT DISTINCT. 8.8 requires every transition to render as
// a ledger line naming its reason, and the three automatic ones — the holder
// disconnected, the holder lost authorization, the acquiring agent run left its
// running state — to stay distinguishable. The sentence table below is total over the
// closed set, so a sixth reason is a compile error rather than a line that silently
// reads like one of the five.

import { readWireString } from "../../core/index.js";
import type { ConsoleSessionEvent } from "../../store/index.js";

/** The event a lease transition arrives on. Wire-verbatim, rendered as received. */
export const TERMINAL_LEASE_EVENT_KIND = "pty.control_changed";

/**
 * The transition reasons, as `Spec-006` closes the set.
 *
 * Declared once as a tuple with the union derived from it. No contract package
 * exports this vocabulary yet — `Plan-023 §Console growth slate` row 3 is what
 * registers the terminal's renderer obligations — so this is the console's single
 * declaration of it, and every consumer (the sentence table, the guard, the
 * family's own scenario test) derives from this array rather than restating it.
 */
export const TERMINAL_LEASE_TRANSITION_REASONS = [
  "taken",
  "released",
  "auto_released_disconnect",
  "auto_released_authorization_lost",
  "auto_released_run_idle",
] as const;

/** One transition reason. Derived, never restated. */
export type TerminalLeaseTransitionReason = (typeof TERMINAL_LEASE_TRANSITION_REASONS)[number];

/**
 * What each reason says the holder looks like AFTER it, which is the other half of
 * reading a transition.
 *
 * A reason alone was taken as the whole reading, and the holder was then read
 * tolerantly beside it: any non-empty string became a holder and everything else
 * became the free lease. So a `taken` whose payload named nobody was presented as a
 * FREE lease — a shell the daemon has just handed to someone, offered here as one
 * anybody may claim — and a `released` that carried the viewer's own id was presented
 * as `held-by-you`, which opens stdin until the daemon rejects the writes. Neither
 * payload is a transition this build understands, and the honest reading of a
 * transition it cannot understand is the unread one.
 *
 * Two shapes and not five, because the direction is what the holder member reports:
 * a take names who holds it, and every release — the operator's own and the three
 * automatic ones alike — leaves nobody holding it. The member is documented as who
 * holds the lease AFTER the transition, so a release that named a holder is
 * contradicting itself rather than naming the participant it took the shell from;
 * that participant is the `previousHolderParticipantId` the same payload carries.
 *
 * The check is HERE because there is nowhere else for it. `packages/contracts`
 * registers `pty.control_changed` as an event type and no payload variant for it, so
 * this module is the console's one declaration of the shape and the tolerant envelope
 * above it validates nothing. Keyed by the reason union so a sixth reason is a
 * compile error rather than a payload nothing checks.
 */
const TRANSITION_HOLDER_SHAPES: Readonly<
  Record<TerminalLeaseTransitionReason, "names-the-holder" | "names-nobody">
> = {
  taken: "names-the-holder",
  released: "names-nobody",
  auto_released_disconnect: "names-nobody",
  auto_released_authorization_lost: "names-nobody",
  auto_released_run_idle: "names-nobody",
};

/** A reason the wire sent, or `undefined` when it sent something outside the set. */
export function asTerminalLeaseTransitionReason(
  candidate: unknown,
): TerminalLeaseTransitionReason | undefined {
  return TERMINAL_LEASE_TRANSITION_REASONS.find((reason) => reason === candidate);
}

/** One transition, as the ledger renders it. */
export interface TerminalLeaseTransition {
  /** The event's position in the session log. Stable across a replay. */
  readonly sequence: number;
  readonly occurredAtIso: string;
  readonly reason: TerminalLeaseTransitionReason;
  /** Who holds it after this transition; `null` is the free lease, explicitly. */
  readonly holderParticipantId: string | null;
  readonly previousHolderParticipantId: string | null;
  /** Who the log attributes the event to, when it names anyone. */
  readonly actorId: string | undefined;
}

/**
 * A lease transition the console could not read, kept so the surface can say so.
 *
 * The wire moved the lease and this build does not understand the move. Skipping it
 * would leave the previous holder standing as the newest state, which is the one
 * reading that lets a person keep typing into a shell the daemon has taken from
 * them — so the transition is carried in its own right, with whatever the wire
 * called it, and the projection settles into the arm that writes nothing.
 */
export interface TerminalLeaseUnreadTransition {
  /** The event's position in the session log. Stable across a replay. */
  readonly sequence: number;
  readonly occurredAtIso: string;
  /**
   * The reason the wire sent, when it sent a non-empty string — verbatim, for the
   * operator to paste somewhere. `undefined` when the payload named none at all,
   * which is the same fact with less to say about it.
   */
  readonly reason: string | undefined;
}

/**
 * Read one transition off an event, or `undefined` when the payload is not one.
 *
 * Both halves have to agree. A recognised reason with a holder shape that
 * contradicts it is not a transition this build can read, and returning it with the
 * holder quietly normalised is how a malformed `taken` became a free lease and a
 * `released` carrying the viewer became `held-by-you`.
 */
export function readTerminalLeaseTransition(
  event: ConsoleSessionEvent,
): TerminalLeaseTransition | undefined {
  const payload = event.payload;
  if (payload === undefined) {
    return undefined;
  }
  const reason = asTerminalLeaseTransitionReason(payload["reason"]);
  if (reason === undefined) {
    return undefined;
  }
  const holderParticipantId = readParticipantId(payload["holderParticipantId"]);
  const namesAHolder = holderParticipantId !== null;
  if (namesAHolder !== (TRANSITION_HOLDER_SHAPES[reason] === "names-the-holder")) {
    return undefined;
  }
  return {
    sequence: event.sequence,
    occurredAtIso: event.occurredAt,
    reason,
    holderParticipantId,
    previousHolderParticipantId: readParticipantId(payload["previousHolderParticipantId"]),
    actorId: event.actorId,
  };
}

/**
 * Read one unreadable transition off its event.
 *
 * Separate from {@link readTerminalLeaseTransition} because the two answer different
 * questions: that one asks whether the console understands the move, this one records
 * the move it does not understand. The reason is carried verbatim and only when the
 * wire sent a non-empty string — anything else is a payload with nothing to name,
 * and a stringified object would be the surface inventing a vocabulary.
 */
export function readTerminalLeaseUnreadTransition(
  event: ConsoleSessionEvent,
): TerminalLeaseUnreadTransition {
  const reason = event.payload?.["reason"];
  return {
    sequence: event.sequence,
    occurredAtIso: event.occurredAt,
    reason: readWireString(reason),
  };
}

/**
 * A participant id, or the free lease.
 *
 * Anything that is not a non-empty string reads as the free lease rather than as
 * an identity: an absent member and an explicit null both mean "nobody holds it",
 * and a surface that treated a missing member as a holder would attribute the
 * shell to `undefined`.
 *
 * The predicate is the console's one wire-string reading; what this module owns is
 * the mapping of its absence onto the free lease, which is a lease fact and not a
 * wire one.
 */
function readParticipantId(candidate: unknown): string | null {
  return readWireString(candidate) ?? null;
}

/**
 * The sentence one transition renders as.
 *
 * Total over the closed reason set by construction, so the three automatic reasons
 * cannot collapse into one line. Labels are the caller's — the reader knows
 * participant ids, and a display name is the roster's to supply — so a caller with
 * no name passes the id and the sentence still names somebody.
 */
export function terminalLeaseTransitionSentence(
  transition: TerminalLeaseTransition,
  labelFor: (participantId: string) => string,
): string {
  const holderLabel =
    transition.holderParticipantId === null ? null : labelFor(transition.holderParticipantId);
  const previousLabel =
    transition.previousHolderParticipantId === null
      ? null
      : labelFor(transition.previousHolderParticipantId);
  const previous = previousLabel ?? "The previous holder";

  switch (transition.reason) {
    case "taken":
      return `${holderLabel ?? "Someone"} took the shell.`;
    case "released":
      return `${previous} released the shell.`;
    case "auto_released_disconnect":
      return `${previous} disconnected, so the shell was released.`;
    case "auto_released_authorization_lost":
      return `${previous} lost authorization, so the shell was released.`;
    case "auto_released_run_idle":
      return `${previous}'s run left its running state, so the shell was released.`;
  }
}
