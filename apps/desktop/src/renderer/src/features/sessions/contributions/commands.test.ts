// What the palette offers for the pane layout: the five rows and the chord they do not claim.

import { describe, expect, it } from "vitest";

import type { CommandDefinition, Keybinding } from "@renderer/registries/commands/command-types.js";
import { CommandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import { CommandRegistry } from "@renderer/registries/commands/command-registry.js";
import { MountedPaneLayouts } from "../pane-layout/mounted-pane-layouts.js";
import { createSpyingPaneLayoutActs } from "../pane-layout/pane-layout-acts.test-support.js";
import {
  PANE_LAYOUT_COMMAND_OWNER,
  paneLayoutPaletteCommands,
  registerPaneLayoutCommands,
} from "./commands.js";

function commandById(commands: readonly CommandDefinition[], id: string): CommandDefinition {
  const command = commands.find((candidate) => candidate.id === id);
  expect(command).not.toBeUndefined();
  return command as CommandDefinition;
}

describe("the pane layout's palette rows", () => {
  it("offers all five pane acts, each scoped to a window with a session", () => {
    const commands = paneLayoutPaletteCommands(createSpyingPaneLayoutActs());
    expect(commands.map((command) => command.id)).toStrictEqual([
      "paneLayout.focusNextPane",
      "paneLayout.focusPreviousPane",
      "paneLayout.closePane",
      "paneLayout.movePaneLeft",
      "paneLayout.movePaneRight",
    ]);
    for (const command of commands) {
      expect(command.when).toBe("sessionActive");
    }
  });

  it("runs the act the row names", () => {
    const paneLayoutActs = createSpyingPaneLayoutActs();
    const commands = paneLayoutPaletteCommands(paneLayoutActs);
    commandById(commands, "paneLayout.focusNextPane").run();
    commandById(commands, "paneLayout.focusPreviousPane").run();
    commandById(commands, "paneLayout.closePane").run();
    commandById(commands, "paneLayout.movePaneLeft").run();
    commandById(commands, "paneLayout.movePaneRight").run();
    expect(paneLayoutActs.focusNextPane).toHaveBeenCalledTimes(1);
    expect(paneLayoutActs.focusPreviousPane).toHaveBeenCalledTimes(1);
    expect(paneLayoutActs.closeFocusedPane).toHaveBeenCalledTimes(1);
    expect(paneLayoutActs.moveFocusedPaneLeft).toHaveBeenCalledTimes(1);
    expect(paneLayoutActs.moveFocusedPaneRight).toHaveBeenCalledTimes(1);
  });

  it("claims no chord, because the pane layout binds these five on its own element", () => {
    // The module's own reasoning, pinned: a window-table binding installs in the
    // capture phase and consumes any press whose command ran, so it would preempt the
    // pane layout's wide editable-target guard and eat a listbox's arrow keys.
    const commands = new CommandRegistry();
    const contributions = new CommandContributionRegistry(commands);
    registerPaneLayoutCommands(contributions, new MountedPaneLayouts());
    expect(commands.has("paneLayout.focusNextPane")).toBe(true);
    expect(contributions.keyBindings()).toStrictEqual([] as readonly Keybinding[]);
    // Contributed under the pane layout's owner: that owner's empty contribution takes
    // every row back out.
    contributions.contribute({ owner: PANE_LAYOUT_COMMAND_OWNER, commands: [], keyBindings: [] });
    expect(commands.all()).toStrictEqual([]);
  });
});
