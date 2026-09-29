// Run-control contracts — the queue, intervention, pause/resume, and run-read
// surface.
//
// Every shape here and verbatim: adding, removing, or renaming a member is a
// contract break and requires the doc edit first (all name that section as their
// byte-for-byte mirror source, and the three shapes no Phase-1 task names —
// `RunRolledBackEvent` plus the two `run.subscribe*` request shapes — are homed
// here by that same section's closing sentence, which places the canonical Zod
// schemas for the request/response shapes of its own method registry in this
// file; the `driver_ask` interface sharing that fence is NOT one of them, its
// payload schemas living elsewhere).
//
// This module owns the branded `QueueItemId` / `InterventionId`, the queue
// and intervention wire shapes, `RunPauseRequest` / `RunResumeRequest` /
// `RunControlAck`, the forward `RunRolledBackEvent`, the two session-scoped
// `run.subscribe*` request shapes, and the run-read accessor contract. It
// also DECLARES four enums that the canonical doc lists `RunState`,
// `RunFailureCategory`, `QueueItemState`, and `InterventionState`. do not
// redefine", and there is nothing to import — a repo-wide search of
// `packages/` and `apps/` finds no declaration of any of the four. A later
// plan MUST import from here, never restate.
//
// This module imports downward only, so no cycle is reachable through it
// today. Its one in-package consumer is the `./timeline/` subdirectory (take
// `RunState` and `RunRolledBackEventSchema` from here), which nothing below
// imports back. Keep it that way: the shapes below compose
// `./provider-driver.js`, `./session.js`, and `./repo.js`, and every one of those is an eager
// module-scope Zod initializer, so a back-import from any of them would throw `ReferenceError` at
// import time rather than fail to compile (see the `repo.ts` header for the worked case).
//
// Request schemas use the double-T `z.ZodType<T, T>` form and response /
// event schemas the single-T `z.ZodType<T>` form, matching `session.ts`:
// only request schemas reach tRPC's Standard Schema V1 input inference.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import {
  ArtifactIdSchema,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DRIVER_WIRE_HANDLE_MAX_LEN,
  DRIVER_WIRE_REASON_MAX_LEN,
  DRIVER_WIRE_STEER_ATTACHMENTS_MAX,
  DRIVER_WIRE_STEER_CONTENT_MAX_LEN,
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
import { WorkspaceIdSchema, type WorkspaceId } from "./repo.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";

// --------------------------------------------------------------------------
// Branded identifiers
// --------------------------------------------------------------------------

export type QueueItemId = string & { readonly __brand: "QueueItemId" };
export const QueueItemIdSchema: z.ZodType<QueueItemId, QueueItemId> =
  brandedUuidIdSchema<QueueItemId>("QueueItemId");

export type InterventionId = string & { readonly __brand: "InterventionId" };
export const InterventionIdSchema: z.ZodType<InterventionId, InterventionId> =
  brandedUuidIdSchema<InterventionId>("InterventionId");

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
//
// Membership is verbatim. `RunFailureCategory`'s values carry a space by
// design — they are the canonical wire literals, not identifiers, and
// normalizing them to kebab- or snake-case here would silently fork the wire
// contract from the doc.
//
// All four are typed double-T (`z.ZodType<T, T>`) rather than the single-T
// form `session.ts` uses for its enums. A `z.enum` genuinely has Input ===
// Output, and `QueueItemStateSchema` composes into `QueueItemListRequest` — a
// tRPC-consumed request schema, which loses Standard Schema V1 input inference
// the moment any member's Input degrades to `unknown` (see
// `./internal/branded.ts`). Declaring the honest Input on all four keeps the
// four consistent instead of splitting them by current call site.

/** Where a queued message stands: waiting, sent to the run, replaced, canceled, or never sent. */
export type QueueItemState = "queued" | "admitted" | "superseded" | "canceled" | "not_delivered";
/** Validates a {@link QueueItemState}. */
export const QueueItemStateSchema: z.ZodType<QueueItemState, QueueItemState> = z.enum([
  "queued",
  "admitted",
  "superseded",
  "canceled",
  "not_delivered",
]);

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

