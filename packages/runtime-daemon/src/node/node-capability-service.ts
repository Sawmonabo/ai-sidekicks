// NodeCapabilityService — capability declaration + change-detected update
// emission (Plan-003 Phase 2, T2.2) + the I-003-2 `online` ordering gate (T2.4).
//
// Persists a node's declared capabilities to `node_capabilities` (PK
// `node_id + capability_key`) and emits the matching session event:
//   * FIRST declaration of a capability   → `runtime_node.capability_declared`
//   * CHANGE to an already-declared one    → `runtime_node.capability_updated`
//   * IDENTICAL re-declare                  → idempotent no-op (NO write, NO event)
// The idempotent path is what keeps the timeline free of spurious update spam:
// `updated_at` reflects the last actual CHANGE, not the last time the node
// re-sent the same details.
//
// `bringOnline` (T2.4) gates the `runtime_node.online` emission on a prior
// declaration: it reads the node-keyed `node_capabilities` ROW (NOT a
// `capability_declared` event), emits `online` IFF a declaration exists, and
// performs no durable write (online is event-sourced, not a daemon-durable
// state in Phase 2). The gate is node-scoped; the emitted online event is
// session-scoped (Model B). The full rationale lives on the method below.
//
// "Validate the capability declaration" (plan §341 / `Spec-003 §Default Behavior`) means a
// SCHEMA-VALID declaration, NOT an allow-list of known keys: Spec-003's
// least-privilege rule is that only explicitly declared capabilities are
// schedulable — the declaration IS the schedulability allow-list, there is no
// separate registry of known keys to check against. The emitter's `.parse()`
// boundary (the capability payload schema) is the declaration validation; this
// service persists what is declared.
//
// Dual-write with single-transaction atomicity
// --------------------------------------------------------------------------
// `node_capabilities` is the durable node-keyed state; the
// `runtime_node.capability_*` row in `session_events` is the TIMELINE. Each
// declare that actually changes state is a DUAL-WRITE (upsert the table AND
// emit the event) wrapped in ONE `better-sqlite3` `db.transaction(...)` over the
// same handle, so the row and the event commit atomically — a non-atomic
// dual-write would ship a partial-state corruption bug. The transaction is
// prepared ONCE in the constructor; its BODY ORDER is load-bearing (upsert
// FIRST, then emit) so a throwing emit rolls back the upsert. The emitter's
// append runs on this same connection, so its INSERT joins the transaction.
//
// Change-detection normalization (load-bearing)
// --------------------------------------------------------------------------
// The STORED side is necessarily JSON-round-tripped — it comes out of the
// `capability_value` TEXT column. The INCOMING side is a raw object.
// `JSON.stringify` strips `undefined`-valued keys, so comparing raw-incoming
// against round-tripped-stored gives a FALSE "changed" verdict on an identical
// re-declare (e.g. first declare `{a:1, b:undefined}` stores `'{"a":1}'`; an
// identical re-declare's raw `{a:1, b:undefined}` would mis-compare against the
// stored `{a:1}`). Fix: normalize BOTH sides identically — compare
// `JSON.parse(stored)` against `JSON.parse(JSON.stringify(incoming))`, and STORE
// `JSON.stringify(incoming)` (the normalized form) so the next re-declare's
// stored side is already normalized. Compare with `node:util.isDeepStrictEqual`
// (structural + key-order-insensitive) — NOT a raw `JSON.stringify` byte-compare
// (key-order-fragile → spurious update spam) and NOT a canonical-serialization
// (JCS) dependency (canonical SERIALIZATION is a hashing/signing concern owned
// by Plan-006 Tier 4's `EventEnvelope`, not an equality concern here; adding a
// JCS dep would pre-empt that ownership for zero benefit).
//
// `sessionId` is threaded to the EMIT only — never stored. `node_capabilities`
// has no `session_id` column; `capability` maps to `capability_key`,
// `capabilityDetails` to the `capability_value` JSON column.
//
// Refs: Plan-003 (Runtime Node Attach) §Phase 2 / T2.2 + T2.4, Spec-003 line 57
// (online only after capability declaration — the T2.4 gate), line 58
// (least-privilege schedulability), line 92 (capability/trust changes emitted as
// session events), line 115 (no implicit capability exposure on attach), line 133
// (serial re-attach satisfies the node-scoped gate without re-declaring),
// Spec-006 lines 403 (online payload), 379-380 (capability_declared /
// capability_updated payload shapes), invariant I-003-2 (the declaration is the
// precondition that gates `online`).

