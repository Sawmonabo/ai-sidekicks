// Plan-003 Phase 5 T5.1 (Tier 3) — renderer NodeRoster component.
//
// A thin bridge projection over `window.sidekicks`: it renders the SET of
// runtime nodes attached to the active session — one `RuntimeNodeRosterEntry`
// per `runtime_node_attachments` row, exactly as the registered
// `runtimenode.roster` read returns it — and visually distinguishes the three
// status facets the wire entry carries (api-payload-contracts.md:534-544;
// runtime-node.ts:560-570):
//   • `state: NodeState` — the SLOT axis (registering|online|degraded|offline|
//     revoked, runtime-node.ts:86), `runtime_node_attachments.state` carried
//     verbatim with all five values: the read is a faithful projection with no
//     server-side hiding (Spec-003 §Interfaces And Contracts amendment, lines
//     90-94). AC2 distinguishability (Spec-003 line 128): a `degraded`/
//     `offline` node renders with a degraded/offline indicator, NOT a
//     disappearance — a healthy `online` node is visually distinct from one
//     that is not.
//   • `healthState` + `lastHeartbeatAt` — the LIVENESS axis: the sweep-owned
//     3-value presence verdict (`online | degraded | offline`) carried
//     VERBATIM from `runtime_node_presence`, nullable until the node's first
//     heartbeat lands (LEFT JOIN — runtime-node.ts:587-603). The read NEVER
//     derives staleness (the Plan-003 T3.6 sweep stays the single
//     liveness-derivation writer), and neither does this view.
//   • `readOnly: boolean` — the PERMISSION axis, DERIVED per row at read time:
//     true iff the node's stored `client_version` is below the session's
//     `min_client_version` floor (runtime-node.ts:604-609; the server
//     derivation lives in `AttachService.readRoster`,
//     attach-service.ts:1000-1059). A below-floor node is ADMITTED read-only,
//     not ejected (I-003-1, Plan-003 §Invariants) — see the I-003-1 note below
//     for why the roster MUST never hide such a node. A node may be `online`
//     AND `readOnly` at once (the axes are independent); all are rendered.
//
// NEVER-MASK (Spec-003 line 72): the two HEALTH axes (`state`, `healthState`)
// have distinct owners — the slot axis vs the heartbeat sweep — and this view
// renders BOTH, verbatim, side by side. It computes NO collapsed/"effective"
// health scalar, so a recovery on one axis can never mask a degradation on the
// other; the wire itself carries no collapsed scalar either (the both-axes
// stance on the entry schema, runtime-node.ts:528-536), and reconciling the
// axes is deliberately this client's render-time concern, satisfied here by
// presenting both.
//
// Spec-003 coverage:
//   • §AC2 (line 128, "a degraded or offline node remains distinguishable from
//     a healthy online node"): the per-node row renders BOTH health axes as
//     labeled indicators, and a `degraded`/`offline` node (on either axis) is
//     kept in the rendered set with those indicators rather than removed (see
//     the I-003-1 admit-not-eject note).
//   • §AC3 (line 129, "multiple runtime nodes can coexist in one session
//     without changing session identity"): the roster renders a SET
//     (`nodes.map(...)`), not a singleton. The `sessionId` prop scopes the
//     read; the roster never mutates it, so adding a second (e.g. below-floor)
//     node changes the rendered set, not the session identity. This is the
//     MULTI-NODE requirement.
//   • Spec-003 line 49 ("multiple runtime nodes per session"): same set-render
//     — the component is structurally a list over the session's attached
//     nodes, one entry per `runtime_node_attachments` row.
//   • Spec-003 line 76 ("capability-validation failure keeps the node
//     degraded/offline, distinguishable from healthy"): a node that failed
//     capability validation arrives in the read with `state: "degraded"` (the
//     §Fallback-Behavior axis — capability-validation failure leaves the node
//     `degraded`, runtime-node.ts:223-226); the roster surfaces it with the
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
// side is equally unfiltered — Spec-003 line 92's "every row, no server-side
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
//       control-plane-owned cross-node coordination state (Spec-003 line 52;
//       shared-postgres-schema.md `runtime_node_attachments` /
//       `runtime_node_presence`), NOT `daemon.call`: `runtimenode.roster` is
//       registered control-plane tRPC ONLY (a daemon knows only itself), per
//       the registry row (api-payload-contracts.md:562).
//     • Live health TRANSITIONS arrive on `window.sidekicks.daemon.subscribe(
//       <runtime_node.* event>, handler)` — the daemon authors the
//       daemon-reachable `runtime_node.*` lifecycle events (the registered
//       7-name set, runtime-node.ts:693-709; the 5 V1 daemon-reachable
//       producers, runtime-node.ts:715-722). Each pushed event is treated as
//       an OPAQUE change-signal that RE-INVOKES the snapshot read; we
//       deliberately do NOT decode the event payload into accumulated client
//       state (the same posture participant-roster takes for `PresenceUpdate`
//       — see its header). A maintainer's instinct to "merge the event payload
//       into the roster" is wrong here: the control-plane read is the source
//       of truth for the rendered set; the event only says WHEN to re-read.
//       (Tier 8 MAY decode + merge to avoid the re-read round trip; the
//       chattiness is a noted Tier-8 optimization, not a Tier-3 concern.)
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
//   this namespace-first `query` (the registry table at
//   api-payload-contracts.md:556-562, roster row :562; procedure-type
//   paragraph :564) — with the request/response wire shapes at
//   api-payload-contracts.md:527-547 and the contract pinned in Spec-003
//   §Interfaces And Contracts (line 86; amendment lines 90-94). Server truth:
//   `AttachService.readRoster` (attach-service.ts:1000-1059), mounted as the
//   router's first `.query()` (runtime-node-router.factory.ts:268-287); the
//   Node-side SDK arm (`runtimeNodeClient.ts` control-plane `roster`, T5.0d)
//   proves the procedure end-to-end against the real services.
//
//   This renderer still routes the read through the GENERIC
//   `controlPlane.call(...)` bridge surface with the hardcoded registered wire
//   string below (the same registered-name-as-local-const idiom as
//   `participant-roster.tsx`'s `presence.read`): the bridge's `CpProcedure`
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
// by-convention at Tier 1; lint will not catch it until a renderer-targeted
// entry lands at the Plan-023 Tier 8 hoist, per the SessionBootstrap header.)

