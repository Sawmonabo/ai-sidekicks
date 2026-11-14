// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The session event envelope: the closed categories, the tolerant envelope every event is stored and sent in, the execution-epoch stamp and the hydrated (envelope plus body) reader shape.

import type { SessionId } from "../session/id.js";
import type { EventEnvelopeVersion } from "./version.js";

/**
 * The largest `sequence` an envelope may carry, not a tunable: `sequence` travels as an
 * IEEE-754 double, which holds integers exactly only up to 2^53 − 1, so above it two events
 * would share an order key.
 */
export const EVENT_ENVELOPE_SEQUENCE_MAX = 9007199254740991 as const;

/** Payload key of the epoch stamp; ingestion writes it and the supersede projection reads it. */
export const SOURCE_EPOCH_PAYLOAD_KEY = "sourceEpoch" as const;

/** Payload key of the position stamp; it moves with the epoch stamp's key. */
export const SOURCE_POSITION_PAYLOAD_KEY = "sourcePosition" as const;

/**
 * The category a session event belongs to; every event type maps to exactly one, so a mismatched
 * pair fails the strict parse. Adding a category is a minor version bump.
 */
export type EventCategory =
  | "runLifecycle"
  | "agentOutput"
  | "toolActivity"
  | "interactiveRequest"
  | "artifactPublication"
  | "sessionLifecycle"
  | "approvalFlow"
  | "usageTelemetry"
  | "recoveryEvents"
  | "securityEvents"
  | "eventMaintenance"
  | "orchestrationAdmission"
  | "mcpGovernance"
  | "workflowLifecycle"
  | "workflowPhaseLifecycle"
  | "workflowParallelCoordination"
  | "workflowGateResolution";
/**
 * An event's type as the envelope stores it: free-form text rather than a known type, so a
 * reader can store and pass on a type a newer producer wrote.
 */
export type EventEnvelopeType = string;
/**
 * When an incoming event occurred: a real date and time with `Z` or an offset, its seconds optional, its fraction holding no non-zero digit past the third.
 */
export type EventOccurredAt = string;
/**
 * The execution epoch a late-appended row is attributed to: `0` before any rollback, advanced
 * by each accepted `agent.run.rolledBack`.
 */
export type SourceEpoch = number;
/**
 * The run position a stamped row occupies within its source epoch, counting the person's
 * messages the run took (a turn's opening or a steer), not turns, so the supersede cutoff
 * (`position > targetPosition`) can rank a late row against its epoch's surviving rows.
 */
export type SourcePosition = number;
/**
 * Why a stored event's body is not available.
 */
export type HydratedContentUnavailableReason = "absent";
/**
 * A stored event's body as a reader receives it beside the event, never merged into its payload.
 */
export type HydratedSessionEventContent =
  | {
      status: "available";
      /**
       * The opened body, whole.
       */
      body: string;
      /**
       * The whole body's UTF-8 byte length, echoed from the stored payload, never recomputed
       * from `body`.
       */
      contentLength?: number;
    }
  | {
      status: "unavailable";
      /**
       * Why.
       */
      reason: HydratedContentUnavailableReason;
    };

/**
 * The message every session event is stored and travels in. Its own members are closed; its
 * `type` and `payload` are kept as written, so an event from a newer producer survives a read
 * and a write unchanged.
 */
export interface EventEnvelope {
  /**
   * The event's id, opaque on the wire; the daemon assigns a UUID v7.
   */
  id: string;
  /**
   * The session the event belongs to.
   */
  sessionId: SessionId;
  /**
   * Daemon-assigned and strictly increasing per session: the order key.
   */
  sequence: number;
  /**
   * When the event occurred; the append path stores it in UTC with millisecond precision.
   */
  occurredAt: EventOccurredAt;
  /**
   * The event's category.
   */
  category: EventCategory;
  /**
   * The event's type, kept as written.
   */
  type: EventEnvelopeType;
  /**
   * A person's or an agent's id; `null` or absent for a system event, never empty.
   */
  actor?: string | null;
  /**
   * The category's own members, every one kept as written but `__proto__`, which a JavaScript
   * reader cannot keep; may carry the epoch stamp.
   */
  payload: {
    [k: string]: unknown | undefined;
  };
  /**
   * The id that ties this event to others of one operation.
   */
  correlationId?: string;
  /**
   * The id of what caused this event.
   */
  causationId?: string;
  /**
   * The producer's version, written at emit time and never rewritten on read, so it is part of
   * the row's durable identity.
   */
  version: EventEnvelopeVersion;
}
/**
 * A stored event paired with its machine-authored body. `event` is the tolerant envelope, byte
 * for byte the stored row, so a reader need not parse it again to ask whether it has a body.
 */
export interface HydratedSessionEvent {
  /**
   * The stored event.
   */
  event: EventEnvelope;
  /**
   * Its body.
   */
  content: HydratedSessionEventContent;
}

export {
  validateEventCategory,
  validateEventEnvelope,
  validateEventEnvelopeType,
  validateEventOccurredAt,
  validateHydratedContentUnavailableReason,
  validateSourceEpoch,
  validateSourcePosition,
} from "../checks/event/envelope.js";
