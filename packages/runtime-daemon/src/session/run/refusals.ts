// The run engine's refusals, each projected onto the wire by its code.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import { RUN_INVALID_TRANSITION_CODE } from "@ai-sidekicks/contracts/run/control";
import type { RunStateChangeState } from "@ai-sidekicks/contracts/run/events";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunState } from "@ai-sidekicks/contracts/run/state";

import { DaemonDomainError } from "../../ipc/domain-error.js";

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

/** A move the run's current state does not allow (`run.invalid_transition`); nothing was written. */
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
