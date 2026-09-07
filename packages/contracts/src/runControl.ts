// Run-control contracts — the queue, intervention, pause/resume, and
// run-read surface for Plan-004 (Queue, Steer, Pause, Resume).
//
// Every shape here mirrors
// `docs/architecture/contracts/api-payload-contracts.md §Plan-004 — Queue Steer Pause Resume`
// and `§Shared Enums` verbatim: adding, removing, or renaming a member is a
// contract break and requires the doc edit first (Plan-004 T1.1, T1.2, T1.3,
// T1.6, T1.7 all name that section as their byte-for-byte mirror source, and
// the three shapes no Phase-1 task names — `RunRolledBackEvent` plus the two
// `run.subscribe*` request shapes — are homed here by that same section's
// closing sentence, which places the canonical Zod schemas for the
// request/response shapes of its own method registry in this file under
// CP-004-3; the `driver_ask` interface sharing that fence is NOT one of them,
// its payload schemas being Plan-012's).
//
// CANONICAL ORIGIN (Plan-004 CP-004-3). This module owns the branded
// `QueueItemId` / `InterventionId`, the queue and intervention wire shapes,
// `RunPauseRequest` / `RunResumeRequest` / `RunControlAck`, the forward
// `RunRolledBackEvent`, the two session-scoped `run.subscribe*` request
// shapes, and the run-read accessor contract. It also DECLARES four enums
// that the canonical doc lists under §Shared Enums but that no TypeScript in
// this workspace had yet exported: `RunState`, `RunFailureCategory`,
// `QueueItemState`, and `InterventionState`. Plan-004 T1.1/T1.3 say
// "import ... do not redefine", and there is nothing to import — a repo-wide
// search of `packages/` and `apps/` finds no declaration of any of the four.
// Plan-004 is the lowest-tier plan that must author a shape carrying them,
// so they are declared here on the precedent `provider-driver.ts` already
// sets for `RunId`: the canonical symbol is homed with its lowest-tier
// consumer and imported upward (CP-005-6). A later plan MUST import from
// here, never restate.
//
// `InterventionType` is the counter-example and is deliberately NOT declared
// here: it IS exported (Plan-005 owns it in `./provider-driver.js`), so this
// module imports it and pins the payload union against it in the test suite.
//
// IMPORT DIRECTION. This module imports downward only, so no cycle is
// reachable through it today. Its one in-package consumer is the
// `./timeline/` subdirectory (Plan-013 T1.1/T1.2 take `RunState` and
// `RunRolledBackEventSchema` from here), which nothing below imports back.
// Keep it that way: the shapes below compose
// `./provider-driver.js`, `./session.js`, `./repo.js`, and the `./node-id.js`
// leaf, and every one of those is an eager module-scope Zod initializer, so a
// back-import from any of them would throw `ReferenceError` at import time
// rather than fail to compile (see the `repo.ts` header for the worked case).
//
// Request schemas use the double-T `z.ZodType<T, T>` form and response /
// event schemas the single-T `z.ZodType<T>` form, matching `session.ts`:
// only request schemas reach tRPC's Standard Schema V1 input inference.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import { NodeIdSchema, type NodeId } from "./node-id.js";
import {
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DRIVER_WIRE_HANDLE_MAX_LEN,
  DRIVER_WIRE_REASON_MAX_LEN,
  DRIVER_WIRE_STEER_ATTACHMENTS_MAX,
  DRIVER_WIRE_STEER_CONTENT_MAX_LEN,
  RecoveryConditionSchema,
  RecoverySpanClassificationSchema,
  RunIdSchema,
  type ExecutionPosture,
  type RecoveryCondition,
  type RecoverySpanClassification,
  type RunId,
} from "./provider-driver.js";
import { WorkspaceIdSchema, type WorkspaceId } from "./repo.js";
import {
  ChannelIdSchema,
  SessionIdSchema,
  wireFreeFormString,
  type ChannelId,
  type SessionId,
} from "./session.js";

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
// Shared enums (api-payload-contracts.md §Shared Enums)
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

