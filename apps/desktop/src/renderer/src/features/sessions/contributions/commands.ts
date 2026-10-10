// The pane layout's palette rows and the four moves' chords. Each row is contributed once at
// composition time and resolves the newest mounted pane layout (`MountedPaneLayouts`) when it is
// pressed; with none mounted the press raises a refusal a person reads.
//
// The moves are chords in the window's table, live only with focus in a pane: the table skips a
// press in a text field, the terminal's body among them, so there the keys reach the field or
// the shell. Focusing and closing stay on the block's own element behind the wider
// `isEditableTarget` (`lib/editable-target.ts`), since a listbox in a pane takes bare arrows.

import { raiseCommandRefusal } from "#renderer/registries/commands/refusal.js";
import { readCommandWindow } from "#renderer/registries/commands/command-window.js";
import { type CommandDefinition } from "#renderer/registries/commands/definition.js";
import { type CommandContributionRegistry } from "#renderer/registries/commands/contributions.js";
import { type Keybinding } from "#renderer/registries/commands/keybinding.js";
import { WHEN_SESSION_ACTIVE } from "#renderer/registries/commands/when-clause/vocabulary.js";
import type { PaneLayoutActName, PaneLayoutActs } from "../pane-layout/acts.js";
import { mountedPaneLayouts, type MountedPaneLayouts } from "../pane-layout/mounted.js";

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

/** The ids of the four move commands, each bound to an `Alt+Shift` arrow. */
const PANE_MOVE_COMMAND_IDS = {
  movePaneLeft: "paneLayout.movePaneLeft",
  movePaneRight: "paneLayout.movePaneRight",
  moveTerminalUp: "paneLayout.moveTerminalUp",
  moveTerminalDown: "paneLayout.moveTerminalDown",
} as const;

/** The clause the four move chords are live under: focus in one of the session's panes. */
const WHEN_PANE_FOCUSED = "sessionActive && paneFocused";

/** The four move chords. */
const PANE_MOVE_KEY_BINDINGS: readonly Keybinding[] = [
  {
    chord: "Alt+Shift+ArrowLeft",
    commandId: PANE_MOVE_COMMAND_IDS.movePaneLeft,
    when: WHEN_PANE_FOCUSED,
  },
  {
    chord: "Alt+Shift+ArrowRight",
    commandId: PANE_MOVE_COMMAND_IDS.movePaneRight,
    when: WHEN_PANE_FOCUSED,
  },
  {
    chord: "Alt+Shift+ArrowUp",
    commandId: PANE_MOVE_COMMAND_IDS.moveTerminalUp,
    when: WHEN_PANE_FOCUSED,
  },
  {
    chord: "Alt+Shift+ArrowDown",
    commandId: PANE_MOVE_COMMAND_IDS.moveTerminalDown,
    when: WHEN_PANE_FOCUSED,
  },
];

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
      id: PANE_MOVE_COMMAND_IDS.movePaneLeft,
      title: "Move pane left",
      group: PANE_LAYOUT_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["pane", "reorder", "rearrange", "side"],
      run: acts.moveFocusedPaneLeft,
    },
    {
      id: PANE_MOVE_COMMAND_IDS.movePaneRight,
      title: "Move pane right",
      group: PANE_LAYOUT_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["pane", "reorder", "rearrange", "side"],
      run: acts.moveFocusedPaneRight,
    },
    {
      id: PANE_MOVE_COMMAND_IDS.moveTerminalUp,
      title: "Move terminal up",
      group: PANE_LAYOUT_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["terminal", "shell", "above"],
      run: acts.moveTerminalUp,
    },
    {
      id: PANE_MOVE_COMMAND_IDS.moveTerminalDown,
      title: "Move terminal down",
      group: PANE_LAYOUT_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["terminal", "shell", "below"],
      run: acts.moveTerminalDown,
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
    keyBindings: PANE_MOVE_KEY_BINDINGS,
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
    moveTerminalUp: () => {
      perform("moveTerminalUp");
    },
    moveTerminalDown: () => {
      perform("moveTerminalDown");
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
