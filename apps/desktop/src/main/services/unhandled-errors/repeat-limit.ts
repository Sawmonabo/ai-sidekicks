// How many unhandled errors main writes a minute, so a window that throws on every frame cannot
// fill the service's log. A minute starts at the first error after a quiet one; within it each
// distinct error is written at most three times and all errors together at most thirty times, and
// the rest are counted and told in one line once the minute ends. Only an error that was written
// is remembered, so the minute holds at most thirty fingerprints.

/** The bounds on writing unhandled errors. */
export const UNHANDLED_ERROR_RATE_BOUNDS = {
  /** The length of one counting window, in milliseconds. */
  windowMs: 60_000,
  /** How often one error is written in a window. */
  perError: 3,
  /** How many errors in all are written in a window. */
  all: 30,
} as const;

/** Counts errors against the bounds and tells how many were held back once each window ends. */
export class RepeatLimit {
  readonly #onHeldBack: (count: number) => void;
  /** Each error written in this window, by its fingerprint, and how often. */
  readonly #written = new Map<string, number>();
  #writtenCount = 0;
  #heldBackCount = 0;
  #windowEnd: ReturnType<typeof setTimeout> | undefined;

  /** `onHeldBack` hears, once a window ends, how many errors it held back, when it held any. */
  public constructor(onHeldBack: (count: number) => void) {
    this.#onHeldBack = onHeldBack;
  }

  /** Whether the error with `fingerprint` is written now; one that is not is counted. */
  public admit(fingerprint: string): boolean {
    if (this.#windowEnd === undefined) {
      // Unreferenced, so a window still counting never keeps main from exiting.
      this.#windowEnd = setTimeout(() => {
        this.#endWindow();
      }, UNHANDLED_ERROR_RATE_BOUNDS.windowMs);
      this.#windowEnd.unref();
    }
    const writtenTimes = this.#written.get(fingerprint) ?? 0;
    if (
      writtenTimes >= UNHANDLED_ERROR_RATE_BOUNDS.perError ||
      this.#writtenCount >= UNHANDLED_ERROR_RATE_BOUNDS.all
    ) {
      this.#heldBackCount += 1;
      return false;
    }
    this.#written.set(fingerprint, writtenTimes + 1);
    this.#writtenCount += 1;
    return true;
  }

  #endWindow(): void {
    const heldBackCount = this.#heldBackCount;
    this.#written.clear();
    this.#writtenCount = 0;
    this.#heldBackCount = 0;
    this.#windowEnd = undefined;
    if (heldBackCount > 0) {
      this.#onHeldBack(heldBackCount);
    }
  }
}
