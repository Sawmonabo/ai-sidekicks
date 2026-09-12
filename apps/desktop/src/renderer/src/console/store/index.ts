// The store door.
//
// The two stores (`SessionStore` for wire-projected entities, `FrameStore` for the
// shell's own state), their React hooks, the entity vocabulary they project into,
// and the two schedulers that decide WHEN a store notifies.
//
// WHY THE HOOKS SHIP THROUGH THE SAME DOOR AS THE STORES. A surface that reads a store
// through `useSyncExternalStore` itself would be a second subscription path with its own
// equality rule, and the whole point of `session/session-hooks.ts` and
// `shell/frame-hooks.ts` is that there is exactly one: a store is read through its
// selector and never by reaching into its state. Exporting the stores without the hooks
// would quietly invite the second path.
//
// `readable.ts` narrows a `zustand` store to the two methods a consumer needs, so
// nothing outside this family holds a handle that can also WRITE.
//
// IT IS LONG AND IS NOT SPLIT, deliberately: the one relocation available — a
// `shell/index.ts` this door re-exported through — `apps/desktop/AGENTS.md` forbids, a
// family door re-exporting from the module that DECLARES a symbol and never through an
// inner barrel. So the remedy is fewer published names, never the same names elsewhere.

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
export { CONSOLE_ENTITY_KINDS } from "./entities/entities.js";
// `ConsoleEntity` leaves the family because the two validating body reads live in
// `bridge/daemon/entity-body-reads.ts`: a read that narrows a wire member has to sit where
// the registered shapes may be imported, and it still takes and returns this
// family's own entity. It joins the reference and the event on the line below for two
// more readers: the inspector's entity-detail registry is keyed by the KIND it
// renders, and a family that reads a PARTITION of the projection — rather than one
// entity by reference — has to name the row type to derive anything from it, as the
// membership ledger and the agent console's session projection both do.
export type {
  ConsoleEntity,
  ConsoleEntityKind,
  ConsoleEntityRef,
  ConsoleSessionEvent,
} from "./entities/entities.js";
// The projection contract leaves the family with its first producer: the
// composition root's run-lifecycle projector. A projector reads WIRE member names
// and this family deliberately knows none, so the type travels out and the
// implementation stays where the wire is already understood.
export type {
  EntityMutation,
  EntityProjector,
  EntityProjectorRegistry,
} from "./entities/entities.js";
// The registry that decides WHICH projector claims a kind, beside the table type it
// hands out. It ships through this door because the composition root registers into
// it and the session-store plumbing reads a snapshot out of it, and both of those
// live one family up — a deep import would be the second path this door exists to
// keep from opening.
export {
  ConsoleEntityProjectorRegistry,
  consoleEntityProjectorRegistry,
} from "./entities/entity-projector-registry.js";

export { SessionStore, type SessionStoreState } from "./session/session-store.js";
// What the session still has open, from the module that HOLDS it rather than from the
// store that publishes one reading of it. It leaves the family because the cast bar
// renders the strip's all-clear line, and that line is a claim about lifecycles rather
// than about rows: the journal is kept apart from the window precisely so a pruned or
// re-read timeline cannot silently clear an approval, and a surface reading the window
// instead would put the defect straight back. The journal CLASS stays inside — one
// writer per store, constructed by the store itself — so what leaves is the reading.
// The two record types stay inside for the barrel census's rule: the fold above reads
// them by iterating the ledger's own maps and names neither, so a door line for either
// would be a re-export with no reader.
export type { OutstandingAskLedger } from "./session/outstanding-asks/outstanding-ask-journal.js";
// The base state a read establishes. Exported because the composition root now
// builds one — the adapter over the growth port's session read lives there, which
// is where a family that may reach the bridge is allowed to be.
export type { SessionSnapshot } from "./session/session-store.js";

export type { FrameBanner } from "./shell/frame-store.js";
export { FrameStore } from "./shell/frame-store.js";
// The handover a pane performs when its refusal stops being its own business: a
// whole-workspace code reaches the frame's banner rather than a line inside one pane.
// The selector beside it is for the surfaces whose refusals arrive as a collection —
// one per resolved request, one per control settlement, one per concurrent read — so
// no surface writes its own reading of which member rule 9 puts across the frame. Its
// order means PREFERENCE: nothing in this console stamps a refusal with a time, so a
// position in a collection is never a claim about which one the daemon said last.
export {
  preferredBannerClassRefusalAmong,
  useRefusalBannerEscalation,
} from "./shell/refusal-escalation.js";

