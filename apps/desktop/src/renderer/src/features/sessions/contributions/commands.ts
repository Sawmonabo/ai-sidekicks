// What the deck contributes to the palette, and how a press reaches the deck that is
// actually on screen.
//
// The five acts are `deck-acts.ts`'; this file is the seam between them and the
// window's command surface: a mounted-surface seat plus a contribution made at
// composition time. Nothing here crosses a family boundary and nothing here belongs in
// `seats/`.
//
// CONTRIBUTED AT COMPOSITION TIME, RESOLVED AT PRESS TIME. A command is built once per
// window, before any deck exists; the deck comes and goes with the route. So each row
// resolves the mounted deck when it runs, and an empty seat is a REFUSAL a person
// reads rather than a press that does nothing.
//
// WHY NO CHORD IS CLAIMED HERE, WHICH IS A DECISION AND NOT AN OMISSION.
//
// The deck already binds these five keystrokes on its own element — Alt+Arrow to
// cycle, Alt+Shift+Arrow to move, Alt+Backspace to close — and it guards them with
// `isEditableTarget`, the WIDE question: does the focused widget own its arrow keys?
// A find field, a combobox and a listbox all do, and `primitives/editable-target.ts`
// records that pairing as the fix for a measured defect, where typing in a pane's find
// field rearranged or closed the pane it was typed in.
//
// The window's binding table asks the NARROW question (`isTextEntryTarget`) and
// installs in the CAPTURE phase, and it consumes any press whose command RAN —
// `preventDefault` plus `stopPropagation`, on the reasoning that a press which ran
// something is the console's. Binding these same keystrokes there would therefore
// preempt the deck's handler and, inside a listbox or a combobox, run the deck act and
// eat the widget's arrow key. Moving the wide guard into the acts would not help: the
// act would decline and the table would consume the press anyway, because a command
// that ran is what the table measures. The only place the guard could live is a
// `when` clause, and the console's clause vocabulary is a closed set of route keys.
//
// So the keystrokes stay the deck's, where the wide guard is, and the palette rows are
// what this file adds: the same five acts, discoverable by name, reachable from
// anywhere in the session, and refusing out loud when there is no deck to act on.

import { raiseCommandRefusal } from "@renderer/registries/commands/command-refusal.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { type CommandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import type { PaneLayoutActName, PaneLayoutActs } from "../pane-layout/pane-layout-acts.js";
import {
  mountedPaneLayouts,
  type MountedPaneLayouts,
} from "../pane-layout/mounted-pane-layouts.js";

/**
 * The palette group these rows sit under.
 *
 * One binding rather than a literal per command: the group is also a secondary match
 * field, so two spellings would split the surface's rows across two categories.
 */
export const PANE_LAYOUT_COMMAND_GROUP = "Panes";

/**
 * The `when` clause every command carries.
 *
 * Fail-closed by construction: the palette answers `false` for a key the context does
 * not carry, so a window with no session offers none of these rather than offering
 * acts with nothing to act on.
 */
const WHEN_SESSION_ACTIVE = "sessionActive";

/**
 * The owner string this contribution carries.
 *
 * The contribution door is owner-scoped, so composing twice — a hot reload, a second
 * test — replaces these rows instead of raising on their ids.
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
 * Contribute the deck's commands to a window.
 *
 * Takes the surface rather than reaching for the module-scope door, for
 * `registerTranscriptCommands`' reason: a test contributes into a surface it owns.
 */
export function registerPaneLayoutCommands(
  surface: CommandContributionRegistry,
  seat: MountedPaneLayouts = mountedPaneLayouts,
): void {
  surface.contribute({
    owner: PANE_LAYOUT_COMMAND_OWNER,
    commands: paneLayoutPaletteCommands(actsOnTheMountedDeck(seat)),
    keyBindings: [],
  });
}

/**
 * The act set every contributed command runs through.
 *
 * Written out rather than derived from a name list, so a SIXTH act added to `PaneLayoutActs`
 * fails to compile here instead of being contributed as a command that reaches the
 * mounted deck through nothing.
 */
function actsOnTheMountedDeck(seat: MountedPaneLayouts): PaneLayoutActs {
  const perform = (act: PaneLayoutActName): void => {
    performOnMountedDeck(seat, act);
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
function performOnMountedDeck(seat: MountedPaneLayouts, act: PaneLayoutActName): void {
  const outcome = seat.perform(act);
  if (outcome.status === "refused") {
    raiseCommandRefusal(outcome.refusal);
  }
}
