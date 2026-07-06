// RuntimeBindingStore — durable driver-instance ↔ run bindings (Plan-005
// Phase 2, T2.2).
//
// A runtime binding records that a specific `run` is bound to a specific driver
// contract version, optionally carrying a provider-owned opaque `resume_handle`
// plus arbitrary provider `runtime_metadata`. The store is the daemon-resident
// authority over the `runtime_bindings` table (migration `0003`).
//
// I-005-1 (driver authority remains local even when the provider endpoint is
// remote): this store is DAEMON-RESIDENT — it holds prepared statements over the
// machine-local SQLite handle. No binding state is ever read from or written to
// a remote provider; the provider's only contribution is the opaque
// `contract_version` / `resume_handle` STRINGS it declares, which the daemon
// validates at the write seam and persists locally. The authority over which run
// is bound to which driver, and over the durable record of it, never leaves the
// local daemon.
//
// Write-seam validation (DEFENSE-IN-DEPTH, Spec-005:55):
//   `contract_version` and `resume_handle` are the only PROVIDER-DECLARED columns
//   and the only columns with DB CHECK constraints (`0003-runtime-bindings.ts`).
//   They are validated through `provider-output-validation.ts` BEFORE every
//   INSERT/UPDATE — a second, semantic layer (canonical-semver shape; all-
//   whitespace rejection) on top of the SQLite CHECK's length+NUL bounds.
//
// Deliberate boundary (NOT an oversight — this mirrors the T2.1 CHECK-scope
// discipline): `runId`, `driverName`, `id`, and the CONTENT of
// `runtime_metadata` are DAEMON-CONTROLLED. They have no DB CHECK and no
// governing validation obligation in the audit, so they are NOT Zod-guarded at
// this seam. We do not gold-plate beyond the audited obligation (the same reason
// T2.1 did not add a `supported IN (0,1)` over-check). `id` is store-minted;
// `runId`/`driverName` originate from trusted daemon callers; `runtime_metadata`
// is round-tripped as opaque JSON.
//
// Idiom: mirrors `node/node-registry.ts` — `export class` with `#`-private
// `readonly` cached prepared `Statement` fields prepared ONCE in the constructor,
// a prepared `db.transaction(...)` for the read-modify-write update, and an
// injected clock + id source for testability. The raw `db` handle is NOT
// retained as a field — the prepared statements keep the connection alive (the
// established idiom here). The `update()` transaction departs from NodeRegistry
// on ONE axis — it is dispatched IMMEDIATE, not DEFERRED (see the `#updateTxn`
// field comment for why a read-first transaction needs `BEGIN IMMEDIATE`).
//
// Refs: Plan-005 §Phase 2 / T2.2, Spec-005 line 47, invariant I-005-1.

import { randomUUID } from "node:crypto";

import type { Database, Statement, Transaction } from "better-sqlite3";

import {
  assertValidContractVersion,
  assertValidResumeHandle,
} from "./provider-output-validation.js";

// --------------------------------------------------------------------------
// Public domain types (camelCase, parsed). LOCAL to runtime-daemon — NOT hoisted
// to `@ai-sidekicks/contracts`: a single-package, daemon-internal consumer
// (T2.3 ProviderRegistry) fails the 2-surface hoist test.
// --------------------------------------------------------------------------

/**
 * A runtime binding as seen by daemon callers: parsed, camelCase, with
 * `runtime_metadata` already `JSON.parse`d into an object. Snake_case rows and
 * raw JSON strings never cross this boundary.
 */
