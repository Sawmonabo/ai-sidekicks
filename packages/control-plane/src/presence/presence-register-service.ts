// PresenceRegisterService — Plan-002 Phase 3 (T3.1 in-memory Yjs Awareness
// ingest; T3.2 cross-node LISTEN/NOTIFY fan-out + reconnect-grace timer).
//
// Responsibilities (T3.1 + T3.2):
//   * recordHeartbeat — ingest a `PresenceHeartbeat` into the in-memory Yjs
//     Awareness CRDT (I-002-3). Each (session, participant, device) tuple gets
//     its own `Y.Doc` + `Awareness` instance whose LOCAL state holds that
//     client's presence; subsequent heartbeats from the same tuple update that
//     same local state in place. NO SQLite or Postgres write occurs — the live
//     CRDT state lives in memory only (Spec-002 §Default Behavior line 58,
//     §State And Data Implications line 157, Plan-002 §Invariants I-002-3).
//     T3.2: each local heartbeat ALSO serializes the client's Awareness slot
//     and publishes it on the cross-node fan-out (so peer nodes see this
//     participant), and (re)arms the reconnect-grace timer for that client.
//   * readPresence — project the live in-memory Awareness state for a session
//     (local holders) PLUS the decoded peer-origin state (fan-out receivers)
//     into the `PresenceReadResponse` wire shape (one entry per participant).
//   * #onFanoutMessage (T3.2 receive path; applies the y-protocols
//     `applyAwarenessUpdate` internally) — decode a peer node's serialized
//     Awareness update, FULLY revalidate every projected field (first path
//     admitting foreign-written state — see §FOREIGN-WRITER HARDENING below),
//     and store the validated state as a peer holder so the participant
//     surfaces on this node's `readPresence`. NEVER persisted.
//   * forgetClient / destroy — explicit GC. `forgetClient` releases one
//     (session, participant, device) tuple (local OR peer) and clears its
//     grace timer; `destroy` releases EVERY tracked client and unsubscribes
//     from the fan-out (leak-free shutdown).
//
// Why Yjs Awareness, not a plain Map (I-002-3 is explicit about the CRDT):
//   Plan-002 line 118 mandates "Use Yjs Awareness (`y-protocols/awareness`) as
//   the presence CRDT" and I-002-3 names the "Yjs Awareness CRDT" as the live
//   surface. A `y-protocols/awareness` `Awareness` instance is fundamentally a
//   SINGLE-local-client holder: it borrows one numeric `clientID` from its
//   backing `Y.Doc`, and `setLocalState(...)` mutates only THAT client's slot
//   (`getStates()` maps `clientID -> state`). To aggregate MANY participants on
//   the server we therefore hold ONE `Awareness` per LOCALLY-connected
//   client-device (Shape B), where each instance's local state IS that
//   participant-device's presence. This is the only CRDT-faithful server-side
//   shape — a single shared `Awareness` could only ever carry one local
//   client's state — and it lines up directly with the T3.2 cross-node fan-out,
//   which serializes a client's slot via
//   `encodeAwarenessUpdate(awareness, [doc.clientID])` from the same
//   y-protocols module.
//
// ----------------------------------------------------------------------------
// T3.2 cross-node fan-out — what crosses the wire, and where it does NOT land
// ----------------------------------------------------------------------------
//
//   * The fan-out payload is the SERIALIZED Awareness update
//     (`encodeAwarenessUpdate(awareness, [doc.clientID])`), applied on peers
//     via `applyAwarenessUpdate`. It is EPHEMERAL CRDT state, NEVER a persisted
//     presence row (I-002-3). The production transport is Postgres
//     `LISTEN/NOTIFY` (ADR-008, Spec-002 line 61) over a transient CHANNEL name
//     (`presence_fanout`) — NOT a row in any table. There is NO
//     `INSERT INTO presence_*` anywhere; the only Postgres surface this service
//     touches is the NOTIFY channel, which carries bytes, not rows.
//   * Postgres NOTIFY has an 8000-byte payload limit. A single-client Awareness
//     update base64-encodes to ~540 bytes (measured), far under the cap, so the
//     common path never approaches it. As defense-in-depth, `publish` on the
//     production transport drops (with a structured warning) any payload that
//     would exceed `NOTIFY_PAYLOAD_SAFETY_LIMIT` rather than fragmenting —
//     fragment reassembly is exactly the ordering/state machinery presence
//     should not own. A dropped update degrades gracefully: the next 15s
//     heartbeat re-publishes.
//   * The transport is abstracted behind the `PresencePubSub` seam (mirrors the
//     constructor-injected `Querier` precedent in `migration-runner.ts`): an
//     in-memory fake drives the cross-node unit tests (two in-process PGlite
//     instances are SEPARATE databases and cannot share NOTIFY, and `LISTEN`
//     needs a long-lived dedicated connection that the one-shot `Querier`
//     checkout does not model), while `PgListenNotifyPubSub` wires the real
//     `pg` `LISTEN/NOTIFY`. With no `pubSub` injected, the service runs
//     single-node (fan-out is a no-op) — exactly T3.1 behavior.
//
// ----------------------------------------------------------------------------
// T3.2 cross-node recency tiebreak — `ingestSequence` SCOPED to same-origin
// ----------------------------------------------------------------------------
//
//   `readPresence` collapses a participant's devices to the single device that
//   represents them. T3.1 ordered devices by `(lastSeenAtMs, ingestSequence)`:
//   `lastSeenAtMs` (server-clock receipt time) is the primary key, and the
//   per-NODE monotonic `ingestSequence` broke same-millisecond ties so the
//   newest-INGESTED device won deterministically. That is correct ONLY while
//   the devices being compared were ingested by the SAME node — across nodes
//   the sequences are drawn from disjoint counter spaces and are not comparable.
//
//   The fan-out introduces peer state from OTHER nodes, so T3.2 makes the
//   tiebreak a three-level cascade that consults `ingestSequence` ONLY within a
//   single origin node (see `isMoreRecent`):
//     1. `lastSeenAtMs` differs            → greater wins (most-recently-heard).
//     2. same `lastSeenAtMs`, same origin  → greater `ingestSequence` wins.
//        Preserves T3.1's "newest-ingested device wins" same-tick contract for
//        a node's own devices (`lastSeenAtMs` has only ms resolution, so two
//        heartbeats in one tick tie on the clock).
//     3. same `lastSeenAtMs`, diff origin  → greater `originNodeId` wins. A
//        deterministic, order-independent cross-node tiebreak that NEVER
//        compares two nodes' disjoint sequence spaces (distinct nodes always
//        have distinct ids, so `originNodeId` alone is already total).
//
//   This is the "scope the sequence comparison to local-origin clients" option:
//   `ingestSequence` stays meaningful where it is meaningful (same node) and is
//   never consulted where it is meaningless (across nodes). A hybrid logical
//   clock was considered and rejected as overkill — presence tolerates the
//   documented cross-node clock-skew caveat (below), and the node-id/device-id
//   tiebreak resolves cross-node same-ms ambiguity without clock bookkeeping.
//
//   CLOCK-SKEW CAVEAT (documented, accepted): `lastSeenAtMs` is each ORIGIN
//   node's server clock. Comparing it across nodes assumes loosely-synchronized
//   server clocks (NTP-grade) — a pre-existing limitation, since T3.1 already
//   serializes `lastSeenAtMs` as the wire `lastSeen`. Presence is advisory, not
//   an ordering authority, so bounded skew is acceptable.
//
//   PEER-SLOT ORDERING CAVEAT (documented, accepted): peer state is stored as a
//   decoded `PresenceLocalState` snapshot (not a live per-peer Awareness), so
//   it does NOT carry Awareness's built-in clock-based last-writer-wins for the
//   SAME source device. If two NOTIFY messages from one source device arrived
//   out of publish-order, the later-arriving (older) snapshot would overwrite
//   the newer. In practice Postgres `LISTEN/NOTIFY` preserves per-connection
//   commit order, so single-source out-of-order delivery does not occur on the
//   production transport. Storing decoded snapshots (rather than one live
//   Awareness per remote device) is the deliberate choice: a live Awareness per
//   peer device would spin up an unbounded number of `Y.Doc` + `Awareness`
//   pairs, each with its own 30s `_checkInterval` — a real per-device timer/
//   memory cost. The CRDT round-trip that I-002-3 and the "uses Yjs Awareness"
//   test pin is still exercised: the origin serializes via
//   `encodeAwarenessUpdate` and the receiver applies via `applyAwarenessUpdate`
//   into a scratch Awareness before extracting the snapshot.
//
// ----------------------------------------------------------------------------
// FOREIGN-WRITER HARDENING (T3.2) — full revalidation on the receive path
// ----------------------------------------------------------------------------
//
//   T3.1's `readLocalState` typeof-checked only 5 discriminator fields and did
//   NOT assert `state` against the 4-value enum, justified because the only
//   writer was the local well-typed `recordHeartbeat`. T3.2's
//   `applyAwarenessUpdate` is the FIRST path admitting state written by a
//   FOREIGN node, so full revalidation is now mandatory and lives in
//   `validatePresenceLocalState`: every field is typeof-checked AND `state` is
//   asserted to be a member of the canonical `PresenceState` enum. A malformed
//   peer update (e.g. an out-of-enum `state`, a missing field, a wrong type) is
//   REJECTED — the offending client is not stored and does not surface on this
//   node's projection — rather than projected as corrupt state.
//
// ----------------------------------------------------------------------------
// T3.3 emission seam (T3.2 produces the transitions; T3.3 emits them durably)
// ----------------------------------------------------------------------------
//
//   The reconnect-grace timer drives `reconnecting` and `offline` transitions
//   for LOCAL clients. T3.3 (next task) emits those as durable `session_events`
//   (`presence.reconnecting` / `presence.offline`) on the Plan-006 path. T3.2
//   exposes a minimal observation seam — the optional `onTransition` callback
//   in the options — so T3.3 can hook emission WITHOUT T3.2 itself adding any
//   durable storage. A callback (not an EventEmitter field) is the right shape:
//   there is exactly one consumer, and a callback is trivially injectable/
//   mockable. T3.2 MUST NOT emit durable events and MUST NOT add durable
//   storage (I-002-3).
//
// ----------------------------------------------------------------------------
// Cross-plan / cross-task boundaries (DO NOT CROSS)
// ----------------------------------------------------------------------------
//
//   * No durable presence storage. This service writes NO presence ROW to
//     SQLite or Postgres — that is the load-bearing I-002-3 property (the Pr1
//     regression tests pin it: the service takes no `Querier`/`Pool` presence
//     store, and no presence-state table exists in the schema). The ONLY
//     Postgres surface T3.2 touches is the transient `LISTEN/NOTIFY` channel
//     (ephemeral bytes, not rows). Audit-relevant presence transitions
//     (`presence.online/idle/reconnecting/offline`) are emitted as
//     `session_events` later (T3.3) via the `onTransition` seam; that event
//     log — not this live CRDT — is the durable surface.
//   * No wire/transport layer for the JSON-RPC `PresenceUpdate` push or the
//     `PresenceRead` RPC binding — those are downstream (Plan-007-partial
//     substrate + T3.3); this service is the in-process ingest/query/fan-out
//     core.
//
// Refs: Spec-002 §Default Behavior (lines 57, 58, 61), §Fallback Behavior
// (line 73), §State And Data Implications (line 157); Plan-002 §Phase 3,
// §Invariants I-002-3; ADR-008 (presence transport — Postgres LISTEN/NOTIFY);
// docs/architecture/contracts/api-payload-contracts.md §Tier 2 — Plan-002
// (PresenceHeartbeat / PresenceUpdate / PresenceRead wire forms).

