// Session event contracts: the event envelope, the closed set of event types and categories,
// and the payload variants of the strict `SessionEvent` union.
//
// The set of event types (`SessionEventType`) is closed, but a payload variant is registered for
// only some of them: membership in the set is type registration, not payload support. Adding a
// variant later is additive.
//
// `version` is a `"MAJOR.MINOR"` string, never a number: comparing "1.10" with "1.9" as text is
// wrong, so the reader parses both parts as integers. `EventEnvelopeVersionSchema` in
// `./event-core.js` checks the format.

import { z } from "zod";

// Only these are used here; the leaf's other exports are re-exported by the seam below.
import {
  EVENT_FIELD_MAX_LEN,
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "./event-core.js";
// None of these payload files imports this file, directly or through another module, so no
// import here can close a cycle between eagerly built Zod schemas.
import {
  AgentProviderBindingChangedPayloadSchema,
  AgentProviderBindingChangeFailedPayloadSchema,
  type AgentProviderBindingChangedPayload,
  type AgentProviderBindingChangeFailedPayload,
} from "./agent-provider-binding.js";
import {
  ApprovalCanceledPayloadSchema,
  ApprovalDenialOverriddenPayloadSchema,
  ApprovalRememberedPayloadSchema,
  ApprovalRequestedPayloadSchema,
  ApprovalResolvedPayloadSchema,
  ApprovalReviewerDeniedPayloadSchema,
  ApprovalRuleRevokedPayloadSchema,
  type ApprovalCanceledPayload,
  type ApprovalDenialOverriddenPayload,
  type ApprovalRememberedPayload,
  type ApprovalRequestedPayload,
  type ApprovalResolvedPayload,
  type ApprovalReviewerDeniedPayload,
  type ApprovalRuleRevokedPayload,
} from "./approval.js";
import { CloudTaskUpdatedPayloadSchema, type CloudTaskUpdatedPayload } from "./cloud.js";
import { CommandEndedPayloadSchema, type CommandEndedPayload } from "./command.js";
import {
  BackupCompletedPayloadSchema,
  BackupFailedPayloadSchema,
  BackupRestoredPayloadSchema,
  type BackupCompletedPayload,
  type BackupFailedPayload,
  type BackupRestoredPayload,
} from "./daemon-backup.js";
import { GitSettledPayloadSchema, type GitSettledPayload } from "./gitflow/local.js";
import {
  McpServerConfigChangedPayloadSchema,
  McpServerOauthCompletedPayloadSchema,
  McpServerStatusChangedPayloadSchema,
  McpServerTrustChangedPayloadSchema,
  McpToolOverrideChangedPayloadSchema,
  type McpServerConfigChangedPayload,
  type McpServerOauthCompletedPayload,
  type McpServerStatusChangedPayload,
  type McpServerTrustChangedPayload,
  type McpToolOverrideChangedPayload,
} from "./mcp-governance.js";
import { uuidTextFormSchema } from "./internal/branded.js";
import { NodeIdSchema, type NodeId } from "./node-id.js";
import {
  PlanAcceptedPayloadSchema,
  PlanHandedOffPayloadSchema,
  PlanProposedPayloadSchema,
  type PlanAcceptedPayload,
  type PlanHandedOffPayload,
  type PlanProposedPayload,
} from "./plan.js";
import { DRIVER_FAILURE_DETAIL_MAX_LEN, RunIdSchema, type RunId } from "./provider-driver.js";
import { PtyControlChangedPayloadSchema, type PtyControlChangedPayload } from "./pty.js";
import { QuestionAskedPayloadSchema, type QuestionAskedPayload } from "./question.js";
import { RelayPinRefusedPayloadSchema, type RelayPinRefusedPayload } from "./relay.js";
import { RepoWorkspaceLifecyclePayloadSchema, type RepoWorkspaceLifecyclePayload } from "./repo.js";
import {
  RunRecoveryResolvedPayloadSchema,
  type RunRecoveryResolvedPayload,
} from "./run-control.js";
import {
  ModerationReviewFlaggedPayloadSchema,
  RunStepLimitReachedPayloadSchema,
  SessionNoticePayloadSchema,
  SessionSideQuestionAnsweredPayloadSchema,
  type ModerationReviewFlaggedPayload,
  type RunStepLimitReachedPayload,
  type SessionNoticePayload,
  type SessionSideQuestionAnsweredPayload,
} from "./session-controls.js";
import {
  SessionGoalClearedPayloadSchema,
  SessionGoalUpdatedPayloadSchema,
  type SessionGoalClearedPayload,
  type SessionGoalUpdatedPayload,
} from "./session-goal.js";
import {
  SessionRestoreFinishedPayloadSchema,
  type SessionRestoreFinishedPayload,
} from "./session-restore.js";
import { SessionConvertedPayloadSchema, type SessionConvertedPayload } from "./session-convert.js";
import { RunQueuedPayloadSchema, type RunQueuedPayload } from "./run-queued.js";
import { SessionCreatedPayloadSchema, type SessionCreatedPayload } from "./session-created.js";
import {
  SessionIdSchema,
  SessionLifecycleChangePayloadSchema,
  SessionMarkChangePayloadSchema,
  SessionRenamedPayloadSchema,
  wireFreeFormString,
  type SessionId,
  type SessionLifecycleChangePayload,
  type SessionMarkChangePayload,
  type SessionRenamedPayload,
} from "./session.js";
import {
  SessionBranchChangedPayloadSchema,
  SessionSweptToRepoRootPayloadSchema,
  WorktreeCreatedPayloadSchema,
  WorktreeRetiredPayloadSchema,
  type SessionBranchChangedPayload,
  type SessionSweptToRepoRootPayload,
  type WorktreeCreatedPayload,
  type WorktreeRetiredPayload,
} from "./worktree-events.js";
import { WorktreeLifecyclePayloadSchema, type WorktreeLifecyclePayload } from "./worktree.js";
import {
  WorkflowCanceledPayloadSchema,
  WorkflowResultsPostedPayloadSchema,
  WorkflowResumedPayloadSchema,
  WorkflowStartedPayloadSchema,
  type WorkflowCanceledPayload,
  type WorkflowResultsPostedPayload,
  type WorkflowResumedPayload,
  type WorkflowStartedPayload,
} from "./workflow-run-control.js";
import {
  WorkflowGateResolvedPayloadSchema,
  WorkflowStepCanceledPayloadSchema,
  WorkflowStepFailedPayloadSchema,
  WorkflowStepFinishedPayloadSchema,
  WorkflowStepSkippedPayloadSchema,
  WorkflowStepStartedPayloadSchema,
  type WorkflowGateResolvedPayload,
  type WorkflowStepEventPayload,
  type WorkflowStepFailedPayload,
  type WorkflowStepFinishedPayload,
  type WorkflowStepSkippedPayload,
  type WorkflowStepStartedPayload,
} from "./workflow-run-step.js";

// The literal `category` on each union variant is the registry's category for its type, so a
// mismatched pair (a `session.created` under `approval_flow`) fails at parse time instead of
// being stored under the wrong category and breaking replay. Declaration order does not affect
// the canonical bytes, which carry the literal strings; adding a category is a MINOR bump.

/** The family a session event belongs to; every event type maps to exactly one. */
export type EventCategory =
  | "run_lifecycle"
  | "assistant_output"
  | "tool_activity"
  | "interactive_request"
  | "artifact_publication"
  | "session_lifecycle"
  | "approval_flow"
  | "usage_telemetry"
  | "runtime_node_lifecycle"
  | "recovery_events"
  | "security_events"
  | "event_maintenance"
  | "policy_events"
  | "orchestration_admission"
  | "mcp_governance"
  | "workflow_lifecycle"
  | "workflow_phase_lifecycle"
  | "workflow_parallel_coordination"
  | "workflow_gate_resolution";
/** Wire schema for {@link EventCategory}. */
export const EventCategorySchema: z.ZodType<EventCategory> = z.enum([
  "run_lifecycle",
  "assistant_output",
  "tool_activity",
  "interactive_request",
  "artifact_publication",
  "session_lifecycle",
  "approval_flow",
  "usage_telemetry",
  "runtime_node_lifecycle",
  "recovery_events",
  "security_events",
  "event_maintenance",
  "policy_events",
  "orchestration_admission",
  "mcp_governance",
  "workflow_lifecycle",
  "workflow_phase_lifecycle",
  "workflow_parallel_coordination",
  "workflow_gate_resolution",
]);

// Declared in `./event-core.js` and re-exported here so importers keep using this file; change
// any of them there. Type-only re-exports need `export type` under `isolatedModules` and
// `verbatimModuleSyntax`.
export type { CapabilityDetails, EventEnvelopeVersion } from "./event-core.js";
export {
  CAPABILITY_CONTRACT_VERSION_MAX_LEN,
  CapabilityDetailsSchema,
  EVENT_ENVELOPE_VERSION_MAX_LEN,
  EVENT_ENVELOPE_VERSION_PATTERN,
  EVENT_FIELD_MAX_LEN,
  EventEnvelopeVersionSchema,
} from "./event-core.js";

/**
 * Three-way comparison of two envelope versions (-1, 0, 1), numeric on MAJOR then MINOR, so a
 * below-floor check is `compareEventEnvelopeVersion(clientVersion, floor) < 0`. It lives in
 * contracts so the version-floor gate and any other consumer that orders envelope versions share
 * one comparator. It is not the `semver` library: the type has exactly two segments, so semver's
 * range and prerelease handling would be dead weight.
 *
 * The brand guarantees well-formed input and is not re-checked here; a cast that carries a
 * non-integer segment throws `SyntaxError` at `BigInt()` instead of silently misordering.
 */
export function compareEventEnvelopeVersion(
  a: EventEnvelopeVersion,
  b: EventEnvelopeVersion,
): -1 | 0 | 1 {
  // `BigInt`, not `Number`, keeps the compare exact above `Number.MAX_SAFE_INTEGER`, where distinct
  // versions would collapse to one float; the version floor reads this ordering. The cast holds
  // because the schema guarantees two non-negative integer segments within its length cap.
  const [aMajor, aMinor] = a.split(".").map(BigInt) as [bigint, bigint];
  const [bMajor, bMinor] = b.split(".").map(BigInt) as [bigint, bigint];
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  return 0;
}

// Per-field length caps are a second line of defense behind the HTTP layer's body-size limit, so
// a non-HTTP caller (daemon IPC, replay, fixtures) cannot get a huge field past the parser.
// Raising one is a contract bump. Free-form string fields use `wireFreeFormString` (session.ts),
// which bounds length and rejects whitespace-only and NUL-containing values; NUL would corrupt
// the trace lines emitted from `correlationId` and `causationId`.

// Two layers share this file.
//
// - `EventEnvelopeSchema` is the version-tolerant carrier. `type` is a bounded free-form string,
//   not the `SessionEventType` union: a newer producer may add types, and a reader must store an
//   envelope whose type it does not know as a version stub, never drop or reject it. `payload`
//   is an open record, so unknown fields from a newer producer are kept verbatim.
// - `SessionEventSchema` is the strict layer, where an unknown type or a category/type mismatch
//   fails at parse time.
//
// The tolerance has two limits. `category` stays the closed `EventCategorySchema` enum, because
// a reader with no registry rows for a category cannot route it; a new category is a MINOR bump
// that ships with code. The top-level member set is closed (`.strict()`) at the eleven fields
// below: stripping an unknown member would desync the parsed value from the stored canonical
// bytes, and new data goes in `payload`. `pii_payload` is a storage column, not an envelope
// member.

/**
 * The largest `sequence` an envelope may carry: accepted at this value, refused one above it.
 * It is not a tunable. `sequence` travels as an IEEE-754 double, which holds integers exactly
 * only up to 2^53 - 1; above that distinct sequences become the same number, so two different
 * events would share a replay key and canonicalize to identical bytes. Raising this changes
 * nothing (`.int()` enforces the same ceiling); a larger range needs a wider wire type such as
 * a string-encoded bigint.
 *
 * It is named so an out-of-range value reports why. A caller that builds an envelope without
 * parsing it is covered by `packages/runtime-daemon/src/events/canonicalizer.ts`.
 */
export const EVENT_ENVELOPE_SEQUENCE_MAX: number = Number.MAX_SAFE_INTEGER;

/**
 * Append-time ceiling on `canonical_bytes(row)`: 32 KiB. The event log re-publishes canonical
 * bytes base64-encoded in a chunk that rides one relay frame with no fragmentation, so a larger
 * row could never travel. The append path enforces it (`daemon.event_canonical_bytes_exceeded`),
 * and so does the purge when it builds stubs. Unlike the sequence ceiling this is a policy knob:
 * payloads carry lengths and references, never inline bulk content, so the value is headroom over
 * every cataloged shape. Raise it by changing the payload corpus first, then this value, then
 * both enforcement sites.
 */
export const EVENT_CANONICAL_BYTES_MAX: number = 32768;

/**
 * The `sessionId` that daemon-scope events (rows describing the machine rather than a
 * conversation) bind to: the RFC 9562 Max UUID. `session_events` sequences per session and
 * `EventEnvelope.sessionId` is not nullable, so these rows get a sequence of their own. The
 * all-ones value has no valid version nibble, so no versioned session id can equal it. The
 * constant is minted through `SessionIdSchema.parse` with the literal uncast, so if the id check
 * ever stops admitting the Max UUID this module throws at import instead of the daemon emitting a
 * sentinel that no longer parses.
 */
export const DAEMON_SCOPE_SENTINEL_SESSION_ID: SessionId = SessionIdSchema.parse(
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
);

/**
 * The canonical event message; every session event travels in this envelope, and
 * {@link EventEnvelopeSchema} is its validator. Each member maps to a `session_events` column;
 * storage-only columns are deliberately not members.
 */
export interface EventEnvelope {
  // Opaque on the wire — see the `id` note in `buildCommonShape()`.
  id: string;
  sessionId: SessionId;
  // Daemon-assigned, strictly increasing per session: the replay key. Bounded by
  // {@link EVENT_ENVELOPE_SEQUENCE_MAX}, above which distinct sequences would share a double.
  sequence: number;
  // ISO 8601. The narrower canonical form (RFC 3339 UTC, ms precision) is applied at append time
  // by the event log's normalization, not here.
  occurredAt: string;
  category: EventCategory;
  /**
   * Deliberately `string`, not `SessionEventType`: the envelope is the version-tolerant carrier,
   * and a reader must parse an envelope whose type it does not know in order to store it as a
   * version stub. Do not tighten this to the census union.
   */
  type: string;
  /**
   * A user or agent id; `null` or absent for system events. Present-null and absent are
   * distinguishable on the wire, and an empty string is rejected as a producer bug.
   */
  actor?: string | null | undefined;
  /**
   * Category-specific fields, open by design: higher-MINOR fields are kept verbatim. The one
   * exception is an own `__proto__` key, which is rejected because Zod's record parser cannot
   * preserve it and silently stripping it is forbidden (see the pre-guard on
   * {@link EventEnvelopeSchema}). May carry the epoch stamp: {@link SourceEpochSchema},
   * {@link SourcePositionSchema} and {@link withEpochStamp}.
   */
  payload: Record<string, unknown>;
  // Optional, not nullable: absent is the only no-value state for the correlation pair; `actor`
  // alone uses null for the system.
  correlationId?: string | undefined;
  causationId?: string | undefined;
  /**
   * Producer-set `"MAJOR.MINOR"` string, never numeric on the wire. The emitting daemon writes it
   * at emit time; it is never copied from a received event and never rewritten on read (upcasters
   * change the in-memory form only), so the row's `.version` is part of its durable identity. The
   * {@link EventEnvelopeVersion} brand keeps unvalidated strings out.
   */
  version: EventEnvelopeVersion;
}

// Shared by `EventEnvelopeSchema` and every variant, so shared-field validation cannot drift.
// `category` is left out: variants need it as a literal so a category/type mismatch fails to
// parse, while the envelope uses the full enum.

const buildCommonShape = () => ({
  // Opaque on the wire: any non-empty bounded string (length cap, whitespace and NUL guards).
  // The daemon assigns UUID v7 but the wire contract does not require it.
  id: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.id"),
  sessionId: SessionIdSchema,
  // A non-negative integer the daemon assigns strictly increasing per session; a gap is a defect.
  // The `.max()` decides nothing `.int()` does not already decide (it enforces the same ceiling);
  // it exists so an out-of-range value reports why the ceiling exists. It is a separate check
  // because a check-level `error` on `.int()` would also apply to the `invalid_type` issue a
  // fractional value raises, and `1.5` would be reported as an overflow.
  sequence: z
    .number()
    .int()
    .nonnegative()
    .max(EVENT_ENVELOPE_SEQUENCE_MAX, {
      message: `sequence must be at most ${EVENT_ENVELOPE_SEQUENCE_MAX} (Number.MAX_SAFE_INTEGER): above it distinct sequences collapse onto the same IEEE-754 double, so two different events would carry the same replay key.`,
    }),
  // ISO 8601; `offset: true` also accepts numeric RFC 3339 offsets ("+00:00"). The canonical form
  // (UTC `Z`, millisecond precision) is applied at append time, not at the wire.
  occurredAt: z.iso.datetime({ offset: true }),
  // A user or agent id, or null or absent for system events. The helper rejects empty,
  // whitespace-only and NUL strings, so a system event sends `null` or omits the key.
  // `.nullable()` comes after the helper so its string checks run only on strings.
  actor: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.actor").nullable().optional(),
  correlationId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.correlationId").optional(),
  causationId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.causationId").optional(),
  version: EventEnvelopeVersionSchema,
});

/**
 * Runtime validator for {@link EventEnvelope}: exactly the eleven canonical members. Their
 * serialized order is RFC 8785's, applied by the canonicalizer, not here. `version` is the
 * branded, producer-set {@link EventEnvelopeVersion} and is never rewritten on read.
 */
export const EventEnvelopeSchema: z.ZodType<EventEnvelope> = z
  .object({
    // Shared fields, single-sourced with the variants.
    ...buildCommonShape(),
    category: EventCategorySchema,
    // Bounded free-form, not the census union (see the layering note above); the same wire
    // guards apply, and every census literal passes.
    type: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.type"),
    // Open record behind a raw-input pre-guard. Unknown keys from a higher-MINOR producer are kept
    // verbatim, except an own `__proto__` key: Zod's record parser skips it, so two different wire
    // strings would parse to one value. The pre-guard rejects that key loudly. It must inspect the
    // raw value (`superRefine` before the `.pipe`), since a refine on the record's output cannot
    // see a key already dropped.
    payload: z
      .unknown()
      .superRefine((value, ctx) => {
        if (typeof value === "object" && value !== null && Object.hasOwn(value, "__proto__")) {
          ctx.addIssue({
            code: "custom",
            message:
              "EventEnvelope.payload MUST NOT carry an own __proto__ key — the record parser cannot preserve it, and silent stripping is forbidden.",
          });
        }
      })
      .pipe(z.record(z.string(), z.unknown())),
  })
  // Membership is closed although the carrier is otherwise tolerant: stripping an unknown member
  // would desync the parsed value from the stored canonical bytes. `pii_payload` is a storage
  // column, never a member.
  .strict();

// `sourceEpoch` + `sourcePosition` are the one cross-cutting payload pair. A non-lifecycle row
// that the run engine attributes to a superseded execution epoch (appended late, after a
// rollback) carries both; a current-epoch row carries neither. Absence is the current-epoch
// signal, so the stamp is never fabricated.
//
// The pair is payload, not an envelope member: it sits in the canonical bytes while the envelope
// stays at eleven members, so adding it needed no envelope version bump. Once a "1.0" envelope
// has been emitted, a new optional payload field takes a MINOR bump instead.
//
// Admission is keyed on run-scopedness (the payload carries `runId`), not on family alone. Seven
// variants take the stamp, each with a required `runId`: `assistant.message`,
// `assistant.thinking_update`, `tool.invoked`, `tool.result`, `tool.error`, `command.ended` and
// `usage.model_rerouted`. Every other branch stays unwrapped. A lifecycle row from a superseded
// epoch is absorbed at the epoch check rather than appended late, and so is a permission ask or a
// question, because such an ask never reaches a person. `usage.rate_limit_update` has no `runId`,
// so a stamp on it would be unattributable, and `git.settled` names a run on only some causes.
// A branch that should take the stamp must be wrapped: a strict payload without it rejects a
// stamped row at the strict layer. The tolerant `EventEnvelopeSchema` accepts a stamped row
// either way, so an unwrapped branch costs interpretation, not transport or the canonical bytes.
// `__tests__/event-source-epoch.test.ts` walks the live union and fails a run-scoped branch of an
// admitting family that is unwrapped, and any other branch that is wrapped.
//
// This file owns the typed shape only. What an epoch means (`0` is before any rollback; each
// accepted `run.rolled_back` advances it) belongs to the run state machine, and stamping and
// late-event handling belong to the daemon.

/**
 * The execution epoch a late-appended non-lifecycle row is attributed to: a nonnegative integer,
 * `0` being before any rollback. What advances an epoch is defined by the run state machine, not
 * here.
 */
export type SourceEpoch = number;
/** Wire schema for {@link SourceEpoch}. */
export const SourceEpochSchema: z.ZodType<SourceEpoch> = z.number().int().nonnegative();

/**
 * The normalized session position (the turn-boundary vocabulary of `targetPosition`) that a
 * stamped row occupies within its source epoch. It is the stamp's companion because no run-scoped
 * family's payload carries a native position, and the supersede cutoff (`turn > targetPosition`)
 * cannot rank a late row against its epoch's surviving prefix without one.
 */
export type SourcePosition = number;
/** Wire schema for {@link SourcePosition}. */
export const SourcePositionSchema: z.ZodType<SourcePosition> = z.number().int().nonnegative();

// `as const`, not a written annotation: the literal type stays evident to `isolatedDeclarations`
// and the keys work as computed property names in `withEpochStamp`.
/** Payload key of the epoch stamp; ingestion writes it and the supersede projection reads it. */
export const SOURCE_EPOCH_PAYLOAD_KEY = "sourceEpoch" as const;
/** Payload key of the position stamp; it moves with {@link SOURCE_EPOCH_PAYLOAD_KEY}. */
export const SOURCE_POSITION_PAYLOAD_KEY = "sourcePosition" as const;

/**
 * Adds the optional `sourceEpoch` + `sourcePosition` stamp to a run-scoped strict payload schema
 * and refines that the pair travels with a present, non-null `runId`. Whether a branch takes the
 * stamp is the caller's call; see the admission rule above.
 *
 * - The pair is declared here once: the generic constraint refuses a shape that already declares
 *   either key, so a registrant cannot hand-roll the pair or wrap twice.
 * - `.extend()` keeps the payload's strictness. The `$strict` parameter states the precondition
 *   but Zod's config type parameters are interchangeable, so wrapping a non-strict payload
 *   returns a non-strict schema; the admission test in `event-source-epoch.test.ts` refuses a
 *   wrapped branch that is not strict.
 * - The stamp is optional and absence means the current epoch; a required key would force
 *   producers to fabricate an attribution.
 * - Either key requires both, and a non-null `runId`: epochs and positions are run-local and the
 *   supersede cutoff reads run identity, epoch and position together. Null is refused as well as
 *   absent, because a nullable `runId` spells "no run" the way absence does. `runId` is checked
 *   at runtime because the helper is generic over the shape, so a payload with no `runId` key
 *   (`usage.rate_limit_update`) rejects every stamped row.
 */
export function withEpochStamp<
  Shape extends z.core.$ZodShape & { sourceEpoch?: never; sourcePosition?: never },
>(
  payloadSchema: z.ZodObject<Shape, z.core.$strict>,
): z.ZodObject<
  Shape & {
    sourceEpoch: z.ZodOptional<z.ZodType<SourceEpoch>>;
    sourcePosition: z.ZodOptional<z.ZodType<SourcePosition>>;
  },
  z.core.$strict
> {
  // `.extend()` is typed `Extend<Shape, U>`, which TypeScript cannot reduce while `Shape` is
  // generic, so the return cast asserts the intersection that the constraint steers every real
  // caller into (a shape that declares neither stamp key). `.superRefine()` returns `this`.
  //
  // A JS caller that bypasses the constraint gets a throw from `util.extend` if the colliding base
  // schema has refinements; a check-free one is silently overridden, since the stamp schemas are
  // spread last. Runtime behavior is pinned in `__tests__/event-source-epoch.test.ts`.
  return (
    payloadSchema
      // Keyed off the exported consts so the schema keys and the wire names cannot drift apart.
      .extend({
        [SOURCE_EPOCH_PAYLOAD_KEY]: SourceEpochSchema.optional(),
        [SOURCE_POSITION_PAYLOAD_KEY]: SourcePositionSchema.optional(),
      })
      .superRefine((value, ctx) => {
        // A plain object; the stamp and `runId` keys are reachable only by index because the
        // helper is generic over the shape.
        const stamped = value as Record<string, unknown>;
        const hasEpoch = stamped[SOURCE_EPOCH_PAYLOAD_KEY] !== undefined;
        const hasPosition = stamped[SOURCE_POSITION_PAYLOAD_KEY] !== undefined;
        // Unstamped is the current-epoch default, not a violation.
        if (!hasEpoch && !hasPosition) return;
        if (!hasPosition) {
          ctx.addIssue({
            code: "custom",
            path: [SOURCE_POSITION_PAYLOAD_KEY],
            message: `A ${SOURCE_EPOCH_PAYLOAD_KEY} stamp REQUIREs ${SOURCE_POSITION_PAYLOAD_KEY}: the supersede cutoff cannot rank the row against its epoch's surviving prefix without a position.`,
          });
        }
        if (!hasEpoch) {
          ctx.addIssue({
            code: "custom",
            path: [SOURCE_EPOCH_PAYLOAD_KEY],
            message: `A ${SOURCE_POSITION_PAYLOAD_KEY} stamp REQUIREs ${SOURCE_EPOCH_PAYLOAD_KEY}: a position without its epoch names no epoch to supersede against.`,
          });
        }
        // `runId` is the run-identity key run-scoped payloads carry. Test null and undefined
        // explicitly: a truthiness test would also reject `""`, which the base schema's `.min(1)`
        // owns. Two `===` clauses because `eqeqeq` forbids `== null`.
        if (stamped["runId"] === undefined || stamped["runId"] === null) {
          ctx.addIssue({
            code: "custom",
            path: ["runId"],
            message: `A ${SOURCE_EPOCH_PAYLOAD_KEY}/${SOURCE_POSITION_PAYLOAD_KEY} stamp REQUIREs a present, non-null runId: epochs and positions are run-local, so an epoch stamp on a row with no run identity is unattributable.`,
          });
        }
      }) as unknown as z.ZodObject<
      Shape & {
        sourceEpoch: z.ZodOptional<z.ZodType<SourceEpoch>>;
        sourcePosition: z.ZodOptional<z.ZodType<SourcePosition>>;
      },
      z.core.$strict
    >
  );
}

// session.created: the payload is session-created.ts's.

// Variant interfaces extend the envelope, narrowing `type`, `category` and `payload` to the
// variant's literals. Adding or narrowing an envelope member surfaces as a type error in every
// variant schema annotation, but removing one does not (Zod's output type is covariant), which
// is why the test suite also pins the eleven envelope keys.
/** Emitted when a session is admitted. */
export interface SessionCreatedEvent extends EventEnvelope {
  type: "session.created";
  category: "session_lifecycle";
  payload: SessionCreatedPayload;
}
/** Wire schema for {@link SessionCreatedEvent}. */
export const SessionCreatedEventSchema: z.ZodType<SessionCreatedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("session.created"),
    category: z.literal("session_lifecycle"),
    payload: SessionCreatedPayloadSchema,
  })
  .strict();

