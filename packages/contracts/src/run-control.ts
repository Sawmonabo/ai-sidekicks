// Run-control contracts: interventions on a running run, pause and resume, the
// recovery question after a restart, the run state stream, the run read, and the
// `run.*` method table, which also serves the queue (`run-queue.ts`) and a child's
// own controls (`run-children.ts`).
//
// This module owns the branded `InterventionId` and two closed sets every other
// module imports from here rather than restating: `RunFailureCategory` and
// `InterventionState`. `RunState` is in `./run-state.js`, below the run modules.
//
// It imports downward only. The shapes below compose `./provider-driver.js`,
// `./run-children.js`, `./run-queue.js`, `./run-state.js`,
// `./session-controls.js` and `./session.js`, each an eager module-scope Zod
// initializer, so a back-import from any of them would throw `ReferenceError` at
// import time rather than fail to compile. The same reason keeps the message
// bounds (`DRIVER_WIRE_STEER_*`) in `./provider-driver.js`: its `SteerPayload`
// applies them and cannot import from here.
//
// Request schemas use the double-T `z.ZodType<T, T>` form and response and
// event schemas the single-T `z.ZodType<T>` form, matching `session.ts`: only
// request schemas reach tRPC's Standard Schema V1 input inference.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import { countSchema } from "./internal/wire-scalars.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import {
  ArtifactIdSchema,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DRIVER_WIRE_HANDLE_MAX_LEN,
  DRIVER_WIRE_REASON_MAX_LEN,
  DRIVER_WIRE_STEER_ATTACHMENTS_MAX,
  DRIVER_WIRE_STEER_CONTENT_MAX_LEN,
  DRIVER_WIRE_TOKEN_MAX_LEN,
  InterventionTypeSchema,
  RecoveryConditionSchema,
  RecoverySpanClassificationSchema,
  RunIdSchema,
  type ArtifactId,
  type ExecutionPosture,
  type InterventionType,
  type RecoveryCondition,
  type RecoverySpanClassification,
  type RunId,
} from "./provider-driver.js";
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
import { RunStateSchema, type RunState } from "./run-state.js";
import {
  RunSafetyBufferingUpdatedPayloadSchema,
  type RunSafetyBufferingUpdatedPayload,
} from "./session-controls.js";
import {
  FILE_PATH_MAX_LEN,
  SessionIdSchema,
  wireFreeFormString,
  type SessionId,
} from "./session.js";

// --------------------------------------------------------------------------
// Branded identifiers
// --------------------------------------------------------------------------

export type InterventionId = string & { readonly __brand: "InterventionId" };
export const InterventionIdSchema: z.ZodType<InterventionId, InterventionId> =
  brandedUuidIdSchema<InterventionId>("InterventionId");

// --------------------------------------------------------------------------
// Closed sets
// --------------------------------------------------------------------------
//
// `RunFailureCategory`'s values carry a space by design: they are the wire
// literals, not identifiers.
//
// Both are typed double-T (`z.ZodType<T, T>`), as `QueueItemState` is: a
// set that composes into a request schema loses Standard Schema V1 input
// inference the moment its input degrades to `unknown` (see
// `./internal/branded.ts`), and the sets stay alike.

export type InterventionState =
  | "requested"
  | "accepted"
  | "applied"
  | "rejected"
  | "degraded"
  | "expired";
export const InterventionStateSchema: z.ZodType<InterventionState, InterventionState> = z.enum([
  "requested",
  "accepted",
  "applied",
  "rejected",
  "degraded",
  "expired",
]);

export type RunFailureCategory =
  | "provider failure"
  | "transport failure"
  | "local persistence failure"
  | "projection failure";
export const RunFailureCategorySchema: z.ZodType<RunFailureCategory, RunFailureCategory> = z.enum([
  "provider failure",
  "transport failure",
  "local persistence failure",
  "projection failure",
]);

// --------------------------------------------------------------------------
// Shared field parsers
// --------------------------------------------------------------------------

// Filesystem path entries: the execution posture's `writableRoots`. Not
// `wireFreeFormString`, which refuses whitespace-only values although a
// directory named with a single space is legal on POSIX; NUL is refused because
// no filesystem admits it in a path.
const filesystemPathSchema: z.ZodString = z
  .string()
  .min(1)
  .max(FILE_PATH_MAX_LEN)
  .refine((value) => !value.includes("\0"), {
    message: "Filesystem path MUST NOT contain a NUL byte.",
  });

