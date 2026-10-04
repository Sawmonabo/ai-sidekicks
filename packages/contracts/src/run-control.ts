// Run-control contracts: interventions on a running run, pause and resume, the recovery question
// after a restart, the run state stream, the run read, and the `run.*` method table, which also
// serves the queue (`run-queue.ts`), a child's own controls (`run-children.ts`) and the provider's
// choices a run waits on (`run-provider-choice.ts`).
//
// Imports go downward only: the modules imported here build their Zod schemas at module scope, so
// a back-import would throw at import time instead of failing to compile.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import { countSchema, isoDateTimeSchema } from "./internal/wire-scalars.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import {
  ArtifactIdSchema,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  InterventionTypeSchema,
  RunIdSchema,
  type ArtifactId,
  type ExecutionPosture,
  type InterventionType,
  type RunId,
} from "./provider-driver.js";
import {
  DRIVER_WIRE_HANDLE_MAX_LEN,
  DRIVER_WIRE_REASON_MAX_LEN,
  DRIVER_WIRE_TOKEN_MAX_LEN,
} from "./provider-driver-wire.js";
import { RecoveryConditionSchema, type RecoveryCondition } from "./provider-driver-recovery.js";
import {
  ChildInterruptRequestSchema,
  ChildInterruptResponseSchema,
  ChildPauseSetRequestSchema,
  ChildPauseSetResponseSchema,
  ChildrenStopRequestSchema,
  ChildrenStopResponseSchema,
  ChildSteerRequestSchema,
  type ChildInterruptRequest,
  type ChildInterruptResponse,
  type ChildPauseSetRequest,
  type ChildPauseSetResponse,
  type ChildrenStopRequest,
  type ChildrenStopResponse,
  type ChildSteerRequest,
} from "./run-children.js";
import {
  QueueItemCancelRequestSchema,
  QueueItemCancelResponseSchema,
  QueueItemCreateRequestSchema,
  QueueItemCreateResponseSchema,
  QueueItemIdSchema,
  QueueItemListRequestSchema,
  QueueItemListResponseSchema,
  QueueItemSummarySchema,
  QueueReorderRequestSchema,
  RunQueueSubscribeRequestSchema,
  type QueueItemCancelRequest,
  type QueueItemCancelResponse,
  type QueueItemCreateRequest,
  type QueueItemCreateResponse,
  type QueueItemId,
  type QueueItemListRequest,
  type QueueItemListResponse,
  type QueueItemSummary,
  type QueueReorderRequest,
  type RunQueueSubscribeRequest,
} from "./run-queue.js";
import {
  RunRefusalChoiceResolveRequestSchema,
  RunUsageCreditsChoiceResolveRequestSchema,
  type RunRefusalChoiceResolveRequest,
  type RunUsageCreditsChoiceResolveRequest,
} from "./run-provider-choice.js";
import { RunStateSchema, type RunState } from "./run-state.js";
import {
  PermissionLevelSchema,
  RunSafetyBufferingUpdatedPayloadSchema,
  type RunSafetyBufferingUpdatedPayload,
} from "./session-controls.js";
import {
  FILE_PATH_MAX_LEN,
  SessionIdSchema,
  wireFreeFormString,
  wireUncappedFreeFormString,
  type SessionId,
} from "./session.js";

/** Identifies one intervention on a run. */
export type InterventionId = string & { readonly __brand: "InterventionId" };
/** Parses an {@link InterventionId}. */
export const InterventionIdSchema: z.ZodType<InterventionId, InterventionId> =
  brandedUuidIdSchema<InterventionId>("InterventionId");

/** Where an intervention stands, from request to outcome. */
export type InterventionState =
  | "requested"
  | "accepted"
  | "applied"
  | "rejected"
  | "degraded"
  | "expired";
/** Parses an {@link InterventionState}. */
export const InterventionStateSchema: z.ZodType<InterventionState, InterventionState> = z.enum([
  "requested",
  "accepted",
  "applied",
  "rejected",
  "degraded",
  "expired",
]);

/** Why a run failed. The values carry spaces because they are wire literals, not identifiers. */
export type RunFailureCategory =
  | "provider failure"
  | "transport failure"
  | "local persistence failure"
  | "projection failure";
