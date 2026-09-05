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
// which is how repo and invite went missing from the inspector's scope.
export { CONSOLE_ENTITY_KINDS } from "./entities.js";
// `ConsoleEntity` leaves the family because the two validating body reads live in
// `bridge/entity-body-reads.ts`: a read that narrows a wire member has to sit where
// the registered shapes may be imported, and it still takes and returns this
// family's own entity.
export type { ConsoleEntity, ConsoleEntityRef, ConsoleSessionEvent } from "./entities.js";
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

export { SessionStore } from "./session-store.js";
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

// The selector hook, and the state its selector reads.
//
// `useOpenSessionStore` hands a caller the store; reading it is a second act, and
// until T-023p-1C-7 every caller of that second act lived inside this family. A
// view family that reached for `useSyncExternalStore` itself would be the second
// subscription path this family's header exists to prevent — so the one path
// ships through the door beside the store it reads.
export type { SessionStoreState } from "./session-store.js";
export { useSessionStore } from "./hooks.js";

// The partition and initialisation reads leave the family with their first
// surface caller: the auxiliary window's agent step reads a session's agents,
// which is one entity kind's map plus the fact that the store has a base state to
// read it from. Both go through this door rather than a deep import, so the
// family's one subscription path stays the only one.
export {
  useFrameStore,
  useLocationHash,
  useOpenSessionIds,
  useOpenSessionStore,
  useSessionInitialised,
  useSessionPartition,
} from "./hooks.js";

// The wall-clock wake-up. In this family rather than in `primitives/` because it is
// a scheduling decision — the console's other one, `scheduling.ts`, is its neighbour
// — and because what it publishes is state a surface renders against rather than
// anything it draws. It arms the only timer in the console outside those two
// schedulers and the live announcer's hold.
export {
  /** @consumedBy T-023p-1C-4, T-023p-1C-5 */
  earliestFutureDeadline,
  /** @consumedBy T-023p-1C-4, T-023p-1C-5 */
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
export { GenerationLatch, useGenerationLatch } from "./generation-latch.js";
export type {
  /** @consumedBy T-023p-1C-8 */
  CurrentGenerationClaim,
  GenerationClaim,
} from "./generation-latch.js";
// The caller's own membership role, forwarded with the two types a caller has to name
// to use it. Its first surface consumer is the terminal lease line: taking the shell
// is owner/collaborator-only, so a control offered on identity alone offered viewers
// and runtime contributors a mutation that can only be refused. The reader is a
// PARAMETER because this family sits below `bridge/` and may not reach a port, so the
// view family that can passes one in.
export { useCallerMembershipRole } from "./hooks.js";
export type { CallerMembershipRoleResult, CallerParticipantReader } from "./hooks.js";
