// PresenceRegisterService — Plan-002 Phase 3 (T3.1 in-memory Yjs Awareness
// ingest; T3.2 cross-node LISTEN/NOTIFY fan-out + reconnect-grace timer).
//
// Responsibilities (T3.1 + T3.2):
//   * recordHeartbeat — ingest a `PresenceHeartbeat` into the in-memory Yjs
//     Awareness CRDT (I-002-3). Each (session, participant, device) tuple gets
//     its own `Y.Doc` + `Awareness` instance whose LOCAL state holds that
//     client's presence; subsequent heartbeats from the same tuple update that
//     same local state in place. NO SQLite or Postgres write occurs — the live
//     CRDT state lives in memory only (`Spec-002 §Default Behavior`,
//     §State And Data Implications, Plan-002 §Invariants I-002-3).
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
//   `Plan-002 §Implementation Steps` mandates "Use Yjs Awareness (`y-protocols/awareness`) as
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
//     `LISTEN/NOTIFY` (ADR-008, `Spec-002 §Default Behavior`) over a transient CHANNEL name
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
//   PEER-SLOT ORDERING (guarded by the same `isMoreRecent` recency rule): peer
//   state is stored as a decoded `PresenceLocalState` snapshot (not a live
//   per-peer Awareness), so it does NOT carry Awareness's built-in clock-based
//   last-writer-wins for the SAME source device. The fan-out upsert
//   (`#onFanoutMessage`) therefore applies, BEFORE replacing a peer holder, the
//   SAME `isMoreRecent` comparator `readPresence` uses to collapse devices: a
//   later-arriving snapshot replaces the stored one ONLY if it is strictly more
//   recent. This handles both single-source out-of-order delivery (two NOTIFY
//   messages from one source device reordered in flight) and cross-source
//   device-migration reorders — the older snapshot is dropped on receive rather
//   than clobbering the newer. (Postgres `LISTEN/NOTIFY` already preserves
//   per-connection commit order, so single-source reordering is rare on the
//   production transport; the guard makes correctness independent of that
//   delivery property rather than relying on it.) Storing decoded snapshots
//   (rather than one live Awareness per remote device) remains the deliberate
//   choice: a live Awareness per peer device would spin up an unbounded number
//   of `Y.Doc` + `Awareness` pairs, each with its own 30s `_checkInterval` — a
//   real per-device timer/memory cost. The CRDT round-trip that I-002-3 and the
//   "uses Yjs Awareness" test pin is still exercised: the origin serializes via
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
//   `validatePresenceLocalState`, which runs `safeParse` against
//   `PresenceLocalStateSchema` — the single source of truth for shape,
//   branded-id UUID format, `PresenceState` enum membership, and numeric range
//   bounds. A malformed peer update (e.g. an out-of-enum `state`, a missing
//   field, a wrong type) is REJECTED — the offending client is not stored and
//   does not surface on this node's projection — rather than projected as
//   corrupt state.
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
// Refs: `Spec-002 §Default Behavior`, `Spec-002 §Fallback Behavior`,
// `Spec-002 §State And Data Implications`; Plan-002 §Phase 3,
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
// Value import (separate from the type-only import above): the branded-id Zod
// schemas are runtime values used to FULLY revalidate the three UUID id fields
// on a foreign peer snapshot (see `validatePresenceLocalState`).
import {
  ChannelIdSchema,
  DEVICE_ID_MAX_LEN,
  DEVICE_TYPE_MAX_LEN,
  ParticipantIdSchema,
  PresenceStateSchema,
  SessionIdSchema,
  canonicalizeUuid,
  wireFreeFormString,
} from "@ai-sidekicks/contracts";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { z } from "zod";

// --------------------------------------------------------------------------
// Reconnect-grace timing — defaults per `Spec-002 §Default Behavior`.
// --------------------------------------------------------------------------
//
// `Spec-002 §Default Behavior`: "Presence heartbeat default interval is 15s, with a
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
// here until it is assigned a rank, with deliberate placement. RUNTIME
// membership enforcement (rejecting an off-enum foreign `state`) lives in
// `PresenceLocalStateSchema.state`, which reuses the contract's
// `PresenceStateSchema` enum — so the same contract enum drives both the
// compile-time rank table here and the parse-time validation, and they cannot
// drift.
//
// SECOND CONSUMER — `isMoreRecent`'s same-tuple state-rank tiebreak (2b): when
// two snapshots tie on (lastSeenAtMs, originNodeId, ingestSequence), the
// more-degraded state wins. The tiebreak and the grace machine MUST share THIS
// table: because `#transition` advances only forward along this ordering and
// reuses the tuple, the higher-rank state at an equal tuple is provably the
// later one. A parallel rank table for the tiebreak could disagree — letting a
// state `#transition` would never move to nevertheless dominate at an equal
// tuple — so the single shared table is load-bearing, not incidental reuse.
const PRESENCE_PROGRESSION: Record<PresenceState, number> = {
  online: 0,
  idle: 0,
  reconnecting: 1,
  offline: 2,
};