// The window-scoped modal's half of the shell's `inert` guard. Through this door
// rather than either overlay's, because its callers are sibling VIEW families —
// `sign-in/`, `onboarding/`, and the deep-link invite lifecycle in `collaboration/` —
// which reach each other through nothing, and because the cell it writes lives in this
// family's own store. Written twice before it was hoisted, and the second copy was
// missing: a walkthrough that trapped focus and left the whole route surface reachable
// behind it.
export { useModalSurfaceLifetime } from "./shell/modal-surface-lifetime.js";

// The shell's own condition, and the two derivations every reader of it shares.
//
// Through this door rather than the frame's, because the readers span the DAG in
// both directions: the palette sits BELOW `frame/` and every view family sits above
// it, and `frame/index.ts` is a door no view family may import at all — so a
// vocabulary published there would be one neither could reach. This family owns the
// store the value lives in, which makes it the lowest family that can own the words.
export {
  SHELL_DETAIL_DESTINATION,
  UNREPORTED_SHELL_NOTICE,
  UNREPORTED_SHELL_STATE,
  describeShellConnection,
  shellReportsAreEqual,
} from "./shell/shell-state.js";
export type {
  ShellConnection,
  ShellKeystoreState,
  ShellNegotiation,
  ShellReport,
  ShellState,
  ShellTransport,
} from "./shell/shell-state.js";
// What that condition COSTS, from the module that derives it. Beside the vocabulary
// rather than inside it: a block is derived from a state and a method name, and the
// two halves have different readers — see `store/shell/shell-mutation-block.ts`'s own header.
//
// `currentShellBlock` ships beside `useShellBlockFor` because a dispatching surface
// needs both and they answer different questions: the subscribed block draws the control,
// and the current one decides whether the call is put. Six surfaces take it — the
// membership ledger, the sent-invite ledger, the invitation mint, the sessions
// destination's act block, the onboarding step's re-check, and the ledger's answer to a
// provider-raised ask — and a family that could not reach it through this door would spell
// `getState().shellState` for itself, which is the second reading of which cell carries
// the shell condition.
//
// `shellBlockForMethod` is deliberately HELD OFF this door: a raw derivation published
// here is one a render body can call without memoising it, and the hook below is the
// reading every surface takes instead.
export {
  MUTATING_DAEMON_METHODS,
  // Both taken by the bidirectional pairing suite in `bridge/daemon/`, which holds this
  // roster equal to the registry's own record set in each direction.
  isMutatingDaemonMethod,
  // The same question asked where the call is PUT rather than where the control was
  // drawn: a block landing between the render and the press leaves a captured one
  // fail-open. `currentShellMutationBlock` applies no method rule, for the one caller
  // that has already classified from the registry's own `kind` column — the call door.
  currentShellBlock,
  currentShellMutationBlock,
  shellBlocksAreEqual,
  shellMutationBlock,
} from "./shell/shell-mutation-block.js";
// The refusal a block becomes. It leaves the family because the producer of a blocked
// dispatch is a VIEW family and siblings cannot reach each other: the ledger's ask
// answer settles one. The origin string itself stays inside.
export { shellBlockRefusal } from "./shell/shell-mutation-block.js";
export type { MutatingDaemonMethod, ShellMutationBlock } from "./shell/shell-mutation-block.js";
// `useShellBlockFor` is the subscribed per-method reading every dispatching surface
// draws its disabled state and its reason from — one hook rather than the same three
// lines per family, each of them free to re-render a control on every heartbeat.
export { useRailAttentionCount, useShellBlockFor, useShellState } from "./shell/frame-hooks.js";
// Every open session's projection as one signal, and the one fold the frame takes
// over it. Published because the two callers sit on opposite sides of the console
// DAG — a view family and `frame/` — so the mechanism can only be shared from here.
export {
  subscribeToOpenSessions,
  useWorstOpenSessionRecovery,
} from "./session/open-session-signal.js";