/** Parses a {@link RunFailureCategory}. */
export const RunFailureCategorySchema: z.ZodType<RunFailureCategory, RunFailureCategory> = z.enum([
  "provider failure",
  "transport failure",
  "local persistence failure",
  "projection failure",
]);

// A `writableRoots` entry. Not `wireFreeFormString`: a directory named with a single space is
// legal, while NUL is in no filesystem's paths.
const filesystemPathSchema: z.ZodString = z
  .string()
  .min(1)
  .max(FILE_PATH_MAX_LEN)
  .refine((value) => !value.includes("\0"), {
    message: "Filesystem path MUST NOT contain a NUL byte.",
  });

// `expectedRunVersion` is the mandatory optimistic-concurrency comparand: an absent one is
// refused, never applied. `clientIdempotencyKey` is stored with the intervention under
// `UNIQUE(target_run_id, client_idempotency_key)`, so an identical retry replays the recorded
// outcome.

/**
 * A caller's request to steer, interrupt, cancel or retry a run, one arm per intervention type.
 * An interrupt's `pending` sends the waiting messages as the next turn or returns them to the
 * draft, and `deliverFirst` names the message `Send now` puts ahead of the rest.
 * `faster_model_retry` resends a turn Codex holds for a safety check on `model`.
 */
export type InterventionRequestPayload =
  | {
      type: "steer";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      content: string;
      attachments?: ArtifactId[] | undefined;
      expectedTurnId?: string | undefined;
    }
  | {
      type: "interrupt";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      pending: "nextTurn" | "returnToDraft";
      deliverFirst?: QueueItemId | undefined;
      reason?: string | undefined;
    }
  | {
      type: "cancel";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      reason?: string | undefined;
    }
  | {
      type: "faster_model_retry";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      expectedTurnId: string;
      model: string;
    };

/** Parses an {@link InterventionRequestPayload}; `deliverFirst` requires `pending: "nextTurn"`. */
export const InterventionRequestPayloadSchema: z.ZodType<
  InterventionRequestPayload,
  InterventionRequestPayload
> = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("steer"),
        targetRunId: RunIdSchema,
        expectedRunVersion: countSchema,
        clientIdempotencyKey: z.uuid(),
        content: wireUncappedFreeFormString("InterventionRequestPayload.content"),
        attachments: z.array(ArtifactIdSchema).optional(),
        expectedTurnId: wireFreeFormString(
          DRIVER_WIRE_HANDLE_MAX_LEN,
          "InterventionRequestPayload.expectedTurnId",
        ).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("interrupt"),
        targetRunId: RunIdSchema,
        expectedRunVersion: countSchema,
        clientIdempotencyKey: z.uuid(),
        pending: z.enum(["nextTurn", "returnToDraft"]),
        deliverFirst: QueueItemIdSchema.optional(),
        reason: wireFreeFormString(
          DRIVER_WIRE_REASON_MAX_LEN,
          "InterventionRequestPayload.reason",
        ).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("cancel"),
        targetRunId: RunIdSchema,
        expectedRunVersion: countSchema,
        clientIdempotencyKey: z.uuid(),
        reason: wireFreeFormString(
          DRIVER_WIRE_REASON_MAX_LEN,
          "InterventionRequestPayload.reason",
        ).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("faster_model_retry"),
        targetRunId: RunIdSchema,
        expectedRunVersion: countSchema,
        clientIdempotencyKey: z.uuid(),
        expectedTurnId: wireFreeFormString(
          DRIVER_WIRE_HANDLE_MAX_LEN,
          "InterventionRequestPayload.expectedTurnId",
        ),
        model: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "InterventionRequestPayload.model"),
      })
      .strict(),
  ])
  .refine(
    (request) =>
      request.type !== "interrupt" ||
      request.deliverFirst === undefined ||
      request.pending === "nextTurn",
    {
      path: ["deliverFirst"],
      message: "A message delivered first goes as the next turn, never back to the draft.",
    },
  );

/**
 * The common part of the daemon's answer to an intervention. A refused intervention is a normal
 * response with state `rejected` and a machine-readable `rejectionReason`, not a JSON-RPC error.
 */