// --------------------------------------------------------------------------
// Interventions on the lead's run
// --------------------------------------------------------------------------
//
// `expectedRunVersion` is the MANDATORY optimistic-concurrency comparand: an
// absent comparand is refused, never applied. `clientIdempotencyKey` is the
// second guard: a requester-generated UUID stored on the intervention under
// `UNIQUE(target_run_id, client_idempotency_key)`, so an identical retry replays
// the recorded outcome.
//
// The interrupt's `pending` says what happens to the messages still waiting:
// `nextTurn` sends them at once as the next turn (the lead's own interrupt), and
// `returnToDraft` drops them back into the draft (interrupting everything).
// `deliverFirst` names the waiting message `Send now` delivers ahead of the rest.
//
// The faster-model retry is the person's `Stop and retry` while Codex holds a turn
// for a safety check and names a faster model: the daemon stops that turn and
// sends the same message again on `model`, which then stays the session's model.
// `expectedTurnId` is required on it, so a retry aimed at a turn that is no longer
// the latest, or whose reply has started, is refused as `rejected` with a
// `rejectionReason`.

/** A caller's request to steer, interrupt, cancel or retry a run, one arm per intervention type. */
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
        content: wireFreeFormString(
          DRIVER_WIRE_STEER_CONTENT_MAX_LEN,
          "InterventionRequestPayload.content",
        ),
        attachments: z.array(ArtifactIdSchema).max(DRIVER_WIRE_STEER_ATTACHMENTS_MAX).optional(),
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

// The daemon's answer to an intervention. A refused intervention is a normal
// response with state `rejected` and a machine-readable cause in
// `rejectionReason`, not a JSON-RPC error.

export interface InterventionResponseBase {
  interventionId: InterventionId;
  state: InterventionState;
  // The run counter after the intervention, which the caller threads into its
  // next `expectedRunVersion`. An applied steer advances the run version with no
  // state change, so on that path this is the only place the fresh comparand can
  // be read.
  runVersion: number;
  rejectionReason?: string | undefined;
}

/** The daemon's answer to an intervention request: its state, the run version, any result. */
export type InterventionRequestResponse = InterventionResponseBase & {
  interventionType: InterventionType;
  result?: Record<string, unknown> | undefined;
};

/** Validates an {@link InterventionRequestResponse}; closed to unknown keys. */
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

// --------------------------------------------------------------------------
// The run state stream
// --------------------------------------------------------------------------
//
// `ExecutionPosture` keeps a module-private parser. Its `z.ZodType<ExecutionPosture>`
// annotation fails the build if that type narrows, though a widening still
// compiles, because `ZodType` is covariant in its output.

// `allowedDomains` is `[string, ...string[]]`, so the parser produces a non-empty
// tuple: Zod v4's `.nonempty()` checks the length but leaves the inferred type
// `string[]`, which the annotation below refuses.
const allowedDomainsSchema: z.ZodType<[string, ...string[]], [string, ...string[]]> = z.tuple(
  [wireFreeFormString(DRIVER_WIRE_HANDLE_MAX_LEN, "ExecutionPosture.allowedDomains")],
  wireFreeFormString(DRIVER_WIRE_HANDLE_MAX_LEN, "ExecutionPosture.allowedDomains"),
);

const executionPostureSchema: z.ZodType<ExecutionPosture> = z.union([
  z
    .object({
      networkAccess: z.enum(["none", "full"]),
      writableRoots: z.array(filesystemPathSchema),
      profileName: wireFreeFormString(
        DRIVER_WIRE_HANDLE_MAX_LEN,
        "ExecutionPosture.profileName",
      ).optional(),
      mode: z.literal("trusted"),
    })
    .strict(),
  z
    .object({
      networkAccess: z.enum(["none", "full"]),
      writableRoots: z.array(filesystemPathSchema),
      profileName: wireFreeFormString(
        DRIVER_WIRE_HANDLE_MAX_LEN,
        "ExecutionPosture.profileName",
      ).optional(),
      mode: z.enum(["workspace-sandboxed", "readonly-sandboxed"]),
      credentialPolicyRef: wireFreeFormString(
        DRIVER_WIRE_HANDLE_MAX_LEN,
        "ExecutionPosture.credentialPolicyRef",
      ),
    })
    .strict(),
  z
    .object({
      networkAccess: z.literal("allowed-domains"),
      allowedDomains: allowedDomainsSchema,
      writableRoots: z.array(filesystemPathSchema),
      profileName: wireFreeFormString(
        DRIVER_WIRE_HANDLE_MAX_LEN,
        "ExecutionPosture.profileName",
      ).optional(),
      mode: z.literal("trusted"),
    })
    .strict(),
  z
    .object({
      networkAccess: z.literal("allowed-domains"),
      allowedDomains: allowedDomainsSchema,
      writableRoots: z.array(filesystemPathSchema),
      profileName: wireFreeFormString(
        DRIVER_WIRE_HANDLE_MAX_LEN,
        "ExecutionPosture.profileName",
      ).optional(),
      mode: z.enum(["workspace-sandboxed", "readonly-sandboxed"]),
      credentialPolicyRef: wireFreeFormString(
        DRIVER_WIRE_HANDLE_MAX_LEN,
        "ExecutionPosture.credentialPolicyRef",
      ),
    })
    .strict(),
]);

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

