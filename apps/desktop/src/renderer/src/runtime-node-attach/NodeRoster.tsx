// Plan-003 Phase 5 T5.1 (Tier 3) — renderer NodeRoster component.
//
// A thin bridge projection over `window.sidekicks`: it renders the SET of
// runtime nodes attached to the active session — one `RuntimeNodeRosterEntry`
// per `runtime_node_attachments` row, exactly as the registered
// `runtimenode.roster` read returns it — and visually distinguishes the three
// status facets the wire entry carries (`docs/architecture/contracts/api-payload-contracts.md §Tier 3: Plan-003 — Runtime Node Attach (Task 4.4)`;
// `packages/contracts/src/runtime-node.ts#RuntimeNodeRosterEntry`):
//   • `state: NodeState` — the SLOT axis (registering|online|degraded|offline|
//     revoked — `packages/contracts/src/runtime-node.ts#NodeState`),
//     `runtime_node_attachments.state` carried
//     verbatim with all five values: the read is a faithful projection with no
//     server-side hiding (`Spec-003 §Interfaces And Contracts` amendment).
//     AC2 distinguishability (`Spec-003 §Acceptance Criteria`): a `degraded`/
//     `offline` node renders with a degraded/offline indicator, NOT a
//     disappearance — a healthy `online` node is visually distinct from one
//     that is not.
//   • `healthState` + `lastHeartbeatAt` — the LIVENESS axis: the sweep-owned
//     3-value presence verdict (`online | degraded | offline`) carried
//     VERBATIM from `runtime_node_presence`, nullable until the node's first
//     heartbeat lands (LEFT JOIN — the `healthState` field on `RuntimeNodeRosterEntrySchema`). The read NEVER
//     derives staleness (the Plan-003 T3.6 sweep stays the single
//     liveness-derivation writer), and neither does this view.
//   • `readOnly: boolean` — the PERMISSION axis, DERIVED per row at read time:
//     true iff the node's stored `client_version` is below the session's
//     `min_client_version` floor (the `readOnly` field on `RuntimeNodeRosterEntrySchema`; the server
//     derivation lives in
//     `packages/control-plane/src/runtime-nodes/attach-service.ts#readRoster`).
//     A below-floor node is ADMITTED read-only,
//     not ejected (I-003-1, Plan-003 §Invariants) — see the I-003-1 note below
//     for why the roster MUST never hide such a node. A node may be `online`
//     AND `readOnly` at once (the axes are independent); all are rendered.
//
// NEVER-MASK (`Spec-003 §Default Behavior`): the two HEALTH axes (`state`, `healthState`)
// have distinct owners — the slot axis vs the heartbeat sweep — and this view
// renders BOTH, verbatim, side by side. It computes NO collapsed/"effective"
// health scalar, so a recovery on one axis can never mask a degradation on the
// other; the wire itself carries no collapsed scalar either (the BOTH-AXES
// STANCE note above
// `packages/contracts/src/runtime-node.ts#RuntimeNodeRosterRequest`), and
// reconciling the axes is deliberately this client's render-time concern,
// satisfied here by presenting both.
//
// Spec-003 coverage:
//   • `Spec-003 §Acceptance Criteria` AC2 ("a degraded or offline node remains distinguishable from
//     a healthy online node"): the per-node row renders BOTH health axes as
//     labeled indicators, and a `degraded`/`offline` node (on either axis) is
//     kept in the rendered set with those indicators rather than removed (see
//     the I-003-1 admit-not-eject note).
//   • `Spec-003 §Acceptance Criteria` AC3 ("multiple runtime nodes can coexist in one session
//     without changing session identity"): the roster renders a SET
//     (`nodes.map(...)`), not a singleton. The `sessionId` prop scopes the
//     read; the roster never mutates it, so adding a second (e.g. below-floor)
//     node changes the rendered set, not the session identity. This is the
//     MULTI-NODE requirement.
//   • `Spec-003 §Required Behavior` ("multiple runtime nodes per session"): same set-render
//     — the component is structurally a list over the session's attached
//     nodes, one entry per `runtime_node_attachments` row.
//   • `Spec-003 §Fallback Behavior` ("capability-validation failure keeps the node
//     degraded/offline, distinguishable from healthy"): a node that failed
//     capability validation arrives in the read with `state: "degraded"` (the
//     §Fallback-Behavior axis — capability-validation failure leaves the node
//     `degraded`, the LEAST-PRIVILEGE note on `healthChanges.state`); the roster surfaces it with the
//     degraded indicator alongside healthy peers. This view does NOT perform
//     the validation (that is the daemon/control-plane authority) — it
//     projects the resulting `state` distinguishably.
//
// I-003-1 (admit-not-eject) — what this roster MUST NOT do. T5.1 cites no
// invariant (it is a read-only projection), but I-003-1 (Plan-003 §Invariants,
// "a below-floor node stays JOINED and VISIBLE; it is never ejected") shapes a
// NEGATIVE requirement on the render: a `degraded`/`offline` node (on either
// health axis) and a `readOnly` (below-floor) node are ALL kept in the
// rendered set with their indicators — never filtered out. There is
// deliberately NO `.filter(...)` that drops a node by `state`, `healthState`,
// or `readOnly`; the roster renders every node the read returns (the server
// side is equally unfiltered — `Spec-003 §Interfaces And Contracts`'s "every row, no server-side
// hiding" visibility clause). A future reader must NOT add a "hide
// offline/below-floor nodes" filter: that would violate I-003-1's
// admit-not-eject guarantee and break the AC2 distinguishability this view
// exists to provide.
//
// THE DESIGN — controlPlane.call snapshot + daemon.subscribe trigger:
//
//   This mirrors the shipped `session-members/participant-roster.tsx` Option-C
//   flow exactly (snapshot-read + subscribe-as-change-signal), with two
//   transport differences appropriate to runtime-node state:
//     • The DECODED roster snapshot is read through the GENERIC control-plane
//       surface `window.sidekicks.controlPlane.call(...)` — the roster is
//       control-plane-owned cross-node coordination state (`Spec-003 §Required Behavior`;
//       shared-postgres-schema.md `runtime_node_attachments` /
//       `runtime_node_presence`), NOT `daemon.call`: `runtimenode.roster` is
//       registered control-plane tRPC ONLY (a daemon knows only itself), per
//       the registry row (`docs/architecture/contracts/api-payload-contracts.md §Runtime-Node Method-Name Registry (Tier 3)`).
//     • Live health TRANSITIONS arrive on `window.sidekicks.daemon.subscribe(
//       <runtime_node.* event>, handler)` — the daemon authors the
//       daemon-reachable `runtime_node.*` lifecycle events (the registered
//       7-name set `packages/contracts/src/runtime-node.ts#RUNTIME_NODE_EVENT_NAMES`;
//       the 5 V1 daemon-reachable producers, its
//       `Runtime-node event PAYLOAD-shape schemas` banner). Each pushed event
//       is treated as an OPAQUE change-signal that RE-INVOKES the snapshot
//       read; we deliberately do NOT decode the event payload into accumulated
//       client state (the same posture participant-roster takes for
//       `PresenceUpdate` — see its header). A maintainer's instinct to "merge
//       the event payload into the roster" is wrong here: the control-plane
//       read is the source of truth for the rendered set; the event only says
//       WHEN to re-read. (Tier 8 MAY decode + merge to avoid the re-read round
//       trip; the chattiness is a noted Tier-8 optimization, not a Tier-3
//       concern.)
//
//   BOTH READS TRAVEL THROUGH ONE OPTIONAL SEAM. The pair above is the DEFAULT
//   (`INSTALLED_BRIDGE_READS`), not the only possibility: a host that resolves
//   its own bridge holds a different object from the installed one and cannot
//   otherwise stand in for it, so `NodeRosterProps.reads` lets it hand the pair
//   in. Omitting the prop is what every existing caller does and reaches exactly
//   the `window.sidekicks` calls described above; nothing about the wire names,
//   the ordering, the guards, or the render moves either way.
//
//   Subscribe-BEFORE-initial-read ordering is deliberate (identical rationale
//   to participant-roster): a node-state change landing AFTER the snapshot but
//   BEFORE the subscription installs would otherwise be lost, leaving the
//   roster stale until the next change. Installing the subscription first
//   makes the worst case a redundant re-read (collapsed by the out-of-order
//   guard), not an unrecoverable missed update.
//
// REGISTERED roster-read transport (T5.0a–T5.0d scope expansion, PR #150) —
//
//   `runtimenode.roster` is a REGISTERED wire contract, not a deferral. The
//   Runtime-Node Method-Name Registry exposes five `runtimenode.*` methods —
//   four mutations (`attach`/`heartbeat`/`capabilityupdate`/`detach`) plus
//   this namespace-first `query` (the registry table, roster row, and
//   procedure-type paragraph in
//   `docs/architecture/contracts/api-payload-contracts.md §Runtime-Node Method-Name Registry (Tier 3)`)
//   — with the request/response wire shapes at
//   `docs/architecture/contracts/api-payload-contracts.md §Tier 3: Plan-003 — Runtime Node Attach (Task 4.4)` and the contract pinned in
//   `Spec-003 §Interfaces And Contracts`. Server truth:
//   `packages/control-plane/src/runtime-nodes/attach-service.ts#readRoster`,
//   mounted as the router's first `.query()` (the `roster` procedure on
//   `packages/control-plane/src/runtime-nodes/runtime-node-router.factory.ts#createRuntimeNodeRouter`);
//   the Node-side SDK arm (the `roster` method on
//   `packages/client-sdk/src/runtimeNodeClient.ts#createControlPlaneRuntimeNodeClient`,
//   T5.0d) proves the procedure end-to-end against the real services.
//
//   This renderer still routes the read through the GENERIC
//   `controlPlane.call(...)` bridge surface with the hardcoded registered wire
//   string below (the same registered-name-as-local-const idiom as
//   `apps/desktop/src/renderer/src/session-members/participant-roster.tsx#PRESENCE_READ_METHOD`,
//   the `presence.read` name): the bridge's `CpProcedure`
//   brand is still `never`-shaped at Tier 1 (desktop-bridge.ts:99), so no
//   typed per-procedure surface exists to bind yet. At Tier 1 every bridge
//   method throws `NotImplementedAtTier1Error` (desktop-bridge.ts:334-336,
//   `tier1Throw`; the `controlPlane.call` stub at :353), so the component's
//   REJECTED render branch is the production-observable path until Plan-023
//   Tier 8 wires the real IPC handler through the main process onto the
//   SHIPPED SDK arm (CP-003-3). The remaining gap is the bridge WIRING, not
//   the contract.
//
// Renderer-untrusted boundary (Spec-023 §Trust Stance) — this file imports ONLY:
//   • `react` — the renderer's UI engine; explicitly allowed.
//   • Type-only from `@ai-sidekicks/contracts` — the contracts package is
//     renderer-safe (no `node:*`, `electron`, or `fs`/`path`/`process` runtime
//     imports); the type-only form emits NO JS runtime import, so only the
//     type-graph view of the wire shapes reaches the renderer.
// No `electron`, no `node:*`, no `./src/main/**`, no `./src/preload/**`, and no
// `@ai-sidekicks/client-sdk` (the Node-side `runtimeNodeClient.ts` SDK) —
// statically enforced via the `no-restricted-imports` rule in
// apps/desktop/eslint.config.mjs. (The `@ai-sidekicks/client-sdk` ban is
// structural since Plan-023 T-023p-1C-1 removed the package from this app's
// manifest — the specifier no longer resolves here, per the SessionBootstrap
// header.)

