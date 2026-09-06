// The shared browser mount waits for a body whose load has already been STARTED.
//
// THE DEFECT THIS PINS. `renderSettled` walked `unloadedKeys()`, which reports the keys
// nothing has ASKED for yet — and every path that warms a body is an ask: the idle warm
// after first paint, the palette highlighting an entry, an address about to open, and a
// preceding case on the same process-wide board. Once any of them has started a load, the
// key leaves that list while the module is still in flight, so the walk awaited nothing
// and the mount returned onto the reserved region. Whether a tier then saw the body came
// down to how many turns a dynamic import happened to take — axe audits the reserved
// region and a capture photographs it, and both are stable, green, and pictures of the
// wrong thing. `ConsoleRoot.test-support.tsx` records the identical finding on the
// surface board; this is the mount every browser tier shares.
//
// IT BELONGS TO THE BROWSER TIER BECAUSE THE HARNESS DOES. `console-harness.tsx` imports
// `vitest/browser` for the CDP and user-event seams the three browser tiers share, so it
// cannot be driven from a happy-dom project at all — and the subject here is that file's
// own settle rather than any surface it mounts.
//
// THE PROCESS-WIDE BOARD, WITH ONE SYNTHETIC REGISTRATION ON IT. This file imports no
// family door, so the boards hold exactly what the case registers and the walk under test
// is exercised without standing up an emulator or a hosted view to do it.

import { afterEach, describe, expect, it } from "vitest";

import { renderSettled } from "../console-harness.js";

import { crossMacrotaskBoundary } from "../../../src/renderer/src/console/core/macrotask-boundary.test-support.js";
import { consolePaneRegistry } from "../../../src/renderer/src/console/seats/index.js";
import {
  deferredBodyModule,
  syntheticPaneContextAt,
} from "../../../src/renderer/src/console/seats/lazy-body.test-support.js";
import { pendingPaneKindsIn } from "../../../src/renderer/src/console/seats/pending-pane-body.js";
import { type ConsolePaneContext } from "../../../src/renderer/src/console/seats/pane-context.js";
import { type PaneKind } from "../../../src/renderer/src/console/seats/pane-kinds.js";

/** The kind this case borrows. Nothing else in this file's graph registers one. */
const SYNTHETIC_KIND = "diff";

/** Named so a duplicate claim would fail by naming this file rather than a family. */
const SYNTHETIC_OWNER = "console-harness-settle-case";

/** What the loaded body prints, so the assertion is about content and not about a class. */
const LOADED_BODY_TEXT = "the body the loader carried";

/**
 * How many platform turns the mount is given before its still-waiting is called a fact.
 *
 * Generous rather than tuned, and in the direction that cannot make this case pass
 * wrongly: every extra turn is another chance for a mount that does NOT wait to return
 * and fail the assertion, while a mount that waits for its registration's promise stays
 * pending however many are spent.
 */
const MOUNT_SETTLE_TURNS = 6;

afterEach(() => {
  // The board is process-wide, so the registration has to be given back — a second case
  // in this tier would otherwise inherit a settled loader and prove nothing.
  consolePaneRegistry.unregister(SYNTHETIC_KIND);
  document.body.replaceChildren();
});

describe("the shared browser mount", () => {
  it("settles a body whose load a warm had already started", async () => {
    const deferred = deferredBodyModule<ConsolePaneContext>();
    consolePaneRegistry.register({
      kind: SYNTHETIC_KIND,
      owner: SYNTHETIC_OWNER,
      body: deferred.load,
    });

    // THE WARM, WHICH IS WHAT EVERY REAL PATH DOES BEFORE A MOUNT. One `preload` — the
    // same call the idle walk, the palette's highlighted entry and an opening address all
    // make — starts the load and leaves the promise in flight.
    void consolePaneRegistry.preload(SYNTHETIC_KIND);

    // THE OLD WALK'S OWN PREDICATE, PLANTED RATHER THAN DESCRIBED: with the module still
    // in flight the board already counts this kind as asked-for, so a walk over
    // `unloadedKeys()` has nothing to await and returns at once.
    const unloadedKeysWhileInFlight: readonly PaneKind[] = consolePaneRegistry.unloadedKeys();
    expect(unloadedKeysWhileInFlight).not.toContain(SYNTHETIC_KIND);

    const body = consolePaneRegistry
      .descriptorFor(SYNTHETIC_KIND)
      ?.render(syntheticPaneContextAt(SYNTHETIC_KIND));
    let mountReturned = false;
    const mounting = renderSettled(<>{body}</>).then((mount) => {
      mountReturned = true;
      return mount;
    });

    // THE CLAIM, ASSERTED AS A CLAIM ABOUT THE WAIT rather than about a render. Give the
    // mount every turn it could want with the module still in flight: a mount that walks
    // its registered keys is still inside its own `act` scope here, and one that walked
    // only the never-started ones has long since returned onto the reserved region. The
    // boundaries are how the losing implementation is given its chance, not how this case
    // waits — the wait is the `await` on the mount itself, below.
    for (let turn = 0; turn < MOUNT_SETTLE_TURNS; turn += 1) {
      await crossMacrotaskBoundary();
    }
    expect(mountReturned).toBe(false);

    deferred.arrive(() => LOADED_BODY_TEXT);
    const { container } = await mounting;
    expect(container.textContent).toContain(LOADED_BODY_TEXT);
    expect(pendingPaneKindsIn(container)).toStrictEqual([]);
  });
});
