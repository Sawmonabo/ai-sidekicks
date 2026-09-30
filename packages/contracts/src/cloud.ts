// A session's tasks in its provider's own cloud: sending one, the session's live
// list of them, one task's last reported state, a Codex attempt's diff, and bringing
// a task back into the session.
//
// The daemon only calls the provider's own cloud verbs, under the session's account
// and from the session's folder; it never runs the remote work. So a task's state is
// only what its provider reported. Codex reports `pending`, `ready`, `applied` or
// `error`; Claude Code's command line reads no status at all, so its task is
// `submitted` for its whole life. The task shape is split by provider so neither can
// carry the other's states, and a state no provider reported cannot parse.
//
// This module imports nothing that reaches `./event.js`: `event.ts` imports the task
// update payload from here, and a cycle among eager module-scope schemas throws at
// load.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import {
  FILE_PATH_MAX_LEN,
  SessionIdSchema,
  wireFreeFormString,
  type SessionId,
} from "./session.js";

/** The longest cloud task id the daemon accepts. */
export const CLOUD_TASK_ID_MAX_LEN = 256;

/** The longest Codex cloud environment label the daemon accepts. */
export const CLOUD_ENVIRONMENT_LABEL_MAX_LEN = 256;

/** The most attempts one Codex cloud task runs: Codex's own bound. */
export const CLOUD_TASK_ATTEMPTS_MAX = 4;

/** The id the provider gave a cloud task: Codex's task id, or Claude Code's cloud session id. */
export type CloudTaskId = string & { readonly __brand: "CloudTaskId" };
/** Parses a {@link CloudTaskId}: a non-empty string up to {@link CLOUD_TASK_ID_MAX_LEN}. */
export const CloudTaskIdSchema: z.ZodType<CloudTaskId, CloudTaskId> = z
  .string()
  .min(1)
  .max(CLOUD_TASK_ID_MAX_LEN)
  .brand<"CloudTaskId">() as unknown as z.ZodType<CloudTaskId, CloudTaskId>;

/** One attempt of a Codex task, counted from 1. */
const CloudTaskAttemptSchema = z.number().int().min(1).max(CLOUD_TASK_ATTEMPTS_MAX);

/** The label of a Codex cloud environment, as the account's own tasks name it or as typed. */
const CloudEnvironmentLabelSchema = wireFreeFormString(
  CLOUD_ENVIRONMENT_LABEL_MAX_LEN,
  "Cloud environment",
);

// --------------------------------------------------------------------------
// Refusals
// --------------------------------------------------------------------------

/**
 * Sending to the cloud is refused because this session cannot use its provider's
 * cloud: a Codex account without a ChatGPT sign-in, a Claude Code account without a
 * claude.ai Pro, Max or Team sign-in, or a project with no GitHub remote.
 */
export const CLOUD_UNAVAILABLE_CODE = "cloud.unavailable" as const;
export type CloudUnavailableCode = typeof CLOUD_UNAVAILABLE_CODE;

const CLOUD_UNAVAILABLE_REASON_VALUES = [
  "chatgpt_sign_in_required",
  "claude_subscription_required",
  "github_remote_required",
] as const;
/** Why {@link CLOUD_UNAVAILABLE_CODE} refused. */
export type CloudUnavailableReason = (typeof CLOUD_UNAVAILABLE_REASON_VALUES)[number];
export const CLOUD_UNAVAILABLE_REASONS: readonly CloudUnavailableReason[] =
  CLOUD_UNAVAILABLE_REASON_VALUES;

// --------------------------------------------------------------------------
// The task
// --------------------------------------------------------------------------

/**
 * What Codex reported when an attempt was applied to the session's folder: all of
 * it, part of it with the paths it skipped and the paths in conflict, or an error in
 * Codex's own words.
 */
export type CodexCloudBringBack =
  | { outcome: "applied" }
  | { outcome: "partial"; skippedPaths: string[]; conflictingPaths: string[] }
  | { outcome: "error"; message: string };
/** Parses a {@link CodexCloudBringBack}. */
export const CodexCloudBringBackSchema: z.ZodType<CodexCloudBringBack> = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("applied") }).strict(),
    z
      .object({
        outcome: z.literal("partial"),
        skippedPaths: z.array(z.string().min(1).max(FILE_PATH_MAX_LEN)),
        conflictingPaths: z.array(z.string().min(1).max(FILE_PATH_MAX_LEN)),
      })
      .strict(),
    z.object({ outcome: z.literal("error"), message: z.string().min(1) }).strict(),
  ],
);

interface CodexCloudTaskBase {
  taskId: CloudTaskId;
  sessionId: SessionId;
  provider: "codex";
  environment: string;
  attempts: number;
  /** The last bring-back of this task, or null before the first. */
  bringBack: CodexCloudBringBack | null;
}

/**
 * A Codex cloud task. `errorMessage` is Codex's own message, present exactly when
 * Codex reported the task as `error`.
 */