import type {
  ParticipantId,
  PresenceHeartbeat,
  PresenceReadResponse,
  PresenceReadResponseParticipant,
  PresenceState,
  SessionId,
} from "@ai-sidekicks/contracts";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

// --------------------------------------------------------------------------
// Reconnect-grace timing — defaults per Spec-002 line 57.
// --------------------------------------------------------------------------
//
// Spec-002 line 57: "Presence heartbeat default interval is 15s, with a
// reconnect grace window of 45s before offline." Read as a TWO-threshold
// machine (the brief's restated AC — "missed heartbeat moves a participant to
// reconnecting before offline (45s grace window)" — favors this reading):
//
//   active/online/idle --(15s no heartbeat)--> reconnecting
//                      --(45s total no heartbeat)--> offline
//
// i.e. `reconnecting` fires at the first missed heartbeat interval (15s after
// the last heartbeat), and `offline` fires at the full 45s grace window from
// the last heartbeat. Both thresholds are configurable via
// `PresenceRegisterServiceOptions`; these are the spec defaults. They live HERE
// (not in T3.1) because the timer that consumes them is T3.2's — defining them
// in T3.1 would have been dead surface.
const DEFAULT_RECONNECTING_AFTER_MS = 15_000;
const DEFAULT_OFFLINE_AFTER_MS = 45_000;

// Postgres NOTIFY hard limit is 8000 bytes; the production transport drops
// (with a warning) any payload exceeding this safety floor rather than
// fragmenting. A single-client Awareness update base64-encodes to ~540 bytes
// (measured), so this is purely defense-in-depth — see the file header.
const NOTIFY_PAYLOAD_SAFETY_LIMIT = 7_000;

// Production LISTEN/NOTIFY channel name. A transient Postgres channel — NOT a
// table — so nothing about the fan-out is durable (I-002-3).
const PRESENCE_FANOUT_CHANNEL = "presence_fanout";

// --------------------------------------------------------------------------
// Offline-degradation ordering — the grace machine's forward-only progression.
// --------------------------------------------------------------------------
//
// The reconnect-grace timer (Pr2) moves a client toward offline as heartbeats
// lapse: a LIVE state (online/idle) degrades to `reconnecting` at 15s, then to
// `offline` at 45s. `#transition` consults this rank so a transition is applied
// ONLY when it moves the client strictly FORWARD in degradation — it must never
// bounce a client backward (an explicit `offline` heartbeat is terminal and is
// NOT dragged back to `reconnecting` when the timer fires). online and idle
// share rank 0: they are both "live", and the grace timer treats an idle client
// exactly like an online one (idle is a client-reported activity level, not a
// degradation step).
//
// This `Record<PresenceState, number>` is ALSO the single compile-time
// exhaustiveness tripwire for the state set: a future fifth `PresenceState`
// (added to the contract + spec FIRST, per doc-first ordering) is a TYPE ERROR
// here until it is assigned a rank, with deliberate placement. `PRESENCE_STATES`
// below is derived from its keys, so the two constants can never drift — adding
// a state fails compile in exactly this one place and auto-flows into the
// membership set.
const PRESENCE_PROGRESSION: Record<PresenceState, number> = {
  online: 0,
  idle: 0,
  reconnecting: 1,
  offline: 2,
};

