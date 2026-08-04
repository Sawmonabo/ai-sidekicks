// NodeRegistry — durable node identity + registration (Plan-003 Phase 2, T2.1)
// + the explicit-shutdown detach producer (T2.5).
//
// A node is "registered to this daemon" iff a `node_trust_state` row (PK
// `node_id`, `trust_level DEFAULT 'untrusted'`) exists for it. That row is the
// AUTHORITATIVE durable state: `lookup` recovers identity by READING the row,
// not by replaying events, so identity is stable across a daemon restart
// because it lives in SQLite, not in process memory (D1 — plan §334).
//
// `detach` (T2.5) emits `runtime_node.offline` (`reason: "explicit_shutdown"`)
// and LEAVES the `node_trust_state` row INTACT — the untouched row is what lets
// the node reconnect under the same `node_id` (I-003-3: detach does not revoke
// membership). It is an emit-only path (no durable write, no transaction); the
// full rationale lives on the method below.
//
// Dual-write with single-transaction atomicity
// --------------------------------------------------------------------------
// `node_trust_state` is the durable node-keyed state; the parallel
// `runtime_node.registered` row in `session_events` is the collaboration
// TIMELINE. Every `register` is therefore a DUAL-WRITE: upsert the node-keyed
// table AND emit the session-scoped event. Both writes target the same local
// SQLite handle and commit in ONE transaction. A non-atomic dual-write would
// ship a latent partial-state corruption bug (a trust row with no event, or an
// event with no row); the transaction is what forecloses it.
//
// WHO OWNS THAT TRANSACTION CHANGED with Plan-006 T3.1's re-point, and the
// atomicity was re-established rather than dropped. This class used to open the
// transaction itself and emit inside it; the durable append path is async now
// (it awaits a signing-key unseal) and a better-sqlite3 transaction cannot span
// an `await`. So the upsert is handed DOWN as `transactionalPrelude`, which
// `EventLogService.append` runs inside the same transaction as the event-row
// INSERT, immediately BEFORE it.
//
// The BODY ORDER is preserved exactly — upsert FIRST, event row LAST — so a
// throwing INSERT still rolls back the upsert. What IMPROVED: a refusal raised
// before the transaction opens (the ingest-halt gate, a signing failure) means
// the prelude never runs at all, which is stronger than rolling it back. No
// `register` path can now leave a trust row without its event.
//
// What is threaded vs. stored
// --------------------------------------------------------------------------
// `sessionId` / `nodeVersion` / `platform` are wire-only fields carried to the
// EMIT and recovered by event replay — `node_trust_state` has no column for
// them and the plan forbids adding one (the table is node-keyed, not
// session-keyed). Registration does NOT elevate trust: `trust_level` stays at
// the schema default `'untrusted'`; trust elevation is a separate
// Phase-3/approval concern, so `register` takes no `trust_level` param.
//
// Refs: Plan-003 (Runtime Node Attach) §Phase 2 / T2.1 + T2.5, `Spec-003 §Fallback Behavior`
// (disconnected node keeps membership; reconnect under same identity — the T2.5
// detach guarantee), `Spec-003 §State And Data Implications` (durable
// runtime-node records for reconnect + audit),
// `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`
// (`runtime_node.registered` + `runtime_node.offline` payload shapes), invariant I-003-3
// (registration records a node without mutating membership; detach does not
// revoke membership).

import type { NodeState } from "@ai-sidekicks/contracts";
import type { Database, Statement } from "better-sqlite3";

import type { RuntimeNodeEventEmitter } from "./node-event-emitter.js";

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

/**
 * The durable `node_trust_state` row — the authoritative "is this node
 * registered" record. Mirrors the migration column shape
 * (`0002-runtime-node.ts`): every column is `TEXT`, so no `safeIntegers`
 * concern applies (that was a `session_events.monotonic_ns` matter only).
 */
export interface NodeTrustStateRow {
  readonly node_id: string;
  readonly trust_level: string;
  readonly established_at: string;
  readonly updated_at: string;
}

/**
 * `register` input. `sessionId`/`nodeVersion`/`platform` are wire-only (emit +
 * replay), never persisted to `node_trust_state`. `actor` defaults to `null`
 * (system actor) when omitted.
 */
