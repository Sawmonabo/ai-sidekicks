// Whether the clear control is offered: one predicate, the card and the palette row.
//
// The card's clear button and the palette's clear row are the same act, and each used
// to spell the rule out for itself — `goal.status === "set" && !isMutating` in the row
// builder, `disabled={isMutating || goal.status !== "set"}` inside the editor. Same
// answer today and two expressions of it, which is the shape that drifts silently:
// whichever half is edited next leaves the other offering an act the surface beside it
// has withdrawn.

import { type SessionGoalProjection } from "../../../bridge/index.js";

/**
 * Whether clearing the goal is an act there is anything to do.
 *
 * Two facts and no permission among them: there has to BE a goal to clear, and the one
 * mutation this session allows in flight must not already be running.
 */
export function canClearSessionGoal(goal: SessionGoalProjection, isMutating: boolean): boolean {
  return goal.status === "set" && !isMutating;
}
