// How a workflow run was started and by whom: the run mode, the trigger node's kind, and the
// person, device, message or parent run that started it.
import { z } from "zod";

import { AgentIdSchema, type AgentId } from "../../agent/definition.js";
import { EventCursorSchema, SessionIdSchema, type SessionId } from "../../session/id.js";
import { type EventCursor } from "../../session/event-cursor.js";
import { DeviceIdSchema, type DeviceId } from "../../trust-statement.js";
import { WorkflowRunIdSchema, type WorkflowRunId } from "./id.js";

/** How a run was started, which is a different question from who started it. */
export const WORKFLOW_RUN_MODES = [
  "manual",
  "trigger",
  "webhook",
  "chat",
  "agent",
  "retry",
  "sub-workflow",
] as const;
/** One of {@link WORKFLOW_RUN_MODES}. */
export type WorkflowRunMode = (typeof WORKFLOW_RUN_MODES)[number];
/** Wire schema for {@link WorkflowRunMode}. */
export const WorkflowRunModeSchema: z.ZodType<WorkflowRunMode, WorkflowRunMode> =
  z.enum(WORKFLOW_RUN_MODES);

/**
 * The kind of trigger node that started a run, which the runs table's trigger column and filter
 * read. A retry keeps its source run's kind; a mode cannot carry this, because `trigger` covers a
 * schedule, a file event, a session event and another workflow failing alike.
 */
export const WORKFLOW_TRIGGER_KINDS = [
  "trigger.manual",
  "trigger.schedule",
  "trigger.file-watch",
  "trigger.webhook",
  "trigger.session-event",
  "trigger.chat",
  "trigger.sub-workflow",
  "trigger.error",
] as const;
/** One of {@link WORKFLOW_TRIGGER_KINDS}. */
export type WorkflowTriggerKind = (typeof WORKFLOW_TRIGGER_KINDS)[number];
/** Wire schema for {@link WorkflowTriggerKind}. */
export const WorkflowTriggerKindSchema: z.ZodType<WorkflowTriggerKind, WorkflowTriggerKind> =
  z.enum(WORKFLOW_TRIGGER_KINDS);

/**
 * Who or what started a run, as its row and its header name it. A person's start records the
 * device of the connection that made it, never a person; a chat start carries the message it
 * came from, so the run links back to that message.
 */
export type WorkflowStartedBy =
  | { kind: "user"; deviceId: DeviceId }
  | { kind: "schedule" }
  | { kind: "chat"; sessionId: SessionId; messageAnchorCursor?: EventCursor | undefined }
  | { kind: "agent"; agentId: AgentId }
  | { kind: "webhook" }
  | { kind: "fileEvent" }
  | { kind: "parentWorkflow"; parentWorkflowRunId: WorkflowRunId };
/** Wire schema for {@link WorkflowStartedBy}. */
export const WorkflowStartedBySchema: z.ZodType<WorkflowStartedBy> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), deviceId: DeviceIdSchema }).strict(),
  z.object({ kind: z.literal("schedule") }).strict(),
  z
    .object({
      kind: z.literal("chat"),
      sessionId: SessionIdSchema,
      messageAnchorCursor: EventCursorSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("agent"), agentId: AgentIdSchema }).strict(),
  z.object({ kind: z.literal("webhook") }).strict(),
  z.object({ kind: z.literal("fileEvent") }).strict(),
  z
    .object({ kind: z.literal("parentWorkflow"), parentWorkflowRunId: WorkflowRunIdSchema })
    .strict(),
]);