export interface InterventionResponseBase {
  interventionId: InterventionId;
  state: InterventionState;
  // The run version after the intervention, for the caller's next `expectedRunVersion`. An
  // applied steer advances it with no state change, so this is the only place to read it.
  runVersion: number;
  rejectionReason?: string | undefined;
}

/** The daemon's answer to an intervention request: its state, the run version, any result. */
export type InterventionRequestResponse = InterventionResponseBase & {
  interventionType: InterventionType;
  result?: Record<string, unknown> | undefined;
};

/** Parses an {@link InterventionRequestResponse}; closed to unknown keys. */
export const InterventionRequestResponseSchema: z.ZodType<InterventionRequestResponse> = z
  .object({
    interventionId: InterventionIdSchema,
    runVersion: countSchema,
    rejectionReason: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "InterventionResponseBase.rejectionReason",
    ).optional(),
    interventionType: InterventionTypeSchema,
    state: InterventionStateSchema,
    result: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const executionPostureSchema: z.ZodType<ExecutionPosture> = z
  .object({
    mode: PermissionLevelSchema,
    writableRoots: z.array(filesystemPathSchema),
    profileName: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "ExecutionPosture.profileName",
    ).optional(),
    credentialPolicyRef: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "ExecutionPosture.credentialPolicyRef",
    ),
  })
  .strict();

/**
 * A turn the provider's safety check refused with no other model to take it, on
 * `run.failed`: the refusing model, and the provider's own sentence, explanation
 * and check category when it sends them.
 */
export interface RunRefusedCause {
  cause: "refused";
  model: string;
  sentence?: string | undefined;
  explanation?: string | undefined;
  safetyCategory?: string | undefined;
}
const RunRefusedCauseSchema: z.ZodType<RunRefusedCause> = z
  .object({
    cause: z.literal("refused"),
    model: wireFreeFormString(DRIVER_WIRE_HANDLE_MAX_LEN, "RunRefusedCause.model"),
    sentence: wireFreeFormString(
      DRIVER_FAILURE_DETAIL_MAX_LEN,
      "RunRefusedCause.sentence",
    ).optional(),
    explanation: wireFreeFormString(
      DRIVER_FAILURE_DETAIL_MAX_LEN,
      "RunRefusedCause.explanation",
    ).optional(),
    safetyCategory: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "RunRefusedCause.safetyCategory",
    ).optional(),
  })
  .strict();

/**
 * One run state transition as `run.subscribeState` delivers it, with its new run version.
 * `sessionId` is carried by the subscription's scope, not repeated per event.
 */
export interface RunStateChangeEvent {
  runId: RunId;
  // The comparand clients pass back as `expectedRunVersion`.
  runVersion: number;
  previousState: RunState;
  newState: RunState;
  failureCategory?: RunFailureCategory | undefined;
  failureCause?: RunRefusedCause | undefined;
  recoveryCondition?: RecoveryCondition | undefined;
  // Two producers, one field: free-form prose on a failed resume, and a fixed
  // `<registered code> origin=<arm>` form from the outbound-frame neutralization tripwire. Read
  // the cause as the substring before the first space; the whole value is not always prose.
  providerFailureDetail?: string | undefined;
  completionKind?: "turn" | "task" | undefined;
  // Present only on a terminal the daemon itself closed; such a terminal is never a crash.
  intendedClose?: true | undefined;
  // Stamped only on `run.running`, where the workspace root and effective posture are final.
  executionPosture?: ExecutionPosture | undefined;
  // Why the daemon stopped the run: one of the limits the person set, or its workflow phase
  // was canceled.
  trigger?: "step_limit" | "spend_limit" | "token_limit" | "workflow_phase_canceled" | undefined;
  timestamp: string;
}