import { useEffect } from "react";

import type {
  RuntimeNodeRosterEntry,
  RuntimeNodeRosterRequest,
  RuntimeNodeRosterResponse,
  SessionId,
  Unsubscribe,
} from "@ai-sidekicks/contracts";

// The wire-rejection normalizer is shared across every renderer surface and
// both Electron processes, so it lives in `src/shared/` rather than being
// written a fourth time here (Plan-023 Phase 1B). It renders ANY code+message
// envelope with the wire `code` as `Error.name`, which is exactly what this
// view's below-floor labeling needed and is strictly wider: a
// `version.floor_exceeded` read refusal still surfaces as
// `version.floor_exceeded: <server message>`, and every OTHER typed
// `runtimenode.*` refusal now surfaces by its own code instead of collapsing
// to `[object Object]`. The code-specific recognizer this file used to carry
// therefore bought nothing on the render path and is gone; the compile-time
// binding to the contracts literal survives in the one view that BRANCHES on
// the code (`MixedVersionStatus.tsx#VERSION_FLOOR_EXCEEDED_WIRE_CODE`).
import { normalizeWireRejection } from "../../../shared/wire-errors.js";

// The held-answer stamp. A settled roster belongs to the session AND the transport
// it was read through, and comparing one of those during render is what left the
// retired transport's rows on screen — so the comparison is taken from the console's
// one implementation of the rule rather than written a second time here.
//
// Reached by its own specifier rather than through the store family's door: this
// component is a Tier-1 renderer subtree that the console ABSORBS, not a console
// family, so the door's cross-family rule does not govern it — and the door
// publishes the session stores, the frame store, and the schedulers, none of which
// a view holding no store has any business pulling in to compare two identities.
import {
  useSubjectStampedState,
  type SubjectStamp,
} from "../console/store/subject-stamped-state.js";

