// The deferred edge into the emulator: one fetch per loader, and the real module
// at the end of it.
//
// The BUNDLING half of this module's claim — that `@xterm/xterm` lands in a lazy
// chunk rather than in the initial document — is not assertable from here; it is
// the renderer initial-bundle budget's subject, measured against Vite's own chunk
// manifest in `test/console/budget/bundle-budget.test.ts`. What is assertable here
// is the contract that makes that split safe to depend on: the module a caller
// gets is the real adapter, and two callers share one fetch.

import { describe, expect, it } from "vitest";

import { TerminalEmulatorLoader, terminalEmulatorLoader } from "./emulator-loader.js";
import { XtermTerminalAdapter } from "./xterm-adapter.js";

describe("the emulator loader", () => {
  it("resolves the real adapter class, not a stand-in for it", async () => {
    const { XtermTerminalAdapter: loaded } = await new TerminalEmulatorLoader().load();
    // Identity, not shape: a wrapper that merely looked like the class would let a
    // surface build an emulator this tree does not own.
    expect(loaded).toBe(XtermTerminalAdapter);
  });

  it("reports whether the chunk has been asked for", async () => {
    const loader = new TerminalEmulatorLoader();
    expect(loader.isLoadStarted).toBe(false);
    await loader.load();
    expect(loader.isLoadStarted).toBe(true);
  });

  it("memoises: two surfaces mounting together share one fetch", () => {
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
