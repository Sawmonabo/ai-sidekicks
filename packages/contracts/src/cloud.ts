// A session's work in its provider's own cloud. The daemon only calls the provider's cloud
// verbs and never runs the remote work, so the work's state is only what its provider reported.
// Cloud work is one of two kinds, with the provider as data: a task with attempts, which reports
// `pending`, `ready`, `applied` or `error` (Codex's), or a cloud session, which reads no status
// and stays `submitted` (Claude Code's). The shape is split by kind so neither carries the
// other's states.
//
// Nothing imported here may reach `./event.js`, which imports the task update payload from
// this module: a cycle among eager module-scope schemas throws at load.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import { ProviderNameSchema, type ProviderName } from "./provider-account.js";
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

/** The id the provider gave its cloud work: a task's id, or a cloud session's id. */
export type CloudTaskId = string & { readonly __brand: "CloudTaskId" };
/** Parses a {@link CloudTaskId}: a non-empty string up to {@link CLOUD_TASK_ID_MAX_LEN}. */
export const CloudTaskIdSchema: z.ZodType<CloudTaskId, CloudTaskId> = z
  .string()
  .min(1)
  .max(CLOUD_TASK_ID_MAX_LEN)
  .brand<"CloudTaskId">() as unknown as z.ZodType<CloudTaskId, CloudTaskId>;

// One attempt of a cloud task, counted from 1.
const CloudTaskAttemptSchema = z.number().int().min(1).max(CLOUD_TASK_ATTEMPTS_MAX);

// The label of a Codex cloud environment, as the account's tasks name it or as typed.
const CloudEnvironmentLabelSchema = wireFreeFormString(
  CLOUD_ENVIRONMENT_LABEL_MAX_LEN,
  "Cloud environment",
);

// Refusals

/**
 * Sending to the cloud is refused because this session cannot use its provider's
 * cloud: a Codex account without a ChatGPT sign-in, a Claude Code account without a
 * claude.ai Pro, Max or Team sign-in, or a project with no GitHub remote.
 */
export const CLOUD_UNAVAILABLE_CODE = "cloud.unavailable" as const;
/**
 * Type of {@link CLOUD_UNAVAILABLE_CODE}.
 *
 * @consumedBy the handler that returns the `cloud.unavailable` error
 */
export type CloudUnavailableCode = typeof CLOUD_UNAVAILABLE_CODE;

const CLOUD_UNAVAILABLE_REASON_VALUES = [
  "provider_sign_in_required",
  "provider_subscription_required",
  "github_remote_required",
] as const;
/** Why {@link CLOUD_UNAVAILABLE_CODE} refused. */
export type CloudUnavailableReason = (typeof CLOUD_UNAVAILABLE_REASON_VALUES)[number];
/**
 * Every {@link CloudUnavailableReason}.
 *
 * @consumedBy the session menu's `Send to the cloud…` row, which shows why a session
 * cannot use it
 */
export const CLOUD_UNAVAILABLE_REASONS: readonly CloudUnavailableReason[] =
  CLOUD_UNAVAILABLE_REASON_VALUES;

/**
 * The refusal's details: why, and the session's provider, so the screen draws that provider's own
 * sentence and remedy.
 */
export interface CloudUnavailableDetails {
  reason: CloudUnavailableReason;
  provider: ProviderName;
}
/**
 * Parses {@link CloudUnavailableDetails}.
 *
 * @consumedBy the handler that returns the `cloud.unavailable` error
 */
export const CloudUnavailableDetailsSchema: z.ZodType<CloudUnavailableDetails> = z
  .object({ reason: z.enum(CLOUD_UNAVAILABLE_REASON_VALUES), provider: ProviderNameSchema })
  .strict();

// The work

/**
 * What the provider reported when a task's attempt was applied to the session's folder: all of
 * it, part of it with the paths it skipped and the paths in conflict, or an error in the
 * provider's own words.
 */
export type CloudBringBack =
  | { outcome: "applied" }
  | { outcome: "partial"; skippedPaths: string[]; conflictingPaths: string[] }
  | { outcome: "error"; message: string };
