// A served growth subscription, for a fixture that has frames to hand out.
//
// `GrowthStream` is "an async iterable the caller drains and closes"
// (`growth-port/growth-outcome.ts`), and until this module the fixture served none:
// every subscription on the port refused, so a surface whose only input is a feed
// could be built and never driven. This is the one implementation of that shape in
// the console, so a second fixture needing a stream takes it rather than writing a
// generator of its own.
//
// A QUEUE AND A WAITER, WHICH IS THE WHOLE OF IT. A push with a reader waiting hands
// the value straight over; a push with none parks it, in order, so a frame pushed
// before anyone iterated is not lost — which is exactly the case a deep-link fixture
// hits, since the pending frame is scripted at the tick the scenario starts and the
// surface subscribes on its first mount.
//
// CLOSING IS TERMINAL AND IDEMPOTENT. `close()` ends the iteration for the reader
// that is waiting and for every later one, and a push after it is dropped rather than
// queued — a stream nobody can read again must not accumulate. A caller that closes
// twice is the ordinary React case, where a cleanup runs after the owner has already
// released the feed.
//
// NOTHING HERE READS A CLOCK. The scenario's frozen clock decides WHEN a frame is
// pushed, which is the pusher's business; this holds the frames and the reader.

// Taken by its own specifier rather than through `growth-port/index.js`: that door
// re-exports `growth-port.ts`, which reaches `growth-signatures/index.js`, which
// reaches the invite plane's own signature — and the invite signature names this
// stream. The deep edge is the remedy for that cycle, which is the rule the growth
// port's own door states for its plane tables.
import type { GrowthStream } from "../growth-port/growth-outcome.js";

/**
 * One served subscription's frames.
 *
 * A class with private fields rather than a generator closure: it owns a queue, a
 * waiter, and a terminal state, so it owns a teardown — and a generator that captured
 * the same three in a closure would give a test nothing to assert against except by
 * driving the iteration.
 */
export class FixtureGrowthStream<TEvent> implements GrowthStream<TEvent> {
  readonly #queued: TEvent[] = [];
  #waiting: ((result: IteratorResult<TEvent>) => void) | undefined;
  #isClosed = false;

  /** Whether `close()` has been called. Terminal once true. */
  public get isClosed(): boolean {
    return this.#isClosed;
  }

  /** Frames pushed and not yet taken. Zero while a reader is parked on the waiter. */
  public get queuedCount(): number {
    return this.#queued.length;
  }

  /**
   * Hand one frame to the reader, or hold it until there is one.
   *
   * Dropped after close rather than queued or thrown: a producer that pushes into a
   * released feed is the ordinary teardown race, and raising there would turn one
   * surface's unmount into the pusher's error.
   */
  public push(event: TEvent): void {
    if (this.#isClosed) {
      return;
    }
    const waiting = this.#waiting;
    if (waiting === undefined) {
      this.#queued.push(event);
      return;
    }
    this.#waiting = undefined;
    waiting({ value: event, done: false });
  }

  /** End the iteration, for the reader parked now and for every later one. */
  public close(): void {
    if (this.#isClosed) {
      return;
    }
    this.#isClosed = true;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    // The parked reader is released with a DONE result rather than left forever: a
    // `for await` that never settles holds its whole enclosing task open, which under
    // a test harness is a hang rather than a failure.
    waiting?.({ value: undefined, done: true });
  }

  /**
   * The frames, as one iteration.
   *
   * ONE READER, and the shape says so rather than a comment claiming it: the waiter
   * is a single slot, so a second concurrent `next()` would replace the first's
   * resolver and strand it. The console's own consumers drain a feed from one place —
   * the owner that opened it — and a fixture that supported fan-out would be modelling
   * a wire property the growth signature does not promise.
   */
  public get events(): AsyncIterable<TEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<TEvent> => ({
        next: async (): Promise<IteratorResult<TEvent>> => {
          const queued = this.#queued.shift();
          if (queued !== undefined) {
            return { value: queued, done: false };
          }
          if (this.#isClosed) {
            return { value: undefined, done: true };
          }
          return await new Promise<IteratorResult<TEvent>>((resolve) => {
            this.#waiting = resolve;
          });
        },
        // `return` is what a `break` out of a `for await` calls. Without it the
        // stream would stay open behind a consumer that had already walked away, and
        // its queue would grow for the life of the window.
        return: async (): Promise<IteratorResult<TEvent>> => {
          this.close();
          return { value: undefined, done: true };
        },
      }),
    };
  }
}