// repo.* and workspace.*: six variants sharing repo.ts's `RepoWorkspaceLifecyclePayloadSchema`,
// so their payload cannot drift between them. The `worktree.*` variants below use the same
// family shape over their own state vocabulary. None is run-scoped (no `runId`), so none takes
// the epoch stamp.

/** Emitted when `repo.attach` admits a local path as a durable repo mount. */
export interface RepoAttachedEvent extends EventEnvelope {
  type: "repo.attached";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
/** Wire schema for {@link RepoAttachedEvent}. */
export const RepoAttachedEventSchema: z.ZodType<RepoAttachedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("repo.attached"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

/** Emitted when a mount moves to the terminal `detached` state. */
export interface RepoDetachedEvent extends EventEnvelope {
  type: "repo.detached";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
/** Wire schema for {@link RepoDetachedEvent}. */
export const RepoDetachedEventSchema: z.ZodType<RepoDetachedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("repo.detached"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

/** Emitted when a workspace's (re)provisioning begins. */
export interface WorkspacePreparingEvent extends EventEnvelope {
  type: "workspace.preparing";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
/** Wire schema for {@link WorkspacePreparingEvent}. */
export const WorkspacePreparingEventSchema: z.ZodType<WorkspacePreparingEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("workspace.preparing"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

/** Emitted when provisioning completes and the execution root is bound. */
export interface WorkspaceReadyEvent extends EventEnvelope {
  type: "workspace.ready";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
/** Wire schema for {@link WorkspaceReadyEvent}. */
export const WorkspaceReadyEventSchema: z.ZodType<WorkspaceReadyEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("workspace.ready"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

/**
 * Emitted when a workspace becomes unavailable: a failed reprovision, or a path that went away
 * after binding. Write runs are blocked until repair.
 */
export interface WorkspaceStaleEvent extends EventEnvelope {
  type: "workspace.stale";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
/** Wire schema for {@link WorkspaceStaleEvent}. */
export const WorkspaceStaleEventSchema: z.ZodType<WorkspaceStaleEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("workspace.stale"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

/** Emitted once per dependent workspace archived by the detach cascade. */
export interface WorkspaceArchivedEvent extends EventEnvelope {
  type: "workspace.archived";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
/** Wire schema for {@link WorkspaceArchivedEvent}. */
export const WorkspaceArchivedEventSchema: z.ZodType<WorkspaceArchivedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("workspace.archived"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

// worktree.*: five variants. Their payload is the family factory instantiated over
// `WorktreeStateSchema` (`WorktreeLifecyclePayloadSchema` in worktree.ts), so a worktree event
// claiming a workspace state stays a parse error. `worktree.created` and `worktree.retired` add
// the members worktree-events.ts declares. There is no `worktree.failed`: the worktree row's
// `-> failed` transition emits no worktree event, because `workspace.stale` already records the
// failure, and `SessionEventSchema` must keep rejecting it (pinned in
// `__tests__/worktree.test.ts`). None is run-scoped, so none takes the epoch stamp.

/** Emitted with worktree row creation; carries the kept copy a put-back came from, if any. */
export interface WorktreeCreatedEvent extends EventEnvelope {
  type: "worktree.created";
  category: "session_lifecycle";
  payload: WorktreeCreatedPayload;
}
/** Wire schema for {@link WorktreeCreatedEvent}. */
export const WorktreeCreatedEventSchema: z.ZodType<WorktreeCreatedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.created"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeCreatedPayloadSchema,
  })
  .strict();

/** Emitted on the `creating -> ready` transition: the checkout is bound as an execution root. */
export interface WorktreeReadyEvent extends EventEnvelope {
  type: "worktree.ready";
  category: "session_lifecycle";
  payload: WorktreeLifecyclePayload;
}
/** Wire schema for {@link WorktreeReadyEvent}. */
export const WorktreeReadyEventSchema: z.ZodType<WorktreeReadyEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.ready"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeLifecyclePayloadSchema,
  })
  .strict();

/** Emitted on the `-> dirty` transition: uncommitted work was observed in the checkout. */
export interface WorktreeDirtyEvent extends EventEnvelope {
  type: "worktree.dirty";
  category: "session_lifecycle";
  payload: WorktreeLifecyclePayload;
}
/** Wire schema for {@link WorktreeDirtyEvent}. */
export const WorktreeDirtyEventSchema: z.ZodType<WorktreeDirtyEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.dirty"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeLifecyclePayloadSchema,
  })
  .strict();

/** Emitted on the `-> merged` transition: the worktree's branch has merged back. */
export interface WorktreeMergedEvent extends EventEnvelope {
  type: "worktree.merged";
  category: "session_lifecycle";
  payload: WorktreeLifecyclePayload;
}
/** Wire schema for {@link WorktreeMergedEvent}. */
export const WorktreeMergedEventSchema: z.ZodType<WorktreeMergedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.merged"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeLifecyclePayloadSchema,
  })
  .strict();

/**
 * Emitted on the `-> retired` transition, recorded and evented before any disk mutation; cleanup
 * is asynchronous and idempotent. Carries the kept copy when a discard kept one.
 */
export interface WorktreeRetiredEvent extends EventEnvelope {
  type: "worktree.retired";
  category: "session_lifecycle";
  payload: WorktreeRetiredPayload;
}
/** Wire schema for {@link WorktreeRetiredEvent}. */
export const WorktreeRetiredEventSchema: z.ZodType<WorktreeRetiredEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.retired"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeRetiredPayloadSchema,
  })
  .strict();

// event.compacted: the purge receipt. Its payload is declared here because the daemon emits the
// row itself. It re-spells `occurredAt` beside the envelope's own, as `session.created`'s payload
// re-spells `sessionId`, rather than deduplicating. The row is a node-level record bound to the
// daemon-scope sentinel `sessionId`; that binding is the emitter's job and the schema does not
// narrow to it, so an `event.compacted` for one session may carry that session's id. It is not
// run-scoped, so it takes no epoch stamp.

/**
 * A `session_events.sequence` value carried inside a payload (a range end or an implicated row).
 * It takes the envelope's ceiling, or an endpoint could not name the row it points at and two
 * ranges could disagree about which rows they cover.
 */
const payloadSequenceSchema = z
  .number()
  .int()
  .nonnegative()
  .max(EVENT_ENVELOPE_SEQUENCE_MAX, {
    message: `A payload sequence value must be at most ${EVENT_ENVELOPE_SEQUENCE_MAX} (Number.MAX_SAFE_INTEGER), the same injectivity ceiling EventEnvelope.sequence takes.`,
  });

// The event_maintenance payload base; `occurredAt` re-spells the envelope's own.
const buildEventMaintenanceBaseShape = () => ({
  nodeId: NodeIdSchema,
  // The batch or pass correlation id: opaque, bounded free-form; no format is fixed.
  operationId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "event_maintenance.operationId"),
  occurredAt: z.iso.datetime({ offset: true }),
});

/** One session a deletion removed, with the range of its rows the deletion stubbed. */
export interface EventCompactedRemovedSession {
  sessionId: SessionId;
  fromSeq: number;
  toSeq: number;
}
const EventCompactedRemovedSessionSchema: z.ZodType<EventCompactedRemovedSession> = z
  .object({
    sessionId: SessionIdSchema,
    fromSeq: payloadSequenceSchema,
    toSeq: payloadSequenceSchema,
  })
  .strict()
  .refine((removed) => removed.fromSeq <= removed.toSeq, {
    message: "a stubbed range starts at or before its end",
    path: ["toSeq"],
  });

/**
 * `event.compacted` — the receipt of one session deletion (`Delete old data`):
 * every session it removed and the range of rows it replaced with audit stubs
 * in each. It is written only when a deletion stubbed rows, so it names at least
 * one session.
 */
export type EventCompactedPayload = {
  nodeId: NodeId;
  operationId: string;
  occurredAt: string;
  removedSessions: EventCompactedRemovedSession[];
};
/** Wire schema for {@link EventCompactedPayload}. */
export const EventCompactedPayloadSchema: z.ZodType<EventCompactedPayload> = z
  .object({
    ...buildEventMaintenanceBaseShape(),
    removedSessions: z.array(EventCompactedRemovedSessionSchema).min(1),
  })
  .strict();

/** Emitted once per session deletion that stubbed rows. */
export interface EventCompactedEvent extends EventEnvelope {
  type: "event.compacted";
  category: "event_maintenance";
  payload: EventCompactedPayload;
}
/** Wire schema for {@link EventCompactedEvent}. */
export const EventCompactedEventSchema: z.ZodType<EventCompactedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("event.compacted"),
    category: z.literal("event_maintenance"),
    payload: EventCompactedPayloadSchema,
  })
  .strict();

