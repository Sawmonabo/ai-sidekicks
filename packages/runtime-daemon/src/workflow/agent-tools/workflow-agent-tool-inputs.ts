// The inputs of the workflow tools an agent calls from a session, where they differ from
// the request of the method the tool drives. A tool whose input is its method's request
// takes that request schema as it is: `workflow_kinds` takes `workflow.kindList`'s,
// `workflow_update` takes `workflow.definitionUpdate`'s, and `workflow_enable` takes
// `workflow.enabledSet`'s.
//
// A tool never takes a session id: the session is the one whose turn called it, so an
// agent cannot reach a workflow through another session. The JSON Schema a provider
// receives is generated from these schemas, so each member's description is the text the
// model reads.
import {
  WorkflowContentHashSchema,
  WorkflowDefinitionIdSchema,
  WorkflowDefinitionScopeRefSchema,
  WorkflowDefinitionScopeSchema,
  WorkflowDocumentSchema,
  WorkflowDraftDocumentSchema,
  type SessionCallbackTool,
  type WorkflowDefinitionId,
  type WorkflowDefinitionScope,
  type WorkflowDocument,
  type WorkflowDraftDocument,
} from "@ai-sidekicks/contracts";
import { z } from "zod";

const positiveNumber = z.number().int().positive();

/** The `workflow_run` input: a workflow named as the session sees it. */
export interface WorkflowRunToolInput {
  definitionName: string;
  scope?: WorkflowDefinitionScope | undefined;
}
/** Schema for {@link WorkflowRunToolInput}. */
export const WorkflowRunToolInputSchema: z.ZodType<WorkflowRunToolInput, WorkflowRunToolInput> = z
  .object({
    definitionName: z.string().min(1).describe("The workflow's name."),
    scope: WorkflowDefinitionScopeSchema.optional().describe(
      "Where to look. Omitted, the name resolves in this session first, then its project, then shared.",
    ),
  })
  .strict();

/**
 * The `workflow_run` tool: starts the latest version of a named workflow, its run living
 * in the session whose turn called it.
 */
export const WORKFLOW_RUN_TOOL: SessionCallbackTool = {
  name: "workflow_run",
  description:
    "Start a workflow run in this session by definition name. Resolution is most-specific-first across the session, project, and shared scopes.",
  inputSchema: z.toJSONSchema(WorkflowRunToolInputSchema),
};

/** The `workflow_list` input: the method's request without a session. */
export interface WorkflowListToolInput {
  scope?: WorkflowDefinitionScope | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}
/** Schema for {@link WorkflowListToolInput}. */
export const WorkflowListToolInputSchema: z.ZodType<WorkflowListToolInput, WorkflowListToolInput> =
  z
    .object({
      scope: WorkflowDefinitionScopeSchema.optional().describe(
        "One scope only. Omitted, every scope this session can see.",
      ),
      limit: positiveNumber.optional().describe("The most workflows to return."),
      cursor: z
        .string()
        .min(1)
        .optional()
        .describe("The cursor a previous call returned, to read the next page."),
    })
    .strict();

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

/** The `workflow_validate` input: a document checked as a save would check it, unsaved. *
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
 * The `workflow_create` input: the method's request without a session. A document with
 * no layout is laid out by the daemon.
 */
export interface WorkflowCreateToolInput {
  scope: WorkflowDefinitionScope;
  scopeRef?: string | undefined;
  parentContentHash?: string | undefined;
  document: WorkflowDocument;
}
/** Schema for {@link WorkflowCreateToolInput}. */
export const WorkflowCreateToolInputSchema: z.ZodType<
  WorkflowCreateToolInput,
  WorkflowCreateToolInput
> = z
  .object({
    scope: WorkflowDefinitionScopeSchema.describe("Where the workflow is saved."),
    scopeRef: WorkflowDefinitionScopeRefSchema.optional().describe(
      "The repository root for a project workflow. Omitted for session and shared.",
    ),
    parentContentHash: WorkflowContentHashSchema.optional().describe(
      "The content hash of the shared workflow this one branches from, when it does.",
    ),
    document: WorkflowDocumentSchema,
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
