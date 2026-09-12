// What the ledger frame stops holding once the ledger has been still for a while.
//
// THE TWO THINGS A QUIET LEDGER KEEPS AND CANNOT USE. The cap next door bounds the
// rows the window holds, and both of the tables that hang off those rows outlive
// them on purpose:
//
//   • A measurement prior is kept for a row the cap dropped, because a row that
//     comes back should come back the height it was rather than at the estimate. The
//     prune drops the priors of the rows IT took — and a row that left the window any
//     other way (narrowed away, folded, replayed past, re-projected) keeps its prior
//     for as long as this frame lives.
//   • A parked lease is kept so a row a person had expanded comes back expanded when
//     they page to it. `row-lease-table.ts` states the bound in the same breath: "a
//     person paging back expects the row they had open a moment ago to still be
//     open, and nobody expects that of a row pruned an hour ago." The cap on that
//     table bounds it by COUNT; nothing bounds it by time.
//
// This is the time half of that same rule, and it is deliberately not a second cap:
// the count bound stays exactly as it is, and this returns what is left after a quiet
// period that has already made the leases worthless by that module's own statement of
// what they are for.
//
// THERE IS NO TIMER, AND THAT IS THE DESIGN RATHER THAN A SIMPLIFICATION.
// A timer on the console's steady state is ruled out — no timer fires except the
// refresh scheduler's deadline and the presence heartbeat — and `LedgerViewport.test.tsx`
// holds the ledger to it by
// asserting a settled frame has armed nothing. A dwell timer was written here first
// and that case caught it. So the pass runs on the NEXT activity after a quiet period
// instead: the gap is measured against the clock, and a `run` that arrives more than a
// dwell after the previous one trims before it records itself.
//
// WHAT THAT COSTS, STATED RATHER THAN GLOSSED. A ledger that goes quiet and is never
// touched again keeps what it was holding until the frame is disposed — and a disposed
// frame drops both tables whole, so nothing outlives it either way. The case this
// leaves uncovered is a live frame nobody touches, which is also a frame whose
// footprint has stopped growing. The case it covers is the one that actually
// accumulates: a long session that keeps working, where rows churn through the window
// for hours between the pauses a person takes.
//
// IT CAN NEVER TAKE SOMETHING THE FRAME IS USING, and that is a property rather than
// a hope. It drops priors for rows the window does not hold — the window is asked at
// the moment of the pass, so a row on screen is retained by construction — and it
// drops parked leases, which by definition belong to rows the window has already
// dropped.

import { LEDGER_IDLE_TRIM_DWELL_MS } from "../../frame-bounds.js";
import { type RowMeasurementLedger } from "../../measurement/index.js";
import { type ConsoleClock } from "../../../../core/index.js";
import { type LedgerWindow } from "./window-cap.js";

export interface LedgerIdleMemoryTrimOptions {
  readonly clock: ConsoleClock;
  readonly window: LedgerWindow;
  readonly measurements: RowMeasurementLedger;
  /** Overridden by tests only; `frame-bounds.ts` owns the shipped value. */
  readonly dwellMs?: number;
}

/** What one pass returned, and when. */
export interface LedgerIdleTrimPass {
  /** The clock's reading when the pass ran. */
  readonly atMs: number;
  /** Measurement priors dropped, for rows the window no longer held. */
  readonly measurementPriors: number;
  /** Parked leases dropped. */
  readonly parkedLeases: number;
}

export class LedgerIdleMemoryTrim {
  readonly #clock: ConsoleClock;
  readonly #window: LedgerWindow;
  readonly #measurements: RowMeasurementLedger;
  readonly #dwellMs: number;

  #lastActivityMs: number | undefined;
  #lastPass: LedgerIdleTrimPass | undefined;

  public constructor(options: LedgerIdleMemoryTrimOptions) {
    this.#clock = options.clock;
    this.#window = options.window;
    this.#measurements = options.measurements;
    this.#dwellMs = options.dwellMs ?? LEDGER_IDLE_TRIM_DWELL_MS;
  }

  /**
   * The last pass that actually returned something, or `undefined`.
   *
   * A pass that took nothing is not recorded. The reading is a record of memory
   * returned, and overwriting a real release with a later no-op would report a frame
   * as having just trimmed when what it did was find nothing to trim.
   */
  public get lastPass(): LedgerIdleTrimPass | undefined {
    return this.#lastPass;
  }

  /**
   * Something happened in the ledger. Trim first if the ledger was quiet before it.
   *
   * The gap is measured against the PREVIOUS activity, so the pass runs at the end of
   * the quiet period rather than at the start of it — which is what makes the tables
   * it walks the ones the quiet period made stale. Recording the stamp afterwards is
   * what keeps it once per quiet period: the next call measures against this moment
   * and finds no gap.
   *
   * The very first call records without trimming. A frame that has just been built
   * has been quiet for its whole life and has nothing yet to give back.
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
