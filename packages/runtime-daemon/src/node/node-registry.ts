// NodeRegistry — durable node identity + registration (Plan-003 Phase 2, T2.1).
//
// A node is "registered to this daemon" iff a `node_trust_state` row (PK
// `node_id`, `trust_level DEFAULT 'untrusted'`) exists for it. That row is the
// AUTHORITATIVE durable state: `lookup` recovers identity by READING the row,
// not by replaying events, so identity is stable across a daemon restart
// because it lives in SQLite, not in process memory (D1 — plan §334).
//
// Dual-write with single-transaction atomicity
// --------------------------------------------------------------------------
// `node_trust_state` is the durable node-keyed state; the parallel
// `runtime_node.registered` row in `session_events` is the collaboration
// TIMELINE. Every `register` is therefore a DUAL-WRITE: upsert the node-keyed
// table AND emit the session-scoped event. Both writes target the same local
// SQLite handle, so they are wrapped in ONE `better-sqlite3` `db.transaction(...)`
// and commit atomically. A non-atomic dual-write would ship a latent
// partial-state corruption bug (a trust row with no event, or an event with no
// row); the transaction is what forecloses it.
//
// The transaction is prepared ONCE in the constructor (better-sqlite3's
// prepare-the-transaction-once idiom) capturing the prepared statements + the
// emitter. The BODY ORDER is load-bearing: the table upsert runs FIRST, then
// the emit — so a throwing emit (e.g. a sequence-allocation failure) rolls back
// the upsert that already ran inside the transaction. The emitter's `append`
// executes on this same connection, so its INSERT participates in this
// transaction (better-sqlite3 transactions are connection-level).
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
// Refs: Plan-003 (Runtime Node Attach) §Phase 2 / T2.1, Spec-003 line 78
// (durable runtime-node records), line 90 (node identity stable across
// reconnect), Spec-006 line 374 (`runtime_node.registered` payload shape),
// invariant I-003-3 (registration records a node without mutating membership).

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

// --------------------------------------------------------------------------
// NodeRegistry
// --------------------------------------------------------------------------

export class NodeRegistry {
  // Only the prepared statements + the prepared transaction wrapper are
  // retained (mirrors SessionService — the raw `db` handle is NOT stored; a
  // prepared statement internally keeps its parent connection alive).
  readonly #upsertTrustStateStmt: Statement;
  readonly #selectTrustStateStmt: Statement;
  readonly #registerTxn: (input: RegisterNodeInput) => void;

  constructor(
    db: Database,
    emitter: RuntimeNodeEventEmitter,
    now: () => string = () => new Date().toISOString(),
  ) {
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

    // Prepare the dual-write transaction once. Body order is load-bearing:
    // upsert the durable table FIRST, then emit — so a throwing emit rolls back
    // the upsert that already ran in this transaction. The emitter's append runs
    // on the SAME connection, so its INSERT joins this transaction.
    this.#registerTxn = db.transaction((input: RegisterNodeInput): void => {
      this.#upsertTrustStateStmt.run({ node_id: input.nodeId, now: now() });
      emitter.emitRegistered({
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        // `registering` is the initial lifecycle state (the node has joined and
        // is completing capability declaration — runtime-node-model.md:48 /
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
      });
    });
  }

  /**
   * Register a node (or refresh an already-registered node) and emit
   * `runtime_node.registered`. Atomic: the `node_trust_state` upsert and the
   * event emit either both commit or both roll back. Synchronous —
   * better-sqlite3 is synchronous by design.
   */
  register(input: RegisterNodeInput): void {
    this.#registerTxn(input);
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