// Machine-authored content: `assistant.message`, `assistant.thinking_update`, `tool.invoked`,
// `tool.result` and `tool.error`.
//
// The body is not a payload member. It lives in `session_events.content_payload`, sealed under the
// session's content key and left out of the canonical bytes like `pii_payload`; `payload` carries
// only its length and whether it was cut. A reader pairs the event with the opened body
// ({@link HydratedSessionEvent}). The schemas are `.strict()`, so a body spliced into `payload`
// fails validation.
//
// Two families, not one schema: the assistant pair has `contentType` and no tool identity; the
// tool trio has a required `toolName` beside optional `toolCallId` and `durationMs`, and no
// `contentType`.
//
// Member ownership splits at the sealing codec. `contentType` is the producer's, which knows the
// media type. The two {@link MachineContentDescriptor} members are the codec's: facts about what
// it sealed, determined after the plaintext bound was applied. A producer that pre-carries either
// is refused at the write path.
//
// All five are run-scoped (`runId`), so each takes the epoch stamp.

/**
 * The payload key carrying the body's pre-truncation UTF-8 byte length, so a truncated row still
 * reports how much was dropped. It survives compaction in the audit stub, where it is the whole
 * remaining record of the destroyed body's size.
 */
export const CONTENT_LENGTH_PAYLOAD_KEY = "contentLength" as const;

/**
 * The payload key marking a body stored as a prefix. Present only as `true` and omitted when the
 * stored body is complete, never written as `false`: absence is the completeness signal, and an
 * omitted key keeps a complete row's canonical bytes identical to what they would be without the
 * bound.
 */
export const CONTENT_TRUNCATED_PAYLOAD_KEY = "contentTruncated" as const;

/**
 * The per-row plaintext ceiling for `session_events.content_payload`: 262144 bytes (256 KiB) of
 * UTF-8. The column holds machine-scale text (a tool result is often a file dump or a command's
 * whole stdout), so an over-bound body is truncated at a codepoint boundary, never refused or
 * dropped: refusing the append would lose the turn, and dropping the body would misreport that
 * the turn never happened.
 */
export const CONTENT_PAYLOAD_PLAINTEXT_MAX: number = 262_144;

// A type alias, not an interface: `EventEnvelope.payload` is `Record<string, unknown>`, and
// TypeScript gives an implicit index signature to object-literal types but never to an interface,
// so an interface payload could not satisfy the envelope it extends.
/**
 * The two codec-owned descriptive members every body-bearing payload carries. Each is optional:
 * a row with no body (an `assistant.message` whose body the driver could not read, a
 * `tool.invoked` with no arguments) is valid, and requiring them would make its producer invent a
 * length for bytes that do not exist.
 */
export type MachineContentDescriptor = {
  /** Pre-truncation UTF-8 byte length of the body that was sealed. */
  contentLength?: number | undefined;
  /** Present as `true` only when the stored body is a prefix; never `false`. */
  contentTruncated?: true | undefined;
};

/** Payload of `assistant.message` and `assistant.thinking_update`. */
export type AssistantOutputPayload = MachineContentDescriptor & {
  sessionId: SessionId;
  runId: string;
  /** Media type of the body, set by the PRODUCER and not by the codec. */
  contentType?: string | undefined;
  sourceEpoch?: SourceEpoch | undefined;
  sourcePosition?: SourcePosition | undefined;
};

/** Payload of `tool.invoked`, `tool.result` and `tool.error`. */
export type ToolActivityPayload = MachineContentDescriptor & {
  sessionId: SessionId;
  runId: string;
  /** Required: a tool row with no name cannot be attributed, and the codec cannot supply it. */
  toolName: string;
  toolCallId?: string | undefined;
  durationMs?: number | undefined;
  sourceEpoch?: SourceEpoch | undefined;
  sourcePosition?: SourcePosition | undefined;
};

// Shared by the five payload schemas and the five union branches, so a member cannot drift.
const buildMachineContentDescriptorShape = () => ({
  contentLength: z.number().int().nonnegative().optional(),
  // `z.literal(true)`, not `z.boolean()`: a `false` on the wire would canonicalize into bytes a
  // complete row must not have, so omit-never-false is enforced at parse.
  contentTruncated: z.literal(true).optional(),
});

const buildAssistantOutputPayloadShape = () => ({
  sessionId: SessionIdSchema,
  // A bounded free-form guard like `EventEnvelope.id`, not the branded `RunIdSchema` that
  // `usage.model_rerouted` uses.
  runId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "assistant output payload runId"),
  contentType: wireFreeFormString(
    EVENT_FIELD_MAX_LEN,
    "assistant output payload contentType",
  ).optional(),
  ...buildMachineContentDescriptorShape(),
});

const buildToolActivityPayloadShape = () => ({
  sessionId: SessionIdSchema,
  runId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "tool activity payload runId"),
  toolName: wireFreeFormString(EVENT_FIELD_MAX_LEN, "tool activity payload toolName"),
  toolCallId: wireFreeFormString(
    EVENT_FIELD_MAX_LEN,
    "tool activity payload toolCallId",
  ).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  ...buildMachineContentDescriptorShape(),
});

const assistantMessagePayloadSchema = withEpochStamp(
  z.object(buildAssistantOutputPayloadShape()).strict(),
);
const assistantThinkingUpdatePayloadSchema = withEpochStamp(
  z.object(buildAssistantOutputPayloadShape()).strict(),
);
const toolInvokedPayloadSchema = withEpochStamp(z.object(buildToolActivityPayloadShape()).strict());
const toolResultPayloadSchema = withEpochStamp(z.object(buildToolActivityPayloadShape()).strict());
const toolErrorPayloadSchema = withEpochStamp(z.object(buildToolActivityPayloadShape()).strict());

/** Emitted when the assistant produces a message; its body is sealed apart from the payload. */
export interface AssistantMessageEvent extends EventEnvelope {
  type: "assistant.message";
  category: "assistant_output";
  payload: AssistantOutputPayload;
}
/** Wire schema for {@link AssistantMessageEvent}. */
export const AssistantMessageEventSchema: z.ZodType<AssistantMessageEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("assistant.message"),
    category: z.literal("assistant_output"),
    payload: assistantMessagePayloadSchema,
  })
  .strict();

/** Emitted when the assistant reports a reasoning update; its body is sealed apart. */
export interface AssistantThinkingUpdateEvent extends EventEnvelope {
  type: "assistant.thinking_update";
  category: "assistant_output";
  payload: AssistantOutputPayload;
}
/** Wire schema for {@link AssistantThinkingUpdateEvent}. */
export const AssistantThinkingUpdateEventSchema: z.ZodType<AssistantThinkingUpdateEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("assistant.thinking_update"),
    category: z.literal("assistant_output"),
    payload: assistantThinkingUpdatePayloadSchema,
  })
  .strict();

/** Emitted when a tool call starts; its arguments are sealed apart from the payload. */
export interface ToolInvokedEvent extends EventEnvelope {
  type: "tool.invoked";
  category: "tool_activity";
  payload: ToolActivityPayload;
}
/** Wire schema for {@link ToolInvokedEvent}. */
export const ToolInvokedEventSchema: z.ZodType<ToolInvokedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("tool.invoked"),
    category: z.literal("tool_activity"),
    payload: toolInvokedPayloadSchema,
  })
  .strict();

/** Emitted when a tool call returns; its result is sealed apart from the payload. */
export interface ToolResultEvent extends EventEnvelope {
  type: "tool.result";
  category: "tool_activity";
  payload: ToolActivityPayload;
}
/** Wire schema for {@link ToolResultEvent}. */
export const ToolResultEventSchema: z.ZodType<ToolResultEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("tool.result"),
    category: z.literal("tool_activity"),
    payload: toolResultPayloadSchema,
  })
  .strict();

/** Emitted when a tool call fails; its error body is sealed apart from the payload. */
export interface ToolErrorEvent extends EventEnvelope {
  type: "tool.error";
  category: "tool_activity";
  payload: ToolActivityPayload;
}
/** Wire schema for {@link ToolErrorEvent}. */
export const ToolErrorEventSchema: z.ZodType<ToolErrorEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("tool.error"),
    category: z.literal("tool_activity"),
    payload: toolErrorPayloadSchema,
  })
  .strict();