import { isDeepStrictEqual } from "node:util";

import type { Database, Statement } from "better-sqlite3";

import type { RuntimeNodeEventEmitter } from "./node-event-emitter.js";

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

/**
 * `declare` input. `sessionId` is threaded to the emit only (never stored).
 * `capability` is the `capability_key`; `capabilityDetails` becomes the
 * `capability_value` JSON snapshot. `actor` defaults to `null` (system actor)
 * when omitted.
 */
export interface DeclareCapabilityInput {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly capability: string;
  readonly capabilityDetails: Record<string, unknown>;
  readonly actor?: string | null;
}

// Private row shape for the SELECT that decides first-declare vs. change.
interface CapabilityValueRow {
  readonly capability_value: string;
}

// --------------------------------------------------------------------------
// NodeCapabilityService
// --------------------------------------------------------------------------

export class NodeCapabilityService {
  // Only prepared statements + the prepared transaction wrapper are retained
  // (mirrors SessionService / NodeRegistry — the raw `db` handle is NOT stored).
  // A single UPSERT statement serves BOTH the first-declare and the changed
  // branches (only the emit call differs); the SELECT decides which branch runs.
  readonly #selectCapabilityStmt: Statement;
  readonly #upsertCapabilityStmt: Statement;
  readonly #nodeHasAnyCapabilityStmt: Statement;
  readonly #declareTxn: (input: DeclareCapabilityInput) => void;
  // The same single emission seam the `declare` paths route through, retained so
  // `bringOnline` (T2.4) can emit `runtime_node.online` without re-deriving the
  // event-construction path. `declare`'s transaction captures `emitter` in its
  // closure; `bringOnline` is a non-transactional SELECT + conditional emit, so
  // it needs the reference on the instance.
  readonly #emitter: RuntimeNodeEventEmitter;