export type QueueItemState = "queued" | "admitted" | "superseded" | "canceled" | "expired";
export const QueueItemStateSchema: z.ZodType<QueueItemState, QueueItemState> = z.enum([
  "queued",
  "admitted",
  "superseded",
  "canceled",
  "expired",
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

// Filesystem path entries. Three consuming members: the restore result's two
// never-silent enumerations (`overwrittenIgnoredPaths` / `divergentGitlinks`,
// recurring across every file-bearing rollback disposition) and the execution
// posture's `writableRoots` (recurring across all four posture arms).
//
// Deliberately NOT `wireFreeFormString`: that helper rejects whitespace-only
// values, and a repository entry named with a single space is legal on POSIX,
// so using it here would turn a real restore into a parse failure. The only
// guard that CANNOT falsely refuse is applied instead — NUL rejection (no
// filesystem admits a NUL in a path component).
//
// Both length and cardinality are deliberately UNBOUNDED. Spec-010
// §Turn-Boundary Snapshots requires both restore enumerations to be
// never-silent; a per-path length ceiling would make a valid
// extended-length Windows path (\\?\ prefix — no 260/4096 bound) or a
// deep POSIX tree fail parse, and an array-count cap would refuse a
// large-but-legitimate restore — either way discarding the only report of
// overwritten files or divergent gitlinks, which is the one outcome the
// never-silent mandate forbids. Byte bounds belong to the framework layer's
// body-size limit, not to a cap that can refuse a truthful result.
const filesystemPathSchema: z.ZodString = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), {
    message: "Filesystem path MUST NOT contain a NUL byte.",
  });

// --------------------------------------------------------------------------
// T1.1 — Queue item contracts
// --------------------------------------------------------------------------

export interface QueueItemCreateRequest {
  sessionId: SessionId;
  channelId?: ChannelId | undefined;
  // Repo-bound run binding (Spec-010 run setup data; absent = non-repo run) —
  // Tier-6 audit, CP-004-8.
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
    channelId: ChannelIdSchema.optional(),
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
  channelId?: ChannelId | undefined;
}
export const QueueItemListRequestSchema: z.ZodType<QueueItemListRequest, QueueItemListRequest> = z
  .object({
    sessionId: SessionIdSchema,
    state: QueueItemStateSchema.optional(),
    channelId: ChannelIdSchema.optional(),
  })
  .strict();