export interface RegisterNodeInput {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly capabilities: Record<string, unknown>;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly actor?: string | null;
}

/**
 * `detach` input (Plan-003 §Phase 2 / T2.5). The explicit-shutdown producer for
 * `runtime_node.offline`.
 *
 * `reason` is NOT a parameter: detach IS the explicit-shutdown producer, so the
 * emitted `reason` is HARDCODED `"explicit_shutdown"`. The `heartbeat_lost` /
 * `network_partition` reasons are server-derived (staleness sweep): a V1
 * coordination-record transition, durable event V1.1-gated (ADR-017), never this
 * method (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` authors the full enum; V1.1 adds a producer, not a shape).
 *
 * `previousState` is forwarded as-supplied (omitted from the payload when
 * `undefined` — the method invents NO default; the explicit-shutdown call site
 * supplies `"online"`). `lastHeartbeatAt` defaults to `now()` when omitted (the
 * node IS heard from at explicit shutdown → a real ISO-8601 timestamp, never
 * null). `actor` defaults to `null` (system actor) when omitted.
 */
export interface DetachNodeInput {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly actor?: string | null;
  readonly previousState?: NodeState;
  readonly lastHeartbeatAt?: string;
}

// --------------------------------------------------------------------------
// NodeRegistry
// --------------------------------------------------------------------------

export class NodeRegistry {
  // Only the prepared statements + the prepared transaction wrapper are
  // retained (mirrors SessionService — the raw `db` handle is NOT stored; a
  // prepared statement internally keeps its parent connection alive).
  readonly #upsertTrustStateStmt: Statement;
  readonly #selectTrustStateStmt: Statement;
  // The single emission seam BOTH paths route through. `register` hands it a
  // `transactionalPrelude`; `detach` emits with none (no durable write).
  readonly #emitter: RuntimeNodeEventEmitter;
  // Wall-clock source reused for `detach`'s default `lastHeartbeatAt` — the same
  // injected `now` the registration upsert uses, so a test's deterministic clock
  // governs both paths.
  readonly #now: () => string;

