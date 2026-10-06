// Returns memory a quiet transcript no longer needs: measurement priors for rows the window
// dropped, and parked states. No timer runs: the pass happens on the next activity after a gap of
// at least the dwell, because a settled frame arms nothing. It never takes what the frame is
// using: priors go only for rows the window does not hold at that moment, and parked states
// belong to rows the window already dropped.

import { TRANSCRIPT_IDLE_TRIM_DWELL_MS } from "./caps.js";
import { type RowMeasurementTable } from "./row-measurement-table.js";
import { type Clock } from "#renderer/lib/clock.js";
import { type TranscriptWindow } from "./window-cap.js";

/** Dependencies of an `IdleMemoryTrim`: the clock and the window and table it trims. */
export interface IdleMemoryTrimOptions {
  readonly clock: Clock;
  readonly window: TranscriptWindow;
  readonly measurements: RowMeasurementTable;
}

/** Trims memory held for rows the transcript no longer shows, after a quiet period. */
export class IdleMemoryTrim {
  readonly #clock: Clock;
  readonly #window: TranscriptWindow;
  readonly #measurements: RowMeasurementTable;

  #lastActivityMs: number | undefined;

  public constructor(options: IdleMemoryTrimOptions) {
    this.#clock = options.clock;
    this.#window = options.window;
    this.#measurements = options.measurements;
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
    if (lastActivityMs !== undefined && nowMs - lastActivityMs >= TRANSCRIPT_IDLE_TRIM_DWELL_MS) {
      this.#runPass();
    }
  }

  #runPass(): void {
    this.#measurements.forgetAllExcept(this.#window.rows().map((row) => row.key));
    this.#window.releaseParkedStates();
  }
}