/** Parses a {@link CloudBringBack}. */
export const CloudBringBackSchema: z.ZodType<CloudBringBack> = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("applied") }).strict(),
  z
    .object({
      outcome: z.literal("partial"),
      skippedPaths: z.array(z.string().min(1).max(FILE_PATH_MAX_LEN)),
      conflictingPaths: z.array(z.string().min(1).max(FILE_PATH_MAX_LEN)),
    })
    .strict(),
  z.object({ outcome: z.literal("error"), message: z.string().min(1) }).strict(),
]);

interface CloudTaskBase {
  kind: "task";
  taskId: CloudTaskId;
  sessionId: SessionId;
  provider: ProviderName;
  environment: string;
  attempts: number;
  /** The last bring-back of this task, or null before the first. */
  bringBack: CloudBringBack | null;
}

/**
 * A cloud task with attempts. `errorMessage` is the provider's own message, present exactly when
 * the provider reported the task as `error`.
 */
export type CloudTask =
  | (CloudTaskBase & { state: "pending" | "ready" | "applied" })
  | (CloudTaskBase & { state: "error"; errorMessage: string });

/**
 * A cloud session. Its state is `submitted` for its whole life, and `url` is its address on the
 * provider's site.
 */
export interface CloudSession {
  kind: "session";
  taskId: CloudTaskId;
  sessionId: SessionId;
  provider: ProviderName;
  state: "submitted";
  url: string;
}

/** One piece of a session's cloud work, with only the state its provider reported. */
export type CloudWork = CloudTask | CloudSession;

const cloudTaskBaseShape = {
  kind: z.literal("task"),
  taskId: CloudTaskIdSchema,
  sessionId: SessionIdSchema,
  provider: ProviderNameSchema,
  environment: CloudEnvironmentLabelSchema,
  attempts: CloudTaskAttemptSchema,
  bringBack: CloudBringBackSchema.nullable(),
};

/** Parses a {@link CloudWork}. */
export const CloudWorkSchema: z.ZodType<CloudWork> = z.union([
  z.object({ ...cloudTaskBaseShape, state: z.enum(["pending", "ready", "applied"]) }).strict(),
  z
    .object({
      ...cloudTaskBaseShape,
      state: z.literal("error"),
      errorMessage: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("session"),
      taskId: CloudTaskIdSchema,
      sessionId: SessionIdSchema,
      provider: ProviderNameSchema,
      state: z.literal("submitted"),
      url: z.url({ protocol: /^https$/ }),
    })
    .strict(),
]);

// cloud.taskStart

/**
 * Sends one message to the session's provider's cloud instead of to the agent. `environment` and
 * `attempts` belong to a task with attempts: the environment's label and how many attempts to
 * run.
 */
export interface CloudTaskStartRequest {
  sessionId: SessionId;
  prompt: string;
  environment?: string | undefined;
  attempts?: number | undefined;
}
/** Parses a {@link CloudTaskStartRequest}; a blank prompt or attempts outside 1 to 4 fail. */
export const CloudTaskStartRequestSchema: z.ZodType<CloudTaskStartRequest, CloudTaskStartRequest> =
  z
    .object({
      sessionId: SessionIdSchema,
      prompt: z.string().regex(/\S/),
      environment: CloudEnvironmentLabelSchema.optional(),
      attempts: CloudTaskAttemptSchema.optional(),
    })
    .strict();

/** The new work's id. */
export interface CloudTaskStartResponse {
  taskId: CloudTaskId;
}
/** Parses a {@link CloudTaskStartResponse}. */
export const CloudTaskStartResponseSchema: z.ZodType<CloudTaskStartResponse> = z
  .object({ taskId: CloudTaskIdSchema })
  .strict();

// cloud.taskList (live)

/** The session whose cloud work a `cloud.taskList` subscription follows. */
export interface CloudTaskListRequest {
  sessionId: SessionId;
}
/** Parses a {@link CloudTaskListRequest}. */
export const CloudTaskListRequestSchema: z.ZodType<CloudTaskListRequest, CloudTaskListRequest> = z
  .object({ sessionId: SessionIdSchema })
  .strict();

/**
 * The session's whole set of cloud work, sent first on subscribing and again on each change, so a
 * subscriber never composes changes into a set of its own.
 */
