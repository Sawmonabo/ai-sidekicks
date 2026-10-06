import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step";

/**
 * One step's address inside its run as one string, `node#executionIndex`, for keying what this
 * sitting remembers about a step (its receipt) and for keying its panel.
 */
export function stepKeyText(step: Pick<WorkflowStep, "nodeId" | "executionIndex">): string {
  return `${step.nodeId}#${String(step.executionIndex)}`;
}
