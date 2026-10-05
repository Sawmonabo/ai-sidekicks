import type { WorkflowRunStatus, WorkflowWaitCause } from "@ai-sidekicks/contracts/workflow-run";

import { Chip, type ChipTone } from "@renderer/components/Chip/Chip.js";
import { isPersonWaitCause } from "../run-steps.js";
import { RUN_STATUS_WORDS } from "../workflow-words.js";

/**
 * A run's status as one chip. Amber only for a run waiting on a person, red for a run that
 * failed or crashed, the accent for one running; a run held on a spent account is not amber.
 */
export function RunStatusChip(props: {
  readonly status: WorkflowRunStatus;
  readonly waitCause?: WorkflowWaitCause | undefined;
}): React.JSX.Element {
  return (
    <Chip tone={toneOf(props.status, props.waitCause)} label={RUN_STATUS_WORDS[props.status]} />
  );
}

function toneOf(status: WorkflowRunStatus, waitCause: WorkflowWaitCause | undefined): ChipTone {
  switch (status) {
    case "running":
      return "accent";
    case "waiting":
      return isPersonWaitCause(waitCause) ? "attention" : "neutral";
    case "failed":
    case "crashed":
      return "failure";
    case "new":
    case "succeeded":
    case "canceled":
      return "neutral";
  }
}
