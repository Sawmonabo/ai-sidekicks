// The one edge into the emulator's code, and the only asynchronous one.
//
// `xterm/adapter.ts` pulls in `@xterm/xterm`, its addons and its stylesheet, so it is reached
// through `import()` only: a static import from anything mounted at boot would put all of
// those bytes in the initial document.

import { MemoizedLoad } from "#renderer/lib/memoized-load.js";

/**
 * The adapter class and nothing else, narrowed from `xterm/adapter.ts` so a rename there fails
 * here. A type-position `typeof import(...)` is erased, so it opens no runtime edge into the
 * lazy chunk.
 */
export type TerminalEmulatorModule = Pick<
  typeof import("./xterm/adapter.js"),
  "XtermTerminalAdapter"
>;

/**
 * The emulator chunk's loader: one fetch per page, however many terminal panes ask, so panes
 * mounting together share one fetch.
 */
export const terminalEmulatorLoader: MemoizedLoad<TerminalEmulatorModule> = new MemoizedLoad(
  async () => {
    const { XtermTerminalAdapter } = await import("./xterm/adapter.js");
    return { XtermTerminalAdapter };
  },
);
