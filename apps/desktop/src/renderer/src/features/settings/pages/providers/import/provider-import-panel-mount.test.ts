// The deferred edge into the import panel resolves the real component.
//
// Whether the body lands in a lazy chunk is not assertable here: the `renderer-initial-bundle`
// budget bounds the graph's size and names no module.

import { describe, expect, it } from "vitest";

import { providerImportPanelMount } from "./provider-import-panel-mount.js";
import { ProviderImportPanel } from "./ProviderImportPanel.js";

describe("the import panel's deferred body", () => {
  it("resolves the real import panel, not a stand-in for it", async () => {
    // Identity, not shape: a wrapper that merely looked like the panel would let the caller
    // draw an import this directory does not own. It also holds the chunk root to
    // re-exporting the declaration rather than wrapping it.
    expect((await providerImportPanelMount.load()).Body).toBe(ProviderImportPanel);
    expect(providerImportPanelMount.isResolved).toBe(true);
  });
});
