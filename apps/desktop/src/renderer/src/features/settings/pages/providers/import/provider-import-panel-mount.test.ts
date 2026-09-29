// The deferred edge into the import panel: one fetch per loader and the real component at
// the end of it.
//
// The BUNDLING half of this seam's claim — that the body lands in a lazy chunk rather
// than in the initial document — is not assertable from here, and no gate asserts it:
// the `renderer-initial-bundle` byte budget bounds the graph's SIZE and names no
// module. What is assertable here is the contract that makes the split safe to depend
// on: what a caller gets is the component itself rather than a stand-in.

import { describe, expect, it } from "vitest";

import { providerImportPanelMount } from "./provider-import-panel-mount.js";
import { ProviderImportPanel } from "./ProviderImportPanel.js";

describe("the import panel's deferred body", () => {
  it("resolves the real import panel, not a stand-in for it", async () => {
    // Identity, not shape: a wrapper that merely looked like the panel would let the
    // caller draw an import this directory does not own. The import above names the
    // DECLARING module while the loader goes through the chunk root, so this also holds
    // that root to re-exporting the declaration rather than wrapping it.
    expect((await providerImportPanelMount.load()).Body).toBe(ProviderImportPanel);
    expect(providerImportPanelMount.isResolved).toBe(true);
  });
});
