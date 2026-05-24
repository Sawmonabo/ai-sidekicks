// PresenceRegisterService — Plan-002 Phase 3 (T3.1, in-memory Yjs Awareness
// ingestion ONLY).
//
// Responsibilities (this task, T3.1):
//   * recordHeartbeat — ingest a `PresenceHeartbeat` into the in-memory Yjs
//     Awareness CRDT (I-002-3). Each (session, participant, device) tuple gets
//     its own `Y.Doc` + `Awareness` instance whose LOCAL state holds that
//     client's presence; subsequent heartbeats from the same tuple update that
//     same local state in place. NO SQLite or Postgres write occurs — the live
//     CRDT state lives in memory only (Spec-002 §Default Behavior line 58,
//     §State And Data Implications line 157, Plan-002 §Invariants I-002-3).
//   * readPresence — project the live in-memory Awareness state for a session
//     into the `PresenceReadResponse` wire shape (one entry per participant).
//   * forgetClient — explicit GC primitive for a single (session, participant,
//     device) tuple, used by callers that observe a hard disconnect. The
//     timer-driven reconnect-grace GC (45s grace -> reconnecting -> offline) is
//     NOT in this task — see the T3.2 scope boundary below.
//
// Why Yjs Awareness, not a plain Map (I-002-3 is explicit about the CRDT):
//   Plan-002 line 113 mandates "Use Yjs Awareness (`y-protocols/awareness`) as
//   the presence CRDT" and I-002-3 names the "Yjs Awareness CRDT" as the live
//   surface. A `y-protocols/awareness` `Awareness` instance is fundamentally a
//   SINGLE-local-client holder: it borrows one numeric `clientID` from its
//   backing `Y.Doc`, and `setLocalState(...)` mutates only THAT client's slot
//   (`getStates()` maps `clientID -> state`). To aggregate MANY participants on
//   the server we therefore hold ONE `Awareness` per connected client-device
//   (Shape B), where each instance's local state IS that participant-device's
//   presence. This is the only CRDT-faithful server-side shape — a single
//   shared `Awareness` could only ever carry one local client's state — and it
//   lines up directly with the T3.2 cross-node fan-out, which serializes a
//   client's slot via `encodeAwarenessUpdate(awareness, [doc.clientID])` from
//   the same y-protocols module.
//
// ----------------------------------------------------------------------------
// SCOPE BOUNDARY — T3.1 is in-memory ingest ONLY; T3.2 extends THIS file
// ----------------------------------------------------------------------------
//
// The immediately-following task T3.2 extends this same service with (a)
// Postgres `LISTEN/NOTIFY` cross-node fan-out (ADR-008) and (b) the
// reconnect-grace window timer (45s grace -> `reconnecting` -> `offline`).
// T3.1 deliberately ships NEITHER:
//   * The constructor takes `options?: PresenceRegisterServiceOptions` whose
//     interface is intentionally EMPTY in T3.1. T3.2 widens it with the `pg`
//     pool handle (for LISTEN/NOTIFY) and the grace-window timing config —
//     callers constructing the service today pass nothing, and that call shape
//     stays source-compatible when T3.2 adds optional fields.
//   * The live state is held in the `#sessions` map below; T3.2's grace-window
//     timer sweeps that same map to drive the reconnecting/offline transitions
//     and to GC stale clients. T3.1 exposes only the explicit `forgetClient`
//     GC entry point; the timer that calls it on a grace-window expiry is
//     T3.2's.
//   * Heartbeats carrying `activityState: "offline"` (or `"reconnecting"`) are
//     accepted and STORED verbatim in T3.1 — the wire enum admits all four
//     `PresenceState` values (presence.ts:121) and the service must not reject
//     any. T3.1 does NOT itself transition a client toward offline or GC it on
//     an "offline" heartbeat; that timer-driven lifecycle is T3.2's. Storing
//     the carried state keeps the ingest path total without pulling T3.2's
//     reconnect machinery forward.
//
// The 15s heartbeat-interval / 45s grace-period timing constants (Plan-002
// line 113) are left to T3.2, where the timer that consumes them lives —
// defining them here unused would be dead surface in T3.1's diff.
//
// ----------------------------------------------------------------------------
// Cross-plan / cross-task boundaries (DO NOT CROSS in T3.1)
// ----------------------------------------------------------------------------
//
//   * No durable storage. This service writes NOTHING to SQLite or Postgres —
//     that is the load-bearing I-002-3 property (the Pr1 regression test pins
//     it: the service takes no `Querier`/`Pool` at all, and no presence-state
//     table exists in the schema). Audit-relevant presence transitions
//     (`presence.online/idle/reconnecting/offline`) are emitted as
//     `session_events` later (T3.3); that event log — not this live CRDT — is
//     the durable surface.
//   * No wire/transport layer. The JSON-RPC `PresenceUpdate` push and the
//     `PresenceRead` RPC binding are downstream (Plan-007-partial substrate +
//     later Phase 3 tasks); this service is the in-process ingest/query core.
//
// Refs: Spec-002 §Default Behavior (line 58), §State And Data Implications
// (line 157); Plan-002 §Phase 3, §Invariants I-002-3; ADR-008 (presence
// transport — the LISTEN/NOTIFY fan-out is T3.2);
// docs/architecture/contracts/api-payload-contracts.md §Tier 2 — Plan-002
// (PresenceHeartbeat / PresenceRead wire forms).