// Each payload below is declared beside the method or record that produces it and imported here:
// the emitter's contract authors the payload. `usage.model_rerouted` is declared here because no
// other contract states it.
//
// Only `command.ended` and `usage.model_rerouted` take the epoch stamp: they are the run-scoped
// members here, each with a required `runId`. The approval, session-lifecycle, interactive-request,
// security and mcp-governance variants sit outside the late-append window, and `git.settled`
// names a run on only some causes.
//
// Each arm is built once by `buildSessionEventVariantSchema` and registered in the union
// directly. The builder is not exported, so its inferred return type keeps the literal `type` that
// the discriminated union dispatches on, and it takes the category from the registry's entry for
// the type, so an arm filed under another category is a compile error. These variants export
// their event type and no standalone schema; `SessionEventSchema` is where they parse.

/**
 * A session event whose payload a contract of its own declares: the envelope with `type`,
 * `category` and `payload` narrowed to one variant. `payload` maps the payload's members into an
 * object type, because TypeScript gives the implicit index signature the envelope's record needs
 * to object types and never to interfaces, so an owning contract may declare its payload either
 * way.
 */
export interface SessionEventVariant<
  TType extends SessionEventType,
  TCategory extends EventCategory,
  TPayload extends object,
> extends EventEnvelope {
  type: TType;
  category: TCategory;
  payload: { [Member in keyof TPayload]: TPayload[Member] };
}

const buildSessionEventVariantSchema = <
  TType extends SessionEventType,
  TPayload extends z.ZodType<object>,
>(
  type: TType,
  category: (typeof SESSION_EVENT_CATEGORY_RECORD)[TType],
  payload: TPayload,
) =>
  z
    .object({
      ...buildCommonShape(),
      type: z.literal(type),
      category: z.literal(category),
      payload,
    })
    .strict();

/** Emitted when an approval request is refused, and by whom. */
export type ApprovalRejectedEvent = SessionEventVariant<
  "approval.rejected",
  "approval_flow",
  ApprovalResolvedPayload
>;
/** Emitted when an ask ends with its run and can no longer be answered. */
export type ApprovalCanceledEvent = SessionEventVariant<
  "approval.canceled",
  "approval_flow",
  ApprovalCanceledPayload
>;
/** Emitted when an approval rule is remembered; the payload is the whole rule. */
export type ApprovalRememberedEvent = SessionEventVariant<
  "approval.remembered",
  "approval_flow",
  ApprovalRememberedPayload
>;
/** Emitted when a remembered approval rule is revoked. */
export type ApprovalRuleRevokedEvent = SessionEventVariant<
  "approval.rule_revoked",
  "approval_flow",
  ApprovalRuleRevokedPayload
>;
/** Emitted when Codex's own reviewer flags an item with a warning or a required review. */
export type ModerationReviewFlaggedEvent = SessionEventVariant<
  "moderation.review_flagged",
  "approval_flow",
  ModerationReviewFlaggedPayload
>;
/** Emitted when an agent proposes a plan; the payload is the record the screen renders. */
export type PlanProposedEvent = SessionEventVariant<
  "plan.proposed",
  "approval_flow",
  PlanProposedPayload
>;
/** Emitted when a proposed plan is accepted and is being built in its own session. */
export type PlanAcceptedEvent = SessionEventVariant<
  "plan.accepted",
  "approval_flow",
  PlanAcceptedPayload
>;
/** Emitted when a plan seeds a fresh session. */
export type PlanHandedOffEvent = SessionEventVariant<
  "plan.handed_off",
  "approval_flow",
  PlanHandedOffPayload
>;
/** Emitted when an agent, tool server or workflow step asks the person a question. */
export type QuestionAskedEvent = SessionEventVariant<
  "question.asked",
  "interactive_request",
  QuestionAskedPayload
>;
/** Emitted when an MCP server's connection status changes. */
export type McpServerStatusChangedEvent = SessionEventVariant<
  "mcp.server_status_changed",
  "mcp_governance",
  McpServerStatusChangedPayload
>;
/** Emitted when an MCP server's configuration changes. */
export type McpServerConfigChangedEvent = SessionEventVariant<
  "mcp.server_config_changed",
  "mcp_governance",
  McpServerConfigChangedPayload
>;
/** Emitted when trust in an MCP server is granted, withdrawn or lost to drift. */
export type McpServerTrustChangedEvent = SessionEventVariant<
  "mcp.server_trust_changed",
  "mcp_governance",
  McpServerTrustChangedPayload
>;
/** Emitted when an MCP tool override changes. */
export type McpToolOverrideChangedEvent = SessionEventVariant<
  "mcp.tool_override_changed",
  "mcp_governance",
  McpToolOverrideChangedPayload
>;
/** Emitted when an MCP server sign-in ends, in success or failure. */
export type McpServerOauthCompletedEvent = SessionEventVariant<
  "mcp.server_oauth_completed",
  "mcp_governance",
  McpServerOauthCompletedPayload
>;
/** Emitted when a cloud task is sent, changes state or is brought back. */
export type CloudTaskUpdatedEvent = SessionEventVariant<
  "cloud.task_updated",
  "session_lifecycle",
  CloudTaskUpdatedPayload
>;
/** Emitted when an undo finishes, with what applied and what did not. */
export type SessionRestoreFinishedEvent = SessionEventVariant<
  "session.restore_finished",
  "session_lifecycle",
  SessionRestoreFinishedPayload
>;
/** Emitted when a session's goal is removed. */
export type SessionGoalClearedEvent = SessionEventVariant<
  "session.goal_cleared",
  "session_lifecycle",
  SessionGoalClearedPayload
>;
/** Emitted for a plain-sentence notice about the session, such as a warning from the provider. */
export type SessionNoticeEvent = SessionEventVariant<
  "session.notice",
  "session_lifecycle",
  SessionNoticePayload
>;
/** Emitted when a side question is answered; the aside never enters the conversation. */
export type SessionSideQuestionAnsweredEvent = SessionEventVariant<
  "session.side_question_answered",
  "session_lifecycle",
  SessionSideQuestionAnsweredPayload
>;
/** Emitted when a git act leaves or changes the session's branch. */
export type GitSettledEvent = SessionEventVariant<
  "git.settled",
  "artifact_publication",
  GitSettledPayload
>;
/** Emitted when the relay presents a key that does not match the pinned one. */
export type RelayPinRefusedEvent = SessionEventVariant<
  "relay.pin_refused",
  "security_events",
  RelayPinRefusedPayload
>;
/** Emitted when a command ends; it takes the epoch stamp. */
export type CommandEndedEvent = SessionEventVariant<
  "command.ended",
  "tool_activity",
  CommandEndedPayload & {
    sourceEpoch?: SourceEpoch | undefined;
    sourcePosition?: SourcePosition | undefined;
  }
>;

/**
 * `usage.model_rerouted`: the provider moved a turn onto another model and the
 * turn went on. `scope` says how long the switch holds — this turn, the rest
 * of the session, or only a subagent's, a side question's or a background
 * fork's response (`local`). `sentence` and `explanation` are the provider's
 * own words when it sends them; `safetyCategory` names the check's category
 * when the provider reports one.
 */
export type UsageModelReroutedPayload = {
  sessionId: SessionId;
  runId: RunId;
  agentId?: string | undefined;
  fromModel: string;
  toModel: string;
  scope: "turn" | "session" | "local";
  sentence?: string | undefined;
  explanation?: string | undefined;
  cause: "safety" | "model_unavailable" | "model_blocked" | "out_of_credits";
  safetyCategory?: string | undefined;
};
/** Emitted when the provider moves a turn onto another model; it takes the epoch stamp. */
export type UsageModelReroutedEvent = SessionEventVariant<
  "usage.model_rerouted",
  "usage_telemetry",
  UsageModelReroutedPayload & {
    sourceEpoch?: SourceEpoch | undefined;
    sourcePosition?: SourcePosition | undefined;
  }
>;
/** Emitted when a session is archived. */
export type SessionArchivedEvent = SessionEventVariant<
  "session.archived",
  "session_lifecycle",
  SessionLifecycleChangePayload
>;
/** Emitted when an archived session is reactivated. */
export type SessionReactivatedEvent = SessionEventVariant<
  "session.reactivated",
  "session_lifecycle",
  SessionLifecycleChangePayload
>;
/** Emitted when a session is closed. */
export type SessionClosedEvent = SessionEventVariant<
  "session.closed",
  "session_lifecycle",
  SessionLifecycleChangePayload
>;
/** Emitted when a session is pinned. */
export type SessionPinnedEvent = SessionEventVariant<
  "session.pinned",
  "session_lifecycle",
  SessionMarkChangePayload
>;
/** Emitted when a session is unpinned. */
export type SessionUnpinnedEvent = SessionEventVariant<
  "session.unpinned",
  "session_lifecycle",
  SessionMarkChangePayload
>;
/** Emitted when a session is muted. */
export type SessionMutedEvent = SessionEventVariant<
  "session.muted",
  "session_lifecycle",
  SessionMarkChangePayload
>;
/** Emitted when a session is unmuted. */
export type SessionUnmutedEvent = SessionEventVariant<
  "session.unmuted",
  "session_lifecycle",
  SessionMarkChangePayload
>;
/** Emitted when a chat is converted, with the outcome of the copy. */
export type SessionConvertedEvent = SessionEventVariant<
  "session.converted",
  "session_lifecycle",
  SessionConvertedPayload
>;
/** Emitted when the branch a session's folder is on changes outside the console. */
export type SessionBranchChangedEvent = SessionEventVariant<
  "session.branch_changed",
  "session_lifecycle",
  SessionBranchChangedPayload
>;
/** Emitted when a worktree removal moves a session back to the repository root. */
export type SessionSweptToRepoRootEvent = SessionEventVariant<
  "session.swept_to_repo_root",
  "session_lifecycle",
  SessionSweptToRepoRootPayload
>;
/** Emitted when an agent's provider binding is switched. */
export type AgentProviderBindingChangedEvent = SessionEventVariant<
  "agent.provider_binding_changed",
  "session_lifecycle",
  AgentProviderBindingChangedPayload
>;
/** Emitted when an accepted binding switch could not be applied. */
export type AgentProviderBindingChangeFailedEvent = SessionEventVariant<
  "agent.provider_binding_change_failed",
  "session_lifecycle",
  AgentProviderBindingChangeFailedPayload
>;
/** Emitted when an approval is requested, including a provider's permission ask. */
export type ApprovalRequestedEvent = SessionEventVariant<
  "approval.requested",
  "approval_flow",
  ApprovalRequestedPayload
>;
/** Emitted when an approval request is granted, and by whom. */
export type ApprovalApprovedEvent = SessionEventVariant<
  "approval.approved",
  "approval_flow",
  ApprovalResolvedPayload
>;
/**
 * `approval.reviewer_denied` carries the provider's own denial as its sealed body,
 * so its payload takes the codec's content members beside the owner's.
 */
export type ApprovalReviewerDeniedEvent = SessionEventVariant<
  "approval.reviewer_denied",
  "approval_flow",
  ApprovalReviewerDeniedPayload & MachineContentDescriptor
>;
/** Emitted when the person allows a blocked action once. */
export type ApprovalDenialOverriddenEvent = SessionEventVariant<
  "approval.denial_overridden",
  "approval_flow",
  ApprovalDenialOverriddenPayload
>;
/** Emitted when a run is queued. */
export type RunQueuedEvent = SessionEventVariant<"run.queued", "run_lifecycle", RunQueuedPayload>;
/** Emitted when a turn reaches the step bound and ends there. */
export type RunStepLimitReachedEvent = SessionEventVariant<
  "run.step_limit_reached",
  "run_lifecycle",
  RunStepLimitReachedPayload
>;
/** Emitted when the person's choice settles a run's recovery question. */
export type RunRecoveryResolvedEvent = SessionEventVariant<
  "run.recovery_resolved",
  "run_lifecycle",
  RunRecoveryResolvedPayload
>;
/** Emitted when a session's goal is set or changes status. */
export type SessionGoalUpdatedEvent = SessionEventVariant<
  "session.goal_updated",
  "session_lifecycle",
  SessionGoalUpdatedPayload
>;
/** Emitted when a session is renamed. */
export type SessionRenamedEvent = SessionEventVariant<
  "session.renamed",
  "session_lifecycle",
  SessionRenamedPayload
>;
/** Emitted when the holder of a shell changes. */
export type PtyControlChangedEvent = SessionEventVariant<
  "pty.control_changed",
  "session_lifecycle",
  PtyControlChangedPayload
>;
/** Emitted when a workflow run starts. */
export type WorkflowStartedEvent = SessionEventVariant<
  "workflow.started",
  "workflow_lifecycle",
  WorkflowStartedPayload
>;
/** Emitted when a workflow run resumes. */
export type WorkflowResumedEvent = SessionEventVariant<
  "workflow.resumed",
  "workflow_lifecycle",
  WorkflowResumedPayload
>;
/** Emitted when a workflow run is canceled. */
export type WorkflowCanceledEvent = SessionEventVariant<
  "workflow.canceled",
  "workflow_lifecycle",
  WorkflowCanceledPayload
>;
/** Emitted when a finished run's results land as a row in the asking session. */
export type WorkflowResultsPostedEvent = SessionEventVariant<
  "workflow.results_posted",
  "workflow_lifecycle",
  WorkflowResultsPostedPayload
>;
/** Emitted when a workflow step starts, with the input it ran on. */
export type WorkflowStepStartedEvent = SessionEventVariant<
  "workflow.step_started",
  "workflow_phase_lifecycle",
  WorkflowStepStartedPayload
>;
/** Emitted when a workflow step finishes, with its output and log. */
export type WorkflowStepFinishedEvent = SessionEventVariant<
  "workflow.step_finished",
  "workflow_phase_lifecycle",
  WorkflowStepFinishedPayload
>;
/** Emitted when a workflow step fails, with its error. */
export type WorkflowStepFailedEvent = SessionEventVariant<
  "workflow.step_failed",
  "workflow_phase_lifecycle",
  WorkflowStepFailedPayload
>;
/** Emitted when a running or waiting step ends because its run did. */
export type WorkflowStepCanceledEvent = SessionEventVariant<
  "workflow.step_canceled",
  "workflow_phase_lifecycle",
  WorkflowStepEventPayload
>;
/** Emitted when a workflow step is skipped. */
export type WorkflowStepSkippedEvent = SessionEventVariant<
  "workflow.step_skipped",
  "workflow_phase_lifecycle",
  WorkflowStepSkippedPayload
>;
/** Emitted when a workflow gate is answered. */
export type WorkflowGateResolvedEvent = SessionEventVariant<
  "workflow.gate_resolved",
  "workflow_gate_resolution",
  WorkflowGateResolvedPayload
>;
/** Emitted when a backup run writes a backup. */
export type BackupCompletedEvent = SessionEventVariant<
  "backup.completed",
  "event_maintenance",
  BackupCompletedPayload