export type RunState =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "paused"
  | "completed"
  | "interrupted"
  | "failed";
export const RunStateSchema: z.ZodType<RunState, RunState> = z.enum([
  "queued",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "paused",
  "completed",
  "interrupted",
  "failed",
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
//
// `z.ZodType<T, T>` — see `./internal/branded.ts` for rationale (preserves
// Input inference when this composes into a tRPC-consumed request schema).
const RecordOfUnknownSchema: z.ZodType<Record<string, unknown>, Record<string, unknown>> = z.record(
  z.string(),
  z.unknown(),
);

// A run's optimistic-concurrency comparand and every normalized session
// position. `.int()` and `.nonnegative()` are both load-bearing rather than
// decorative — the same reasoning `ApplyInterventionParamsSchema` records for
// `expectedRunVersion`: a float or a negative compares unequal to every stored
// value and turns a concurrency or boundary check into an unconditional
// refusal that reads as a conflict.
const runCounterSchema: z.ZodNumber = z.number().int().nonnegative();

// Filesystem path entries: the execution posture's `writableRoots`
// (recurring across all four posture arms).
//
// Deliberately NOT `wireFreeFormString`: that helper rejects whitespace-only
// values, and a directory named with a single space is legal on POSIX. The
// only guard that CANNOT falsely refuse is applied instead — NUL rejection (no
// filesystem admits a NUL in a path component).
//
// Length is deliberately UNBOUNDED: a per-path ceiling would make a valid
// extended-length Windows path (\\?\ prefix — no 260/4096 bound) or a deep
// POSIX tree fail parse. Byte bounds belong to the framework layer's
// body-size limit.
const filesystemPathSchema: z.ZodString = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), {
    message: "Filesystem path MUST NOT contain a NUL byte.",
  });

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------

export interface QueueItemCreateRequest {
  sessionId: SessionId;
  // Repo-bound run binding (run setup data; absent = non-repo run) — repo-bound
  // audit.
  workspaceId?: WorkspaceId | undefined;
  priority?: number | undefined;
  payload: Record<string, unknown>;
}
export const QueueItemCreateRequestSchema: z.ZodType<
  QueueItemCreateRequest,
  QueueItemCreateRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    workspaceId: WorkspaceIdSchema.optional(),
    // `.int()` mirrors the `queue_items.priority INTEGER NOT NULL DEFAULT 0`
    // column: a float would round on the way into SQLite and silently reorder
    // the drain. NOT `.nonnegative()` — the column's own comment reads
    // "higher = more urgent", so a negative priority is a meaningful
    // de-prioritization rather than an error.
    priority: z.number().int().optional(),
    payload: RecordOfUnknownSchema,
  })
  .strict();

