// What address the shared mount opens a window at — the one thing about it a suite
// never states and every suite depends on.
//
// THE MOUNT IS SCAFFOLDING WITH A COMPOSITION OF ITS OWN, which is why it is worth a
// case. A window born at no address is an install's FIRST LAUNCH, and a fixture build
// opens one into the demonstration session rather than the sessions list — a
// different surface, a different deck, and a mount that settles in hundreds of
// milliseconds instead of tens because that deck fetches its pane chunks while the
// mount is still running. Every suite that drives the composed window and says
// nothing about an address was silently getting that composition, and the window's
// own idle warm walk reached the surface board inside such a mount, which is how the
// destination-warm case lost the cold board its control reads.
//
// SO THE HELPER STATES THE ADDRESS AND THIS FILE HOLDS IT TO ALL THREE READINGS: the
// default it supplies, the address a case sets for itself and must keep, and the
// empty address a case can still name when the first launch is what it means. The
// third is the negative control for the first — without it, a helper that had simply
// deleted the first-launch opening from the tier would pass the other two.

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LEDGER_FIRST_SIXTY_SCENARIO } from "../../bridge/scenarios/ledger/ledger-first-sixty.js";
import { formatRoute } from "../../routing/index.js";
import { SESSIONS_HASH, mountConsole } from "./ConsoleRoot.test-support.js";

/** No address at all — what a window carries before any suite has said otherwise. */
const NO_HASH = "";

/** An address that is neither the default nor the demo's, so keeping it is visible. */
const WORKFLOWS_HASH = "#/workflows";

/**
 * Where the first-launch opening lands.
 *
 * Composed from the scenario's own session rather than written out, so the case
 * cannot go on asserting a route the demonstration no longer opens.
 */
const DEMONSTRATION_HASH = formatRoute({
  kind: "workspace",
  sessionId: LEDGER_FIRST_SIXTY_SCENARIO.sessionId,
});

describe("the composed window's opening address", () => {
  beforeEach(() => {
    window.location.hash = NO_HASH;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = NO_HASH;
  });

  it("gives a mount that names no address the sessions list, not the first launch", async () => {
    await mountConsole();

    expect(window.location.hash).toBe(SESSIONS_HASH);
  });

  it("leaves an address the case set for itself exactly as the case set it", async () => {
    window.location.hash = WORKFLOWS_HASH;

    await mountConsole();

    expect(window.location.hash).toBe(WORKFLOWS_HASH);
  });

  it("negative control: named outright, the empty address still opens the first launch", async () => {
    await mountConsole({ openedAtHash: NO_HASH });

    expect(window.location.hash).toBe(DEMONSTRATION_HASH);
  });
});
