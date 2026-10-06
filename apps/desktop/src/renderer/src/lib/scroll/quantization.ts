// Does this display quantize a programmatic scroll offset to whole pixels? Nothing in the
// platform reports it, so the learner writes a fractional offset and reads back.
// Skipping a no-op write is an optimization on a display that rounds and a visible bug on one
// that does not, so skipping waits for a confirmed answer.
// Two agreeing readbacks are required: one can be a user scroll landing between write and read.

/**
 * Agreeing witnesses before the controller believes this display quantizes programmatic
 * `scrollTop` writes to whole pixels. Two, because a single readback can be explained by a
 * concurrent user scroll landing between the write and the read.
 */
const SCROLL_QUANTIZATION_SAMPLE_COUNT = 2;

/** Learns from write/readback pairs whether the display rounds programmatic scroll offsets. */
export class WholePixelQuantizationLearner {
  readonly #witnessCount: number;
  /** Readbacks since the last disagreement, bounded by the count that settles the question. */
  readonly #witnesses: boolean[] = [];

  #verdict: boolean | undefined;

  public constructor(witnessCount: number = SCROLL_QUANTIZATION_SAMPLE_COUNT) {
    this.#witnessCount = witnessCount;
  }

  /**
   * Fold one write and its readback in. Only a fractional request is evidence, since an
   * integral one lands on an integer on every display. The reading is integrality, not an
   * epsilon compare, which rounding never trips.
   */
  public observe(requestedScrollTop: number, appliedScrollTop: number): void {
    if (this.#verdict !== undefined || Number.isInteger(requestedScrollTop)) {
      return;
    }
    const witness = Number.isInteger(appliedScrollTop);
    const previous = this.#witnesses[0];
    if (previous !== undefined && previous !== witness) {
      // Disagreement means the earlier reading was a concurrent user scroll; start over.
      this.#witnesses.length = 0;
    }
    this.#witnesses.push(witness);
    if (this.#witnesses.length >= this.#witnessCount) {
      this.#verdict = witness;
      this.#witnesses.length = 0;
    }
  }

  /**
   * Whether writing `requestedScrollTop` over `currentScrollTop` would change nothing a
   * reader could see. Fails closed while the question is open, so the write happens.
   */
  public isNoOpWrite(requestedScrollTop: number, currentScrollTop: number): boolean {
    return (
      this.#verdict === true && Math.round(requestedScrollTop) === Math.round(currentScrollTop)
    );
  }

  /** `true`, `false`, or `undefined` while the question is still open. */
  public get verdict(): boolean | undefined {
    return this.#verdict;
  }
}