import { useEffect, useState } from "react";

import type {
  RuntimeNodeRosterEntry,
  RuntimeNodeRosterResponse,
  SessionId,
  Unsubscribe,
  VersionFloorExceededCode,
  VersionFloorExceededError,
} from "@ai-sidekicks/contracts";

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
// api-payload-contracts.md:562 (`query`, control-plane tRPC ONLY — the
// namespace's first and only query; its four siblings are mutations), served
// by `AttachService.readRoster` via the router's first `.query()`
// (runtime-node-router.factory.ts:268-287). Hardcoded as a local `const` per
// the shipped renderer idiom (`participant-roster.tsx`'s
// `PRESENCE_READ_METHOD`): the bridge surface is generic, so the registered
// name is the single greppable coupling point the Plan-023 Tier 8 IPC wiring
// binds. The name lives in the `runtimenode.*` METHOD namespace
// (error.ts:106-109 — the namespace deliberately uses no separator, distinct
// from the `runtime_node.*` EVENT names). The response is typed end-to-end via
// the imported `RuntimeNodeRosterResponse` DTO on the `readRoster` cast below.
const ROSTER_READ_PROCEDURE = "runtimenode.roster";

// `runtime_node.online` — one of the 7 registered `runtime_node.*` lifecycle
// event names (runtime-node.ts:693-709), and one of the 5 daemon-reachable V1
// producers (`registered`, `online`, `offline`, `capability_declared`,
// `capability_updated` — runtime-node.ts:715-722; `degraded`/`revoked` are
// V1.1-gated server-derived events with no V1 author). We subscribe to the
// liveness-transition signal and treat each push as an OPAQUE "node state
// changed" trigger to re-read the snapshot — we do NOT decode the payload
// (same change-signal posture as participant-roster's `PresenceUpdate`).
// `online` is the canonical liveness-transition event for AC2's health
// distinguishability; the Tier-8 wiring may broaden the subscription to the
// full `runtime_node.*` family once the bridge's `DaemonEvent` brand narrows
// to the event union (Plan-007) and the subscribe surface carries
// per-subscription params (the DECIDED bridge-shape gap documented on
// participant-roster).
const RUNTIME_NODE_ONLINE_EVENT = "runtime_node.online";

