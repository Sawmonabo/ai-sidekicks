// The two devices, the shell, the run and its command, and the two event builders every lease
// suite shares. One home, so the suites do not spell the same identities differently, and the
// malformed-shape cases are only meaningful against a builder whose default is well formed. The
// structured builder is expressed over the raw one, so there is one answer to what an event's
// id, session and instant look like.

import { PTY_CONTROL_CHANGED_EVENT, type TerminalId } from "@ai-sidekicks/contracts/pty";
import type { CommandId } from "@ai-sidekicks/contracts/command";
import type { RunId } from "@ai-sidekicks/contracts/provider-driver";

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import {
  TERMINAL_LEASE_SCENARIO,
  TERMINAL_SCENARIO_ROLES,
} from "@fixtures/scenarios/terminal-lease.js";
import { eventOfKind } from "@test/helpers/session-events.js";

/**
 * This device, taken from the scenario. The fold treats a device id as an opaque string, so a
 * placeholder would pass every case yet be a holder no daemon could emit.
 */
export const THIS_DEVICE_ID: string = TERMINAL_SCENARIO_ROLES.owner;
/** A second device, taken from the scenario for the same reason. */
export const OTHER_DEVICE_ID: string = TERMINAL_SCENARIO_ROLES.otherDevice;

/** The shell every transition below names unless a case names another. */
export const SHELL_ID = "shell-1" as TerminalId;
/** A second shell of the same session, for the cases about which shell a move names. */
export const OTHER_SHELL_ID = "shell-2" as TerminalId;
/** An agent's run, for the cases where a run holds the shell. */
export const RUN_ID = "019b7b30-0280-7bd1-8110-cca0117a0199" as RunId;
/** The run's command that holds the shell; a run's hold names both. */
export const COMMAND_ID = "command-1" as CommandId;

/**
 * A `pty.control_changed` carrying exactly the payload a case hands it. The reader's suites
 * decide the member set, including an absent payload.
 */
export function leaseEventWithPayload(
  sequence: number,
  payload: Record<string, unknown> | undefined,
  actorId: string | undefined = OTHER_DEVICE_ID,
): ProjectedSessionEvent {
  return {
    // The app's one admitted-event builder, plus the actor a lease move is attributed to,
    // which it does not take.
    ...eventOfKind(TERMINAL_LEASE_SCENARIO.sessionId, PTY_CONTROL_CHANGED_EVENT, sequence, payload),
    ...(actorId === undefined ? {} : { actorId }),
  };
}

/**
 * A well-formed transition from the members a caller means to vary. The default makes the
 * malformed cases mean something: a caller changes one member of an event the reader accepts.
 */
export function transitionEvent(
  sequence: number,
  reason: string,
  holderDeviceId: string | null,
  previousHolderDeviceId: string | null = null,
  options: TransitionEventOptions = {},
): ProjectedSessionEvent {
  return leaseEventWithPayload(
    sequence,
    {
      sessionId: TERMINAL_LEASE_SCENARIO.sessionId,
      terminalId: options.terminalId ?? SHELL_ID,
      holderDeviceId,
      ...(options.holderRunId === undefined ? {} : { holderRunId: options.holderRunId }),
      ...(options.holderCommandId === undefined
        ? {}
        : { holderCommandId: options.holderCommandId }),
      previousHolderDeviceId,
      reason,
    },
    holderDeviceId ?? undefined,
  );
}

/** What a well-formed transition may vary beyond its reason and holders. */
interface TransitionEventOptions {
  readonly terminalId?: TerminalId;
  readonly holderRunId?: RunId;
  readonly holderCommandId?: CommandId;
}
