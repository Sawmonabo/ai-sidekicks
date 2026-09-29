// What a LOG of lease transitions folds to, from this device's seat.
//
// `lease-transition.ts` reads one event; this module reads a session. The two are
// split because they answer different questions and need different fixtures: a
// reading is a payload and a sentence, and a projection is an ordering, a device, and
// a cap. Everything below is a property of the SEQUENCE — which of five holdings
// the surface settles into, and which transitions the ledger keeps.
//
// This module has one hard rule: **the holder is a wire field and is never derived
// from the last observed claim**. So nothing here reads the outcome of a
// `session.takeControl` call.
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
// (`store/entities/entities.ts`) is that a projector reads the event and nothing else, so
// a replayed prefix is deterministic and a reconnect heals by re-running it. The
// lease is exactly that shape: given the same events and the same device, the same
// state. A class holding the fold's result beside the store would be a second
// source of truth for a fact the log already orders.

import type { ConsoleSessionEvent } from "@renderer/store/session/entities/entities.js";
import { TERMINAL_LEASE_HISTORY_CAP } from "../terminal-caps.js";
import {
  TERMINAL_LEASE_EVENT_KIND,
  readTerminalLeaseTransition,
  readTerminalLeaseUnreadTransition,
  type TerminalLeaseTransition,
  type TerminalLeaseUnreadTransition,
} from "./lease-transition.js";

/**
 * Who holds the shell, from this device's seat.
 *
 * `not-checked` is not a synonym for `unheld`: a free lease is an explicit state that
 * reads differently from a suppressed one, and "no transition has ever
 * been read" is neither. `unrecognized-transition` is a fifth answer for the same
 * kind of reason — the log carried a transition this build cannot read, so the
 * holder is neither the free lease nor whoever held it before. Declared as a tuple
 * for the reason every closed set here is.
 */
export const TERMINAL_LEASE_HOLDERS = [
  "not-checked",
  "unheld",
  "held-by-this-device",
  "held-by-another-device",
  "unrecognized-transition",
] as const;

/** One of the holdings above. */
export type TerminalLeaseHolder = (typeof TERMINAL_LEASE_HOLDERS)[number];

/** What a log of lease transitions folds to, from this device's seat. */
export interface TerminalLeaseState {
  readonly holding: TerminalLeaseHolder;
  /** The holder the wire named, or `null` for a free lease. Never inferred. */
  readonly holderUserId: string | null;
  /**
   * The newest transition the fold could not read, when one arrived after every
   * transition it could. Present means the lease state is unknown rather than
   * stale, and the surface says which transition lost it.
   */
  readonly unreadTransition: TerminalLeaseUnreadTransition | undefined;
  /** Newest last, capped at `TERMINAL_LEASE_HISTORY_CAP`. */
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

/** What the fold needs beyond the events. */
export interface TerminalLeaseProjectionInput {
  /** This device's identity, so `held-by-this-device` can be told from a device that does not
   * hold the lease (`held-by-another-device`). */
  readonly thisDeviceId: string | undefined;
}

/** The state before any transition has been read. */
export const UNREAD_TERMINAL_LEASE: TerminalLeaseState = {
  holding: "not-checked",
  holderUserId: null,
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
 * later release introduced would leave this surface reading `held-by-this-device` and
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
    if (transitions.length > TERMINAL_LEASE_HISTORY_CAP) {
      transitions.shift();
    }
  }

  const newest = transitions.at(-1);
  const wireHolderUserId = newest === undefined ? null : newest.holderUserId;

  // Fail-closed: an unread transition collapses to the free lease BEFORE the device
  // comparison, so a surface can never show "you hold it" on the strength of a
  // transition this build could not read.
  const holderUserId = unreadTransition !== undefined ? null : wireHolderUserId;

  return {
    holding: readHolding({
      transitionCount,
      unreadTransition,
      holderUserId,
      thisDeviceId: input.thisDeviceId,
    }),
    holderUserId,
    unreadTransition,
    transitions,
    transitionCount,
    unreadableTransitionCount,
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
  readonly holderUserId: string | null;
  readonly thisDeviceId: string | undefined;
}): TerminalLeaseHolder {
  if (state.unreadTransition !== undefined) {
    return "unrecognized-transition";
  }
  if (state.transitionCount === 0) {
    return "not-checked";
  }
  if (state.holderUserId === null) {
    return "unheld";
  }
  return state.holderUserId === state.thisDeviceId
    ? "held-by-this-device"
    : "held-by-another-device";
}