// `VERSION_FLOOR_EXCEEDED_WIRE_CODE` — the canonical wire code for the
// below-floor refusal (ADR-018 §Decision #10), single-sourced in contracts as
// `NEGOTIATION_REASON_FLOOR_EXCEEDED` (the plain `as const` literal at
// jsonrpc-negotiation.ts:211) and aliased as the `VersionFloorExceededCode`
// type (error.ts:96-98). The type annotation is the load-bearing part:
// annotating this local literal with the imported `VersionFloorExceededCode`
// binds it to the contracts literal AT COMPILE TIME — if the canonical code
// ever drifts, this line becomes a type error rather than the below-floor
// recognizer below silently ceasing to match (which would demote below-floor
// rejections to the generic error envelope and lose the AC2 below-floor
// labeling unflagged, since a type predicate's body is an unchecked
// assertion). The binding costs nothing at runtime — `import type` plus a
// type-annotated local literal emit no JS import — so the file stays
// type-only from `@ai-sidekicks/contracts` (the shipped renderer-precedent
// posture).
const VERSION_FLOOR_EXCEEDED_WIRE_CODE: VersionFloorExceededCode = "version.floor_exceeded";

/**
 * Props for {@link NodeRoster}.
 *
 * `sessionId` is the branded {@link SessionId} of the session whose node roster
 * to render. It matches `RuntimeNodeRosterRequest.sessionId`
 * (runtime-node.ts:538-540), so `{ sessionId }` constructs a valid roster-read
 * request with no cast. The roster read is scoped to this id, and the roster
 * NEVER mutates it — adding nodes changes the rendered set, not the session
 * identity (AC3). The id arrives as a prop (supplied by a future Plan-023
 * router/deep-link; exercised by the T5.4 manual smoke), not from
 * renderer-side discovery — the same prop-contract posture as
 * `ParticipantRoster`.
 */
export interface NodeRosterProps {
  sessionId: SessionId;
}

// Discriminated-union view state — identical three-state shape to
// `ParticipantRoster`'s `RosterState`. Mount-triggered, so it STARTS in
// `loading` (the read fires on mount; there is no button). Each variant maps
// 1:1 to a rendered `<section>` branch below, so the render is a total
// function over the union. The `loaded` variant carries the verbatim
// `RuntimeNodeRosterEntry[]` set from the read — the SHIPPED T5.0b wire DTO
// (runtime-node.ts:560-570), not a local view-model — so the render binds to
// the real contract axes by construction.
//
// No-flicker contract (same as participant-roster): `loading` is set in only
// two RENDER-PHASE places — the `useState` initializer (MOUNT) and the
// `previousSessionId` guard (every `sessionId` CHANGE). It is NOT set on a
// same-session subscribe-triggered re-read: `refreshSnapshot` setStates ONLY
// to `loaded`/`error`, so a live-health re-read updates the node set IN PLACE
// and never flashes back to the loading branch.
type RosterViewState =
  | { kind: "loading" }
  | { kind: "loaded"; nodes: RuntimeNodeRosterEntry[] }
  | { kind: "error"; error: Error };