export type CodexCloudTask =
  | (CodexCloudTaskBase & { state: "pending" | "ready" | "applied" })
  | (CodexCloudTaskBase & { state: "error"; errorMessage: string });

/**
 * A Claude Code cloud task. Its state is `submitted` for its whole life, and `url` is
 * the cloud session's address on claude.ai.
 */
export interface ClaudeCloudTask {
  taskId: CloudTaskId;
  sessionId: SessionId;
  provider: "claude";
  state: "submitted";
  url: string;
}

/** One cloud task of a session, with only the state its provider reported. */
export type CloudTask = CodexCloudTask | ClaudeCloudTask;

const codexCloudTaskBaseShape = {
  taskId: CloudTaskIdSchema,
  sessionId: SessionIdSchema,
  provider: z.literal("codex"),
  environment: CloudEnvironmentLabelSchema,
  attempts: CloudTaskAttemptSchema,
  bringBack: CodexCloudBringBackSchema.nullable(),
};

/** Parses a {@link CloudTask}. */
export const CloudTaskSchema: z.ZodType<CloudTask> = z.union([
  z.object({ ...codexCloudTaskBaseShape, state: z.enum(["pending", "ready", "applied"]) }).strict(),
  z
    .object({
      ...codexCloudTaskBaseShape,
      state: z.literal("error"),
      errorMessage: z.string().min(1),
    })
    .strict(),
  z
    .object({
      taskId: CloudTaskIdSchema,
      sessionId: SessionIdSchema,
      provider: z.literal("claude"),
      state: z.literal("submitted"),
      url: z.url({ protocol: /^https$/ }),
    })
    .strict(),
]);

// --------------------------------------------------------------------------
// cloud.taskStart
// --------------------------------------------------------------------------

/**
 * Sends one message to the session's provider's cloud as a new task instead of to
 * the agent. `environment` and `attempts` are Codex's: the environment's label and
 * how many attempts to run.
 */
export interface CloudTaskStartRequest {
  sessionId: SessionId;
  prompt: string;
  environment?: string | undefined;
  attempts?: number | undefined;
}
/** Parses a {@link CloudTaskStartRequest}; a blank prompt and attempts outside 1 to 4 are refused. */
export const CloudTaskStartRequestSchema: z.ZodType<CloudTaskStartRequest, CloudTaskStartRequest> =
  z
    .object({
      sessionId: SessionIdSchema,
      prompt: z.string().regex(/\S/),
      environment: CloudEnvironmentLabelSchema.optional(),
      attempts: CloudTaskAttemptSchema.optional(),
    })
    .strict();

/** The new task's id. */
export interface CloudTaskStartResponse {
  taskId: CloudTaskId;
}
/** Parses a {@link CloudTaskStartResponse}. */
export const CloudTaskStartResponseSchema: z.ZodType<CloudTaskStartResponse> = z
  .object({ taskId: CloudTaskIdSchema })
  .strict();

// --------------------------------------------------------------------------
// cloud.taskList (live)
// --------------------------------------------------------------------------

/** The session whose cloud tasks a `cloud.taskList` subscription follows. */
export interface CloudTaskListRequest {
  sessionId: SessionId;
}
/** Parses a {@link CloudTaskListRequest}. */
export const CloudTaskListRequestSchema: z.ZodType<CloudTaskListRequest, CloudTaskListRequest> = z
  .object({ sessionId: SessionIdSchema })
  .strict();

/**
 * The session's whole set of cloud tasks, sent first on subscribing and again on
 * each change, so a subscriber never composes changes into a set of its own.
 */
export interface CloudTaskListFrame {
  sessionId: SessionId;
  tasks: CloudTask[];
}
/** Parses a {@link CloudTaskListFrame}. */
export const CloudTaskListFrameSchema: z.ZodType<CloudTaskListFrame> = z
  .object({ sessionId: SessionIdSchema, tasks: z.array(CloudTaskSchema) })
  .strict();

// --------------------------------------------------------------------------
// cloud.taskRead
// --------------------------------------------------------------------------

/** The task to read. */
export interface CloudTaskReadRequest {
  taskId: CloudTaskId;
}
/** Parses a {@link CloudTaskReadRequest}. */
export const CloudTaskReadRequestSchema: z.ZodType<CloudTaskReadRequest, CloudTaskReadRequest> = z
  .object({ taskId: CloudTaskIdSchema })
  .strict();

// --------------------------------------------------------------------------
// cloud.taskDiffRead
// --------------------------------------------------------------------------

/** A ready Codex task's diff; `attempt` picks one of a task's several attempts. */
export interface CloudTaskDiffReadRequest {
  taskId: CloudTaskId;
  attempt?: number | undefined;
}
/** Parses a {@link CloudTaskDiffReadRequest}; an attempt outside 1 to 4 is refused. */
export const CloudTaskDiffReadRequestSchema: z.ZodType<
  CloudTaskDiffReadRequest,
  CloudTaskDiffReadRequest
> = z.object({ taskId: CloudTaskIdSchema, attempt: CloudTaskAttemptSchema.optional() }).strict();