// --------------------------------------------------------------------------
// Awareness local-state shape — what each client's CRDT slot carries.
// --------------------------------------------------------------------------
//
// The single source of truth for the local-state shape AND its foreign-writer
// revalidation. `validatePresenceLocalState` runs untrusted, cross-node bytes
// through `safeParse`, so every constraint a malicious or buggy peer could
// violate lives here as a parser rule — the derived `PresenceLocalState` type
// cannot drift from what the validator actually enforces. Branded id fields
// reuse the contract schemas (`z.ZodType<Brand, Brand>`), so `z.infer` yields
// the same branded types the rest of the file consumes. `z.object` strips
// unknown keys, so a peer cannot smuggle extra fields into the stored snapshot.
//
// Largest ms epoch whose `new Date(ms).toISOString()` stays within the
// 4-digit-year ISO-8601 grammar that `PresenceReadResponseSchema.lastSeen`
// (`z.iso.datetime`, contracts/src/presence.ts:341) enforces —
// `Date.UTC(9999,11,31,23,59,59,999)`. Beyond this, `toISOString()` emits an
// expanded 6-digit year that the daemon's presence.read result-schema
// validation (runtime-daemon registry.ts:395) rejects with -32603 while the
// out-of-range foreign peer stays sticky-dominant in `isMoreRecent`.
const MAX_PRESENCE_LAST_SEEN_MS = 253_402_300_799_999;

// Node's `setTimeout` delay is a 32-bit signed value: the largest delay it
// honors verbatim is 2^31-1 ms (~24.8 days). A larger delay OVERFLOWS the
// 32-bit field, and Node coerces it to 1ms while emitting a
// `TimeoutOverflowWarning` — so a grace window set above this would fire the
// reconnecting/offline transition almost immediately, silently forcing the
// client offline. Both grace windows are validated to fit under this ceiling in
// the constructor (see the timing guard), which keeps every delay
// `#armGraceTimer` actually passes to `setTimeout` (`reconnectingAfterMs` and
// `offlineAfterMs - reconnectingAfterMs`, each <= its input) safely in range.
const SET_TIMEOUT_MAX_MS = 2_147_483_647;

// Generous length cap for the snapshot's `originNodeId`. Node ids are
// `crypto.randomUUID()` (36 chars) in production, but the constructor
// (`options?.nodeId ?? crypto.randomUUID()`) accepts an arbitrary
// caller-supplied string — the tests pass `"node-a"` / `"node-b"` — so this is
// a bound, NOT a UUID-format assertion: `z.uuid()` would wrongly reject the
// legitimate non-UUID node ids the abstraction allows. There is no contracts
// `NodeId` const because `PresenceFanoutMessage` is control-plane-internal.
const NODE_ID_MAX_LEN = 256;

