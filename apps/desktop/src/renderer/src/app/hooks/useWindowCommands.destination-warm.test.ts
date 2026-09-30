// A chord reaches a destination's command directly, so the command has to warm.
//
// The palette calls a navigation command's `preload` while its row is highlighted; a chord calls
// none of it, since `KeybindingTable` resolves the binding and runs the command. Without warming
// in `run`, a loader-backed screen navigated with its chunk unrequested and a keyboard user saw
// the reserved frame.
//
// Driven through the real composed window: the command is the one the window registers, and an
// installed `KeybindingTable` dispatches it, since calling `run` by hand skips the key path.
// The chord is rebound to a modifier-free key for the reason in
// `useWindowCommands.contributions.test.ts`; which chord ships is
// `layout/NavigationRail/navigation-commands.test.ts`'s claim. The reading is taken synchronously
// after the press, before the window's idle walk can load the body and make it vacuous.

import { describe, expect, it } from "vitest";

import { KeybindingTable } from "@renderer/registries/keybindings/keybinding-table.js";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { screenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { mountApp } from "@test/helpers/mount-app.js";

/** A key no console chord binds, and one that needs no modifier to press. */
const PRESSED_CODE = "F9";

const WORKFLOWS_COMMAND_ID = "frame.goToWorkflows";

/**
 * Dispatch the console's registered command for an id, through a real installed table.
 *
 * The table is built over the module-scope registry the mounted window registered into, so the
 * command that runs is the window's own; this only supplies the binding.
 */
function pressRebound(commandId: string): void {
  const table = new KeybindingTable({ registry: commandRegistry, readContext: () => ({}) });
  table.setBindings([{ chord: PRESSED_CODE, commandId }]);
  const target = new EventTarget();
  const detach = table.install(target);
  target.dispatchEvent(new KeyboardEvent("keydown", { code: PRESSED_CODE, key: PRESSED_CODE }));
  detach();
}

describe("a rail destination reached by chord", () => {
  it("warms the destination's screen on the run path, not only the palette's", async () => {
    await mountApp();

    // Control: the board is cold here, so the reading after the press is about the press.
    expect(screenRegistry.unloadedKeys()).toContain("workflows");

    pressRebound(WORKFLOWS_COMMAND_ID);

    // Read synchronously: `unloadedKeys` reports whether a load was asked for.
    expect(screenRegistry.unloadedKeys()).not.toContain("workflows");
  });

  it("does nothing at all for a press that reaches no command", async () => {
    // Without this, a table that ran something on every press would pass the case above.
    // Asserted on the route, since the process-wide board is already warm by now.
    const mounted = await mountApp();

    pressRebound("frame.thisCommandIsNotRegistered");

    expect(mounted.container.querySelector(".meridian-workflows-destination")).toBeNull();
  });
});