// `SessionSnapshotRead` now leaves the family, because the producer it was held
// back for exists: the composition root builds a reader over the growth port's
// session read, and says so at the call site with a type rather than by convention.
export { SessionStoreRegistry } from "./session/session-store-registry.js";
// Straight from the module that DECLARES it rather than through the registry that
// consumes it: a barrel re-exporting a re-export is the chain this family's one
// door exists to avoid.
//
// `SessionSnapshotReader` stays inside the family: what a caller above needs to
// SAY is what the registry takes, and the reader is one arm of that union rather
// than a type anything outside names.
export type { SessionSnapshotRead } from "./session/open-session-entry.js";

// The refresh chokepoint, through the same door as the stores it feeds. A view
// family that refreshes a wire read reaches this scheduler and no other timer:
// `apps/desktop/AGENTS.md` puts every refresh through `store/read/refresh-scheduler.ts`,
// and a
// chokepoint reachable only by deep-importing past this barrel is one a family
// would route around rather than through. `ApplyQueue` stays off the door: its only
// caller is `SessionStoreRegistry`, and a second one would be a second writer into
// the apply chokepoint.
//
// Open for the surfaces that perform their OWN reads as well as for the stores.
// `SessionStoreRegistry` owns one scheduler per open session for the session
// snapshot; a family reading a wire the snapshot does not carry — the repos
// section's `repo.mountRead`, for one — still owes rule "no interval polling", and
// this is the only implementation of it, so it is reachable through the door rather
// than deep-imported around.
export { RefreshScheduler, type RefreshReason } from "./read/refresh-scheduler.js";

// The COMPOSED shape of that scheduler, beside the primitive it composes. A scheduled
// read published to subscribers was written out sixteen times across eight view
// families and `bridge/` — the same emitter, the same latch, the same
// `snapshot`/`subscribe`/`start`/`requestRead`/`dispose` skeleton, and a publisher that
// was character-for-character identical in three unrelated families. It leaves this
// family because every one of those readings sits above it and they reach each other
// through nothing, so this door is the only place the base can be shared from.
//
// THE OPTIONS TYPE IS DELIBERATELY ABSENT. A subclass hands `super` an object literal
// and never names the shape, so a door line for it would publish a name nothing
// outside this family types — which the barrel census fails, and which is the rule
// that a door is never widened for symmetry.
export { ScheduledReading } from "./read/scheduled-reading.js";

// The read line every scheduled read is on, and the four names a caller outside this
// family needs from it: the hook that binds one to a `(subject, key)` pairing, the
// combinator the bridge's call door races a pending read against, the reading a
// COMPOSED read takes at each boundary between its own calls, and the scope itself.
//
// `ReadScope` IS PUBLISHED, and the sentence that withheld it named a risk
// construction does not create. A caller cannot construct somebody else's line — what
// it constructs it owns — and the line a HOLDER owns is the case neither of the other
// two names serves: `useReadScope` binds a scope to a render, which is wrong for a
// class whose lifetime is its own key rather than any one component's mount, and the
// scheduler's scope is private on purpose. The composer's provider-command
// enumeration is that holder: two zones observe it, one drives it, and the read line
// belongs to the address it was opened at.
export {
  isReadAbandoned,
  ReadScope,
  settleUnlessAbandoned,
  useReadScope,
} from "./read/read-cancellation.js";
export type { ReadRound } from "./read/read-cancellation.js";

// The signal half of a push-driven read, beside the scheduler that coalesces it.
// It leaves the family because its callers are view families, which are siblings
// and cannot reach each other — so the second caller's only alternative to this
// door was the second copy of the filter that this export replaces.
export { subscribeToSessionEventKinds } from "./session/session-event-signal.js";

// The wiring that feeds that chokepoint, on the door for the same reason: the four
// moments a reading goes stale are one rule, and a family that could not reach this
// hook would wire whichever subset its author remembered — which is exactly how the
// queue and quota readings came to have none. `ReadTriggerTarget` travels with it
// because every reading above this family implements it.
export {
  NO_TRIGGERING_EVENT_KINDS,
  useReadTriggers,
  useSessionReadTriggers,
  useWindowReadTriggers,
  type ReadTriggerTarget,
} from "./read/read-triggers.js";