export interface QueueItemSummary {
  id: QueueItemId;
  state: QueueItemState;
  priority: number;
  channelId?: ChannelId | undefined;
  createdAt: string;
  updatedAt: string;
}
export const QueueItemSummarySchema: z.ZodType<QueueItemSummary> = z
  .object({
    id: QueueItemIdSchema,
    state: QueueItemStateSchema,
    priority: z.number().int(),
    channelId: ChannelIdSchema.optional(),
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
// T1.2 — InterventionRequestPayload
// --------------------------------------------------------------------------
//
// `expectedRunVersion` is the MANDATORY optimistic-concurrency comparand
// (D-004-2, fail-closed): an absent comparand is rejected, never applied — an
// optional field would let a caller bypass the stale-replay guard by omitting
// it. `clientIdempotencyKey` is the orthogonal second guard: a
// requester-generated UUID persisted on the `interventions` row under
// `UNIQUE(target_run_id, client_idempotency_key)`, so an identical retry
// replays the recorded outcome. The UUID shape is validated here rather than
// left to caller discipline because a non-UUID key lands in a durable receipt
// as an unbounded caller-chosen string.
//
// `targetPosition` parses as an integer >= 0 and NOTHING MORE. Whether it
// names a recorded turn boundary of the target run strictly below that run's
// current position is a daemon ADMISSION check against durable state (Phase 2
// / Phase 3), not something a schema can know.
//
// `replacementSend` is OPTIONAL and PRESENCE-DISCRIMINATING: presence alone
// selects the atomic edit-and-resend composite (I-004-21) and turns on that
// composite's four additional structural refusal guards, each of which is
// likewise an admission concern. `.strict()` is what makes the absence
// meaningful — an unregistered sibling member fails closed rather than being
// silently dropped into a bare rollback.

export type InterventionRequestPayload =
  | {
      type: "steer";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      content: string;
      attachments?: unknown[] | undefined;
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
    }
  | {
      type: "rollback";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      targetPosition: number;
      replacementSend?: { content: string } | undefined;
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
      // `unknown` elements by contract, so the bound is on COUNT alone; the
      // framework layer's body-size limit is what bounds the bytes.
      attachments: z.array(z.unknown()).max(DRIVER_WIRE_STEER_ATTACHMENTS_MAX).optional(),
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
  z
    .object({
      type: z.literal("rollback"),
      targetRunId: RunIdSchema,
      expectedRunVersion: runCounterSchema,
      clientIdempotencyKey: z.string().uuid(),
      targetPosition: runCounterSchema,
      replacementSend: z
        .object({
          // The `steer` arm's `content` vocabulary. No attachment member in
          // V1: the leg replaces a participant `user.message` body and nothing
          // else, so widening it is a named future amendment rather than an
          // unregistered field the daemon might silently drop.
          content: wireFreeFormString(
            DRIVER_WIRE_STEER_CONTENT_MAX_LEN,
            "InterventionRequestPayload.replacementSend.content",
          ),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

// --------------------------------------------------------------------------
// T1.3 — Rollback result vocabulary
// --------------------------------------------------------------------------
//
// The disposition class is ENCODED in the arm types: `applied` admits exactly
// `RollbackAppliedResult` and `degraded` exactly `RollbackDegradedResult`, so
// a state/disposition mismatch is a parse failure rather than a rendering bug.
// That mapping is ORTHOGONAL to the rewind grouping — the confirmed-rewind
// group spans both states.
//
// `resendDisposition` is a THIRD, separate axis: it names no leg, reports the
// replacement leg's outcome rather than an earliest-failing one, and rides
// both terminal classes. It is SCHEMA-OPTIONAL and PRODUCER-OBLIGATED —
// presence is not expressible as required because no member of a rollback
// result identifies its request as composite (`replacementSend` is
// request-side and is never echoed), except on `resend-unapplied`, which is
// composite-only and therefore REQUIRES it. The VALUE is expressible and is
// state-determined in V1 (`applied` => "admitted", every `degraded` arm =>
// "unapplied"), so each class admits only its own literal.
//
// ENCODING NOTE. The canonical doc composes these as
// `RollbackAppliedResult & RollbackAppliedResendOutcome`. The schemas below
// fold the resend member into each arm instead of composing a Zod
// intersection, because `.strict()` and `z.intersection` are mutually
// destructive — each side of an intersection sees the whole input, so two
// strict halves reject each other's keys and nothing parses. TypeScript
// distributes `(A | B) & C` to `(A & C) | (B & C)`, so the folded union's
// output type is the doc's composition exactly, and the `z.ZodType<...>`
// annotations below are what prove it.

export type RollbackAppliedResult =
  | {
      disposition: "files-restored";
      // Spec-010 §Turn-Boundary Snapshots mandates both enumerations on the
      // restore result ("never silent"): REQUIRED, empty-when-none — absence
      // is a parse failure, so a consumer can never mistake absence for none.
      overwrittenIgnoredPaths: string[];
      divergentGitlinks: string[];
    }
  | { disposition: "conversation-only" };

export type RollbackDegradedResult =
  | {
      disposition: "files-partially-restored";
      failedStep: string;
      // Same never-silent mandate, covering every effect applied BEFORE the
      // failure — the failing command's partial writes included. Only a
      // pre-mutation failure carries both empty.
      overwrittenIgnoredPaths: string[];
      divergentGitlinks: string[];
    }
  | { disposition: "files-unrestored" }
  | { disposition: "pause-only" }
  | { disposition: "nothing-applied" }
  | { disposition: "position-mismatch"; requestedPosition: number; confirmedPosition: number }
  | {
      disposition: "boundary-diverged";
      confirmedPosition: number;
      // Required-and-NULLABLE rather than optional: Spec-004 routes a second
      // cause into this disposition — a position-less `usage.context_compacted`
      // row, which "classifies as crossing for EVERY target of that run" and
      // has no position to compare against. An absent member could not
      // distinguish that from a producer that forgot to populate it; an
      // explicit `null` states the cause.
      newestBoundaryPosition: number | null;
    }
  | {
      // Composite-only, and the ONLY disposition that STANDS IN FOR a completed
      // file leg — its reachability condition is a fully successful rewind — so
      // it carries `files-restored`'s two enumerations on the same REQUIRED +
      // empty-when-none contract. Dropping them would silence an overwritten
      // ignored path in exactly the case where the restore DID mutate the tree.
      disposition: "resend-unapplied";
      resendDisposition: "unapplied";
      overwrittenIgnoredPaths: string[];
      divergentGitlinks: string[];
    };

export interface RollbackAppliedResendOutcome {
  resendDisposition?: "admitted" | undefined;
}
export interface RollbackDegradedResendOutcome {
  resendDisposition?: "unapplied" | undefined;
}

export type RollbackInterventionResult =
  | (RollbackAppliedResult & RollbackAppliedResendOutcome)
  | (RollbackDegradedResult & RollbackDegradedResendOutcome);

export const RollbackAppliedResultSchema: z.ZodType<
  RollbackAppliedResult & RollbackAppliedResendOutcome
> = z.discriminatedUnion("disposition", [
  z
    .object({
      disposition: z.literal("files-restored"),
      overwrittenIgnoredPaths: z.array(filesystemPathSchema),
      divergentGitlinks: z.array(filesystemPathSchema),
      resendDisposition: z.literal("admitted").optional(),
    })
    .strict(),
  z
    .object({
      disposition: z.literal("conversation-only"),
      resendDisposition: z.literal("admitted").optional(),
    })
    .strict(),
]);

export const RollbackDegradedResultSchema: z.ZodType<
  RollbackDegradedResult & RollbackDegradedResendOutcome
> = z.discriminatedUnion("disposition", [
  z
    .object({
      disposition: z.literal("files-partially-restored"),
      failedStep: wireFreeFormString(
        DRIVER_WIRE_REASON_MAX_LEN,
        "RollbackDegradedResult.failedStep",
      ),
      overwrittenIgnoredPaths: z.array(filesystemPathSchema),
      divergentGitlinks: z.array(filesystemPathSchema),
      resendDisposition: z.literal("unapplied").optional(),
    })
    .strict(),
  z
    .object({
      disposition: z.literal("files-unrestored"),
      resendDisposition: z.literal("unapplied").optional(),
    })
    .strict(),
  z
    .object({
      disposition: z.literal("pause-only"),
      resendDisposition: z.literal("unapplied").optional(),
    })
    .strict(),
  z
    .object({
      disposition: z.literal("nothing-applied"),
      resendDisposition: z.literal("unapplied").optional(),
    })
    .strict(),
  z
    .object({
      disposition: z.literal("position-mismatch"),
      requestedPosition: runCounterSchema,
      confirmedPosition: runCounterSchema,
      resendDisposition: z.literal("unapplied").optional(),
    })
    .strict(),
  z
    .object({
      disposition: z.literal("boundary-diverged"),
      confirmedPosition: runCounterSchema,
      newestBoundaryPosition: runCounterSchema.nullable(),
      resendDisposition: z.literal("unapplied").optional(),
    })
    .strict(),
  z
    .object({
      disposition: z.literal("resend-unapplied"),
      resendDisposition: z.literal("unapplied"),
      overwrittenIgnoredPaths: z.array(filesystemPathSchema),
      divergentGitlinks: z.array(filesystemPathSchema),
    })
    .strict(),
]);

export const RollbackInterventionResultSchema: z.ZodType<RollbackInterventionResult> = z.union([
  RollbackAppliedResultSchema,
  RollbackDegradedResultSchema,
]);

// --------------------------------------------------------------------------
// T1.3 — InterventionRequestResponse
// --------------------------------------------------------------------------
//
// Discriminated on `interventionType` so `result` parses STRICTLY per type: a
// malformed rollback result FAILS validation instead of falling through a
// permissive generic arm. The rollback arm is additionally split by lifecycle
// state, so a disposition-less terminal response fails parse and so does a
// state/disposition mismatch (`applied` + `files-unrestored` would otherwise
// exit-map 0 while rendering a failed restore, since the CLI derives the POSIX
// code from `state`).
//
// `rejectionReason` is a machine-readable cause carried on a `rejected`
// OUTCOME — a normal response, NOT a JSON-RPC transport error. It is REQUIRED
// on the rollback `rejected` arm (every refusal family there carries its cause
// and the daemon persists all of them) and optional on the base for the
// remaining states and non-rollback types.
//
// `rejectionGuard` names WHICH of the atomic edit-and-resend composite's four
// structural refusal guards refused, when one of them did. It is NOT a typed
// restatement of prose: `rejectionReason` is a machine-readable cause (above)
// and never a sentence — the shipped console renders it verbatim in its refusal
// CODE slot, which is "never prose, never localized, never reworded between the
// producer and the screen"
// (`apps/desktop/src/renderer/src/console/core/refusal.ts`). What that member is
// NOT is a CLOSED VOCABULARY: `error-contracts.md` §Intervention deliberately
// registers no code for an intervention OUTCOME (`rejected` / `expired` /
// `degraded` "are states, not error codes"; that namespace covers only
// request-level refusals that produce no intervention row), so no contract
// anywhere enumerates the causes a rollback `rejected` may carry, and the
// `wireFreeFormString` below bounds length / whitespace / NUL at the trust
// boundary rather than fixing a value set. A client can therefore SHOW the cause
// and cannot SWITCH on it: a refusal family added later carries a new identifier
// that every exhaustive read falls through, silently and at no compile-time
// cost. This member is the closed union that closes exactly that gap for the
// four guards — the shape `refusal.ts` already prescribes, where each producer
// "keeps its own closed code union and widens into this shape at its boundary" —
// so a fifth guard breaks compilation at every exhaustive reader and a per-guard
// remedy render is total by construction rather than by care. The four literals
// are the guard names of `Spec-004 §Required Behavior` (its
// four-structural-refusal-guards paragraph) kebab-cased with the leading article
// dropped, so each names the condition the guard requires rather than a
// restatement of the failure.
//
// ARM-SCOPED, NOT BASE-SCOPED. Only the composite raises these guards, and only
// a `rollback` request can be a composite, so the member is declared on the
// rollback `rejected` arm alone — `.strict()` then REFUSES it on a steer /
// interrupt / cancel rejection and on every non-`rejected` state, instead of a
// base-level optional that would parse a guard on an arm that can never raise
// one. Within that arm it is additive-OPTIONAL and PRODUCER-OBLIGATED, the
// `resendDisposition` shape: no member of a `rejected` response identifies its
// request as composite (`replacementSend` is request-side and the response does
// not echo it), so requiredness is not expressible at the strict-parse boundary.
// The daemon's tested obligation is that a refusal raised by one of the four
// guards always populates it and every other refusal family never does — the
// EIGHT `Queue And Intervention Model §Intervention State Transition Table`
// admits for a rollback: the capability gate, authorization, the target-position
// domain check, the compaction-boundary classification, an incompatible target
// run state, the Spec-010 restore precondition, the uncompacted-rewind-span
// intersection, and execution-root `busy`. The obligation is asserted by the
// composite's settlement tests (Plan-004 T3.17), whose negative control runs all
// eight.
//
// REPLAY-DURABLE, AND NOT DERIVABLE FROM ITS SIBLING. A `rejected` response
// carries no `result` (the state-split arm below declares `result?: never`), so
// an idempotent replay of the same `clientIdempotencyKey` reconstructs the whole
// response from the durable intervention row — which is why `rejectionReason`
// has a column of its own. The guard literal cannot be recovered from that
// sibling: its vocabulary is open and unenumerated (above), so reading a literal
// back out of it would be a match against a value set no contract publishes —
// exactly what this member exists to abolish. The daemon
// therefore persists the literal beside the sentence (`interventions`
// `rejection_guard`, additive nullable, its column-attached CHECK closing the
// same four literals and binding them to the rollback `rejected` arm this member
// is scoped to), and a replay returns a value EQUAL to the recorded one across a
// daemon restart — never omitted, and never re-derived by re-evaluating the
// guards against a run that has since moved on.
//
// ADDITIVE-OPTIONAL UNDER THE EXISTING PROTOCOL VERSION. The arm shipped before
// this member, so the additive-only rule for already-published shapes binds — and
// a new optional member is inside what that rule admits and outside everything it
// forbids (no rename, no type change, no semantic change, no new required field,
// no new required semantic invariant). It rides `2026-05-01` and mints no
// revision, as every additive member added to this file since that ratification
// has; see `docs/architecture/contracts/api-payload-contracts.md` §Plan-004 —
// Queue Steer Pause Resume for the rule and the precedent list.

export type RollbackCompositeRejectionGuard =
  | "no-active-turn"
  | "no-pending-send"
  | "participant-authored-target"
  | "resumable-target";

export const RollbackCompositeRejectionGuardSchema: z.ZodType<RollbackCompositeRejectionGuard> =
  z.enum(["no-active-turn", "no-pending-send", "participant-authored-target", "resumable-target"]);

export interface InterventionResponseBase {
  interventionId: InterventionId;
  state: InterventionState;
  // Post-application run counter (D-004-1) — the caller threads this into the
  // next intervention's `expectedRunVersion`. Carried on the response because
  // an applied native steer advances the run version WITHOUT a `run.*` state
  // change, so for that path this is the only place the fresh comparand can be
  // read.
  runVersion: number;
  rejectionReason?: string | undefined;
}

export type InterventionRequestResponse =
  | (InterventionResponseBase & {
      interventionType: "rollback";
      state: "applied";
      result: RollbackAppliedResult & RollbackAppliedResendOutcome;
      // The guard is the `rejected` arm's alone. Declared `?: never` on every
      // other arm for the same reason `result?: never` is below: structural
      // assignability lets a producer-side variable carry a stray member that
      // compiles and then fails the client's strict parse. `runControl.test-d.ts`
      // pins this at compile time off a non-fresh variable.
      rejectionGuard?: never;
    })
  | (InterventionResponseBase & {
      interventionType: "rollback";
      state: "degraded";
      result: RollbackDegradedResult & RollbackDegradedResendOutcome;
      rejectionGuard?: never;
    })
  | (InterventionResponseBase & {
      interventionType: "rollback";
      state: "rejected";
      rejectionReason: string;
      // Present exactly when one of the composite's four structural refusal
      // guards refused; absent on every other refusal family (see the block
      // above the base interface).
      rejectionGuard?: RollbackCompositeRejectionGuard | undefined;
      // The doc declares `result?: never` on this arm. Without it, structural
      // assignability lets a producer-side variable carry a stray `result`
      // that compiles and then fails the strict runtime parse.
      result?: never;
    })
  | (InterventionResponseBase & {
      interventionType: "rollback";
      state: "requested" | "accepted" | "expired";
      result?: never;
      rejectionGuard?: never;
    })
  | (InterventionResponseBase & {
      interventionType: "steer" | "interrupt" | "cancel";
      result?: Record<string, unknown> | undefined;
      // Only a rollback request can be a composite.
      rejectionGuard?: never;
    });

// The base members every arm carries. Spread rather than composed through
// `z.intersection` for the reason recorded on the rollback results above:
// `.strict()` and intersection cannot both hold.
const interventionResponseBaseShape = {
  interventionId: InterventionIdSchema,
  runVersion: runCounterSchema,
  rejectionReason: wireFreeFormString(
    DRIVER_WIRE_HANDLE_MAX_LEN,
    "InterventionResponseBase.rejectionReason",
  ).optional(),
} as const;

// The non-disposition states (`requested` / `accepted` / `expired`) and the
// `rejected` arm carry the doc's `result?: never` in the exported type, and
// every arm but `rejected` carries `rejectionGuard?: never` (so a stray member
// fails at compile time), while `.strict()` is what turns either into a parse
// refusal at runtime.
export const InterventionRequestResponseSchema: z.ZodType<InterventionRequestResponse> =
  z.discriminatedUnion("interventionType", [
    z.discriminatedUnion("state", [
      z
        .object({
          ...interventionResponseBaseShape,
          interventionType: z.literal("rollback"),
          state: z.literal("applied"),
          result: RollbackAppliedResultSchema,
        })
        .strict(),
      z
        .object({
          ...interventionResponseBaseShape,
          interventionType: z.literal("rollback"),
          state: z.literal("degraded"),
          result: RollbackDegradedResultSchema,
        })
        .strict(),
      z
        .object({
          ...interventionResponseBaseShape,
          interventionType: z.literal("rollback"),
          state: z.literal("rejected"),
          rejectionReason: wireFreeFormString(
            DRIVER_WIRE_HANDLE_MAX_LEN,
            "InterventionResponseBase.rejectionReason",
          ),
          rejectionGuard: RollbackCompositeRejectionGuardSchema.optional(),
        })
        .strict(),
      z
        .object({
          ...interventionResponseBaseShape,
          interventionType: z.literal("rollback"),
          state: z.enum(["requested", "accepted", "expired"]),
        })
        .strict(),
    ]),
    z
      .object({
        ...interventionResponseBaseShape,
        interventionType: z.enum(["steer", "interrupt", "cancel"]),
        state: InterventionStateSchema,
        result: RecordOfUnknownSchema.optional(),
      })
      .strict(),
  ]);

// --------------------------------------------------------------------------
// T1.3 — RunStateChangeEvent
// --------------------------------------------------------------------------
//
// `ExecutionPosture`, `RecoveryCondition`, and `RecoverySpanClassification`
// are Plan-005-owned types imported from `./provider-driver.js`. TWO of the
// three now carry exported parsers there (Plan-005 T4.8), and this file
// imports them instead of mirroring their values: a carrier that restates a
// hoisted vocabulary is the drift T4.8 exists to remove, and the symbol names
// are claimed from Plan-005's own file rather than minted in this one.
//
// `ExecutionPosture` keeps its module-private parser below. It carries no
// exported schema in `provider-driver.ts` and is not one of T4.8's carrier
// surfaces, so exporting a parser for it HERE would claim a Plan-005 symbol
// name in this package's barrel. Its `z.ZodType<ExecutionPosture>` annotation
// pins the parser's output to the imported declaration, which fails the build
// if that type NARROWS — but a WIDENING of it still compiles, because
// `ZodType` is covariant in its output. The annotation is a partial guard, not
// a mirror-drift guard, and that asymmetry is exactly why the two recovery
// vocabularies are single-sourced upstream instead of annotated here.
//
// THREE MEMBERS OF THE CANONICAL SHAPE ARE DELIBERATELY OMITTED: `agentId`,
// `linkType`, and `effectiveRunConfig`. All three are typed by Plan-016-owned
// symbols (`AgentId`, `LinkType`, `OrchestrationRunConfig`) that no
// TypeScript in this workspace declares, and minting them here would take
// Plan-016's ownership of shapes it has not yet authored. The remaining
// orchestration-linkage members (`parentRunId`, `internalHelper`,
// `producingNodeId`) have types in hand and are carried, so the omission is
// exactly the three that cannot be typed rather than the whole block.
//
// The consequence is deliberate and must be understood before Plan-016 lands:
// `.strict()` means a producer emitting `agentId` FAILS PARSE. Plan-016 is
// Tier 6 and ships after this contract, so no producer exists today; when one
// does, the three members are added HERE — never worked around at a consumer,
// and never by relaxing the strict shape.

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

// The `run.subscribeState` WIRE projection (api-payload-contracts.md
// §Plan-004 — Queue Steer Pause Resume), deliberately distinct from the
// durable `run_lifecycle` payload of `Spec-006 §Run Lifecycle
// (run_lifecycle)` (`{sessionId, runId, runVersion, previousState,
// newState, channelId?, ...}` — Zod home: the `SessionEventSchema` variants
// in `event.ts`, Plan-006). The subscription server projects the durable
// row into this shape: `sessionId` is carried by the subscription scope
// (`RunStateSubscribeRequest`), not repeated per event, and the canonical
// wire member is `currentState`. The durable payload is NOT expected to
// validate through this schema.
export interface RunStateChangeEvent {
  runId: RunId;
  // Run-progression counter (D-004-1): the optimistic-concurrency comparand
  // clients read via `run.subscribeState` and pass back as
  // `expectedRunVersion`. Distinct from the immutable `EventEnvelope.version`
  // wire-contract semver — this is the run aggregate's concurrency token.
  runVersion: number;
  previousState: RunState;
  currentState: RunState;
  failureCategory?: RunFailureCategory | undefined;
  recoveryCondition?: RecoveryCondition | undefined;
  recoverySpanClassification?: RecoverySpanClassification | undefined;
  healthSignal?: "stuck-suspected" | undefined;
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
    | "moderation_denied"
    | "workflow_phase_cancelled"
    | undefined;
  parentRunId?: RunId | undefined;
  internalHelper?: boolean | undefined;
  producingNodeId?: NodeId | undefined;
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
    healthSignal: z.literal("stuck-suspected").optional(),
    providerFailureDetail: wireFreeFormString(
      DRIVER_FAILURE_DETAIL_MAX_LEN,
      "RunStateChangeEvent.providerFailureDetail",
    ).optional(),
    completionKind: z.enum(["turn", "task"]).optional(),
    intendedClose: z.literal(true).optional(),
    executionPosture: executionPostureSchema.optional(),
    trigger: z
      .enum([
        "turn_limit",
        "budget_exhausted",
        "idle_timeout",
        "moderation_denied",
        "workflow_phase_cancelled",
      ])
      .optional(),
    parentRunId: RunIdSchema.optional(),
    internalHelper: z.boolean().optional(),
    producingNodeId: NodeIdSchema.optional(),
    admittedUnpricedCapCents: z.number().int().nonnegative().optional(),
    admittedModelFamily: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "RunStateChangeEvent.admittedModelFamily",
    ).optional(),
    timestamp: z.iso.datetime({ offset: true }),
  })
  .strict();

// --------------------------------------------------------------------------
// CP-004-3 — RunRolledBackEvent
// --------------------------------------------------------------------------
//
// The forward, NON-STATE rollback event. Registered in
// `docs/architecture/contracts/api-payload-contracts.md §Plan-004 — Queue Steer Pause Resume` and homed
// here under CP-004-3 rather than under a Phase-1 task, because no Phase-1
// task names it: T3.12 produces the forward emission, and the shape rides
// `run.subscribeState` alongside `RunStateChangeEvent`.
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
// present because this same payload is the durable `run.rolled_back` row the
// Plan-013 timeline consumes, where the boundary entry refines
// `runId === payload.runId`, `sessionId === payload.sessionId`, and
// `position === payload.targetPosition`, so outer attribution and payload
// cannot disagree.

export interface RunRolledBackEvent {
  sessionId: SessionId;
  runId: RunId;
  // The POST-rollback progression value — the rollback application advanced
  // it. The rewind records no transition of its own, so this event is what
  // keeps a `run.subscribeState` subscriber from being blind to it.
  runVersion: number;
  channelId?: ChannelId | undefined;
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
    channelId: ChannelIdSchema.optional(),
    targetPosition: runCounterSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// T1.6 — Pause / resume triggers
// --------------------------------------------------------------------------
//
// `pause` and `resume` are SEPARATE REQUEST TYPES, not `InterventionType`
// members: they are orchestration-layer verbs (ADR-011) and hold no membership
// in `steer | interrupt | cancel | rollback` by design, so the client needs a
// typed trigger distinct from `applyIntervention`. Both carry the MANDATORY
// `expectedRunVersion` guard with the same fail-closed semantics as
// `InterventionRequestPayload` — D-004-2 as deliberately extended to these two
// verbs (I-004-7), not as inherited from its original intervention-only scope.

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
// CP-004-3 — Subscription request shapes
// --------------------------------------------------------------------------
//
// Both `run.subscribe*` requests carry `{sessionId}` and nothing else, and
// both are homed here on the same CP-004-3 basis as `RunRolledBackEvent`
// above: `docs/architecture/contracts/api-payload-contracts.md §Plan-004 — Queue Steer Pause Resume`
// registers them, no Phase-1 task names them, and the Phase-4 client-SDK and
// renderer tasks (T4.1 / T4.3 / T4.4) consume them — T4.3 naming the shipped
// `subscribePresence → {sessionId}` shape as the precedent these two follow.
//
// SESSION-SCOPED BY DESIGN, not for want of a filter: the canonical event
// stream is per-session and ADR-001 makes the session the authorization
// unit, so a caller subscribes within a session it participates in and fans
// out per run CLIENT-side via `RunStateChangeEvent.runId`. A `runId` member
// would be a second, weaker scope over an authorization decision the session
// already settles.
//
// NO replay-cursor member, unlike `SessionSubscribeRequest`: that shape
// declares `afterCursor` / `lastEventId` because it is ALSO served over
// tRPC's HTTP/SSE transport, whose fetch adapter injects a reconnect's
// `Last-Event-ID` header into the input object BEFORE Zod validation, where
// a strict shape lacking the member would throw on every resumption. The
// `run.*` namespace is Plan-007 local-IPC JSON-RPC (CP-004-4) — the posture
// `PresenceSubscribeRequest` records for itself — so the absence here is a
// decision, and adding cursors is a doc edit first.
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
// T1.7 — Run-read accessor contract
// --------------------------------------------------------------------------
//
// The SHAPE only. Phase 3 authors the engine-side read
// (`runtime-daemon/src/session/run-engine.ts`, CP-004-6); this file
// deliberately creates no daemon module.
//
// `version` is the any-run-progression counter ratified as D-004-1 — the
// comparand the stale-replay guard compares `expectedRunVersion` against
// (I-004-7). `sessionId` and `state` are derived from the
// `Spec-006 §Run Lifecycle (run_lifecycle)` projection; there is no
// standalone runs table.
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