export interface RuntimeBinding {
  readonly id: string;
  readonly runId: string;
  readonly driverName: string;
  readonly contractVersion: string;
  readonly resumeHandle: string | null;
  readonly runtimeMetadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `create` input. No `id` field — the store mints it (`run` → bindings is
 * 1:many, so `id` is a store-minted surrogate, NOT `runId`). `resumeHandle` and
 * `runtimeMetadata` are optional; an omitted handle persists as SQL NULL and an
 * omitted metadata defaults to `{}`.
 */
export interface CreateRuntimeBindingInput {
  readonly runId: string;
  readonly driverName: string;
  readonly contractVersion: string;
  readonly resumeHandle?: string | null;
  readonly runtimeMetadata?: Record<string, unknown>;
}

/**
 * `update` patch — the MUTABLE subset only, all optional. `runId`, `driverName`,
 * `id`, and `createdAt` are immutable post-creation and are deliberately absent
 * from this shape (the binding's identity + provenance do not change).
 */
export interface UpdateRuntimeBindingPatch {
  readonly contractVersion?: string;
  readonly resumeHandle?: string | null;
  readonly runtimeMetadata?: Record<string, unknown>;
}

// --------------------------------------------------------------------------
// Private row interface (snake_case, raw DB shape). `runtime_metadata` is the
// raw JSON string straight out of SQLite; `resume_handle` is `string | null`.
// --------------------------------------------------------------------------

interface RuntimeBindingRow {
  readonly id: string;
  readonly run_id: string;
  readonly driver_name: string;
  readonly contract_version: string;
  readonly resume_handle: string | null;
  readonly runtime_metadata: string;
  readonly created_at: string;
  readonly updated_at: string;
}

// --------------------------------------------------------------------------
// RuntimeBindingStore
// --------------------------------------------------------------------------

export class RuntimeBindingStore {
  // Only prepared statements + the prepared transaction wrapper are retained
  // (mirrors NodeRegistry / SessionService — the raw `db` handle is NOT stored;
  // a prepared statement internally keeps its parent connection alive).
  readonly #insertStmt: Statement;
  readonly #selectByIdStmt: Statement;
  readonly #selectByRunStmt: Statement;
  readonly #selectResumableStmt: Statement;
  readonly #updateStmt: Statement;
  readonly #deleteStmt: Statement;
  // Read-modify-write update wrapped in a single transaction so the SELECT and
  // the UPDATE see a consistent snapshot. Returns the updated row, or `undefined`
  // when `id` is absent.
  //
  // Dispatched IMMEDIATE (`#updateTxn.immediate(...)` in `update()`), NOT the
  // default DEFERRED — and this is the ONE place the store departs from
  // NodeRegistry's discipline. The body is READ-FIRST: it `SELECT`s the existing
  // row (establishing a WAL read snapshot) and only THEN `UPDATE`s (requiring a
  // write-lock upgrade). Under WAL with a second connection on the same DB file
  // — the daemon's documented production model (multiple native handles on one
  // file; daemon-restart overlap is the explicit realistic scenario) — two such
  // read-then-upgrade transactions BOTH hold a read snapshot and BOTH attempt to
  // upgrade, colliding as `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` CANNOT
  // absorb (the busy-handler only retries while no transaction is held). This is
  // exactly the failure class `session/migration-runner.ts` (see its
  // `applyMigrations` docstring, lines 74-85) documents and fixes with
  // `.immediate()`: `BEGIN IMMEDIATE` takes the RESERVED writer-intent lock at
  // BEGIN, so racers serialize at BEGIN (which `busy_timeout` CAN absorb) rather
  // than colliding at write-upgrade time. NodeRegistry's `#registerTxn`, by
  // contrast, is WRITE-FIRST (UPSERT-then-emit → it upgrades immediately and is
  // correctly left DEFERRED); the read-first store update does not inherit that
  // safety, so it must be IMMEDIATE. Typed as `Transaction<F>` (not the erased
  // bare callable) precisely so `.immediate(...)` is reachable.
  readonly #updateTxn: Transaction<
    (id: string, patch: UpdateRuntimeBindingPatch) => RuntimeBindingRow | undefined
  >;
  // Injected wall-clock + id sources for deterministic tests.
  readonly #now: () => string;
  readonly #newId: () => string;