export interface QueueItemCreateResponse {
  queueItemId: QueueItemId;
  state: QueueItemState;
  createdAt: string;
}
export const QueueItemCreateResponseSchema: z.ZodType<QueueItemCreateResponse> = z
  .object({
    queueItemId: QueueItemIdSchema,
    state: QueueItemStateSchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export interface QueueItemListRequest {
  sessionId: SessionId;
  state?: QueueItemState | undefined;
}
export const QueueItemListRequestSchema: z.ZodType<QueueItemListRequest, QueueItemListRequest> = z
  .object({
    sessionId: SessionIdSchema,
    state: QueueItemStateSchema.optional(),
  })
  .strict();

export interface QueueItemSummary {
  id: QueueItemId;
  state: QueueItemState;
  priority: number;
  createdAt: string;
  updatedAt: string;
}
export const QueueItemSummarySchema: z.ZodType<QueueItemSummary> = z
  .object({
    id: QueueItemIdSchema,
    state: QueueItemStateSchema,
    priority: z.number().int(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export interface QueueItemListResponse {
  items: QueueItemSummary[];
}
export const QueueItemListResponseSchema: z.ZodType<QueueItemListResponse> = z
  .object({ items: z.array(QueueItemSummarySchema) })
  .strict();

export interface QueueItemCancelRequest {
  queueItemId: QueueItemId;
}
export const QueueItemCancelRequestSchema: z.ZodType<
  QueueItemCancelRequest,
  QueueItemCancelRequest
> = z.object({ queueItemId: QueueItemIdSchema }).strict();

export interface QueueItemCancelResponse {
  queueItemId: QueueItemId;
  // Narrowed to the single terminal a cancel can reach: the response type is
  // not a place to restate the whole lifecycle enum.
  state: "canceled";
}
export const QueueItemCancelResponseSchema: z.ZodType<QueueItemCancelResponse> = z
  .object({
    queueItemId: QueueItemIdSchema,
    state: z.literal("canceled"),
  })
  .strict();

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
//
// `expectedRunVersion` is the MANDATORY optimistic-concurrency comparand
// (fail-closed): an absent comparand is rejected, never applied — an optional
// field would let a caller bypass the stale-replay guard by omitting it.
// `clientIdempotencyKey` is the orthogonal second guard: a
// requester-generated UUID persisted on the `interventions` row under
// `UNIQUE(target_run_id, client_idempotency_key)`, so an identical retry
// replays the recorded outcome. The UUID shape is validated here rather than
// left to caller discipline because a non-UUID key lands in a durable receipt
// as an unbounded caller-chosen string.

/** A caller's request to steer, interrupt, or cancel a run, one arm per intervention type. */
export type InterventionRequestPayload =
  | {
      type: "steer";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      content: string;
      // TYPED `ArtifactId[]` (2026-09-08 discharge) — the SAME element type and
      // the SAME order-preserving, never-silently-dropped delivery rule the
      // driver-boundary `SteerPayload.attachments` carries, imported from its
      // home in `./provider-driver.js` rather than restated here, because this
      // arm and that payload are two ends of one carrier and a second
      // declaration would let them drift. The rule and both bounds — this seam's
      // coarse `DRIVER_WIRE_STEER_ATTACHMENTS_MAX` count ceiling and the
      // operator-tunable `max_attachments_per_carrier` the daemon enforces at
      // carrier acceptance — are stated once, on that declaration.
      attachments?: ArtifactId[] | undefined;
      expectedTurnId?: string | undefined;
    }
  | {
      type: "interrupt";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      reason?: string | undefined;
    }
  | {
      type: "cancel";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      reason?: string | undefined;
    };

export const InterventionRequestPayloadSchema: z.ZodType<
  InterventionRequestPayload,
  InterventionRequestPayload
> = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("steer"),
      targetRunId: RunIdSchema,
      expectedRunVersion: runCounterSchema,
      clientIdempotencyKey: z.string().uuid(),
      content: wireFreeFormString(
        DRIVER_WIRE_STEER_CONTENT_MAX_LEN,
        "InterventionRequestPayload.content",
      ),
      // `ArtifactId` elements: a non-id element is refused at this seam, and
      // the `.max()` beside it is the coarse frame-abuse count ceiling. The
      // operator-tunable `max_attachments_per_carrier` is the daemon's
      // admission check, not this parse's — see `SteerPayload`.
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
      expectedRunVersion: runCounterSchema,
      clientIdempotencyKey: z.string().uuid(),
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
      expectedRunVersion: runCounterSchema,
      clientIdempotencyKey: z.string().uuid(),
      reason: wireFreeFormString(
        DRIVER_WIRE_REASON_MAX_LEN,
        "InterventionRequestPayload.reason",
      ).optional(),
    })
    .strict(),
]);

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
//
// The result shapes a settled rollback reports. The disposition class is
// ENCODED in the arm types: `applied` admits exactly `RollbackAppliedResult`
// and `degraded` exactly `RollbackDegradedResult`.
//
// `resendDisposition` is a separate axis: it reports the replacement leg's
// outcome, and each class admits only its own literal (`applied` =>
// "admitted", `degraded` => "unapplied").

/** What an applied rollback restored: files and the conversation, or the conversation only. */
export type RollbackAppliedResult =
  | { disposition: "files-restored" }
  | { disposition: "conversation-only" };

/** Why a rollback degraded: nothing was applied, or the replacement message was not sent. */
export type RollbackDegradedResult =
  | { disposition: "nothing-applied" }
  | { disposition: "resend-unapplied"; resendDisposition: "unapplied" };

export interface RollbackAppliedResendOutcome {
  resendDisposition?: "admitted" | undefined;
}
export interface RollbackDegradedResendOutcome {
  resendDisposition?: "unapplied" | undefined;
}

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
//
// `rejectionReason` is a machine-readable cause carried on a `rejected`
// OUTCOME — a normal response, NOT a JSON-RPC transport error.
//
// `RollbackCompositeRejectionGuard` names the edit-and-resend composite's
// structural refusal guard. It is a closed union so a new guard breaks
// compilation at every exhaustive reader.

/** The guard that refuses an edit-and-resend rollback before anything is applied. */
export type RollbackCompositeRejectionGuard = "user-authored-target";

export interface InterventionResponseBase {
  interventionId: InterventionId;
  state: InterventionState;
  // Post-application run counter — the caller threads this into the next
  // intervention's `expectedRunVersion`. Carried on the response because an
  // applied native steer advances the run version WITHOUT a `run.*` state
  // change, so for that path this is the only place the fresh comparand can be
  // read.
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
    runVersion: runCounterSchema,
    rejectionReason: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "InterventionResponseBase.rejectionReason",
    ).optional(),
    interventionType: InterventionTypeSchema,
    state: InterventionStateSchema,
    result: RecordOfUnknownSchema.optional(),
  })
  .strict();

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
//
// TWO of the three now carry exported parsers there, and this file imports
// them instead of mirroring their values: a carrier that restates a hoisted
// vocabulary is the drift exists to remove, and the symbol names are claimed
// from its own file rather than minted in this one.
//
// `ExecutionPosture` keeps its module-private parser below. Its
// `z.ZodType<ExecutionPosture>` annotation pins the parser's output to the
// imported declaration, which fails the build if that type NARROWS — but a
// WIDENING of it still compiles, because `ZodType` is covariant in its output.
// The annotation is a partial guard, not a mirror-drift guard, and that
// asymmetry is exactly why the two recovery vocabularies are single-sourced
// upstream instead of annotated here.
//
// TWO MEMBERS OF THE CANONICAL SHAPE ARE DELIBERATELY OMITTED: `agentId` and
// `effectiveRunConfig`.
//
// The consequence is deliberate and must be understood before lands:
// `.strict()` means a producer emitting `agentId` FAILS PARSE.