// The `window.sidekicks` ambient type lives in the renderer-wide
// `sidekicks-bridge.d.ts` (Plan-002 Phase 6 T6.0; part of the renderer
// typecheck graph via its `include`), so `window.sidekicks` below is
// `SidekicksBridge`-typed without an import here. The bridge exposes exactly
// six GENERIC capability surfaces (Spec-023; desktop-bridge.ts:265-314) —
// there is no `runtimeNode` namespace and no per-procedure typing yet, so the
// registered `runtimenode.roster` name rides the generic
// `controlPlane.call(...)` / `daemon.subscribe(...)` pair below.

// Wire procedure / event / error-code names.
//
// `ROSTER_READ_PROCEDURE` — the REGISTERED control-plane procedure for the
// reconciled roster read (presence × slot): registry row
// `docs/architecture/contracts/api-payload-contracts.md §Runtime-Node Method-Name Registry (Tier 3)` (`query`, control-plane tRPC ONLY — the
// namespace's first and only query; its four siblings are mutations), served
// by `AttachService.readRoster` via the router's first `.query()` (the
// `roster` procedure on
// `packages/control-plane/src/runtime-nodes/runtime-node-router.factory.ts#createRuntimeNodeRouter`).
// Hardcoded as a local `const` per the shipped renderer idiom
// (`apps/desktop/src/renderer/src/session-members/participant-roster.tsx#PRESENCE_READ_METHOD`):
// the bridge surface is generic, so the registered
// name is the single greppable coupling point the Plan-023 Tier 8 IPC wiring
// binds. The name lives in the `runtimenode.*` METHOD namespace
// (error.ts:106-109 — the namespace deliberately uses no separator, distinct
// from the `runtime_node.*` EVENT names). The response is typed end-to-end via
// the imported `RuntimeNodeRosterResponse` DTO on the `readRoster` cast below.
const ROSTER_READ_PROCEDURE = "runtimenode.roster";