// --------------------------------------------------------------------------
// Canonical PresenceState enum membership — foreign-writer revalidation set.
// --------------------------------------------------------------------------
//
// The canonical states per `@ai-sidekicks/contracts` `PresenceState`
// (presence.ts:121), DERIVED from `PRESENCE_PROGRESSION`'s keys so the two stay
// in lockstep (see the tripwire note above). Held as a runtime Set so the
// receive-path validator can assert enum membership on FOREIGN-written `state`
// (the T3.1 read-back path only typeof-checked `state` as a string). The element
// type stays `string` (not `PresenceState`) because `validatePresenceLocalState`
// calls `.has(state)` on ARBITRARY foreign-input strings — the check must accept
// any string, then narrow.
const PRESENCE_STATES: ReadonlySet<string> = new Set(Object.keys(PRESENCE_PROGRESSION));

// --------------------------------------------------------------------------
// Awareness local-state shape — what each client's CRDT slot carries.
// --------------------------------------------------------------------------
//
// This is the value `setLocalState(...)` writes into the per-client Awareness
// slot and `getStates()` reads back. It mirrors the metadata the heartbeat
// carries (Spec-002 line 84) plus the resolved presence `state` and the
// `originNodeId` of the node that ingested it. T3.2's
// `encodeAwarenessUpdate(awareness, [doc.clientID])` serializes exactly this
// object for cross-node fan-out, so the shape is shared across both the local
// store and the wire.
interface PresenceLocalState {
  readonly participantId: ParticipantId;
  readonly deviceId: string;
  readonly state: PresenceState;
  readonly deviceType: string;
  readonly focusedSessionId: SessionId | null;
  readonly focusedChannelId: ChannelIdOrNull;
  // Server-clock receipt time, NOT the wire `metadata.lastActivityAt`. See
  // `recordHeartbeat` for why the server clock is authoritative for `lastSeen`.
  // Primary key of the cross-node recency tiebreak in `readPresence`.
  readonly lastSeenAtMs: number;
  // The id of the node that INGESTED this heartbeat (the origin). Generated
  // once per service instance (`crypto.randomUUID()` in the constructor) and
  // stamped on every local heartbeat. It travels in the Awareness payload, so
  // a peer node can (a) suppress its OWN updates that round-trip back through
  // the fan-out, and (b) discriminate the cross-node recency tiebreak (a peer
  // device's `ingestSequence` is NOT comparable to ours — see `isMoreRecent`).
  readonly originNodeId: string;
  // Per-NODE monotonic ingest order, stamped from `#ingestSequence`. It is the
  // SAME-NODE, SAME-MILLISECOND recency tiebreaker in `readPresence`:
  // `lastSeenAtMs` has only millisecond resolution, so two heartbeats from one
  // node in the same tick tie on the clock; the strictly-increasing sequence
  // makes "newest-ingested device wins" total and deterministic for that node
  // (the T3.1 projection contract). It is CROSS-NODE-MEANINGLESS — two nodes'
  // sequences are drawn from disjoint counter spaces — so `isMoreRecent`
  // consults it ONLY when `originNodeId` matches; across nodes the deterministic
  // `originNodeId` tiebreak is used instead. It travels in the payload but a
  // peer node never compares a foreign sequence to its own.
  readonly ingestSequence: number;
  // The client-reported "last user interaction" timestamp, preserved verbatim
  // from the wire for downstream consumers (e.g. an idle-detector) that want
  // the activity time distinct from the receipt time.
  readonly lastActivityAt: string;
  readonly appVisible: boolean;
}

// `focusedChannelId` is `ChannelId | null` on the wire; aliased to avoid a
// second `@ai-sidekicks/contracts` import line just for the brand (it is only
// ever stored and projected as-is, never constructed here).
type ChannelIdOrNull = PresenceHeartbeat["metadata"]["focusedChannelId"];

// --------------------------------------------------------------------------
// Per-client holders — local (CRDT-backed) vs peer (decoded snapshot).
// --------------------------------------------------------------------------
//
// A LOCAL client (one this node ingests heartbeats for) holds its own
// `Y.Doc` + `Awareness` (Shape B; see file header). A PEER client (one whose
// state arrived via the cross-node fan-out) holds the decoded, fully-validated
// `PresenceLocalState` snapshot — NOT a live Awareness, for the resource and
// ordering reasons documented in the file header §PEER-SLOT ORDERING CAVEAT.
// Both variants carry an optional grace-timer handle; only LOCAL clients arm a
// grace timer (peer clients are driven by their own origin node's timer and
// surface its transitions through the fan-out).
interface LocalClientPresence {
  readonly origin: "local";
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  // Reconnect-grace timer handle for THIS client; (re)armed on every
  // `recordHeartbeat`, cleared on `forgetClient`/`destroy`. `undefined` until
  // the first heartbeat arms it. Tracked here so teardown is leak-free. Typed
  // with an explicit `| undefined` (not the `?` shorthand) so reassignment to
  // `undefined` is legal under `exactOptionalPropertyTypes`.
  graceTimer: ReturnType<typeof setTimeout> | undefined;
}

interface PeerClientPresence {
  readonly origin: "peer";
  // The decoded, fully-revalidated foreign state. Replaced wholesale on each
  // fan-out receive for this (participant, device) tuple.
  state: PresenceLocalState;
}

type ClientPresence = LocalClientPresence | PeerClientPresence;

// Composite in-memory key for a single connected client-device within a
// session. A participant may be present on multiple devices simultaneously,
// so the device id is part of the key — `readPresence` aggregates per
// participant across that participant's devices (see its docstring).
function clientKey(participantId: ParticipantId, deviceId: string): string {
  // The separator is a literal NUL byte (`\0`). It is collision-free because
  // `wireFreeFormString` (session.ts:118-128) rejects NUL in EVERY wire
  // free-form string via `.refine((s) => !s.includes("\0"))` (line 126), and
  // both operands are so guarded at the wire boundary: `participantId` is a
  // `brandedUuidIdSchema` UUID (session.ts:57) and `deviceId` is
  // `wireFreeFormString(DEVICE_ID_MAX_LEN, ...)` (presence.ts:240). So the
  // separator can never occur inside either field, and the join parses back
  // unambiguously. (Spelled `\0` rather than an inline literal so the byte is
  // visible in source — an invisible NUL here has already misled two readers.)
  return `${participantId}\0${deviceId}`;
}

// --------------------------------------------------------------------------
// Cross-node fan-out seam (T3.2).
// --------------------------------------------------------------------------
//
// A driver-agnostic publish/subscribe interface for cross-node presence
// fan-out, mirroring the constructor-injected `Querier` precedent. The
// production implementation (`PgListenNotifyPubSub`) wires Postgres
// `LISTEN/NOTIFY`; the in-memory implementation (`InMemoryPresencePubSub`) is
// the unit-test substrate (two PGlite instances can't share NOTIFY, and LISTEN
// needs a long-lived dedicated connection the one-shot `Querier` checkout does
// not model). A `PresenceFanoutMessage` carries the serialized Awareness update
// plus the origin node id (for self-suppression and the recency tiebreak).
export interface PresenceFanoutMessage {
  readonly sessionId: SessionId;
  readonly update: Uint8Array;
  readonly originNodeId: string;
}

