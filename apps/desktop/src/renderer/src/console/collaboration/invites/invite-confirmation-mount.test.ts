// The deferred edge into the invite confirmation: one loader, and the real card at the
// end of it.
//
// The BUNDLING half of this seam's claim — that the card and everything only it reaches
// land in a lazy chunk rather than in the initial document — is not assertable from here,
// and no gate asserts it: the `renderer-initial-bundle` byte budget bounds the graph's
// SIZE and names no module.
// What is assertable here is the contract that makes the split safe to depend on: what
// the overlay gets is the card itself rather than a stand-in, and the ask is observable,
// which is what the warmed open rests on.

import { describe, expect, it } from "vitest";

import { LoadedLazyBody } from "../../seats/index.js";
import { inviteConfirmationMount } from "./invite-confirmation-mount.js";
import { InviteConfirmation, type InviteConfirmationProps } from "./InviteConfirmation.js";

describe("the invite confirmation's loader", () => {
  it("resolves the real card, not a stand-in for it", async () => {
    // Identity, not shape: a wrapper that merely looked like this would answer a deep
    // link with a card this directory does not own. The import above names the DECLARING
    // module while the loader goes through the chunk root, so this also holds that root
    // to re-exporting the declaration rather than wrapping it.
    expect((await inviteConfirmationMount.load()).Body).toBe(InviteConfirmation);
  });

  it("negative control: the identity check discriminates", async () => {
    // Without this the case above would pass against any `toBe` that could not fail —
    // and what it is guarding is a chunk root that re-exported the wrong symbol, which
    // is a component of exactly the same shape.
    const standIn = (): null => null;
    const impostor = new LoadedLazyBody<InviteConfirmationProps>(
      () => Promise.resolve({ Body: standIn }),
      () => null,
    );
    expect((await impostor.load()).Body).not.toBe(InviteConfirmation);
  });

  it("reports whether the chunk has been asked for, which is what the warm turns on", async () => {
    // A fresh loader over the same chunk root rather than the page's own, which every
    // case above has already warmed: what this case is about is the transition, and one
    // read of an instance somebody else resolved would pass whether or not `load` did
    // anything.
    const loader = new LoadedLazyBody<InviteConfirmationProps>(
      () => import("./invite-confirmation-body.js"),
      () => null,
    );
    expect(loader.isResolved).toBe(false);
    await loader.load();
    expect(loader.isResolved).toBe(true);
  });

  it("the overlay's loader is the console's one loader-backed body, not a second answer", () => {
    // The class is what supplies the settled body at RENDER time, so a mount begun after
    // the warm never suspends. A hand-rolled `lazy()` here would suspend for a microtask
    // on every open, which is the reserved region appearing on exactly the path that paid
    // to avoid it.
    expect(inviteConfirmationMount).toBeInstanceOf(LoadedLazyBody);
  });
});
