// A family composed after the window installed its chord table still gets its chords.
//
// The frame installs one `KeyBindingTable` on `window` from an effect, and the
// families contribute at composition time. Those two moments are not ordered: a
// family composed later — a lazily-loaded chunk, a second composition into a window
// that is already open — binds its chords into a list the table would never read
// again. The failure is silent in both directions, which is why it needs a case: the
// palette lists the command, the settings page prints the chord, and the key does
// nothing.
//
// Driven through the REAL composition root and a REAL dispatched press rather than
// through the hook: what is claimed is that the window's installed table answers the
// chord, and a table read out of a hook result would be the same list this file
// already has, asserted against itself.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { consoleCommandSurface, type ConsoleCommand } from "../palette/index.js";
import { mountConsole } from "./ConsoleRoot.test-support.js";

/** The family this file composes as, so its rows are withdrawn by owner. */
const CONTRIBUTING_OWNER = "frame-commands-contributions-test";

const CONTRIBUTED_COMMAND_ID = "frameCommandsContributionsTest.act";

/**
 * A chord no console family binds, and one no modifier is needed to press.
 *
 * Modifier-free because `$mod` resolves against the real host at listen time, so a
 * press built here would have to guess which modifier this runner's `tinykeys` is
 * watching for — and guessing wrong is a case that passes for the wrong reason.
 */
const CONTRIBUTED_CHORD = "F9";

function pressContributedChord(): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "F9", key: "F9" }));
}

describe("frame command surface — chords contributed after the table was installed", () => {
  // Owner-scoped replace is the withdrawal: contributing nothing under this owner
  // unregisters the command this file added, so the module-scoped registry is left
  // as it was found.
  afterEach(() => {
    consoleCommandSurface.contribute({
      owner: CONTRIBUTING_OWNER,
      commands: [],
      keyBindings: [],
    });
  });

  it("reaches the installed table, and did not before the contribution", async () => {
    let runCount = 0;
    const contributedCommand: ConsoleCommand = {
      id: CONTRIBUTED_COMMAND_ID,
      title: "The act a late family contributed",
      group: "Test",
      run: () => {
        runCount += 1;
      },
    };
    const mounted = await mountConsole();

    // The press BEFORE the contribution is the negative control, and it is in the
    // same case on purpose: it shows the chord was not already bound by something
    // else, so the press after it is measuring this contribution and not the tree.
    pressContributedChord();
    const runsBeforeContribution = runCount;

    await act(async () => {
      consoleCommandSurface.contribute({
        owner: CONTRIBUTING_OWNER,
        commands: [contributedCommand],
        keyBindings: [{ chord: CONTRIBUTED_CHORD, commandId: CONTRIBUTED_COMMAND_ID }],
      });
      await crossMacrotaskBoundary();
    });
    pressContributedChord();

    expect(runsBeforeContribution).toBe(0);
    expect(runCount).toBe(1);

    act(() => {
      mounted.unmount();
    });
  });

  it("stops answering the chord once the window is gone", async () => {
    // The other half of the same wiring: the effect's cleanup withdraws the
    // listener it added, so a contribution arriving after unmount reaches no table
    // — and a leaked subscription would keep answering presses in a window that no
    // longer exists, which is the shape a stray listener always takes.
    let runCount = 0;
    const mounted = await mountConsole();
    act(() => {
      mounted.unmount();
    });

    consoleCommandSurface.contribute({
      owner: CONTRIBUTING_OWNER,
      commands: [
        {
          id: CONTRIBUTED_COMMAND_ID,
          title: "The act a late family contributed",
          group: "Test",
          run: () => {
            runCount += 1;
          },
        },
      ],
      keyBindings: [{ chord: CONTRIBUTED_CHORD, commandId: CONTRIBUTED_COMMAND_ID }],
    });
    pressContributedChord();

    expect(runCount).toBe(0);
  });
});