/** Parses a {@link RunStateChangeEvent}; a failure cause rides only a transition into `failed`. */
export const RunStateChangeEventSchema: z.ZodType<RunStateChangeEvent> = z
  .object({
    runId: RunIdSchema,
    runVersion: countSchema,
    previousState: RunStateSchema,
    newState: RunStateSchema,
    failureCategory: RunFailureCategorySchema.optional(),
    failureCause: RunRefusedCauseSchema.optional(),
    recoveryCondition: RecoveryConditionSchema.optional(),
    providerFailureDetail: wireFreeFormString(
      DRIVER_FAILURE_DETAIL_MAX_LEN,
      "RunStateChangeEvent.providerFailureDetail",
    ).optional(),
    completionKind: z.enum(["turn", "task"]).optional(),
    intendedClose: z.literal(true).optional(),
    executionPosture: executionPostureSchema.optional(),
    trigger: z
      .enum(["step_limit", "spend_limit", "token_limit", "workflow_phase_canceled"])
      .optional(),
    timestamp: isoDateTimeSchema,
  })
  .strict()
  .refine((event) => event.failureCause === undefined || event.newState === "failed", {
    path: ["failureCause"],
    message: "A failure cause rides only a transition into `failed`.",
  });

/**
 * A run rewound to an earlier turn boundary, carried on `run.subscribeState`. It is not a state
 * transition, so it has no `previousState` or `newState`; inventing one would corrupt the stream
 * consumers replay. It carries no tag: `.strict()` keeps it apart from the state change. It is
 * also the stored `run.rolled_back` payload, hence `sessionId`.
 */
export interface RunRolledBackEvent {
  sessionId: SessionId;
  runId: RunId;
  // The run version after the rollback advanced it.
  runVersion: number;
  // The turn boundary the run landed at, as a session position: the request's target, or the
  // landing the driver confirmed when that differs.
  targetPosition: number;
}

/** Parses a {@link RunRolledBackEvent}. */
export const RunRolledBackEventSchema: z.ZodType<RunRolledBackEvent> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    runVersion: countSchema,
    targetPosition: countSchema,
  })
  .strict();

/**
 * One delivery on `run.subscribeState`: a state change, a rollback, or Codex's safety hold on the
 * run's turn. The hold is a live detail carried only by this stream, never written to the
 * session's history, so a re-opened session does not replay it. None carries a tag; `.strict()`
 * on all three keeps them apart.
 */
export type RunStateStreamEvent =
  | RunStateChangeEvent
  | RunRolledBackEvent
  | RunSafetyBufferingUpdatedPayload;
const RunStateStreamEventSchema: z.ZodType<RunStateStreamEvent> = z.union([
  RunStateChangeEventSchema,
  RunRolledBackEventSchema,
  RunSafetyBufferingUpdatedPayloadSchema,
]);

/** Pauses a run. Not an intervention, but guarded by the same mandatory `expectedRunVersion`. */
export interface RunPauseRequest {
  targetRunId: RunId;
  expectedRunVersion: number;
}
/** Parses a {@link RunPauseRequest}. */
export const RunPauseRequestSchema: z.ZodType<RunPauseRequest, RunPauseRequest> = z
  .object({
    targetRunId: RunIdSchema,
    expectedRunVersion: countSchema,
  })
  .strict();

/** Resumes a paused run, guarded by the same mandatory `expectedRunVersion`. */
export interface RunResumeRequest {
  targetRunId: RunId;
  expectedRunVersion: number;
}
/** Parses a {@link RunResumeRequest}. */
export const RunResumeRequestSchema: z.ZodType<RunResumeRequest, RunResumeRequest> = z
  .object({
    targetRunId: RunIdSchema,
    expectedRunVersion: countSchema,
  })
  .strict();

/**
 * The run's state after a run-control call and its advanced `runVersion`, so the caller can
 * guard its next request without reading `run.subscribeState`.
 */
export interface RunControlAck {
  runId: RunId;
  newState: RunState;
  runVersion: number;
}
/** Parses a {@link RunControlAck}. */
export const RunControlAckSchema: z.ZodType<RunControlAck> = z
  .object({
    runId: RunIdSchema,
    newState: RunStateSchema,
    runVersion: countSchema,
  })
  .strict();

/**
 * The person's answer when a resumed conversation and the service's record disagree. Provider
 * ahead: `keep_provider` keeps what it did, `undo_to_agreed` cuts back to where both agree.
 * Service ahead: `continue_provider` goes on from the provider's record, `hand_over` starts a new
 * conversation with the hand-over brief.
 */
