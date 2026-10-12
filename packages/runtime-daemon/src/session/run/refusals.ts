// The run engine's refusals, each projected onto the wire by its code.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import {
  RUN_INVALID_TRANSITION_CODE,
  RUN_VERSION_STALE_CODE,
} from "@ai-sidekicks/contracts/run/control";
import type { RunStateChangeState } from "@ai-sidekicks/contracts/run/events";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { DaemonDomainError } from "../../ipc/domain-error.js";
import { isTerminalState, type RunState } from "@ai-sidekicks/contracts/run/state";

/** A run id the daemon holds no run for (`run.not_found`). */
export class RunNotFoundError extends DaemonDomainError {
  constructor(runId: RunId) {
    super("Run does not exist or is not accessible", {
      code: "run.not_found",
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { runId },
    });
  }
}

/**
 * A `run.pause` or `run.resume` whose expected version is not the run's current one, older or
 * newer (`run.version_stale`); nothing was written and the run is as it was.
 */
export class RunVersionStaleError extends DaemonDomainError {
  constructor(runId: RunId, expectedRunVersion: number, runVersion: number) {
    super(`The run is at version ${String(runVersion)}, not ${String(expectedRunVersion)}`, {
      code: RUN_VERSION_STALE_CODE,
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: { runId, expectedRunVersion, runVersion },
    });
  }
}

/**
 * A move the run's current state does not allow (`run.invalid_transition`); nothing was written.
 */
export class RunInvalidTransitionError extends DaemonDomainError {
  readonly runId: RunId;
  readonly fromState: RunState;
  readonly toState: RunStateChangeState;

  constructor(
    runId: RunId,
    fromState: RunState,
    toState: RunStateChangeState,
    options?: { readonly cause?: unknown },
  ) {
    super(`A run in ${fromState} cannot move to ${toState}`, {
      code: RUN_INVALID_TRANSITION_CODE,
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: { runId, fromState, toState },
    });
    this.runId = runId;
    this.fromState = fromState;
    this.toState = toState;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * A terminal refused because the run had already ended, by the time it was read or inside the
 * write itself; nothing was written. A late terminal from the provider is expected to meet this.
 */
export class RunAlreadyEndedError extends RunInvalidTransitionError {}

/**
 * The refusal of a provider's move of `runId` to `toState` once the run has ended in `endedState`:
 * {@link RunAlreadyEndedError} for a terminal, else {@link RunInvalidTransitionError}.
 */
export function endedRunRefusal(
  runId: RunId,
  toState: RunStateChangeState,
  endedState: RunState,
): RunInvalidTransitionError {
  return isTerminalState(toState)
    ? new RunAlreadyEndedError(runId, endedState, toState)
    : new RunInvalidTransitionError(runId, endedState, toState);
}

/**
 * A turn the daemon or the provider would start on a session whose next turn is held for another
 * run: the continue of its interrupted lead run with the messages waiting for it, or a lead run
 * that has not ended (`driver.unavailable`, `session_turn_in_flight`, as a driver refuses a turn
 * the daemon starts while another holds the session); nothing was written.
 */
export class SessionTurnHeldError extends DaemonDomainError {
  constructor(sessionId: SessionId) {
    super("The session's next turn is held for another of its runs, so this turn waits", {
      code: "driver.unavailable",
      jsonRpcCode: JsonRpcErrorCode.InternalError,
      detail: { sessionId, reason: "session_turn_in_flight" },
    });
  }
}