export interface PresencePubSub {
  // Publish a serialized Awareness update for `sessionId` to all subscribed
  // nodes. MUST NOT throw on transient transport failure — the caller treats
  // publish as best-effort (the next heartbeat re-publishes). Returns a promise
  // that resolves once the publish is dispatched (or dropped/failed silently).
  publish(message: PresenceFanoutMessage): Promise<void>;
  // Subscribe to fan-out messages from ALL nodes (including, on some
  // transports, this node's own publishes — the service suppresses self-origin
  // messages by `originNodeId`). Returns an unsubscribe function.
  subscribe(handler: (message: PresenceFanoutMessage) => void): () => void;
  // Optional resource teardown (close the dedicated LISTEN connection, etc.).
  close?(): Promise<void>;
}

// Observation seam for T3.3 durable-event emission. T3.2 invokes this on every
// timer-driven LOCAL client transition; T3.3 wires it to the Plan-006
// `session_events` append path. T3.2 itself performs NO durable write.
export interface PresenceTransitionEvent {
  readonly sessionId: SessionId;
  readonly participantId: ParticipantId;
  readonly deviceId: string;
  readonly from: PresenceState;
  readonly to: PresenceState;
  readonly at: Date;
}

// --------------------------------------------------------------------------
// Constructor options — T3.2 widens the (T3.1-empty) seam. ALL fields optional
// so existing `new PresenceRegisterService()` call sites stay source-compatible
// (T3.1's inheritance contract).
// --------------------------------------------------------------------------
export interface PresenceRegisterServiceOptions {
  // Cross-node fan-out transport. Absent => single-node mode (fan-out is a
  // no-op), which is exactly T3.1 behavior. Production injects a
  // `PgListenNotifyPubSub`; cross-node tests inject an `InMemoryPresencePubSub`.
  readonly pubSub?: PresencePubSub;
  // This node's identity, stamped on every local heartbeat and used for
  // self-suppression + the recency tiebreak. Defaults to a fresh
  // `crypto.randomUUID()` per service instance. Injectable so tests can assert
  // a deterministic origin and so two test services can be given distinct
  // node ids.
  readonly nodeId?: string;
  // Reconnect-grace timing (Spec-002 line 57 defaults: 15s / 45s). Read as the
  // delay (ms) from the LAST heartbeat to the `reconnecting` and `offline`
  // transitions respectively. `offlineAfterMs` MUST be >= `reconnectingAfterMs`
  // for the two-step machine to be well-ordered.
  readonly reconnectingAfterMs?: number;
  readonly offlineAfterMs?: number;
  // Observation seam for T3.3 durable presence-event emission (see
  // `PresenceTransitionEvent`). Absent => transitions are applied to the live
  // CRDT only (no observer). T3.2 itself never persists.
  readonly onTransition?: (event: PresenceTransitionEvent) => void;
}

export class PresenceRegisterService {
  // Live presence state, in memory ONLY (I-002-3). Keyed session ->
  // clientKey(participant, device) -> ClientPresence (local OR peer). Mutated
  // on `recordHeartbeat` / `#onFanoutMessage` (fan-out receive) /
  // `forgetClient` / the grace timer / `destroy`.
  readonly #sessions: Map<SessionId, Map<string, ClientPresence>> = new Map();

  // This node's identity (see options.nodeId). Generated once; never changes.
  readonly #nodeId: string;

  // Cross-node fan-out transport (undefined => single-node mode).
  readonly #pubSub: PresencePubSub | undefined;

  // Unsubscribe handle for the fan-out subscription; cleared on `destroy`.
  readonly #unsubscribe: (() => void) | undefined;

  readonly #reconnectingAfterMs: number;
  readonly #offlineAfterMs: number;
  readonly #onTransition: ((event: PresenceTransitionEvent) => void) | undefined;

  // Per-NODE monotonic ingest counter. Stamped on every LOCAL heartbeat and
  // used as the same-node, same-millisecond recency tiebreaker in
  // `readPresence` (see `isMoreRecent`). Strictly increasing within this
  // process; intentionally NOT comparable across nodes (each node has its own).
  #ingestSequence: number = 0;