// The subscription server projects the stored row into this shape. `sessionId`
// is carried by the subscription's scope (`RunStateSubscribeRequest`), not
// repeated per event; `newState` is the stored row's own spelling.
/** One run state transition as `run.subscribeState` delivers it, with its new run version. */
export interface RunStateChangeEvent {
  runId: RunId;
  // The run's progression counter: the comparand clients read here and pass back
  // as `expectedRunVersion`.
  runVersion: number;
  previousState: RunState;
  newState: RunState;
  failureCategory?: RunFailureCategory | undefined;
  failureCause?: RunRefusedCause | undefined;
  recoveryCondition?: RecoveryCondition | undefined;
  recoverySpanClassification?: RecoverySpanClassification | undefined;
  // Two producers, one field: free-form prose from the resume-failure producer,
  // and one fixed `<registered code> origin=<arm>` form from the outbound-frame
  // neutralization tripwire. A consumer reads the cause as the substring before
  // the first space and never assumes the whole value is prose.
  providerFailureDetail?: string | undefined;
  completionKind?: "turn" | "task" | undefined;
  // Present only on a terminal the daemon itself closed; such a terminal is never
  // a crash.
  intendedClose?: true | undefined;
  // Stamped only on `run.running`, where the resolved workspace root and the
  // effective posture are final.
  executionPosture?: ExecutionPosture | undefined;
  trigger?:
    | "turn_limit"
    | "budget_exhausted"
    | "idle_timeout"
    | "workflow_phase_canceled"
    | undefined;
  timestamp: string;
}

export const RunStateChangeEventSchema: z.ZodType<RunStateChangeEvent> = z
  .object({
    runId: RunIdSchema,
    runVersion: countSchema,
    previousState: RunStateSchema,
    newState: RunStateSchema,
    failureCategory: RunFailureCategorySchema.optional(),
    failureCause: RunRefusedCauseSchema.optional(),
    recoveryCondition: RecoveryConditionSchema.optional(),
    recoverySpanClassification: RecoverySpanClassificationSchema.optional(),
    providerFailureDetail: wireFreeFormString(
      DRIVER_FAILURE_DETAIL_MAX_LEN,
      "RunStateChangeEvent.providerFailureDetail",
    ).optional(),
    completionKind: z.enum(["turn", "task"]).optional(),
    intendedClose: z.literal(true).optional(),
    executionPosture: executionPostureSchema.optional(),
    trigger: z
      .enum(["turn_limit", "budget_exhausted", "idle_timeout", "workflow_phase_canceled"])
      .optional(),
    timestamp: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((event) => event.failureCause === undefined || event.newState === "failed", {
    path: ["failureCause"],
    message: "A failure cause rides only a transition into `failed`.",
  });

// The forward rollback event: not a state transition, so it carries no
// `previousState` / `newState`, and inventing one would corrupt the transition
// stream consumers replay. It shares `run.subscribeState` with the state change
// and carries no tag: `.strict()` on both keeps them apart, since each fails the
// other's required members. `sessionId` is present because this is also the
// stored `run.rolled_back` payload the timeline reads.

/** A run rewound to an earlier turn boundary, carried on `run.subscribeState`. */
export interface RunRolledBackEvent {
  sessionId: SessionId;
  runId: RunId;
  // The run counter after the rollback, which advanced it.
  runVersion: number;
  // The turn boundary the run landed at, as a session position. It equals the
  // request's target on the confirmed path; where the driver confirmed a
  // different landing it is that landing, so the event never misstates where the
  // run came to rest.
  targetPosition: number;
}

export const RunRolledBackEventSchema: z.ZodType<RunRolledBackEvent> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    runVersion: countSchema,
    targetPosition: countSchema,
  })
  .strict();