export type RunRecoveryChoice =
  | "keep_provider"
  | "undo_to_agreed"
  | "continue_provider"
  | "hand_over";
const RunRecoveryChoiceSchema: z.ZodType<RunRecoveryChoice, RunRecoveryChoice> = z.enum([
  "keep_provider",
  "undo_to_agreed",
  "continue_provider",
  "hand_over",
]);

/** Answers the recovery question a restart left a run halted on (`run.recoveryResolve`). */
export interface RunRecoveryResolveRequest {
  runId: RunId;
  choice: RunRecoveryChoice;
}
/** Parses a {@link RunRecoveryResolveRequest}. */
export const RunRecoveryResolveRequestSchema: z.ZodType<
  RunRecoveryResolveRequest,
  RunRecoveryResolveRequest
> = z.object({ runId: RunIdSchema, choice: RunRecoveryChoiceSchema }).strict();

/** The payload of `run.recovery_resolved`: which choice settled the question. */
export interface RunRecoveryResolvedPayload {
  sessionId: SessionId;
  runId: RunId;
  choice: RunRecoveryChoice;
}
/** Parses a {@link RunRecoveryResolvedPayload}. */
export const RunRecoveryResolvedPayloadSchema: z.ZodType<RunRecoveryResolvedPayload> = z
  .object({ sessionId: SessionIdSchema, runId: RunIdSchema, choice: RunRecoveryChoiceSchema })
  .strict();

/**
 * Opens a session's run state stream: every run in the session, the lead and each child, which
 * the caller fans out by `runId`. Session-scoped, with no replay cursor.
 */
export interface RunStateSubscribeRequest {
  sessionId: SessionId;
}
/** Parses a {@link RunStateSubscribeRequest}. */
export const RunStateSubscribeRequestSchema: z.ZodType<
  RunStateSubscribeRequest,
  RunStateSubscribeRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

/**
 * The code of a move the run's current state does not allow, such as a second or late answer to a
 * choice the run already settled.
 */
export const RUN_INVALID_TRANSITION_CODE = "run.invalid_transition" as const;
/**
 * The type of {@link RUN_INVALID_TRANSITION_CODE}.
 *
 * @consumedBy the handler that returns the `run.invalid_transition` error
 */
export type RunInvalidTransitionCode = typeof RUN_INVALID_TRANSITION_CODE;

/** The run-control methods, keyed by method name. */
export interface RunControlMethodDescriptors {
  readonly "run.queueCreate": MethodDescriptor<
    "run.queueCreate",
    QueueItemCreateRequest,
    QueueItemCreateResponse
  >;
  readonly "run.queueList": MethodDescriptor<
    "run.queueList",
    QueueItemListRequest,
    QueueItemListResponse
  >;
  readonly "run.queueCancel": MethodDescriptor<
    "run.queueCancel",
    QueueItemCancelRequest,
    QueueItemCancelResponse
  >;
  readonly "run.queueReorder": MethodDescriptor<
    "run.queueReorder",
    QueueReorderRequest,
    QueueItemListResponse
  >;
  readonly "run.subscribeQueue": SubscriptionMethodDescriptor<
    "run.subscribeQueue",
    RunQueueSubscribeRequest,
    SubscribeAckResponse,
    QueueItemSummary
  >;
  readonly "run.intervene": MethodDescriptor<
    "run.intervene",
    InterventionRequestPayload,
    InterventionRequestResponse
  >;
  readonly "run.pause": MethodDescriptor<"run.pause", RunPauseRequest, RunControlAck>;
  readonly "run.resume": MethodDescriptor<"run.resume", RunResumeRequest, RunControlAck>;
  readonly "run.subscribeState": SubscriptionMethodDescriptor<
    "run.subscribeState",
    RunStateSubscribeRequest,
    SubscribeAckResponse,
    RunStateStreamEvent
  >;
  readonly "run.childSteer": MethodDescriptor<
    "run.childSteer",
    ChildSteerRequest,
    QueueItemCreateResponse
  >;
  readonly "run.childInterrupt": MethodDescriptor<
    "run.childInterrupt",
    ChildInterruptRequest,
    ChildInterruptResponse
  >;
  readonly "run.childPauseSet": MethodDescriptor<
    "run.childPauseSet",
    ChildPauseSetRequest,
    ChildPauseSetResponse
  >;
  readonly "run.childrenStop": MethodDescriptor<
    "run.childrenStop",
    ChildrenStopRequest,
    ChildrenStopResponse
  >;
  readonly "run.recoveryResolve": MethodDescriptor<
    "run.recoveryResolve",
    RunRecoveryResolveRequest,
    RunControlAck
  >;
  readonly "run.refusalChoiceResolve": MethodDescriptor<
    "run.refusalChoiceResolve",
    RunRefusalChoiceResolveRequest,
    RunControlAck
  >;
  readonly "run.usageCreditsChoiceResolve": MethodDescriptor<
    "run.usageCreditsChoiceResolve",
    RunUsageCreditsChoiceResolveRequest,
    RunControlAck
  >;
}

