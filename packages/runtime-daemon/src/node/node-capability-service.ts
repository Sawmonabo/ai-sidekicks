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
// Refs: Plan-003 (Runtime Node Attach) §Phase 2 / T2.2 + T2.4, `Spec-003 §Default Behavior`
// (online only after capability declaration — the T2.4 gate;
// least-privilege schedulability), `Spec-003 §State And Data Implications`
// (capability/trust changes emitted as session events),
// `Spec-003 §Pitfalls To Avoid` (no implicit capability exposure on attach;
// serial re-attach satisfying the node-scoped gate without re-declaring is
// the T2.4 gate contract),
// `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` (`runtime_node.online` +
// `capability_declared` / `capability_updated` payload shapes), invariant I-003-2 (the declaration is the
// precondition that gates `online`).

import { isDeepStrictEqual } from "node:util";

import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts";
import type { Database, Statement } from "better-sqlite3";

import { withSessionAppendLock } from "../events/session-append-lock.js";
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

/**
 * Module-private abort signal for the in-prelude decision re-check.
 *
 * Thrown from inside the `transactionalPrelude`, which runs inside the append's
 * `IMMEDIATE` transaction — so throwing it rolls that transaction back whole:
 * the upsert is undone, the event-row INSERT never runs, and no sequence is
 * consumed (the append re-derives the sequence from the durable chain head on
 * each attempt).
 *
 * NOT exported and NOT a `DaemonDomainError`: in the normal case it never
 * escapes this module (the retry loop catches exactly it), and it names an
 * internal concurrency event rather than anything a caller did wrong.
 */
class CapabilityRowDivergedError extends Error {
  constructor(nodeId: string, capability: string) {
    super(
      `NodeCapabilityService.declare: the node_capabilities row for ` +
        `(${nodeId}, ${capability}) changed between the read-decide step and the ` +
        `write transaction; aborting to avoid emitting an event whose payload no ` +
        `longer describes the committed state.`,
    );
    this.name = "CapabilityRowDivergedError";
  }
}

