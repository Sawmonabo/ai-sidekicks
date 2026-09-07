// The shell's window signals, as streams a fixture can drive.
//
// SPLIT FROM `fixture-auxiliary-windows.ts`, WHICH OWNS THE WINDOWS. That module
// holds which windows are open and what each operation answers; this one holds the
// DELIVERY — an open stream, a queue, and the wake that hands a report to whoever is
// draining. The cut is along that seam rather than at a line count: the window set
// changes when an operation is added, and the delivery does not change at all.
//
// AND IT IS ONE IMPLEMENTATION BECAUSE THERE ARE TWO SIGNALS. The shell reports a
// window's pane coming back in two ways — the crash nobody asked for and the return
// somebody did — and they carry different values for the deck's own reason: it must
// render a note for one and nothing for the other. The DELIVERY is identical, so a
// second copy of it would be two places for the queue-before-close ordering below to
// be right, and the copy that went stale would be the one nothing tested.

import type { GrowthStream } from "../growth-port/growth-outcome.js";

/**
 * One window signal, as an open stream that reports what the plane tells it.
 *
 * A REAL STREAM AND NOT AN EMPTY ONE. An iterable that ended immediately would reach
 * a watch's drain as a producer closing the signal, and the placeholder would carry
 * "the signal that reports a lost window ended" in every fixture window — a stated
 * fault where the truth is that nothing has gone wrong. So it stays open until the
 * subscriber closes it, exactly as the daemon's would.
 *
 * ONE CONSUMER, and the generator is minted once for that reason: a watch drains
 * `events` in a single `for await`, and handing a second reader its own generator
 * over one queue would let two drains split a report between them.
 */
export class FixtureWindowSignalStream<TEvent> implements GrowthStream<TEvent> {
  readonly #pending: TEvent[] = [];
  readonly #onClosed: (stream: FixtureWindowSignalStream<TEvent>) => void;
  #events: AsyncGenerator<TEvent> | undefined;
  #wake: (() => void) | undefined;
  #isClosed = false;

  public constructor(onClosed: (stream: FixtureWindowSignalStream<TEvent>) => void) {
    this.#onClosed = onClosed;
  }

  public get events(): AsyncIterable<TEvent> {
    this.#events ??= this.#deliver();
    return this.#events;
  }

  /**
   * Put one report on the stream.
   *
   * Queued and then woken, in that order, so a report that lands while the drain is
   * parked on the wake promise is read on the pass the wake releases rather than on
   * the one after it.
   */
  public report(event: TEvent): void {
    if (this.#isClosed) {
      return;
    }
    this.#pending.push(event);
    this.#release();
  }

  /**
   * Close the signal, which is what ends the drain.
   *
   * Idempotent, because a watch closes a stream it was handed after its round was
   * superseded as well as the one it installed, and both paths reach here.
   */
  public close(): void {
    if (this.#isClosed) {
      return;
    }
    this.#isClosed = true;
    this.#release();
    this.#onClosed(this);
  }

  #release(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  /**
   * Hand over every queued report, then wait for the next one or for the close.
   *
   * The queue is drained BEFORE the closed flag is read, so a report that arrives in
   * the same turn as a close is still delivered: a report that reached the plane and
   * then vanished because the subscriber was tearing down would be a window event
   * nothing ever mentioned.
   */
  async *#deliver(): AsyncGenerator<TEvent> {
    let isDraining = true;
    while (isDraining) {
      const next = this.#pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#isClosed) {
        isDraining = false;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

/**
 * Every open stream of one signal, and the fan-out that feeds them.
 *
 * A CLASS RATHER THAN A `Set` HELD BY THE PLANE, because the membership rule and the
 * fan-out are one thing: a stream joins when it is opened and leaves when it closes
 * itself, and a report goes to whatever is a member at that moment. Held as a bare
 * `Set` beside the plane, the two signals would each restate the same three lines,
 * and the plane would own a lifetime it has nothing to say about.
 */
export class FixtureWindowSignalStreams<TEvent> {
  readonly #open = new Set<FixtureWindowSignalStream<TEvent>>();

  /** Open one stream. It leaves the set by closing itself, never by being removed. */
  public subscribe(): FixtureWindowSignalStream<TEvent> {
    const stream = new FixtureWindowSignalStream<TEvent>((closed) => {
      this.#open.delete(closed);
    });
    this.#open.add(stream);
    return stream;
  }

  /** Report to every subscriber. A signal nobody is draining reaches nobody. */
  public report(event: TEvent): void {
    for (const stream of this.#open) {
      stream.report(event);
    }
  }
}
