// The deferred edge into the graph renderer: one fetch per loader, and the real component at
// the end of it. That `@xyflow/react` lands in a lazy chunk is the bundle tier's subject and
// is not assertable here.

import { describe, expect, it } from "vitest";

import { RunGraphCanvas } from "./RunGraphCanvas.js";
import { RunGraphLoader, runGraphLoader } from "./run-graph-loader.js";

describe("the graph loader", () => {
  it("resolves the real canvas component, not a stand-in for it", async () => {
    const { RunGraphCanvas: loaded } = await new RunGraphLoader().load();
    // Identity, not shape: a look-alike wrapper would let a caller draw a graph this directory
    // does not own.
    expect(loaded).toBe(RunGraphCanvas);
  });

  it("reports whether the chunk has been asked for", async () => {
    const loader = new RunGraphLoader();
    expect(loader.isLoadStarted).toBe(false);
    await loader.load();
    expect(loader.isLoadStarted).toBe(true);
  });

  it("memoizes: two graphs mounting together share one fetch", () => {
    const loader = new RunGraphLoader();
    // Promise identity is the observable: two promises would mean two entries into the module.
    expect(loader.load()).toBe(loader.load());
  });

  it("negative control: two loaders do not share one memo", () => {
    // Without this the case above would pass against a module-level promise.
    expect(new RunGraphLoader().load()).not.toBe(new RunGraphLoader().load());
  });

  it("the page's loader is one instance, and it is a loader", () => {
    expect(runGraphLoader).toBeInstanceOf(RunGraphLoader);
  });
});