/** The attempt's diff as Codex prints it, for the review pane to show read-only. */
export interface CloudTaskDiffReadResponse {
  taskId: CloudTaskId;
  attempt: number;
  diff: string;
}
/** Parses a {@link CloudTaskDiffReadResponse}. */
export const CloudTaskDiffReadResponseSchema: z.ZodType<CloudTaskDiffReadResponse> = z
  .object({ taskId: CloudTaskIdSchema, attempt: CloudTaskAttemptSchema, diff: z.string() })
  .strict();

// --------------------------------------------------------------------------
// cloud.taskApply
// --------------------------------------------------------------------------

/**
 * Brings a task back. On Codex the daemon takes a file checkpoint and then applies
 * one attempt to the session's folder, `attempt` picking one of several; on Claude
 * Code it cuts a new worktree, pulls the cloud session into it and imports it as a
 * new session.
 */
export interface CloudTaskApplyRequest {
  taskId: CloudTaskId;
  attempt?: number | undefined;
}
/** Parses a {@link CloudTaskApplyRequest}; an attempt outside 1 to 4 is refused. */
export const CloudTaskApplyRequestSchema: z.ZodType<CloudTaskApplyRequest, CloudTaskApplyRequest> =
  z.object({ taskId: CloudTaskIdSchema, attempt: CloudTaskAttemptSchema.optional() }).strict();

/**
 * What bringing a task back did: on Codex, what the apply reported; on Claude Code,
 * the new session the returned work opened as.
 */
export type CloudTaskApplyResponse =
  | { provider: "codex"; bringBack: CodexCloudBringBack }
  | { provider: "claude"; sessionId: SessionId };
/** Parses a {@link CloudTaskApplyResponse}. */
export const CloudTaskApplyResponseSchema: z.ZodType<CloudTaskApplyResponse> = z.discriminatedUnion(
  "provider",
  [
    z.object({ provider: z.literal("codex"), bringBack: CodexCloudBringBackSchema }).strict(),
    z.object({ provider: z.literal("claude"), sessionId: SessionIdSchema }).strict(),
  ],
);

// --------------------------------------------------------------------------
// cloud.task_updated
// --------------------------------------------------------------------------

/**
 * A task was sent, or its provider reported a new state, or it was brought back. The
 * payload is the whole task as it now stands, so the session's record of its tasks
 * is the latest of these per task.
 */
export interface CloudTaskUpdatedPayload {
  task: CloudTask;
}
/** Parses a {@link CloudTaskUpdatedPayload}. */
export const CloudTaskUpdatedPayloadSchema: z.ZodType<CloudTaskUpdatedPayload> = z
  .object({ task: CloudTaskSchema })
  .strict();

// --------------------------------------------------------------------------
// Methods
// --------------------------------------------------------------------------

/** The `cloud.*` methods, keyed by name. */
export interface CloudMethodDescriptors {
  readonly "cloud.taskStart": MethodDescriptor<
    "cloud.taskStart",
    CloudTaskStartRequest,
    CloudTaskStartResponse
  >;
  readonly "cloud.taskList": SubscriptionMethodDescriptor<
    "cloud.taskList",
    CloudTaskListRequest,
    SubscribeAckResponse,
    CloudTaskListFrame
  >;
  readonly "cloud.taskRead": MethodDescriptor<"cloud.taskRead", CloudTaskReadRequest, CloudTask>;
  readonly "cloud.taskDiffRead": MethodDescriptor<
    "cloud.taskDiffRead",
    CloudTaskDiffReadRequest,
    CloudTaskDiffReadResponse
  >;
  readonly "cloud.taskApply": MethodDescriptor<
    "cloud.taskApply",
    CloudTaskApplyRequest,
    CloudTaskApplyResponse
  >;
}

export const CLOUD_METHOD_DESCRIPTORS: CloudMethodDescriptors = defineMethodDescriptors({
  "cloud.taskStart": {
    method: "cloud.taskStart",
    procedureType: "mutation",
    mutating: true,
    requestSchema: CloudTaskStartRequestSchema,
    responseSchema: CloudTaskStartResponseSchema,
  },
  "cloud.taskList": {
    method: "cloud.taskList",
    procedureType: "subscription",
    mutating: false,
    requestSchema: CloudTaskListRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: CloudTaskListFrameSchema,
  },
  "cloud.taskRead": {
    method: "cloud.taskRead",
    procedureType: "query",
    mutating: false,
    requestSchema: CloudTaskReadRequestSchema,
    responseSchema: CloudTaskSchema,
  },
  "cloud.taskDiffRead": {
    method: "cloud.taskDiffRead",
    procedureType: "query",
    mutating: false,
    requestSchema: CloudTaskDiffReadRequestSchema,
    responseSchema: CloudTaskDiffReadResponseSchema,
  },
  "cloud.taskApply": {
    method: "cloud.taskApply",
    procedureType: "mutation",
    mutating: true,
    requestSchema: CloudTaskApplyRequestSchema,
    responseSchema: CloudTaskApplyResponseSchema,
  },
});