// The three reasons a self-reading surface re-reads, wired imperatively over the
// `ReadTriggerTarget` above. Here rather than in a view family because the
// observations — window focus, the store's repair edge, and a named frame — are the
// same three whichever surface reads; only the kinds differ, and the reading declares
// those. It ships beside the hook wiring and not instead of it: a reading minted per
// subject inside a resource seam cannot call a hook, so the two wirings differ and the
// two members they read do not.
export { SessionRefreshTriggers } from "./read/refresh-triggers.js";

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
// it selects from — and until the browser-terminal family landed every caller of that
// second act lived
// inside this family, so the one path now serves a view family too.
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
export { useFrameStore } from "./shell/frame-hooks.js";
export { useLocationHash } from "./shell/location-hash.js";
export {
  useOpenSessionIds,
  useOpenSessionStore,
  useSessionPartition,
  useSessionStore,
} from "./session/session-hooks.js";
// The readings ABOUT a projection, from the module that holds them. Declared in a
// second line rather than folded into the one above because they come from a second
// module — a door re-exports a symbol from the module that DECLARES it, never through
// a sibling that happens to re-export it.
export {
  useSessionDegraded,
  useSessionDegradedCause,
  useSessionInitialised,
  useSessionProjectionRevision,
} from "./session/session-projection-hooks.js";

// The peer-invocation grant, read off the session partition. Through this door
// because its two readers are VIEW families and siblings cannot reach each other:
// the agent console draws the control the grant belongs to, and the ledger's empty
// window says why a session with the grant off holds no handoff rows. The fold is
// one implementation for both — a second copy that answered `false` for an absent
// member would present an enabled session as safe.
// `peerInvocationEnabledIn` itself stays off this door: the hook is what both
// surfaces read, the fold is the hook's own, and a door line whose only importer is
// a test is a re-export with no production reader.
export {
  NOTHING_PROJECTED,
  usePeerInvocationProjection,
} from "./session/peer-invocation-projection.js";
export type { PeerInvocationProjection } from "./session/peer-invocation-projection.js";

// The wall-clock wake-up. In this family rather than in `primitives/` because it is
// a scheduling decision — the console's other two, `read/refresh-scheduler.ts` and
// `read/apply-queue.ts`, are its neighbours one directory over — and because what it
// publishes is state a surface renders against rather than
// anything it draws. It arms the only timer in the console outside those two
// schedulers and the live announcer's hold.
export { earliestFutureDeadline, useDeadlineWake } from "./subject-scoped/deadline-wake.js";