>;
/** Emitted when a backup run does not finish. */
export type BackupFailedEvent = SessionEventVariant<
  "backup.failed",
  "event_maintenance",
  BackupFailedPayload
>;
/** Emitted when the service starts again from a backup. */
export type BackupRestoredEvent = SessionEventVariant<
  "backup.restored",
  "event_maintenance",
  BackupRestoredPayload
>;

// `withEpochStamp` takes a strict ZodObject, but the imported schema is annotated
// `z.ZodType<T>`, which erases that surface. It is a strict object at runtime, so the surface is
// re-widened for the call and the result annotated with the composed payload.
const commandEndedVariantPayloadSchema = withEpochStamp(
  CommandEndedPayloadSchema as unknown as z.ZodObject<Record<never, never>, z.core.$strict>,
) as unknown as z.ZodType<CommandEndedEvent["payload"]>;

const usageModelReroutedVariantPayloadSchema = withEpochStamp(
  z
    .object({
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      agentId: uuidTextFormSchema.optional(),
      fromModel: wireFreeFormString(EVENT_FIELD_MAX_LEN, "UsageModelReroutedPayload.fromModel"),
      toModel: wireFreeFormString(EVENT_FIELD_MAX_LEN, "UsageModelReroutedPayload.toModel"),
      scope: z.enum(["turn", "session", "local"]),
      sentence: wireFreeFormString(
        DRIVER_FAILURE_DETAIL_MAX_LEN,
        "UsageModelReroutedPayload.sentence",
      ).optional(),
      explanation: wireFreeFormString(
        DRIVER_FAILURE_DETAIL_MAX_LEN,
        "UsageModelReroutedPayload.explanation",
      ).optional(),
      cause: z.enum(["safety", "model_unavailable", "model_blocked", "out_of_credits"]),
      safetyCategory: wireFreeFormString(
        EVENT_FIELD_MAX_LEN,
        "UsageModelReroutedPayload.safetyCategory",
      ).optional(),
    })
    .strict(),
);

const approvalRejectedVariantSchema = buildSessionEventVariantSchema(
  "approval.rejected",
  "approval_flow",
  ApprovalResolvedPayloadSchema,
);
const approvalCanceledVariantSchema = buildSessionEventVariantSchema(
  "approval.canceled",
  "approval_flow",
  ApprovalCanceledPayloadSchema,
);
const approvalRememberedVariantSchema = buildSessionEventVariantSchema(
  "approval.remembered",
  "approval_flow",
  ApprovalRememberedPayloadSchema,
);
const approvalRuleRevokedVariantSchema = buildSessionEventVariantSchema(
  "approval.rule_revoked",
  "approval_flow",
  ApprovalRuleRevokedPayloadSchema,
);
const moderationReviewFlaggedVariantSchema = buildSessionEventVariantSchema(
  "moderation.review_flagged",
  "approval_flow",
  ModerationReviewFlaggedPayloadSchema,
);
const planProposedVariantSchema = buildSessionEventVariantSchema(
  "plan.proposed",
  "approval_flow",
  PlanProposedPayloadSchema,
);
const planAcceptedVariantSchema = buildSessionEventVariantSchema(
  "plan.accepted",
  "approval_flow",
  PlanAcceptedPayloadSchema,
);
const planHandedOffVariantSchema = buildSessionEventVariantSchema(
  "plan.handed_off",
  "approval_flow",
  PlanHandedOffPayloadSchema,
);
const questionAskedVariantSchema = buildSessionEventVariantSchema(
  "question.asked",
  "interactive_request",
  QuestionAskedPayloadSchema,
);
const mcpServerStatusChangedVariantSchema = buildSessionEventVariantSchema(
  "mcp.server_status_changed",
  "mcp_governance",
  McpServerStatusChangedPayloadSchema,
);
const mcpServerConfigChangedVariantSchema = buildSessionEventVariantSchema(
  "mcp.server_config_changed",
  "mcp_governance",
  McpServerConfigChangedPayloadSchema,
);
const mcpServerTrustChangedVariantSchema = buildSessionEventVariantSchema(
  "mcp.server_trust_changed",
  "mcp_governance",
  McpServerTrustChangedPayloadSchema,
);
const mcpToolOverrideChangedVariantSchema = buildSessionEventVariantSchema(
  "mcp.tool_override_changed",
  "mcp_governance",
  McpToolOverrideChangedPayloadSchema,
);
const mcpServerOauthCompletedVariantSchema = buildSessionEventVariantSchema(
  "mcp.server_oauth_completed",
  "mcp_governance",
  McpServerOauthCompletedPayloadSchema,
);
const cloudTaskUpdatedVariantSchema = buildSessionEventVariantSchema(
  "cloud.task_updated",
  "session_lifecycle",
  CloudTaskUpdatedPayloadSchema,
);
const sessionRestoreFinishedVariantSchema = buildSessionEventVariantSchema(
  "session.restore_finished",
  "session_lifecycle",
  SessionRestoreFinishedPayloadSchema,
);
const sessionGoalClearedVariantSchema = buildSessionEventVariantSchema(
  "session.goal_cleared",
  "session_lifecycle",
  SessionGoalClearedPayloadSchema,
);
const sessionNoticeVariantSchema = buildSessionEventVariantSchema(
  "session.notice",
  "session_lifecycle",
  SessionNoticePayloadSchema,
);
const sessionSideQuestionAnsweredVariantSchema = buildSessionEventVariantSchema(
  "session.side_question_answered",
  "session_lifecycle",
  SessionSideQuestionAnsweredPayloadSchema,
);
const gitSettledVariantSchema = buildSessionEventVariantSchema(
  "git.settled",
  "artifact_publication",
  GitSettledPayloadSchema,
);
const relayPinRefusedVariantSchema = buildSessionEventVariantSchema(
  "relay.pin_refused",
  "security_events",
  RelayPinRefusedPayloadSchema,
);
const commandEndedVariantSchema = buildSessionEventVariantSchema(
  "command.ended",
  "tool_activity",
  commandEndedVariantPayloadSchema,
);
const sessionArchivedVariantSchema = buildSessionEventVariantSchema(
  "session.archived",
  "session_lifecycle",
  SessionLifecycleChangePayloadSchema,
);
const sessionReactivatedVariantSchema = buildSessionEventVariantSchema(
  "session.reactivated",
  "session_lifecycle",
  SessionLifecycleChangePayloadSchema,
);
const sessionClosedVariantSchema = buildSessionEventVariantSchema(
  "session.closed",
  "session_lifecycle",
  SessionLifecycleChangePayloadSchema,
);
const sessionPinnedVariantSchema = buildSessionEventVariantSchema(
  "session.pinned",
  "session_lifecycle",
  SessionMarkChangePayloadSchema,
);
const sessionUnpinnedVariantSchema = buildSessionEventVariantSchema(
  "session.unpinned",
  "session_lifecycle",
  SessionMarkChangePayloadSchema,
);
const sessionMutedVariantSchema = buildSessionEventVariantSchema(
  "session.muted",
  "session_lifecycle",
  SessionMarkChangePayloadSchema,
);
const sessionUnmutedVariantSchema = buildSessionEventVariantSchema(
  "session.unmuted",
  "session_lifecycle",
  SessionMarkChangePayloadSchema,
);
const usageModelReroutedVariantSchema = buildSessionEventVariantSchema(
  "usage.model_rerouted",
  "usage_telemetry",
  usageModelReroutedVariantPayloadSchema,
);
const sessionConvertedVariantSchema = buildSessionEventVariantSchema(
  "session.converted",
  "session_lifecycle",
  SessionConvertedPayloadSchema,
);
const sessionBranchChangedVariantSchema = buildSessionEventVariantSchema(
  "session.branch_changed",
  "session_lifecycle",
  SessionBranchChangedPayloadSchema,
);
const sessionSweptToRepoRootVariantSchema = buildSessionEventVariantSchema(
  "session.swept_to_repo_root",
  "session_lifecycle",
  SessionSweptToRepoRootPayloadSchema,
);
const agentProviderBindingChangedVariantSchema = buildSessionEventVariantSchema(
  "agent.provider_binding_changed",
  "session_lifecycle",
  AgentProviderBindingChangedPayloadSchema,
);
const agentProviderBindingChangeFailedVariantSchema = buildSessionEventVariantSchema(
  "agent.provider_binding_change_failed",
  "session_lifecycle",
  AgentProviderBindingChangeFailedPayloadSchema,
);
const approvalRequestedVariantSchema = buildSessionEventVariantSchema(
  "approval.requested",
  "approval_flow",
  ApprovalRequestedPayloadSchema,
);
const approvalApprovedVariantSchema = buildSessionEventVariantSchema(
  "approval.approved",
  "approval_flow",
  ApprovalResolvedPayloadSchema,
);
// The owner's schema is annotated `z.ZodType<T>`, which erases the object surface `.extend()`
// needs. It is a strict object at runtime, so the surface is re-widened for the call and the
// result annotated with the composed payload.
const approvalReviewerDeniedVariantPayloadSchema = (
  ApprovalReviewerDeniedPayloadSchema as unknown as z.ZodObject<
    Record<never, never>,
    z.core.$strict
  >
).extend(buildMachineContentDescriptorShape()) as unknown as z.ZodType<
  ApprovalReviewerDeniedEvent["payload"]
>;
const approvalReviewerDeniedVariantSchema = buildSessionEventVariantSchema(
  "approval.reviewer_denied",
  "approval_flow",
  approvalReviewerDeniedVariantPayloadSchema,
);
const approvalDenialOverriddenVariantSchema = buildSessionEventVariantSchema(
  "approval.denial_overridden",
  "approval_flow",
  ApprovalDenialOverriddenPayloadSchema,
);
const runQueuedVariantSchema = buildSessionEventVariantSchema(
  "run.queued",
  "run_lifecycle",
  RunQueuedPayloadSchema,
);
const runStepLimitReachedVariantSchema = buildSessionEventVariantSchema(
  "run.step_limit_reached",
  "run_lifecycle",
  RunStepLimitReachedPayloadSchema,
);
const runRecoveryResolvedVariantSchema = buildSessionEventVariantSchema(
  "run.recovery_resolved",
  "run_lifecycle",
  RunRecoveryResolvedPayloadSchema,
);
const sessionGoalUpdatedVariantSchema = buildSessionEventVariantSchema(
  "session.goal_updated",
  "session_lifecycle",
  SessionGoalUpdatedPayloadSchema,
);
const sessionRenamedVariantSchema = buildSessionEventVariantSchema(
  "session.renamed",
  "session_lifecycle",
  SessionRenamedPayloadSchema,
);
const ptyControlChangedVariantSchema = buildSessionEventVariantSchema(
  "pty.control_changed",
  "session_lifecycle",
  PtyControlChangedPayloadSchema,
);
const workflowStartedVariantSchema = buildSessionEventVariantSchema(
  "workflow.started",
  "workflow_lifecycle",
  WorkflowStartedPayloadSchema,
);
const workflowResumedVariantSchema = buildSessionEventVariantSchema(
  "workflow.resumed",
  "workflow_lifecycle",
  WorkflowResumedPayloadSchema,
);
const workflowCanceledVariantSchema = buildSessionEventVariantSchema(
  "workflow.canceled",
  "workflow_lifecycle",
  WorkflowCanceledPayloadSchema,
);
const workflowResultsPostedVariantSchema = buildSessionEventVariantSchema(
  "workflow.results_posted",
  "workflow_lifecycle",
  WorkflowResultsPostedPayloadSchema,
);
const workflowStepStartedVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_started",
  "workflow_phase_lifecycle",
  WorkflowStepStartedPayloadSchema,
);
const workflowStepFinishedVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_finished",
  "workflow_phase_lifecycle",
  WorkflowStepFinishedPayloadSchema,
);
const workflowStepFailedVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_failed",
  "workflow_phase_lifecycle",
  WorkflowStepFailedPayloadSchema,
);
const workflowStepCanceledVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_canceled",
  "workflow_phase_lifecycle",
  WorkflowStepCanceledPayloadSchema,
);
const workflowStepSkippedVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_skipped",
  "workflow_phase_lifecycle",
  WorkflowStepSkippedPayloadSchema,
);
const workflowGateResolvedVariantSchema = buildSessionEventVariantSchema(
  "workflow.gate_resolved",
  "workflow_gate_resolution",
  WorkflowGateResolvedPayloadSchema,
);
const backupCompletedVariantSchema = buildSessionEventVariantSchema(
  "backup.completed",
  "event_maintenance",
  BackupCompletedPayloadSchema,
);
const backupFailedVariantSchema = buildSessionEventVariantSchema(
  "backup.failed",
  "event_maintenance",
  BackupFailedPayloadSchema,
);
const backupRestoredVariantSchema = buildSessionEventVariantSchema(
  "backup.restored",
  "event_maintenance",
  BackupRestoredPayloadSchema,
);

// `event` and `content` are separate members on purpose: the body is never merged into
// `event.payload`, whose strict schemas declare no body member. `event` is the tolerant
// {@link EventEnvelope}, not the strict {@link SessionEvent}: a stored row is rebuilt through the
// carrier, and narrowing is a step the caller chooses, so a reader need not re-parse a row just
// to ask whether the body opened.

/**
 * Why a body is not available: a closed set, so a caller gets a reason to act on instead of
 * assuming loss from a missing key. `absent` and `purged` are distinguishable only from the
 * row's retention class, which is why the reader takes it as input.
 */
export type HydratedContentUnavailableReason =
  /** The row never carried a body: live row, NULL column. */
  | "absent"
  /** The session was deleted; its row is a stub and the body went with it. */
  | "purged"
  /** The daemon master key could not be obtained, so no wrapped key opens. */
  | "master_key_unavailable"
  /** The session has a sealed body but no wrapped key row to open it with. */
  | "wrapped_key_missing"
  /**
   * Sealed material refused to open: the session key's own envelope (wrong master, a blob moved
   * between rows, a replay under a superseded key version) or the body ciphertext failing its
   * AEAD tag or decoding to invalid UTF-8. The AEAD refuses these identically, so no cause is
   * guessed here.
   */
  | "decrypt_failed";

/** The closed two-arm content union of a {@link HydratedSessionEvent}. */
export type HydratedSessionEventContent =
  | {
      readonly status: "available";
      /** The opened body; a prefix when `contentTruncated` is `true`. */
      readonly body: string;
      /** Echoed from the stored payload, never recomputed from `body`. */
      readonly contentLength?: number | undefined;
      readonly contentTruncated?: true | undefined;
    }
  | {
      readonly status: "unavailable";
      readonly reason: HydratedContentUnavailableReason;
    };

/** A stored event paired with its machine-authored body; the event itself is never mutated. */
export interface HydratedSessionEvent {
  /** Byte-identical to the stored row. */
  readonly event: EventEnvelope;
  readonly content: HydratedSessionEventContent;
}

