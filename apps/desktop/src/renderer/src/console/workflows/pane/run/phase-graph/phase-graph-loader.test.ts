// The deferred edge into the graph renderer: one fetch per loader, and the real
// component at the end of it.
//
// The BUNDLING half of this module's claim — that `@xyflow/react` lands in a lazy
// chunk rather than in the initial document — is not assertable from here; it is the
// renderer initial-bundle budget's subject, measured against Vite's own chunk
// manifest by the bundle tier. What is assertable here is the contract that makes
// that split safe to depend on: the module a caller gets is the real canvas, and two
// callers share one fetch.

import { describe, expect, it } from "vitest";

import { PhaseGraphCanvas } from "./PhaseGraphCanvas.js";
import { PhaseGraphLoader, phaseGraphLoader } from "./phase-graph-loader.js";

describe("the graph loader", () => {
  it("resolves the real canvas component, not a stand-in for it", async () => {
    const { PhaseGraphCanvas: loaded } = await new PhaseGraphLoader().load();
    // Identity, not shape: a wrapper that merely looked like the component would let
    // a surface draw a graph this directory does not own. The import above names the
    // DECLARING module while the loader goes through the chunk's door, so this also
    // holds the door to re-exporting the declaration rather than wrapping it.
    expect(loaded).toBe(PhaseGraphCanvas);
  });

  it("reports whether the chunk has been asked for", async () => {
    const loader = new PhaseGraphLoader();
    expect(loader.isLoadStarted).toBe(false);
    await loader.load();
    expect(loader.isLoadStarted).toBe(true);
  });

  it("memoises: two graphs mounting together share one fetch", () => {
    const loader = new PhaseGraphLoader();
    // Promise identity is the observable. Two distinct promises would mean two
    // entries into the module, which is the race the memo exists to prevent.
    expect(loader.load()).toBe(loader.load());
  });

  it("negative control: two loaders do not share one memo", () => {
    // Without this the case above would pass against a module-level promise, which
    // is exactly the shared state the class form exists to avoid.
    expect(new PhaseGraphLoader().load()).not.toBe(new PhaseGraphLoader().load());
  });

  it("the page's loader is one instance, and it is a loader", () => {
    expect(phaseGraphLoader).toBeInstanceOf(PhaseGraphLoader);
  });
});