// `ExecutionPostureNetwork` types `allowedDomains` as `[string, ...string[]]`,
// so the parser must produce a non-empty TUPLE and not merely a checked array:
// Zod v4's `.nonempty()` enforces the length but leaves the inferred type
// `string[]`, which the `z.ZodType<ExecutionPosture>` annotation below then
// refuses. The variadic-rest tuple form carries both the check and the type.
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

// The subscription server projects the durable row into this shape:
// `sessionId` is carried by the subscription scope
// (`RunStateSubscribeRequest`), not repeated per event, and the canonical
// wire member is `currentState`. The durable payload is NOT expected to
// validate through this schema.
/** One run state transition as `run.subscribeState` delivers it, with its new run version. */
export interface RunStateChangeEvent {
  runId: RunId;
  // Run-progression counter: the optimistic-concurrency comparand clients
  // read via `run.subscribeState` and pass back as `expectedRunVersion`.
  // Distinct from the immutable `EventEnvelope.version` wire-contract semver
  // — this is the run aggregate's concurrency token.
  runVersion: number;
  previousState: RunState;
  currentState: RunState;
  failureCategory?: RunFailureCategory | undefined;
  recoveryCondition?: RecoveryCondition | undefined;
  recoverySpanClassification?: RecoverySpanClassification | undefined;
  // Two producers, one field: free-form prose from the resume-failure
  // producer, and one fixed `<registered code> origin=<arm>` form from the
  // outbound-frame neutralization tripwire. A consumer reads the cause as the
  // substring before the first space and MUST NOT assume the whole value is
  // prose.
  providerFailureDetail?: string | undefined;
  completionKind?: "turn" | "task" | undefined;
  // Daemon-initiated `closeSession` clean-terminal discriminator: present only
  // on that path, absent on every other terminal. Consumers MUST NOT classify
  // such a terminal as a crash.
  intendedClose?: true | undefined;
  // Stamped only on `run.running` — the post-setup-gate spawn-success
  // transition, where the resolved workspace root and effective posture are
  // final. Optionality is for pre-amendment history and non-running rows only.
  executionPosture?: ExecutionPosture | undefined;
  trigger?:
    | "turn_limit"
    | "budget_exhausted"
    | "idle_timeout"
    | "workflow_phase_canceled"
    | undefined;
  parentRunId?: RunId | undefined;
  internalHelper?: boolean | undefined;
  // Path-independent admission stamps — NOT part of the orchestration linkage
  // block: `run.queued` carries these for EVERY provider run, whichever
  // admission path created it. Never client-suppliable.
  admittedUnpricedCapCents?: number | undefined;
  admittedModelFamily?: string | undefined;
  timestamp: string;
}

