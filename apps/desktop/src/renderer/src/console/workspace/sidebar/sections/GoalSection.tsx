// The session's one goal, at the sidebar's density: one line, clamped to one measure.
//
// Each sidebar section is a composition of its own read that opens panes, and the
// goal's own density rule is one line here with the editor opening in place on the
// surface that owns it. So this section STATES the goal and never edits it: the set
// and clear controls, the draft, the bounded-text validation, and the two mutations
// all live on the approvals surface's goal card, and a second editor in the sidebar
// would be a second in-flight mutation over a contract that admits exactly one per
// session.
//
// THE READ IS THE LOG, NOT A GOAL STORE. There is no separate goal store anywhere in
// the corpus: the current goal is whatever the latest goal event says, folded by
// origin sequence within an origin and by envelope time between origins. This
// section takes that fold from the bridge family's door — the same fold the card
// takes — because two surfaces folding one log their own way is exactly the second
// source of truth the goal's own rule forbids.
//
// TURN-BOUNDARY EFFECTIVENESS AND CROSS-NODE HONESTY BELONG TO THE CARD. Both are
// sentences about what a goal CHANGE does, and a change is made where the editor is.
// The one line here states what the session's goal is; a person who wants to know
// what changing it will do opens the surface that offers the change.
//
// AND THE CONTROL SAYS NAVIGATION, BECAUSE THAT IS WHAT IT DOES. It read "Set a goal"
// / "Change the goal" — an advertised mutation whose destination renders its editor
// only for a role the goal contract admits, so a caller the contract does not admit
// was promised an act and handed a surface that offers them none. The remedy is the copy
// rather than a role gate here: gating would need a second reading of the caller's
// identity beside the card's own, and it would hide the goal from a user
// entitled to read it. The words are `goal-section-commands.ts`'s and the act is that
// module's one function, both shared with the palette row — so the button, the row,
// and the destination cannot come apart.
//
// THE CONTROL IS OFFERED IN EVERY READING, which is why the line is a component of
// its own. Opening the goal's surface is exactly as available while the projection is
// incomplete as it is when the fold answered — more so, arguably — so the section
// returns one shape rather than four, and the palette row it contributes is present
// on precisely the same condition: this section is on screen.

import { useMemo } from "react";

import { foldSessionGoal } from "../../../bridge/index.js";
import { type SidebarSectionContext } from "../../../seats/index.js";
import {
  useSessionDegradedCause,
  useSessionInitialised,
  useSessionStore,
  type SessionStoreState,
} from "../../../store/index.js";
import { GoalLine } from "./GoalLine.js";
import {
  GOAL_SECTION_ACTION_LABEL,
  openSessionGoalSurface,
  useGoalSectionCommands,
} from "./goal-section-commands.js";

export function GoalSection(context: SidebarSectionContext): React.JSX.Element {
  const timeline = useSessionStore(context.sessionStore, selectTimeline);
  const isInitialised = useSessionInitialised(context.sessionStore);
  const degradedCause = useSessionDegradedCause(context.sessionStore);
  const goal = useMemo(() => foldSessionGoal(timeline), [timeline]);
  useGoalSectionCommands(context.openPane);

  return (
    <div className="meridian-sidebar-goal">
      <GoalLine isInitialised={isInitialised} degradedCause={degradedCause} goal={goal} />
      <button
        type="button"
        className="meridian-sidebar-goal__open"
        onClick={() => {
          openSessionGoalSurface(context.openPane);
        }}
      >
        {GOAL_SECTION_ACTION_LABEL}
      </button>
    </div>
  );
}

function selectTimeline(state: SessionStoreState): SessionStoreState["timeline"] {
  return state.timeline;
}