  constructor(options?: PresenceRegisterServiceOptions) {
    this.#nodeId = options?.nodeId ?? crypto.randomUUID();
    this.#pubSub = options?.pubSub;
    this.#reconnectingAfterMs = options?.reconnectingAfterMs ?? DEFAULT_RECONNECTING_AFTER_MS;
    this.#offlineAfterMs = options?.offlineAfterMs ?? DEFAULT_OFFLINE_AFTER_MS;
    this.#onTransition = options?.onTransition;

    // Subscribe to the fan-out (if any) so peer-node presence lands on this
    // node. Self-origin messages are suppressed in the handler.
    this.#unsubscribe = this.#pubSub?.subscribe((message) => {
      this.#onFanoutMessage(message);
    });
  }

  /**
   * Ingest a heartbeat into the in-memory Awareness CRDT for `sessionId`
   * (I-002-3 — no durable write occurs), publish it to peer nodes via the
   * fan-out, and (re)arm this client's reconnect-grace timer.
   *
   * The first heartbeat for a (participant, device) tuple lazily creates that
   * client's `Y.Doc` + `Awareness`; subsequent heartbeats update the same
   * client's local Awareness slot in place via `setLocalState(...)`. All four
   * `PresenceState` values are accepted and stored verbatim — including
   * `"offline"` and `"reconnecting"` — because the wire enum admits them
   * (presence.ts:121) and the ingest path stays total. An explicit `"offline"`
   * heartbeat is stored as-is; the timer-driven lifecycle is independent (it
   * fires only on the ABSENCE of heartbeats, never on a carried state).
   *
   * `lastSeen` provenance: the server captures `Date.now()` at receipt and
   * stores it as `lastSeenAtMs`, rather than trusting the wire
   * `metadata.lastActivityAt`. Two reasons: (a) it defends against client
   * clock skew — a client with a wrong clock cannot forge a future/past
   * last-seen; (b) `lastActivityAt` is semantically "when the user last
   * interacted", which is distinct from "when the server last heard from the
   * client". The wire `lastActivityAt` is still preserved on the stored state.
   *
   * @param sessionId the session this presence belongs to. Presence is scoped
   *   per session (a participant present in two sessions has two independent
   *   Awareness slots).
   * @param heartbeat the validated `PresenceHeartbeat` (boundary validation via
   *   `PresenceHeartbeatSchema` is the transport layer's job; this in-process
   *   core trusts the typed input).
   */
  recordHeartbeat(sessionId: SessionId, heartbeat: PresenceHeartbeat): void {
    const clients: Map<string, ClientPresence> = this.#clientsFor(sessionId);
    const key: string = clientKey(heartbeat.participantId, heartbeat.deviceId);

    // Resolve-or-create a LOCAL holder. If a PEER holder existed for this tuple
    // (a fan-out receive arrived before the local client first heartbeat), the
    // local heartbeat takes authority — replace the peer snapshot with a live
    // local CRDT holder (this node is now the origin for this device).
    let client: ClientPresence | undefined = clients.get(key);
    if (client === undefined || client.origin !== "local") {
      if (client !== undefined && client.origin === "peer") {
        // Drop the superseded peer snapshot; the local holder below replaces it.
        clients.delete(key);
      }
      const doc: Y.Doc = new Y.Doc();
      const awareness: Awareness = newAwareness(doc);
      client = { origin: "local", doc, awareness, graceTimer: undefined };
      clients.set(key, client);
    }

    const localState: PresenceLocalState = {
      participantId: heartbeat.participantId,
      deviceId: heartbeat.deviceId,
      state: heartbeat.activityState,
      deviceType: heartbeat.metadata.deviceType,
      focusedSessionId: heartbeat.metadata.focusedSessionId,
      focusedChannelId: heartbeat.metadata.focusedChannelId,
      lastSeenAtMs: Date.now(),
      originNodeId: this.#nodeId,
      // Strictly-increasing per-node ingest order; the same-node, same-ms
      // recency tiebreak. Pre-increment so the first heartbeat is sequence 1.
      ingestSequence: ++this.#ingestSequence,
      lastActivityAt: heartbeat.metadata.lastActivityAt,
      appVisible: heartbeat.metadata.appVisible,
    };
    // Write into THIS client's Awareness slot. `setLocalState` mutates only the
    // doc's own clientID entry — exactly the single-local-client semantics that
    // make Shape B (one Awareness per client) the correct aggregator.
    client.awareness.setLocalState(localState);

    // (Re)arm the reconnect-grace timer for this client off the fresh
    // heartbeat. A heartbeat arriving within the grace window cancels the
    // pending reconnecting/offline transition (the clear in `#armGraceTimer`).
    this.#armGraceTimer(sessionId, client, heartbeat.participantId, heartbeat.deviceId);

    // Publish to peer nodes (best-effort; never throws into the hot path).
    this.#publish(sessionId, client.awareness, client.doc.clientID);
  }

  /**
   * Project the live in-memory presence for `sessionId` into the
   * `PresenceReadResponse` wire shape (one entry per participant), merging
   * BOTH local holders (read from their Awareness CRDT) and peer holders
   * (decoded snapshots received via the fan-out).
   *
   * Multi-device aggregation: storage is keyed (participant, device), but the
   * contract returns one entry per PARTICIPANT. When a participant has live
   * presence from multiple devices (possibly across nodes), the winner is the
   * device picked by `isMoreRecent` — "most recently heard-from device
   * represents the participant". The tiebreak for same-millisecond
   * `lastSeenAtMs` is a three-level cascade (see file header §cross-node recency
   * tiebreak): per-node `ingestSequence` WITHIN one origin node (preserving
   * T3.1's "newest-ingested device wins"), and a deterministic
   * node-id/device-id tiebreak ACROSS nodes (where the disjoint sequence spaces
   * are never compared).
   *
   * Reads only the live in-memory state; performs no durable read. A session
   * with no live clients yields an empty `participants` array.
   *
   * @param sessionId the session to project.
   * @returns the per-participant presence projection.
   */
  readPresence(sessionId: SessionId): PresenceReadResponse {
    const clients: Map<string, ClientPresence> | undefined = this.#sessions.get(sessionId);
    if (clients === undefined) {
      return { participants: [] };
    }

    // Collapse (participant, device) -> participant, keeping the most-recent
    // device per participant (see `isMoreRecent` for the recency cascade).
    const newestByParticipant: Map<ParticipantId, PresenceLocalState> = new Map();
    for (const client of clients.values()) {
      const local: PresenceLocalState | undefined =
        client.origin === "local"
          ? validatePresenceLocalState(client.awareness.getLocalState())
          : client.state;
      if (local === undefined) {
        // A local client whose slot was cleared (e.g. set to null) contributes
        // nothing; peer holders always carry a validated snapshot.
        continue;
      }
      const existing: PresenceLocalState | undefined = newestByParticipant.get(local.participantId);
      if (existing === undefined || isMoreRecent(local, existing)) {
        newestByParticipant.set(local.participantId, local);
      }
    }

    const participants: PresenceReadResponseParticipant[] = [];
    for (const local of newestByParticipant.values()) {
      participants.push({
        participantId: local.participantId,
        state: local.state,
        lastSeen: new Date(local.lastSeenAtMs).toISOString(),
      });
    }
    return { participants };
  }

  /**
   * The number of sessions this node currently holds live presence for — an
   * operability gauge (how many session maps are resident in memory).
   *
   * Also the introspection seam that pins the `#onFanoutMessage` empty-map
   * reclaim: an empty session map and a deleted one are observationally
   * identical via `readPresence` (both yield an empty `participants`), so a
   * leak of all-rejected/all-suppressed fan-out sessions has NO black-box
   * symptom — this gauge is the only way to assert the reclaim fired.
   *
   * @returns the count of sessions with at least one tracked client-device.
   */
  trackedSessionCount(): number {
    return this.#sessions.size;
  }

  /**
   * Garbage-collect a single (session, participant, device) client's live
   * presence — the explicit hard-disconnect entry point. Handles BOTH local
   * (CRDT-backed) and peer (snapshot) holders.
   *
   * For a local holder: clears the client's Awareness slot
   * (`setLocalState(null)`), clears its grace timer, then destroys the
   * `Awareness` and its backing `Y.Doc`. For a peer holder: drops the snapshot.
   * In both cases the map entry is removed; an emptied session map is removed
   * too so a churned session leaves no residual key.
   *
   * @param sessionId the session the client belonged to.
   * @param participantId the disconnecting participant.
   * @param deviceId the specific device that disconnected.
   * @returns `true` if a client was found and removed; `false` if no such
   *   client was tracked.
   */
  forgetClient(sessionId: SessionId, participantId: ParticipantId, deviceId: string): boolean {
    const clients: Map<string, ClientPresence> | undefined = this.#sessions.get(sessionId);
    if (clients === undefined) {
      return false;
    }
    const key: string = clientKey(participantId, deviceId);
    const client: ClientPresence | undefined = clients.get(key);
    if (client === undefined) {
      return false;
    }
    this.#teardownClient(client);
    clients.delete(key);
    if (clients.size === 0) {
      this.#sessions.delete(sessionId);
    }
    return true;
  }

  /**
   * Release EVERY tracked client across all sessions and unsubscribe from the
   * cross-node fan-out — leak-free shutdown. Clears every grace timer, destroys
   * every local Awareness/Y.Doc, drops every peer snapshot, and closes the
   * transport if it exposes `close()`. After `destroy()` the service holds no
   * timers and no CRDT instances.
   *
   * Returns a promise so callers can await transport teardown; the in-memory
   * state is released synchronously before the (optional) async close.
   */
  async destroy(): Promise<void> {
    for (const clients of this.#sessions.values()) {
      for (const client of clients.values()) {
        this.#teardownClient(client);
      }
      clients.clear();
    }
    this.#sessions.clear();
    this.#unsubscribe?.();
    if (this.#pubSub?.close !== undefined) {
      await this.#pubSub.close();
    }
  }

  // ------------------------------------------------------------------------
  // Internal — fan-out receive path.
  // ------------------------------------------------------------------------

  /**
   * Handle one cross-node fan-out message: suppress self-origin, decode the
   * serialized Awareness update into a scratch Awareness, FULLY revalidate each
   * foreign client state, and store the validated snapshot as a peer holder so
   * the participant surfaces on this node's `readPresence`.
   *
   * Self-suppression: a transport may echo this node's own publishes back
   * (`InMemoryPresencePubSub` does, and a shared Postgres NOTIFY channel does
   * too). Applying our own update would be a no-op at best and could re-stamp a
   * stale snapshot at worst — so we drop any message whose `originNodeId`
   * matches ours.
   */
  #onFanoutMessage(message: PresenceFanoutMessage): void {
    if (message.originNodeId === this.#nodeId) {
      return; // self-origin echo — already authoritative locally.
    }

    // Decode into a SCRATCH Awareness whose own slot is never set (so its empty
    // self-slot is filterable). This is the y-protocols `applyAwarenessUpdate`
    // receive path the cross-node fan-out is built on.
    const scratchDoc: Y.Doc = new Y.Doc();
    const scratch: Awareness = newAwareness(scratchDoc);
    try {
      applyAwarenessUpdate(scratch, message.update, "fanout");
    } catch {
      // A malformed/corrupt binary update that the CRDT decoder rejects is
      // dropped wholesale — it cannot contribute valid presence.
      teardownAwareness(scratch, scratchDoc);
      return;
    }

    const clients: Map<string, ClientPresence> = this.#clientsFor(message.sessionId);
    for (const [clientId, rawState] of scratch.getStates()) {
      if (clientId === scratchDoc.clientID) {
        continue; // scratch's own empty slot — never a foreign client.
      }
      // FULL foreign-writer revalidation (see file header §FOREIGN-WRITER
      // HARDENING): every field typeof-checked AND `state` asserted against the
      // canonical enum. A malformed peer state is REJECTED, not projected.
      const validated: PresenceLocalState | undefined = validatePresenceLocalState(rawState);
      if (validated === undefined) {
        continue;
      }
      // Ignore a peer echo of OUR OWN node's state (defense-in-depth beyond the
      // message-level self-suppression above — e.g. a relayed multi-hop echo).
      if (validated.originNodeId === this.#nodeId) {
        continue;
      }

      const key: string = clientKey(validated.participantId, validated.deviceId);
      const existing: ClientPresence | undefined = clients.get(key);
      if (existing !== undefined && existing.origin === "local") {
        // A live LOCAL holder for this exact tuple outranks a peer snapshot
        // (this node is the authoritative origin for a device it ingests).
        continue;
      }
      const peer: PeerClientPresence = { origin: "peer", state: validated };
      clients.set(key, peer);
    }

    // Reclaim the session map if NO holder survived (all states rejected by the
    // foreign-writer revalidation, all self-origin, or all outranked by a live
    // local holder). `#clientsFor` above get-or-creates and unconditionally
    // inserts an empty `Map`; without this, a peer publishing malformed-only or
    // all-suppressed states across many distinct, never-seen session ids would
    // grow `#sessions` unbounded — a memory-exhaustion vector from the foreign-
    // writer surface this path hardens. Mirrors the `forgetClient` reclaim.
    if (clients.size === 0) {
      this.#sessions.delete(message.sessionId);
    }

    teardownAwareness(scratch, scratchDoc);
  }

  // ------------------------------------------------------------------------
  // Internal — fan-out publish.
  // ------------------------------------------------------------------------

  #publish(sessionId: SessionId, awareness: Awareness, clientId: number): void {
    if (this.#pubSub === undefined) {
      return; // single-node mode.
    }
    const update: Uint8Array = encodeAwarenessUpdate(awareness, [clientId]);
    const message: PresenceFanoutMessage = {
      sessionId,
      update,
      originNodeId: this.#nodeId,
    };
    // Best-effort: a transient publish failure MUST NOT throw into the
    // heartbeat hot path. The local state is already updated; the next
    // heartbeat re-publishes. `publish` returns a promise; swallow rejections.
    void this.#pubSub.publish(message).catch(() => {
      // Intentionally swallowed — see above. A production transport logs the
      // failure inside its own `publish` (structured warning).
    });
  }

  // ------------------------------------------------------------------------
  // Internal — reconnect-grace timer machine (LOCAL clients only).
  // ------------------------------------------------------------------------

  /**
   * (Re)arm the reconnect-grace timer for a LOCAL client off a fresh heartbeat.
   * Clears any pending timer first (a heartbeat within the grace window cancels
   * the pending transition), then schedules the two-step machine:
   *
   *   t + reconnectingAfterMs  -> transition to `reconnecting`
   *   t + offlineAfterMs       -> transition to `offline`
   *
   * Each transition rewrites the client's Awareness `state` IN MEMORY and fires
   * the `onTransition` observer (T3.3's durable-emission seam). No durable write
   * occurs here (I-002-3). A transition is a no-op if the client's current
   * state already equals (or has passed) the target — e.g. an explicit
   * `"offline"` heartbeat means the `reconnecting` step has nothing to do.
   */
  #armGraceTimer(
    sessionId: SessionId,
    client: LocalClientPresence,
    participantId: ParticipantId,
    deviceId: string,
  ): void {
    if (client.graceTimer !== undefined) {
      clearTimeout(client.graceTimer);
      client.graceTimer = undefined;
    }

    // Step 1: at reconnectingAfterMs, move online/idle -> reconnecting.
    const reconnectingTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
      this.#transition(sessionId, client, participantId, deviceId, "reconnecting");
      // Step 2: at offlineAfterMs (relative to the heartbeat), move ->
      // offline. Scheduled as the remaining delta so the absolute offline
      // instant is offlineAfterMs from the last heartbeat.
      const remainingToOffline: number = Math.max(
        0,
        this.#offlineAfterMs - this.#reconnectingAfterMs,
      );
      client.graceTimer = setTimeout(() => {
        this.#transition(sessionId, client, participantId, deviceId, "offline");
        client.graceTimer = undefined;
      }, remainingToOffline);
    }, this.#reconnectingAfterMs);

    client.graceTimer = reconnectingTimer;
  }

  /**
   * Apply a timer-driven transition to a LOCAL client: rewrite its Awareness
   * `state` in memory, re-publish the new state to peers (so they see the
   * reconnecting/offline transition), and fire the `onTransition` observer.
   *
   * No-op if the client's current state is already AT OR PAST the target on the
   * offline-degradation ordering (online/idle < reconnecting < offline; see
   * `PRESENCE_PROGRESSION`). The grace machine only ever moves FORWARD in
   * degradation — it must never bounce a client backward (e.g. an explicit
   * `offline` heartbeat must NOT be dragged back to `reconnecting` when the 15s
   * timer fires). This keeps the observed transition stream monotonic, which
   * matters for T3.3's durable-event emission (a bogus offline->reconnecting
   * would pollute the timeline).
   */
  #transition(
    sessionId: SessionId,
    client: LocalClientPresence,
    participantId: ParticipantId,
    deviceId: string,
    to: PresenceState,
  ): void {
    const current: PresenceLocalState | undefined = validatePresenceLocalState(
      client.awareness.getLocalState(),
    );
    if (current === undefined || PRESENCE_PROGRESSION[to] <= PRESENCE_PROGRESSION[current.state]) {
      // Slot cleared, or the current state is already at/past the target on the
      // degradation ordering (so this forward-only transition is a no-op).
      return;
    }
    const from: PresenceState = current.state;
    const next: PresenceLocalState = { ...current, state: to };
    client.awareness.setLocalState(next);

    // Surface the transition to peers so cross-node projections reflect it.
    this.#publish(sessionId, client.awareness, client.doc.clientID);

    // T3.3 durable-emission seam (T3.2 writes nothing durable itself).
    //
    // CRASH GUARD (mirrors the daemon's session-subscribe.ts setImmediate/timer
    // boundary guard, lines ~316-326): `#transition` is reached from a DETACHED
    // `setTimeout` grace-timer callback (`#armGraceTimer`), so this stack has NO
    // surrounding try/catch and runs outside any caller's reach. The
    // `onTransition` observer is documented as the durable-emission seam wired to
    // `SessionService.append` (T3.3), which CAN throw — SQLite `SQLITE_BUSY`, a
    // `monotonic_ns` unique-violation, or a Zod validation failure. A throw on
    // this timer boundary would ESCAPE to Node's `uncaughtException` and is
    // capable of terminating the daemon process. So we degrade gracefully:
    // surface the failure via `console.error` with a tripwire prefix carrying the
    // full transition context, then SWALLOW it — a dropped observer notification
    // (T3.3 can recover on the next transition / via reconciliation) is the right
    // trade against crashing the daemon over one emission. There is no structured
    // logger in the control-plane today; this flips to it when one lands.
    // TRIPWIRE: replace `console.error` once a structured logger surfaces.
    try {
      this.#onTransition?.({
        sessionId,
        participantId,
        deviceId,
        from,
        to,
        at: new Date(),
      });
    } catch (error) {
      console.error(
        `[presence] onTransition observer threw; transition notification dropped (swallowed to keep the daemon alive) for sessionId=${sessionId} participantId=${participantId} from=${from} to=${to}`,
        error,
      );
    }
  }

  // ------------------------------------------------------------------------
  // Internal — shared helpers.
  // ------------------------------------------------------------------------

  #clientsFor(sessionId: SessionId): Map<string, ClientPresence> {
    let clients: Map<string, ClientPresence> | undefined = this.#sessions.get(sessionId);
    if (clients === undefined) {
      clients = new Map<string, ClientPresence>();
      this.#sessions.set(sessionId, clients);
    }
    return clients;
  }

  // Tear down a single holder: clear its grace timer (local only) and release
  // any CRDT resources. Does NOT touch the owning session map (callers do).
  #teardownClient(client: ClientPresence): void {
    if (client.origin === "local") {
      if (client.graceTimer !== undefined) {
        clearTimeout(client.graceTimer);
        client.graceTimer = undefined;
      }
      // Mark this client offline in the CRDT (null local state) before tearing
      // down — the y-protocols-documented "propagate a null state before
      // disconnect" convention — then destroy the Awareness (releasing its
      // internal check-interval timer) and the backing Y.Doc.
      client.awareness.setLocalState(null);
      teardownAwareness(client.awareness, client.doc);
    }
    // Peer holders carry no timers and no CRDT instance — nothing to release.
  }
}

