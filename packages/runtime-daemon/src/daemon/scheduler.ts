// The service's one scheduler: every background job runs at a deadline on the monotonic clock, all
// of them behind one armed timer, one job at a time in deadline order.
//
//   * A deadline is kept on the monotonic clock and re-checked each time the timer fires, so
//     setting the wall clock back or forward neither holds a job back nor runs it early. Time
//     asleep may not count toward a deadline; the wake signal tells the jobs that must catch up.
//   * The wake signal: when more wall-clock time than the wake gap passed between arming the timer
//     and its firing, or the wall clock has moved that much further than the monotonic clock since
//     the last look, the machine slept (or its clock was set forward, or the event loop was held
//     that long), and every wake listener hears it once.
//   * The timer is never armed further ahead than the wake check, so a wake is noticed within it
//     even while no job is due, and it is unreferenced, so it never keeps a stopping process alive.

import { performance } from "node:perf_hooks";

import { describeRejection } from "../rejection.js";
import type { ServiceLogWriter } from "./service-log.js";

// The longest the one timer waits before the scheduler looks at the wall clock again, which bounds
// how late a wake is noticed: 15 seconds, so a wake is heard within moments at little cost.
const WAKE_CHECK_INTERVAL_MS = 15_000;

// The wall-clock gap past which a wake is counted: one and a half wake checks, so a timer that
// fires a little late is not taken for a sleep.
const WAKE_GAP_THRESHOLD_MS = 22_500;

/** One job: what it is called in the service log, when it runs, and the work. */
export interface ScheduledJob {
  readonly name: string;
  /** How long from now until it runs, in milliseconds on the monotonic clock; 0 runs it at once. */
  readonly delayMs: number;
  /**
   * The work, given a signal the scheduler's stop aborts, which a long job checks between its steps
   * so the stop never waits on it for long; a rejection is written to the service log.
   */
  readonly run: (signal: AbortSignal) => Promise<void>;
}

/** A job that runs again `intervalMs` after each run ends, until it is canceled. */
export interface RepeatingJob {
  readonly name: string;
  readonly intervalMs: number;
  /** How long from now until the first run, in milliseconds; omitted, it is due at once. */
  readonly firstDelayMs?: number;
  /** The work, given the signal the scheduler's stop aborts, as {@link ScheduledJob.run}. */
  readonly run: (signal: AbortSignal) => Promise<void>;
}

/** What a caller holds for a scheduled job. */
export interface ScheduledJobHandle {
  /** Removes the job's future runs; a run already going finishes. A repeat does nothing. */
  cancel(): void;
}

/** One wake: when it was noticed and the wall-clock gap that marked it, both in milliseconds. */
export interface WakeSignal {
  readonly noticedAt: number;
  readonly awayMs: number;
}

/** The clocks and the log the scheduler runs with; the clocks are injectable for tests. */
export interface SchedulerDeps {
  readonly writeServiceLog: ServiceLogWriter;
  /** Wall clock in milliseconds since the epoch; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly monotonicNow?: () => number;
}

interface PendingRun {
  readonly entryId: number;
  readonly name: string;
  // On the monotonic clock.
  readonly runAt: number;
  readonly run: (signal: AbortSignal) => Promise<void>;
}

/**
 * The daemon's one scheduler and its wake signal. Jobs run one at a time in deadline order; a job
 * scheduled after `stop` throws.
 */
export class Scheduler {
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #now: () => number;
  readonly #monotonicNow: () => number;
  // Kept sorted by `runAt`, then by scheduling order, so the head is always the next due run.
  #pending: PendingRun[] = [];
  readonly #wakeListeners = new Set<(wake: WakeSignal) => void>();
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #nextEntryId = 0;
  #isStopped = false;
  // Aborted at the stop, so the job running then ends early.
  readonly #stop = new AbortController();
  #lastWallLook: number;
  #lastMonotonicLook: number;
  // When the timer was armed, on the wall clock.
  #armedAtWall = 0;

  constructor(deps: SchedulerDeps) {
    this.#writeServiceLog = deps.writeServiceLog;
    this.#now = deps.now ?? Date.now;
    this.#monotonicNow = deps.monotonicNow ?? (() => performance.now());
    this.#lastWallLook = this.#now();
    this.#lastMonotonicLook = this.#monotonicNow();
  }

  /** Schedules one run of `job` at its instant. Throws once the scheduler has stopped. */
  schedule(job: ScheduledJob): ScheduledJobHandle {
    const entryId = this.#insert(job.name, this.#monotonicNow() + job.delayMs, job.run);
    return {
      cancel: () => {
        this.#remove(entryId);
      },
    };
  }

