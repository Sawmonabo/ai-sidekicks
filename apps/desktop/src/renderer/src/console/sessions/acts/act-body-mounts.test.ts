// The deferred edge into each of the acts bar's two disclosed bodies: one fetch per
// loader, the real components at the end of them, and two chunks rather than one.
//
// The BUNDLING half of this seam's claim — that each body lands in a lazy chunk rather
// than in the initial document — is not assertable from here; it is the initial-graph
// census's subject, read out of the build by the bundle tier. What is assertable here is
// the contract that makes the split safe to depend on: what a press gets is the
// component itself rather than a stand-in, and each act reaches its own body.

import { describe, expect, it } from "vitest";

import { joinSessionFormMount, providerImportPanelMount } from "./act-body-mounts.js";
import { JoinSessionForm } from "./JoinSessionForm.js";
import { ProviderImportPanel } from "./ProviderImportPanel.js";

describe("the acts bar's deferred bodies", () => {
  it("resolves the real join form, not a stand-in for it", async () => {
    // Identity, not shape: a wrapper that merely looked like the form would let the bar
    // draw a join this directory does not own. The import above names the DECLARING
    // module while the loader goes through the chunk root, so this also holds that root
    // to re-exporting the declaration rather than wrapping it.
    expect((await joinSessionFormMount.load()).Body).toBe(JoinSessionForm);
    expect(joinSessionFormMount.isResolved).toBe(true);
  });

  it("resolves the real import panel, not a stand-in for it", async () => {
    expect((await providerImportPanelMount.load()).Body).toBe(ProviderImportPanel);
    expect(providerImportPanelMount.isResolved).toBe(true);
  });

  it("negative control: each mount answers with its OWN act's body", async () => {
    // What makes the two cases above claims about WHICH component rather than about
    // resolving one at all. The mistake this two-root shape is exposed to is a
    // copy-pasted specifier, and the failure it produces is a press that draws the other
    // act — with the other act's chunk fetched to draw it.
    const join = await joinSessionFormMount.load();
    const providerImport = await providerImportPanelMount.load();

    expect(join.Body).not.toBe(providerImport.Body);
    expect(join.Body).not.toBe(ProviderImportPanel);
    expect(providerImport.Body).not.toBe(JoinSessionForm);
  });
});