// THE TWO SUBJECT PRIMITIVES, and why they ship through this door rather than being
// re-implemented per family. State that outlives its subject was the recurring defect
// class across every console family: a pane rebound from one session to another kept
// the previous one's editor text, busy flag, roster, or outcome for a frame, and a
// call still in flight against the previous subject settled into the new one. Five
// families each wrote their own holder and their own generation counter, and the
// place copies of a guard drift is the predicate.
//
// `store/subject-scoped/subject-scoped-holder.ts` holds the rule and `store/subject-scoped/subject-scoped-state.ts` is its
// React half, which together answer what a surface RENDERS for the subject it is
// bound to; `store/read/generation-latch.ts` answers whether an act may be dispatched at all,
// which a handler settles inside its own tick. A second implementation of either is a
// review rejection, which is why reaching them is a door line and not a deep import.
//
// The `@consumedBy` tags are the dead-code gate's one exemption, on this package's
// terms: they name the task that imports the symbol, and they are deleted in the PR
// that does. The package's mechanical-gate rules say so.
export {
  /** @consumedBy a view family that has not landed yet */
  SubjectScopedHolder,
} from "./subject-scoped/subject-scoped-holder.js";
export { useSubjectScopedState } from "./subject-scoped/subject-scoped-state.js";
// The seed rule the two families above pass as the holder's `initial`. It ships from
// this door rather than from either of them because both read it: the `workflows/`
// view family for the definitions and runs directories, and the run pane for one run's
// snapshot. What a read STARTS as is one rule, and three surfaces disagreed about it in
// three different ways before it was written down once.
export { subjectReadStart } from "./read/subject-read-start.js";
export type { SubjectRead } from "./read/subject-read-start.js";
// The disposal half, from the module that DECLARES it. A value a drop releases takes
// the holder above; a value that owns a subscription or a connection takes this,
// because the render that seeded it may be one React throws away.
export { useSubjectScopedResource } from "./subject-scoped/subject-scoped-resource.js";
// The disposal SHAPE travels with the hook, because it is how a caller says which
// kind of ending its resource has and the hook refuses to guess.
// The union alone — the two arms are reached by writing one of them, never by naming
// it, so a door line for each would be a name nothing outside this family ever types.
export type { SubjectScopedDisposal } from "./subject-scoped/subject-scoped-resource.js";
export type { SubjectKey, SubjectScopedPublish } from "./subject-scoped/subject-scoped-holder.js";
export type { SubjectScopedState } from "./subject-scoped/subject-scoped-state.js";
// THE ACT PRIMITIVE, beside the two subject primitives and the latch it composes.
// An act with a prerequisite read behind it — a roster before a node is named, the
// modes a mount admits, whether a branch already has a checkout — was written three
// times in one directory before this existed: three schedulers, three trigger
// wirings, three emitters, three four-arm vocabularies, three overlap guards, and
// three copies of the hook and its disposal constant. It ships through this door for
// `RefreshScheduler`'s reason: a chokepoint reachable only by deep-importing past
// this barrel is one a family would route around rather than through.
//
// WHAT LEAVES IS THE BASE CLASS AND NOT THE MACHINE, because the pass-through was the
// last thing still being copied: `store/act/act-controller-base.ts` holds the `ActController`
// and every family extends that. `ActController` itself therefore has no reader
// outside this family, and a door line for it would be a name nothing outside
// `store/` ever types — which the barrel census fails. It rejoins this door the day a
// surface holds one directly.
export { ActSurfaceController } from "./act/act-controller-base.js";
// The three reading shapes travel with it because a controller composing one has to
// NAME what it publishes: its own settled arm is its own, and the three arms around
// that arm are this module's.
export type {
  ActOutcome,
  ActPrerequisiteReading,
  ActReading,
  ActSettlementReading,
} from "./act/act-reading.js";
// The React half, from the module that declares it. It binds any controller offering
// the four lifecycle members, which is why the repos family's three — each extending
// the base rather than being an `ActController` — bind through it unchanged.
export { useActController } from "./act/use-act-controller.js";
// The disposal beside the hook, because it is not the hook's alone: a controller that
// publishes into a host rather than off a snapshot binds through
// `useSubjectScopedResource` directly and ends exactly the same way.
export { CONTROLLER_DISPOSAL } from "./act/use-act-controller.js";
// The store axis, for the same reason the disposal leaves: a reading that binds
// through `useSubjectScopedResource` directly rather than through the hook above still
// arms its triggers on a session store, and the rebind rule is the same one. The type
// travels with it so such a reading can DECLARE the member rather than growing it by
// coincidence.
export { useSessionStoreRebind } from "./session/session-store-rebind.js";
export type { SessionStoreScoped } from "./session/session-store-rebind.js";

export { GenerationLatch, useGenerationLatch } from "./read/generation-latch.js";
export type { CurrentGenerationClaim, GenerationClaim } from "./read/generation-latch.js";
// The resume reading. Its consumer is the ledger surface that mounts a session's
// workspace: the refused arm says the position this session was last read up to could
// not be resolved and the log was re-read from the beginning of its window, which is a
// real degradation of what the console remembered and reaches nobody unless a surface
// renders it. Through this door rather than a deep import, on the family's
// one-subscription-path rule.
//
// The DECISION TYPE is deliberately not published beside it: the hook's return type
// is inferred at every call site, so a door line for the name would be a line with no
// reader — which is the dead export the census fails, and the type is reached deep
// inside this family by the registry that forwards it.
export { useTimelineResume } from "./session/session-projection-hooks.js";
// The degradation cause itself, beside the hook that answers it. Without this line
// a consumer could reach the closed set only by reflecting on the hook's return
// type — which derives the set from a CONSUMER of it, so widening the hook's
// annotation widens the consumer's exhaustiveness silently and narrowing it to a
// wrapper collapses that exhaustiveness outright.
export type { SessionDegradedCause } from "./session/session-store.js";
// The ladder itself, through the module that owns it. Published because the fold is
// now performed over a SET of stores rather than inside one: the all-sessions
// destination reports one degradation for the whole window, and picking the worst
// standing cause is exactly the rule this function holds. A caller reducing the set
// itself would be the "simpler" second assignment that module's own header warns
// about — the one that silently downgrades a store that could not follow the stream
// at all into one that merely failed a read.
export { worstDegradedCause } from "./degradation.js";
