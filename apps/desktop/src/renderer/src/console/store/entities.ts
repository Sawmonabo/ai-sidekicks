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
  // `Spec-023 §Console Design (Meridian)` §The surface set routes five entity kinds
  // to the `inspector` pane — repo, workspace, worktree, invite, member — and these
  // are the two the console could not NAME. `seats/pane-address.ts` derives the
  // inspector's scope from this vocabulary, so their absence made a repo card and an
  // invite card unrepresentable at the address layer and made the runtime scope table
  // reject them as kind mismatches, which would have forced the repos and
  // collaboration branches to reopen this shared substrate to open a pane the spec
  // already routes.
  //
  // NO PROJECTOR IS OWED BY THIS ENTRY. A kind here is a valid REFERENCE kind and a
  // partition that exists; it is not a promise that some family projects rows into
  // it. An inspector card for a repo or an invite reads the row from its own family's
  // reader — the growth port's repo and invite operations — exactly as it would if it
  // had a partition full of rows, and the empty partition costs one `Map` per session.
  // The alternative was a second kind vocabulary for references that the store does
  // not fill, which is two closed sets for one idea.
  "repo",
  "invite",
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
  /**
   * Who this entity is attributed to, when the wire names anyone.
   *
   * The projector carries `ConsoleSessionEvent.actorId` here unchanged, so it holds the
   * same three-state fact that member does — a participant id, an agent id, or nobody
   * — and a renderer that read it as a participant's would mislabel every agent-driven
   * run. Naming a KIND here would be the guess the decode boundary refuses to make.
   */
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
  /**
   * The canonical event's own opaque identifier, wire-verbatim.
   *
   * `EventEnvelope.id` in `packages/contracts/src/event.ts` — the first of the
   * canonical eleven, and the only member that names THIS event rather than its
   * position. It is carried rather than dropped because the console has a reader
   * for it: the hydrated-event read is keyed `{sessionId, eventId}`, so a ledger
   * row that wants the machine-authored body of the turn it is rendering has
   * nothing to ask with unless the projection kept this. A composed
   * `session:sequence` string names the same row to a human and resolves for no
   * caller, which is why the member is here instead.
   */
  readonly id: string;
  /** The session the event belongs to, wire-verbatim. */
  readonly sessionId: string;
  /** Monotonic position within the session. Dedupe and gap detection key on it. */
  readonly sequence: number;
  /** Wire-verbatim event type, e.g. `run.queued`. Rendered as received. */
  readonly kind: string;
  /** ISO-8601, wire-verbatim. Formatted at render time, never re-parsed into a store. */
  readonly occurredAt: string;
  /**
   * Who the event is attributed to, wire-verbatim, when the wire names anyone.
   *
   * `EventEnvelope.actor`, carried under this name rather than a narrower one. The
   * contract registers that member as a participant id, an AGENT id, or `null` for a
   * system-emitted event, and supplies no discriminator to tell the first two apart —
   * so this member holds whichever id the daemon named and the console never guesses
   * which kind it has. The member used to be called `actorParticipantId`, which named
   * one of the three states and quietly mis-described the other two: every agent-
   * emitted event in the store was being read as a participant's.
   *
   * Absent for the system arm, and absent is the ONE no-value state: the wire has two,
   * present-`null` and omitted, and the decode boundary folds both into this one
   * (`frame/session-event-payload.ts`). Nothing downstream has to tell them apart,
   * because no daemon distinguishes them either.
   */
  readonly actorId?: string;
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
