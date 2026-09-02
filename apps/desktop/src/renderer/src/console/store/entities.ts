// The console's entity vocabulary and the shape of a store mutation.
//
// `Spec-023 §Console Design (Meridian)` §The four bars ("Light on the machine")
// and the design's store discipline give three rules this module encodes:
//
//   • **Entity-keyed, partitioned.** State is a map per entity KIND, not one flat
//     map, so a mutation replaces one partition's identity and a row selector for
//     an untouched kind bails on `Object.is` without walking anything. Measured on
//     the design's own bench: a flat map costs about 1.3 ms per event at 20,000
//     entities and a partitioned one about 57 µs.
//   • **A store never caches a flag another store owns.** Each partition names
//     what it OWNS; a projection that needs two kinds composes them at read time
//     rather than denormalising one into the other, because a denormalised copy is
//     a second source of truth that the reconnect path cannot heal.
//   • **Projections never persist.** Nothing here is durable. `persistence/` holds
//     UI state only, and every entity in this module is re-derived from the
//     daemon on reconnect (`Spec-023 §Pitfalls To Avoid`).

/**
 * The entity kinds the console partitions by, in a stable order for tests and for
 * the gallery. Closed, and deliberately NOT the pane-kind set: a pane is a view of
 * an entity, and several pane kinds render the same kind of entity.
 *
 * Declared exactly once. The union below is derived from this array rather than
 * written beside it, because two hand-maintained copies of a closed set drift in
 * the direction nothing catches — a union member missing from the array leaves
 * `emptyPartitions` returning an object with a hole in it, and every read of that
 * partition is `undefined` at a type that says it cannot be.
 */
export const CONSOLE_ENTITY_KINDS = [
  "session",
  "participant",
  "channel",
  "run",
  "agent",
  "workspace",
  "worktree",
  "artifact",
  "approval",
  // Two workflow kinds, not one. A definition is authored, versioned, and scoped and
  // outlives every run of it; a run is one execution of one pinned version. The
  // builder addresses the first and the run pane the second, so filing both under
  // one partition would have a definition edit and a run transition invalidate each
  // other's selectors — and would give the two no way to be told apart by kind at
  // all, which is what a partitioned store keys on.
  "workflow-definition",
  "workflow-run",
  "browser-page",
] as const;

/** One entity kind. Derived from the enumeration, never restated. */
export type ConsoleEntityKind = (typeof CONSOLE_ENTITY_KINDS)[number];

/** A reference to one entity: its kind and its wire-verbatim identifier. */
export interface ConsoleEntityRef {
  readonly kind: ConsoleEntityKind;
  readonly id: string;
}

/**
 * The base every stored entity carries. Bodies are added per kind by the view
 * families; the substrate only needs identity and the wire-verbatim fields every
 * surface reads.
 */
export interface ConsoleEntity {
  readonly kind: ConsoleEntityKind;
  readonly id: string;
  /**
   * Wire-verbatim state string. Rendered as received, never re-parsed
   * (`Spec-023 §Console Design (Meridian)` §The eight rules, wire figures).
   */
  readonly state?: string;
  /** ISO-8601 timestamp of the newest event that touched this entity. */
  readonly touchedAt?: string;
  /** The participant this entity is attributed to, when the wire names one. */
  readonly attributedTo?: string;
  /** Kind-specific body, owned by the view family that registered the projector. */
  readonly body?: Readonly<Record<string, unknown>>;
}

/** Upsert one entity. The projector's normal output. */
export interface EntityUpsert {
  readonly operation: "upsert";
  readonly entity: ConsoleEntity;
}

/**
 * Remove one entity. Rare: the daemon's log is append-only, so a removal is a
 * lifecycle fact (a worktree torn down, a browser page closed), never a garbage
 * collection the renderer decided on.
 */
export interface EntityRemoval {
  readonly operation: "remove";
  readonly ref: ConsoleEntityRef;
}

/** A single change the apply chokepoint will merge. */
export type EntityMutation = EntityUpsert | EntityRemoval;

/**
 * An event as the console consumes it.
 *
 * This is a RENDERER-LOCAL projection contract, not a wire type: the bridge's
 * event payloads are `unknown` until Plan-007 lands its discriminated unions, and
 * a console that invented wire members would be the lane-4 change Phase 1C
 * forbids. The bridge adapter narrows a payload into this shape at the boundary,
 * so exactly one module knows the wire and everything above it reads this.
 */
export interface ConsoleSessionEvent {
  /** The session the event belongs to, wire-verbatim. */
  readonly sessionId: string;
  /** Monotonic position within the session. Dedupe and gap detection key on it. */
  readonly sequence: number;
  /** Wire-verbatim event type, e.g. `run.queued`. Rendered as received. */
  readonly kind: string;
  /** ISO-8601, wire-verbatim. Formatted at render time, never re-parsed into a store. */
  readonly occurredAt: string;
  /** The participant the event is attributed to, when the wire names one. */
  readonly actorParticipantId?: string;
  /** The event's own payload, narrowed by the projector that claims its kind. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * Turns one event into entity mutations. Registered per event kind at store
 * construction, so a view family owns the projection of the events it renders and
 * the substrate owns none of them.
 *
 * A projector is PURE. It may read the event and nothing else — not the store,
 * not the clock, not the bridge. That is what makes replaying a log deterministic
 * and what lets the gap-healing path re-run a prefix without side effects.
 */
export type EntityProjector = (event: ConsoleSessionEvent) => readonly EntityMutation[];

/** The projector registry: event kind to the projector that claims it. */
export type EntityProjectorRegistry = Readonly<Record<string, EntityProjector>>;

/** An empty partition set, one map per kind. */
export function emptyPartitions(): Record<
  ConsoleEntityKind,
  Readonly<Record<string, ConsoleEntity>>
> {
  const partitions = {} as Record<ConsoleEntityKind, Readonly<Record<string, ConsoleEntity>>>;
  for (const kind of CONSOLE_ENTITY_KINDS) {
    partitions[kind] = {};
  }
  return partitions;
}
