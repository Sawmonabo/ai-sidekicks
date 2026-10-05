// Renderer crashes in a row, and how the renderer is reloaded after each. The first two reload it
// to reopen every window from its kept layout; the third in a row, and every one after it until
// the count clears, reloads it as a safe start, which opens without the kept layout, so a layout
// or a session that crashes the renderer when drawn cannot loop. The count clears once a reloaded
// renderer has run five minutes with no crash, on one timer the next crash clears.

/** How the renderer is reloaded after a crash. */
export type RendererReload = "restore" | "safe-start";

/** Crashes in a row that reload from the kept layout; the next one in a row is a safe start. */
const RESTORING_CRASHES = 2;

/** How long a reloaded renderer runs with no crash before the count clears, in milliseconds. */
export const CRASH_COUNT_CLEARS_AFTER_MS: number = 5 * 60 * 1000;

/** The renderer crashes counted in a row, and the timer that clears them. */
export class RendererCrashes {
  #inARow = 0;
  #clearing: ReturnType<typeof setTimeout> | undefined;

  /** Counts one crash and answers how the renderer is reloaded after it. */
  public count(): RendererReload {
    clearTimeout(this.#clearing);
    this.#clearing = undefined;
    this.#inARow += 1;
    return this.#inARow > RESTORING_CRASHES ? "safe-start" : "restore";
  }

  /** Starts the run after which a reloaded renderer that has not crashed clears the count. */
  public reloaded(): void {
    this.#clearing = setTimeout(() => {
      this.#inARow = 0;
      this.#clearing = undefined;
    }, CRASH_COUNT_CLEARS_AFTER_MS);
  }
}
