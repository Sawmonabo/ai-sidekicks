// What a LOG of lease transitions folds to, from the viewer's seat.
//
// `lease-transition.ts` reads one event; this module reads a session. The two are
// split because they answer different questions and need different fixtures: a
// reading is a payload and a sentence, and a projection is an ordering, a viewer, a
// holding node, and a cap. Everything below is a property of the SEQUENCE — which of
// five holdings the surface settles into, whether the control plane can vouch for the
// holder, what an offline host did to the lease, and which transitions the ledger
// keeps.
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

import type { ConsoleSessionEvent } from "../../store/index.js";
import { TERMINAL_LEASE_LEDGER_CAP } from "../../core/index.js";
import {
  TERMINAL_LEASE_EVENT_KIND,
  readTerminalLeaseTransition,
  readTerminalLeaseUnreadTransition,
  type TerminalLeaseTransition,
  type TerminalLeaseUnreadTransition,
} from "./lease-transition.js";

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
 * What an offline node MEANS for this lease, which is not one sentence.
 *
 * The reading used to be a bare node id, projected whenever a roster read found the
 * host offline. But a lease can already be free when that happens — a `released`
 * transition and then the sole node dropping — and the surface then said "Nobody
 * holds the shell" and "The holding node … is offline" at once: one sentence naming a
 * holder the other says does not exist, about a machine the first says nobody is
 * using.
 *
 * So the two readings are told apart here, where the fold knows which one it made,
 * rather than left to a renderer to infer from a null holder it cannot attribute.
 * There IS something to say in both cases — an offline host is why the shell stays
 * read-only either way — and it is a different sentence, so the effect travels with
 * the node id and the line renders one sentence per member.
 *
 * `no-holder-shown` and not `already-free`, because it covers both ways this surface
 * ends up showing nobody: the newest readable transition was a release, and a
 * transition arrived that this build could not read at all. Neither is a holder the
 * node reading collapsed, and a sentence claiming one would be as wrong in the second
 * case as in the first.
 */
export const TERMINAL_OFFLINE_NODE_EFFECTS = ["holder-collapsed", "no-holder-shown"] as const;

export type TerminalOfflineNodeEffect = (typeof TERMINAL_OFFLINE_NODE_EFFECTS)[number];

/** An offline host, and what its being offline did to the lease. */
export interface TerminalOfflineNodeReading {
  readonly nodeId: string;
  readonly effect: TerminalOfflineNodeEffect;
}

export interface TerminalLeaseState {
  readonly holding: TerminalLeaseHolding;
  /** The holder the wire named, or `null` for a free lease. Never inferred. */
  readonly holderParticipantId: string | null;
  readonly holderVouching: TerminalHolderVouching;
  /**
   * The host a roster read found offline, and what that did to this lease, when one
   * was found offline. Rendered so the degraded line names the node rather than
   * saying "somewhere" — and says the right thing about the holder.
   */
  readonly offlineNode: TerminalOfflineNodeReading | undefined;
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
   * and it is counted by the member below instead.
   */
  readonly transitionCount: number;
  /**
   * Every transition the fold could NOT read, across the whole log.
   *
   * A DIFFERENT QUESTION FROM `unreadTransition`, which is the newest unreadable
   * transition and only while no readable one has arrived since. That member
   * answers whether the current holder is known, and a later readable transition
   * settles it; this one answers whether the ledger's rows are the whole history,
   * and nothing settles that — a transition this build could not read changed no
   * row whether or not the log went on. A ledger counting only the trailing one
   * would report a history it cannot prove complete as complete.
   */
  readonly unreadableTransitionCount: number;
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
  offlineNode: undefined,
  unreadTransition: undefined,
  transitions: [],
  transitionCount: 0,
  unreadableTransitionCount: 0,
};

/**
 * Fold a session's events into the lease state.
 *
 * Total and pure. Events of other kinds are skipped. A `pty.control_changed` the
 * reader cannot read — a reason outside the closed set, a payload that carries none,
 * or a holder shape that contradicts the reason it arrived under — is NOT skipped: it
 * is recorded as the unread transition and the projection settles into the arm that
 * shows no holder and writes nothing.
 *
 * That direction is the whole point. Skipping it left the transition before it
 * standing as the newest state, so a daemon that moved the lease under a reason a
 * later release introduced would leave this surface reading `held-by-you` and
 * stdin open for somebody who no longer holds the shell. An unread transition is
 * ignorance, and ignorance about a write lease reads as no lease at all.
 *
 * A later transition the reader CAN read clears it: the console understands the
 * current state again, and the state it understands is that transition's.
 */
export function projectTerminalLease(
  events: readonly ConsoleSessionEvent[],
  input: TerminalLeaseProjectionInput,
): TerminalLeaseState {
  const transitions: TerminalLeaseTransition[] = [];
  let transitionCount = 0;
  let unreadableTransitionCount = 0;
  let unreadTransition: TerminalLeaseUnreadTransition | undefined;

  for (const event of events) {
    if (event.kind !== TERMINAL_LEASE_EVENT_KIND) {
      continue;
    }
    const transition = readTerminalLeaseTransition(event);
    if (transition === undefined) {
      unreadableTransitionCount += 1;
      unreadTransition = readTerminalLeaseUnreadTransition(event);
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
  const holdingNode = input.holdingNode;
  const vouching = readVouching(holdingNode);

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
    offlineNode: readOfflineNode({
      holdingNode,
      hasWireHolder: wireHolderParticipantId !== null,
      unreadTransition,
    }),
    unreadTransition,
    transitions,
    transitionCount,
    unreadableTransitionCount,
  };
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
 * The offline-host reading, or nothing when the roster read found no host offline.
 *
 * The effect is read from what this fold was about to show, not from the vouching:
 * an unvouchable HOLDER is the only case where an offline node took a holder off the
 * screen, and the fold knows both of the ways it can end up showing nobody without
 * one — the newest readable transition was a release, and a transition arrived that
 * this build cannot read.
 */
function readOfflineNode(state: {
  readonly holdingNode: TerminalLeaseProjectionInput["holdingNode"];
  readonly hasWireHolder: boolean;
  readonly unreadTransition: TerminalLeaseUnreadTransition | undefined;
}): TerminalOfflineNodeReading | undefined {
  const holdingNode = state.holdingNode;
  if (holdingNode === undefined || holdingNode.isReachable) {
    return undefined;
  }
  return {
    nodeId: holdingNode.nodeId,
    effect:
      state.hasWireHolder && state.unreadTransition === undefined
        ? "holder-collapsed"
        : "no-holder-shown",
  };
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
