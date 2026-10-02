// The one edge into the emulator's code, and the only asynchronous one.
//
// `xterm-adapter.ts` pulls in `@xterm/xterm`, its addons and its stylesheet, so it is reached
// through `import()` only: a static import from anything mounted at boot would put all of
// those bytes in the initial document. The memoized promise is a private field of a class,
// not module state, so a test can build its own loader.

/**
 * The adapter class and nothing else, narrowed from `xterm-adapter.ts` so a rename there fails
 * here. A type-position `typeof import(...)` is erased, so it opens no runtime edge into the
 * lazy chunk.
 */
export type TerminalEmulatorModule = Pick<
  typeof import("./xterm-adapter.js"),
  "XtermTerminalAdapter"
>;

/**
 * The emulator chunk's loader: one fetch per page, however many terminal panes ask.
 */
export class TerminalEmulatorLoader {
  #modulePromise: Promise<TerminalEmulatorModule> | undefined;

  /**
   * The emulator chunk, fetched once; every later call gets the same promise, so panes
   * mounting together share one fetch.
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
      // A chunk fetch can fail transiently. Memoizing the rejection would hand every later
      // mount the same failure, so the memo is dropped and this caller still sees the error.
      this.#modulePromise = undefined;
      throw loadError;
    }
  }
}

/** The page's loader. A test builds its own; nothing else does. */
export const terminalEmulatorLoader: TerminalEmulatorLoader = new TerminalEmulatorLoader();
