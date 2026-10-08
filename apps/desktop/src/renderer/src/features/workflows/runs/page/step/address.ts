import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step/record";

/** The two members that name a step inside its run. */
export type StepAddress = Pick<WorkflowStep, "nodeId" | "executionIndex">;

/**
 * One step's address inside its run as one string, `node#executionIndex`, for keying what this
 * sitting remembers about a step (its receipt) and for keying its panel.
 */
export function stepKeyText(step: StepAddress): string {
  return `${step.nodeId}#${String(step.executionIndex)}`;
}
