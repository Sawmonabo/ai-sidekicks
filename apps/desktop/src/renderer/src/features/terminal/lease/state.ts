// Folds a session's `pty.control_changed` events into one shell's lease state, from this
// device's point of view.
//
// The holder is a wire field and is never derived from the last observed take, so nothing
// here reads the outcome of a `session.takeControl` call. A take that succeeded and one whose
// broadcast never arrived look identical at the call site, and only one means the person may
// type; the lease line changes only when the transition comes back on the log.
//
// Each shell has its own holder, so only transitions naming the asked-about shell are read. Every
// reading carries the shell's lease version, and the fold keeps the newest: a holder the shell
// list read is not undone by an older transition the log delivers after it. The fold is pure:
// given the same events, listing, shell and device it gives the same state, so a rebuild is
// deterministic and a reconnect heals by re-running it.

import {
  PTY_CONTROL_CHANGED_EVENT,
  type PtyListEntry,
  type TerminalId,
} from "@ai-sidekicks/contracts/pty";
import type { CommandId } from "@ai-sidekicks/contracts/command";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import {
  readTerminalLeaseShell,
  readTerminalLeaseTransition,
  type TerminalLeaseTransition,
} from "./transition.js";

/**
 * Who holds the shell, from this device's point of view.
 *
 * `not-checked` means the holder has not been read: nothing has said who holds it yet, the newest
 * transition for it is one this build cannot read, or a device holds it before this device's own
 * id is known, so whose hold it is cannot be told. It is not the free lease (`unheld`): a free
 * shell is live here, since the first device to write takes it, and an unread one is read-only.
 * `held-by-run` means an agent's run holds the shell and only the run writes, even when the run's
 * machine is this device.
 */
export const TERMINAL_LEASE_HOLDERS = [
  "not-checked",
  "unheld",
  "held-by-this-device",
  "held-by-another-device",
  "held-by-run",
] as const;

/** One of the holders above. */
export type TerminalLeaseHolder = (typeof TERMINAL_LEASE_HOLDERS)[number];

// The holders the lease line draws nothing for: a holder not yet read, a free shell and this
// device's own hold.
const UNDRAWN_LEASE_HOLDERS = ["not-checked", "unheld", "held-by-this-device"] as const;

/** The holders the lease line is drawn for. */
export type DrawnLeaseHolder = Exclude<TerminalLeaseHolder, (typeof UNDRAWN_LEASE_HOLDERS)[number]>;

/** What a log of lease transitions folds to, from this device's point of view. */
export interface TerminalLeaseState {
  readonly holder: TerminalLeaseHolder;
  /** The device the wire named as the holder, or `null` for a free lease. Never inferred. */
  readonly holderDeviceId: string | null;
  /** The run the wire named as the holder, while an agent's run holds the shell. */
  readonly holderRunId: RunId | undefined;
  /** The run's command the wire named as the holder; the run's hold ends when it ends. */
  readonly holderCommandId: CommandId | undefined;
}

/** A holder read off the shell list or the shell's scrollback, at its lease version. */
export type ListedTerminalLease = Pick<PtyListEntry, "holder" | "leaseVersion">;

/** What the fold needs beyond the events. */
export interface TerminalLeaseProjectionInput {
  /** The shell whose lease is folded. Transitions naming another shell are skipped. */
  readonly terminalId: TerminalId;
  /**
   * This device's id, to tell `held-by-this-device` from `held-by-another-device`; `undefined`
   * until it is known, which leaves a device's hold `not-checked`.
   */
  readonly thisDeviceId: string | undefined;
  /** The shell's holder as last listed; a transition replaces it only from a newer version. */
  readonly listedLease?: ListedTerminalLease | undefined;
}

/**
 * Whether the lease line is drawn: not before the holder is read, for a free shell, or for this
 * device's own hold.
 */
export function isLeaseLineDrawn(holder: TerminalLeaseHolder): holder is DrawnLeaseHolder {
  return !(UNDRAWN_LEASE_HOLDERS as readonly TerminalLeaseHolder[]).includes(holder);
}

/**
 * Whether this device may type into the shell: while it holds it, and while nobody does, because
 * the first write takes a free shell. Everything else, a lease not yet read among them, is
 * read-only.
 */
