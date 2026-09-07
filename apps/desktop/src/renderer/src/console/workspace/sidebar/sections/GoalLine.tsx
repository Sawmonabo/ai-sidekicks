// The one line the goal section states, in whichever of its four readings applies.
//
// Split from `GoalSection.tsx` so the section is what its name says: a line and the
// control that opens the surface the goal is edited on. What forced the split is the
// control's placement rather than the file's length — the control is offered in every
// reading, because navigating to the goal is exactly as available while the
// projection is incomplete as it is when the fold answered, and a section that
// returned early on each absence could not render it without writing the same button
// out four times.
//
// THE ORDER OF THE ARMS IS THE CLAIM. An incomplete projection may be missing the
// very event that set the goal, so "no goal set" would be this console reporting its
// own gap as the session's state — in the words a person reads as "nobody has set
// one". The unread and degraded readings are therefore answered ahead of the fold,
// and the fold's own unreadable arm ahead of its value.

import { type SessionGoalProjection } from "../../../bridge/index.js";
import { DerivedFigure, Nothing } from "../../../primitives/index.js";

export function GoalLine(props: {
  /** Whether the store has a projection at all yet. */
  readonly isInitialised: boolean;
  /** The store's own word for an incomplete projection, where it has one. */
  readonly degradedCause: string | undefined;
  /** The fold over the log, which is the only place a goal is recorded. */
  readonly goal: SessionGoalProjection;
}): React.JSX.Element {
  if (!props.isInitialised) {
    return <Nothing kind="not-loaded" title="Reading the session's goal." />;
  }
  if (props.degradedCause !== undefined) {
    return (
      <Nothing
        kind="error"
        title="The goal is unavailable."
        detail={`The projection is incomplete (${props.degradedCause}), so a goal read from it could be one the session has already moved past.`}
      />
    );
  }
  if (props.goal.status === "unreadable") {
    return (
      <Nothing
        kind="error"
        title="The latest goal event could not be read."
        detail="A goal event landed carrying a shape this build does not recognise, so the goal shown here would be a guess."
      />
    );
  }
  if (props.goal.status === "set") {
    // Clamped to one measure by the sheet rather than truncated here: the text is the
    // participant's own and a console-shortened goal is a different goal. The full
    // text is the element's title, so it is reachable without a pane.
    return (
      <p className="meridian-sidebar-goal__text" title={props.goal.text}>
        {props.goal.text}
      </p>
    );
  }
  return (
    <p className="meridian-sidebar-goal__none">
      <DerivedFigure text="No goal set" />
    </p>
  );
}