import type {
  ParticipantId,
  PresenceHeartbeat,
  PresenceReadResponse,
  PresenceReadResponseParticipant,
  PresenceState,
  SessionId,
} from "@ai-sidekicks/contracts";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

// --------------------------------------------------------------------------
// Awareness local-state shape — what each client's CRDT slot carries.
// --------------------------------------------------------------------------
//
// This is the value `setLocalState(...)` writes into the per-client Awareness
// slot and `getStates()` reads back. It mirrors the metadata the heartbeat
// carries (Spec-002 line 84) plus the resolved presence `state`. T3.2's
// `encodeAwarenessUpdate(awareness, [doc.clientID])` serializes exactly this
// object for cross-node fan-out, so the shape is shared across both tasks.
interface PresenceLocalState {
  readonly participantId: ParticipantId;
  readonly deviceId: string;
  readonly state: PresenceState;
  readonly deviceType: string;
  readonly focusedSessionId: SessionId | null;
  readonly focusedChannelId: ChannelIdOrNull;
  // Server-clock receipt time, NOT the wire `metadata.lastActivityAt`. See
  // `recordHeartbeat` for why the server clock is authoritative for `lastSeen`.
  readonly lastSeenAtMs: number;
  // Service-wide monotonic ingest order. Used SOLELY as the cross-device
  // recency tiebreaker in `readPresence` — `lastSeenAtMs` has only millisecond
  // resolution, so two heartbeats ingested in the same millisecond would tie on
  // the clock and make the projection order-dependent. The strictly-increasing
  // sequence makes "newest device wins" total and deterministic. It is NOT a
  // wire field (`lastSeen` still serializes from `lastSeenAtMs`).
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
// Per-client CRDT holder — one Y.Doc + Awareness per (session, participant,
// device) tuple (Shape B; see file header for why one-per-client is the only
// CRDT-faithful aggregation shape).
// --------------------------------------------------------------------------
interface ClientPresence {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
}

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
// Constructor options — T3.2 extension seam.
// --------------------------------------------------------------------------
//
// Intentionally EMPTY in T3.1. T3.2 widens this with the `pg` pool handle (for
// LISTEN/NOTIFY cross-node fan-out) and the reconnect-grace timing config. The
// interface exists now so the constructor signature
// (`new PresenceRegisterService(options?)`) is stable across the T3.1 -> T3.2
// boundary: today's callers pass nothing, and T3.2's added fields are all
// optional, so no existing construction site needs to change. The empty-object
// lint disable mirrors the established `XxxOptions {}` seam idiom in
// `packages/contracts/src/desktop-bridge.ts` (Tier 1 stubs widened later).
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PresenceRegisterServiceOptions {}

export class PresenceRegisterService {
  // Live presence state, in memory ONLY (I-002-3). Keyed session ->
  // clientKey(participant, device) -> { doc, awareness }. T3.2's grace-window
  // timer sweeps this same map; T3.1 mutates it on `recordHeartbeat` /
  // `forgetClient` only.
  readonly #sessions: Map<SessionId, Map<string, ClientPresence>> = new Map();