export interface CloudTaskListFrame {
  sessionId: SessionId;
  tasks: CloudWork[];
}
/** Parses a {@link CloudTaskListFrame}. */
export const CloudTaskListFrameSchema: z.ZodType<CloudTaskListFrame> = z
  .object({ sessionId: SessionIdSchema, tasks: z.array(CloudWorkSchema) })
  .strict();

// cloud.taskRead

/** The cloud work to read. */
export interface CloudTaskReadRequest {
  taskId: CloudTaskId;
}
/** Parses a {@link CloudTaskReadRequest}. */
export const CloudTaskReadRequestSchema: z.ZodType<CloudTaskReadRequest, CloudTaskReadRequest> = z
  .object({ taskId: CloudTaskIdSchema })
  .strict();

// cloud.taskDiffRead

/** A ready task's diff; `attempt` picks one of a task's several attempts. */
export interface CloudTaskDiffReadRequest {
  taskId: CloudTaskId;
  attempt?: number | undefined;
}
/** Parses a {@link CloudTaskDiffReadRequest}; an attempt outside 1 to 4 is refused. */
export const CloudTaskDiffReadRequestSchema: z.ZodType<
  CloudTaskDiffReadRequest,
  CloudTaskDiffReadRequest
> = z.object({ taskId: CloudTaskIdSchema, attempt: CloudTaskAttemptSchema.optional() }).strict();

/** The attempt's diff as the provider prints it, for the review pane to show read-only. */
export interface CloudTaskDiffReadResponse {
  taskId: CloudTaskId;
  attempt: number;
  diff: string;
}
/** Parses a {@link CloudTaskDiffReadResponse}. */
export const CloudTaskDiffReadResponseSchema: z.ZodType<CloudTaskDiffReadResponse> = z
  .object({ taskId: CloudTaskIdSchema, attempt: CloudTaskAttemptSchema, diff: z.string() })
  .strict();

// cloud.taskApply

/**
 * Brings cloud work back. For a task the daemon takes a file checkpoint and then applies one
 * attempt to the session's folder, `attempt` picking one of several; for a cloud session it cuts a
 * new worktree, pulls the cloud session into it and imports it as a new session.
 */
export interface CloudTaskApplyRequest {
  taskId: CloudTaskId;
  attempt?: number | undefined;
}
/** Parses a {@link CloudTaskApplyRequest}; an attempt outside 1 to 4 is refused. */
export const CloudTaskApplyRequestSchema: z.ZodType<CloudTaskApplyRequest, CloudTaskApplyRequest> =
  z.object({ taskId: CloudTaskIdSchema, attempt: CloudTaskAttemptSchema.optional() }).strict();

/**
 * What bringing cloud work back did: for a task, what the apply reported; for a cloud session,
 * the new session the returned work opened as.
 */
export type CloudTaskApplyResponse =
  | { kind: "task"; bringBack: CloudBringBack }
  | { kind: "session"; sessionId: SessionId };
/** Parses a {@link CloudTaskApplyResponse}. */
export const CloudTaskApplyResponseSchema: z.ZodType<CloudTaskApplyResponse> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("task"), bringBack: CloudBringBackSchema }).strict(),
    z.object({ kind: z.literal("session"), sessionId: SessionIdSchema }).strict(),
  ],
);

// cloud.task_updated

/**
 * Cloud work was sent, or its provider reported a new state, or it was brought back. The payload
 * is the whole work as it now stands, so the session's record of its cloud work is the latest of
 * these per id.
 */
export interface CloudTaskUpdatedPayload {
  task: CloudWork;
}
/** Parses a {@link CloudTaskUpdatedPayload}. */
export const CloudTaskUpdatedPayloadSchema: z.ZodType<CloudTaskUpdatedPayload> = z
  .object({ task: CloudWorkSchema })
  .strict();

// Methods

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
  readonly "cloud.taskRead": MethodDescriptor<"cloud.taskRead", CloudTaskReadRequest, CloudWork>;
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

/**
 * The `cloud.*` methods' names, procedure types and shapes.
 *
 * @consumedBy the daemon's `cloud.*` handlers
 */
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
    responseSchema: CloudWorkSchema,
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