  constructor(db: Database, deps: { now?: () => string; newId?: () => string } = {}) {
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    // `crypto.randomUUID()` is the established daemon id idiom (per
    // `node/node-event-emitter.ts`). `id` is a store-minted surrogate because
    // run → bindings is 1:many.
    this.#newId = deps.newId ?? ((): string => randomUUID());

    // Named-parameter binding (`@col`) throughout — mirrors NodeRegistry.
    this.#insertStmt = db.prepare(
      `INSERT INTO runtime_bindings
         (id, run_id, driver_name, contract_version, resume_handle, runtime_metadata, created_at, updated_at)
       VALUES
         (@id, @run_id, @driver_name, @contract_version, @resume_handle, @runtime_metadata, @created_at, @updated_at)`,
    );
    this.#selectByIdStmt = db.prepare(
      `SELECT id, run_id, driver_name, contract_version, resume_handle, runtime_metadata, created_at, updated_at
         FROM runtime_bindings
        WHERE id = ?`,
    );
    // Uses `idx_runtime_bindings_run`. Ordered by `created_at` then `id` for a
    // stable, deterministic return order (1:many).
    this.#selectByRunStmt = db.prepare(
      `SELECT id, run_id, driver_name, contract_version, resume_handle, runtime_metadata, created_at, updated_at
         FROM runtime_bindings
        WHERE run_id = ?
        ORDER BY created_at, id`,
    );
    // Plan-015 recovery seam (see findResumableBindings doc).
    this.#selectResumableStmt = db.prepare(
      `SELECT id, run_id, driver_name, contract_version, resume_handle, runtime_metadata, created_at, updated_at
         FROM runtime_bindings
        WHERE resume_handle IS NOT NULL
        ORDER BY created_at, id`,
    );
    // Full-row UPDATE of the mutable columns + `updated_at`. `created_at` is
    // never in the SET list, so it is structurally preserved. The read-modify-
    // write txn computes the merged values and binds them here.
    this.#updateStmt = db.prepare(
      `UPDATE runtime_bindings
          SET contract_version = @contract_version,
              resume_handle    = @resume_handle,
              runtime_metadata = @runtime_metadata,
              updated_at       = @updated_at
        WHERE id = @id`,
    );
    this.#deleteStmt = db.prepare(`DELETE FROM runtime_bindings WHERE id = ?`);

    // Prepare the read-modify-write update transaction once. The SELECT-then-
    // UPDATE pair runs atomically so a concurrent writer cannot interleave
    // between the read and the write. It is invoked via `.immediate(...)` in
    // `update()` (BEGIN IMMEDIATE) because the body is read-first — see the
    // `#updateTxn` field comment for the `SQLITE_BUSY_SNAPSHOT`-under-WAL
    // rationale. Validation runs OUTSIDE this txn (in `update`) so a rejected
    // patch never opens a transaction at all — which is what makes "a rejected
    // update leaves the row unchanged" hold without relying on rollback.
    this.#updateTxn = db.transaction(
      (id: string, patch: UpdateRuntimeBindingPatch): RuntimeBindingRow | undefined => {
        const existing = this.#selectByIdStmt.get(id) as RuntimeBindingRow | undefined;
        if (existing === undefined) {
          return undefined;
        }
        // Presence-detect each patch key. Under `exactOptionalPropertyTypes` an
        // explicit `undefined` is not assignable, so `!== undefined` is a safe
        // "is this column being patched" test. An absent key keeps the existing
        // value; a present `resumeHandle: null` correctly CLEARS the handle to
        // SQL NULL (COALESCE binding could not express this — null is COALESCE's
        // "keep existing" sentinel).
        const mergedContractVersion: string =
          patch.contractVersion !== undefined ? patch.contractVersion : existing.contract_version;
        const mergedResumeHandle: string | null =
          patch.resumeHandle !== undefined ? patch.resumeHandle : existing.resume_handle;
        const mergedRuntimeMetadata: string =
          patch.runtimeMetadata !== undefined
            ? JSON.stringify(patch.runtimeMetadata)
            : existing.runtime_metadata;
        const updatedAt: string = this.#now();

        this.#updateStmt.run({
          id,
          contract_version: mergedContractVersion,
          resume_handle: mergedResumeHandle,
          runtime_metadata: mergedRuntimeMetadata,
          updated_at: updatedAt,
        });

        return {
          ...existing,
          contract_version: mergedContractVersion,
          resume_handle: mergedResumeHandle,
          runtime_metadata: mergedRuntimeMetadata,
          updated_at: updatedAt,
        };
      },
    );
  }

  /**
   * Create a runtime binding. Validates the PROVIDER-DECLARED fields at the
   * write seam BEFORE the INSERT (`contract_version` always; `resume_handle`
   * only when present — the column is nullable). Mints `id`; sets
   * `created_at === updated_at === now()`; serializes `runtime_metadata`
   * (defaulting to `{}`). Returns the created binding from the in-memory values
   * just written (no re-SELECT needed). Synchronous — better-sqlite3 is
   * synchronous by design.
   */
  create(input: CreateRuntimeBindingInput): RuntimeBinding {
    assertValidContractVersion(input.contractVersion);
    if (input.resumeHandle != null) {
      assertValidResumeHandle(input.resumeHandle);
    }

    const id: string = this.#newId();
    const timestamp: string = this.#now();
    const resumeHandle: string | null = input.resumeHandle ?? null;
    const runtimeMetadata: Record<string, unknown> = input.runtimeMetadata ?? {};
    const runtimeMetadataJson: string = JSON.stringify(runtimeMetadata);

    this.#insertStmt.run({
      id,
      run_id: input.runId,
      driver_name: input.driverName,
      contract_version: input.contractVersion,
      resume_handle: resumeHandle,
      runtime_metadata: runtimeMetadataJson,
      created_at: timestamp,
      updated_at: timestamp,
    });

    return {
      id,
      runId: input.runId,
      driverName: input.driverName,
      contractVersion: input.contractVersion,
      resumeHandle,
      // Return the JSON-ROUND-TRIPPED metadata (reusing the already-computed
      // `runtimeMetadataJson` — do NOT re-stringify), so `create()` agrees with
      // `findById()` / `update()`, which both reconstruct via `#rowToDomain` →
      // `JSON.parse`. Returning the original `input.runtimeMetadata` would diverge
      // for values JSON normalizes (`{ optional: undefined }` drops the key; a
      // `Date` becomes its ISO string) — DB-as-source-of-truth keeps the three
      // accessors consistent.
      runtimeMetadata: JSON.parse(runtimeMetadataJson) as Record<string, unknown>,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  /**
   * Look up a binding by its primary key. Returns `undefined` when absent.
   */
  findById(id: string): RuntimeBinding | undefined {
    const row = this.#selectByIdStmt.get(id) as RuntimeBindingRow | undefined;
    return row === undefined ? undefined : this.#rowToDomain(row);
  }

  /**
   * List all bindings for a run (uses `idx_runtime_bindings_run`). Returns `[]`
   * when none. `run` → bindings is 1:many.
   */
  findByRun(runId: string): RuntimeBinding[] {
    const rows = this.#selectByRunStmt.all(runId) as RuntimeBindingRow[];
    return rows.map((row) => this.#rowToDomain(row));
  }

  /**
   * Patch a binding's mutable columns. Validates any PRESENT provider-declared
   * fields at the write seam (same asserts as `create`) BEFORE opening the
   * transaction — so a rejected patch never touches the row. Bumps `updated_at`
   * and PRESERVES `created_at`. Applies only the provided fields (absent keys
   * keep their existing value; a present `resumeHandle: null` clears it).
   * Returns the updated binding, or `undefined` if `id` is not found.
   *
   * Validation precedence is deliberate and contract-pinned: the patch-shape
   * asserts are an UNCONDITIONAL PRECONDITION on the argument and run BEFORE the
   * existence lookup. So `update(absentId, invalidPatch)` THROWS (the patch is
   * malformed regardless of whether the target row exists — failing fast surfaces
   * a real caller bug), whereas `update(absentId, validPatch)` returns
   * `undefined`. The `runtime-binding-store.test.ts` "absent-id with invalid
   * patch" case pins this ordering as an enforced contract.
   */
  update(id: string, patch: UpdateRuntimeBindingPatch): RuntimeBinding | undefined {
    if (patch.contractVersion !== undefined) {
      assertValidContractVersion(patch.contractVersion);
    }
    if (patch.resumeHandle != null) {
      assertValidResumeHandle(patch.resumeHandle);
    }

    // `.immediate(...)` → BEGIN IMMEDIATE (read-first transaction; see the
    // `#updateTxn` field comment for the WAL `SQLITE_BUSY_SNAPSHOT` rationale).
    const row = this.#updateTxn.immediate(id, patch);
    return row === undefined ? undefined : this.#rowToDomain(row);
  }

  /**
   * Delete a binding by primary key. Returns whether a row was removed.
   */
  delete(id: string): boolean {
    const info = this.#deleteStmt.run(id);
    return info.changes > 0;
  }

  /**
   * List every binding that carries a non-null `resume_handle`.
   *
   * This is the Plan-015 recovery-aware-persistence extension seam (CP-005-1).
   * Plan-015 will REFINE the predicate — joining the dedicated
   * `recovery_checkpoints` table to surface only bindings that actually NEED
   * recovery — but the binding-level "has a handle to resume from" semantic
   * ships FUNCTIONAL now (this is a working query, not a throw-stub).
   */
  findResumableBindings(): RuntimeBinding[] {
    const rows = this.#selectResumableStmt.all() as RuntimeBindingRow[];
    return rows.map((row) => this.#rowToDomain(row));
  }

  // ------------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------------

  /**
   * Map a raw snake_case DB row to the public camelCase domain type, parsing
   * `runtime_metadata` from its stored JSON string. Snake_case rows and raw
   * JSON never leak to callers.
   */
  #rowToDomain(row: RuntimeBindingRow): RuntimeBinding {
    return {
      id: row.id,
      runId: row.run_id,
      driverName: row.driver_name,
      contractVersion: row.contract_version,
      resumeHandle: row.resume_handle,
      runtimeMetadata: JSON.parse(row.runtime_metadata) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