/** Bounded attempts for the read-decide-emit optimistic-concurrency loop. */
const CAPABILITY_DECLARE_MAX_ATTEMPTS: number = 3;

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
  // The single emission seam both paths route through. `declare` hands it a
  // `transactionalPrelude` on its mutating branches; `bringOnline` emits with
  // none (no durable write).
  readonly #emitter: RuntimeNodeEventEmitter;
  // Wall clock for `node_capabilities.updated_at`. Held on the instance now
  // that the upsert runs from a prelude closure rather than from a transaction
  // body that captured the constructor parameter.
  readonly #now: () => string;

  constructor(
    db: Database,
    emitter: RuntimeNodeEventEmitter,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#emitter = emitter;
    this.#now = now;
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
  }

  /**
   * Declare (or re-declare) a node capability. Atomic dual-write on the paths
   * that mutate state (first declaration and change); an identical re-declare
   * is an idempotent no-op (no write, no event).
   *
   * SHAPE, post Plan-006 T3.1 re-point — read-decide under the append lock,
   * re-check inside the write transaction, retry on divergence:
   *
   *   1. Acquire `withSessionAppendLock` for the session. This is what keeps two
   *      concurrent same-session declares of the same capability from BOTH
   *      reading "no row", both taking the first-declare branch, and both
   *      emitting `capability_declared` for one logical declaration.
   *   2. Read + decide (first-declare / changed / identical no-op). A no-op
   *      returns here having written nothing and emitted nothing.
   *   3. `await` the emit with the upsert as `transactionalPrelude`, so the
   *      `node_capabilities` row and the event row commit in ONE transaction,
   *      upsert FIRST — the same body order this class shipped, and a throwing
   *      INSERT still rolls the upsert back.
   *
   * The nested `append` REUSES the hold taken at (1) through owner-scoped
   * reentrancy rather than deadlocking on it.
   *
   * WHY THE LOCK IS NOT ENOUGH, and what closes the rest. The read at (2) used
   * to run INSIDE the write transaction. It cannot stay there — the event
   * PAYLOAD depends on it (`declared` and `updated` are different events),
   * signing depends on the payload, and signing is async. Moving it out opens a
   * window that the append lock does NOT cover, because `node_capabilities` is
   * NODE-keyed (no `session_id` column) while the lock is SESSION-keyed: two
   * declares for the same `(nodeId, capability)` under DIFFERENT sessions hold
   * different locks, both read, both park on the signing-key unseal, and both
   * commit — one connection or two, it makes no difference. That would break
   * this class's own Model-B property that an identical re-declare in a
   * DIFFERENT session is a no-op.
   *
   * So the prelude RE-CHECKS: as its first statement, inside the append's
   * `BEGIN IMMEDIATE`, it re-reads the row and aborts the whole transaction on
   * divergence (upsert undone, event INSERT never reached, no sequence
   * consumed). `declare` retries the read-decide-emit up to
   * {@link CAPABILITY_DECLARE_MAX_ATTEMPTS} times on that sentinel and only that sentinel;
   * exhaustion rethrows it loudly rather than writing on a stale decision.
   */
  async declare(input: DeclareCapabilityInput): Promise<void> {
    // Branded once here and reused for BOTH the lock key and the emit, so the
    // lock partition and the event's partition cannot drift apart.
    const sessionId: SessionId = SessionIdSchema.parse(input.sessionId);

    for (let attempt: number = 1; ; attempt += 1) {
      try {
        await this.#declareOnce(input, sessionId);
        return;
      } catch (error: unknown) {
        // ONLY the divergence sentinel is retryable; every other failure
        // propagates on its first occurrence.
        if (!(error instanceof CapabilityRowDivergedError)) {
          throw error;
        }
        if (attempt >= CAPABILITY_DECLARE_MAX_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  /**
   * ONE attempt of the read-decide-emit sequence, under the session's append
   * lock. Throws {@link CapabilityRowDivergedError} when the durable row moved
   * between the decision and the write.
   *
   * Factored out so each retry re-reads a genuinely FRESH row: a loop around
   * the lock body alone would keep closing over the first attempt's
   * `existingRow` and diverge forever.
   */
  async #declareOnce(input: DeclareCapabilityInput, sessionId: SessionId): Promise<void> {
    await withSessionAppendLock(sessionId, async () => {
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

      // The durable half of the dual-write, shared by both mutating branches.
      // Runs inside the append's transaction immediately BEFORE the event-row
      // INSERT. `this.#now()` is read HERE, in the transaction, exactly where it
      // was read when this class owned the transaction.
      const upsertCapability = (): void => {
        // THE RE-CHECK, first statement — see the `declare` doc comment for why
        // the session-keyed append lock cannot cover a node-keyed row.
        //
        // `existingRow` was read outside any write transaction and this attempt
        // then parked on an `await` before reaching here. Re-reading inside
        // `BEGIN IMMEDIATE` closes the window in both directions: a racer that
        // committed before our BEGIN is visible here, and a racer that BEGINs
        // after ours blocks until we COMMIT or ROLL BACK. `.get()` is called
        // directly — better-sqlite3 throws on a nested transaction and we are
        // already inside the append's, which supplies the read consistency.
        const currentRow: CapabilityValueRow | undefined = this.#selectCapabilityStmt.get({
          node_id: input.nodeId,
          capability_key: input.capability,
        }) as CapabilityValueRow | undefined;
        if (currentRow?.capability_value !== existingRow?.capability_value) {
          throw new CapabilityRowDivergedError(input.nodeId, input.capability);
        }

        this.#upsertCapabilityStmt.run({
          node_id: input.nodeId,
          capability_key: input.capability,
          capability_value: capabilityValue,
          now: this.#now(),
        });
      };

      if (existingRow === undefined) {
        // First declaration of this capability.
        await this.#emitter.emitCapabilityDeclared({
          sessionId,
          nodeId: input.nodeId,
          capability: input.capability,
          capabilityDetails: normalizedIncoming,
          actor: input.actor ?? null,
          transactionalPrelude: upsertCapability,
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
      await this.#emitter.emitCapabilityUpdated({
        sessionId,
        nodeId: input.nodeId,
        capability: input.capability,
        previousState: priorDetails,
        newState: normalizedIncoming,
        actor: input.actor ?? null,
        transactionalPrelude: upsertCapability,
      });
    });
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
   * NO DURABLE WRITE, NO PRELUDE: `online` is NOT a daemon-durable state in
   * Phase 2 — there is no node-table column for liveness; it is event-sourced via
   * the online event. So `bringOnline` is a SELECT + a single conditional emit,
   * and it passes no `transactionalPrelude` (unlike `declare`, whose dual-write
   * of the durable row + event needs to commit in one transaction). The emit is
   * the only side effect on the satisfied path. It takes no outer
   * `withSessionAppendLock` either: there is no read-decide to protect — the
   * gate reads a node-keyed row that this method never writes, so re-reading it
   * under a lock would order nothing that is not already ordered by `append`.
   *
   * NO "ALREADY ONLINE" SUPPRESSION (intentional, not an oversight): there is no
   * durable online state to check against, so this primitive does not de-duplicate
   * repeat onlines — once-per-attach is the Phase-3 caller's contract, not this
   * gated primitive's. `bringOnline` is a STANDALONE gate a caller invokes; it does
   * not sequence register→declare→online (that orchestration, and any
   * online-on-reconnect logic, is Phase 3 / T3.x).
   */
  async bringOnline(input: {
    readonly nodeId: string;
    readonly sessionId: string;
    readonly actor?: string | null;
  }): Promise<boolean> {
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
    await this.#emitter.emitOnline({
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      previousState: "registering",
      newState: "online",
      actor: input.actor ?? null,
    });
    return true;
  }
}
