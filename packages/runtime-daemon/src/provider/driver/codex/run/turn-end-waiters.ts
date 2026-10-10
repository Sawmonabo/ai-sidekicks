// Waiting for stopped turns to end: an undo and a faster-model retry both send `turn/interrupt`,
// which Codex answers on acceptance, and act only once the turn's `turn/completed` has arrived. A
// wait is bound by the request deadline, so a turn that never ends cannot hold either forever, and
// a turn its service dropped ends the wait as not ended.

import type { CodexScheduleTimeout } from "../transport/diagnostics.js";
import type { CodexSessionRecord } from "../session/state.js";

interface CodexTurnEndWaiter {
  readonly record: CodexSessionRecord;
  readonly turnId: string;
  readonly settle: (hasEnded: boolean) => void;
}

/** The turns of one lifecycle being waited on to end. */
export class CodexTurnEndWaiters {
  readonly #scheduleTimeout: CodexScheduleTimeout;
  readonly #timeoutMs: number;
  readonly #waiters = new Set<CodexTurnEndWaiter>();

  constructor(scheduleTimeout: CodexScheduleTimeout, timeoutMs: number) {
    this.#scheduleTimeout = scheduleTimeout;
    this.#timeoutMs = timeoutMs;
  }

  /** Resolves `true` once the turn has ended, or `false` when the deadline came first. */
  async waitForEnd(record: CodexSessionRecord, turnId: string): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      let cancelDeadline = (): void => {};
      const waiter: CodexTurnEndWaiter = {
        record,
        turnId,
        settle: (hasEnded) => {
          this.#waiters.delete(waiter);
          cancelDeadline();
          resolve(hasEnded);
        },
      };
      this.#waiters.add(waiter);
      cancelDeadline = this.#scheduleTimeout(() => {
        waiter.settle(false);
      }, this.#timeoutMs);
      this.settle();
    });
  }

  /** Settles every wait on `record`'s turns as not ended: its turns were dropped unended. */
  abandon(record: CodexSessionRecord): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.record === record) {
        waiter.settle(false);
      }
    }
  }

  /**
   * Settles every wait whose turn no route still owes a terminal: neither live, nor interrupted,
   * nor held for a retry.
   */
  settle(): void {
    for (const waiter of [...this.#waiters]) {
      const { record, turnId } = waiter;
      const isOwed =
        record.runIdByActiveTurnId.has(turnId) ||
        record.interruptedRunIdByTurnId.has(turnId) ||
        record.delivery.retriedRunIdByTurnId.has(turnId);
      if (!isOwed) {
        waiter.settle(true);
      }
    }
  }
}
