// The shared shell's write lease, projected from the log.
//
// `Spec-023 §Console Design (Meridian)` 8.8 gives this module its one hard rule:
// **the holder is a wire field and is never derived from the last observed
// claim**. So nothing here reads the outcome of a `session.takeControl` call.
// The lease state is a fold over `pty.control_changed` events — the registered
// event type whose payload carries the holder, the holder it replaced, and the
// reason — and a claim the console made changes the surface only when the
// transition it caused comes back on the log.
//
// That is not fastidiousness. A claim that succeeds and a claim whose broadcast
// the console never received look identical at the call site, and only one of
// them means the person may type. An optimistic surface would show a keyboard to
// somebody who does not hold the shell.
//
// WHY A PURE FOLD AND NOT A CLASS. The store's own projector discipline
// (`store/entities.ts`) is that a projector reads the event and nothing else, so
// a replayed prefix is deterministic and a reconnect heals by re-running it. The
// lease is exactly that shape: given the same events and the same viewer, the same
// state. A class holding the fold's result beside the store would be a second
// source of truth for a fact the log already orders.
//
// THREE AUTOMATIC REASONS, KEPT DISTINCT. 8.8 requires every transition to render
// as a ledger line naming its reason, and the three automatic ones — the holder
// disconnected, the holder lost authorization, the acquiring agent run left its
// running state — to stay distinguishable. The sentence table below is total over
// the closed set, so a sixth reason is a compile error rather than a line that
// silently reads like one of the five.

import type { ConsoleSessionEvent } from "../store/index.js";

/** The event a lease transition arrives on. Wire-verbatim, rendered as received. */
import { TERMINAL_LEASE_LEDGER_CAP } from "./constants.js";

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
 * Who holds the shell, from the viewer's seat.
 *
 * `not-checked` is not a synonym for `unheld`: 8.8 makes a free lease an explicit
 * state that reads differently from a suppressed one, and "no transition has ever
 * been read" is neither. `unrecognized-transition` is a fifth answer for the same
 * kind of reason — the log carried a transition this build cannot read, so the
 * holder is neither the free lease nor whoever held it before. Declared as a tuple
 * for the reason every closed set here is.
 */
export const TERMINAL_LEASE_HOLDINGS = [
  "not-checked",
  "unheld",
  "held-by-you",
  "held-by-another",
  "unrecognized-transition",
] as const;

export type TerminalLeaseHolding = (typeof TERMINAL_LEASE_HOLDINGS)[number];

/**
 * Whether the control plane can vouch for the holder.
 *
 * 8.8: "Never shows a holder the control plane cannot vouch for. When the holding
 * node reads offline, `controlHolder` resolves to null and the surface renders
 * unheld." The wire answers that on a `runtimenode.roster` read whose carrying
 * member the shipped schema does not yet have, so the caller supplies the reading
 * from the log instead — `node-presence-model.ts` folds the registered
 * `runtime_node.*` events the store already holds. `not-checked` stays the honest
 * answer wherever that fold cannot name one host for the session's one shell.
 */
export const TERMINAL_HOLDER_VOUCHINGS = ["not-checked", "vouched", "unvouched"] as const;

export type TerminalHolderVouching = (typeof TERMINAL_HOLDER_VOUCHINGS)[number];

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

export interface TerminalLeaseState {
  readonly holding: TerminalLeaseHolding;
  /** The holder the wire named, or `null` for a free lease. Never inferred. */
  readonly holderParticipantId: string | null;
  readonly holderVouching: TerminalHolderVouching;
  /**
   * The node whose health made the holder unvouchable, when one did. Rendered so
   * the degraded line names it rather than saying "somewhere".
   */
  readonly unvouchedNodeId: string | undefined;
  /**
   * The newest transition the fold could not read, when one arrived after every
   * transition it could. Present means the lease state is unknown rather than
   * stale, and the surface says which transition lost it.
   */
  readonly unreadTransition: TerminalLeaseUnreadTransition | undefined;
  /** Newest last, capped at `TERMINAL_LEASE_LEDGER_CAP`. */
  readonly transitions: readonly TerminalLeaseTransition[];
  /**
   * Every transition the fold could READ, including the ones the cap dropped. An
   * unreadable one is counted nowhere here — it has no sentence and no ledger row,
   * and it is reported through `unreadTransition` instead.
   */
  readonly transitionCount: number;
}

/**
 * A reading of the host the lease holder sits on.
 *
 * Declared here, beside the fold that consumes it, and imported by
 * `node-presence-model.ts`, which produces it — the two sides of one seam share the
 * declaration rather than each spelling the shape out.
 */
export interface TerminalHoldingNodeReading {
  readonly nodeId: string;
  readonly isReachable: boolean;
}

/** What the fold needs beyond the events. */
export interface TerminalLeaseProjectionInput {
  /** The viewer, so `held-by-you` can be told from `held-by-another`. */
  readonly viewerParticipantId: string | undefined;
  /**
   * The holding node's reachability, when the caller could read one.
   *
   * Omitted means nothing was read, which is `not-checked` and NOT a claim that the
   * node is reachable. Passing `{ nodeId, isReachable: false }` is what a reading
   * that found the host offline produces, and it collapses the surface to unheld
   * while keeping the node's identity on screen.
   */
  readonly holdingNode?: TerminalHoldingNodeReading;
}

/** The state before any transition has been read. */
export const UNREAD_TERMINAL_LEASE: TerminalLeaseState = {
  holding: "not-checked",
  holderParticipantId: null,
  holderVouching: "not-checked",
  unvouchedNodeId: undefined,
  unreadTransition: undefined,
  transitions: [],
  transitionCount: 0,
};

