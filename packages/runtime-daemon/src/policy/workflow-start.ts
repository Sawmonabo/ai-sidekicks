// Whether a workflow run that an agent or a trigger asks for may start. The person's own starts,
// from any of their devices, pass no policy check and never come here.

import type { UserId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";

import type { Authorizer, PolicyDecision } from "./authorizer.js";

/**
 * Decides whether a start an agent made through its workflow tools, or a run a trigger fired, may
 * begin under the `workflow::start` rules. Each start is evaluated afresh, so a rule changed after a
 * trigger was armed still stops its next run; `owner` is the machine's owning user as the daemon
 * resolved it, and a start whose owner did not resolve is denied without evaluation.
 */
export function checkWorkflowStart(
  authorizer: Authorizer,
  start: { readonly owner: UserId | undefined; readonly workflowId: WorkflowDefinitionId },
): PolicyDecision {
  if (start.owner === undefined) {
    return { decision: "deny", errors: ["the machine's owning user did not resolve"] };
  }
  return authorizer.decide({
    principal: start.owner,
    action: "workflow::start",
    resource: { type: "Workflow", id: start.workflowId },
    context: {},
  });
}
