// What ONE `pty.control_changed` event says, and nothing about what a log of them
// folds to.
//
// The two questions were one module, and they are not one job. This half is a
// READER: it reads one event's payload through the contract, decoded at the bridge,
// and records a payload the contract refuses. It knows nothing about a device or which holding the
// lease line settles into — both are `lease-model.ts`'s, because both are properties
// of the SEQUENCE rather than of the event.
//
// The split is along that seam and not along a line count. A reader can be driven
// with one event and no session; the fold cannot be driven at all without a log. So
// each side is testable on its own terms, and the fold imports the reader rather
// than restating any part of it.
//
// Both halves obey one hard rule — **the holder is a wire field and is never derived
// from the last observed take** — and this is where it is enforced, because this is
// where a payload becomes a reading at all. The shape each reason obliges the
// payload to have (a take names its holder, a release names nobody) is the
// contract's refinement, so a payload that contradicts its own reason is refused
// here without this module restating the rule.

import type { PtyControlChangedReason, RunId, TerminalId } from "@ai-sidekicks/contracts";

import { readWireString } from "@renderer/lib/wire-strings.js";
import { readPtyControlChangedPayload } from "@renderer/services/daemon/pty-control-changed-payload.js";
import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";

/** One transition, as the fold reads it. */
export interface TerminalLeaseTransition {
  /** The shell whose holder changed. */
  readonly terminalId: TerminalId;
  readonly reason: PtyControlChangedReason;
  /** The device holding the shell after this transition; `null` is the free lease. */
  readonly holderDeviceId: string | null;
  /** The run holding the shell after this transition, while an agent's run holds it. */
  readonly holderRunId: RunId | undefined;
}

/**
 * A lease transition the console could not read, kept so the lease line can say so.
 *
 * The wire moved the lease and this build does not understand the move. Skipping it
 * would leave the previous holder standing as the newest state, which is the one
 * reading that lets a person keep typing into a shell the daemon has taken from
 * them — so the transition is carried in its own right, with whatever the wire
 * called it, and the projection settles into the arm that writes nothing.
 */
export interface TerminalLeaseUnreadTransition {
  /**
   * The reason the wire sent, when it sent a non-empty string — verbatim, for the
   * operator to paste somewhere. `undefined` when the payload named none at all,
   * which is the same fact with less to say about it.
   */
  readonly reason: string | undefined;
}

/**
 * Read one transition off an event, or `undefined` when the payload is not one the
 * contract admits: a reason outside the closed set, a missing member, or a holder
 * shape that contradicts its reason.
 */
export function readTerminalLeaseTransition(
  event: ProjectedSessionEvent,
): TerminalLeaseTransition | undefined {
  const payload = readPtyControlChangedPayload(event.payload);
  if (payload === undefined) {
    return undefined;
  }
  return {
    terminalId: payload.terminalId,
    reason: payload.reason,
    holderDeviceId: payload.holderDeviceId,
    holderRunId: payload.holderRunId,
  };
}

/**
 * The shell an event names, read as a plain string, whether or not the rest of the
 * payload is readable. The fold uses it to skip a transition on another shell it
 * cannot read, and to keep one that names no shell at all.
 */
export function readTerminalLeaseShell(event: ProjectedSessionEvent): string | undefined {
  return readWireString(event.payload?.["terminalId"]);
}

/**
 * Read one unreadable transition off its event.
 *
 * Separate from {@link readTerminalLeaseTransition} because the two answer different
 * questions: that one asks whether the console understands the move, this one records
 * the move it does not understand. The reason is carried verbatim and only when the
 * wire sent a non-empty string — anything else is a payload with nothing to name,
 * and a stringified object would be the lease line inventing a vocabulary.
 */
export function readTerminalLeaseUnreadTransition(
  event: ProjectedSessionEvent,
): TerminalLeaseUnreadTransition {
  return { reason: readWireString(event.payload?.["reason"]) };
}
