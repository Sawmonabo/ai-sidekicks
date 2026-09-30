// Returns memory a quiet transcript no longer needs: measurement priors for rows the window
// dropped, and parked leases. No timer runs: the pass happens on the next activity after a gap of
// at least the dwell, because a settled frame arms nothing. It never takes what the frame is
// using: priors go only for rows the window does not hold at that moment, and parked leases
// belong to rows the window already dropped.

import { TRANSCRIPT_IDLE_TRIM_DWELL_MS } from "./viewport-constants.js";
import { type RowMeasurementTable } from "./row-measurement-table.js";
import { type Clock } from "@renderer/lib/clock.js";
import { type TranscriptWindow } from "./window-cap.js";

/** Dependencies of an `IdleMemoryTrim`: the clock and the window and table it trims. */
export interface IdleMemoryTrimOptions {
  readonly clock: Clock;
  readonly window: TranscriptWindow;
  readonly measurements: RowMeasurementTable;
  /** Overridden by tests only; `viewport-constants.ts` owns the shipped value. */
  readonly dwellMs?: number;
}

/** What one pass returned, and when. */
export interface IdleTrimPass {
  /** The clock's reading when the pass ran. */
  readonly atMs: number;
  /** Measurement priors dropped, for rows the window no longer held. */
  readonly measurementPriors: number;
  /** Parked leases dropped. */
  readonly parkedLeases: number;
}

/** Trims memory held for rows the transcript no longer shows, after a quiet period. */
export class IdleMemoryTrim {
  readonly #clock: Clock;
  readonly #window: TranscriptWindow;
  readonly #measurements: RowMeasurementTable;
  readonly #dwellMs: number;

  #lastActivityMs: number | undefined;
  #lastPass: IdleTrimPass | undefined;

  public constructor(options: IdleMemoryTrimOptions) {
    this.#clock = options.clock;
    this.#window = options.window;
    this.#measurements = options.measurements;
    this.#dwellMs = options.dwellMs ?? TRANSCRIPT_IDLE_TRIM_DWELL_MS;
  }

  /**
   * The last pass that returned something, or `undefined`. A pass that took nothing is not
   * recorded, so a no-op never overwrites a real release.
   */
  public get lastPass(): IdleTrimPass | undefined {
    return this.#lastPass;
  }

  /**
   * Records that something happened in the transcript, trimming first if it was quiet before.
   *
   * The gap is measured against the previous activity, so the pass runs at the end of a quiet
   * period and once per period. The first call only records: a new frame has nothing to give
   * back.
   */
  public noteActivity(): void {
    const nowMs = this.#clock.now();
    const lastActivityMs = this.#lastActivityMs;
    this.#lastActivityMs = nowMs;
    if (lastActivityMs !== undefined && nowMs - lastActivityMs >= this.#dwellMs) {
      this.#runPass(nowMs);
    }
  }

  #runPass(atMs: number): void {
    const retainedRowKeys = this.#window.rows().map((row) => row.key);
    const measurementPriors = this.#measurements.forgetAllExcept(retainedRowKeys);
    const parkedLeases = this.#window.releaseParkedLeases();
    if (measurementPriors === 0 && parkedLeases === 0) {
      return;
    }
    this.#lastPass = { atMs, measurementPriors, parkedLeases };
  }
}
