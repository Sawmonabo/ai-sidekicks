// The one edge into the graph renderer's code, and the only one that is asynchronous.
//
// WHY THIS MODULE EXISTS. The console bounds the renderer's initial bundle excluding
// lazy chunks — terminal, node graph, math, diagrams, browser tools — so the node
// graph is a LAZY chunk by the budget it is measured against. The chunk's door pulls
// in `@xyflow/react`, its `@xyflow/system` runtime sibling, the library's own
// `base.css` and this directory's sheet; reached by a static import from a pane the
// console can open at boot, every one of those bytes lands in the document the
// operator waits for whether or not a run is ever drawn.
//
// So the door is reached through `import()` and through nothing else. That makes this
// module the bundler's split point: everything only `run-graph/index.js` reaches is
// emitted as its own chunk, with the two sheets `RunGraphCanvas.tsx` imports, and fetched
// the first time a graph mounts.
//
// WHY A CLASS AND NOT A MODULE-LEVEL PROMISE. The promise has to be memoized: two
// run panes mounting in one frame must not start two fetches, and a remount must not
// re-enter the module. A module-level `let` holding that promise is the state
// `apps/desktop/AGENTS.md` rejects, and it would also be untestable — there would be
// no second instance to compare a first against. The memo is a private field, so a
// test builds its own loader and the page's default is one `const` beside it.

/**
 * What a caller gets: the canvas component, and deliberately nothing else.
 *
 * Narrowed from the door's own shape rather than restated, so a rename behind
 * `index.ts` fails here instead of drifting. `typeof import(...)` in a TYPE position
 * is erased by the compiler — it opens no runtime edge into the chunk this module
 * exists to keep out of the initial graph.
 */
export type RunGraphModule = Pick<typeof import("./index.js"), "RunGraphCanvas">;

/** The graph chunk's loader: one fetch per page, however many graphs ask. */
export class RunGraphLoader {
  #modulePromise: Promise<RunGraphModule> | undefined;

  /** Whether the chunk has been asked for yet. The memo, observable. */
  public get isLoadStarted(): boolean {
    return this.#modulePromise !== undefined;
  }

  /**
   * The graph chunk, fetched once. Every later call gets the same promise, so two
   * graphs mounting together share one fetch rather than racing two.
   */
  public load(): Promise<RunGraphModule> {
    this.#modulePromise ??= this.#fetchModule();
    return this.#modulePromise;
  }

  async #fetchModule(): Promise<RunGraphModule> {
    try {
      const { RunGraphCanvas } = await import("./index.js");
      return { RunGraphCanvas };
    } catch (loadError) {
      // A chunk that did not arrive is not a chunk that cannot: the fetch fails
      // transiently. Memoizing the rejection would leave every later mount for the
      // life of the window holding a failure that a second request would not have
      // reproduced, so the memo is dropped and the caller that asked still sees this
      // attempt's error.
      this.#modulePromise = undefined;
      throw loadError;
    }
  }
}

/** The page's loader. A test builds its own; nothing else does. */
export const runGraphLoader: RunGraphLoader = new RunGraphLoader();