// Below-floor rejection envelope — the load-bearing consumption of the
// `VersionFloorExceededError` contract (contract_consumes). `Pick` keeps the
// recognizer HONEST about what the read path actually delivers: the full
// `VersionFloorExceededError` (error.ts:332-336) requires
// `details: VersionBoundExceededDetails` — the TWO-sided HTTP `ErrorResponse`
// shape — but the runtime-node refusal surface is code+message-only (the
// one-sided session floor cannot populate `acceptedRange`; the SDK applies the
// identical reasoning when it declines to validate against the two-sided
// schema, runtimeNodeClient.ts:312-318), and the SDK's
// `RuntimeNodeControlPlaneError` (runtimeNodeClient.ts:320-332) — the rejection
// shape a Tier-8 bridge wired through the SDK would surface here — likewise
// carries no `details`: only `code` + `message` (plus a transport-level
// `httpStatus`). Narrowing to the full interface while checking two fields
// would let a future reader dereference `.details` with the type system's
// blessing and crash on the real envelope; the `Pick` makes that
// unrepresentable while still typing both discriminants off the shipped
// contract (`code` stays the single-sourced `VersionFloorExceededCode`
// literal).
type VersionFloorRejectionEnvelope = Pick<VersionFloorExceededError, "code" | "message">;

