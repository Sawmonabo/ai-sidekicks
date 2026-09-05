// The store door.
//
// The two stores (`SessionStore` for wire-projected entities, `FrameStore` for the
// shell's own state), their React hooks, the entity vocabulary they project into,
// and the two schedulers that decide WHEN a store notifies.
//
// WHY THE HOOKS SHIP THROUGH THE SAME DOOR AS THE STORES. A surface that reads a
// store through `useSyncExternalStore` itself would be a second subscription path
// with its own equality rule, and the whole point of `hooks.ts` is that there is
// exactly one — `Spec-023 §Console Design (Meridian)` §The eight rules, rule 6:
// a store is read through its selector and never by reaching into its state.
// Exporting the stores without the hooks would quietly invite the second path.
//
// `readable.ts` narrows a `zustand` store to the two methods a consumer needs, so
// nothing outside this family holds a handle that can also WRITE.

// The kind vocabulary leaves the family beside the reference it keys, because the
// seat that decides which entity kinds a pane is a view of has to decide it for
// EVERY kind — a list of the admitted ones grows a hole the day a kind is added,
// which is how repo and invite went missing from the inspector's scope. The
// enumeration ships beside the union for the same reason the deck needs both: the
// inspector keys one record body per kind and its table is total over this set by
// type, so a new kind fails to compile at the table rather than reaching a deck
// that renders it blank, and a claim about a CLOSED SET has to be countable at
// runtime for a test to hold it — a second union declared here instead would be the
// mirrored closed set `apps/desktop/AGENTS.md` rejects.
//
// `ConsoleEntity` joins its ref on the door with `useSessionPartition` below: a
// partition is a map OF entities, so a consumer that can subscribe to one and
// cannot name what it holds would have to restate the shape to read it.
export { CONSOLE_ENTITY_KINDS } from "./entities.js";
export type {
  ConsoleEntity,
  ConsoleEntityKind,
  ConsoleEntityRef,
  ConsoleSessionEvent,
} from "./entities.js";
// The projection contract leaves the family with its first producer: the
// composition root's run-lifecycle projector. A projector reads WIRE member names
// and this family deliberately knows none, so the type travels out and the
// implementation stays where the wire is already understood.
export type { EntityMutation, EntityProjector, EntityProjectorRegistry } from "./entities.js";
// The registry that decides WHICH projector claims a kind, beside the table type it
// hands out. It ships through this door because the composition root registers into
// it and the session-store plumbing reads a snapshot out of it, and both of those
// live one family up — a deep import would be the second path this door exists to
// keep from opening.
export {
  ConsoleEntityProjectorRegistry,
  consoleEntityProjectorRegistry,
} from "./entity-projector-registry.js";

export { SessionStore, type SessionStoreState } from "./session-store.js";
// The base state a read establishes. Exported because the composition root now
// builds one — the adapter over the growth port's session read lives there, which
// is where a family that may reach the bridge is allowed to be.
export type { SessionSnapshot } from "./session-store.js";

export type { FrameBanner } from "./frame-store.js";
export { FrameStore } from "./frame-store.js";

// `SessionSnapshotRead` now leaves the family, because the producer it was held
// back for exists: the composition root builds a reader over the growth port's
// session read, and says so at the call site with a type rather than by convention.
export { SessionStoreRegistry } from "./session-store-registry.js";
// Straight from the module that DECLARES it rather than through the registry that
// consumes it: a barrel re-exporting a re-export is the chain this family's one
// door exists to avoid.
//
// `SessionSnapshotReader` stays inside the family: what a caller above needs to
// SAY is what the registry takes, and the reader is one arm of that union rather
// than a type anything outside names.
export type { SessionSnapshotRead } from "./open-session-entry.js";

// The refresh chokepoint, on the family door because the rule it realises binds
// every family above this one: `Spec-023 §Console Design (Meridian)` §The eight
// rules puts every read behind one scheduler, and a view family that could not
// reach it through this barrel would have to arm a timer of its own — which is
// exactly what the rule forbids. `ApplyQueue` stays off the door: its only caller
// is `SessionStoreRegistry`, and a second one would be a second writer into the
// apply chokepoint.
export { RefreshScheduler, type RefreshReason } from "./scheduling.js";

