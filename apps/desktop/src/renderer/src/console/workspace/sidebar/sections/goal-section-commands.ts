// The goal section's one act, contributed to the command palette.
//
// Every operator action is palette-reachable, and this section offers exactly one:
// open the surface the goal lives on. The sidebar's own `Enter` command is a different
// act — it expands the section under the DOM-free cursor, on a registry scoped to the
// sidebar element — so a person who never puts focus in the sidebar can reach neither
// it nor this section's control without a pointer.
//
// IT IS NAVIGATION AND SAYS SO. The section states the goal and never edits it: the
// editor, the draft, the validation, and both mutations live on the approvals
// surface's goal card, and whether this window's participant may use them is that
// card's own resolved authorization. So this act promises a destination rather than
// a mutation — and the row and the button carry ONE string, so the palette cannot
// end up calling one act by a second name.
//
// WHY THE ROW IS NOT GATED ON THE GOAL AUTHORIZATION. Gating navigation on a role
// would mean reading the caller's identity here as well, which is a second read of a
// fact that already has one reader, and it would hide the goal itself from a viewer
// who is entitled to see it. The honest fix for "the control advertised an edit the
// destination may refuse" is the copy, not a gate: nothing here claims a mutation, so
// there is nothing for a read-only role to be denied.

import { useMemo } from "react";

import { useConsoleCommandSeat, type ConsoleCommand } from "../../../palette/index.js";
import { useLatestRef } from "../../../primitives/index.js";
import { type ConsolePaneAddress, type ConsolePaneOpener } from "../../../seats/index.js";

/** The owner this row is contributed under. One per surface, one live at a time. */
export const GOAL_SECTION_COMMAND_OWNER = "workspace-goal-section";

/** The id the act is contributed under, namespaced by the surface that owns it. */
export const GOAL_SECTION_COMMAND_ID = "sidebar.openSessionGoal";

/**
 * The words the button and the palette row both use.
 *
 * Neutral about what happens next on purpose: the destination offers the editor to
 * the roles the goal contract admits and states the goal to everyone else, and a
 * label that promised "Set a goal" to a viewer would be advertising an act the
 * surface it opens will not offer them.
 */
export const GOAL_SECTION_ACTION_LABEL = "Open the goal in approvals";

/** The surface the goal's editor and its two mutations live on. */
const GOAL_SURFACE_ADDRESS: ConsolePaneAddress = { kind: "approvals" };

/**
 * The clause the row is offered under.
 *
 * `sessionActive`, the same key every session-scoped act uses: a goal belongs to a
 * session, and this section is rendered only inside one.
 */
const GOAL_SECTION_COMMAND_WHEN = "sessionActive";

/** Contribute the section's act for as long as the section is on screen. */
export function useGoalSectionCommands(openPane: ConsolePaneOpener): void {
  // Refreshed by every COMMITTED render and never in the render body: the sidebar in
  // an auxiliary window hands down that window's own opener, and a pass React throws
  // away would otherwise leave the row opening a pane in a deck nobody is looking at.
  const openPaneRef = useLatestRef(openPane);

  const commands = useMemo<readonly ConsoleCommand[]>(
    () => [
      {
        id: GOAL_SECTION_COMMAND_ID,
        title: GOAL_SECTION_ACTION_LABEL,
        group: "Sidebar",
        when: GOAL_SECTION_COMMAND_WHEN,
        keywords: ["goal", "objective", "approvals"],
        run: () => {
          openSessionGoalSurface(openPaneRef.current);
        },
      },
    ],
    [openPaneRef],
  );

  useConsoleCommandSeat(GOAL_SECTION_COMMAND_OWNER, commands);
}

/**
 * Open the surface that owns the goal — the section's button's act, exactly.
 *
 * One function rather than two call sites composing the same address: the button and
 * the row would otherwise be two places that decide where the goal lives, and the
 * first pane kind to be renamed would take one of them with it and leave the other.
 */
export function openSessionGoalSurface(openPane: ConsolePaneOpener): void {
  openPane(GOAL_SURFACE_ADDRESS);
}
