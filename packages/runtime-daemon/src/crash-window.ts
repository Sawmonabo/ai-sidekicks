// The daemon's one sliding window over a process's recent crashes: how long to wait before each
// restart, and when the crashes come too close together to restart at all.

/**
 * How long a provider process waits before each automatic restart, in milliseconds, indexed by how
 * many crashes the three-minute window already holds. A crash that falls past the list's end, the
 * fifth, ends the restarts.
 */
const PROVIDER_RESTART_WAITS_MS = [0, 1_000, 2_000, 4_000] as const;

// The span the provider's crashes are counted over.
const PROVIDER_CRASH_WINDOW_MS = 180_000;

/**
 * The crashes of one process over a sliding window. Each crash answers the wait before its restart
 * from the waits list, indexed by the crashes the window already held, or a crash loop once the
 * window holds as many crashes as the list has waits. It holds at most one entry per wait.
 */
export class CrashWindow {
  readonly #windowMs: number;
  readonly #restartWaitsMs: readonly number[];
  // Crash times in the order they were recorded, oldest first.
  readonly #crashTimes: number[] = [];

  /**
   * The provider's window by default: three minutes over {@link PROVIDER_RESTART_WAITS_MS}.
   * Another process passes its own span, in milliseconds, and waits.
   */
  constructor(
    options: { readonly windowMs: number; readonly restartWaitsMs: readonly number[] } = {
      windowMs: PROVIDER_CRASH_WINDOW_MS,
      restartWaitsMs: PROVIDER_RESTART_WAITS_MS,
    },
  ) {
    this.#windowMs = options.windowMs;
    this.#restartWaitsMs = options.restartWaitsMs;
  }

  /**
   * Records a crash at `at`, in milliseconds on the caller's clock, and answers the wait before
   * restarting, or `crashLoop` when the window already held one crash per wait. A crash older than
   * the window by `at` no longer counts.
   */
  recordCrash(at: number): { readonly restartAfterMs: number } | { readonly crashLoop: true } {
    const cutoff = at - this.#windowMs;
    while (this.#crashTimes[0] !== undefined && this.#crashTimes[0] <= cutoff) {
      this.#crashTimes.shift();
    }
    const restartAfterMs = this.#restartWaitsMs[this.#crashTimes.length];
    if (restartAfterMs === undefined) {
      return { crashLoop: true };
    }
    this.#crashTimes.push(at);
    return { restartAfterMs };
  }

  /** Forgets every crash, so the next one counts from the first; a person's restart does this. */
  clear(): void {
    this.#crashTimes.length = 0;
  }
}
