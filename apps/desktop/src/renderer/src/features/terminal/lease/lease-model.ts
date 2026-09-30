// What a LOG of lease transitions folds to for one shell, from this device's point of
// view.
//
// `lease-transition.ts` reads one event; this module reads a session. The two are
// split because they answer different questions and need different fixtures: a
// reading is a payload, and a projection is an ordering, a shell and a device.
// Everything below is a property of the SEQUENCE — which holding the lease line
// settles into.
//
// The lease is per shell: each of a session's shells has a holder of its own, so the
// fold reads only the transitions that name the shell it is asked about.
//
// This module has one hard rule: **the holder is a wire field and is never derived
// from the last observed take**. So nothing here reads the outcome of a
// `session.takeControl` call.
// The lease state is a fold over `pty.control_changed` events — the registered
// event type whose payload carries the holder, the holder it replaced, and the
// reason — and a take the console made changes the lease line only when the
// transition it caused comes back on the log.
//
// That is not fastidiousness. A take that succeeds and a take whose broadcast
// the console never received look identical at the call site, and only one of
// them means the person may type. An optimistic lease line would show a keyboard to
// somebody who does not hold the shell.
//
// WHY A PURE FOLD AND NOT A CLASS. The store's own projector discipline
// (`store/entities/entities.ts`) is that a projector reads the event and nothing else, so
// a replayed prefix is deterministic and a reconnect heals by re-running it. The
// lease is exactly that shape: given the same events, shell and device, the same
// state. A class holding the fold's result beside the store would be a second
// source of truth for a fact the log already orders.

import { PTY_CONTROL_CHANGED_EVENT, type RunId, type TerminalId } from "@ai-sidekicks/contracts";

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import {
  readTerminalLeaseShell,
  readTerminalLeaseTransition,
  readTerminalLeaseUnreadTransition,
  type TerminalLeaseTransition,
  type TerminalLeaseUnreadTransition,
} from "./lease-transition.js";

/**
 * Who holds the shell, from this device's point of view.
 *
 * `not-checked` is not a synonym for `unheld`: a free lease is an explicit state that
 * reads differently from a suppressed one, and "no transition has ever
 * been read" is neither. `held-by-run` is an agent's run holding the shell: its
 * writes come only from the run, whatever device the run's machine is, so nobody may
 * type until the run stops. `unrecognized-transition` is one more answer for the same
 * kind of reason as `not-checked` — the log carried a transition this build cannot
 * read, so the holder is neither the free lease nor whoever held it before. Declared
 * as a tuple for the reason every closed set here is.
 */
export const TERMINAL_LEASE_HOLDERS = [
  "not-checked",
  "unheld",
  "held-by-this-device",
  "held-by-another-device",
  "held-by-run",
  "unrecognized-transition",
] as const;

/** One of the holdings above. */
export type TerminalLeaseHolder = (typeof TERMINAL_LEASE_HOLDERS)[number];

/** What a log of lease transitions folds to, from this device's point of view. */
export interface TerminalLeaseState {
  readonly holding: TerminalLeaseHolder;
  /** The device the wire named as the holder, or `null` for a free lease. Never inferred. */
  readonly holderDeviceId: string | null;
  /** The run the wire named as the holder, while an agent's run holds the shell. */
  readonly holderRunId: RunId | undefined;
  /**
   * The newest transition the fold could not read, when one arrived after every
   * transition it could. Present means the lease state is unknown rather than
   * stale, and the lease line says which transition lost it.
   */
  readonly unreadTransition: TerminalLeaseUnreadTransition | undefined;
}

/** What the fold needs beyond the events. */
export interface TerminalLeaseProjectionInput {
  /** The shell whose lease is folded. Transitions naming another shell are skipped. */
  readonly terminalId: TerminalId;
  /** This device's identity, so `held-by-this-device` can be told from a device that does not
   * hold the lease (`held-by-another-device`). */
  readonly thisDeviceId: string | undefined;
}