// `z.discriminatedUnion` needs literal-typed ZodObject variants, which gives O(1) parse dispatch
// and narrowed types where an event is used. The variant schemas are rebuilt here instead of
// reusing the exported `*EventSchema` values, because `z.ZodType<T>` erases the literal `type`
// the union discriminates on; this keeps the public API `isolatedDeclarations`-friendly. Payload
// schemas are shared, so payload shapes cannot drift between the two surfaces.

/** Every session event with a registered payload variant, discriminated on `type`. */
export type SessionEvent =
  | SessionCreatedEvent
  | RepoAttachedEvent
  | RepoDetachedEvent
  | WorkspacePreparingEvent
  | WorkspaceReadyEvent
  | WorkspaceStaleEvent
  | WorkspaceArchivedEvent
  | WorktreeCreatedEvent
  | WorktreeReadyEvent
  | WorktreeDirtyEvent
  | WorktreeMergedEvent
  | WorktreeRetiredEvent
  | EventCompactedEvent
  | AssistantMessageEvent
  | AssistantThinkingUpdateEvent
  | ToolInvokedEvent
  | ToolResultEvent
  | ToolErrorEvent
  | ApprovalRejectedEvent
  | ApprovalCanceledEvent
  | ApprovalRememberedEvent
  | ApprovalRuleRevokedEvent
  | ModerationReviewFlaggedEvent
  | PlanProposedEvent
  | PlanAcceptedEvent
  | PlanHandedOffEvent
  | QuestionAskedEvent
  | McpServerStatusChangedEvent
  | McpServerConfigChangedEvent
  | McpServerTrustChangedEvent
  | McpToolOverrideChangedEvent
  | McpServerOauthCompletedEvent
  | CloudTaskUpdatedEvent
  | SessionRestoreFinishedEvent
  | SessionGoalClearedEvent
  | SessionNoticeEvent
  | SessionSideQuestionAnsweredEvent
  | GitSettledEvent
  | RelayPinRefusedEvent
  | CommandEndedEvent
  | UsageModelReroutedEvent
  | SessionArchivedEvent
  | SessionReactivatedEvent
  | SessionClosedEvent
  | SessionPinnedEvent
  | SessionUnpinnedEvent
  | SessionMutedEvent
  | SessionUnmutedEvent
  | SessionConvertedEvent
  | SessionBranchChangedEvent
  | SessionSweptToRepoRootEvent
  | AgentProviderBindingChangedEvent
  | AgentProviderBindingChangeFailedEvent
  | ApprovalRequestedEvent
  | ApprovalApprovedEvent
  | ApprovalReviewerDeniedEvent
  | ApprovalDenialOverriddenEvent
  | RunQueuedEvent
  | RunStepLimitReachedEvent
  | RunRecoveryResolvedEvent
  | SessionGoalUpdatedEvent
  | SessionRenamedEvent
  | PtyControlChangedEvent
  | WorkflowStartedEvent
  | WorkflowResumedEvent
  | WorkflowCanceledEvent
  | WorkflowResultsPostedEvent
  | WorkflowStepStartedEvent
  | WorkflowStepFinishedEvent
  | WorkflowStepFailedEvent
  | WorkflowStepCanceledEvent
  | WorkflowStepSkippedEvent
  | WorkflowGateResolvedEvent
  | BackupCompletedEvent
  | BackupFailedEvent
  | BackupRestoredEvent;
/**
 * Strict parser for {@link SessionEvent}: an unknown type or a category that does not match its
 * type fails to parse.
 */
export const SessionEventSchema: z.ZodType<SessionEvent> = z.discriminatedUnion("type", [
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("session.created"),
      category: z.literal("session_lifecycle"),
      payload: SessionCreatedPayloadSchema,
    })
    .strict(),
  // The six repo and workspace arms share repo.ts's payload schema; none takes the epoch stamp.
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("repo.attached"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("repo.detached"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("workspace.preparing"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("workspace.ready"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("workspace.stale"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("workspace.archived"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  // The five worktree arms use the payload schemas of their `*EventSchema` exports; none takes
  // the epoch stamp. There is no `worktree.failed` arm.
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.created"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeCreatedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.ready"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.dirty"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.merged"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.retired"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeRetiredPayloadSchema,
    })
    .strict(),
  // The `event.compacted` arm shares the payload schema declared above, which is authored in this
  // file because the daemon emits the row itself; it takes no epoch stamp.
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("event.compacted"),
      category: z.literal("event_maintenance"),
      payload: EventCompactedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("assistant.message"),
      category: z.literal("assistant_output"),
      payload: assistantMessagePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("assistant.thinking_update"),
      category: z.literal("assistant_output"),
      payload: assistantThinkingUpdatePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("tool.invoked"),
      category: z.literal("tool_activity"),
      payload: toolInvokedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("tool.result"),
      category: z.literal("tool_activity"),
      payload: toolResultPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("tool.error"),
      category: z.literal("tool_activity"),
      payload: toolErrorPayloadSchema,
    })
    .strict(),
  // The arms built once by `buildSessionEventVariantSchema` above.
  approvalRejectedVariantSchema,
  approvalCanceledVariantSchema,
  approvalRememberedVariantSchema,
  approvalRuleRevokedVariantSchema,
  moderationReviewFlaggedVariantSchema,
  planProposedVariantSchema,
  planAcceptedVariantSchema,
  planHandedOffVariantSchema,
  questionAskedVariantSchema,
  mcpServerStatusChangedVariantSchema,
  mcpServerConfigChangedVariantSchema,
  mcpServerTrustChangedVariantSchema,
  mcpToolOverrideChangedVariantSchema,
  mcpServerOauthCompletedVariantSchema,
  cloudTaskUpdatedVariantSchema,
  sessionRestoreFinishedVariantSchema,
  sessionGoalClearedVariantSchema,
  sessionNoticeVariantSchema,
  sessionSideQuestionAnsweredVariantSchema,
  gitSettledVariantSchema,
  relayPinRefusedVariantSchema,
  commandEndedVariantSchema,
  usageModelReroutedVariantSchema,
  sessionArchivedVariantSchema,
  sessionReactivatedVariantSchema,
  sessionClosedVariantSchema,
  sessionPinnedVariantSchema,
  sessionUnpinnedVariantSchema,
  sessionMutedVariantSchema,
  sessionUnmutedVariantSchema,
  sessionConvertedVariantSchema,
  sessionBranchChangedVariantSchema,
  sessionSweptToRepoRootVariantSchema,
  agentProviderBindingChangedVariantSchema,
  agentProviderBindingChangeFailedVariantSchema,
  approvalRequestedVariantSchema,
  approvalApprovedVariantSchema,
  approvalReviewerDeniedVariantSchema,
  approvalDenialOverriddenVariantSchema,
  runQueuedVariantSchema,
  runStepLimitReachedVariantSchema,
  runRecoveryResolvedVariantSchema,
  sessionGoalUpdatedVariantSchema,
  sessionRenamedVariantSchema,
  ptyControlChangedVariantSchema,
  workflowStartedVariantSchema,
  workflowResumedVariantSchema,
  workflowCanceledVariantSchema,
  workflowResultsPostedVariantSchema,
  workflowStepStartedVariantSchema,
  workflowStepFinishedVariantSchema,
  workflowStepFailedVariantSchema,
  workflowStepCanceledVariantSchema,
  workflowStepSkippedVariantSchema,
  workflowGateResolvedVariantSchema,
  backupCompletedVariantSchema,
  backupFailedVariantSchema,
  backupRestoredVariantSchema,
]);

// Every wire `type` string. Each type belongs to exactly one category and
// `SESSION_EVENT_CATEGORY_BY_TYPE` covers every type: the `satisfies Record<SessionEventType,
// EventCategory>` check below makes a missing, unknown or duplicate key a compile error, and
// `__tests__/session-event.test.ts` checks the per-category partition. Type strings are
// immutable wire identifiers (MINOR bumps only add), so a registered literal is never renamed.
// Blocks follow `EventCategory` order, which is not load-bearing.
//
// A type's category is its registry entry, not its prefix: `session.clock_unsynced` and
// `session.clock_corrected` are `runtime_node_lifecycle` (they keep the `session.` prefix because
// a rename would break the wire), `daemon.*` and `relay.pin_refused` are `security_events`,
// `moderation.review_flagged` and `plan.*` are `approval_flow`, and `orchestration.rejected` is
// `orchestration_admission`.
/**
 * Every wire event type string the taxonomy registers, whether or not a payload variant exists
 * for it yet.
 */
export type SessionEventType =
  // run_lifecycle
  | "run.queued"
  | "run.starting"
  | "run.running"
  | "run.waiting_for_approval"
  | "run.waiting_for_input"
  | "run.pausing"
  | "run.paused"
  | "run.completed"
  | "run.interrupted"
  | "run.failed"
  | "run.rolled_back"
  | "run.provider_initialized"
  | "run.turn_started"
  | "run.worker_shutdown"
  | "run.step_limit_reached"
  | "run.recovery_resolved"
  // assistant_output
  | "assistant.message"
  | "assistant.thinking_update"
  // tool_activity
  | "tool.invoked"
  | "tool.result"
  | "tool.error"
  | "tool.replayed"
  | "tool.skipped_during_recovery"
  | "subagent.started"
  | "subagent.completed"
  | "command.ended"
  // interactive_request
  | "queue_item.created"
  | "queue_item.admitted"
  | "queue_item.superseded"
  | "queue_item.canceled"
  | "queue_item.not_delivered"
  | "intervention.requested"
  | "intervention.accepted"
  | "intervention.applied"
  | "intervention.rejected"
  | "intervention.degraded"
  | "intervention.expired"
  | "user.message"
  | "question.asked"
  // artifact_publication
  | "artifact.published"
  | "artifact.visibility_updated"
  | "artifact.superseded"
  | "diff.created"
  | "git.settled"
  // session_lifecycle
  | "session.created"
  | "session.activated"
  | "session.archived"
  | "session.reactivated"
  | "session.closed"
  | "session.purge_requested"
  | "session.purged"
  | "session.goal_updated"
  | "session.goal_cleared"
  | "session.provider_status"
  | "session.notice"
  | "session.renamed"
  | "session.pinned"
  | "session.unpinned"
  | "session.muted"
  | "session.unmuted"
  | "session.converted"
  | "session.side_question_answered"
  | "session.restore_finished"
  | "agent.provider_binding_changed"
  | "agent.provider_binding_change_failed"
  | "repo.attached"
  | "repo.detached"
  | "workspace.preparing"
  | "workspace.ready"
  | "workspace.stale"
  | "workspace.archived"
  | "worktree.created"
  | "worktree.ready"
  | "worktree.dirty"
  | "worktree.merged"
  | "worktree.retired"
  | "session.branch_changed"
  | "session.swept_to_repo_root"
  | "pty.control_changed"
  | "cloud.task_updated"
  // approval_flow
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "approval.canceled"
  | "approval.remembered"
  | "approval.rule_revoked"
  | "approval.reviewer_denied"
  | "approval.denial_overridden"
  | "moderation.review_flagged"
  | "plan.proposed"
  | "plan.accepted"
  | "plan.handed_off"
  // usage_telemetry
  | "usage.token_count"
  | "usage.cost_update"
  | "usage.context_window_update"
  | "usage.budget_warning"
  | "usage.rate_limit_update"
  | "usage.api_retry"
  | "usage.context_compacted"
  | "usage.model_rerouted"
  // runtime_node_lifecycle
  | "session.clock_unsynced"
  | "session.clock_corrected"
  // recovery_events
  | "recovery.attempted"
  | "recovery.succeeded"
  | "recovery.failed"
  // security_events
  | "security.default.override"
  | "security.update.available"
  | "daemon.master_key_source"
  | "daemon.pii_split_ambiguous"
  | "relay.pin_refused"
  // event_maintenance
  | "event.compacted"
  | "backup.completed"
  | "backup.failed"
  | "backup.restored"
  // policy_events
  | "policy_bundle.loaded"
  | "policy_bundle.rejected"
  // orchestration_admission
  | "orchestration.rejected"
  // mcp_governance
  | "mcp.server_status_changed"
  | "mcp.server_config_changed"
  | "mcp.server_trust_changed"
  | "mcp.tool_override_changed"
  | "mcp.server_oauth_completed"
  // workflow_lifecycle
  | "workflow.created"
  | "workflow.started"
  | "workflow.gated"
  | "workflow.failed"
  | "workflow.completed"
  | "workflow.resumed"
  | "workflow.canceled"
  | "workflow.run_waiting"
  | "workflow.schedule_armed"
  | "workflow.schedule_fired"
  | "workflow.trigger_armed"
  | "workflow.trigger_fired"
  | "workflow.results_posted"
  // workflow_phase_lifecycle
  | "workflow.phase_admitted"
  | "workflow.phase_waiting_on_pool"
  | "workflow.phase_started"
  | "workflow.phase_progressed"
  | "workflow.phase_canceling"
  | "workflow.phase_failed"
  | "workflow.phase_retried"
  | "workflow.phase_suspended"
  | "workflow.phase_resumed"
  | "workflow.phase_completed"
  | "workflow.human_phase_claimed"
  | "workflow.human_phase_escalated"
  | "workflow.step_started"
  | "workflow.step_finished"
  | "workflow.step_failed"
  | "workflow.step_canceled"
  | "workflow.step_skipped"
  // workflow_parallel_coordination
  | "workflow.parallel_join_cancellation"
  // workflow_gate_resolution
  | "workflow.gate_resolved";

/**
 * The event types with a payload variant registered in `SessionEventSchema`: a subset of the
 * census (`SESSION_EVENT_CATEGORY_BY_TYPE`). The `SessionEvent["type"]` annotation refuses a
 * literal that has no variant. The list is hand-written, so registering a union arm means adding
 * its type here in the same change; `__tests__/event-source-epoch.test.ts` checks that it equals
 * the union's arms. Order follows the union arms.
 */