  // Service-wide monotonic ingest counter. Incremented on every
  // `recordHeartbeat` and stamped onto the stored `PresenceLocalState` as
  // `ingestSequence`. It is the cross-device recency tiebreaker in
  // `readPresence`: `lastSeenAtMs` (server `Date.now()`) has only millisecond
  // resolution, so two heartbeats ingested in the same tick would tie on the
  // clock and make "newest device wins" depend on `Map` iteration order. A
  // strictly-increasing integer makes the merge total and deterministic.
  // Service-wide (not per session/participant) is sufficient: the merge only
  // ever compares sequences WITHIN one participant's device set, and a single
  // counter cannot overflow `Number.MAX_SAFE_INTEGER` in any realistic runtime.
  //
  // T3.2 CROSS-NODE CAVEAT: this counter is PER-NODE. It is a correct tiebreak
  // only while every device of a participant is ingested by the SAME node (the
  // T3.1 single-node assumption). When T3.2 adds LISTEN/NOTIFY fan-out it will
  // serialize this whole local-state object (including `ingestSequence`) via
  // `encodeAwarenessUpdate` and apply it on peer nodes — at which point two
  // devices on different nodes carry sequences drawn from disjoint counter
  // spaces, so comparing them is meaningless. T3.2 MUST therefore either scope
  // this sequence comparison to local-origin clients only, or replace the
  // tiebreak with a cross-node-safe key (e.g. an `(originNodeId, lastSeenAtMs,
  // ingestSequence)` tuple or a hybrid logical clock). See the merge site in
  // `readPresence` for the exact comparison that needs revisiting.
  #ingestSequence: number = 0;

  // `options` is unused in T3.1 (the seam is empty) but is accepted so the
  // constructor shape is stable for T3.2. Referenced via a void statement to
  // satisfy `noUnusedParameters`/lint without a leading-underscore rename that
  // would change the public signature T3.2 inherits.
  constructor(options?: PresenceRegisterServiceOptions) {
    void options;
  }