  constructor(
    db: Database,
    emitter: RuntimeNodeEventEmitter,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#emitter = emitter;
    this.#now = now;
    // UPSERT `node_trust_state`. On first registration: INSERT with
    // `trust_level='untrusted'` (the schema default, spelled explicitly so the
    // intent is visible) and `established_at = updated_at = now`. On
    // re-registration (PK conflict): UPDATE ONLY `updated_at` — `established_at`
    // and `trust_level` are PRESERVED (re-register must not reset the first-seen
    // timestamp, and registration never elevates trust). `excluded.updated_at`
    // is the value from the attempted INSERT, i.e. the fresh `now`.
    this.#upsertTrustStateStmt = db.prepare(
      `INSERT INTO node_trust_state (node_id, trust_level, established_at, updated_at)
       VALUES (@node_id, 'untrusted', @now, @now)
       ON CONFLICT(node_id) DO UPDATE SET updated_at = excluded.updated_at`,
    );
    this.#selectTrustStateStmt = db.prepare(
      `SELECT node_id, trust_level, established_at, updated_at
         FROM node_trust_state
        WHERE node_id = ?`,
    );
  }

  /**
   * Register a node (or refresh an already-registered node) and emit
   * `runtime_node.registered`. Atomic: the `node_trust_state` upsert and the
   * event row either both commit or neither does.
   *
   * ASYNC because the durable append path is (its per-session mutex and its
   * signing-key unseal). The upsert travels as `transactionalPrelude` — see the
   * file header for why that is where the atomicity now lives.
   */
  async register(input: RegisterNodeInput): Promise<void> {
    await this.#emitter.emitRegistered({
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      // `registering` is the initial lifecycle state (the node has joined and
      // is completing capability declaration — `docs/domain/runtime-node-model.md §State Model` /
      // NodeStateSchema). `previousState` is intentionally OMITTED: registration
      // is the FIRST lifecycle event, so there is no prior state to report.
      // Omitting the key keeps it absent from the parsed payload (the happy-path
      // test asserts `not.toHaveProperty("previousState")`). The emitter input
      // types it `previousState?: NodeState | undefined`, so an explicit
      // `undefined` would type-check too — omission is simply the cleaner intent.
      newState: "registering",
      capabilities: input.capabilities,
      nodeVersion: input.nodeVersion,
      platform: input.platform,
      // Forward `actor` as `?? null` so an omitted (`undefined`) actor becomes
      // the system-null actor (the emitter input rejects explicit-`undefined`
      // under `exactOptionalPropertyTypes`).
      actor: input.actor ?? null,
      // The durable half of the dual-write, run inside the append's transaction
      // immediately BEFORE the event-row INSERT. `this.#now()` is read HERE, in
      // the transaction, exactly where it was read when this class owned the
      // transaction — so an injected clock still governs the persisted
      // timestamps and nothing observes a `now` from before a queued append.
      transactionalPrelude: () => {
        this.#upsertTrustStateStmt.run({ node_id: input.nodeId, now: this.#now() });
      },
    });
  }

  /**
   * Detach a node (Plan-003 §Phase 2 / T2.5). Emits `runtime_node.offline`
   * (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`) for the explicit-shutdown trigger and LEAVES THE
   * `node_trust_state` REGISTRATION ROW INTACT, so the node can reconnect under
   * the same `node_id` (`Spec-003 §Fallback Behavior` — a disconnected node keeps membership;
   * `Spec-003 §Implementation Notes` — node identity stable across reconnect). This is the I-003-3
   * guarantee that detach does not revoke membership.
   *
   * LEAVE-INTACT (no durable write, no transaction): `detach` does NOT
   * update/delete/insert `node_trust_state` — it is `emitOffline` ONLY. The
   * untouched trust row is precisely what lets `lookup` resolve the SAME identity
   * on reconnect (`established_at` preserved from the first registration). Because
   * there is no dual-write here, there is no atomicity concern, so — unlike
   * `register` — this is NOT wrapped in `db.transaction(...)`.
   *
   * HARDCODED `reason: "explicit_shutdown"`: detach IS the explicit-shutdown
   * producer, so the reason is not a parameter. The `heartbeat_lost` /
   * `network_partition` reasons come from a DIFFERENT Phase-3 heartbeat-service
   * producer, not this method (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` authors the full enum so Phase 3 adds
   * producers, not a shape change). `lastHeartbeatAt` defaults to the injected
   * `now()` — the node IS heard from at explicit shutdown, so this is a real
   * ISO-8601 timestamp, never null (the schema is `z.iso.datetime({ offset: true })`).
   * `previousState` is forwarded as the caller supplies it (the method invents no
   * default; an omitted value is left off the parsed payload — the explicit-shutdown
   * call site supplies `"online"`). `actor` forwards as `?? null` so an omitted actor
   * becomes the system-null actor (the emitter input rejects explicit-`undefined`
   * under `exactOptionalPropertyTypes`). ASYNC because the durable append path
   * is — there is still no durable write here and so no prelude, but the emit
   * must be awaited for its failure to reach the caller.
   */
  async detach(input: DetachNodeInput): Promise<void> {
    await this.#emitter.emitOffline({
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      // Forwarded as-supplied; omission keeps the key absent from the parsed
      // payload (the emitter input types `previousState?: NodeState | undefined`).
      previousState: input.previousState,
      newState: "offline",
      actor: input.actor ?? null,
      // The node IS heard from at explicit shutdown → default to the real wall
      // clock, never null (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` / `z.iso.datetime`).
      lastHeartbeatAt: input.lastHeartbeatAt ?? this.#now(),
      // HARDCODED — detach is the explicit-shutdown producer; heartbeat-driven
      // reasons are a Phase-3 producer, not this method.
      reason: "explicit_shutdown",
    });
  }

  /**
   * Look up a node's durable trust-state row. Returns `undefined` when the node
   * is not registered ("registered iff a row exists"). This is the recovery
   * path proven by D1: after a daemon restart, identity is recovered by READING
   * this row, not by replaying events.
   */
  lookup(nodeId: string): NodeTrustStateRow | undefined {
    return this.#selectTrustStateStmt.get(nodeId) as NodeTrustStateRow | undefined;
  }
}