// --------------------------------------------------------------------------
// In-memory fan-out fake — the cross-node unit-test substrate.
// --------------------------------------------------------------------------
//
// A process-local broadcast bus. EVERY subscriber (including the publisher's
// OWN service, which self-suppresses by `originNodeId`) receives every
// published message synchronously. This models the cross-node delivery
// semantics WITHOUT a database: two `PresenceRegisterService` instances sharing
// ONE `InMemoryPresencePubSub` behave like two nodes on one Postgres NOTIFY
// channel. It is the test substrate because two in-process PGlite instances are
// SEPARATE databases that cannot share NOTIFY.
export class InMemoryPresencePubSub implements PresencePubSub {
  readonly #handlers: Set<(message: PresenceFanoutMessage) => void> = new Set();

  publish(message: PresenceFanoutMessage): Promise<void> {
    // Snapshot the handler set so a subscribe/unsubscribe during dispatch does
    // not perturb this fan-out round.
    for (const handler of [...this.#handlers]) {
      handler(message);
    }
    return Promise.resolve();
  }

  subscribe(handler: (message: PresenceFanoutMessage) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  close(): Promise<void> {
    this.#handlers.clear();
    return Promise.resolve();
  }
}

// --------------------------------------------------------------------------
// Production fan-out — Postgres LISTEN/NOTIFY (ADR-008, Spec-002 line 61).
// --------------------------------------------------------------------------
//
// Wires the cross-node fan-out to a Postgres `LISTEN/NOTIFY` channel. The
// payload (a serialized Awareness update + origin node id) is base64-encoded
// into the NOTIFY message (NOTIFY carries text). I-002-3: this touches a
// TRANSIENT CHANNEL (`presence_fanout`), NEVER a table row — no
// `INSERT INTO presence_*` anywhere.
//
// Connection model: LISTEN requires a LONG-LIVED dedicated connection that
// receives async `notification` events (a `pg.Client`, NOT a `pg.Pool`
// checkout — a pooled connection is returned between queries and would stop
// delivering notifications). The caller supplies a connected `pg.Client`
// already issued `LISTEN presence_fanout`; this class attaches the
// `notification` listener and decodes inbound payloads. NOTIFY (publish) is
// issued on the same client.
//
// This class is constructed by production wiring (not exercised by the
// cross-node unit tests, which use `InMemoryPresencePubSub`). A single belt-
// and-suspenders test asserts it wires `notification` correctly against one
// PGlite instance (publish + receive on the same DB).
export interface PgListenNotifyClient {
  // The subset of `pg.Client` this transport needs. `query` issues
  // LISTEN/NOTIFY; `on("notification", ...)` delivers inbound messages.
  query(sql: string, params?: ReadonlyArray<unknown>): Promise<unknown>;
  on(
    event: "notification",
    listener: (message: { channel: string; payload?: string }) => void,
  ): unknown;
  removeListener?(
    event: "notification",
    listener: (message: { channel: string; payload?: string }) => void,
  ): unknown;
}

export class PgListenNotifyPubSub implements PresencePubSub {
  readonly #client: PgListenNotifyClient;
  readonly #handlers: Set<(message: PresenceFanoutMessage) => void> = new Set();
  readonly #onNotification: (message: { channel: string; payload?: string }) => void;
  // Optional structured-warning sink (defaults to `console.warn`). Injectable
  // so production wiring can route to OpenTelemetry without this module taking
  // a logger dependency.
  readonly #warn: (warning: string, detail: Record<string, unknown>) => void;

  constructor(
    client: PgListenNotifyClient,
    warn?: (warning: string, detail: Record<string, unknown>) => void,
  ) {
    this.#client = client;
    this.#warn =
      warn ??
      ((warning, detail) => {
        console.warn(warning, detail);
      });
    this.#onNotification = (message: { channel: string; payload?: string }): void => {
      if (message.channel !== PRESENCE_FANOUT_CHANNEL || message.payload === undefined) {
        return;
      }
      const decoded: PresenceFanoutMessage | undefined = decodeFanoutPayload(message.payload);
      if (decoded === undefined) {
        return; // malformed envelope — drop.
      }
      for (const handler of [...this.#handlers]) {
        handler(decoded);
      }
    };
    this.#client.on("notification", this.#onNotification);
  }

  async publish(message: PresenceFanoutMessage): Promise<void> {
    const payload: string = encodeFanoutPayload(message);
    if (Buffer.byteLength(payload, "utf8") > NOTIFY_PAYLOAD_SAFETY_LIMIT) {
      // Defense-in-depth: drop (do NOT fragment) an oversized payload. A single
      // client update is ~540 bytes, so this is a never-in-practice guard. The
      // next heartbeat re-publishes; dropping degrades gracefully.
      this.#warn("presence fan-out payload exceeds NOTIFY safety limit; dropped", {
        channel: PRESENCE_FANOUT_CHANNEL,
        sessionId: message.sessionId,
        bytes: Buffer.byteLength(payload, "utf8"),
        limit: NOTIFY_PAYLOAD_SAFETY_LIMIT,
      });
      return;
    }
    // `pg_notify($1, $2)` (parameterized) avoids quoting/escaping the payload
    // into a `NOTIFY channel, 'literal'` statement. The query can reject on a
    // transient transport fault (connection blip, PG restart/failover) — the
    // MOST-likely real failure on this path. Surface it through the structured
    // `#warn` sink (so operators can distinguish "fan-out healthy" from "every
    // publish failing"), then RETHROW: the service's `#publish` `.catch(() =>
    // {})` still swallows it for the heartbeat hot path (control flow
    // unchanged), but the signal is no longer silent.
    try {
      await this.#client.query("SELECT pg_notify($1, $2)", [PRESENCE_FANOUT_CHANNEL, payload]);
    } catch (error) {
      this.#warn("presence fan-out NOTIFY failed", {
        channel: PRESENCE_FANOUT_CHANNEL,
        sessionId: message.sessionId,
        error,
      });
      throw error;
    }
  }

  subscribe(handler: (message: PresenceFanoutMessage) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  close(): Promise<void> {
    this.#handlers.clear();
    this.#client.removeListener?.("notification", this.#onNotification);
    return Promise.resolve();
  }
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

// Construct an Awareness and immediately clear its built-in 30s
// `_checkInterval` (`outdatedTimeout`). We drive client lifecycle ourselves via
// the reconnect-grace timer, so the library's interval is pure overhead here.
// The interval does NOT threaten our state: in Shape B (one Awareness per LOCAL
// client, so the only meaningful slot is this instance's own clientID), the
// interval's 30s outdated-state DELETION branch is dead — y-protocols EXCLUDES
// the local client from deletion (`awareness.js:70` only removes
// `clientid !== this.clientID`) and instead RE-ANNOUNCES the local state at
// `outdatedTimeout / 2` to keep it alive (`awareness.js:61-63`). So the real
// reasons to clear it are (a) avoid leaking a 30s `setInterval` per connected
// client-device, and (b) avoid the spurious ~15s periodic re-announce churn
// (each re-announce would re-publish an unchanged slot). Clearing it is the
// documented y-protocols-bypass pattern when the host owns lifecycle. The
// `_checkInterval` field is typed `any` in the `.d.ts` (`awareness.d.ts:46`);
// the cast tightens it to the timer-handle type so `clearInterval` is sound.
function newAwareness(doc: Y.Doc): Awareness {
  const awareness: Awareness = new Awareness(doc);
  const handle = (awareness as unknown as { _checkInterval?: ReturnType<typeof setInterval> })
    ._checkInterval;
  if (handle !== undefined) {
    clearInterval(handle);
  }
  return awareness;
}

// Destroy an Awareness and its backing Y.Doc, releasing the Awareness internal
// interval (if not already cleared) and the doc's clientID slot.
function teardownAwareness(awareness: Awareness, doc: Y.Doc): void {
  awareness.destroy();
  doc.destroy();
}

// Cross-node recency comparison: is `candidate` strictly more recent than
// `incumbent`? Three-level cascade (see file header §cross-node recency
// tiebreak). Total and deterministic both within and across nodes.
//   1. `lastSeenAtMs` differs           → greater wins (most-recently-heard-from).
//   2. tie + SAME `originNodeId`        → greater `ingestSequence` wins. The
//      per-node sequences are comparable here; this preserves T3.1's
//      "newest-ingested device wins" same-millisecond contract for one node.
//   3. tie + DIFFERENT `originNodeId`   → greater `originNodeId` wins. The
//      disjoint per-node `ingestSequence` spaces are NEVER compared across
//      nodes, and distinct nodes always have distinct ids, so this is decisive
//      and total — there is no fourth level to fall through to.
function isMoreRecent(candidate: PresenceLocalState, incumbent: PresenceLocalState): boolean {
  if (candidate.lastSeenAtMs !== incumbent.lastSeenAtMs) {
    return candidate.lastSeenAtMs > incumbent.lastSeenAtMs;
  }
  if (candidate.originNodeId === incumbent.originNodeId) {
    // Same node, same millisecond: per-node ingest order is the tiebreak.
    return candidate.ingestSequence > incumbent.ingestSequence;
  }
  // Cross-node, same millisecond: deterministic node-id tiebreak; the disjoint
  // `ingestSequence` spaces are intentionally not consulted.
  return candidate.originNodeId > incumbent.originNodeId;
}

// FULL revalidation of a presence state object read from EITHER a local
// Awareness slot OR a decoded foreign (peer) update. Unlike T3.1's discriminator-
// only `readLocalState`, this asserts EVERY field's type AND that `state` is a
// member of the canonical 4-value `PresenceState` enum — required because the
// fan-out receive path admits FOREIGN-written state (see file header
// §FOREIGN-WRITER HARDENING). Returns `undefined` (reject) for any malformed
// shape; the caller drops the offending client rather than projecting corrupt
// state. `Awareness#getLocalState()` returns `Record<string, any> | null`, so
// the input is `unknown` and narrowed here.
function validatePresenceLocalState(raw: unknown): PresenceLocalState | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;

  const participantId = candidate["participantId"];
  const deviceId = candidate["deviceId"];
  const state = candidate["state"];
  const deviceType = candidate["deviceType"];
  const focusedSessionId = candidate["focusedSessionId"];
  const focusedChannelId = candidate["focusedChannelId"];
  const lastSeenAtMs = candidate["lastSeenAtMs"];
  const originNodeId = candidate["originNodeId"];
  const ingestSequence = candidate["ingestSequence"];
  const lastActivityAt = candidate["lastActivityAt"];
  const appVisible = candidate["appVisible"];

  if (
    typeof participantId !== "string" ||
    typeof deviceId !== "string" ||
    typeof state !== "string" ||
    // Enum membership — the load-bearing foreign-writer check. A peer state
    // carrying e.g. `"away"` is rejected, not projected.
    !PRESENCE_STATES.has(state) ||
    typeof deviceType !== "string" ||
    // focusedSessionId / focusedChannelId are `string | null` on the wire.
    !(focusedSessionId === null || typeof focusedSessionId === "string") ||
    !(focusedChannelId === null || typeof focusedChannelId === "string") ||
    typeof lastSeenAtMs !== "number" ||
    !Number.isFinite(lastSeenAtMs) ||
    typeof originNodeId !== "string" ||
    typeof ingestSequence !== "number" ||
    !Number.isFinite(ingestSequence) ||
    typeof lastActivityAt !== "string" ||
    typeof appVisible !== "boolean"
  ) {
    return undefined;
  }

  // Every field validated above — reconstruct explicitly (rather than casting
  // the whole object) so the returned value carries only the validated fields,
  // and the brands are reapplied on the id fields.
  return {
    participantId: participantId as ParticipantId,
    deviceId,
    state: state as PresenceState,
    deviceType,
    focusedSessionId: focusedSessionId as SessionId | null,
    focusedChannelId: focusedChannelId as ChannelIdOrNull,
    lastSeenAtMs,
    originNodeId,
    ingestSequence,
    lastActivityAt,
    appVisible,
  };
}

// Encode a fan-out message into the NOTIFY text payload: base64 of the binary
// Awareness update, plus the session id and origin node id, as a compact JSON
// envelope. NOTIFY carries text, so the binary update must be encoded.
function encodeFanoutPayload(message: PresenceFanoutMessage): string {
  return JSON.stringify({
    s: message.sessionId,
    n: message.originNodeId,
    u: Buffer.from(message.update).toString("base64"),
  });
}

// Decode a NOTIFY text payload back into a fan-out message. Returns `undefined`
// for a malformed envelope (the transport drops it).
function decodeFanoutPayload(payload: string): PresenceFanoutMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const envelope = parsed as Record<string, unknown>;
  const sessionId = envelope["s"];
  const originNodeId = envelope["n"];
  const updateBase64 = envelope["u"];
  if (
    typeof sessionId !== "string" ||
    typeof originNodeId !== "string" ||
    typeof updateBase64 !== "string"
  ) {
    return undefined;
  }
  return {
    sessionId: sessionId as SessionId,
    originNodeId,
    update: new Uint8Array(Buffer.from(updateBase64, "base64")),
  };
}