  /**
   * Ingest a heartbeat into the in-memory Awareness CRDT for `sessionId`
   * (I-002-3 — no durable write occurs).
   *
   * The first heartbeat for a (participant, device) tuple lazily creates that
   * client's `Y.Doc` + `Awareness`; subsequent heartbeats update the same
   * client's local Awareness slot in place via `setLocalState(...)`. All four
   * `PresenceState` values are accepted and stored verbatim — including
   * `"offline"` and `"reconnecting"` — because the wire enum admits them
   * (presence.ts:121) and T3.1 must keep the ingest path total. T3.1 does NOT
   * transition a client toward offline or GC it on an "offline" heartbeat:
   * that timer-driven lifecycle is T3.2's (see file header §SCOPE BOUNDARY).
   *
   * `lastSeen` provenance: the server captures `Date.now()` at receipt and
   * stores it as `lastSeenAtMs`, rather than trusting the wire
   * `metadata.lastActivityAt`. Two reasons: (a) it defends against client
   * clock skew — a client with a wrong clock cannot forge a future/past
   * last-seen; (b) `lastActivityAt` is semantically "when the user last
   * interacted", which is distinct from "when the server last heard from the
   * client" (a client can heartbeat while idle, carrying a stale
   * `lastActivityAt`). The wire `lastActivityAt` is still preserved on the
   * stored state for downstream consumers that want the activity time.
   *
   * @param sessionId the session this presence belongs to. Presence is scoped
   *   per session (a participant present in two sessions has two independent
   *   Awareness slots).
   * @param heartbeat the validated `PresenceHeartbeat` (boundary validation via
   *   `PresenceHeartbeatSchema` is the transport layer's job; this in-process
   *   core trusts the typed input).
   */
  recordHeartbeat(sessionId: SessionId, heartbeat: PresenceHeartbeat): void {
    let clients: Map<string, ClientPresence> | undefined = this.#sessions.get(sessionId);
    if (clients === undefined) {
      clients = new Map<string, ClientPresence>();
      this.#sessions.set(sessionId, clients);
    }

    const key: string = clientKey(heartbeat.participantId, heartbeat.deviceId);
    let client: ClientPresence | undefined = clients.get(key);
    if (client === undefined) {
      // Lazily create this client's CRDT holder. Each Y.Doc mints its own
      // numeric clientID, which Awareness borrows — so every connected
      // client-device occupies a distinct Awareness slot.
      const doc: Y.Doc = new Y.Doc();
      const awareness: Awareness = new Awareness(doc);
      client = { doc, awareness };
      clients.set(key, client);
    }

    // Stamp a strictly-increasing ingest sequence so `readPresence`'s
    // most-recent-device merge is deterministic even when two heartbeats land
    // in the same `Date.now()` millisecond (see `#ingestSequence`).
    this.#ingestSequence += 1;
    const localState: PresenceLocalState = {
      participantId: heartbeat.participantId,
      deviceId: heartbeat.deviceId,
      state: heartbeat.activityState,
      deviceType: heartbeat.metadata.deviceType,
      focusedSessionId: heartbeat.metadata.focusedSessionId,
      focusedChannelId: heartbeat.metadata.focusedChannelId,
      lastSeenAtMs: Date.now(),
      ingestSequence: this.#ingestSequence,
      lastActivityAt: heartbeat.metadata.lastActivityAt,
      appVisible: heartbeat.metadata.appVisible,
    };
    // Write into THIS client's Awareness slot. `setLocalState` mutates only the
    // doc's own clientID entry — exactly the single-local-client semantics that
    // make Shape B (one Awareness per client) the correct aggregator.
    client.awareness.setLocalState(localState);
  }

