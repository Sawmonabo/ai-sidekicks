// Input schemas for the workflow tools an agent calls from a session, for the tools whose input
// differs from the request of the method they drive. `workflow_run` is in
// `@ai-sidekicks/contracts/workflow/run-tool`, which the desktop also reads. `workflow_kinds`,
// `workflow_list`, `workflow_create`, `workflow_update` and `workflow_enable` take their methods'
// request schemas (`workflow.kindList`, `workflow.definitionList`, `workflow.definitionCreate`,
// `workflow.definitionUpdate`, `workflow.enabledSet`) unchanged.
//
// No tool takes a session id: the session is the one whose turn made the call, so an agent cannot
// reach another session. Only `workflow_run` takes a repository, a project's, for a workflow that
// needs one; without it the run works in that session's folder. The JSON Schema a provider
// receives is generated from these schemas, so each member's description is the text the model
// reads.
import {
  WorkflowDefinitionIdSchema,
  WorkflowDraftDocumentSchema,
  type WorkflowDefinitionId,
  type WorkflowDraftDocument,
} from "@ai-sidekicks/contracts/workflow/definition/definition";
import { z } from "zod";

const positiveNumber = z.number().int().positive();

/**
 * The `workflow_read` input: one version of a workflow, and with `diffFromVersion` its
 * changes since that version. It drives the definition read, the version read and the
 * version diff, each addressed by version number.
 *
 * @consumedBy the workflow agent tools, when the daemon serves them
 */
export interface WorkflowReadToolInput {
  definitionId: WorkflowDefinitionId;
  version?: number | undefined;
  diffFromVersion?: number | undefined;
}
/**
 * Schema for {@link WorkflowReadToolInput}.
 *
 * @consumedBy the workflow agent tools, when the daemon serves them
 */
export const WorkflowReadToolInputSchema: z.ZodType<WorkflowReadToolInput, WorkflowReadToolInput> =
  z
    .object({
      definitionId: WorkflowDefinitionIdSchema.describe("The workflow's id, from workflow_list."),
      version: positiveNumber.optional().describe("The version number. Omitted, the latest."),
      diffFromVersion: positiveNumber
        .optional()
        .describe("An earlier version number; the result adds what changed since it."),
    })
    .strict();

/**
 * The `workflow_validate` input: a document checked as a save would check it, unsaved.
 *
 * @consumedBy the workflow agent tools, when the daemon serves them
 */
export interface WorkflowValidateToolInput {
  document: WorkflowDraftDocument;
}
/**
 * Schema for {@link WorkflowValidateToolInput}.
 *
 * @consumedBy the workflow agent tools, when the daemon serves them
 */
export const WorkflowValidateToolInputSchema: z.ZodType<
  WorkflowValidateToolInput,
  WorkflowValidateToolInput
> = z
  .object({
    document: WorkflowDraftDocumentSchema.describe(
      "The document to check. The result lists every finding a save would refuse.",
    ),
  })
  .strict();

/**
 * The `workflow_schedule_set` input: a new schedule for a workflow's schedule trigger.
 * The tool reads the workflow and saves a new version, so it names the version it read
 * and is refused when another save came first.
 *
 * @consumedBy the workflow agent tools, when the daemon serves them
 */
export interface WorkflowScheduleSetToolInput {
  definitionId: WorkflowDefinitionId;
  expectedVersionNumber: number;
  expression: string;
  timeZone: string;
}
/**
 * Schema for {@link WorkflowScheduleSetToolInput}.
 *
 * @consumedBy the workflow agent tools, when the daemon serves them
 */
export const WorkflowScheduleSetToolInputSchema: z.ZodType<
  WorkflowScheduleSetToolInput,
  WorkflowScheduleSetToolInput
> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema.describe("The workflow's id, from workflow_list."),
    expectedVersionNumber: positiveNumber.describe(
      "The version number read before this change; refused if a newer version exists.",
    ),
    expression: z.string().min(1).describe("A cron expression, such as 0 8 * * 1-5."),
    timeZone: z
      .string()
      .min(1)
      .describe("The IANA time zone the expression is read in, such as America/New_York."),
  })
  .strict();
