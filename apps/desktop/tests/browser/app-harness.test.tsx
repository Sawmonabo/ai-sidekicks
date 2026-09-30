// The shared browser mount waits for a body whose load has already started.
//
// `unloadedKeys()` reports only the keys nothing has asked for yet, and every path that warms
// a body is an ask (the idle warm, the palette highlighting an entry, an address about to
// open, an earlier case on the same process-wide board). A mount that walked it would await
// nothing for a load still in flight and return onto the reserved region, which axe would
// audit and a capture would photograph. `renderSettled` therefore walks every registered key.
// `mount-app.tsx` follows the same rule for the composed window.
//
// This file belongs to the browser tier because `app-harness.ts` imports `vitest/browser`, so
// it cannot run in a happy-dom project. It imports no feature registration, so the registries
// hold only the one synthetic registration the case makes.

import { afterEach, describe, expect, it } from "vitest";

import { renderSettled } from "../helpers/app-harness.js";

import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";
import { paneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { deferredBodyModule, syntheticPaneContextAt } from "../helpers/lazy-body-contexts.js";
import { listPendingBodyNames } from "@renderer/components/LazyBody/pending-body-marker.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { type PaneKind } from "@renderer/routing/panes/pane-kinds.js";

/** The kind this case borrows. Nothing else in this file's graph registers one. */
const SYNTHETIC_KIND = "diff";

/** Named so a duplicate claim would fail by naming this file rather than a feature. */
const SYNTHETIC_OWNER = "app-harness-settle-case";

/** What the loaded body prints, so the assertion is about content and not about a class. */
const LOADED_BODY_TEXT = "the body the loader carried";

/**
 * How many platform turns the mount is given before its still waiting is called a fact.
 * Generous in the safe direction: each extra turn is another chance for a mount that does not
 * wait to return and fail, while one that waits stays pending however many are spent.
 */
const MOUNT_SETTLE_TURNS = 6;

afterEach(() => {
  // The board is process-wide; a second case would otherwise inherit a settled loader.
  paneRegistry.unregister(SYNTHETIC_KIND);
  document.body.replaceChildren();
});

describe("the shared browser mount", () => {
  it("settles a body whose load a warm had already started", async () => {
    const deferred = deferredBodyModule<PaneContext>();
    paneRegistry.register({
      kind: SYNTHETIC_KIND,
      owner: SYNTHETIC_OWNER,
      body: deferred.load,
    });

    // The warm every real path does before a mount: one `preload`, the call the idle walk, the
    // palette and an opening address all make, starts the load and leaves the promise in flight.
    void paneRegistry.preload(SYNTHETIC_KIND);

    // With the module still in flight the board counts this kind as asked for, so a walk over
    // `unloadedKeys()` would have nothing to await and return at once.
    const unloadedKeysWhileInFlight: readonly PaneKind[] = paneRegistry.unloadedKeys();
    expect(unloadedKeysWhileInFlight).not.toContain(SYNTHETIC_KIND);

    const body = paneRegistry
      .descriptorFor(SYNTHETIC_KIND)
      ?.render(syntheticPaneContextAt(SYNTHETIC_KIND));
    let mountReturned = false;
    const mounting = renderSettled(<>{body}</>).then((mount) => {
      mountReturned = true;
      return mount;
    });

    // Give the mount every turn it could want with the module still in flight: a mount that
    // walks its registered keys is still inside its `act` scope, while one that walked only
    // the never-started keys has already returned onto the reserved region.
    for (let turn = 0; turn < MOUNT_SETTLE_TURNS; turn += 1) {
      await crossMacrotaskBoundary();
    }
    expect(mountReturned).toBe(false);

    deferred.arrive(() => LOADED_BODY_TEXT);
    const { container } = await mounting;
    expect(container.textContent).toContain(LOADED_BODY_TEXT);
    expect(listPendingBodyNames(container)).toStrictEqual([]);
  });
});
