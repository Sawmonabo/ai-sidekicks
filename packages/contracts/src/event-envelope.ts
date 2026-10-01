// The session event envelope: its version rules, the closed categories, the execution-epoch stamp
// and the hydrated (envelope plus content) reader shape.
//
// `version` is a `"MAJOR.MINOR"` string, never a number: comparing "1.10" with "1.9" as text is
// wrong, so the reader parses both parts as integers. `EventEnvelopeVersionSchema` in
// `./event-core.js` checks the format.

import { z } from "zod";
import {
  EVENT_FIELD_MAX_LEN,
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "./event-core.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";

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
  | "recovery_events"
  | "security_events"
  | "event_maintenance"
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
  "recovery_events",
  "security_events",
  "event_maintenance",
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
export type { EventEnvelopeVersion } from "./event-core.js";
export {
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

// Two layers: the carrier below, and the strict `SessionEventSchema` in `event.ts`.
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
// bytes, and new data goes in `payload`.

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

/**
 * The members `EventEnvelopeSchema` and every variant share, so shared-field validation cannot
 * drift. `category` is left out: variants need it as a literal so a category/type mismatch fails to
 * parse, while the envelope uses the full enum.
 */
export const buildCommonShape = (): {
  id: z.ZodString;
  sessionId: z.ZodType<SessionId, SessionId>;
  sequence: z.ZodNumber;
  occurredAt: z.ZodISODateTime;
  actor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  correlationId: z.ZodOptional<z.ZodString>;
  causationId: z.ZodOptional<z.ZodString>;
  version: z.ZodType<EventEnvelopeVersion>;
} => ({
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
  // would desync the parsed value from the stored canonical bytes.
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
// No check walks the union for this: a branch is wrapped, or left bare, by this rule when it is
// registered.
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
 *   returns a non-strict schema. Only a `.strict()` payload is wrapped.
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
  // spread last.
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

// `event` and `content` are separate members on purpose: the body is never merged into
// `event.payload`, whose strict schemas declare no body member. `event` is the tolerant
// {@link EventEnvelope}, not the strict {@link SessionEvent}: a stored row is rebuilt through the
// carrier, and narrowing is a step the caller chooses, so a reader need not re-parse a row just
// to ask whether the body opened.

/**
 * Why a body is not available: the row never carried one. Nothing is sealed, so no other reason
 * exists; the member stays a closed union so a caller reads a reason, not a missing key.
 */
export type HydratedContentUnavailableReason = "absent";

/** Parses a {@link HydratedContentUnavailableReason}. */
export const HydratedContentUnavailableReasonSchema: z.ZodType<HydratedContentUnavailableReason> =
  z.literal("absent");

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