export const RunStateChangeEventSchema: z.ZodType<RunStateChangeEvent> = z
  .object({
    runId: RunIdSchema,
    runVersion: runCounterSchema,
    previousState: RunStateSchema,
    currentState: RunStateSchema,
    failureCategory: RunFailureCategorySchema.optional(),
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
    parentRunId: RunIdSchema.optional(),
    internalHelper: z.boolean().optional(),
    admittedUnpricedCapCents: z.number().int().nonnegative().optional(),
    admittedModelFamily: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "RunStateChangeEvent.admittedModelFamily",
    ).optional(),
    timestamp: z.iso.datetime({ offset: true }),
  })
  .strict();

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
//
// The forward, NON-STATE rollback event. Registered and homed here rather than
// under a Phase-1 task, because no Phase-1 task names it: produces the forward
// emission, and the shape rides `run.subscribeState` alongside
// `RunStateChangeEvent`.
//
// Deliberately NO `previousState` / `currentState`: a rollback is not a state
// transition, and fabricating one would corrupt the transition stream
// consumers replay. It is non-terminal, so it has zero interaction with the
// at-most-once terminal backstop. The two arms therefore share one stream
// with no wire tag and stay unambiguous STRUCTURALLY, which is what
// `.strict()` buys on both: a state-change object fails here for want of
// `sessionId` / `targetPosition`, and this shape fails there for want of
// `previousState` / `currentState` / `timestamp`.
//
// `sessionId` — which the sibling state-change shape does not carry — is
// present because this same payload is the durable `run.rolled_back` row
// timeline consumes, where the boundary entry refines `runId ===
// payload.runId`, `sessionId === payload.sessionId`, and `position ===
// payload.targetPosition`, so outer attribution and payload cannot disagree.

/** A run rewound to an earlier turn boundary, carried on `run.subscribeState`. */
export interface RunRolledBackEvent {
  sessionId: SessionId;
  runId: RunId;
  // The POST-rollback progression value — the rollback application advanced
  // it. The rewind records no transition of its own, so this event is what
  // keeps a `run.subscribeState` subscriber from being blind to it.
  runVersion: number;
  // The turn-boundary rewind anchor the run LANDED at (normalized session
  // position). Equal to the request's `targetPosition` on the confirmed path;
  // a confirmed-floor mismatch degrade records the driver-confirmed landing
  // position instead — the event never lies about where the run came to rest.
  targetPosition: number;
}

export const RunRolledBackEventSchema: z.ZodType<RunRolledBackEvent> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    runVersion: runCounterSchema,
    targetPosition: runCounterSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// Pause / resume triggers
// --------------------------------------------------------------------------
//
// `pause` and `resume` are SEPARATE REQUEST TYPES, not `InterventionType`
// members: they are orchestration-layer verbs and hold no membership in `steer
// | interrupt | cancel` by design, so the client needs a typed
// trigger distinct from `applyIntervention`. Both carry the MANDATORY
// `expectedRunVersion` guard with the same fail-closed semantics as
// `InterventionRequestPayload` — as deliberately extended to these two verbs,
// not as inherited from its original intervention-only scope.