export const SESSION_EVENT_TYPES: readonly SessionEvent["type"][] = [
  "session.created",
  "repo.attached",
  "repo.detached",
  "workspace.preparing",
  "workspace.ready",
  "workspace.stale",
  "workspace.archived",
  "worktree.created",
  "worktree.ready",
  "worktree.dirty",
  "worktree.merged",
  "worktree.retired",
  "event.compacted",
  "assistant.message",
  "assistant.thinking_update",
  "tool.invoked",
  "tool.result",
  "tool.error",
  "approval.rejected",
  "approval.canceled",
  "approval.remembered",
  "approval.rule_revoked",
  "moderation.review_flagged",
  "plan.proposed",
  "plan.accepted",
  "plan.handed_off",
  "question.asked",
  "mcp.server_status_changed",
  "mcp.server_config_changed",
  "mcp.server_trust_changed",
  "mcp.tool_override_changed",
  "mcp.server_oauth_completed",
  "cloud.task_updated",
  "session.restore_finished",
  "session.goal_cleared",
  "session.notice",
  "session.side_question_answered",
  "git.settled",
  "relay.pin_refused",
  "command.ended",
  "usage.model_rerouted",
  "session.archived",
  "session.reactivated",
  "session.closed",
  "session.pinned",
  "session.unpinned",
  "session.muted",
  "session.unmuted",
  "session.converted",
  "session.branch_changed",
  "session.swept_to_repo_root",
  "agent.provider_binding_changed",
  "agent.provider_binding_change_failed",
  "approval.requested",
  "approval.approved",
  "approval.reviewer_denied",
  "approval.denial_overridden",
  "run.queued",
  "run.step_limit_reached",
  "run.recovery_resolved",
  "session.goal_updated",
  "session.renamed",
  "pty.control_changed",
  "workflow.started",
  "workflow.resumed",
  "workflow.canceled",
  "workflow.results_posted",
  "workflow.step_started",
  "workflow.step_finished",
  "workflow.step_failed",
  "workflow.step_canceled",
  "workflow.step_skipped",
  "workflow.gate_resolved",
  "backup.completed",
  "backup.failed",
  "backup.restored",
] as const;

// One exported const per `EventCategory`, named `<CATEGORY_IN_SCREAMING_SNAKE>_EVENT_TYPES`, so
// the `*_events` categories read `..._EVENTS_EVENT_TYPES`. Each array holds exactly the registry
// types of its category, and together the arrays partition the census; both are asserted in
// `__tests__/session-event.test.ts`. The explicit `readonly SessionEventType[]` annotations keep
// the exports `isolatedDeclarations`-clean.

/** The event types of the `run_lifecycle` category. */
export const RUN_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "run.queued",
  "run.starting",
  "run.running",
  "run.waiting_for_approval",
  "run.waiting_for_input",
  "run.pausing",
  "run.paused",
  "run.completed",
  "run.interrupted",
  "run.failed",
  "run.rolled_back",
  "run.provider_initialized",
  "run.turn_started",
  "run.worker_shutdown",
  "run.step_limit_reached",
  "run.recovery_resolved",
] as const;

/** The event types of the `assistant_output` category. */
export const ASSISTANT_OUTPUT_EVENT_TYPES: readonly SessionEventType[] = [
  "assistant.message",
  "assistant.thinking_update",
] as const;

/** The event types of the `tool_activity` category. */
export const TOOL_ACTIVITY_EVENT_TYPES: readonly SessionEventType[] = [
  "tool.invoked",
  "tool.result",
  "tool.error",
  "tool.replayed",
  "tool.skipped_during_recovery",
  "subagent.started",
  "subagent.completed",
  "command.ended",
] as const;

/** The event types of the `interactive_request` category. */
export const INTERACTIVE_REQUEST_EVENT_TYPES: readonly SessionEventType[] = [
  "queue_item.created",
  "queue_item.admitted",
  "queue_item.superseded",
  "queue_item.canceled",
  "queue_item.not_delivered",
  "intervention.requested",
  "intervention.accepted",
  "intervention.applied",
  "intervention.rejected",
  "intervention.degraded",
  "intervention.expired",
  "user.message",
  "question.asked",
] as const;

/** The event types of the `artifact_publication` category. */
export const ARTIFACT_PUBLICATION_EVENT_TYPES: readonly SessionEventType[] = [
  "artifact.published",
  "artifact.visibility_updated",
  "artifact.superseded",
  "diff.created",
  "git.settled",
] as const;

/**
 * The event types of the `session_lifecycle` category: session (including the side question, the
 * undo record, the pin and mute marks and a chat's conversion), agent, repo, workspace and
 * worktree (including the branch change and the sweep to the repository root), pty and cloud task.
 */
export const SESSION_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "session.created",
  "session.activated",
  "session.archived",
  "session.reactivated",
  "session.closed",
  "session.purge_requested",
  "session.purged",
  "session.goal_updated",
  "session.goal_cleared",
  "session.provider_status",
  "session.notice",
  "session.renamed",
  "session.pinned",
  "session.unpinned",
  "session.muted",
  "session.unmuted",
  "session.converted",
  "session.side_question_answered",
  "session.restore_finished",
  "agent.provider_binding_changed",
  "agent.provider_binding_change_failed",
  "repo.attached",
  "repo.detached",
  "workspace.preparing",
  "workspace.ready",
  "workspace.stale",
  "workspace.archived",
  "worktree.created",
  "worktree.ready",
  "worktree.dirty",
  "worktree.merged",
  "worktree.retired",
  "session.branch_changed",
  "session.swept_to_repo_root",
  "pty.control_changed",
  "cloud.task_updated",
] as const;

/** The event types of the `approval_flow` category. */
export const APPROVAL_FLOW_EVENT_TYPES: readonly SessionEventType[] = [
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.canceled",
  "approval.remembered",
  "approval.rule_revoked",
  "approval.reviewer_denied",
  "approval.denial_overridden",
  "moderation.review_flagged",
  "plan.proposed",
  "plan.accepted",
  "plan.handed_off",
] as const;

/** The event types of the `usage_telemetry` category. */
export const USAGE_TELEMETRY_EVENT_TYPES: readonly SessionEventType[] = [
  "usage.token_count",
  "usage.cost_update",
  "usage.context_window_update",
  "usage.budget_warning",
  "usage.rate_limit_update",
  "usage.api_retry",
  "usage.context_compacted",
  "usage.model_rerouted",
] as const;

/**
 * The event types of the `runtime_node_lifecycle` category: the two `session.clock_*` events,
 * whose category is the registry's, not their namespace prefix's.
 */
export const RUNTIME_NODE_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "session.clock_unsynced",
  "session.clock_corrected",
] as const;

/** The event types of the `recovery_events` category. */
export const RECOVERY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "recovery.attempted",
  "recovery.succeeded",
  "recovery.failed",
] as const;

/** The event types of the `security_events` category. */
export const SECURITY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "security.default.override",
  "security.update.available",
  "daemon.master_key_source",
  "daemon.pii_split_ambiguous",
  "relay.pin_refused",
] as const;

/** The event types of the `event_maintenance` category. */
export const EVENT_MAINTENANCE_EVENT_TYPES: readonly SessionEventType[] = [
  "event.compacted",
  "backup.completed",
  "backup.failed",
  "backup.restored",
] as const;

/** The event types of the `policy_events` category. */
export const POLICY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "policy_bundle.loaded",
  "policy_bundle.rejected",
] as const;

/** The event types of the `orchestration_admission` category. */
export const ORCHESTRATION_ADMISSION_EVENT_TYPES: readonly SessionEventType[] = [
  "orchestration.rejected",
] as const;

/**
 * The event types of the `mcp_governance` category. Four of the five bind to the daemon-scope
 * sentinel session; `mcp.server_status_changed` binds per event.
 */
export const MCP_GOVERNANCE_EVENT_TYPES: readonly SessionEventType[] = [
  "mcp.server_status_changed",
  "mcp.server_config_changed",
  "mcp.server_trust_changed",
  "mcp.tool_override_changed",
  "mcp.server_oauth_completed",
] as const;

/** The event types of the `workflow_lifecycle` category. */
export const WORKFLOW_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.created",
  "workflow.started",
  "workflow.gated",
  "workflow.failed",
  "workflow.completed",
  "workflow.resumed",
  "workflow.canceled",
  "workflow.run_waiting",
  "workflow.schedule_armed",
  "workflow.schedule_fired",
  "workflow.trigger_armed",
  "workflow.trigger_fired",
  "workflow.results_posted",
] as const;

/** The event types of the `workflow_phase_lifecycle` category. */
export const WORKFLOW_PHASE_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.phase_admitted",
  "workflow.phase_waiting_on_pool",
  "workflow.phase_started",
  "workflow.phase_progressed",
  "workflow.phase_canceling",
  "workflow.phase_failed",
  "workflow.phase_retried",
  "workflow.phase_suspended",
  "workflow.phase_resumed",
  "workflow.phase_completed",
  "workflow.human_phase_claimed",
  "workflow.human_phase_escalated",
  "workflow.step_started",
  "workflow.step_finished",
  "workflow.step_failed",
  "workflow.step_canceled",
  "workflow.step_skipped",
] as const;

/** The event types of the `workflow_parallel_coordination` category. */
export const WORKFLOW_PARALLEL_COORDINATION_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.parallel_join_cancellation",
] as const;

/** The event types of the `workflow_gate_resolution` category. */
export const WORKFLOW_GATE_RESOLUTION_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.gate_resolved",
] as const;

// Internal record behind the exported map. The `satisfies Record<SessionEventType,
// EventCategory>` check makes a missing, unregistered or duplicate key a compile error, so the
// registry cannot drift from `SessionEventType`.
const SESSION_EVENT_CATEGORY_RECORD = {
  // run_lifecycle
  "run.queued": "run_lifecycle",
  "run.starting": "run_lifecycle",
  "run.running": "run_lifecycle",
  "run.waiting_for_approval": "run_lifecycle",
  "run.waiting_for_input": "run_lifecycle",
  "run.pausing": "run_lifecycle",
  "run.paused": "run_lifecycle",
  "run.completed": "run_lifecycle",
  "run.interrupted": "run_lifecycle",
  "run.failed": "run_lifecycle",
  "run.rolled_back": "run_lifecycle",
  "run.provider_initialized": "run_lifecycle",
  "run.turn_started": "run_lifecycle",
  "run.worker_shutdown": "run_lifecycle",
  "run.step_limit_reached": "run_lifecycle",
  "run.recovery_resolved": "run_lifecycle",
  // assistant_output
  "assistant.message": "assistant_output",
  "assistant.thinking_update": "assistant_output",
  // tool_activity
  "tool.invoked": "tool_activity",
  "tool.result": "tool_activity",
  "tool.error": "tool_activity",
  "tool.replayed": "tool_activity",
  "tool.skipped_during_recovery": "tool_activity",
  "subagent.started": "tool_activity",
  "subagent.completed": "tool_activity",
  "command.ended": "tool_activity",
  // interactive_request
  "queue_item.created": "interactive_request",
  "queue_item.admitted": "interactive_request",
  "queue_item.superseded": "interactive_request",
  "queue_item.canceled": "interactive_request",
  "queue_item.not_delivered": "interactive_request",
  "intervention.requested": "interactive_request",
  "intervention.accepted": "interactive_request",
  "intervention.applied": "interactive_request",
  "intervention.rejected": "interactive_request",
  "intervention.degraded": "interactive_request",
  "intervention.expired": "interactive_request",
  "user.message": "interactive_request",
  "question.asked": "interactive_request",
  // artifact_publication
  "artifact.published": "artifact_publication",
  "artifact.visibility_updated": "artifact_publication",
  "artifact.superseded": "artifact_publication",
  "diff.created": "artifact_publication",
  "git.settled": "artifact_publication",
  // session_lifecycle
  "session.created": "session_lifecycle",
  "session.activated": "session_lifecycle",
  "session.archived": "session_lifecycle",
  "session.reactivated": "session_lifecycle",
  "session.closed": "session_lifecycle",
  "session.purge_requested": "session_lifecycle",
  "session.purged": "session_lifecycle",
  "session.goal_updated": "session_lifecycle",
  "session.goal_cleared": "session_lifecycle",
  "session.provider_status": "session_lifecycle",
  "session.notice": "session_lifecycle",
  "session.renamed": "session_lifecycle",
  "session.pinned": "session_lifecycle",
  "session.unpinned": "session_lifecycle",
  "session.muted": "session_lifecycle",
  "session.unmuted": "session_lifecycle",
  "session.converted": "session_lifecycle",
  "session.side_question_answered": "session_lifecycle",
  "session.restore_finished": "session_lifecycle",
  "agent.provider_binding_changed": "session_lifecycle",
  "agent.provider_binding_change_failed": "session_lifecycle",
  "repo.attached": "session_lifecycle",
  "repo.detached": "session_lifecycle",
  "workspace.preparing": "session_lifecycle",
  "workspace.ready": "session_lifecycle",
  "workspace.stale": "session_lifecycle",
  "workspace.archived": "session_lifecycle",
  "worktree.created": "session_lifecycle",
  "worktree.ready": "session_lifecycle",
  "worktree.dirty": "session_lifecycle",
  "worktree.merged": "session_lifecycle",
  "worktree.retired": "session_lifecycle",
  "session.branch_changed": "session_lifecycle",
  "session.swept_to_repo_root": "session_lifecycle",
  "pty.control_changed": "session_lifecycle",
  "cloud.task_updated": "session_lifecycle",
  // approval_flow
  "approval.requested": "approval_flow",
  "approval.approved": "approval_flow",
  "approval.rejected": "approval_flow",
  "approval.canceled": "approval_flow",
  "approval.remembered": "approval_flow",
  "approval.rule_revoked": "approval_flow",
  "approval.reviewer_denied": "approval_flow",
  "approval.denial_overridden": "approval_flow",
  "moderation.review_flagged": "approval_flow",
  "plan.proposed": "approval_flow",
  "plan.accepted": "approval_flow",
  "plan.handed_off": "approval_flow",
  // usage_telemetry
  "usage.token_count": "usage_telemetry",
  "usage.cost_update": "usage_telemetry",
  "usage.context_window_update": "usage_telemetry",
  "usage.budget_warning": "usage_telemetry",
  "usage.rate_limit_update": "usage_telemetry",
  "usage.api_retry": "usage_telemetry",
  "usage.context_compacted": "usage_telemetry",
  "usage.model_rerouted": "usage_telemetry",
  // runtime_node_lifecycle
  "session.clock_unsynced": "runtime_node_lifecycle",
  "session.clock_corrected": "runtime_node_lifecycle",
  // recovery_events
  "recovery.attempted": "recovery_events",
  "recovery.succeeded": "recovery_events",
  "recovery.failed": "recovery_events",
  // security_events
  "security.default.override": "security_events",
  "security.update.available": "security_events",
  "daemon.master_key_source": "security_events",
  "daemon.pii_split_ambiguous": "security_events",
  "relay.pin_refused": "security_events",
  // event_maintenance
  "event.compacted": "event_maintenance",
  "backup.completed": "event_maintenance",
  "backup.failed": "event_maintenance",
  "backup.restored": "event_maintenance",
  // policy_events
  "policy_bundle.loaded": "policy_events",
  "policy_bundle.rejected": "policy_events",
  // orchestration_admission
  "orchestration.rejected": "orchestration_admission",
  // mcp_governance
  "mcp.server_status_changed": "mcp_governance",
  "mcp.server_config_changed": "mcp_governance",
  "mcp.server_trust_changed": "mcp_governance",
  "mcp.tool_override_changed": "mcp_governance",
  "mcp.server_oauth_completed": "mcp_governance",
  // workflow_lifecycle
  "workflow.created": "workflow_lifecycle",
  "workflow.started": "workflow_lifecycle",
  "workflow.gated": "workflow_lifecycle",
  "workflow.failed": "workflow_lifecycle",
  "workflow.completed": "workflow_lifecycle",
  "workflow.resumed": "workflow_lifecycle",
  "workflow.canceled": "workflow_lifecycle",
  "workflow.run_waiting": "workflow_lifecycle",
  "workflow.schedule_armed": "workflow_lifecycle",
  "workflow.schedule_fired": "workflow_lifecycle",
  "workflow.trigger_armed": "workflow_lifecycle",
  "workflow.trigger_fired": "workflow_lifecycle",
  "workflow.results_posted": "workflow_lifecycle",
  // workflow_phase_lifecycle
  "workflow.phase_admitted": "workflow_phase_lifecycle",
  "workflow.phase_waiting_on_pool": "workflow_phase_lifecycle",
  "workflow.phase_started": "workflow_phase_lifecycle",
  "workflow.phase_progressed": "workflow_phase_lifecycle",
  "workflow.phase_canceling": "workflow_phase_lifecycle",
  "workflow.phase_failed": "workflow_phase_lifecycle",
  "workflow.phase_retried": "workflow_phase_lifecycle",
  "workflow.phase_suspended": "workflow_phase_lifecycle",
  "workflow.phase_resumed": "workflow_phase_lifecycle",
  "workflow.phase_completed": "workflow_phase_lifecycle",
  "workflow.human_phase_claimed": "workflow_phase_lifecycle",
  "workflow.human_phase_escalated": "workflow_phase_lifecycle",
  "workflow.step_started": "workflow_phase_lifecycle",
  "workflow.step_finished": "workflow_phase_lifecycle",
  "workflow.step_failed": "workflow_phase_lifecycle",
  "workflow.step_canceled": "workflow_phase_lifecycle",
  "workflow.step_skipped": "workflow_phase_lifecycle",
  // workflow_parallel_coordination
  "workflow.parallel_join_cancellation": "workflow_parallel_coordination",
  // workflow_gate_resolution
  "workflow.gate_resolved": "workflow_gate_resolution",
} satisfies Record<SessionEventType, EventCategory>;

