// One terminal session's output and exit, held while the spawn that started it has not resolved,
// since until then its caller does not know the session id. Once released they are delivered in
// order and every later one as it comes.

/**
 * The most output held for one session; past it the holder pauses the terminal's read, so
 * nothing is dropped and memory stays bounded.
 */
const MAX_HELD_OUTPUT_BYTES = 64 * 1024;

/** The events of one session, held until released. */
export class HeldSessionEvents {
  readonly #onOverBound: () => void;
  #deliveries: Array<() => void> | undefined = [];
  #heldBytes = 0;

  /** `onOverBound` is called once, when the held output first passes its bound. */
  constructor(onOverBound: () => void) {
    this.#onOverBound = onOverBound;
  }

  /** Runs `delivery` now once released, and holds it until then; `byteCount` is its output. */
  deliver(delivery: () => void, byteCount: number): void {
    if (this.#deliveries === undefined) {
      delivery();
      return;
    }
    const wasWithinBound = this.#heldBytes <= MAX_HELD_OUTPUT_BYTES;
    this.#deliveries.push(delivery);
    this.#heldBytes += byteCount;
    if (wasWithinBound && this.#heldBytes > MAX_HELD_OUTPUT_BYTES) {
      this.#onOverBound();
    }
  }

  /** Whether the held output is past its bound, which its release ends. */
  get isOverBound(): boolean {
    return this.#deliveries !== undefined && this.#heldBytes > MAX_HELD_OUTPUT_BYTES;
  }

  /** Whether anything is held. */
  get isHolding(): boolean {
    return this.#deliveries !== undefined && this.#deliveries.length > 0;
  }

  /** Ends the holding and answers what was held, in order. */
  release(): Array<() => void> {
    const held = this.#deliveries ?? [];
    this.#deliveries = undefined;
    return held;
  }
}
