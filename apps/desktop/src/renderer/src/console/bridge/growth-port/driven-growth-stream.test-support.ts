// The subscription a case drives by hand, through each of the three ways one finishes.
//
// A scenario's own stream wakes on beats, which is right for a scenario and wrong for
// a case whose subject is HOW a stream stops: nothing in a scenario ends one, and
// nothing in one breaks one either. Both endings matter, and they are different — a
// producer that finished said everything it had, and one that rejected part-way left a
// reader holding a claim that is no longer true and a handle nobody closed.
//
// GENERIC IN THE FRAME, AND DECLARED ONCE HERE. The shell's report binding and the
// provider-import progress reading each drain a `GrowthStream` and each has to be
// driven through the same three endings; written twice, the two doubles would agree
// about what a close counts as only until somebody fixed one of them. It sits beside
// `growth-outcome.ts` because that is where the interface it implements is declared,
// which makes this the lowest module in the console's DAG that owns its own subject.
//
// THE CLOSE IS COUNTED RATHER THAN FLAGGED. "Closed at least once" cannot tell a
// drain that let go of its handle from one that let go of it twice, and the second is
// a double release on the live wire.

import type { GrowthStream } from "./growth-outcome.js";

export class DrivenGrowthStream<TFrame> implements GrowthStream<TFrame> {
  #pending: TFrame | undefined;
  #wake: (() => void) | undefined;
  #failure: Error | undefined;
  #closed = false;
  #closeCount = 0;

  public get events(): AsyncIterable<TFrame> {
    return this.#iterate();
  }

  /**
   * How many times the drain closed this stream.
   *
   * Zero after a channel that broke is a subscription the reader has stopped reading
   * and never let go of — which on the live wire is one the daemon is still serving.
   */
  public get closeCount(): number {
    return this.#closeCount;
  }

  public close(): void {
    this.#closeCount += 1;
    this.#closed = true;
    this.#wake?.();
    this.#wake = undefined;
  }

  /** Deliver one frame to whatever is draining. */
  public emit(frame: TFrame): void {
    this.#pending = frame;
    this.#wake?.();
    this.#wake = undefined;
  }

  /** Break the channel: the iterator REJECTS, the way a torn-down subscription does. */
  public fail(failure: Error): void {
    this.#failure = failure;
    this.#wake?.();
    this.#wake = undefined;
  }

  async *#iterate(): AsyncGenerator<TFrame> {
    while (!this.#closed) {
      // Read at the top of the pass rather than beside the yield, so a failure raised
      // while the generator was parked is the first thing it sees when it wakes.
      if (this.#failure !== undefined) {
        throw this.#failure;
      }
      const pending = this.#pending;
      if (pending !== undefined) {
        this.#pending = undefined;
        yield pending;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}