/** The state before any transition has been read. */
export const UNREAD_TERMINAL_LEASE: TerminalLeaseState = {
  holding: "not-checked",
  holderDeviceId: null,
  holderRunId: undefined,
  unreadTransition: undefined,
};

/**
 * Fold a session's events into one shell's lease state.
 *
 * Total and pure. Events of other kinds are skipped, and so are transitions naming
 * another shell. A `pty.control_changed` the reader cannot read — a reason outside the
 * closed set, a payload that carries none, or a holder shape that contradicts the
 * reason it arrived under — is NOT skipped unless it plainly names another shell: it
 * is recorded as the unread transition and the projection settles into the arm that
 * shows no holder and writes nothing.
 *
 * That direction is the whole point. Skipping it would leave the transition before it
 * standing as the newest state, so a daemon that moved the lease under a reason a
 * later release introduced would leave the lease line reading `held-by-this-device` and
 * stdin open for somebody who no longer holds the shell. An unread transition is
 * ignorance, and ignorance about a write lease reads as no lease at all.
 *
 * A later transition the reader CAN read clears it: the console understands the
 * current state again, and the state it understands is that transition's.
 */
export function projectTerminalLease(
  events: readonly ProjectedSessionEvent[],
  input: TerminalLeaseProjectionInput,
): TerminalLeaseState {
  let newest: TerminalLeaseTransition | undefined;
  let unreadTransition: TerminalLeaseUnreadTransition | undefined;

  for (const event of events) {
    if (event.kind !== PTY_CONTROL_CHANGED_EVENT) {
      continue;
    }
    const transition = readTerminalLeaseTransition(event);
    if (transition === undefined) {
      const namedShell = readTerminalLeaseShell(event);
      if (namedShell === undefined || namedShell === input.terminalId) {
        unreadTransition = readTerminalLeaseUnreadTransition(event);
      }
      continue;
    }
    if (transition.terminalId !== input.terminalId) {
      continue;
    }
    unreadTransition = undefined;
    newest = transition;
  }

  // Fail-closed: an unread transition collapses to the free lease BEFORE the device
  // comparison, so the lease line can never show "you hold it" on the strength of a
  // transition this build could not read.
  const readable = unreadTransition === undefined ? newest : undefined;
  const holderDeviceId = readable?.holderDeviceId ?? null;
  const holderRunId = readable?.holderRunId;

  return {
    holding: readHolding({
      hasReadTransition: newest !== undefined,
      unreadTransition,
      holderDeviceId,
      holderRunId,
      thisDeviceId: input.thisDeviceId,
    }),
    holderDeviceId,
    holderRunId,
    unreadTransition,
  };
}

/**
 * Which holding the fold settled on. Ordered fail-closed, hardest fact last.
 *
 * The unread arm comes first because it is a statement about the READING and not
 * about the lease: with a transition the console could not understand, neither
 * "nobody holds it" nor "you hold it" is something the lease line knows, and the
 * only honest answers left are the two that disable writing. A run's hold comes
 * before the device comparison, because the run's machine is the holding device and
 * this device may be that machine, yet only the run writes.
 */
function readHolding(state: {
  readonly hasReadTransition: boolean;
  readonly unreadTransition: TerminalLeaseUnreadTransition | undefined;
  readonly holderDeviceId: string | null;
  readonly holderRunId: RunId | undefined;
  readonly thisDeviceId: string | undefined;
}): TerminalLeaseHolder {
  if (state.unreadTransition !== undefined) {
    return "unrecognized-transition";
  }
  if (!state.hasReadTransition) {
    return "not-checked";
  }
  if (state.holderDeviceId === null) {
    return "unheld";
  }
  if (state.holderRunId !== undefined) {
    return "held-by-run";
  }
  return state.holderDeviceId === state.thisDeviceId
    ? "held-by-this-device"
    : "held-by-another-device";
}
