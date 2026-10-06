import { useContext } from "react";

import { WorkflowCommandTargetsContext, type WorkflowCommandTargets } from "../command-target.js";

/**
 * The keyed acts the workflows screen offers to what it draws. Throws when called outside the
 * screen, which is the only place a control offering one is drawn.
 */
export function useWorkflowCommandTargets(): WorkflowCommandTargets {
  const targets = useContext(WorkflowCommandTargetsContext);
  if (targets === undefined) {
    throw new Error("A workflows control is drawn outside the workflows screen.");
  }
  return targets;
}