/** The run-control methods, each with its schemas. */
export const RUN_CONTROL_METHOD_DESCRIPTORS: RunControlMethodDescriptors = defineMethodDescriptors({
  "run.queueCreate": {
    method: "run.queueCreate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: QueueItemCreateRequestSchema,
    responseSchema: QueueItemCreateResponseSchema,
  },
  "run.queueList": {
    method: "run.queueList",
    procedureType: "query",
    mutating: false,
    requestSchema: QueueItemListRequestSchema,
    responseSchema: QueueItemListResponseSchema,
  },
  "run.queueCancel": {
    method: "run.queueCancel",
    procedureType: "mutation",
    mutating: true,
    requestSchema: QueueItemCancelRequestSchema,
    responseSchema: QueueItemCancelResponseSchema,
  },
  "run.queueReorder": {
    method: "run.queueReorder",
    procedureType: "mutation",
    mutating: true,
    requestSchema: QueueReorderRequestSchema,
    responseSchema: QueueItemListResponseSchema,
  },
  "run.subscribeQueue": {
    method: "run.subscribeQueue",
    procedureType: "subscription",
    mutating: false,
    requestSchema: RunQueueSubscribeRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: QueueItemSummarySchema,
  },
  "run.intervene": {
    method: "run.intervene",
    procedureType: "mutation",
    mutating: true,
    requestSchema: InterventionRequestPayloadSchema,
    responseSchema: InterventionRequestResponseSchema,
  },
  "run.pause": {
    method: "run.pause",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RunPauseRequestSchema,
    responseSchema: RunControlAckSchema,
  },
  "run.resume": {
    method: "run.resume",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RunResumeRequestSchema,
    responseSchema: RunControlAckSchema,
  },
  "run.subscribeState": {
    method: "run.subscribeState",
    procedureType: "subscription",
    mutating: false,
    requestSchema: RunStateSubscribeRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: RunStateStreamEventSchema,
  },
  "run.childSteer": {
    method: "run.childSteer",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ChildSteerRequestSchema,
    responseSchema: QueueItemCreateResponseSchema,
  },
  "run.childInterrupt": {
    method: "run.childInterrupt",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ChildInterruptRequestSchema,
    responseSchema: ChildInterruptResponseSchema,
  },
  "run.childPauseSet": {
    method: "run.childPauseSet",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ChildPauseSetRequestSchema,
    responseSchema: ChildPauseSetResponseSchema,
  },
  "run.childrenStop": {
    method: "run.childrenStop",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ChildrenStopRequestSchema,
    responseSchema: ChildrenStopResponseSchema,
  },
  "run.recoveryResolve": {
    method: "run.recoveryResolve",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RunRecoveryResolveRequestSchema,
    responseSchema: RunControlAckSchema,
  },
  "run.refusalChoiceResolve": {
    method: "run.refusalChoiceResolve",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RunRefusalChoiceResolveRequestSchema,
    responseSchema: RunControlAckSchema,
  },
  "run.usageCreditsChoiceResolve": {
    method: "run.usageCreditsChoiceResolve",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RunUsageCreditsChoiceResolveRequestSchema,
    responseSchema: RunControlAckSchema,
  },
});
