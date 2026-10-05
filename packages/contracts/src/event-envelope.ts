// The session event envelope: its version rules, the closed categories, the execution-epoch stamp
// and the hydrated (envelope plus content) reader shape.

import { z } from "zod";
import {
  EVENT_FIELD_MAX_LEN,
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "./event-core.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";
import { countSchema, isoDateTimeSchema } from "./internal/wire-scalars.js";

/**
 * The category a session event belongs to; every event type maps to exactly one, so a mismatched
 * pair fails to parse. Adding a category is a MINOR version bump.
 */
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

// Declared in `./event-core.js`, the leaf below this file, and re-exported here.
export type { EventEnvelopeVersion } from "./event-core.js";
export {
  /** @consumedBy a reader that checks an event envelope's version */
  EVENT_ENVELOPE_VERSION_MAX_LEN,
  /** @consumedBy a reader that checks an event envelope's version */
  EVENT_ENVELOPE_VERSION_PATTERN,
  EVENT_FIELD_MAX_LEN,
  EventEnvelopeVersionSchema,
} from "./event-core.js";

/**
 * Three-way comparison of two envelope versions (-1, 0, 1), numeric on MAJOR then MINOR, never as
 * text ("1.10" is above "1.9"). A value cast past the brand with a non-integer segment throws
 * `SyntaxError` rather than misordering.
 */
export function compareEventEnvelopeVersion(
  a: EventEnvelopeVersion,
  b: EventEnvelopeVersion,
): -1 | 0 | 1 {
  // `BigInt` keeps the compare exact above `Number.MAX_SAFE_INTEGER`; the brand guarantees two
  // integer segments.
  const [aMajor, aMinor] = a.split(".").map(BigInt) as [bigint, bigint];
  const [bMajor, bMinor] = b.split(".").map(BigInt) as [bigint, bigint];
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  return 0;
}

// Two layers. `EventEnvelopeSchema` is the version-tolerant envelope: a newer producer's unknown
// `type` is stored as a version stub and its unknown payload fields are kept verbatim, but the
// category set and the top-level members stay closed. `SessionEventSchema` in `event.ts` is the
// strict layer, where an unknown type or a category/type mismatch fails to parse. Free-form
// fields use `wireFreeFormString`, which bounds length and refuses blank and NUL values.

/**
 * The largest `sequence` an envelope may carry, not a tunable: `sequence` travels as an IEEE-754
 * double, which holds integers exactly only up to 2^53 - 1, so above it two events would share an
 * order key.
 */
export const EVENT_ENVELOPE_SEQUENCE_MAX: number = Number.MAX_SAFE_INTEGER;

/**
 * The `sessionId` that rows describing the machine rather than a conversation bind to: the RFC
 * 9562 Max UUID, which no versioned session id can equal. Parsed at import, so an id check that
 * stops admitting it fails at load rather than on the wire.
 */
export const DAEMON_SCOPE_SENTINEL_SESSION_ID: SessionId = SessionIdSchema.parse(
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
);

/**
 * The message every session event travels in, validated by {@link EventEnvelopeSchema}. Each
 * member maps to a `session_events` column.
 */
export interface EventEnvelope {
  /** Opaque on the wire; the daemon assigns a UUID v7. */
  id: string;
  sessionId: SessionId;
  /** Daemon-assigned, strictly increasing per session: the order key. */
  sequence: number;
  /** ISO 8601; the append path normalizes it to RFC 3339 UTC with millisecond precision. */
  occurredAt: string;
  category: EventCategory;
  /** A plain string, not `SessionEventType`, so a reader can store a type it does not know. */
  type: string;
  /** A user or agent id; `null` or absent for system events, never empty. */
  actor?: string | null | undefined;
  /**
   * Category-specific fields, open so a newer producer's fields are kept verbatim; an own
   * `__proto__` key is refused. May carry the epoch stamp ({@link withEpochStamp}).
   */
  payload: Record<string, unknown>;
  correlationId?: string | undefined;
  causationId?: string | undefined;
  /**
   * The producer's `"MAJOR.MINOR"` version, written at emit time and never rewritten on read, so it
   * is part of the row's durable identity.
   */
  version: EventEnvelopeVersion;
}

/**
 * The members `EventEnvelopeSchema` and every variant share. `category` is left out: a variant
 * needs it as a literal so a category/type mismatch fails to parse.
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
  id: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.id"),
  sessionId: SessionIdSchema,
  // `.int()` already enforces the ceiling; the `.max()` exists so an out-of-range value says why.
  sequence: z
    .number()
    .int()
    .nonnegative()
    .max(EVENT_ENVELOPE_SEQUENCE_MAX, {
      message:
        `sequence must be at most ${EVENT_ENVELOPE_SEQUENCE_MAX} ` +
        `(Number.MAX_SAFE_INTEGER): above it distinct sequences collapse onto the same ` +
        `IEEE-754 double, so two different events would carry the same order key.`,
    }),
  occurredAt: isoDateTimeSchema,
  // `.nullable()` comes after the helper so its string checks run only on strings.
  actor: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.actor").nullable().optional(),
  correlationId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.correlationId").optional(),
  causationId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.causationId").optional(),
  version: EventEnvelopeVersionSchema,
});

/** Runtime validator for {@link EventEnvelope}: exactly the canonical members, none unknown. */
export const EventEnvelopeSchema: z.ZodType<EventEnvelope> = z
  .object({
    ...buildCommonShape(),
    category: EventCategorySchema,
    type: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.type"),
    // Zod's record parser skips an own `__proto__` key, so two different wire strings would parse
    // to one value; the guard refuses that key on the raw input, before the record drops it.
    payload: z
      .unknown()
      .superRefine((value, ctx) => {
        if (typeof value === "object" && value !== null && Object.hasOwn(value, "__proto__")) {
          ctx.addIssue({
            code: "custom",
            message:
              "EventEnvelope.payload MUST NOT carry an own __proto__ key — the " +
              "record parser cannot preserve it, and silent stripping is forbidden.",
          });
        }
      })
      .pipe(z.record(z.string(), z.unknown())),
  })
  // Membership is closed although the carrier is otherwise tolerant: stripping an unknown member
  // would desync the parsed value from the stored canonical bytes.
  .strict();

// The epoch stamp: `sourceEpoch` + `sourcePosition`, carried in the payload by a non-lifecycle row
// appended late for a superseded execution epoch (after a rollback); a current-epoch row carries
// neither, so the stamp is never fabricated. Only a variant whose payload always carries `runId`
// takes it (the assistant, tool, `command.ended` and `usage.model_rerouted` events): a lifecycle
// row, an ask or a question from a superseded epoch is absorbed at the epoch check instead. A
// variant is wrapped with {@link withEpochStamp} when it is registered.

/**
 * The execution epoch a late-appended non-lifecycle row is attributed to: `0` before any rollback,
 * advanced by each accepted `run.rolled_back`.
 */
export type SourceEpoch = number;
/** Wire schema for {@link SourceEpoch}. */
export const SourceEpochSchema: z.ZodType<SourceEpoch> = countSchema;

/**
 * The turn position a stamped row occupies within its source epoch, so the supersede cutoff
 * (`turn > targetPosition`) can rank a late row against its epoch's surviving rows.
 */
export type SourcePosition = number;
/** Wire schema for {@link SourcePosition}. */
export const SourcePositionSchema: z.ZodType<SourcePosition> = countSchema;

/** Payload key of the epoch stamp; ingestion writes it and the supersede projection reads it. */
export const SOURCE_EPOCH_PAYLOAD_KEY = "sourceEpoch" as const;
/** Payload key of the position stamp; it moves with {@link SOURCE_EPOCH_PAYLOAD_KEY}. */
export const SOURCE_POSITION_PAYLOAD_KEY = "sourcePosition" as const;

/**
 * Adds the optional epoch stamp to a run-scoped `.strict()` payload schema: either key requires
 * the other and a present, non-null `runId`, because epochs and positions are run-local. The type
 * refuses a shape that already declares either key, so a payload cannot be wrapped twice.
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
  // TypeScript cannot reduce `.extend()`'s `Extend<Shape, U>` while `Shape` is generic, so the
  // return cast asserts the intersection the constraint guarantees.
  return payloadSchema
    .extend({
      [SOURCE_EPOCH_PAYLOAD_KEY]: SourceEpochSchema.optional(),
      [SOURCE_POSITION_PAYLOAD_KEY]: SourcePositionSchema.optional(),
    })
    .superRefine((value, ctx) => {
      // The helper is generic over the shape, so these keys are reachable only by index.
      const stamped = value as Record<string, unknown>;
      const hasEpoch = stamped[SOURCE_EPOCH_PAYLOAD_KEY] !== undefined;
      const hasPosition = stamped[SOURCE_POSITION_PAYLOAD_KEY] !== undefined;
      if (!hasEpoch && !hasPosition) return;
      if (!hasPosition) {
        ctx.addIssue({
          code: "custom",
          path: [SOURCE_POSITION_PAYLOAD_KEY],
          message:
            `A ${SOURCE_EPOCH_PAYLOAD_KEY} stamp REQUIREs ` +
            `${SOURCE_POSITION_PAYLOAD_KEY}: the supersede cutoff cannot rank the ` +
            `row against its epoch's surviving prefix without a position.`,
        });
      }
      if (!hasEpoch) {
        ctx.addIssue({
          code: "custom",
          path: [SOURCE_EPOCH_PAYLOAD_KEY],
          message:
            `A ${SOURCE_POSITION_PAYLOAD_KEY} stamp REQUIREs ${SOURCE_EPOCH_PAYLOAD_KEY}: ` +
            `a position without its epoch names no epoch to supersede against.`,
        });
      }
      // Not a truthiness test: an empty `runId` is the base schema's to refuse.
      if (stamped["runId"] === undefined || stamped["runId"] === null) {
        ctx.addIssue({
          code: "custom",
          path: ["runId"],
          message:
            `A ${SOURCE_EPOCH_PAYLOAD_KEY}/${SOURCE_POSITION_PAYLOAD_KEY} stamp ` +
            `REQUIREs a present, non-null runId: epochs and positions are run-local, ` +
            `so an epoch stamp on a row with no run identity is unattributable.`,
        });
      }
    }) as unknown as z.ZodObject<
    Shape & {
      sourceEpoch: z.ZodOptional<z.ZodType<SourceEpoch>>;
      sourcePosition: z.ZodOptional<z.ZodType<SourcePosition>>;
    },
    z.core.$strict
  >;
}

// A hydrated event keeps the body beside the envelope, never merged into `event.payload`, and
// `event` is the tolerant envelope, so a reader need not re-parse a row to ask if it has a body.

/** Why a body is not available: the row never carried one. */
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
