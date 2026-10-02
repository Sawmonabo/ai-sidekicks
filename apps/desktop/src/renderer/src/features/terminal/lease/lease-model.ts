// Folds a session's `pty.control_changed` events into one shell's lease state, from this
// device's point of view.
//
// The holder is a wire field and is never derived from the last observed take, so nothing
// here reads the outcome of a `session.takeControl` call. A take that succeeded and one whose
// broadcast never arrived look identical at the call site, and only one means the person may
// type; the lease line changes only when the transition comes back on the log.
//
// Each shell has its own holder, so only transitions naming the asked-about shell are read.
// The fold is pure: given the same events, shell and device it gives the same state, so a
// replayed prefix is deterministic and a reconnect heals by re-running it.

import {
  PTY_CONTROL_CHANGED_EVENT,
  type CommandId,
  type RunId,
  type TerminalId,
} from "@ai-sidekicks/contracts";

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
 * `not-checked` means no transition has been read, which is not the free lease (`unheld`).
 * `held-by-run` means an agent's run holds the shell and only the run writes, even when the
 * run's machine is this device. `unrecognized-transition` means the log carried a transition
 * this build cannot read, so the holder is unknown.
 */
export const TERMINAL_LEASE_HOLDERS = [
  "not-checked",
  "unheld",
  "held-by-this-device",
  "held-by-another-device",
  "held-by-run",
  "unrecognized-transition",
] as const;

/** One of the holders above. */
export type TerminalLeaseHolder = (typeof TERMINAL_LEASE_HOLDERS)[number];

/** What a log of lease transitions folds to, from this device's point of view. */
export interface TerminalLeaseState {
  readonly holder: TerminalLeaseHolder;
  /** The device the wire named as the holder, or `null` for a free lease. Never inferred. */
  readonly holderDeviceId: string | null;
  /** The run the wire named as the holder, while an agent's run holds the shell. */
  readonly holderRunId: RunId | undefined;
  /** The run's command the wire named as the holder; stopping it ends the run's hold. */
  readonly holderCommandId: CommandId | undefined;
  /**
   * The newest transition the fold could not read, when it arrived after every readable one.
   * Present means the lease state is unknown rather than stale.
   */
  readonly unreadTransition: TerminalLeaseUnreadTransition | undefined;
}

/** What the fold needs beyond the events. */
export interface TerminalLeaseProjectionInput {
  /** The shell whose lease is folded. Transitions naming another shell are skipped. */
  readonly terminalId: TerminalId;
  /** This device's identity, to tell `held-by-this-device` from `held-by-another-device`. */
  readonly thisDeviceId: string | undefined;
}

/** The state before any transition has been read. */
export const UNREAD_TERMINAL_LEASE: TerminalLeaseState = {
  holder: "not-checked",
  holderDeviceId: null,
  holderRunId: undefined,
  holderCommandId: undefined,
  unreadTransition: undefined,
};

/**
 * Fold a session's events into one shell's lease state. Total and pure.
 *
 * Other event kinds and transitions naming another shell are skipped. A `pty.control_changed`
 * the reader cannot read (an unknown reason, no payload, or a holder shape that contradicts
 * its reason) is not skipped unless it plainly names another shell: it is recorded as the
 * unread transition and the holder becomes `unrecognized-transition`, which shows no holder
 * and writes nothing. Skipping it would leave the previous holder standing, and stdin open
 * for someone who no longer holds the shell.
 *
 * A later transition the reader can read clears the unread one.
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

  // Fail-closed: an unread transition collapses to the free lease before the device
  // comparison, so "you hold it" is never shown on the strength of a transition it could not read.
  const readable = unreadTransition === undefined ? newest : undefined;
  const holderDeviceId = readable?.holderDeviceId ?? null;
  const holderRunId = readable?.holderRunId;
  const holderCommandId = readable?.holderCommandId;

  return {
    holder: readHolder({
      hasReadTransition: newest !== undefined,
      unreadTransition,
      holderDeviceId,
      holderRunId,
      thisDeviceId: input.thisDeviceId,
    }),
    holderDeviceId,
    holderRunId,
    holderCommandId,
    unreadTransition,
  };
}

// An unread transition comes first because it says the reading failed, so neither "free" nor
// "yours" is known. A run's hold comes before the device comparison because the run's machine
// may be this device, yet only the run writes.
function readHolder(state: {
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