// `runtime_node.online` — one of the 7 registered `runtime_node.*` lifecycle
// event names (`packages/contracts/src/runtime-node.ts#RUNTIME_NODE_EVENT_NAMES`),
// and one of the 5
// daemon-reachable V1 producers (`registered`, `online`, `offline`,
// `capability_declared`, `capability_updated` — its
// `Runtime-node event PAYLOAD-shape schemas` banner; `degraded`/`revoked`
// are V1.1-gated server-derived events with no V1 author). We subscribe to
// the liveness-transition signal and treat each push as an OPAQUE "node state
// changed" trigger to re-read the snapshot — we do NOT decode the payload
// (same change-signal posture as participant-roster's `PresenceUpdate`).
// `online` is the canonical liveness-transition event for AC2's health
// distinguishability; the Tier-8 wiring may broaden the subscription to the
// full `runtime_node.*` family once the bridge's `DaemonEvent` brand narrows
// to the event union (Plan-007) and the subscribe surface carries
// per-subscription params (the DECIDED bridge-shape gap documented on
// participant-roster).
const RUNTIME_NODE_ONLINE_EVENT = "runtime_node.online";

/**
 * The two reads this view performs, as one substitutable seam.
 *
 * ADDITIVE AND OPTIONAL. The default below is exactly the pair this view has
 * always used — `window.sidekicks.controlPlane.call(ROSTER_READ_PROCEDURE, …)`
 * and `window.sidekicks.daemon.subscribe(RUNTIME_NODE_ONLINE_EVENT, …)` — so a
 * caller that supplies nothing gets the shipped behaviour unchanged, and every
 * existing caller and test is unaffected.
 *
 * It exists because a HOST that resolves its own bridge cannot stand in for the
 * installed one: it holds a different object, and this view reads the global. A
 * host that holds the pair can now hand them in, and one that does not gets the
 * global. Neither the wire names above nor anything this view renders moves.
 *
 * The seam is narrower than the bridge surfaces it defaults to, deliberately.
 * `readRoster` takes the registered REQUEST and no procedure name, and
 * `subscribePresence` takes the session and no event name, because which
 * procedure answers a roster read and which registered `runtime_node.*` names a
 * presence subscription carries are facts about the wire rather than choices a
 * host makes — a seam that took them as arguments would invite a second, quieter
 * answer to both.
 *
 * A HOST HOLDS ONE PAIR PER TRANSPORT. The effect below depends on this object's
 * identity, because a replaced transport is the one change a session-keyed
 * dependency cannot see, so a pair composed fresh on every render resubscribes on
 * every render. That is a host's own doing rather than a hazard hidden here: the
 * console's mount caches one seam per bridge, and the default arm is a module
 * constant.
 */
export interface NodeRosterReads {
  /** One session's roster snapshot, as the registered read answers it. */
  readRoster: (request: RuntimeNodeRosterRequest) => Promise<RuntimeNodeRosterResponse>;
  /**
   * Node presence transitions for one session, as an opaque change signal.
   *
   * The handler takes NO payload, which is the same posture the effect below
   * already holds the installed subscription to: a push says WHEN to re-read and
   * the control-plane snapshot stays the source of the rendered set.
   */
  subscribePresence: (sessionId: SessionId, onPresenceChange: () => void) => Unsubscribe;
}

