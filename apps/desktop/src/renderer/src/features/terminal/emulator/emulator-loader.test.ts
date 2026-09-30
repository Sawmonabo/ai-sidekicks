// The deferred edge into the emulator: one fetch per loader, and the real module at the end
// of it. That `@xterm/xterm` lands in a lazy chunk is the initial-bundle budget's subject
// (`tests/budget/bundle-budget.test.ts`) and is not assertable here.

import { describe, expect, it } from "vitest";

import { TerminalEmulatorLoader, terminalEmulatorLoader } from "./emulator-loader.js";
import { XtermTerminalAdapter } from "./xterm-adapter.js";

describe("the emulator loader", () => {
  it("resolves the real adapter class, not a stand-in for it", async () => {
    const { XtermTerminalAdapter: loaded } = await new TerminalEmulatorLoader().load();
    // Identity, not shape: a wrapper that merely looked like the class would let a
    // component build an emulator this tree does not own.
    expect(loaded).toBe(XtermTerminalAdapter);
  });

  it("reports whether the chunk has been asked for", async () => {
    const loader = new TerminalEmulatorLoader();
    expect(loader.isLoadStarted).toBe(false);
    await loader.load();
    expect(loader.isLoadStarted).toBe(true);
  });

  it("memoizes: two terminal panes mounting together share one fetch", () => {
    const loader = new TerminalEmulatorLoader();
    // Promise identity is the observable. Two distinct promises would mean two
    // entries into the module, which is the race the memo exists to prevent.
    expect(loader.load()).toBe(loader.load());
  });

  it("negative control: two loaders do not share one memo", () => {
    // Without this the case above would pass against a module-level promise, which
    // is exactly the shared state the class form exists to avoid.
    expect(new TerminalEmulatorLoader().load()).not.toBe(new TerminalEmulatorLoader().load());
  });

  it("the page's loader is one instance, and it is a loader", () => {
    expect(terminalEmulatorLoader).toBeInstanceOf(TerminalEmulatorLoader);
  });
});
