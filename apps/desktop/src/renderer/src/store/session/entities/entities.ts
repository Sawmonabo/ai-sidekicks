// The console's entity vocabulary and the shape of a store mutation, which encode three rules:
//   - Entity-keyed and partitioned. State is a map per entity kind, so a mutation replaces one
//     partition's identity and an untouched kind's row selector bails on `Object.is`. A flat map
//     would copy every entity per event; a partitioned one copies only the touched kind's.
//   - A store never caches a flag another store owns. A projection needing two kinds composes
//     them at read time; a denormalized copy is a second source of truth the reconnect path
//     cannot heal.
//   - Projections never persist. `persistence/` holds UI state only, and every entity here is
//     re-derived from the daemon on reconnect.
import { ENTITY_KINDS, type EntityKind, type EntityRef } from "@renderer/lib/entity-kinds.js";

/**
 * The base every stored entity carries: identity and the wire-verbatim fields every view reads.
 * Bodies are added per kind by the features that render them.
 */
export interface StoredEntity {
  readonly kind: EntityKind;
  readonly id: string;
  /** Wire-verbatim state string, rendered as received and never re-parsed. */
  readonly state?: string;
  /** ISO-8601 timestamp of the newest event that touched this entity. */
  readonly touchedAt?: string;
  /**
   * Who this entity is attributed to, when the wire names anyone. It carries
   * `ProjectedSessionEvent.actorId` unchanged, so it is a user id, an agent id or nobody; naming
   * a kind here would be a guess the decode boundary refuses to make.
   */
  readonly attributedTo?: string;
  /** Kind-specific body, owned by the feature that registered the projector. */
  readonly body?: Readonly<Record<string, unknown>>;
}

/** Upsert one entity. The projector's normal output. */
export interface EntityUpsert {
  readonly operation: "upsert";
  readonly entity: StoredEntity;
}

/**
 * Remove one entity. Rare: the daemon's log is append-only, so a removal is a lifecycle fact
 * (a worktree torn down, a browser page closed), never a renderer-side garbage collection.
 */
export interface EntityRemoval {
  readonly operation: "remove";
  readonly ref: EntityRef;
}

/** A single change the apply chokepoint will merge. */
export type EntityMutation = EntityUpsert | EntityRemoval;

/**
 * An event as the console consumes it. A renderer-local projection contract, not a wire type:
 * bridge payloads are `unknown` until the bridge adapter narrows them into this shape at the
 * boundary, so exactly one module knows the wire.
 */
export interface ProjectedSessionEvent {
  /**
   * The canonical event's own opaque identifier, wire-verbatim (`EventEnvelope.id`). It is kept
   * because the hydrated-event read is keyed `{sessionId, eventId}`, and a composed
   * `session:sequence` string resolves for no caller.
   */
  readonly id: string;
  /** The session the event belongs to, wire-verbatim. */
  readonly sessionId: string;
  /** Monotonic position within the session. Dedupe and gap detection key on it. */
  readonly sequence: number;
  /**
   * The position the session's log holds the event at, wire-verbatim and opaque, so a link that
   * names a message by its cursor can find its row. The stream delivers it with each change, and
   * a backward `transcript.read` page with each row.
   */
  readonly cursor: string;
  /** Wire-verbatim event type, e.g. `run.queued`. Rendered as received. */
  readonly kind: string;
  /** ISO-8601, wire-verbatim. Formatted at render time, never re-parsed into a store. */
  readonly occurredAt: string;
  /**
   * Who the event is attributed to, wire-verbatim, when the wire names anyone
   * (`EventEnvelope.actor`). The contract registers a user id, an agent id or `null` for a
   * system event, with no discriminator between the first two, so this holds whichever id the
   * daemon named and the console never guesses its kind.
   *
   * Absent is the one no-value state: the decode boundary
   * (`services/daemon/session-event-payload.ts`) folds present-`null` and omitted into it.
   */
  readonly actorId?: string;
  /** The event's own payload, narrowed by the projector that claims its kind. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * Turns one event into entity mutations. Registered per event kind, so a feature owns the
 * projection of the events it renders.
 *
 * A projector is pure: it reads the event and nothing else (not the store, clock or bridge),
 * which makes rebuilding from a log deterministic and lets gap healing re-run a prefix safely.
 */
export type EntityProjector = (event: ProjectedSessionEvent) => readonly EntityMutation[];

/** The projector registry: event kind to the projector that claims it. */
export type EntityProjectorTable = Readonly<Record<string, EntityProjector>>;

/** An empty partition set, one map per kind. */
export function emptyPartitions(): Record<EntityKind, Readonly<Record<string, StoredEntity>>> {
  const partitions = {} as Record<EntityKind, Readonly<Record<string, StoredEntity>>>;
  for (const kind of ENTITY_KINDS) {
    partitions[kind] = {};
  }
  return partitions;
}