/**
 * The default seam: the installed bridge, reached exactly as it always was.
 *
 * Each member reaches `window.sidekicks` when it is CALLED rather than when this
 * object is built, so a host that supplies its own seam never touches the global
 * — including in a window where no preload ran and the global is absent. The two
 * brand casts are the ones this file has always carried; they move here with the
 * calls they annotate and are described in the effect's own notes below.
 */
const INSTALLED_BRIDGE_READS: NodeRosterReads = {
  readRoster: (request) => {
    const callProcedure = window.sidekicks.controlPlane.call as (
      procedure: string,
      input: RuntimeNodeRosterRequest,
    ) => Promise<RuntimeNodeRosterResponse>;
    return callProcedure(ROSTER_READ_PROCEDURE, request);
  },
  subscribePresence: (sessionId, onPresenceChange) => {
    const subscribeNodeHealth = window.sidekicks.daemon.subscribe as (
      event: string,
      handler: (payload: unknown) => void,
    ) => Unsubscribe;
    return subscribeNodeHealth(RUNTIME_NODE_ONLINE_EVENT, () => {
      onPresenceChange();
    });
  },
};

/**
 * Props for {@link NodeRoster}.
 *
 * `sessionId` is the branded {@link SessionId} of the session whose node roster
 * to render. It matches `RuntimeNodeRosterRequest.sessionId`
 * (`packages/contracts/src/runtime-node.ts#RuntimeNodeRosterRequest`), so
 * `{ sessionId }` constructs a valid roster-read request with no cast. The roster read is scoped to this id, and the roster
 * NEVER mutates it — adding nodes changes the rendered set, not the session
 * identity (AC3). The id arrives as a prop (supplied by a future Plan-023
 * router/deep-link; exercised by the T5.4 manual smoke), not from
 * renderer-side discovery — the same prop-contract posture as
 * `ParticipantRoster`.
 */
export interface NodeRosterProps {
  sessionId: SessionId;
  /**
   * Where the two reads come from. Omitted, they come from the installed bridge.
   *
   * Optional rather than required so that adding it changes nothing for a caller
   * that had none — see {@link NodeRosterReads} for why a host would supply one.
   */
  reads?: NodeRosterReads;
}

// Discriminated-union view state — identical three-state shape to
// `ParticipantRoster`'s `RosterState`. Mount-triggered, so it STARTS in
// `loading` (the read fires on mount; there is no button). Each variant maps
// 1:1 to a rendered `<section>` branch below, so the render is a total
// function over the union. The `loaded` variant carries the verbatim
// `RuntimeNodeRosterEntry[]` set from the read — the SHIPPED T5.0b wire DTO
// (`packages/contracts/src/runtime-node.ts#RuntimeNodeRosterEntry`), not a
// local view-model — so the render binds to the real contract axes by
// construction.
//
// No-flicker contract (same as participant-roster): `loading` is what the view
// shows whenever nothing has been read FOR THE CURRENT SUBJECT, and the subject
// is the (session, transport) pair the effect below reads through. It is NOT
// re-entered on a same-subject re-read: `refreshSnapshot` publishes ONLY
// `loaded`/`error` under the subject it read for, so a live-health re-read updates
// the node set IN PLACE and never flashes back to the loading branch.
type RosterViewState =
  | { kind: "loading" }
  | { kind: "loaded"; nodes: RuntimeNodeRosterEntry[] }
  | { kind: "error"; error: Error };

/**
 * The "nothing has been read for this subject yet" answer, as one frozen value.
 *
 * A module constant rather than a fresh literal, so the identity of the absence does
 * not change between the passes that produce it — the same reasoning `store/hooks.ts`
 * gives for freezing its own not-loaded arm.
 */
const ROSTER_NOT_READ: RosterViewState = { kind: "loading" };

/**
 * What a held roster is an answer about: this session, read through this transport.
 *
 * Both, and written once. A change to EITHER makes the rows on screen an answer to a
 * question nobody is asking — the session for the obvious reason, the transport
 * because the console's bridge provider replaces its resolution without remounting
 * its children, so a swapped scenario or a re-minted engine leaves the retired
 * bridge's rows standing under a live one. The pair is also exactly the effect's own
 * dependency list, which is what keeps the render-side comparison and the read-side
 * teardown from ever disagreeing about what a new subject is.
 */
function rosterSubjectFor(sessionId: SessionId, reads: NodeRosterReads): SubjectStamp {
  return [sessionId, reads];
}