/**
 * One delivery on `run.subscribeState`: a state change, a rollback, or Codex's
 * safety hold on the run's turn. The hold is a live detail of the run's working
 * status and the stream is its only carrier: it is not written to the session's
 * history, so a re-opened session does not replay it. Like the rollback it carries
 * no tag; `.strict()` on all three keeps them apart, since each lacks the others'
 * required members.
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

// --------------------------------------------------------------------------
// Pause and resume
// --------------------------------------------------------------------------
//
// Separate requests, not `InterventionType` members, each with the same
// mandatory `expectedRunVersion` as an intervention.

export interface RunPauseRequest {
  targetRunId: RunId;
  expectedRunVersion: number;
}
export const RunPauseRequestSchema: z.ZodType<RunPauseRequest, RunPauseRequest> = z
  .object({
    targetRunId: RunIdSchema,
    expectedRunVersion: countSchema,
  })
  .strict();

export interface RunResumeRequest {
  targetRunId: RunId;
  expectedRunVersion: number;
}
export const RunResumeRequestSchema: z.ZodType<RunResumeRequest, RunResumeRequest> = z
  .object({
    targetRunId: RunIdSchema,
    expectedRunVersion: countSchema,
  })
  .strict();

// The run-control ack: the run's state after the call and its advanced
// `runVersion`, so the caller threads the fresh comparand into its next guarded
// request without a round-trip to `run.subscribeState`.
export interface RunControlAck {
  runId: RunId;
  newState: RunState;
  runVersion: number;
}
export const RunControlAckSchema: z.ZodType<RunControlAck> = z
  .object({
    runId: RunIdSchema,
    newState: RunStateSchema,
    runVersion: countSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// Recovery after a restart
// --------------------------------------------------------------------------
//
// After a restart the daemon compares each resumed conversation with its own
// record. A read-only surplus on the provider's side is added with no question;
// any other mismatch halts the run on a question with two choices, and the
// person's answer is `run.recoveryResolve`. Where the provider is ahead:
// `keep_provider` keeps what it did, `undo_to_agreed` cuts back to the last point
// both records agree on. Where the service is ahead: `continue_provider`
// continues from the provider's record, `hand_over` continues in a new
// conversation with the hand-over brief.

/** The person's answer to the recovery question. */
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

/** Answers the recovery question a restart left a run halted on. */
export interface RunRecoveryResolveRequest {
  runId: RunId;
  choice: RunRecoveryChoice;
}
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
export const RunRecoveryResolvedPayloadSchema: z.ZodType<RunRecoveryResolvedPayload> = z
  .object({ sessionId: SessionIdSchema, runId: RunIdSchema, choice: RunRecoveryChoiceSchema })
  .strict();

/**
 * Opens a session's run state stream: every run in the session, the lead and each
 * child, which the caller fans out by `runId`. Session-scoped, with no replay
 * cursor.
 */
export interface RunStateSubscribeRequest {
  sessionId: SessionId;
}
export const RunStateSubscribeRequestSchema: z.ZodType<
  RunStateSubscribeRequest,
  RunStateSubscribeRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

// --------------------------------------------------------------------------
// The run read
// --------------------------------------------------------------------------
//
// The engine-side read the daemon's guards take. `sessionId` and `state` are a
// derived projection; there is no runs table. The accessor returns a snapshot or
// throws, never null for an unknown run, so a guard fails closed rather than
// comparing `undefined` against a comparand. Synchronous, because the projection
// read it fronts is a synchronous SQLite read.

export interface RunReadSnapshot {
  version: number;
  sessionId: SessionId;
  state: RunState;
}
export const RunReadSnapshotSchema: z.ZodType<RunReadSnapshot> = z
  .object({
    version: countSchema,
    sessionId: SessionIdSchema,
    state: RunStateSchema,
  })
  .strict();

export type RunReadAccessor = (runId: RunId) => RunReadSnapshot;

// --------------------------------------------------------------------------
// Methods
// --------------------------------------------------------------------------

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
});