const PresenceLocalStateSchema = z.object({
  participantId: ParticipantIdSchema,
  // `deviceId` / `deviceType` mirror the LOCAL heartbeat path's
  // `wireFreeFormString` guard (contracts/src/presence.ts:240 and :245) so the
  // foreign fan-out path enforces the SAME bound + length cap. This makes the
  // `clientKey` collision-freedom premise true on both paths and closes the NUL
  // log-injection vector `wireFreeFormString` exists to guard (session.ts:109).
  deviceId: wireFreeFormString(DEVICE_ID_MAX_LEN, "PresenceLocalState.deviceId"),
  state: PresenceStateSchema,
  deviceType: wireFreeFormString(DEVICE_TYPE_MAX_LEN, "PresenceLocalState.deviceType"),
  focusedSessionId: SessionIdSchema.nullable(),
  focusedChannelId: ChannelIdSchema.nullable(),
  // Server-clock receipt time, NOT the wire `metadata.lastActivityAt`. See
  // `recordHeartbeat` for why the server clock is authoritative for `lastSeen`.
  // Primary key of the cross-node recency tiebreak in `readPresence`.
  // Bounded by `MAX_PRESENCE_LAST_SEEN_MS` — see that const's declaration for the
  // ISO-8601 4-digit-year ceiling rationale and the downstream -32603 chain.
  lastSeenAtMs: z.number().int().min(0).max(MAX_PRESENCE_LAST_SEEN_MS),
  // The id of the node that INGESTED this heartbeat (the origin). Generated
  // once per service instance (`crypto.randomUUID()` in the constructor) and
  // stamped on every local heartbeat. It travels in the Awareness payload, so
  // a peer node can (a) suppress its OWN updates that round-trip back through
  // the fan-out, and (b) discriminate the cross-node recency tiebreak (a peer
  // device's `ingestSequence` is NOT comparable to ours — see `isMoreRecent`).
  // Carries the same `wireFreeFormString` guard as `deviceId` / `deviceType`
  // (rejects empty / over-length / NUL), defending the `isMoreRecent`
  // string-compare and the log path against a misbehaving peer node — a foreign
  // peer cannot inject an unbounded or NUL-bearing node id.
  originNodeId: wireFreeFormString(NODE_ID_MAX_LEN, "PresenceLocalState.originNodeId"),
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
  ingestSequence: z.number().int().min(0),
  // The client-reported "last user interaction" timestamp, preserved verbatim
  // from the wire for downstream consumers (e.g. an idle-detector) that want
  // the activity time distinct from the receipt time. Validated against the
  // same wire grammar as contracts/src/presence.ts:251.
  lastActivityAt: z.iso.datetime({ offset: true }),
  appVisible: z.boolean(),
});

// This is the value `setLocalState(...)` writes into the per-client Awareness
// slot and `getStates()` reads back. It mirrors the metadata the heartbeat
// carries (`Spec-002 §Interfaces And Contracts`) plus the resolved presence `state` and the
// `originNodeId` of the node that ingested it. T3.2's
// `encodeAwarenessUpdate(awareness, [doc.clientID])` serializes exactly this
// object for cross-node fan-out, so the shape is shared across both the local
// store and the wire. `Readonly<...>` is a type-level modifier only (it does
// NOT freeze the parsed object — every `#transition` produces a fresh spread).
type PresenceLocalState = Readonly<z.infer<typeof PresenceLocalStateSchema>>;

