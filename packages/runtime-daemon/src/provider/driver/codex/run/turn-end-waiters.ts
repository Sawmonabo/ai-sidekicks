// Waiting on a session's turns: an undo, a faster-model retry, a start, a goal set or clear and
// `Allow once` wait, after the daemon sent `turn/interrupt`, which Codex answers on acceptance, for
// the turn's `turn/completed`, and `Allow once` also waits for a turn still starting to run. A wait
// is bound by a deadline, so a turn that never ends or starts cannot hold anything forever; a turn
// its service dropped ends the wait as not ended, and a session's close refuses the wait. Several waits of one act share one
// deadline, whose clock starts at the first of them, so their bounds never add up.

import type { CodexScheduleTimeout } from "../transport/diagnostics.js";
import { CodexSessionClosedError } from "../session/errors.js";
import type { CodexRecordExit } from "../session/slots.js";
import { type CodexSessionRecord, endingTurnIds, isTurnInFlight } from "../session/state.js";

interface CodexTurnEndWaiter {
  readonly record: CodexSessionRecord;
  readonly isOwed: () => boolean;
  readonly settle: (hasEnded: boolean) => void;
  readonly refuse: (error: Error) => void;
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

  /** Stops the clock, once the waits it bounds are over; a later wait starts it again. */
  close(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
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

  /**
   * Resolves `true` once a turn runs on `record`, at once when one does; `false` when `deadline`
   * passed first.
   */
  async waitForLiveTurn(
    record: CodexSessionRecord,
    deadline: CodexTurnEndDeadline,
  ): Promise<boolean> {
    return await this.#wait(record, () => record.runIdByActiveTurnId.size === 0, deadline);
  }

  /**
   * Resolves `true` once a turn runs, starts or opens its run on `record`, at once when one does;
   * `false` when `deadline` passed first.
   */
  async waitForTurnInFlight(
    record: CodexSessionRecord,
    deadline: CodexTurnEndDeadline,
  ): Promise<boolean> {
    return await this.#wait(record, () => !isTurnInFlight(record), deadline);
  }

  /**
   * Ends every wait on `record`'s turns, which were dropped unended: refused with
   * `session.already_closed` when its session closed, else settled as not ended.
   */
  abandon(record: CodexSessionRecord, exit: CodexRecordExit): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.record !== record) {
        continue;
      }
      if (exit === "session_closed") {
        waiter.refuse(new CodexSessionClosedError(record.sessionId));
      } else {
        waiter.settle(false);
      }
    }
  }

  /**
   * Settles every wait no longer owed: whose turns are neither live, nor stopped by the daemon and
   * still ending, nor one Codex started that runs on with no run, one for a live turn once a turn
   * runs, and one for a turn in flight once one is.
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
      return await new Promise<boolean>((resolve, reject) => {
        let unbind = (): void => {};
        const leave = (): void => {
          this.#waiters.delete(waiter);
          unbind();
        };
        const waiter: CodexTurnEndWaiter = {
          record,
          isOwed,
          settle: (hasEnded) => {
            leave();
            resolve(hasEnded);
          },
          refuse: (error) => {
            leave();
            reject(error);
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
