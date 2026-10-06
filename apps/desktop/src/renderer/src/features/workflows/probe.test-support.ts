// The accessibility tier's workflows mount: the session it addresses and a saved-workflow factory.

import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts/workflow/definition/methods";

/** The session the workflows mount addresses. */
export const PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";

/** One definition, as the enumeration carries it. Override only what a case asserts on. */
export function definition(
  overrides: Partial<WorkflowDefinitionSummary> = {},
): WorkflowDefinitionSummary {
  return {
    id: "release-checklist" as WorkflowDefinitionId,
    name: "Release checklist",
    latestVersionNumber: 3,
    latestWorkflowVersionId: "release-checklist-version-3",
    contentHash: "b3:0f1e2d",
    triggerKind: "trigger.manual",
    enabled: true,
    tags: [],
    runCount: 0,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}