/**
 * Each registered wire type's category, for checking category/type consistency without
 * re-parsing. A `ReadonlyMap`, not an object, so an untrusted `.get(evt.type)` cannot walk the
 * prototype chain (`__proto__` and `constructor` would resolve to truthy non-categories). Readers
 * consult it before parsing through `SessionEventSchema`, so that immunity matters.
 */
export const SESSION_EVENT_CATEGORY_BY_TYPE: ReadonlyMap<SessionEventType, EventCategory> = new Map(
  // Sound by the `satisfies` check above: the record's keys are exactly the `SessionEventType`
  // literals.
  Object.entries(SESSION_EVENT_CATEGORY_RECORD) as ReadonlyArray<[SessionEventType, EventCategory]>,
);

// The provider drivers normalize both provider wires into a fixed vocabulary of normalized kinds
// before the taxonomy maps each kind onto a `SessionEventType`. `EVENT_DISPOSITION_BY_KIND` is the
// machine-readable form of that mapping. Every kind has exactly one disposition: `adopt` and
// `rename` name an event type, and every `correlate` and `discard` carries a stated reason, so no
// capability-bearing kind is dropped silently.
//
// The registry covers the census kinds only. Wire-level channel discards and delta families
// belong to the normalizers' wire layer and are not keys here; a wire kind outside the census is
// caught by the normalizers' default-branch diagnostic, never by this registry.
//
// An entry may carry `typePending` in place of `eventType`: a literal minted ahead of its
// registration. No entry uses that arm now; it is kept for the next such case, and the
// normalizers route a pending kind to their diagnostic branch instead of building an envelope
// against a missing type. An `eventType` that is not a census literal is a compile error, since
// it is typed `SessionEventType`.
//
// Registration is not emission license: a normalizer routes a registered kind to its diagnostic
// branch until the owning surface registers the payload variant in `SessionEventSchema`, so
// emission turns on variant by variant.

// The closed set of normalized kinds. Blocks group related kinds; order is not load-bearing.
/** One kind in the normalized vocabulary that the provider drivers map their wires into. */
export type NormalizedEventKind =
  // Inline timeline.
  | "init"
  | "text_delta"
  | "tool_start"
  | "tool_complete"
  | "turn_start"
  | "turn_complete"
  | "approval_request"
  | "approval_resolved"
  | "user_input_request"
  | "user_input_resolved"
  | "session_status"
  | "token_usage"
  | "error"
  | "todo_update"
  // Task mirror.
  | "task_create"
  | "task_update"
  | "notification"
  // Transient retry.
  | "api_retry"
  // System, no timeline row.
  | "compact_boundary"
  | "rate_limits"
  | "model_rerouted"
  | "thread_renamed"
  | "content_block_start"
  | "content_block_stop"
  // Background and subagent.
  | "background_task_terminal"
  | "background_task_notification"
  | "subagent_notification"
  | "subagent_status"
  // Codex process and terminal.
  | "codex_exec_result"
  | "terminal_interaction"
  // Wire echo.
  | "user_text"
  // Heavy, persisted.
  | "diff"
  | "command_output"
  | "thinking"
  | "proposed_plan";

/** Every {@link NormalizedEventKind} as an iterable tuple, like the per-category arrays. */
export const NORMALIZED_EVENT_KINDS: readonly NormalizedEventKind[] = [
  "init",
  "text_delta",
  "tool_start",
  "tool_complete",
  "turn_start",
  "turn_complete",
  "approval_request",
  "approval_resolved",
  "user_input_request",
  "user_input_resolved",
  "session_status",
  "token_usage",
  "error",
  "todo_update",
  "task_create",
  "task_update",
  "notification",
  "api_retry",
  "compact_boundary",
  "rate_limits",
  "model_rerouted",
  "thread_renamed",
  "content_block_start",
  "content_block_stop",
  "background_task_terminal",
  "background_task_notification",
  "subagent_notification",
  "subagent_status",
  "codex_exec_result",
  "terminal_interaction",
  "user_text",
  "diff",
  "command_output",
  "thinking",
  "proposed_plan",
] as const;

/**
 * What a normalized kind becomes. `adopt` and `rename` name a category and exactly one of
 * `eventType` (a registered {@link SessionEventType}) or `typePending` (a literal minted ahead of
 * its registration; no entry uses this arm now). `correlate` and `discard` carry only a non-empty
 * `reason` and no taxonomy target: a correlate folds into an existing row via `correlation_id`,
 * and a discard is consumed transiently. `eventType` names the kind's primary target only;
 * outcome-dependent fan-out (`tool.error`, `approval.rejected` and `approval.canceled`,
 * `subagent.completed`) is the normalizer's business. The `never` members make an entry with both
 * targets, or with a `reason` on an adopt or rename, a type error.
 *
 * Every property is `readonly` because {@link EVENT_DISPOSITION_BY_KIND} hands out shared
 * entries: `ReadonlyMap` blocks `.set()` but not property writes on an entry it returned, so a
 * consumer's `entry.category = ...` would otherwise corrupt the registry process-wide.
 */
export type EventKindDisposition =
  | {
      readonly disposition: "adopt" | "rename";
      readonly category: EventCategory;
      readonly eventType: SessionEventType;
      readonly typePending?: never;
      readonly reason?: never;
    }
  | {
      readonly disposition: "adopt" | "rename";
      readonly category: EventCategory;
      readonly typePending: "B18";
      readonly eventType?: never;
      readonly reason?: never;
    }
  | {
      readonly disposition: "correlate";
      readonly reason: string;
      readonly category?: never;
      readonly eventType?: never;
      readonly typePending?: never;
    }
  | {
      readonly disposition: "discard";
      readonly reason: string;
      readonly category?: never;
      readonly eventType?: never;
      readonly typePending?: never;
    };

// Internal record behind the exported map, like `SESSION_EVENT_CATEGORY_RECORD`. The `satisfies
// Record<NormalizedEventKind, EventKindDisposition>` check makes a missing, unregistered or
// duplicate key a compile error, and the `EventKindDisposition` arms reject an entry that carries
// both `eventType` and `typePending`, a `reason` beside a taxonomy target, or a taxonomy target
// on a correlate or discard. Each entry names its kind's primary target; fan-out is the
// normalizer's concern.
const EVENT_DISPOSITION_RECORD = {
  // Inline timeline.
  // Run-start marker: the provider's own init report. The daemon's `run.*` state transitions stay
  // daemon-emitted, never mapped from a provider init.
  init: {
    disposition: "adopt",
    category: "run_lifecycle",
    eventType: "run.provider_initialized",
  },
  text_delta: {
    disposition: "adopt",
    category: "assistant_output",
    eventType: "assistant.message",
  },
  tool_start: { disposition: "adopt", category: "tool_activity", eventType: "tool.invoked" },
  // Tool-lifecycle completion; a failure outcome fans to `tool.error`.
  tool_complete: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  // Turn boundary.
  turn_start: { disposition: "adopt", category: "run_lifecycle", eventType: "run.turn_started" },
  // Turn complete; `completionKind` separates a turn from a task.
  turn_complete: { disposition: "adopt", category: "run_lifecycle", eventType: "run.completed" },
  // A provider's permission ask that reaches a person, recorded once as the
  // approval it opens. An ask the daemon answers itself, by a policy allow or a
  // remembered rule, appends nothing: the tool row is the record.
  approval_request: {
    disposition: "adopt",
    category: "approval_flow",
    eventType: "approval.requested",
  },
  // Approval resolution; fans by outcome to `approval.rejected` /
  // `approval.canceled`.
  approval_resolved: {
    disposition: "adopt",
    category: "approval_flow",
    eventType: "approval.approved",
  },
  // A structured question to the person: the question record the card renders.
  user_input_request: {
    disposition: "adopt",
    category: "interactive_request",
    eventType: "question.asked",
  },
  user_input_resolved: {
    disposition: "discard",
    reason:
      "the answer is recorded as the person's own user.message turn by the call that answered the question; its delivery to the provider is kept in the daemon's log only",
  },
  // Coarse provider status; it never drives a `session.*` state transition, so none is fabricated.
  session_status: {
    disposition: "adopt",
    category: "session_lifecycle",
    eventType: "session.provider_status",
  },
  token_usage: {
    disposition: "adopt",
    category: "usage_telemetry",
    eventType: "usage.token_count",
  },
  // Run-failure envelope.
  error: { disposition: "adopt", category: "run_lifecycle", eventType: "run.failed" },
  // Todo-snapshot projection (TodoWrite-family result row).
  todo_update: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  // Task mirror: per-task create and update fold into the per-thread mirror and `todo_update`
  // snapshots.
  task_create: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  task_update: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  // Generic user-facing notice fed by Codex; Claude's system-channel `notification` subtype is
  // discarded in the wire layer and is not a registry key.
  notification: {
    disposition: "adopt",
    category: "session_lifecycle",
    eventType: "session.notice",
  },
  // Transient retry record; Claude's `system.api_retry` typed-error enum enriches this same kind,
  // so it is never dropped.
  api_retry: { disposition: "adopt", category: "usage_telemetry", eventType: "usage.api_retry" },
  // System, no timeline row.
  // Provider context-window compaction — distinct from the daemon
  // `event.compacted` retention pass.
  compact_boundary: {
    disposition: "adopt",
    category: "usage_telemetry",
    eventType: "usage.context_compacted",
  },
  // The Claude wire string `rate_limit_event` RENAMES onto `rate_limits`:
  // an account-plane quota snapshot, never context-window telemetry.
  rate_limits: {
    disposition: "rename",
    category: "usage_telemetry",
    eventType: "usage.rate_limit_update",
  },
  // Mid-run model-reroute telemetry.
  model_rerouted: {
    disposition: "adopt",
    category: "usage_telemetry",
    eventType: "usage.model_rerouted",
  },
  // Session/thread rename.
  thread_renamed: {
    disposition: "adopt",
    category: "session_lifecycle",
    eventType: "session.renamed",
  },
  content_block_start: {
    disposition: "discard",
    reason:
      "streaming-structural envelope boundary; the wrapped text_delta kind carries the durable content — no separate timeline or persistence capability",
  },
  content_block_stop: {
    disposition: "discard",
    reason:
      "paired streaming envelope boundary; same streaming-structural reason as content_block_start — the wrapped text_delta kind carries the durable content",
  },
  // Background and subagent.
  // Richer sibling completion; never replaces the tool-lifecycle
  // completion row.
  background_task_terminal: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "subagent.completed",
  },
  // Non-lifecycle task notice; may carry a durable output-file path.
  background_task_notification: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "tool.result",
  },
  // Codex detached-child terminal injected into the parent's next turn.
  subagent_notification: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "subagent.completed",
  },
  // Subagent-lifecycle row / internal child-thread status; fans to
  // `subagent.completed`.
  subagent_status: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "subagent.started",
  },
  // Codex process and terminal.
  // Raw exec-output signal — exited-during-wait vs
  // yielded-with-resumable-session.
  codex_exec_result: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  // Stdin writes to a backgrounded PTY; non-empty stdin redacted from
  // durable metadata.
  terminal_interaction: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "tool.invoked",
  },
  // Wire echo.
  user_text: {
    disposition: "correlate",
    reason:
      "correlation-only wire echo — folds into the originating app-sent user-message row via correlation_id (delivery confirmation of the pending send; no new persisted type); correlate target user.message (B18-minted 2026-07-22, registered in this census so the target literal resolves; the echo keeps routing to normalizer default-branch diagnostic until user.message payload variant joins the union)",
  },
  // Heavy, persisted: the payload goes to SQLite and light metadata to the client.
  diff: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  command_output: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  thinking: {
    disposition: "adopt",
    category: "assistant_output",
    eventType: "assistant.thinking_update",
  },
  // Plan proposal.
  proposed_plan: {
    disposition: "adopt",
    category: "assistant_output",
    eventType: "assistant.message",
  },
} satisfies Record<NormalizedEventKind, EventKindDisposition>;

/**
 * The disposition of each normalized kind: what the taxonomy makes of it, or why it is folded or
 * dropped. The normalizers consult it; the section comment above says what it covers. A
 * `ReadonlyMap`, not a plain object, for the same `.get()` safety as
 * {@link SESSION_EVENT_CATEGORY_BY_TYPE}: an untrusted wire kind such as `__proto__` or
 * `constructor` resolves to `undefined`, never a truthy non-disposition value.
 */
export const EVENT_DISPOSITION_BY_KIND: ReadonlyMap<NormalizedEventKind, EventKindDisposition> =
  new Map(
    // Sound by the `satisfies` check above: the record's keys are exactly the
    // `NormalizedEventKind` literals.
    Object.entries(EVENT_DISPOSITION_RECORD) as ReadonlyArray<
      [NormalizedEventKind, EventKindDisposition]
    >,
  );

// Cross-file ID types (`SessionId`, `UserId`, ...) are not re-exported here: the package barrel
// already exports them from session.ts, and a second export would conflict.
