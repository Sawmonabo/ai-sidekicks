// The pane layout's palette rows. Each row is contributed once at composition time and
// resolves the newest mounted pane layout (`MountedPaneLayouts`) when it is pressed; with
// none mounted the press raises a refusal a person reads.
//
// No chord is claimed here on purpose. The pane layout binds Alt+Arrow, Alt+Shift+Arrow and
// Alt+Backspace on its own element behind `isEditableTarget` (`lib/editable-target.ts`), so
// typing in a find field, combobox or listbox never rearranges panes. The window's binding
// table asks the narrower `isTextEntryTarget` in the capture phase and consumes any press
// whose command ran, so binding these keys there would preempt that guard and eat a
// listbox's arrow keys. A `when` clause cannot carry the guard: its vocabulary is a closed
// set of route keys.

import { raiseCommandRefusal } from "@renderer/registries/commands/command-refusal.js";
import { readCommandWindow } from "@renderer/registries/commands/command-window.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { type CommandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import { WHEN_SESSION_ACTIVE } from "@renderer/registries/commands/window-command-registry.js";
import type { PaneLayoutActName, PaneLayoutActs } from "../pane-layout/pane-layout-acts.js";
import {
  mountedPaneLayouts,
  type MountedPaneLayouts,
} from "../pane-layout/mounted-pane-layouts.js";

/**
 * The palette group these rows sit under. A single binding, because the group is also a
 * secondary match field and two spellings would split the rows across two categories.
 */
export const PANE_LAYOUT_COMMAND_GROUP = "Panes";

/**
 * The owner string this contribution carries. The command registry is owner-scoped, so
 * composing twice (a hot reload, a second test) replaces these rows instead of raising.
 */
export const PANE_LAYOUT_COMMAND_OWNER = "pane-layout";

/** Build the palette commands, given the acts each one performs. */
export function paneLayoutPaletteCommands(acts: PaneLayoutActs): readonly CommandDefinition[] {
  return [
    {
      id: "paneLayout.focusNextPane",
      title: "Focus the next pane",
      group: PANE_LAYOUT_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["pane", "cycle", "right", "forward"],
      run: acts.focusNextPane,
    },
    {
      id: "paneLayout.focusPreviousPane",
      title: "Focus the previous pane",
      group: PANE_LAYOUT_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["pane", "cycle", "left", "back"],
      run: acts.focusPreviousPane,
    },
    {
      id: "paneLayout.closePane",
      title: "Close the focused pane",
      group: PANE_LAYOUT_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["pane", "dismiss", "hide"],
      run: acts.closeFocusedPane,
    },
    {
      id: "paneLayout.movePaneLeft",
      title: "Move the focused pane left",
      group: PANE_LAYOUT_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["pane", "reorder", "rearrange"],
      run: acts.moveFocusedPaneLeft,
    },
    {
      id: "paneLayout.movePaneRight",
      title: "Move the focused pane right",
      group: PANE_LAYOUT_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["pane", "reorder", "rearrange"],
      run: acts.moveFocusedPaneRight,
    },
  ];
}

/**
 * Contribute the pane layout's commands to a window. Takes the registry rather than the
 * module-scope one, so a test contributes into one it owns.
 */
export function registerPaneLayoutCommands(
  registry: CommandContributionRegistry,
  mountedLayouts: MountedPaneLayouts = mountedPaneLayouts,
): void {
  registry.contribute({
    owner: PANE_LAYOUT_COMMAND_OWNER,
    commands: paneLayoutPaletteCommands(actsOnTheMountedPaneLayout(mountedLayouts)),
    keyBindings: [],
  });
}

/**
 * The act set every contributed command runs through. Written out rather than derived from a
 * name list, so an act added to `PaneLayoutActs` fails to compile here.
 */
function actsOnTheMountedPaneLayout(mountedLayouts: MountedPaneLayouts): PaneLayoutActs {
  const perform = (act: PaneLayoutActName): void => {
    performOnMountedPaneLayout(mountedLayouts, act);
  };
  return {
    focusNextPane: () => {
      perform("focusNextPane");
    },
    focusPreviousPane: () => {
      perform("focusPreviousPane");
    },
    closeFocusedPane: () => {
      perform("closeFocusedPane");
    },
    moveFocusedPaneLeft: () => {
      perform("moveFocusedPaneLeft");
    },
    moveFocusedPaneRight: () => {
      perform("moveFocusedPaneRight");
    },
  };
}

/** Perform one act, and state the refusal where a person can see it. */
function performOnMountedPaneLayout(
  mountedLayouts: MountedPaneLayouts,
  act: PaneLayoutActName,
): void {
  const outcome = mountedLayouts.perform(act, readCommandWindow());
  if (outcome.status === "refused") {
    raiseCommandRefusal(outcome.refusal);
  }
}