  /**
   * Schedules `job` to run, then to run again `intervalMs` after each run ends, so two runs of one
   * job never overlap. Throws once the scheduler has stopped.
   */
  scheduleRepeating(job: RepeatingJob): ScheduledJobHandle {
    let isCanceled = false;
    let entryId = -1;
    const runThenRearm = async (signal: AbortSignal): Promise<void> => {
      try {
        await job.run(signal);
      } finally {
        if (!isCanceled && !this.#isStopped) {
          entryId = this.#insert(job.name, this.#monotonicNow() + job.intervalMs, runThenRearm);
        }
      }
    };
    entryId = this.#insert(job.name, this.#monotonicNow() + (job.firstDelayMs ?? 0), runThenRearm);
    return {
      cancel: () => {
        isCanceled = true;
        this.#remove(entryId);
      },
    };
  }

  /**
   * Calls `listener` on each wake from now on, until the returned detach runs. A listener's throw
   * is written to the service log.
   */
  onWake(listener: (wake: WakeSignal) => void): () => void {
    // A wrapper, so one function attached twice detaches once per attach.
    const attached = (wake: WakeSignal): void => {
      listener(wake);
    };
    this.#wakeListeners.add(attached);
    this.#arm();
    return () => {
      this.#wakeListeners.delete(attached);
    };
  }

  /**
   * Runs nothing more: clears the timer and every pending run, aborts the signal the one going was
   * given, then waits for it.
   */
  async stop(): Promise<void> {
    this.#isStopped = true;
    this.#stop.abort();
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = [];
    this.#wakeListeners.clear();
    await this.#running;
  }

  #insert(name: string, runAt: number, run: (signal: AbortSignal) => Promise<void>): number {
    if (this.#isStopped) {
      throw new Error(`The scheduler has stopped, so the job "${name}" cannot be scheduled`);
    }
    const entryId = this.#nextEntryId;
    this.#nextEntryId += 1;
    const entry: PendingRun = { entryId, name, runAt, run };
    // Insert after every run due at or before this one, so equal instants keep scheduling order.
    let index = this.#pending.length;
    while (index > 0 && (this.#pending[index - 1]?.runAt ?? 0) > runAt) {
      index -= 1;
    }
    this.#pending.splice(index, 0, entry);
    this.#arm();
    return entryId;
  }

  #remove(entryId: number): void {
    const index = this.#pending.findIndex((entry) => entry.entryId === entryId);
    if (index !== -1) {
      this.#pending.splice(index, 1);
      this.#arm();
    }
  }

  // Arms the one timer for the next due run, or for the next wake check when sooner. While a run
  // is going the drain re-arms when it ends.
  #arm(): void {
    if (this.#isStopped || this.#running !== undefined) {
      return;
    }
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const head = this.#pending[0];
    if (head === undefined && this.#wakeListeners.size === 0) {
      return;
    }
    const untilHead =
      head === undefined ? WAKE_CHECK_INTERVAL_MS : head.runAt - this.#monotonicNow();
    const delay = Math.max(0, Math.min(untilHead, WAKE_CHECK_INTERVAL_MS));
    this.#armedAtWall = this.#now();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#onTimer();
    }, delay);
    this.#timer.unref();
  }

  #onTimer(): void {
    this.#lookForWake(this.#now() - this.#armedAtWall);
    this.#running = this.#drainDueRuns().finally(() => {
      this.#running = undefined;
      this.#arm();
    });
  }

  async #drainDueRuns(): Promise<void> {
    for (;;) {
      const head = this.#pending[0];
      if (this.#isStopped || head === undefined || head.runAt > this.#monotonicNow()) {
        return;
      }
      this.#pending.shift();
      try {
        await head.run(this.#stop.signal);
      } catch (error) {
        this.#writeServiceLog(
          `The scheduled job "${head.name}" failed: ${describeRejection(error)}`,
        );
      }
      // A long run can span a sleep, so the clocks are compared again before the next one.
      this.#lookForWake();
    }
  }

  // `timerGapMs` is the wall-clock time between arming the timer and its firing; the timer is never
  // armed for longer than a wake check, so a gap past the threshold is time the process missed.
  #lookForWake(timerGapMs = 0): void {
    const wallNow = this.#now();
    const monotonicNow = this.#monotonicNow();
    const clockGapMs = wallNow - this.#lastWallLook - (monotonicNow - this.#lastMonotonicLook);
    const awayMs = Math.max(timerGapMs, clockGapMs);
    this.#lastWallLook = wallNow;
    this.#lastMonotonicLook = monotonicNow;
    if (awayMs <= WAKE_GAP_THRESHOLD_MS) {
      return;
    }
    const wake: WakeSignal = { noticedAt: wallNow, awayMs };
    for (const listener of this.#wakeListeners) {
      try {
        listener(wake);
      } catch (error) {
        this.#writeServiceLog(`A wake listener failed: ${describeRejection(error)}`);
      }
    }
  }
}
