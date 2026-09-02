// The one edge into the graph renderer's code, and the only one that is asynchronous.
//
// WHY THIS MODULE EXISTS. `Spec-023 §Console Design (Meridian)` bounds the renderer's
// initial bundle "excluding lazy chunks (terminal, node graph, math, diagrams,
// browser tools)" — the node graph is named a LAZY chunk by the budget it is measured
// against. `PhaseGraphCanvas.tsx` pulls in `@xyflow/react`, its `@xyflow/system`
// runtime sibling, the library's own `base.css` and this family's sheet; reached by a
// static import from a pane the console can open at boot, every one of those bytes
// lands in the document the operator waits for whether or not a run is ever drawn.
//
// So the canvas is reached through `import()` and through nothing else. That makes
// this module the bundler's split point: everything only `PhaseGraphCanvas.js`
// reaches is emitted as its own chunk and fetched the first time a graph mounts.
//
// WHY A CLASS AND NOT A MODULE-LEVEL PROMISE. The promise has to be memoised: two
// run panes mounting in one frame must not start two fetches, and a remount must not
// re-enter the module. A module-level `let` holding that promise is the state
// `apps/desktop/AGENTS.md` rejects, and it would also be untestable — there would be
// no second instance to compare a first against. The memo is a private field, so a
// test builds its own loader and the page's default is one `const` beside it.

/**
 * What a caller gets: the canvas component, and deliberately nothing else.
 *
 * Narrowed from the module's own shape rather than restated, so a rename in
 * `PhaseGraphCanvas.tsx` fails here instead of drifting. `typeof import(...)` in a
 * TYPE position is erased by the compiler — it opens no runtime edge into the chunk
 * this module exists to keep out of the initial graph.
 */
export type PhaseGraphModule = Pick<typeof import("./PhaseGraphCanvas.js"), "PhaseGraphCanvas">;

/** The graph chunk's loader: one fetch per page, however many graphs ask. */
export class PhaseGraphLoader {
  #modulePromise: Promise<PhaseGraphModule> | undefined;

  /** Whether the chunk has been asked for yet. The memo, observable. */
  public get isLoadStarted(): boolean {
    return this.#modulePromise !== undefined;
  }

  /**
   * The graph chunk, fetched once. Every later call gets the same promise, so two
   * graphs mounting together share one fetch rather than racing two.
   */
  public load(): Promise<PhaseGraphModule> {
    this.#modulePromise ??= this.#fetchModule();
    return this.#modulePromise;
  }

  async #fetchModule(): Promise<PhaseGraphModule> {
    try {
      const { PhaseGraphCanvas } = await import("./PhaseGraphCanvas.js");
      return { PhaseGraphCanvas };
    } catch (loadError) {
      // A chunk that did not arrive is not a chunk that cannot: the fetch fails
      // transiently. Memoising the rejection would leave every later mount for the
      // life of the window holding a failure that a second request would not have
      // reproduced, so the memo is dropped and the caller that asked still sees this
      // attempt's error.
      this.#modulePromise = undefined;
      throw loadError;
    }
  }
}

/** The page's loader. A test builds its own; nothing else does. */
export const phaseGraphLoader: PhaseGraphLoader = new PhaseGraphLoader();
