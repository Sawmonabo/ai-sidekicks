// The step-in receipt: what the pause did, in the daemon's own figures, and which of
// the other two acts landed.
//
// Its own module because `apps/desktop/AGENTS.md` allows one component per `.tsx`,
// and because the two have different jobs — `StepIn.tsx` performs the three acts and
// this one only renders what they answered. It is reached by a relative deep import
// from its host rather than through the family door: nothing outside this family
// renders a step-in receipt, and a door line for it would advertise a seam that has
// no reader.
//
// "YOU HAVE THE FLOOR" IS A CLAIM, SO IT IS ONLY MADE WHERE IT IS TRUE. The composer
// is addressed at a run through the deck's focused pane, and a run whose agent this
// session's store has never seen leaves the composer on the channel path. Saying the
// person has the floor there would be the console reporting an act it did not perform.
//
// AND THE CHECKOUT IS NAMED THE SAME WAY. Three of the four dispositions are ordinary
// states of a real session rather than failures — a run that made no live checkout, a
// run naming more than one, and an execution-root read that refused — so each gets a
// clause of its own and none of them withholds the pause that already happened.

import { InlineRefusal, WireFigure } from "../../../primitives/index.js";
import type { TakeTheFloorOutcome } from "../../../seats/index.js";
import type { StepInState } from "./step-in-state.js";

/** What happened, said once, in the daemon's own figures. */
export function StepInReceipt(props: {
  readonly agentLabel: string;
  readonly state: StepInState;
}): React.JSX.Element | null {
  const { state } = props;
  if (state.phase === "refused") {
    return <InlineRefusal code={state.refusal.code} detail={state.refusal.detail} />;
  }
  if (state.phase !== "paused") {
    return null;
  }
  const floor = state.floor;
  const addressed = floor !== undefined && floor.status === "moved" && floor.composerAddressed;
  const aside = floor === undefined ? undefined : worktreeSentence(floor);
  return (
    <span className="meridian-step-in__receipt" role="status">
      Paused {props.agentLabel} at <WireFigure value={state.acknowledgment.currentState} />, version{" "}
      <WireFigure value={String(state.acknowledgment.runVersion)} />.
      {addressed ? " You have the floor." : null}
      {aside === undefined ? null : ` ${aside}`}
    </span>
  );
}

/**
 * What the deck answered about this run's checkout, as a sentence or as nothing.
 *
 * A total switch over the disposition rather than a chain of conditionals, so a fifth
 * arm added to the seat fails to compile here instead of rendering as silence. The
 * `opened` arm is the one that says nothing: the pane is on screen, which is the whole
 * of the report.
 */
function worktreeSentence(floor: TakeTheFloorOutcome): string | undefined {
  if (floor.status === "no-deck") {
    return "No deck of panes is open in this window, so nothing was put on screen.";
  }
  switch (floor.worktree) {
    case "opened":
      return undefined;
    case "unnamed":
      return "This run names no live checkout, so no worktree pane opened.";
    case "ambiguous":
      return "More than one live checkout names this run, so none was opened.";
    case "unreadable":
      return "The execution roots could not be read, so no worktree pane opened.";
  }
}