// `useSessionPartition` joins the door with its cross-family consumers: the
// composer reads the `agent`, `run`, and `channel` partitions to resolve what a
// send is addressed to, and the frame's agent step reads a session's agents. It is
// the partitioned subscription rule 6 asks for — a surface that reached for
// `useSessionStore` with a selector of its own would be the second subscription
// path this module exists to prevent.
// `useSessionStore` ships beside them for the reason stated above: it is the ONE
// selector-shaped read of a session store, and a surface that could not reach it
// through this door would reach for `useSyncExternalStore` and become the second
// subscription path with its own equality rule. `SessionStoreState` travels with
// it because a caller hoisting a selector to module scope has to name the state
// it selects from.
//
// `useSessionInitialised` and `useSessionDegradedCause` are the two absences a
// partition read cannot express: a map with no rows means one thing before the
// read has answered, another when the daemon has said the projection is
// incomplete, and a third when the session simply has none of that kind. A
// surface that could reach only the partition would have to render all three as
// "empty", which is the collapse rule 8 forbids.
//
// `useOpenSessionIds` ships with them because the sessions surface and the
// context picker each have to name which sessions are open before either can
// read one, and the registry is the only thing that knows.
export {
  useCallerMembershipRole,
  useFrameStore,
  useLocationHash,
  useOpenSessionIds,
  useOpenSessionStore,
  useSessionDegradedCause,
  useSessionInitialised,
  useSessionPartition,
  useSessionStore,
} from "./hooks.js";
// The caller-role chain leaves the family with its first consumer: the approvals
// pane, which gates the goal controls on it. The reader type travels with it
// because the read itself lives on the growth port in `bridge/` — a family this one
// may not reach up to — so the composition site above adapts that outcome into this
// shape, and it has to be able to NAME the shape to do so. The result type travels
// for the same reason: a caller mapping three arms onto what a control may offer
// writes that mapping over the union rather than over a boolean it inferred.
export type { CallerMembershipRoleResult, CallerParticipantReader } from "./hooks.js";

// The wall-clock wake-up. In this family rather than in `primitives/` because it is
// a scheduling decision — the console's other one, `scheduling.ts`, is its neighbour
// — and because what it publishes is state a surface renders against rather than
// anything it draws. It arms the only timer in the console outside those two
// schedulers and the live announcer's hold.
export {
  /** @consumedBy T-023p-1C-4, T-023p-1C-5 */
  earliestFutureDeadline,
  useDeadlineWake,
} from "./deadline-wake.js";

// THE TWO SUBJECT PRIMITIVES, and why they ship through this door rather than being
// re-implemented per family. State that outlives its subject was the recurring defect
// class across every console family: a pane rebound from one session to another kept
// the previous one's editor text, busy flag, roster, or outcome for a frame, and a
// call still in flight against the previous subject settled into the new one. Five
// families each wrote their own holder and their own generation counter, and the
// place copies of a guard drift is the predicate.
//
// `subject-scoped-holder.ts` holds the rule and `subject-scoped-state.ts` is its
// React half, which together answer what a surface RENDERS for the subject it is
// bound to; `generation-latch.ts` answers whether an act may be dispatched at all,
// which a handler settles inside its own tick. `test/console/architecture/
// subject-state-chokepoint.test.ts` fails the build on a second implementation of
// either.
//
// The `@consumedBy` tags are the dead-code gate's one exemption, on this package's
// terms: they name the task that imports the symbol, and they are deleted in the PR
// that does. See `apps/desktop/AGENTS.md` §Mechanical gates.
export {
  /** @consumedBy T-023p-1C-8 */
  SubjectScopedHolder,
} from "./subject-scoped-holder.js";
export { useSubjectScopedState } from "./subject-scoped-state.js";
// The disposal half, from the module that DECLARES it. A value a drop releases takes
// the holder above; a value that owns a subscription or a connection takes this,
// because the render that seeded it may be one React throws away.
export { useSubjectScopedResource } from "./subject-scoped-resource.js";
export type {
  /** @consumedBy T-023p-1C-8 */
  SubjectKey,
  /** @consumedBy T-023p-1C-8 */
  SubjectScopedPublish,
} from "./subject-scoped-holder.js";
export type { SubjectScopedState } from "./subject-scoped-state.js";
export {
  /** @consumedBy T-023p-1C-8 */
  GenerationLatch,
  useGenerationLatch,
} from "./generation-latch.js";
export type {
  /** @consumedBy T-023p-1C-8 */
  CurrentGenerationClaim,
  /** @consumedBy T-023p-1C-8 */
  GenerationClaim,
} from "./generation-latch.js";
