// The one edge into the emulator's code, and the only one that is asynchronous.
//
// WHY THIS MODULE EXISTS. `Spec-023 §Console Design (Meridian)` §Budgets bounds the
// renderer's initial bundle "excluding lazy chunks (terminal, node graph, math,
// diagrams, browser tools)" — so the terminal is named a LAZY chunk by the budget
// it is measured against. `xterm-adapter.ts` pulls in `@xterm/xterm`, five addons,
// and the library's own stylesheet; reached by a static import from a component the
// console mounts at boot, every one of those bytes lands in the document the
// operator waits for, whether or not a terminal is ever opened.
//
// So the adapter is reached through `import()` and through nothing else. That makes
// the module the bundler's split point: everything only `xterm-adapter.js` reaches
// — the library, the addons, the sheet, the renderer pool — is emitted as its own
// chunk and fetched the first time a terminal host mounts.
//
// WHY A CLASS AND NOT A MODULE-LEVEL PROMISE. The promise has to be memoised: two
// terminal surfaces mounting in one frame must not start two fetches, and a
// remount must not re-enter the module. A module-level `let` holding that promise
// is the state `apps/desktop/AGENTS.md` rejects, and it would also be untestable —
// there would be no second instance to compare a first against. The memo is a
// private field, so a test builds its own loader and the page's default is one
// `const` beside it, exactly as `renderer-pool.ts` holds the page's WebGL budget.

/**
 * What a caller gets: the adapter class, and deliberately nothing else.
 *
 * Narrowed from the module's own shape rather than restated, so a rename in
 * `xterm-adapter.ts` fails here instead of drifting. `typeof import(...)` in a TYPE
 * position is erased by the compiler — it opens no runtime edge into the chunk this
 * module exists to keep out of the initial graph.
 */
export type TerminalEmulatorModule = Pick<
  typeof import("./xterm-adapter.js"),
  "XtermTerminalAdapter"
>;

/**
 * The emulator chunk's loader: one fetch per page, however many surfaces ask.
 */
export class TerminalEmulatorLoader {
  #modulePromise: Promise<TerminalEmulatorModule> | undefined;

  /** Whether the chunk has been asked for yet. The memo, observable. */
  public get isLoadStarted(): boolean {
    return this.#modulePromise !== undefined;
  }

  /**
   * The emulator chunk, fetched once. Every later call gets the same promise, so
   * two surfaces mounting together share one fetch rather than racing two.
   */
  public load(): Promise<TerminalEmulatorModule> {
    this.#modulePromise ??= this.#fetchModule();
    return this.#modulePromise;
  }

  async #fetchModule(): Promise<TerminalEmulatorModule> {
    try {
      const { XtermTerminalAdapter } = await import("./xterm-adapter.js");
      return { XtermTerminalAdapter };
    } catch (loadError) {
      // A chunk that did not arrive is not a chunk that cannot: the fetch fails
      // transiently. Memoising the rejection would leave every later mount for the
      // life of the window holding a failure that a second request would not have
      // reproduced, so the memo is dropped and the caller that asked still sees
      // this attempt's error.
      this.#modulePromise = undefined;
      throw loadError;
    }
  }
}

/** The page's loader. A test builds its own; nothing else does. */
export const terminalEmulatorLoader: TerminalEmulatorLoader = new TerminalEmulatorLoader();
