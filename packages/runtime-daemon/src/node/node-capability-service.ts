// NodeCapabilityService — capability declaration + change-detected update
// emission (Plan-003 Phase 2, T2.2).
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
// "Validate the capability declaration" (plan §341 / Spec-003:58) means a
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
// Refs: Plan-003 (Runtime Node Attach) §Phase 2 / T2.2, Spec-003 line 58
// (least-privilege schedulability), line 79 (capability/trust changes emitted as
// session events), line 96 (no implicit capability exposure on attach),
// Spec-006 lines 379-380 (capability_declared / capability_updated payload
// shapes), invariant I-003-2 (the declaration is the precondition that gates
// `online`).

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
  readonly #declareTxn: (input: DeclareCapabilityInput) => void;

  constructor(
    db: Database,
    emitter: RuntimeNodeEventEmitter,
    now: () => string = () => new Date().toISOString(),
  ) {
    // Change-detection is NODE-scoped BY THE SCHEMA: `node_capabilities` is PK
    // (node_id, capability_key) with NO session_id column (0002-runtime-node.ts),
    // and the plan forbids adding one — so session-scoping the dedup is not even
    // implementable, and an identical re-declare of a capability is a no-op
    // regardless of session (capabilities are a NODE property, not a session one;
    // plan §341 forbids the per-session update spam session-scoping would produce).
    // The daemon-side I-003-2 `online` gate (T2.4) is correspondingly node-scoped:
    // it reads THIS durable row ("has this node declared?"), satisfied across serial
    // re-attaches (Spec-003:114) — it does NOT scan a per-session capability_declared
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
}