export function canTypeIntoShell(holder: TerminalLeaseHolder): boolean {
  return holder === "held-by-this-device" || holder === "unheld";
}

/** The state before any transition has been read. */
export const UNREAD_TERMINAL_LEASE: TerminalLeaseState = {
  holder: "not-checked",
  holderDeviceId: null,
  holderRunId: undefined,
  holderCommandId: undefined,
};

/**
 * Fold a session's events into one shell's lease state. Total and pure.
 *
 * Other event kinds and transitions naming another shell are skipped, and of the listed holder and
 * the readable transitions the one at the newest lease version holds. A `pty.control_changed` the
 * reader cannot read (an unknown reason, no payload, or a holder shape that contradicts its reason)
 * is not skipped unless it plainly names another shell: until a readable transition follows it,
 * the holder is `not-checked`, which shows no holder and writes nothing. Skipping it would leave
 * the previous holder standing, and stdin open for someone who no longer holds the shell.
 */
export function projectTerminalLease(
  events: readonly ProjectedSessionEvent[],
  input: TerminalLeaseProjectionInput,
): TerminalLeaseState {
  let newest: LeaseReading | undefined =
    input.listedLease === undefined ? undefined : readListedLease(input.listedLease);
  // Whether the last transition for this shell is one the fold could not read, so it may be the
  // newest change.
  let isNewestUnread = false;

  for (const event of events) {
    if (event.kind !== PTY_CONTROL_CHANGED_EVENT) {
      continue;
    }
    const transition = readTerminalLeaseTransition(event);
    if (transition === undefined) {
      const namedShell = readTerminalLeaseShell(event);
      if (namedShell === undefined || namedShell === input.terminalId) {
        isNewestUnread = true;
      }
      continue;
    }
    if (transition.terminalId !== input.terminalId) {
      continue;
    }
    // The log carries each shell's changes in version order, so a readable one after an unread one
    // is the newer of the two.
    isNewestUnread = false;
    if (newest === undefined || transition.leaseVersion > newest.leaseVersion) {
      newest = transition;
    }
  }

  // Fail-closed: an unread transition names no holder, so neither "you hold it" nor the writable
  // free shell is ever shown on the strength of a transition the fold could not read.
  const readable = isNewestUnread ? undefined : newest;
  const holderDeviceId = readable?.holderDeviceId ?? null;
  const holderRunId = readable?.holderRunId;
  const holderCommandId = readable?.holderCommandId;

  return {
    holder: readHolder({
      hasReadHolder: readable !== undefined,
      holderDeviceId,
      holderRunId,
      thisDeviceId: input.thisDeviceId,
    }),
    holderDeviceId,
    holderRunId,
    holderCommandId,
  };
}

// One reading of who holds the shell, from a transition or the shell list.
type LeaseReading = Pick<
  TerminalLeaseTransition,
  "holderDeviceId" | "holderRunId" | "holderCommandId" | "leaseVersion"
>;

function readListedLease(listed: ListedTerminalLease): LeaseReading {
  return {
    holderDeviceId: listed.holder?.holderDeviceId ?? null,
    holderRunId: listed.holder?.holderRunId,
    holderCommandId: listed.holder?.holderCommandId,
    leaseVersion: listed.leaseVersion,
  };
}

// A run's hold comes before the device comparison because the run's machine may be this device,
// yet only the run writes. A device's hold read before this device's id is known stays unread,
// so neither a live body nor `Take the shell` is shown for a hold that may be this device's.
function readHolder(state: {
  readonly hasReadHolder: boolean;
  readonly holderDeviceId: string | null;
  readonly holderRunId: RunId | undefined;
  readonly thisDeviceId: string | undefined;
}): TerminalLeaseHolder {
  if (!state.hasReadHolder) {
    return "not-checked";
  }
  if (state.holderDeviceId === null) {
    return "unheld";
  }
  if (state.holderRunId !== undefined) {
    return "held-by-run";
  }
  if (state.thisDeviceId === undefined) {
    return "not-checked";
  }
  return state.holderDeviceId === state.thisDeviceId
    ? "held-by-this-device"
    : "held-by-another-device";
}