// Below-floor recognizer. The wire code `version.floor_exceeded` is the typed
// verdict a below-floor node's WRITE attempt returns (VERSION_FLOOR_EXCEEDED,
// ADR-018 §Decision #4 / I-003-1) — it is the contract the roster's
// `readOnly: true` axis PROJECTS (a `readOnly` row is exactly a node whose
// writes would yield this envelope). This `is`-narrowing helper types such an
// envelope structurally, by its `code` + `message` discriminants: the guard
// inspects shape, not identity, so it matches a plain wire envelope and an
// `Error` subclass carrying the code (the SDK's
// `RuntimeNodeControlPlaneError`) alike. Discharging the `code` discriminant
// by `===` equality is SOUND here precisely because
// `VersionFloorExceededCode` is a plain single-sourced string-literal type,
// NOT a nominal brand (contrast the branded `SessionId` above, which no
// structural check could discharge) — and the compared literal is the
// type-annotated `VERSION_FLOOR_EXCEEDED_WIRE_CODE` const, so the comparison
// is compile-time-bound to the contracts literal rather than free-floating
// (see the const's comment). Everything stays type-only from
// `@ai-sidekicks/contracts` — no value import, nothing emitted at runtime —
// matching the shipped renderer precedents (participant-roster /
// SessionBootstrap import `type` ONLY). The recognizer lets the error branch
// label a below-floor rejection surfaced on the roster read as the distinct
// below-floor cause rather than a generic failure — the read-path reflection
// of AC2's at-floor vs below-floor distinguishability.
function isVersionFloorExceededRejection(value: unknown): value is VersionFloorRejectionEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    candidate.code === VERSION_FLOOR_EXCEEDED_WIRE_CODE && typeof candidate.message === "string"
  );
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
export function NodeRoster({ sessionId }: NodeRosterProps): React.JSX.Element {
  const [rosterViewState, setRosterViewState] = useState<RosterViewState>({ kind: "loading" });

  // Session-identity prop reset (React's "Adjusting some state when a prop
  // changes" pattern — the SAME render-phase mechanism `ParticipantRoster`
  // uses). On a `sessionId` change it resets to `loading` render-phase (BEFORE
  // commit), so a future Plan-023 router reusing this instance across sessions
  // never paints the prior session's `loaded` roster for a frame. It touches
  // ONLY `rosterViewState`; the effect-scoped guards re-init inside the
  // effect, which re-runs on the same `[sessionId]` change. The complete fix
  // for instance reuse is the Tier-8 parent keying the roster per session
  // (`key={sessionId}`); this render-phase reset is the narrower fallback
  // until that keying lands.
  const [previousSessionId, setPreviousSessionId] = useState(sessionId);
  if (sessionId !== previousSessionId) {
    setPreviousSessionId(sessionId);
    setRosterViewState({ kind: "loading" });
  }

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

    // `CpProcedure` brand cast (Plan-002/Plan-008 follow-up), tightened to the
    // real types — the control-plane analog of the `DaemonMethod` brand cast
    // in participant-roster. The bridge declares
    // `controlPlane.call<P extends CpProcedure>(procedure: P, input: CpInput<P>):
    // Promise<CpOutput<P>>` where `CpProcedure` is a `never`-shaped brand at
    // Tier 1 (desktop-bridge.ts:99) — no string literal is structurally
    // assignable to it until the control-plane tRPC surface narrows the brand
    // to the real procedure union. The procedure-name string stays loosely
    // `string` (the genuinely untypeable part), but we PIN input →
    // `{ sessionId: SessionId }` (the `RuntimeNodeRosterRequest` wire shape,
    // runtime-node.ts:538-540, built from the branded prop) and return →
    // `Promise<RuntimeNodeRosterResponse>` (the SHIPPED T5.0b response DTO —
    // no local view-model), so the request object is type-checked at the call
    // site and the resolved value needs no downstream cast. Same
    // single-documented-cast posture as participant-roster's `readPresence`
    // (an improvement over `SessionBootstrap`'s loose `unknown`/`unknown`).
    const readRoster = window.sidekicks.controlPlane.call as (
      procedure: string,
      input: { sessionId: SessionId },
    ) => Promise<RuntimeNodeRosterResponse>;

    // `DaemonEvent` brand cast (Plan-007 follow-up), same posture as
    // participant-roster's `subscribePresence`. The bridge declares
    // `daemon.subscribe<E extends DaemonEvent>(event: E, handler: (payload:
    // DaemonEventPayload<E>) => void): Unsubscribe` where `DaemonEvent` is a
    // `never`-shaped brand (desktop-bridge.ts:81) and `DaemonEventPayload<E>`
    // is `unknown` (desktop-bridge.ts:87). We pin the event name to `string`
    // (the untypeable part) and the handler payload to `unknown` — we do NOT
    // decode it (it is an opaque change-signal; see the header), so a tighter
    // payload type would be a fiction here. This single brand bypass lifts
    // when Plan-007 lands the narrowed `DaemonEvent` union + event-to-payload
    // map.
    const subscribeNodeHealth = window.sidekicks.daemon.subscribe as (
      event: string,
      handler: (payload: unknown) => void,
    ) => Unsubscribe;

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
          const rosterResponse = await readRoster(ROSTER_READ_PROCEDURE, { sessionId });
          if (cancelled || requestSequence !== latestRequestSequence) return;
          // No cast — the tightened brand cast above already types the
          // resolved value as the shipped `RuntimeNodeRosterResponse`. The
          // full node set is rendered (admit-not-eject, I-003-1): no
          // `.filter(...)` drops a node by `state`, `healthState`, or
          // `readOnly`.
          setRosterViewState({ kind: "loaded", nodes: rosterResponse.nodes });
        } catch (bridgeError: unknown) {
          if (cancelled || requestSequence !== latestRequestSequence) return;
          // Tier-3 production branch: at Tier 1 every bridge method throws
          // `NotImplementedAtTier1Error` (desktop-bridge.ts
          // `createTier1Bridge`), so this is the production-observable path
          // until Plan-023 Tier 8 wires the real IPC handler onto the shipped
          // SDK arm. We do not narrow on `instanceof` for the render decision
          // — any `Error` shape renders the same envelope; non-`Error`
          // rejections are wrapped so the render branch always holds a real
          // `Error`. We DO recognize a below-floor rejection (the typed
          // `VersionFloorExceededError` contract) to LABEL its cause
          // distinctly: a `readOnly` node's writes would return that envelope,
          // so surfacing the below-floor cause on the read path is the read
          // reflection of AC2's at-floor vs below-floor distinguishability. A
          // re-read failure flips the whole roster to `error` (the Tier-3
          // posture, matching the initial-read failure); a resilient "keep
          // last snapshot" is a Tier-8 polish, not a Tier-3 requirement.
          const normalizedError = normalizeRosterReadError(bridgeError);
          setRosterViewState({ kind: "error", error: normalizedError });
        }
      })();
    };

    // 1. Subscribe to the change-signal stream FIRST, BEFORE the initial read
    //    (same ordering rationale as participant-roster: a change landing
    //    after the snapshot but before the subscription installs would
    //    otherwise be lost). The synchronous `subscribeNodeHealth(...)` call
    //    gets its OWN `try/catch` because at Tier 1 it throws synchronously
    //    (`() => tier1Throw("daemon.subscribe")`, desktop-bridge.ts:350); an
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
      unsubscribe = subscribeNodeHealth(RUNTIME_NODE_ONLINE_EVENT, () => {
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
        setRosterViewState({ kind: "error", error: normalizeRosterReadError(subscribeError) });
      }
    }

    return () => {
      cancelled = true;
      // Idempotent per the `Unsubscribe` contract (desktop-bridge.ts:115-118);
      // `?.()` no-ops when the Tier-1 subscribe threw before assigning.
      unsubscribe?.();
    };
    // `[sessionId]` (not `[]`): the effect reads and subscribes for a specific
    // session, so changing the prop must tear down the old subscription and
    // re-run for the new one. `SessionId` is a string brand, so referential
    // equality holds and the effect does not re-run on unrelated re-renders.
  }, [sessionId]);

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
    // facets — the two HEALTH axes verbatim (never-mask, Spec-003 line 72)
    // plus the permission verdict:
    //   • slot `state` — `online` vs `degraded`/`offline`/`registering`/
    //     `revoked` (AC2 + line 76 capability-degraded distinguishability).
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
    // `data-read-only` expose the facets for the T5.4 manual smoke (and future
    // automated coverage per BL-131) to assert distinguishability without
    // scraping prose. `data-health-state` is ABSENT exactly when the wire
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