  /**
   * Project the live in-memory presence for `sessionId` into the
   * `PresenceReadResponse` wire shape (one entry per participant).
   *
   * Multi-device aggregation: storage is keyed (participant, device), but the
   * contract returns one entry per PARTICIPANT. When a participant has live
   * heartbeats from multiple devices, the MOST-RECENTLY-INGESTED heartbeat wins
   * (highest `ingestSequence`) — both the reported `state` and the `lastSeen`
   * timestamp come from that newest device. The merge orders on the monotonic
   * `ingestSequence` rather than on `lastSeenAtMs` because the wall clock has
   * only millisecond resolution: two devices heartbeating in the same tick
   * would tie on `lastSeenAtMs`, making the winner depend on `Map` iteration
   * order. Spec-002 does not dictate a cross-device merge rule, so this choice
   * is named explicitly here to prevent drift in T3.2 / downstream: "most
   * recently heard-from device represents the participant".
   *
   * Reads only the live Awareness state (`getStates()`); performs no durable
   * read. A session with no live clients yields an empty `participants` array.
   *
   * @param sessionId the session to project.
   * @returns the per-participant presence projection.
   */
  readPresence(sessionId: SessionId): PresenceReadResponse {
    const clients: Map<string, ClientPresence> | undefined = this.#sessions.get(sessionId);
    if (clients === undefined) {
      return { participants: [] };
    }

    // Collapse (participant, device) -> participant, keeping the
    // most-recently-ingested device's state per participant (see docstring on
    // the merge rule). Ordered on the monotonic `ingestSequence`, never on the
    // millisecond-resolution `lastSeenAtMs`, so the winner is deterministic.
    // T3.2 NOTE: `ingestSequence` is a per-node counter — see the
    // `#ingestSequence` field comment for why this comparison needs a
    // cross-node-safe key once LISTEN/NOTIFY fan-out lands.
    const newestByParticipant: Map<ParticipantId, PresenceLocalState> = new Map();
    for (const client of clients.values()) {
      const local: PresenceLocalState | undefined = readLocalState(client.awareness);
      if (local === undefined) {
        // A client whose local state was cleared (e.g. set to null by a future
        // disconnect path) contributes nothing to the projection.
        continue;
      }
      const existing: PresenceLocalState | undefined = newestByParticipant.get(local.participantId);
      if (existing === undefined || local.ingestSequence > existing.ingestSequence) {
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
   * Garbage-collect a single (session, participant, device) client's live
   * presence — the explicit hard-disconnect entry point.
   *
   * Clears the client's Awareness slot (`setLocalState(null)`), then destroys
   * the `Awareness` and its backing `Y.Doc` and drops the map entry; an emptied
   * session map is removed too so a churned session leaves no residual key. This
   * is the GC primitive only — the TIMER that calls it on a reconnect-grace-
   * window expiry (45s) is T3.2's. T3.1 exposes it so a caller observing a
   * definite disconnect can release the in-memory state immediately, preserving
   * the I-002-3 "garbage-collected on disconnect" property without T3.2's timer.
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
    // Mark this client offline in the CRDT (null local state) before tearing
    // down — the y-protocols-documented "propagate a null state before
    // disconnect" convention — then destroy the Awareness (releasing its
    // internal check-interval timer) and the backing Y.Doc (releasing its
    // clientID slot).
    client.awareness.setLocalState(null);
    client.awareness.destroy();
    client.doc.destroy();
    clients.delete(key);
    if (clients.size === 0) {
      this.#sessions.delete(sessionId);
    }
    return true;
  }
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

// Read a client's own local Awareness slot back into the typed
// `PresenceLocalState`. `Awareness#getLocalState()` returns
// `Record<string, any> | null`; we narrow it through `unknown` and `typeof`-
// check the discriminating fields (participantId / deviceId / state /
// lastSeenAtMs / ingestSequence) rather than trusting the `any`, then cast the
// whole object. This guards against accidental shape drift on the untyped CRDT
// read-back — it is NOT a full foreign-writer defense: it `typeof`-checks 5 of
// the fields and does not assert `state` against the 4-value `PresenceState`
// enum. That is sufficient for T3.1, where the ONLY writer is `recordHeartbeat`
// (which writes a well-typed object) and `getLocalState()` reads back that same
// slot. Full revalidation (enum membership on `state`, all-field checks) lands
// with T3.2's cross-node `applyAwarenessUpdate` fan-out — the first path that
// admits state written by a foreign node.
function readLocalState(awareness: Awareness): PresenceLocalState | undefined {
  const raw: unknown = awareness.getLocalState();
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  const participantId = candidate["participantId"];
  const deviceId = candidate["deviceId"];
  const state = candidate["state"];
  const lastSeenAtMs = candidate["lastSeenAtMs"];
  const ingestSequence = candidate["ingestSequence"];
  if (
    typeof participantId !== "string" ||
    typeof deviceId !== "string" ||
    typeof state !== "string" ||
    typeof lastSeenAtMs !== "number" ||
    typeof ingestSequence !== "number"
  ) {
    return undefined;
  }
  // The remaining fields are projected straight through; they were written as
  // a unit with the discriminators above, so a shape that passed the checks
  // carries them. Cast the whole object once now that the discriminators hold.
  return raw as PresenceLocalState;
}
