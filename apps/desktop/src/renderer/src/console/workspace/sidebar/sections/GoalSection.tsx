// The session's one goal, at the sidebar's density: one line, clamped to one measure.
//
// `Spec-023 §The surface set` makes each sidebar section "a composition of its own
// read, opening panes", and the goal's own density rule is one line here with the
// editor opening in place on the surface that owns it. So this section STATES the
// goal and never edits it: the set and clear controls, the draft, the bounded-text
// validation, and the two mutations all live on the approvals surface's goal card,
// and a second editor in the sidebar would be a second in-flight mutation over a
// contract that admits exactly one per session.
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

import { useMemo } from "react";

import { foldSessionGoal } from "../../../bridge/index.js";
import { DerivedFigure, Nothing } from "../../../primitives/index.js";
import { type SidebarSectionContext } from "../../../seats/index.js";
import {
  useSessionDegradedCause,
  useSessionInitialised,
  useSessionStore,
  type SessionStoreState,
} from "../../../store/index.js";

function selectTimeline(state: SessionStoreState): SessionStoreState["timeline"] {
  return state.timeline;
}

export function GoalSection(context: SidebarSectionContext): React.JSX.Element {
  const timeline = useSessionStore(context.sessionStore, selectTimeline);
  const isInitialised = useSessionInitialised(context.sessionStore);
  const degradedCause = useSessionDegradedCause(context.sessionStore);
  const goal = useMemo(() => foldSessionGoal(timeline), [timeline]);

  if (!isInitialised) {
    return <Nothing kind="not-loaded" title="Reading the session's goal." />;
  }
  if (degradedCause !== undefined) {
    // An incomplete projection may be missing the very event that set the goal, so
    // "no goal set" would be this console reporting its own gap as the session's
    // state. The cause is the store's own word, rendered as received.
    return (
      <Nothing
        kind="error"
        title="The goal is unavailable."
        detail={`The projection is incomplete (${degradedCause}), so a goal read from it could be one the session has already moved past.`}
      />
    );
  }
  if (goal.status === "unreadable") {
    return (
      <Nothing
        kind="error"
        title="The latest goal event could not be read."
        detail="A goal event landed carrying a shape this build does not recognise, so the goal shown here would be a guess."
      />
    );
  }
  return (
    <div className="meridian-sidebar-goal">
      {goal.status === "set" ? (
        // Clamped to one measure by the sheet rather than truncated here: the text
        // is the participant's own and a console-shortened goal is a different goal.
        // The full text is the element's title, so it is reachable without a pane.
        <p className="meridian-sidebar-goal__text" title={goal.text}>
          {goal.text}
        </p>
      ) : (
        <p className="meridian-sidebar-goal__none">
          <DerivedFigure text="No goal set" />
        </p>
      )}
      <button
        type="button"
        className="meridian-sidebar-goal__open"
        onClick={() => {
          // The surface that holds the editor. Offering a set control here that
          // opened nothing, or a second editor that could not see the card's own
          // in-flight mutation, are the two ways this line could lie about what it
          // can do.
          context.openPane({ kind: "approvals" });
        }}
      >
        {goal.status === "set" ? "Change the goal" : "Set a goal"}
      </button>
    </div>
  );
}
