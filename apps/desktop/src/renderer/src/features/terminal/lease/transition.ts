// Reads one `pty.control_changed` event on its own, with no ordering and no device.
//
// The holder is a wire field and is never derived from the last observed take. The holder shape
// each reason requires (a take names its holder, every release names the holder it ended, a
// disconnect or a closed pane names nobody after it, and a run's release names the device it hands
// the shell back to or nobody) is the contract's refinement, so a payload that contradicts its
// reason is refused here without restating the rule. `state.ts` folds a log of these readings into
// a lease state.

import type { CommandId } from "@ai-sidekicks/contracts/command";
import type { PtyControlChangedReason, TerminalId } from "@ai-sidekicks/contracts/pty";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { readWireString } from "#renderer/lib/wire/strings.js";
import { readPtyControlChangedPayload } from "#renderer/services/daemon/payload/pty-control-changed.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";

/** One transition, as the fold reads it. */
export interface TerminalLeaseTransition {
  /** The shell whose holder changed. */
  readonly terminalId: TerminalId;
  readonly reason: PtyControlChangedReason;
  /** The device holding the shell after this transition; `null` is the free lease. */
  readonly holderDeviceId: string | null;
  /** The run holding the shell after this transition, while an agent's run holds it. */
  readonly holderRunId: RunId | undefined;
  /** The run's command holding the shell, named whenever the run is. */
  readonly holderCommandId: CommandId | undefined;
  /** The shell's lease version after this transition; a newer reading has a higher one. */
  readonly leaseVersion: number;
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
    holderCommandId: payload.holderCommandId,
    leaseVersion: payload.leaseVersion,
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
