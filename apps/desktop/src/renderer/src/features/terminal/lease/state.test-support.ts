// The two devices, the shell, the run and its command, and the transition builder every lease
// suite shares, so the suites do not spell the same identities differently.

import type { CommandId } from "@ai-sidekicks/contracts/command";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { TERMINAL_CONTROL_CHANGED_EVENT, type TerminalId } from "@ai-sidekicks/contracts/terminal";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import {
  TERMINAL_LEASE_SCENARIO,
  TERMINAL_SCENARIO_ROLES,
} from "#fixtures/scenarios/terminal-lease.js";
import { eventOfKind } from "#test/helpers/session/events.js";

/**
 * This device, taken from the scenario. The fold treats a device id as an opaque string, so a
 * placeholder would pass every case yet be a holder no daemon could emit.
 */
export const THIS_DEVICE_ID = TERMINAL_SCENARIO_ROLES.owner as DeviceId;
/** A second device, taken from the scenario for the same reason. */
export const OTHER_DEVICE_ID = TERMINAL_SCENARIO_ROLES.otherDevice as DeviceId;

/** The shell every transition below names unless a case names another. */
export const SHELL_ID = "shell-1" as TerminalId;
/** A second shell of the same session, for the cases about which shell a move names. */
export const OTHER_SHELL_ID = "shell-2" as TerminalId;
/** An agent's run, for the cases where a run holds the shell. */
export const RUN_ID = "019b7b30-0280-7bd1-8110-cca0117a0199" as RunId;
/** The run's command that holds the shell; a run's hold names both. */
export const COMMAND_ID = "command-1" as CommandId;

/** A `terminal.control.changed` from the members a caller means to vary, attributed to its holder. */
export function transitionEvent(
  sequence: number,
  reason: string,
  holderDeviceId: string | null,
  previousHolderDeviceId: string | null = null,
  options: TransitionEventOptions = {},
): ProjectedSessionEvent {
  return {
    ...eventOfKind(TERMINAL_LEASE_SCENARIO.sessionId, TERMINAL_CONTROL_CHANGED_EVENT, sequence, {
      sessionId: TERMINAL_LEASE_SCENARIO.sessionId,
      terminalId: options.terminalId ?? SHELL_ID,
      holderDeviceId,
      ...(options.holderRunId === undefined ? {} : { holderRunId: options.holderRunId }),
      ...(options.holderCommandId === undefined
        ? {}
        : { holderCommandId: options.holderCommandId }),
      previousHolderDeviceId,
      reason,
      leaseVersion: options.leaseVersion ?? sequence,
    }),
    // The actor a lease move is attributed to, which the app's event builder does not take.
    actorId: holderDeviceId ?? OTHER_DEVICE_ID,
  };
}

/** What a transition may vary beyond its reason and holders. */
interface TransitionEventOptions {
  readonly terminalId?: TerminalId;
  readonly holderRunId?: RunId;
  readonly holderCommandId?: CommandId;
  /** The shell's lease version after the transition; the event's sequence unless a case says. */
  readonly leaseVersion?: number;
}
