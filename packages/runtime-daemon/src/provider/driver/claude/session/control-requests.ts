// The control requests a Claude Code process has not answered yet, keyed by `request_id`. Each one
// fails when its deadline passes, and every one fails at once when the process exits, so nothing
// waits on a process that will never answer.

import { mintUuidV7 } from "../../../../uuid-v7.js";
import { ClaudeRequestTimeoutError, ClaudeSessionUnavailableError } from "./errors.js";
import type { ClaudeControlResponse } from "./transport.js";

/** Starts one deadline and answers how to cancel it; an unref'd timer by default. */
export type ClaudeDeadlineScheduler = (onExpired: () => void, deadlineMs: number) => () => void;

/** The driver's one timer: unref'd, so a pending deadline or wait never keeps the daemon alive. */
export const scheduleUnrefTimer: ClaudeDeadlineScheduler = (onExpired, deadlineMs) => {
  const timer = setTimeout(onExpired, deadlineMs);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
};

interface ClaudePendingControlRequest {
  readonly resolve: (response: ClaudeControlResponse) => void;
  readonly reject: (cause: Error) => void;
  readonly cancelDeadline: () => void;
}

/** One opened request: the id it is written under and the promise its answer settles. */
export interface ClaudeOpenedControlRequest {
  readonly requestId: string;
  readonly settled: Promise<ClaudeControlResponse>;
}

/** The pending control requests of one process. */
export class ClaudeControlRequestTable {
  readonly #pending: Map<string, ClaudePendingControlRequest> = new Map();
  readonly #scheduleDeadline: ClaudeDeadlineScheduler;
  #exitCause: Error | undefined;

  constructor(scheduleDeadline: ClaudeDeadlineScheduler = scheduleUnrefTimer) {
    this.#scheduleDeadline = scheduleDeadline;
  }

  /**
   * Opens a request under a fresh id, before it is written, so an answer arriving at once finds
   * it. Its promise rejects with `ClaudeRequestTimeoutError` after `deadlineMs` and with
   * `ClaudeSessionUnavailableError` when the process exits first, or already exited.
   */
  open(subtype: string, deadlineMs: number): ClaudeOpenedControlRequest {
    const requestId = mintUuidV7();
    const exitCause = this.#exitCause;
    if (exitCause !== undefined) {
      return { requestId, settled: Promise.reject(exitCause) };
    }
    const settled = new Promise<ClaudeControlResponse>((resolve, reject) => {
      const cancelDeadline = this.#scheduleDeadline(() => {
        if (this.#pending.delete(requestId)) {
          reject(
            new ClaudeRequestTimeoutError(
              `The Claude Code process did not answer the ${subtype} request within ` +
                `${deadlineMs}ms`,
              deadlineMs,
            ),
          );
        }
      }, deadlineMs);
      this.#pending.set(requestId, { resolve, reject, cancelDeadline });
    });
    return { requestId, settled };
  }

  /** Settles the request a `control_response` names; answers whether one was pending. */
  settle(requestId: string, response: ClaudeControlResponse): boolean {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      return false;
    }
    this.#pending.delete(requestId);
    pending.cancelDeadline();
    pending.resolve(response);
    return true;
  }

  /** Fails a request whose write failed, so it does not wait out its deadline. */
  fail(requestId: string, cause: Error): void {
    const pending = this.#pending.get(requestId);
    if (pending !== undefined) {
      this.#pending.delete(requestId);
      pending.cancelDeadline();
      pending.reject(cause);
    }
  }

  /** Fails every pending request at once, and every later one, because the process exited. */
  failAllOnExit(detail: string): void {
    const cause = new ClaudeSessionUnavailableError("process_exited", { detail });
    this.#exitCause = cause;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      request.cancelDeadline();
      request.reject(cause);
    }
  }
}
