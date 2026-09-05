// The session goal as it currently stands, read rather than edited.
//
// Split from `SessionGoalCard.tsx`, which owns the draft, the validation, and the
// act of setting a goal, while this owns the projection of what is set.
//
// IT RENDERS THE PROJECTION AND NOTHING LOCAL. A card mid-edit still shows the
// goal the session actually carries, because a draft nobody has committed is not
// yet what the session's agents are working toward.

import { DerivedFigure, Nothing } from "../../primitives/index.js";
import { type SessionGoalProjection } from "./session-goal.js";

/** The read-only line: one goal, clamped to one measure, or an explicit absence. */
export function GoalReading(props: { readonly goal: SessionGoalProjection }): React.JSX.Element {
  if (props.goal.status === "set") {
    return <p className="meridian-goal__text">{props.goal.text}</p>;
  }
  if (props.goal.status === "unreadable") {
    return (
      <Nothing
        kind="error"
        placement="inline"
        title="The latest goal event could not be read."
        detail="A goal event landed carrying a shape this build does not recognise, so the goal shown would be a guess."
      />
    );
  }
  return <DerivedFigure text="No goal set" />;
}