// Normalizes a roster-read (or subscribe) rejection into a render-ready
// `Error`. Hoisted out of the effect so both the read `catch` and the
// subscribe `catch` share one normalization, and so the below-floor recognizer
// (`isVersionFloorExceededRejection`) is applied consistently to both paths.
//
//   • A below-floor `version.floor_exceeded` envelope (the typed
//     `VersionFloorExceededError` contract, matched on its code+message
//     discriminants) is surfaced with its below-floor cause made explicit —
//     the read-path reflection of AC2's at-floor vs below-floor
//     distinguishability. The envelope may be a plain wire object OR an
//     `Error` subclass carrying the code (the SDK's
//     `RuntimeNodeControlPlaneError` shape); either way we build a fresh
//     `Error` carrying its `message` with the wire `code` as `Error.name`, so
//     the rendered envelope shows `version.floor_exceeded: …` rather than a
//     generic `Error: …`.
//   • Any other `Error` is passed through unchanged (the generic Tier-1
//     `NotImplementedAtTier1Error` is the production-observable case today).
//   • A non-`Error`, non-envelope rejection is wrapped via `String(...)` so
//     the render branch always holds a real `Error` instance.
function normalizeRosterReadError(rejection: unknown): Error {
  if (isVersionFloorExceededRejection(rejection)) {
    const belowFloorError = new Error(rejection.message);
    belowFloorError.name = rejection.code;
    return belowFloorError;
  }
  return rejection instanceof Error ? rejection : new Error(String(rejection));
}