// --------------------------------------------------------------------------
// Per-client holders — local (CRDT-backed) vs peer (decoded snapshot).
// --------------------------------------------------------------------------
//
// A LOCAL client (one this node ingests heartbeats for) holds its own
// `Y.Doc` + `Awareness` (Shape B; see file header). A PEER client (one whose
// state arrived via the cross-node fan-out) holds the decoded, fully-validated
// `PresenceLocalState` snapshot — NOT a live Awareness, for the resource and
// ordering reasons documented in the file header §PEER-SLOT ORDERING.
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
  // `participantId` is canonicalized to lowercase hex (`canonicalizeUuid`)
  // BEFORE it enters the key: it is a `brandedUuidIdSchema` UUID
  // (session.ts:57) whose validator (`z.string().uuid()`) is case-INSENSITIVE,
  // so an uppercase and a lowercase spelling denote the SAME logical
  // participant and MUST collapse to one key (else the same participant on one
  // device splits into two slots). `deviceId` is NOT canonicalized — it is an
  // opaque `wireFreeFormString` (presence.ts:240), case-SIGNIFICANT, where two
  // case-variant strings are two genuinely different devices.
  //
  // The separator is a literal NUL byte (`\0`). It is collision-free because
  // `wireFreeFormString` (session.ts:118-128) rejects NUL in EVERY wire
  // free-form string via `.refine((s) => !s.includes("\0"))` (line 126), and
  // both operands are so guarded at the wire boundary: the canonicalized
  // `participantId` is still a hex+hyphen UUID (lowercasing introduces no NUL)
  // and `deviceId` is `wireFreeFormString(DEVICE_ID_MAX_LEN, ...)`. So the
  // separator can never occur inside either field, and the join parses back
  // unambiguously. (Spelled `\0` rather than an inline literal so the byte is
  // visible in source — an invisible NUL here has already misled two readers.)
  return `${canonicalizeUuid(participantId)}\0${deviceId}`;
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
  // Reconnect-grace timing (`Spec-002 §Default Behavior` defaults: 15s / 45s). Read as the
  // delay (ms) from the LAST heartbeat to the `reconnecting` and `offline`
  // transitions respectively. `offlineAfterMs` MUST be >= `reconnectingAfterMs`
  // for the two-step machine to be well-ordered.
  readonly reconnectingAfterMs?: number;
  readonly offlineAfterMs?: number;
  // Observation seam for T3.3 durable presence-event emission (see
  // `PresenceTransitionEvent`). Absent => transitions are applied to the live
  // CRDT only (no observer). T3.2 itself never persists. The return type admits
  // `Promise<void>` because T3.3 wires this to the daemon's durable append path
  // (Plan-006 T3.1's `EventLogService.append` — Plan-001's `SessionService.append`
  // is guarded test-only per the T3.1 precondition), an async
  // DB write; `#transition` catches BOTH a sync throw and an async rejection so
  // either failure mode degrades gracefully instead of crashing the daemon on
  // the detached timer boundary. A plain `() => void` callback still satisfies it.
  readonly onTransition?: (event: PresenceTransitionEvent) => void | Promise<void>;
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
  readonly #onTransition: ((event: PresenceTransitionEvent) => void | Promise<void>) | undefined;

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

    // Fail-fast validation of the injected `nodeId` at construction, symmetric
    // with the timing guards below. `this.#nodeId` is stamped as `originNodeId`
    // on every LOCAL snapshot (`recordHeartbeat`, the fan-out publish, the
    // offline tombstone), and the local read-back path re-runs those snapshots
    // through `validatePresenceLocalState` -> `PresenceLocalStateSchema`, whose
    // `originNodeId` field is `wireFreeFormString(NODE_ID_MAX_LEN, ...)`. So an
    // empty / whitespace-only / NUL-bearing / over-length injected `nodeId`
    // would pass the schema's *foreign* `originNodeId` field on a peer snapshot
    // but then SILENTLY fail the LOCAL snapshot revalidation on every read
    // (dropping this node's own presence) and no-op every grace transition — a
    // latent silent failure. Reuse the EXACT schema-field rule so the
    // constructor and the schema share one source of truth for the bound + NUL
    // guard. The default `crypto.randomUUID()` path (no `nodeId` option)
    // trivially passes (36 chars, non-blank, no NUL).
    //
    // The thrown message is INTENTIONALLY static — it names the rule but does
    // NOT interpolate `this.#nodeId` (unlike the timing guards below, whose
    // numeric values are bounded and NUL-free). A hostile/buggy caller's
    // `nodeId` could itself carry a NUL byte or be megabytes long; echoing it
    // into the message (and thus into logs) would reintroduce exactly the
    // NUL-log-injection / unbounded-string vector `wireFreeFormString` exists to
    // close. The Zod `safeParse` error is discarded for the same reason (it may
    // echo the value).
    if (!wireFreeFormString(NODE_ID_MAX_LEN, "nodeId").safeParse(this.#nodeId).success) {
      throw new RangeError(
        `PresenceRegisterService: nodeId must be a non-blank string of at most ${String(NODE_ID_MAX_LEN)} characters with no NUL byte`,
      );
    }

    // Fail-fast validation of the two timing options at construction. Both feed
    // `#armGraceTimer`'s `Math.max(0, … - elapsed)` + `setTimeout`, where a
    // negative / NaN / non-integer delay is a silent footgun (setTimeout coerces
    // NaN to 0, firing the transition immediately). An UPPER bound is just as
    // load-bearing: a delay above `SET_TIMEOUT_MAX_MS` (2^31-1) overflows
    // setTimeout's 32-bit field and is coerced to ~1ms (TimeoutOverflowWarning),
    // which would fire the reconnecting/offline transition almost immediately —
    // silently forcing the client offline, the inverse of the intended long
    // window. The well-ordering invariant (`offlineAfterMs >= reconnectingAfterMs`,
    // documented on the options) keeps the two-step `reconnecting -> offline`
    // machine monotone. RangeError names the offending value so a
    // misconfiguration is diagnosable at the call site.
    for (const [label, value] of [
      ["reconnectingAfterMs", this.#reconnectingAfterMs],
      ["offlineAfterMs", this.#offlineAfterMs],
    ] as const) {
      if (!Number.isInteger(value) || value < 0 || value > SET_TIMEOUT_MAX_MS) {
        throw new RangeError(
          `PresenceRegisterService: ${label} must be a non-negative integer (ms) not exceeding ${String(SET_TIMEOUT_MAX_MS)} (setTimeout ceiling); received ${String(value)}`,
        );
      }
    }
    if (this.#offlineAfterMs < this.#reconnectingAfterMs) {
      throw new RangeError(
        `PresenceRegisterService: offlineAfterMs (${String(this.#offlineAfterMs)}) must be >= ` +
          `reconnectingAfterMs (${String(this.#reconnectingAfterMs)}) for a well-ordered ` +
          `reconnecting -> offline transition`,
      );
    }

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
    const clients: Map<string, ClientPresence> | undefined = this.#getClients(sessionId);
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
   * For a local holder: first publishes a final `offline` tombstone to peers
   * (so the cross-node fan-out reflects the disconnect rather than a stale
   * `online`/`reconnecting` state), then clears the client's Awareness slot
   * (`setLocalState(null)`), clears its grace timer, and destroys the
   * `Awareness` and its backing `Y.Doc`. For a peer holder: drops the snapshot
   * (peer holders publish nothing — their origin node owns their fan-out).
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
    const clients: Map<string, ClientPresence> | undefined = this.#getClients(sessionId);
    if (clients === undefined) {
      return false;
    }
    const key: string = clientKey(participantId, deviceId);
    const client: ClientPresence | undefined = clients.get(key);
    if (client === undefined) {
      return false;
    }
    this.#teardownClient(sessionId, client);
    clients.delete(key);
    if (clients.size === 0) {
      this.#deleteClients(sessionId);
    }
    return true;
  }

  /**
   * Release EVERY tracked client across all sessions and unsubscribe from the
   * cross-node fan-out — leak-free shutdown. Publishes a best-effort final
   * `offline` tombstone per LOCAL holder (fire-and-forget — not awaited, since
   * an ungraceful shutdown cannot guarantee delivery; peer holders publish
   * nothing), clears every grace timer, destroys every local Awareness/Y.Doc,
   * drops every peer snapshot, and closes the transport if it exposes
   * `close()`. After `destroy()` the service holds no timers and no CRDT
   * instances.
   *
   * Returns a promise so callers can await transport teardown; the in-memory
   * state is released synchronously before the (optional) async close.
   */
  async destroy(): Promise<void> {
    for (const [sessionId, clients] of this.#sessions.entries()) {
      for (const client of clients.values()) {
        // BEST-EFFORT FIRE-AND-FORGET tombstones: `#teardownClient` publishes a
        // final `offline` snapshot for each LOCAL holder via `#publish` (which
        // is itself fire-and-forget). We do NOT collect or await those publish
        // promises before `close()` below — an ungraceful shutdown can't send
        // them anyway, and durable last-gasp delivery is the deferred Tier-5
        // durability layer, not this service's job.
        this.#teardownClient(sessionId, client);
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

    // FOREIGN-WRITER HARDENING (§file header): the envelope `sessionId` becomes a
    // `#sessions` key via `#clientsFor` below. A peer publishing a MALFORMED
    // sessionId that nonetheless carries an otherwise-valid state mints a live,
    // unreachable holder under a garbage key the empty-map reclaim never collects
    // (the reclaim fires only when ZERO holders survive, and here a valid holder
    // does). Validate the envelope key against the canonical `SessionIdSchema`
    // and DROP the whole message on failure. Enforced HERE at the receive
    // chokepoint — not in `decodeFanoutPayload` — because `InMemoryPresencePubSub`
    // delivers the structured message DIRECTLY to handlers, bypassing the wire
    // codec; a decoder-only guard would miss the in-memory transport entirely.
    // This covers BOTH transports and is symmetric with the per-state
    // `validatePresenceLocalState` revalidation in the loop below.
    if (!SessionIdSchema.safeParse(message.sessionId).success) {
      return;
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
    // This loop iterates only the NON-null states `applyAwarenessUpdate` left in
    // the scratch instance — so it has no "null removal" case to handle, and that
    // is BY DESIGN. Cross-node teardown does NOT propagate a disconnect as a null
    // Awareness removal; it propagates an explicit `offline` STATE snapshot (see
    // `#teardownClient`), which the upsert below stores and `readPresence`
    // surfaces truthfully as `state:"offline"`. (Reaping the lingering offline
    // peer holder via TTL and detecting ungraceful node death are
    // Plan-008-remainder Tier-5 durability work — explicitly out of scope here;
    // no TTL or per-peer timer is added.)
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
      if (
        existing !== undefined &&
        existing.origin === "peer" &&
        isMoreRecent(existing.state, validated)
      ) {
        // Recency guard: apply the SAME `isMoreRecent` rule `readPresence` uses,
        // dropping only when the EXISTING peer holder strictly dominates. This
        // expresses the intent "an older arrival must not clobber a newer peer
        // holder" (covering single-source out-of-order delivery and cross-source
        // device-migration reorders). At an EQUAL heartbeat tuple the asymmetry is
        // now explicit via the `isMoreRecent` state-rank sub-tiebreak (2b): a
        // FORWARD-degradation `#transition` snapshot (online -> reconnecting ->
        // offline at the reused tuple) is strictly more-degraded than the holder,
        // so `isMoreRecent(existing, arrival)` is false and it PROPAGATES; but a
        // BACKWARD-degradation same-tuple reorder (a stale less-degraded snapshot
        // arriving late, e.g. an `online` frame behind a later `reconnecting` at
        // the identical tuple) is LESS-degraded, so the existing holder dominates
        // and the stale frame is REJECTED here. The offline tombstone path also
        // bumps `lastSeenAtMs`, so it is strictly newer and is always accepted.
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
      this.#deleteClients(message.sessionId);
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
    // the daemon's durable append path (T3.3; Plan-006 T3.1's
    // `EventLogService.append` — `SessionService.append` is guarded test-only
    // per the T3.1 precondition), an ASYNC DB write that CAN fail two ways —
    // a SYNCHRONOUS throw (a guard/validation error before the await) OR a
    // REJECTED promise (SQLite `SQLITE_BUSY`, a `monotonic_ns` unique-violation,
    // a Zod failure inside the async body). On this detached timer boundary a
    // sync throw escapes to `uncaughtException` and an unhandled rejection
    // escapes to `unhandledRejection` — in Node 22 BOTH are capable of
    // terminating the daemon process. So we degrade gracefully on EITHER path:
    // the try/catch swallows the sync throw, and (because the seam is legitimately
    // async) we duck-type the return value for a thenable and attach a `.catch`
    // that routes a rejection to the SAME tripwire. A dropped observer
    // notification (T3.3 can recover on the next transition / via reconciliation)
    // is the right trade against crashing the daemon over one emission. The
    // duck-typed `.then` check (not `instanceof Promise`) tolerates a non-native
    // thenable (e.g. a userland promise library or a cross-realm Promise) the
    // observer might return. We discharge it via `Promise.resolve(thenable)
    // .catch(...)` rather than calling `.catch` DIRECTLY on the value: the
    // PromiseLike contract (TC39) only requires `.then`, so a valid `.then`-only
    // thenable has no `.catch` — a direct `(value).catch(...)` would be
    // `undefined(...)` and throw a TypeError synchronously, which the outer
    // try/catch would then swallow and MISLABEL "(sync)" while the genuine async
    // rejection went unrouted. `Promise.resolve` absorbs ANY thenable into a
    // native Promise whose `.catch` is guaranteed to exist. This mirrors the
    // established thenable-discharge pattern in `client-sdk`
    // `jsonRpcClient.ts` (same `void | Promise<void>` seam). There is no
    // structured logger in the control-plane today; this flips to it when one
    // lands. TRIPWIRE: replace `console.error` once a structured logger surfaces.
    try {
      const observerResult: void | Promise<void> = this.#onTransition?.({
        sessionId,
        participantId,
        deviceId,
        from,
        to,
        at: new Date(),
      });
      if (
        observerResult !== undefined &&
        observerResult !== null &&
        typeof (observerResult as { then?: unknown }).then === "function"
      ) {
        Promise.resolve(observerResult as PromiseLike<void>).catch((error: unknown) => {
          console.error(
            `[presence] onTransition observer rejected (async); transition notification dropped (swallowed to keep the daemon alive) for sessionId=${sessionId} participantId=${participantId} from=${from} to=${to}`,
            error,
          );
        });
      }
    } catch (error) {
      console.error(
        `[presence] onTransition observer threw (sync); transition notification dropped (swallowed to keep the daemon alive) for sessionId=${sessionId} participantId=${participantId} from=${from} to=${to}`,
        error,
      );
    }
  }

  // ------------------------------------------------------------------------
  // Internal — shared helpers.
  // ------------------------------------------------------------------------

  // ------------------------------------------------------------------------
  // Outer `#sessions` map accessors — the SINGLE canonicalization boundary.
  // ------------------------------------------------------------------------
  //
  // `#sessions` is keyed by `SessionId`, a `brandedUuidIdSchema` UUID whose
  // validator (`z.string().uuid()`) is case-INSENSITIVE (RFC 9562 §4), and ids
  // in this codebase are branded by bare cast at DB-row reads (not parsed
  // through the schema), so an uppercase and a lowercase spelling of the SAME
  // logical session can both reach this map. Routing EVERY keyed access through
  // these three accessors (which canonicalize via `canonicalizeUuid`) is what
  // guarantees the two spellings collapse to one key — so presence cannot split
  // or go missing across case-variants. INVARIANT: no direct
  // `this.#sessions.get/set/delete` exists outside these three methods (whole-
  // map `entries()`/`clear()`/`size` in `destroy`/`trackedSessionCount` operate
  // on the map as a whole and need no per-key canonical form).
  #getClients(sessionId: SessionId): Map<string, ClientPresence> | undefined {
    return this.#sessions.get(canonicalizeUuid(sessionId));
  }

  #setClients(sessionId: SessionId, clients: Map<string, ClientPresence>): void {
    this.#sessions.set(canonicalizeUuid(sessionId), clients);
  }

  #deleteClients(sessionId: SessionId): void {
    this.#sessions.delete(canonicalizeUuid(sessionId));
  }

  #clientsFor(sessionId: SessionId): Map<string, ClientPresence> {
    let clients: Map<string, ClientPresence> | undefined = this.#getClients(sessionId);
    if (clients === undefined) {
      clients = new Map<string, ClientPresence>();
      this.#setClients(sessionId, clients);
    }
    return clients;
  }

  // Tear down a single holder: for a LOCAL holder, fan out a final `offline`
  // tombstone (so peers don't keep the last non-null snapshot indefinitely),
  // clear its grace timer, and release its CRDT resources; for a PEER holder,
  // nothing to release. Does NOT touch the owning session map (callers do).
  #teardownClient(sessionId: SessionId, client: ClientPresence): void {
    if (client.origin === "local") {
      if (client.graceTimer !== undefined) {
        clearTimeout(client.graceTimer);
        client.graceTimer = undefined;
      }
      // Publish a final `offline` snapshot to peers BEFORE clearing the slot.
      // Without it, a LOCAL holder that hard-disconnects leaves peers holding
      // the last non-null state (e.g. `online`) forever — there is no
      // `awareness.on('update')` observer wiring a null fan-out, and the
      // `setLocalState(null)` below is purely local teardown. The offline
      // snapshot is stamped strictly MORE recent than the prior state (a fresh
      // `lastSeenAtMs`/`ingestSequence`) so it wins `isMoreRecent` and survives
      // the peer-side recency guard in `#onFanoutMessage`.
      //
      // Re-published UNCONDITIONALLY when a valid snapshot exists — even if the
      // client is ALREADY `offline`. `#publish` is best-effort (it swallows
      // transport rejections), so the earlier transition-to-`offline` publish
      // may have failed transiently, leaving peers stuck on a stale
      // `online`/`reconnecting` snapshot. There is no TTL reaper this phase, so
      // teardown is the LAST chance to fan out the disconnect. Re-publishing
      // `offline` is idempotent on peers (the receiver's recency guard accepts
      // the strictly-newer tombstone and drops nothing it shouldn't), so the
      // redundant case is harmless and the failed-publish case is repaired. The
      // `last !== undefined` guard stays: a cleared slot has no snapshot to build
      // a tombstone from.
      const last: PresenceLocalState | undefined = validatePresenceLocalState(
        client.awareness.getLocalState(),
      );
      if (last !== undefined) {
        const offlineSnapshot: PresenceLocalState = {
          participantId: last.participantId,
          deviceId: last.deviceId,
          state: "offline",
          deviceType: last.deviceType,
          focusedSessionId: last.focusedSessionId,
          focusedChannelId: last.focusedChannelId,
          lastSeenAtMs: Date.now(),
          originNodeId: this.#nodeId,
          // Pre-increment (matches `recordHeartbeat`): strictly greater than the
          // prior state's sequence so the tombstone is decisively more recent
          // even when `Date.now()` ties the prior heartbeat's `lastSeenAtMs`.
          ingestSequence: ++this.#ingestSequence,
          lastActivityAt: last.lastActivityAt,
          appVisible: last.appVisible,
        };
        client.awareness.setLocalState(offlineSnapshot);
        // Best-effort: `#publish` no-ops in single-node mode and swallows
        // rejections, so this never throws into a teardown/`destroy` path.
        this.#publish(sessionId, client.awareness, client.doc.clientID);
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
// Production fan-out — Postgres LISTEN/NOTIFY (ADR-008, `Spec-002 §Default Behavior`).
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

  async close(): Promise<void> {
    this.#handlers.clear();
    this.#client.removeListener?.("notification", this.#onNotification);
    // Defensive cleanup: the caller owns the dedicated LISTEN connection (see
    // class doc above), but issuing UNLISTEN here leaves a reused connection
    // clean — without it, a long-lived pg client stays server-side-subscribed
    // (leaked listener, wasted NOTIFY traffic) after this transport detaches.
    // UNLISTEN cannot be parameterized (`UNLISTEN $1` is a Postgres parser
    // error — the channel is an identifier, not a bind value); the channel is a
    // trusted compile-time constant, so string-concatenation is safe here.
    // Best-effort — a transient query failure on an already-closing connection
    // is swallowed via `#warn` and NOT rethrown (close() must not throw on
    // teardown).
    try {
      await this.#client.query("UNLISTEN " + PRESENCE_FANOUT_CHANNEL);
    } catch (error) {
      this.#warn("presence fan-out UNLISTEN failed", {
        channel: PRESENCE_FANOUT_CHANNEL,
        error,
      });
    }
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
// `incumbent`? Cascade (see file header §cross-node recency tiebreak). Total and
// deterministic both within and across nodes.
//   1. `lastSeenAtMs` differs           → greater wins (most-recently-heard-from).
//   2. tie + SAME `originNodeId`:
//      2a. `ingestSequence` differs     → greater `ingestSequence` wins. The
//          per-node sequences are comparable here; this preserves T3.1's
//          "newest-ingested device wins" same-millisecond contract for one node.
//      2b. `ingestSequence` ALSO equal  → greater `PRESENCE_PROGRESSION` rank
//          wins. The `#transition` grace machine reuses the heartbeat tuple
//          (same lastSeenAtMs + ingestSequence) and only ever advances `state`
//          FORWARD (online|idle -> reconnecting -> offline), so the more-degraded
//          same-tuple state is the strictly-later one; a less-degraded same-tuple
//          snapshot is a stale reorder. This consults the SAME table `#transition`
//          gates on, so the two cannot disagree about temporal order.
//   3. tie + DIFFERENT `originNodeId`   → greater `originNodeId` wins. The
//      disjoint per-node `ingestSequence` spaces are NEVER compared across
//      nodes, and distinct nodes always have distinct ids, so this is decisive
//      and total. The state-rank sub-tiebreak (2b) is SAME-origin only — it is
//      never reached on the cross-node branch.
function isMoreRecent(candidate: PresenceLocalState, incumbent: PresenceLocalState): boolean {
  if (candidate.lastSeenAtMs !== incumbent.lastSeenAtMs) {
    return candidate.lastSeenAtMs > incumbent.lastSeenAtMs;
  }
  if (candidate.originNodeId === incumbent.originNodeId) {
    if (candidate.ingestSequence !== incumbent.ingestSequence) {
      // Same node, same millisecond: per-node ingest order is the tiebreak.
      return candidate.ingestSequence > incumbent.ingestSequence;
    }
    // Equal (lastSeenAtMs, originNodeId, ingestSequence): the `#transition` grace
    // machine deliberately REUSES the heartbeat tuple and advances only `state`
    // forward along online|idle -> reconnecting -> offline, so a more-degraded
    // state at the same tuple is strictly LATER in time. A less-degraded
    // same-tuple snapshot is therefore a stale reorder and must NOT win. The rank
    // is `PRESENCE_PROGRESSION` — the SAME table `#transition` gates on, so the
    // tiebreak and the grace machine cannot disagree about which state is "later".
    return PRESENCE_PROGRESSION[candidate.state] > PRESENCE_PROGRESSION[incumbent.state];
  }
  // Cross-node, same millisecond: deterministic node-id tiebreak; the disjoint
  // `ingestSequence` spaces are intentionally not consulted.
  return candidate.originNodeId > incumbent.originNodeId;
}

// FULL revalidation of a presence state object read from EITHER a local
// Awareness slot OR a decoded foreign (peer) update. Unlike T3.1's discriminator-
// only `readLocalState`, the input is parsed against `PresenceLocalStateSchema`
// — the single source of truth for a valid snapshot (field shapes, branded-id
// UUID format, the canonical `PresenceState` enum, and the numeric range
// bounds) — required because the fan-out receive path admits FOREIGN-written
// state (see file header §FOREIGN-WRITER HARDENING). The schema's branded-id
// fields reuse the contract `*IdSchema`s, so UUID format is asserted uniformly;
// this matters because `PresenceReadResponseSchema` rejects a non-UUID
// participantId, so storing a malformed peer value would later make the WHOLE
// session's `presence.read` response fail schema validation. Returns
// `undefined` (reject) for any malformed shape; the caller drops the offending
// client rather than projecting corrupt state.
// `Awareness#getLocalState()` returns `Record<string, any> | null`, so the
// input is `unknown` and narrowed by the parse.
function validatePresenceLocalState(raw: unknown): PresenceLocalState | undefined {
  const parsed = PresenceLocalStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
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