/**
 * Renders the live roster of runtime nodes attached to a session: a loading
 * indicator while the initial snapshot is in flight, one row per node (id +
 * slot `state` + liveness `healthState`/`lastHeartbeatAt` +
 * read-only/below-floor status) once loaded, or the error envelope on failure.
 * The roster refreshes itself as node health transitions — see the
 * controlPlane.call-snapshot + daemon.subscribe-trigger design note in the
 * file header.
 *
 * State primitive — manual `useState` discriminated union (NOT React 19
 * `useTransition`/`useActionState`), matching the shipped
 * `ParticipantRoster`/`SessionBootstrap` precedent: it keeps the renderer
 * consumers structurally consistent and fits the Tier-1 sync-throw
 * normalization (which needs explicit `try/catch` around the bridge calls).
 */
export function NodeRoster({
  sessionId,
  reads = INSTALLED_BRIDGE_READS,
}: NodeRosterProps): React.JSX.Element {
  // The held roster is STAMPED with the subject it was read for, rather than kept
  // beside a comparison of one prop. A session change and a transport change are the
  // same failure — rows answering a question that has been replaced — and the second
  // one is the invisible half: the session id does not move when the console's bridge
  // provider swaps its resolution, and a refresh deliberately never re-enters
  // `loading`, so the retired bridge's roster would stand until the replacement read
  // settled, which is unbounded. Stamping substitutes the not-read answer in the
  // render that first sees the new subject, BEFORE commit, so no pass paints the old
  // transport's rows under the new one. It also drops a reply published for a subject
  // this view has left, which is the belt to the effect's own `cancelled` braces.
  const rosterSubject = rosterSubjectFor(sessionId, reads);
  const [rosterViewState, publishRosterViewState] = useSubjectStampedState<RosterViewState>(
    rosterSubject,
    ROSTER_NOT_READ,
  );

  useEffect(() => {
    // Strict-mode-safe mount (same posture as participant-roster /
    // SessionBootstrap). The closure-scoped `let cancelled`, flipped in
    // cleanup, makes any in-flight read resolution (initial OR
    // subscribe-triggered) a no-op after this effect run is torn down — so we
    // never `setState` on an unmounted (or about-to-be-remounted) tree under
    // StrictMode's double-invoke. The `let` RESETS per effect run, which is
    // what neutralizes the double-invoke (a persisting `useRef` would not).
    let cancelled = false;

    // Effect-scoped monotonic read sequence — the out-of-order guard. Multiple
    // `refreshSnapshot()` calls can be IN FLIGHT at once (rapid subscribe
    // pushes each kick off a read), and the bridge gives no
    // resolution-ordering guarantee; without this counter an OLDER read
    // resolving AFTER a NEWER one would overwrite fresh data with stale. Each
    // `refreshSnapshot` captures the value AFTER incrementing; a resolution
    // whose captured sequence is no longer the latest bails without setState.
    // RESETS per effect run (same rationale as `cancelled`).
    let latestRequestSequence = 0;

    // Held so cleanup can release the daemon subscription. `undefined` until
    // the synchronous `subscribeNodeHealth(...)` below succeeds — at Tier 1 it
    // throws synchronously, so `unsubscribe` stays `undefined` and
    // `unsubscribe?.()` in cleanup is a safe no-op.
    let unsubscribe: Unsubscribe | undefined;

    // The seam this effect performs both of its reads through — the installed
    // bridge by default, or whatever the host handed in.
    //
    // The two brand casts the default arm carries are the ones this file has
    // always carried, and they now live beside the calls they annotate in
    // `INSTALLED_BRIDGE_READS` above. `CpProcedure` (Plan-002/Plan-008
    // follow-up) and `DaemonEvent` (Plan-007 follow-up) are both `never`-shaped
    // brands at Tier 1 (desktop-bridge.ts:99 and :81), so no string literal is
    // structurally assignable to either until those surfaces narrow; the
    // procedure and event NAMES stay loosely `string` (the genuinely untypeable
    // part) while the request and the response are pinned to the shipped DTOs,
    // and the subscribe payload stays `unknown` because it is an opaque
    // change-signal this view never decodes (see the header). Reading them from
    // this seam rather than from the global is what makes the pair
    // substitutable; it changes neither cast nor either wire name.
    const { readRoster, subscribePresence } = reads;

    // The subject THIS effect run reads for, rebuilt from the same two inputs its
    // dependency list names. Every publish below carries it, so a reply that lands
    // after the view has moved on is dropped by the stamp rather than installed —
    // and the render-side comparison is against the subject the render is about, not
    // against whatever the last publish happened to be for.
    const readSubject = rosterSubjectFor(sessionId, reads);

    // Shared decoded-snapshot read. Used for BOTH the initial read and every
    // subscribe-triggered refresh. The async-IIFE shape funnels a SYNCHRONOUS
    // Tier-1 stub throw (`() => tier1Throw("controlPlane.call")`,
    // desktop-bridge.ts:353) AND a future async rejection into the same
    // `catch`: a bare `readRoster(...).then(...).catch(...)` would evaluate
    // `readRoster(...)` first, and the sync throw would escape before `.then`
    // is reached and crash the effect callback (React does not catch
    // effect-callback throws). This function NEVER setStates to
    // `{ kind: "loading" }` — only `loaded`/`error` — so subscribe-triggered
    // re-reads never flash back to the loading branch (the no-flicker
    // contract).
    //
    // Each invocation captures a fresh `requestSequence` AFTER incrementing
    // the effect-scoped counter, so the LATEST in-flight read always owns the
    // highest sequence. Both branches bail when EITHER the effect was torn
    // down (`cancelled`) OR a newer read has since started
    // (`requestSequence !== latestRequestSequence`) — two independent guards
    // (unmount vs out-of-order), both required.
    const refreshSnapshot = (): void => {
      const requestSequence = ++latestRequestSequence;
      void (async () => {
        try {
          const rosterResponse = await readRoster({ sessionId });
          if (cancelled || requestSequence !== latestRequestSequence) return;
          // No cast — the tightened brand cast above already types the
          // resolved value as the shipped `RuntimeNodeRosterResponse`. The
          // full node set is rendered (admit-not-eject, I-003-1): no
          // `.filter(...)` drops a node by `state`, `healthState`, or
          // `readOnly`.
          publishRosterViewState(readSubject, { kind: "loaded", nodes: rosterResponse.nodes });
        } catch (bridgeError: unknown) {
          if (cancelled || requestSequence !== latestRequestSequence) return;
          // Tier-3 production branch: at Tier 1 every bridge method throws
          // `NotImplementedAtTier1Error` (desktop-bridge.ts
          // `createTier1Bridge`), so this is the production-observable path
          // until Plan-023 Tier 8 wires the real IPC handler onto the shipped
          // SDK arm. We do not narrow on `instanceof` for the render decision
          // — any `Error` shape renders the same envelope; non-`Error`
          // rejections are wrapped so the render branch always holds a real
          // `Error`. A TYPED refusal envelope keeps its wire code as the
          // rendered `Error.name` — including the below-floor
          // `version.floor_exceeded` verdict a `readOnly` node's writes
          // return, which is the read reflection of AC2's at-floor vs
          // below-floor distinguishability. The bare (non-`total`) wrap is
          // correct here: this is a bridge CATCH binding, so the value came
          // off the IPC surface and a ToPrimitive-failing shape is not
          // realistically reachable. A re-read failure flips the whole roster
          // to `error` (the Tier-3 posture, matching the initial-read
          // failure); a resilient "keep last snapshot" is a Tier-8 polish, not
          // a Tier-3 requirement.
          const normalizedError = normalizeWireRejection(bridgeError);
          publishRosterViewState(readSubject, { kind: "error", error: normalizedError });
        }
      })();
    };

    // 1. Subscribe to the change-signal stream FIRST, BEFORE the initial read
    //    (same ordering rationale as participant-roster: a change landing
    //    after the snapshot but before the subscription installs would
    //    otherwise be lost). The synchronous `subscribePresence(...)` call
    //    gets its OWN `try/catch` because at Tier 1 it throws synchronously
    //    (`() => tier1Throw("daemon.subscribe")`, desktop-bridge.ts:350) — and
    //    an injected seam whose host has no live channel throws here too, so
    //    the arm covers both and neither leaves the view believing it is live;
    //    an
    //    uncaught throw here would crash the effect callback and strand the
    //    view. On the throw we drive the error state, same envelope as the
    //    read. The initial `refreshSnapshot()` sits INSIDE this `try` (step 2)
    //    so a subscribe-throw skips it rather than clobbering the error with a
    //    channel-less snapshot; a READ failure is still owned by the IIFE's
    //    own `catch`. The handler re-invokes `refreshSnapshot` (which closes
    //    over `cancelled` + the sequence guard, so a re-read kicked off the
    //    instant before unmount cannot `setState` after cleanup); we do NOT
    //    consume the event payload — it is an opaque change-signal.
    try {
      unsubscribe = subscribePresence(sessionId, () => {
        refreshSnapshot();
      });

      // 2. Initial decoded snapshot — INSIDE this `try`, AFTER the subscribe
      //    assignment, so it runs ONLY when the subscription actually
      //    installed (ordering + honesty: a subscribe-throw jumps to the
      //    `catch` below and SKIPS this read, so we never CLOBBER the error
      //    with a stale `loaded` that has no live channel — the same posture
      //    as participant-roster).
      refreshSnapshot();
    } catch (subscribeError: unknown) {
      if (!cancelled) {
        publishRosterViewState(readSubject, {
          kind: "error",
          error: normalizeWireRejection(subscribeError),
        });
      }
    }

    return () => {
      cancelled = true;
      // Idempotent per the `Unsubscribe` contract (desktop-bridge.ts:115-118);
      // `?.()` no-ops when the Tier-1 subscribe threw before assigning.
      unsubscribe?.();
    };
    // `[sessionId, reads]` (not `[]`, and not `[sessionId]`): the effect reads
    // and subscribes through a specific transport for a specific session, so a
    // change to EITHER must tear down the old subscription and re-run.
    // `SessionId` is a string brand, so referential equality holds there and the
    // effect does not re-run on unrelated re-renders.
    //
    // `reads` is a dependency because "same session, different transport" is a
    // state a host genuinely reaches: the console's bridge provider REPLACES its
    // resolution without remounting its children — on a supplied-bridge or
    // scenario change, and again when its own engine has been disposed and a
    // second mount must take a fresh one. Left out, this effect would stay
    // subscribed to the superseded bridge, keep reading a disposed engine, and
    // show stale rows with nothing on screen saying so.
    //
    // What makes the dependency safe is that the seam is STABLE PER BRIDGE
    // rather than composed per render — the console's mount caches one pair per
    // bridge identity, and the default arm below is a module constant. So a
    // re-run means the transport genuinely changed, which is exactly the churn
    // the previous omission was reaching for and the correctness it gave up to
    // get it. A host that composes a fresh pair on every render is asking for a
    // resubscribe on every render, which is the honest reading of what it did.
  }, [sessionId, reads]);

  if (rosterViewState.kind === "loading") {
    // `aria-busy` announces the in-flight initial snapshot to assistive tech.
    return (
      <section aria-label="node-roster-loading" aria-busy="true">
        <p>Loading runtime nodes…</p>
      </section>
    );
  }

  if (rosterViewState.kind === "loaded") {
    // One row per node (AC3 set-render). Each row distinguishes all three wire
    // facets — the two HEALTH axes verbatim (never-mask, `Spec-003 §Default Behavior`)
    // plus the permission verdict:
    //   • slot `state` — `online` vs `degraded`/`offline`/`registering`/
    //     `revoked` (AC2 + the `Spec-003 §Fallback Behavior` capability-degrade
    //     distinguishability).
    //   • liveness `healthState` + `lastHeartbeatAt` — the sweep-owned
    //     presence verdict, rendered verbatim and SEPARATELY from `state` (no
    //     collapsed/"effective" scalar is computed, so a recovery on one axis
    //     never masks a degradation on the other). The pre-first-heartbeat
    //     `null` renders as an explicit "none" label, not a hidden field.
    //   • `readOnly` — at-floor (read-write) vs below-floor (read-only); the
    //     `data-read-only` attribute + label surface the below-floor verdict
    //     (I-003-1: the below-floor node is VISIBLE, not ejected).
    // No `.filter(...)` — every node the read returned is rendered
    // (admit-not-eject). `data-node-state` / `data-health-state` /
    // `data-read-only` expose the facets for the T5.4 manual smoke and for the
    // BL-131 component suite in `__tests__/NodeRoster.test.tsx` to assert
    // distinguishability without scraping prose. `data-health-state` is ABSENT exactly when the wire
    // value is `null` (React omits null-valued attributes) — the DOM mirrors
    // the LEFT-JOIN nullability verbatim rather than inventing a fourth enum
    // token.
    return (
      <section aria-label="node-roster-loaded">
        <ul>
          {rosterViewState.nodes.map((node) => (
            <li
              key={node.nodeId}
              data-node-state={node.state}
              data-health-state={node.healthState}
              data-read-only={node.readOnly}
            >
              <span>node id: {node.nodeId}</span>
              <span>state: {node.state}</span>
              <span>liveness: {node.healthState ?? "none (no heartbeat yet)"}</span>
              <span>last heartbeat: {node.lastHeartbeatAt ?? "none (no heartbeat yet)"}</span>
              <span>
                access: {node.readOnly ? "read-only (below version floor)" : "read-write"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  // role="alert" so assistive tech announces the failure.
  return (
    <section aria-label="node-roster-error" role="alert">
      <p>
        {rosterViewState.error.name}: {rosterViewState.error.message}
      </p>
    </section>
  );
}