  constructor(
    db: Database,
    emitter: RuntimeNodeEventEmitter,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#emitter = emitter;
    // Change-detection is NODE-scoped BY THE SCHEMA: `node_capabilities` is PK
    // (node_id, capability_key) with NO session_id column (0002-runtime-node.ts),
    // and the plan forbids adding one — so session-scoping the dedup is not even
    // implementable, and an identical re-declare of a capability is a no-op
    // regardless of session (capabilities are a NODE property, not a session one;
    // plan §341 forbids the per-session update spam session-scoping would produce).
    // The daemon-side I-003-2 `online` gate (T2.4) is correspondingly node-scoped:
    // it reads THIS durable row ("has this node declared?"), satisfied across serial
    // re-attaches (`Spec-003 §Resolved Questions and V1 Scope Decisions`) — it does NOT scan a per-session capability_declared
    // event stream (which this node-keyed dedup would starve).
    this.#selectCapabilityStmt = db.prepare(
      `SELECT capability_value
         FROM node_capabilities
        WHERE node_id = @node_id AND capability_key = @capability_key`,
    );
    // UPSERT `node_capabilities`. First declare → INSERT; change → UPDATE the
    // stored JSON + `updated_at`. `capability_value` stores the NORMALIZED form
    // (`JSON.stringify` of the incoming details) so the next re-declare's stored
    // side is already in the comparison's normal form.
    this.#upsertCapabilityStmt = db.prepare(
      `INSERT INTO node_capabilities (node_id, capability_key, capability_value, updated_at)
       VALUES (@node_id, @capability_key, @capability_value, @now)
       ON CONFLICT(node_id, capability_key)
         DO UPDATE SET capability_value = excluded.capability_value,
                       updated_at       = excluded.updated_at`,
    );

    // The I-003-2 `online` gate (T2.4) — "has this node declared AT LEAST ONE
    // capability anywhere?". DELIBERATELY node-scoped only: no `session_id` (the
    // table has no such column — 0002-runtime-node.ts) and NO `AND capability_key`
    // (any declared capability satisfies the gate, not a specific one). `SELECT 1
    // ... LIMIT 1` is an existence probe — we need the boolean presence of a row,
    // never its value, so this is intentionally distinct from `#selectCapabilityStmt`
    // (which reads a SPECIFIC capability's `capability_value` to decide first-declare
    // vs. change). Reading the durable ROW — not a `capability_declared` EVENT — is
    // the whole point of the gate (see `bringOnline`): an identical re-declare is a
    // node-keyed no-op that emits NO event (Model B), so a node that already declared
    // (row present) but re-declares as a no-op must still online. Gating on the event
    // would resurface Model A at the emission layer; gating on the row makes
    // "has this node declared?" correct across serial re-attaches (`Spec-003 §Resolved Questions and V1 Scope Decisions`).
    this.#nodeHasAnyCapabilityStmt = db.prepare(
      `SELECT 1 FROM node_capabilities WHERE node_id = @node_id LIMIT 1`,
    );

    // Prepare the declare transaction once. Body order is load-bearing: when a
    // write happens, upsert FIRST then emit, so a throwing emit rolls back the
    // upsert. The identical-re-declare path returns WITHOUT writing or emitting.
    this.#declareTxn = db.transaction((input: DeclareCapabilityInput): void => {
      const existingRow: CapabilityValueRow | undefined = this.#selectCapabilityStmt.get({
        node_id: input.nodeId,
        capability_key: input.capability,
      }) as CapabilityValueRow | undefined;

      // Normalize the incoming side through a JSON round-trip so it is compared
      // (and emitted) in the SAME shape the stored side necessarily has — this
      // is what makes an identical re-declare with an `undefined`-valued key (or
      // reordered keys) correctly read as "unchanged".
      const normalizedIncoming: Record<string, unknown> = JSON.parse(
        JSON.stringify(input.capabilityDetails),
      ) as Record<string, unknown>;
      const capabilityValue: string = JSON.stringify(input.capabilityDetails);

      if (existingRow === undefined) {
        // First declaration of this capability.
        this.#upsertCapabilityStmt.run({
          node_id: input.nodeId,
          capability_key: input.capability,
          capability_value: capabilityValue,
          now: now(),
        });
        emitter.emitCapabilityDeclared({
          sessionId: input.sessionId,
          nodeId: input.nodeId,
          capability: input.capability,
          capabilityDetails: normalizedIncoming,
          actor: input.actor ?? null,
        });
        return;
      }

      const priorDetails: Record<string, unknown> = JSON.parse(
        existingRow.capability_value,
      ) as Record<string, unknown>;

      if (isDeepStrictEqual(priorDetails, normalizedIncoming)) {
        // Identical re-declare — idempotent: no write, no event. `updated_at`
        // stays at the last actual change, NOT the last-seen time. Structural
        // (key-order-insensitive) equality on BOTH-sides-normalized values.
        return;
      }

      // Changed: persist the new snapshot and emit the prior + new snapshots.
      this.#upsertCapabilityStmt.run({
        node_id: input.nodeId,
        capability_key: input.capability,
        capability_value: capabilityValue,
        now: now(),
      });
      emitter.emitCapabilityUpdated({
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        capability: input.capability,
        previousState: priorDetails,
        newState: normalizedIncoming,
        actor: input.actor ?? null,
      });
    });
  }

  /**
   * Declare (or re-declare) a node capability. Atomic dual-write on the paths
   * that mutate state (first declaration and change); an identical re-declare
   * is an idempotent no-op (no write, no event). Synchronous —
   * better-sqlite3 is synchronous by design.
   */
  declare(input: DeclareCapabilityInput): void {
    this.#declareTxn(input);
  }

  /**
   * Bring a node `online` — the I-003-2 ordering gate (Plan-003 §Phase 2 / T2.4).
   * Emits `runtime_node.online` (the registering→online transition) IFF the node
   * has previously declared at least one capability; before declaration succeeds
   * the node remains in its non-online (`registering`) state (`Spec-003 §Default Behavior`). Returns
   * `true` when the gate is satisfied and the event was emitted, `false` when no
   * declaration exists (no event emitted).
   *
   * GATE READS THE DURABLE ROW, NOT THE EVENT (this is the whole point — §357):
   * the probe is `#nodeHasAnyCapabilityStmt` ("has this node declared anywhere?"),
   * NOT a scan for a `runtime_node.capability_declared` event. An identical
   * re-declare is a node-keyed no-op that emits NO `capability_declared` event
   * (T2.2 / Model B), so a node that already declared (row present) but re-declares
   * as a no-op would NEVER online if the gate keyed on the event — Model A
   * resurfacing at the emission layer. Keying on the durable ROW makes
   * "has this node declared?" correct across serial re-attaches (`Spec-003 §Resolved Questions and V1 Scope Decisions`),
   * consistent with T2.2's node-scoped change-detection dedup. The control-plane
   * attach gate (T3.2) is a DISTINCT surface reading relayed events, not this
   * daemon-local table.
   *
   * NODE-SCOPED GATE, SESSION-SCOPED TIMELINE (Model B): the gate is node-scoped
   * (the node-keyed `node_capabilities` row, no `session_id`), but the EMITTED
   * `runtime_node.online` event is session-scoped — it carries `input.sessionId`
   * as the per-session partition/sequence key, so the online transition lands on
   * the timeline of the session this attach describes. A node that already declared
   * thus satisfies the gate on a re-attach to a DIFFERENT session and onlines onto
   * that session's timeline without re-declaring.
   *
   * NO DURABLE WRITE, NO TRANSACTION: `online` is NOT a daemon-durable state in
   * Phase 2 — there is no node-table column for liveness; it is event-sourced via
   * the online event. So `bringOnline` is a SELECT + a single conditional emit,
   * deliberately NOT wrapped in `db.transaction(...)` (unlike `declare`, whose
   * dual-write of the durable row + event needs single-transaction atomicity). The
   * emit is the only side effect on the satisfied path.
   *
   * NO "ALREADY ONLINE" SUPPRESSION (intentional, not an oversight): there is no
   * durable online state to check against, so this primitive does not de-duplicate
   * repeat onlines — once-per-attach is the Phase-3 caller's contract, not this
   * gated primitive's. `bringOnline` is a STANDALONE gate a caller invokes; it does
   * not sequence register→declare→online (that orchestration, and any
   * online-on-reconnect logic, is Phase 3 / T3.x).
   */
  bringOnline(input: {
    readonly nodeId: string;
    readonly sessionId: string;
    readonly actor?: string | null;
  }): boolean {
    // Existence probe (presence, never the value): `.get()` returns the `SELECT 1`
    // row when ≥1 declaration exists and `undefined` when none — and THROWS on a
    // real DB error, so a `false` return is only ever the legitimate "not declared"
    // verdict, never a swallowed failure.
    const hasDeclaredCapability: boolean =
      this.#nodeHasAnyCapabilityStmt.get({ node_id: input.nodeId }) !== undefined;
    if (!hasDeclaredCapability) {
      // The I-003-2 precondition is unmet: emit nothing, the node stays in its
      // non-online (registering) state (`Spec-003 §Default Behavior`).
      return false;
    }
    // The durable declaration row exists → emit the registering→online transition
    // onto this session's timeline. The GATE is node-scoped; the EMITTED event is
    // session-scoped (Model B). `actor` forwards as `?? null` so an omitted actor
    // becomes the system-null actor (the emitter input rejects explicit-`undefined`
    // under `exactOptionalPropertyTypes`).
    this.#emitter.emitOnline({
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      previousState: "registering",
      newState: "online",
      actor: input.actor ?? null,
    });
    return true;
  }
}
