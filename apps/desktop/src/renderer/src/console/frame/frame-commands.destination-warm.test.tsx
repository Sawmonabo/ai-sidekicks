// A chord reaches a destination's command directly, so the command has to warm.
//
// WHAT THE PRELOAD CALLBACK IS AND IS NOT. Every navigation command carries a
// `preload` the palette calls while its row is highlighted — speculative warming, fired
// on a person READING rather than acting. A chord calls none of it: `KeyBindingTable`
// resolves the binding and runs the command, and that is the whole path. So a
// destination whose surface is loader-backed navigated with its chunk unrequested, and
// the reserved frame the loader form exists to hide is what a keyboard user saw — the
// one user who reached the destination fastest.
//
// DRIVEN THROUGH THE REAL COMPOSED WINDOW. The command under test is the one the window
// registers from its own effect into the console's command registry, and it is
// DISPATCHED by an installed `KeyBindingTable` rather than called: what is claimed is
// that the keyboard path warms, and calling `run` by hand would assert that over a path
// no key press takes.
//
// THE CHORD IS REBOUND TO A MODIFIER-FREE KEY for `frame-commands.contributions.test.tsx`'s
// measured reason: `$mod` resolves against the real host at listen time, so a synthetic
// press built here would have to guess which modifier this runner watches for, and
// guessing wrong is a case that passes for the wrong reason. Which chord SHIPS is
// `palette/command-surface.test.ts`'s claim and not this file's.
//
// AND THE IDLE WARM CANNOT MASK IT. The window's own walk would eventually load every
// registered body, which would make a "did it load" assertion vacuous — so the reading
// is taken synchronously after the press, before any idle callback or its timer floor
// has had a turn, and the case asserts the board was still cold on the line above.

import { describe, expect, it } from "vitest";

import { KeyBindingTable, consoleCommands } from "../palette/index.js";
import { consoleSurfaceRegistry } from "../seats/index.js";
import { mountConsole } from "./ConsoleRoot.test-support.js";

/** A key no console chord binds, and one that needs no modifier to press. */
const PRESSED_CODE = "F9";

const WORKFLOWS_COMMAND_ID = "frame.goToWorkflows";

/**
 * Dispatch the console's registered command for an id, through a real installed table.
 *
 * The table is built over the module-scope command registry the mounted window
 * registered into, so the command that runs is the window's own — this only supplies
 * the binding, which is the part a synthetic press cannot borrow.
 */
function pressRebound(commandId: string): void {
  const table = new KeyBindingTable({ registry: consoleCommands, readContext: () => ({}) });
  table.setBindings([{ chord: PRESSED_CODE, commandId }]);
  const target = new EventTarget();
  const detach = table.install(target);
  target.dispatchEvent(new KeyboardEvent("keydown", { code: PRESSED_CODE, key: PRESSED_CODE }));
  detach();
}

describe("a rail destination reached by chord", () => {
  it("warms the destination's surface on the run path, not only the palette's", async () => {
    await mountConsole();

    // The control, in line and not in a case of its own: the board is cold here, so the
    // reading after the press is about the press. A window whose idle walk had already
    // run would fail this line rather than pass the next one for the wrong reason.
    expect(consoleSurfaceRegistry.unloadedKeys()).toContain("workflows");

    pressRebound(WORKFLOWS_COMMAND_ID);

    // Read synchronously: `unloadedKeys` reports whether a load was ASKED for, so this
    // is the frame in which the chunk request either exists or does not.
    expect(consoleSurfaceRegistry.unloadedKeys()).not.toContain("workflows");
  });

  it("does nothing at all for a press that reaches no command", async () => {
    // Without this, a table that ran something on every press would satisfy the case
    // above. Asserted on the ROUTE rather than on the board, because the board is
    // process-wide and this file has already warmed it by now.
    const mounted = await mountConsole();

    pressRebound("frame.thisCommandIsNotRegistered");

    expect(mounted.container.querySelector(".meridian-workflows-destination")).toBeNull();
  });
});
