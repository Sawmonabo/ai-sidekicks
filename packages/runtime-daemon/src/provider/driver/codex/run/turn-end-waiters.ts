// Waiting for stopped turns to end: an undo, a faster-model retry, a start and a goal set all wait,
// after the daemon sent `turn/interrupt`, which Codex answers on acceptance, for the turn's
// `turn/completed`. A wait is bound by a deadline, so a turn that never ends cannot hold anything
// forever, and a turn its service dropped ends the wait as not ended. Several waits of one act
// share one deadline, whose clock starts at the first of them, so their bounds never add up.

import type { CodexScheduleTimeout } from "../transport/diagnostics.js";
import { type CodexSessionRecord, endingTurnIds } from "../session/state.js";

interface CodexTurnEndWaiter {
  readonly record: CodexSessionRecord;
  readonly isOwed: () => boolean;
  readonly settle: (hasEnded: boolean) => void;
}

/**
 * One bound on every wait handed it: its clock starts at the first wait that has a turn to wait
 * for, and once it has passed every wait handed it fails at once.
 */
export class CodexTurnEndDeadline {
  readonly #scheduleTimeout: CodexScheduleTimeout;
  readonly #timeoutMs: number;
  readonly #onPassed = new Set<() => void>();
  #cancelTimer: (() => void) | undefined;
  #hasPassed = false;

  constructor(scheduleTimeout: CodexScheduleTimeout, timeoutMs: number) {
    this.#scheduleTimeout = scheduleTimeout;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Calls `onPassed` once the deadline passes, at once when it has, starting the clock on first
   * use, and returns what stops the call.
   */
  bind(onPassed: () => void): () => void {
    if (this.#hasPassed) {
      onPassed();
      return () => {};
    }
    this.#onPassed.add(onPassed);
    this.#cancelTimer ??= this.#scheduleTimeout(() => {
      this.#hasPassed = true;
      for (const passed of [...this.#onPassed]) {
        passed();
      }
    }, this.#timeoutMs);
    return () => {
      this.#onPassed.delete(onPassed);
    };
  }

  /** Stops the clock, once the waits it bounds are over. */
  close(): void {
    this.#cancelTimer?.();
    this.#onPassed.clear();
  }
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

  /** A deadline of `timeoutMs`, by default the request deadline, for waits to share. */
  openDeadline(timeoutMs: number = this.#timeoutMs): CodexTurnEndDeadline {
    return new CodexTurnEndDeadline(this.#scheduleTimeout, timeoutMs);
  }

  /**
   * Resolves `true` once the turn has ended, or `false` when `deadline`, by default a request
   * deadline of its own, passed first.
   */
  async waitForEnd(
    record: CodexSessionRecord,
    turnId: string,
    deadline?: CodexTurnEndDeadline,
  ): Promise<boolean> {
    return await this.#wait(
      record,
      () =>
        record.runIdByActiveTurnId.has(turnId) ||
        endingTurnIds(record).includes(turnId) ||
        record.delivery.unownedTurnIds.has(turnId),
      deadline,
    );
  }

  /**
   * Resolves `true` once no turn the daemon is stopping on `record` still runs: none it stopped is
   * still ending and none Codex started that no run took runs on, those that stop meanwhile
   * included; `false` when `deadline`, by default a request deadline of its own, passed first.
   */
  async waitForStoppedTurns(
    record: CodexSessionRecord,
    deadline?: CodexTurnEndDeadline,
  ): Promise<boolean> {
    return await this.#wait(
      record,
      () => endingTurnIds(record).length > 0 || record.delivery.unownedTurnIds.size > 0,
      deadline,
    );
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
   * Settles every wait whose turns no route still owes a terminal: neither live, nor stopped by the
   * daemon and still ending, nor one Codex started that runs on with no run.
   */
  settle(): void {
    for (const waiter of [...this.#waiters]) {
      if (!waiter.isOwed()) {
        waiter.settle(true);
      }
    }
  }

  async #wait(
    record: CodexSessionRecord,
    isOwed: () => boolean,
    deadline: CodexTurnEndDeadline | undefined,
  ): Promise<boolean> {
    if (!isOwed()) {
      return true;
    }
    const bound = deadline ?? this.openDeadline();
    try {
      return await new Promise<boolean>((resolve) => {
        let unbind = (): void => {};
        const waiter: CodexTurnEndWaiter = {
          record,
          isOwed,
          settle: (hasEnded) => {
            this.#waiters.delete(waiter);
            unbind();
            resolve(hasEnded);
          },
        };
        this.#waiters.add(waiter);
        unbind = bound.bind(() => {
          waiter.settle(false);
        });
      });
    } finally {
      if (deadline === undefined) {
        bound.close();
      }
    }
  }
}
