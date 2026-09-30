// The one edge into the graph renderer's code, and the only asynchronous one. The chunk entry,
// `RunGraphCanvas.tsx`, pulls in `@xyflow/react` and both sheets, which the initial-bundle
// budget excludes, so it is reached through `import()` alone. The memo is a private field so
// two panes mounting in one frame share one fetch and a test can build its own loader.

/**
 * What a caller gets: the canvas component, and nothing else.
 *
 * Narrowed from the entry module's own shape so a rename there fails here. `typeof import()` in
 * a type position is erased, so it opens no runtime edge into the chunk.
 */
export type RunGraphModule = Pick<typeof import("./RunGraphCanvas.js"), "RunGraphCanvas">;

/** The graph chunk's loader: one fetch per page, however many graphs ask. */
export class RunGraphLoader {
  #modulePromise: Promise<RunGraphModule> | undefined;

  /** Whether the chunk has been asked for yet. The memo, observable. */
  public get isLoadStarted(): boolean {
    return this.#modulePromise !== undefined;
  }

  /**
   * The graph chunk, fetched once. Every later call gets the same promise, so two graphs
   * mounting together share one fetch.
   */
  public load(): Promise<RunGraphModule> {
    this.#modulePromise ??= this.#fetchModule();
    return this.#modulePromise;
  }

  async #fetchModule(): Promise<RunGraphModule> {
    try {
      const { RunGraphCanvas } = await import("./RunGraphCanvas.js");
      return { RunGraphCanvas };
    } catch (loadError) {
      // A failed fetch is often transient. Memoizing the rejection would hand every later
      // mount a failure a second request would not reproduce, so the memo is dropped and the
      // caller that asked still sees this attempt's error.
      this.#modulePromise = undefined;
      throw loadError;
    }
  }
}

/** The page's loader. A test builds its own; nothing else does. */
export const runGraphLoader: RunGraphLoader = new RunGraphLoader();