export interface RunPauseRequest {
  targetRunId: RunId;
  expectedRunVersion: number;
}
export const RunPauseRequestSchema: z.ZodType<RunPauseRequest, RunPauseRequest> = z
  .object({
    targetRunId: RunIdSchema,
    expectedRunVersion: runCounterSchema,
  })
  .strict();

export interface RunResumeRequest {
  targetRunId: RunId;
  expectedRunVersion: number;
}
export const RunResumeRequestSchema: z.ZodType<RunResumeRequest, RunResumeRequest> = z
  .object({
    targetRunId: RunIdSchema,
    expectedRunVersion: runCounterSchema,
  })
  .strict();

// Shared pause/resume ack: echoes the post-transition run state plus the
// advanced `runVersion`, so the caller threads the fresh comparand into its
// next guarded request without a round-trip to `run.subscribeState`.
export interface RunControlAck {
  runId: RunId;
  currentState: RunState;
  runVersion: number;
}
export const RunControlAckSchema: z.ZodType<RunControlAck> = z
  .object({
    runId: RunIdSchema,
    currentState: RunStateSchema,
    runVersion: runCounterSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
//
// Both `run.subscribe*` requests carry `{sessionId}` and nothing else, and both
// are homed here on the same basis as `RunRolledBackEvent` above: registers them,
// no Phase-1 task names them, and the Phase-4 client-SDK and renderer tasks
// consume them — naming the shipped `subscribePresence → {sessionId}` shape as
// the precedent these two follow.
//
// SESSION-SCOPED BY DESIGN, not for want of a filter: the canonical event
// stream is per-session and makes the session the authorization unit, so a
// caller subscribes within a session it participates in and fans out per run
// CLIENT-side via `RunStateChangeEvent.runId`. A `runId` member would be a
// second, weaker scope over an authorization decision the session already
// settles.
//
// NO replay-cursor member, unlike `SessionSubscribeRequest`'s `afterCursor`:
// the `run.*` namespace is local-IPC JSON-RPC — the posture
// `PresenceSubscribeRequest` records for itself — so the absence here is a
// decision, and adding a cursor is a doc edit first.
//
// Structurally identical today and DISTINCT types on purpose: the doc
// registers two, and separate types let either surface gain a member later
// with zero churn on the other.

export interface RunStateSubscribeRequest {
  sessionId: SessionId;
}
export const RunStateSubscribeRequestSchema: z.ZodType<
  RunStateSubscribeRequest,
  RunStateSubscribeRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

export interface RunQueueSubscribeRequest {
  sessionId: SessionId;
}
export const RunQueueSubscribeRequestSchema: z.ZodType<
  RunQueueSubscribeRequest,
  RunQueueSubscribeRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
//
// Phase 3 authors the engine-side read
// (`runtime-daemon/src/session/run-engine.ts`); this file
// deliberately creates no daemon module.
//
// `sessionId` and `state` are derived projection; there is no standalone
// runs table.
//
// TOTAL BY CONTRACT. The accessor returns a snapshot or THROWS; it does not
// return null or undefined for an unknown run. That is what makes the guard
// fail closed — a nullish return would let a caller reach for `?.version`,
// compare `undefined` against a supplied comparand, and route an unknown run
// into whichever branch the falsy comparison happens to select. The signature
// encodes the contract; it does not invent behavior the plan leaves open.
//
// SYNCHRONOUS, mirroring the plan's `getRun(runId): { version, sessionId,
// state }`. The projection read it fronts is a synchronous SQLite read.

export interface RunReadSnapshot {
  version: number;
  sessionId: SessionId;
  state: RunState;
}
export const RunReadSnapshotSchema: z.ZodType<RunReadSnapshot> = z
  .object({
    version: runCounterSchema,
    sessionId: SessionIdSchema,
    state: RunStateSchema,
  })
  .strict();

export type RunReadAccessor = (runId: RunId) => RunReadSnapshot;