/**
 * Fold a session's events into the lease state.
 *
 * Total and pure. Events of other kinds are skipped. A `pty.control_changed` this
 * build cannot read — a reason outside the closed set, a payload that carries
 * none — is NOT skipped: it is recorded as the unread transition and the
 * projection settles into the arm that shows no holder and writes nothing.
 *
 * That direction is the whole point. Skipping it left the transition before it
 * standing as the newest state, so a daemon that moved the lease under a reason a
 * later release introduced would leave this surface reading `held-by-you` and
 * stdin open for somebody who no longer holds the shell. An unread transition is
 * ignorance, and ignorance about a write lease reads as no lease at all.
 *
 * A later transition the fold CAN read clears it: the console understands the
 * current state again, and the state it understands is that transition's.
 */
export function projectTerminalLease(
  events: readonly ConsoleSessionEvent[],
  input: TerminalLeaseProjectionInput,
): TerminalLeaseState {
  const transitions: TerminalLeaseTransition[] = [];
  let transitionCount = 0;
  let unreadTransition: TerminalLeaseUnreadTransition | undefined;

  for (const event of events) {
    if (event.kind !== TERMINAL_LEASE_EVENT_KIND) {
      continue;
    }
    const transition = readTransition(event);
    if (transition === undefined) {
      unreadTransition = readUnreadTransition(event);
      continue;
    }
    unreadTransition = undefined;
    transitionCount += 1;
    transitions.push(transition);
    if (transitions.length > TERMINAL_LEASE_LEDGER_CAP) {
      transitions.shift();
    }
  }

  const newest = transitions.at(-1);
  const wireHolderParticipantId = newest === undefined ? null : newest.holderParticipantId;
  const vouching = readVouching(input.holdingNode);

  // Fail-closed, and in this order: an unvouchable holder AND an unread transition
  // each collapse to the free lease BEFORE the viewer comparison, so a surface can
  // never show "you hold it" on the strength of a node the control plane cannot
  // reach or a transition this build could not read.
  const holderParticipantId =
    vouching === "unvouched" || unreadTransition !== undefined ? null : wireHolderParticipantId;

  return {
    holding: readHolding({
      transitionCount,
      unreadTransition,
      holderParticipantId,
      viewerParticipantId: input.viewerParticipantId,
    }),
    holderParticipantId,
    holderVouching: vouching,
    unvouchedNodeId: vouching === "unvouched" ? input.holdingNode?.nodeId : undefined,
    unreadTransition,
    transitions,
    transitionCount,
  };
}

/**
 * The sentence one transition renders as.
 *
 * Total over the closed reason set by construction, so the three automatic reasons
 * cannot collapse into one line. Labels are the caller's — the fold knows
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

/**
 * Read one unreadable transition off its event.
 *
 * Separate from {@link readTransition} because the two answer different questions:
 * that one asks whether the console understands the move, this one records the
 * move it does not understand. The reason is carried verbatim and only when the
 * wire sent a non-empty string — anything else is a payload with nothing to name,
 * and a stringified object would be the surface inventing a vocabulary.
 */
function readUnreadTransition(event: ConsoleSessionEvent): TerminalLeaseUnreadTransition {
  const reason = event.payload?.["reason"];
  return {
    sequence: event.sequence,
    occurredAtIso: event.occurredAt,
    reason: typeof reason === "string" && reason !== "" ? reason : undefined,
  };
}

/** Read one transition off an event, or `undefined` when the payload is not one. */
function readTransition(event: ConsoleSessionEvent): TerminalLeaseTransition | undefined {
  const payload = event.payload;
  if (payload === undefined) {
    return undefined;
  }
  const reason = asTerminalLeaseTransitionReason(payload["reason"]);
  if (reason === undefined) {
    return undefined;
  }
  return {
    sequence: event.sequence,
    occurredAtIso: event.occurredAt,
    reason,
    holderParticipantId: readParticipantId(payload["holderParticipantId"]),
    previousHolderParticipantId: readParticipantId(payload["previousHolderParticipantId"]),
    actorId: event.actorId,
  };
}

/**
 * A participant id, or the free lease.
 *
 * Anything that is not a non-empty string reads as the free lease rather than as
 * an identity: an absent member and an explicit null both mean "nobody holds it",
 * and a surface that treated a missing member as a holder would attribute the
 * shell to `undefined`.
 */
function readParticipantId(candidate: unknown): string | null {
  return typeof candidate === "string" && candidate !== "" ? candidate : null;
}

function readVouching(
  holdingNode: TerminalLeaseProjectionInput["holdingNode"],
): TerminalHolderVouching {
  if (holdingNode === undefined) {
    return "not-checked";
  }
  return holdingNode.isReachable ? "vouched" : "unvouched";
}

/**
 * Which holding the fold settled on. Ordered fail-closed, hardest fact last.
 *
 * The unread arm comes first because it is a statement about the READING and not
 * about the lease: with a transition the console could not understand, neither
 * "nobody holds it" nor "you hold it" is something this surface knows, and the
 * only honest answers left are the two that disable writing.
 */
function readHolding(state: {
  readonly transitionCount: number;
  readonly unreadTransition: TerminalLeaseUnreadTransition | undefined;
  readonly holderParticipantId: string | null;
  readonly viewerParticipantId: string | undefined;
}): TerminalLeaseHolding {
  if (state.unreadTransition !== undefined) {
    return "unrecognized-transition";
  }
  if (state.transitionCount === 0) {
    return "not-checked";
  }
  if (state.holderParticipantId === null) {
    return "unheld";
  }
  return state.holderParticipantId === state.viewerParticipantId
    ? "held-by-you"
    : "held-by-another";
}
