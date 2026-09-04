// Does this display quantize a programmatic scroll offset to whole pixels?
//
// A question about the DISPLAY, not about the ledger — which is why it is its own
// object. A fractional-device-pixel-ratio monitor rounds a written `scrollTop` and
// an integral one keeps it, and nothing in the platform reports which. The only way
// to find out is to write and read back.
//
// WHY IT MATTERS. `scroll-chokepoint.ts` lets the scroll
// controller skip a write that would change nothing — an entirely ordinary
// optimisation on a display that rounds, and a BUG on one that does not, because
// there the two offsets differ by a fraction of a pixel that the reader can see
// accumulate. So skipping is gated on a confirmed answer, never on a guess.
//
// TWO WITNESSES, NOT ONE. A single readback can be explained by a user scroll
// landing between the write and the read, and the only cost of waiting for a second
// is one unskipped no-op write. Two readings that disagree discard both rather than
// averaging two contradictions.

import { SCROLL_QUANTIZATION_WITNESS_COUNT } from "./frame-bounds.js";

export class WholePixelQuantizationLearner {
  readonly #witnessCount: number;
  /** Agreeing readbacks so far, bounded by the count that settles the question. */
  readonly #witnesses: boolean[] = [];

  #verdict: boolean | undefined;

  public constructor(witnessCount: number = SCROLL_QUANTIZATION_WITNESS_COUNT) {
    this.#witnessCount = witnessCount;
  }

  /**
   * Fold one write and its readback in.
   *
   * Only a FRACTIONAL request is evidence: an integral request lands on an integer
   * on every display, so counting it would confirm quantization everywhere.
   *
   * The reading is INTEGRALITY, not an epsilon compare against the rounded value —
   * that comparison is vacuously true, because rounding never moves a number by as
   * much as an epsilon worth having. A fractional request that reads back integral
   * quantized; one that reads back fractional did not, which is also the honest
   * answer for a display that quantizes to half a device pixel rather than to one.
   */
  public observe(requestedScrollTop: number, appliedScrollTop: number): void {
    if (this.#verdict !== undefined || Number.isInteger(requestedScrollTop)) {
      return;
    }
    const witness = Number.isInteger(appliedScrollTop);
    const previous = this.#witnesses[0];
    if (previous !== undefined && previous !== witness) {
      // Disagreement, so the earlier reading was a concurrent user scroll rather
      // than the display's rule. Start over rather than average two contradictions.
      this.#witnesses.length = 0;
    }
    this.#witnesses.push(witness);
    if (this.#witnesses.length >= this.#witnessCount) {
      this.#verdict = witness;
      this.#witnesses.length = 0;
    }
  }

  /**
   * Whether writing `requestedScrollTop` over `currentScrollTop` would change
   * nothing a reader could see.
   *
   * Fail-closed while the question is open: an unanswered display is treated as one
   * that does not quantize, so the write happens.
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
