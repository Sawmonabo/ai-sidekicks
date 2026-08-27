// RuntimeBindingStore — durable driver-instance ↔ run bindings (Plan-005
// Phase 2, T2.2).
//
// A runtime binding records that a specific `run` is bound to a specific driver
// contract version, optionally carrying a provider-owned opaque `resume_handle`
// plus arbitrary provider `runtime_metadata`. The store is the daemon-resident
// authority over the `runtime_bindings` table (created by migration `0003`,
// extended by `0011` with the CLI-version pair and `spawn_config`).
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
// Write-seam validation (DEFENSE-IN-DEPTH, `Spec-005 §Required Behavior`):
//   FOUR columns are PROVIDER-DECLARED, and they are exactly the columns
//   carrying DB CHECK constraints — `contract_version` + `resume_handle`
//   (`0003-runtime-bindings.ts`) and the `cli_version_raw` / `cli_version_semver`
//   pair added by T2.6 (`0011-driver-capability-currency.ts`). All four are
//   validated through `provider-output-validation.ts` BEFORE the write — a
//   second, semantic layer (canonical-semver shape; all-whitespace rejection) on
//   top of the SQLite CHECK's length+NUL bounds. The pair is spawn-scoped, so it
//   is validated at INSERT only; the other two are re-validated on every UPDATE
//   that patches them.
//
// T2.6 extension (campaign B10) — three legs over the migration-`0011` columns:
//   * `findByRuns(runIds)` — the BATCH form of `findByRun`, the local
//     synchronous ack-barrier input Plan-016 T2.10's fan-out gates on.
//   * `spawn_config` — the daemon-owned record of the spawn-bound configuration
//     realized at process spawn, written at EVERY binding write and re-read by
//     the CP-005-1 recovery seam to reconstruct `ResumeSessionParams`' DATA legs
//     without the original client request. Required at the create seam, so
//     "spawned but not persisted" is unrepresentable rather than merely
//     discouraged.
//   * `cli_version_raw` / `cli_version_semver` — the provider handshake version
//     pair, carried as the SINGLE optional `cliVersion` member so the DDL's
//     both-or-neither CHECK is structural at the type level.
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
// Refs: Plan-005 §Phase 2 / T2.2 + T2.6, `Spec-005 §Required Behavior`,
// `Spec-005 §State And Data Implications`, invariant I-005-1.

import { randomUUID } from "node:crypto";

import type {
  DriverCliVersionReport,
  ExecutionPosture,
  SessionCallbackTool,
  SubagentPolicy,
} from "@ai-sidekicks/contracts";
import type { Database, Statement, Transaction } from "better-sqlite3";

import {
  assertValidCliVersionReport,
  ProviderOutputValidationError,
  assertValidContractVersion,
  assertValidResumeHandle,
} from "./provider-output-validation.js";

// --------------------------------------------------------------------------
// Public domain types (camelCase, parsed). LOCAL to runtime-daemon — NOT hoisted
// to `@ai-sidekicks/contracts`: a single-package, daemon-internal consumer
// (T2.3 ProviderRegistry) fails the 2-surface hoist test.
// --------------------------------------------------------------------------

/**
 * The daemon-owned record of the SPAWN-BOUND configuration realized at process
 * spawn, persisted to `runtime_bindings.spawn_config` at every binding write
 * (T2.6, campaign B10).
 *
 * WHY IT EXISTS (CP-005-1): resume is a FRESH PROCESS SPAWN, so every
 * spawn-bound surface `CreateSessionParams` bound must RE-REALIZE on
 * `ResumeSessionParams` or the resumed leg silently sheds it — a posture-less
 * resume relaunches UNSANDBOXED, a schema-less one unconstrained. Recovery does
 * NOT have the original client request, so THIS ROW is the durable source the
 * resume assembly (T3.14) and Plan-015's recovery dispatcher re-read to
 * reconstruct those legs.
 *
 * DATA LEGS ONLY. `CreateSessionParams` / `ResumeSessionParams` also carry two
 * FUNCTION legs (`onCallbackToolCall`, `onMcpServerStatus`); those are
 * re-injected FRESH at every spawn and are NEVER stored — a stored closure could
 * only ever be a stale one, and the canonical schema doc states the same rule on
 * the column ("function legs re-injected fresh, never stored").
 *
 * Daemon-local, NOT hoisted to `@ai-sidekicks/contracts`: both consumers (this
 * store and the daemon-side resume assembly) live in `runtime-daemon`, so it
 * fails the 2-surface hoist test — the same reasoning that keeps `RuntimeBinding`
 * itself local.
 *
 * Members take the `?: T | undefined` form (not bare `?: T`) so a producer can
 * copy the `CreateSessionParams` legs straight across under
 * `exactOptionalPropertyTypes` without conditional spreads — those contract
 * members are declared in exactly that form.
 */
export interface RuntimeBindingSpawnConfig {
  readonly executionPosture?: ExecutionPosture | undefined;
  readonly callbackTools?: SessionCallbackTool[] | undefined;
  readonly subagentPolicy?: SubagentPolicy | undefined;
  readonly outputSchema?: Record<string, unknown> | undefined;
  readonly admittedCostCapCents?: number | undefined;
  // Minted NOW, valued LATER — deliberately, so the task that supplies the value
  // does not have to re-widen this type (and re-widen its closed-key-set parser,
  // which would reject the member as unknown until it did).
  //
  // Owner: Plan-005 T3.17 — the Spec-029 provider-account identity bound at
  // spawn. A run's paying account is bound for the run's LIFETIME, so a resume
  // that re-resolved "whichever account is default now" would silently re-bill.
  readonly providerAccountId?: string | undefined;
  // Owner: Plan-005 T3.23 — `Spec-005 §Required Behavior`: the RESOLVED
  // executable path rides this carrier, so a resumed leg re-spawns the same
  // binary the original spawn resolved rather than re-resolving against a PATH
  // that may have changed underneath it.
  readonly resolvedExecutablePath?: string | undefined;
}

/**
 * A runtime binding as seen by daemon callers: parsed, camelCase, with
 * `runtime_metadata` and `spawn_config` already `JSON.parse`d into objects.
 * Snake_case rows and raw JSON strings never cross this boundary.
 */
export interface RuntimeBinding {
  readonly id: string;
  readonly runId: string;
  readonly driverName: string;
  readonly contractVersion: string;
  // The provider handshake version pair, or `null` when the row carries neither
  // — pre-B3 rows AND creates that omitted the report (the write path stores the
  // pair or neither, so an omitted report leaves both columns NULL). Never
  // half-present through this seam: the DDL CHECK enforces both-or-neither at
  // the column layer and the single optional `cliVersion` create member makes a
  // half-pair unrepresentable at the write seam. A half-present ROW is reachable
  // only by out-of-band corruption, and the read fold reports it as `null`
  // rather than fabricating the missing member (see `#rowToDomain`).
  readonly cliVersion: DriverCliVersionReport | null;
  readonly resumeHandle: string | null;
  readonly spawnConfig: RuntimeBindingSpawnConfig;
  readonly runtimeMetadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `create` input. No `id` field — the store mints it (`run` → bindings is
 * 1:many, so `id` is a store-minted surrogate, NOT `runId`). `resumeHandle` and
 * `runtimeMetadata` are optional; an omitted handle persists as SQL NULL and an
 * omitted metadata defaults to `{}`.
 *
 * `spawnConfig` is REQUIRED (T2.6). Every binding write IS a spawn, and the
 * spawn-bound configuration is what recovery re-reads to rebuild
 * `ResumeSessionParams` — so "spawn a leg, persist nothing" must be
 * UNREPRESENTABLE at this seam rather than merely discouraged. A caller that
 * genuinely realized no spawn-bound surface passes `{}` EXPLICITLY, which is a
 * decision the type system can see. The column's `'{}'` DEFAULT is a
 * pre-B10-ROW artifact (rows written before migration `0011` added the column),
 * never a live-write outcome.
 *
 * `cliVersion` is optional and is the pair-or-neither carrier: ABSENT persists
 * both columns as SQL NULL; PRESENT persists both. There is deliberately no way
 * to express a half-pair, which is the type-level mirror of the DDL's
 * `(cli_version_semver IS NULL) = (cli_version_raw IS NULL)` CHECK.
 */
export interface CreateRuntimeBindingInput {
  readonly runId: string;
  readonly driverName: string;
  readonly contractVersion: string;
  readonly cliVersion?: DriverCliVersionReport;
  readonly resumeHandle?: string | null;
  readonly spawnConfig: RuntimeBindingSpawnConfig;
  readonly runtimeMetadata?: Record<string, unknown>;
}

/**
 * `update` patch — the MUTABLE subset only, all optional. `runId`, `driverName`,
 * `id`, and `createdAt` are immutable post-creation and are deliberately absent
 * from this shape (the binding's identity + provenance do not change).
 *
 * `spawnConfig` and `cliVersion` are absent for the SAME reason, one step
 * stronger: both are SPAWN-SCOPED PROVENANCE — the record of what this
 * particular process launch realized and which CLI build answered its handshake.
 * A relaunch mints a NEW binding row (which is why the store keeps superseded
 * history), so a patched spawn record would rewrite the provenance of a spawn
 * that already happened — exactly the value recovery would then replay from.
 */
export interface UpdateRuntimeBindingPatch {
  readonly contractVersion?: string;
  readonly resumeHandle?: string | null;
  readonly runtimeMetadata?: Record<string, unknown>;
}

// --------------------------------------------------------------------------
// Private row interface (snake_case, raw DB shape). `runtime_metadata` and
// `spawn_config` are the raw JSON strings straight out of SQLite;
// `resume_handle` and the CLI-version pair are `string | null`.
// --------------------------------------------------------------------------

interface RuntimeBindingRow {
  readonly id: string;
  readonly run_id: string;
  readonly driver_name: string;
  readonly contract_version: string;
  readonly cli_version_raw: string | null;
  readonly cli_version_semver: string | null;
  readonly resume_handle: string | null;
  readonly spawn_config: string;
  readonly runtime_metadata: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * `#updateTxn`'s return: the updated raw row PLUS the `spawn_config` record
 * parsed INSIDE the transaction.
 *
 * The parse is a PRECONDITION OF THE COMMIT (see `#updateTxn`), so carrying its
 * result out is what keeps `update()` from parsing the same JSON a second time
 * to build its return value — and guarantees the record it returns is the one
 * the commit was gated on, not a re-derivation of it.
 */
interface UpdatedRuntimeBindingRow {
  readonly row: RuntimeBindingRow;
  readonly spawnConfig: RuntimeBindingSpawnConfig;
}

// --------------------------------------------------------------------------
// `spawn_config` closed-key-set parse table
// --------------------------------------------------------------------------

/**
 * A non-null, non-array object (the JSON "plain object" test).
 *
 * Declared as a TYPE PREDICATE, not a bare `boolean`: a caller that has narrowed
 * a value through this guard can then index it directly, so the seam does not
 * need an `as Record<string, unknown>` cast re-stating at the use site exactly
 * what the guard just proved.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The CLOSED key set of `spawn_config`, each key paired with the shallow
 * runtime check its stored value must satisfy.
 *
 * Shallow BY DESIGN (`typeof` / array / plain-object only, no deep enum or
 * schema validation): `spawn_config` is DAEMON-CONSTRUCTED, the same trust class
 * as `runtime_metadata` — which is why the column carries no provider-string
 * CHECK either. What this table guards is not provider trust but STORAGE
 * INTEGRITY: that the record the recovery seam re-reads is the shape it was
 * written as, and that a member added by a future task cannot be silently
 * dropped on the floor by a reader that predates it (an unknown key is a LOUD
 * failure here, not a shrug).
 *
 * DEPTH LIMIT, stated so no consumer over-reads it: this table proves the key
 * set is closed and each present member's shape ONE LEVEL DEEP. It proves
 * NOTHING about a member's INNER shape — an `executionPosture` stored as `{}`
 * passes `isPlainObject` and reads back as a posture object with no `mode`, no
 * `networkAccess`, and no `writableRoots`. The recovery consumer (T3.14 /
 * Plan-015) must therefore guard the inner shape itself before spawning from
 * it; a posture-shaped hole is not a posture, and this table will not catch it.
 *
 * Typed by `satisfies Readonly<Record<keyof RuntimeBindingSpawnConfig, …>>`
 * rather than by a `Record<string, …>` ANNOTATION: the `satisfies` form keys
 * the table to the domain type, so adding a member to
 * `RuntimeBindingSpawnConfig` without adding its check here is a COMPILE error
 * rather than a runtime "unknown member" refusal discovered on the read that
 * recovery performs. It also keeps the literal key type (an annotation would
 * widen it to `string`), which is what lets the parse loop index the table with
 * a narrowed key instead of a possibly-`undefined` lookup.
 */
const SPAWN_CONFIG_MEMBER_CHECKS = {
  executionPosture: isPlainObject,
  callbackTools: (value) => Array.isArray(value),
  subagentPolicy: isPlainObject,
  outputSchema: isPlainObject,
  // JSON has no NaN/Infinity — both serialize to `null`, which fails this check
  // rather than round-tripping as a number, so a nonsense cap cannot survive.
  admittedCostCapCents: (value) => typeof value === "number",
  providerAccountId: (value) => typeof value === "string",
  resolvedExecutablePath: (value) => typeof value === "string",
} satisfies Readonly<Record<keyof RuntimeBindingSpawnConfig, (value: unknown) => boolean>>;

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
  readonly #selectByRunsStmt: Statement;
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
    (id: string, patch: UpdateRuntimeBindingPatch) => UpdatedRuntimeBindingRow | undefined
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
         (id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver, resume_handle, spawn_config, runtime_metadata, created_at, updated_at)
       VALUES
         (@id, @run_id, @driver_name, @contract_version, @cli_version_raw, @cli_version_semver, @resume_handle, @spawn_config, @runtime_metadata, @created_at, @updated_at)`,
    );
    this.#selectByIdStmt = db.prepare(
      `SELECT id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver, resume_handle, spawn_config, runtime_metadata, created_at, updated_at
         FROM runtime_bindings
        WHERE id = ?`,
    );
    // Uses `idx_runtime_bindings_run`. Ordered by `created_at` then `id` for a
    // stable, deterministic return order (1:many).
    this.#selectByRunStmt = db.prepare(
      `SELECT id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver, resume_handle, spawn_config, runtime_metadata, created_at, updated_at
         FROM runtime_bindings
        WHERE run_id = ?
        ORDER BY created_at, id`,
    );
    // The BATCH form (T2.6). ONE prepared statement for any arity: the run-id
    // list arrives as a single JSON-array parameter expanded by `json_each`,
    // NOT as N generated `?` placeholders. Three properties follow from that
    // choice, and all three are why it is the choice:
    //   * PREPARE-ONCE survives — an `IN (?,?,…)` list has a different SQL text
    //     per arity, so it could not be a constructor-prepared field at all
    //     (it would re-prepare on every call, against this class's whole idiom).
    //   * SQLITE_MAX_VARIABLE_NUMBER cannot be reached — the fan-out this
    //     serves is unbounded in principle, and a 1-parameter statement has no
    //     per-arity ceiling to hit.
    //   * Repeated ids in the input collapse for free: `IN` is SET MEMBERSHIP,
    //     so a run named twice matches its rows once (no `DISTINCT` needed, and
    //     no risk of a caller's duplicate turning into duplicated output rows).
    // JSON1 (`json_each`) is compiled into better-sqlite3's bundled SQLite, so
    // this needs no extension load.
    this.#selectByRunsStmt = db.prepare(
      `SELECT id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver, resume_handle, spawn_config, runtime_metadata, created_at, updated_at
         FROM runtime_bindings
        WHERE run_id IN (SELECT value FROM json_each(?))
        ORDER BY run_id, created_at, id`,
    );
    // Plan-015 recovery seam (see findResumableBindings doc).
    this.#selectResumableStmt = db.prepare(
      `SELECT id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver, resume_handle, spawn_config, runtime_metadata, created_at, updated_at
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
    // rationale.
    //
    // TWO REFUSAL CLASSES, deliberately split across the transaction boundary:
    //   * The PATCH-SHAPE asserts run OUTSIDE this txn (in `update`), so a
    //     malformed patch never opens a transaction at all — "a rejected patch
    //     leaves the row unchanged" holds WITHOUT relying on rollback.
    //   * The STORED-RECORD parse runs INSIDE, because it reads the row this
    //     txn has just selected and cannot be hoisted above it. That one DOES
    //     rely on rollback (better-sqlite3 rolls a `db.transaction(...)` back
    //     when its body throws), and that is the point: a record this store
    //     cannot read back must not have a patch committed onto it, mirroring
    //     `create()`'s pre-INSERT parse from the read side.
    this.#updateTxn = db.transaction(
      (id: string, patch: UpdateRuntimeBindingPatch): UpdatedRuntimeBindingRow | undefined => {
        const existing = this.#selectByIdStmt.get(id) as RuntimeBindingRow | undefined;
        if (existing === undefined) {
          return undefined;
        }
        // Round-trip the STORED record through the SAME closed-key-set parser
        // the read path uses, BEFORE anything commits — the read-side twin of
        // `create()`'s pre-INSERT parse. A row whose `spawn_config` this store
        // cannot read is corrupt storage, and committing a patch onto it would
        // produce a record that is newer, still unreadable, and now carries an
        // `updated_at` implying this daemon wrote it — hiding the corruption
        // behind a fresh timestamp for the recovery read that eventually trips
        // over it. The throw aborts the transaction, so the UPDATE below never
        // lands. The parsed record travels out with the row (see
        // {@link UpdatedRuntimeBindingRow}) so `update()` re-parses nothing.
        const parsedSpawnConfig: RuntimeBindingSpawnConfig = this.#parseSpawnConfig(
          existing.id,
          existing.spawn_config,
        );
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
          row: {
            ...existing,
            contract_version: mergedContractVersion,
            resume_handle: mergedResumeHandle,
            runtime_metadata: mergedRuntimeMetadata,
            updated_at: updatedAt,
          },
          spawnConfig: parsedSpawnConfig,
        };
      },
    );
  }

  /**
   * Create a runtime binding. Validates the PROVIDER-DECLARED fields at the
   * write seam BEFORE the INSERT (`contract_version` always; `resume_handle`
   * and the `cliVersion` pair only when present — those columns are nullable).
   * Mints `id`; sets `created_at === updated_at === now()`; serializes
   * `spawn_config` and `runtime_metadata` (the latter defaulting to `{}`).
   * Returns the created binding from the in-memory values just written (no
   * re-SELECT needed). Synchronous — better-sqlite3 is synchronous by design.
   */
  create(input: CreateRuntimeBindingInput): RuntimeBinding {
    assertValidContractVersion(input.contractVersion);
    if (input.resumeHandle != null) {
      assertValidResumeHandle(input.resumeHandle);
    }
    // The handshake report is PROVIDER input, so it is bounded at this seam like
    // the other two — BEFORE the INSERT, so a bad report surfaces the typed
    // `ProviderOutputValidationError` and lands no row, rather than tripping the
    // DDL CHECK as a raw `SqliteError` (or, worse, landing a row whose recorded
    // version is a lie).
    //
    // SNAPSHOT FIRST, THEN VALIDATE. Each member is read off the caller's object
    // EXACTLY ONCE, into a fresh plain two-member object, and that ONE snapshot
    // is what is validated, what is BOUND to the INSERT, and what is RETURNED.
    // Re-reading `input.cliVersion.raw` at bind time would be a TOCTOU window:
    // the report is provider-shaped input, so a getter (or a Proxy) re-evaluated
    // between the assert and the write could persist a string that never passed
    // validation, leaving the DDL CHECK's length+NUL bounds as the only thing
    // between a hostile driver and a stored lie about which build answered.
    //
    // A NON-object report is passed through UNCOPIED, deliberately: this copy
    // makes no admission decision — it only decides what is read once — so the
    // validator stays the SOLE owner of the accept/reject judgement and still
    // sees (and refuses) exactly the value the caller supplied.
    // The property reads are themselves inside the getter/Proxy threat model:
    // a throwing accessor must surface as the seam's typed leak-safe refusal,
    // never as the caller object's own exception (Codex PR #372 round 1). The
    // thrown value is discarded entirely so nothing caller-controlled reaches
    // the message.
    let cliVersion: DriverCliVersionReport | null;
    try {
      const reportedCliVersion: DriverCliVersionReport | null = input.cliVersion ?? null;
      cliVersion = isPlainObject(reportedCliVersion)
        ? ({
            raw: reportedCliVersion["raw"],
            semver: reportedCliVersion["semver"],
          } as DriverCliVersionReport)
        : reportedCliVersion;
    } catch {
      throw new ProviderOutputValidationError("Invalid provider cli_version report.", {
        driverName: input.driverName,
        field: "cliVersion",
        reason: "a property accessor on the report threw during the defensive copy",
      });
    }
    if (cliVersion !== null) {
      assertValidCliVersionReport(input.driverName, cliVersion);
    }

    const id: string = this.#newId();
    const timestamp: string = this.#now();
    const resumeHandle: string | null = input.resumeHandle ?? null;
    // Fail CLOSED on a missing record: `spawnConfig` is REQUIRED on the input
    // type, so only an untyped/JS caller can reach this branch — and silently
    // writing `'{}'` for such a caller would be the one live-write path into the
    // documented pre-B10 ambiguity class, whose recovery-side failure mode is a
    // posture-less resume relaunching unsandboxed. A loud refusal here is an
    // internal-invariant `Error` (daemon-assembled input, not provider output).
    if (input.spawnConfig === undefined) {
      throw new Error(
        `RuntimeBindingStore.create: spawnConfig is required at every binding write for run ${input.runId} (driver ${input.driverName}) — the '{}' column default is a pre-B10-row artifact, never a live-write outcome`,
      );
    }
    const spawnConfigJson: string = JSON.stringify(input.spawnConfig);
    // Round-trip the record through the SAME closed-key-set parser the read path
    // uses, BEFORE the INSERT — so a record this store could not read back never
    // lands in the first place, and `create()` returns exactly what `findById()`
    // will (DB-as-source-of-truth, the `runtimeMetadata` discipline below). A
    // failure here is an internal-invariant `Error`, not a provider refusal: the
    // record is daemon-assembled, so a malformation is this daemon's own bug.
    const persistedSpawnConfig: RuntimeBindingSpawnConfig = this.#parseSpawnConfig(
      id,
      spawnConfigJson,
    );
    const runtimeMetadata: Record<string, unknown> = input.runtimeMetadata ?? {};
    const runtimeMetadataJson: string = JSON.stringify(runtimeMetadata);

    this.#insertStmt.run({
      id,
      run_id: input.runId,
      driver_name: input.driverName,
      contract_version: input.contractVersion,
      // Bound as a PAIR from one source, so the both-or-neither DDL CHECK can
      // only ever see two NULLs or two values.
      cli_version_raw: cliVersion === null ? null : cliVersion.raw,
      cli_version_semver: cliVersion === null ? null : cliVersion.semver,
      resume_handle: resumeHandle,
      spawn_config: spawnConfigJson,
      runtime_metadata: runtimeMetadataJson,
      created_at: timestamp,
      updated_at: timestamp,
    });

    return {
      id,
      runId: input.runId,
      driverName: input.driverName,
      contractVersion: input.contractVersion,
      // The VALIDATED SNAPSHOT itself — never a re-read of the caller's object
      // (see the TOCTOU note above). It is already the fresh two-member shape
      // the row stores, so `findById()` reconstructs exactly this object;
      // echoing an input carrying extra keys would make the two accessors
      // disagree, the same DB-as-source-of-truth reasoning as the round-tripped
      // `runtimeMetadata` below.
      cliVersion,
      resumeHandle,
      // The parser's output (computed above, pre-INSERT) — never the caller's
      // object, for the same DB-as-source-of-truth reason as `runtimeMetadata`.
      spawnConfig: persistedSpawnConfig,
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
   * List all bindings for MANY runs in one query — the batch form of
   * `findByRun` (T2.6, campaign B10).
   *
   * SYNCHRONOUS, like every other method here, and load-bearingly so: this is
   * the LOCAL ACK-BARRIER input Plan-016 T2.10's fan-out gates on (the same gate
   * as the driver goal methods). A `Promise` return would push the barrier
   * across a microtask boundary and stop it being a barrier at all.
   *
   * Returns a FLAT array ordered `run_id, created_at, id` — the deterministic
   * extension of `findByRun`'s `created_at, id`. The caller groups by `runId`;
   * grouping here would invent a map shape no consumer asked for.
   *
   * Returns ALL rows for those runs, INCLUDING superseded pre-relaunch
   * bindings: a relaunch mints a NEW binding row and the old one is retained as
   * history. There is deliberately NO liveness filtering — the store owns no
   * liveness column by design (T2.2's seam), so the CALLER owns the liveness
   * intersection. A store-side "only the live one" filter would have to invent
   * the liveness judgement, and inventing it in the storage layer is how two
   * different definitions of live end up in the same daemon.
   *
   * Empty input short-circuits to `[]` WITHOUT executing the statement — an
   * empty `IN` set can only ever match nothing, so the round-trip has no
   * possible outcome to report.
   *
   * REFUSES THE WHOLE LIST if any matched row's `spawn_config` is unreadable
   * (see `#parseSpawnConfig` for why skipping the row instead would be worse
   * HERE specifically: a silently dropped binding UNDER-COUNTS the ack barrier
   * Plan-016 T2.10 gates its fan-out on, and that barrier is fail-open — it
   * proceeds when it believes nothing is outstanding). Reachable only by
   * out-of-band corruption: both write seams parse before they commit.
   */
  findByRuns(runIds: readonly string[]): RuntimeBinding[] {
    if (runIds.length === 0) {
      return [];
    }
    const rows = this.#selectByRunsStmt.all(JSON.stringify(runIds)) as RuntimeBindingRow[];
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
   *
   * REFUSES A CORRUPT TARGET. Inside the transaction, the row's stored
   * `spawn_config` is round-tripped through the same closed-key-set parser the
   * read path uses BEFORE the UPDATE commits, so a patch is never written onto
   * a record this store cannot read back (the throw rolls the transaction back,
   * leaving every column — the patched ones and `updated_at` alike — untouched).
   * That refusal is a plain internal-invariant `Error`, not a
   * `ProviderOutputValidationError`: the record is daemon-written local state.
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
    const updated = this.#updateTxn.immediate(id, patch);
    if (updated === undefined) {
      return undefined;
    }
    // Reuses the `spawn_config` record the commit was gated on (see
    // {@link UpdatedRuntimeBindingRow}) rather than re-parsing the column, so
    // the returned binding cannot disagree with what the transaction admitted.
    return this.#rowToDomain(updated.row, updated.spawnConfig);
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
   *
   * REFUSES THE WHOLE LIST if any resumable row's `spawn_config` is unreadable
   * (see `#parseSpawnConfig`): silently dropping the row would hand the
   * recovery dispatcher a SHORTER list of resumable bindings than the database
   * holds, which reads as "nothing to recover" rather than as a failure.
   * Reachable only by out-of-band corruption: both write seams parse before
   * they commit.
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
   * `runtime_metadata` and `spawn_config` from their stored JSON strings and
   * folding the CLI-version columns back into a single pair. Snake_case rows and
   * raw JSON never leak to callers.
   *
   * The pair folds only when BOTH columns are non-null — the same posture
   * `DriverCapabilitiesWriter.#cachedRead` takes on its own copy of this pair.
   * The DDL CHECK makes both-or-neither a stored fact, and this fold READS that
   * guarantee rather than assuming it: a half-present row (reachable only by
   * out-of-band corruption, e.g. a writer running under
   * `PRAGMA ignore_check_constraints`) reports `cliVersion: null` instead of
   * fabricating the missing member. Defaulting the sibling to `""` would have
   * manufactured a version report the provider never gave — and an empty
   * `semver` is exactly the value the floor gate cannot compare, so the
   * fabrication would travel as a real reading rather than as an absent one.
   *
   * `parsedSpawnConfig` is an OPTIONAL pre-parsed record for the one caller that
   * already holds it: `update()`, whose transaction parsed the stored column as
   * a precondition of committing. Passing it through avoids parsing the same
   * JSON twice and makes the returned record provably the one the commit was
   * gated on. Every other caller omits it and this method parses.
   */
  #rowToDomain(
    row: RuntimeBindingRow,
    parsedSpawnConfig?: RuntimeBindingSpawnConfig,
  ): RuntimeBinding {
    return {
      id: row.id,
      runId: row.run_id,
      driverName: row.driver_name,
      contractVersion: row.contract_version,
      cliVersion:
        row.cli_version_raw !== null && row.cli_version_semver !== null
          ? { raw: row.cli_version_raw, semver: row.cli_version_semver }
          : null,
      resumeHandle: row.resume_handle,
      spawnConfig: parsedSpawnConfig ?? this.#parseSpawnConfig(row.id, row.spawn_config),
      runtimeMetadata: JSON.parse(row.runtime_metadata) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Parse a stored `spawn_config` column into the typed record, against the
   * CLOSED key set in `SPAWN_CONFIG_MEMBER_CHECKS`.
   *
   * FAILS LOUD on ANY malformation — unparseable JSON, a non-object, an unknown
   * key, or a known key with the wrong shape — throwing a plain internal-
   * invariant `Error` naming the binding row.
   *
   * WHY LOUD, and why this is a security property rather than tidiness: the
   * CP-005-1 consumer rebuilds `ResumeSessionParams` FROM this record, and
   * resume is a fresh process spawn. A parser that shrugged at a malformed value
   * and returned an all-absent record would hand the resume path a posture-less
   * configuration — and a posture-less relaunch is an UNSANDBOXED one. Silent
   * degradation here converts local data corruption into a sandbox escape, so
   * the only safe reading of a record we cannot read is a refusal.
   *
   * ACCEPTED CONSEQUENCE — one unreadable row REFUSES THE WHOLE LIST at the
   * enumeration seams (`findByRun`, `findByRuns`, `findResumableBindings`,
   * `findById`), because the throw propagates out of the `.map`. That is
   * deliberate, not an oversight: the alternative (skip the row, return the
   * rest) is SILENT UNDER-COUNTING, and both enumerations feed consumers that
   * read a short list as good news — `findByRuns` feeds the Plan-016 T2.10 ack
   * barrier, which is FAIL-OPEN (it proceeds when nothing appears outstanding),
   * and `findResumableBindings` feeds the recovery dispatcher, where a dropped
   * row reads as "nothing to recover". A loud refusal costs an operator a
   * diagnosis; a silent skip costs a barrier that never fired. The exposure is
   * bounded to OUT-OF-BAND corruption in any case: both write seams (`create`
   * pre-INSERT, `update` pre-commit) parse the record before it lands, so this
   * store cannot itself produce a row it later refuses to read.
   *
   * DEPTH LIMIT (see `SPAWN_CONFIG_MEMBER_CHECKS`): this parse proves the key
   * set is CLOSED and each present member's shape ONE LEVEL DEEP. It proves
   * nothing about a member's INNER shape — `{"executionPosture":{}}` parses
   * clean and yields a posture object with no `mode`, no `networkAccess`, and
   * no `writableRoots`. The recovery consumer (T3.14 / Plan-015) owns that
   * guard; a posture-shaped hole is not a posture, and this parser will not
   * catch it.
   *
   * NOT a `ProviderOutputValidationError`: that type is the leak-safe envelope
   * for rejected PROVIDER input crossing the write seam. This value is
   * DAEMON-WRITTEN local state, so a malformation is corrupt storage — an
   * internal invariant violation, not a party to reject. The distinction is the
   * caller's: a `ProviderOutputValidationError` means "the provider misbehaved,
   * refuse it"; this `Error` means "this daemon's own durable state is not what
   * it wrote". Member names are safe to embed for the same reason (a closed,
   * daemon-owned key vocabulary — no provider value ever enters the message).
   *
   * `{}` is a VALID record (all members absent) and is what a pre-B10 row —
   * written before migration `0011` added the column, so carrying its `'{}'`
   * DEFAULT — parses as. That leaves ONE ambiguity, named here rather than
   * papered over: a genuinely-empty live record and a pre-B10 default row are
   * indistinguishable BY VALUE. It is inert in practice because Phase-3 spawn
   * writers always record `resolvedExecutablePath` (T3.23), so a live-written
   * record is never empty — but a reader that must be certain has to look at
   * `created_at` against the migration, not at this value.
   */
  #parseSpawnConfig(bindingId: string, rawSpawnConfig: string): RuntimeBindingSpawnConfig {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawSpawnConfig);
    } catch {
      throw new Error(
        `runtime_bindings.spawn_config is not parseable JSON (binding id ${bindingId}).`,
      );
    }
    if (!isPlainObject(parsed)) {
      throw new Error(
        `runtime_bindings.spawn_config is not a JSON object (binding id ${bindingId}).`,
      );
    }
    // Already narrowed to `Record<string, unknown>` by the `isPlainObject`
    // predicate above — no cast re-stating what the guard just proved.
    const record = parsed;
    for (const key of Object.keys(record)) {
      // Own-key basis on BOTH sides (`Object.keys` above, `hasOwnProperty` here)
      // — the mixed-basis hazard `assertValidCapabilityFlags` documents. The
      // guard IS the unknown-key refusal rather than a feeder into one: past it
      // the key is a member of the closed table, so the lookup below is total
      // and the narrowed index needs no second `undefined` test.
      if (!Object.prototype.hasOwnProperty.call(SPAWN_CONFIG_MEMBER_CHECKS, key)) {
        throw new Error(
          `runtime_bindings.spawn_config carries unknown member "${key}" (binding id ${bindingId}).`,
        );
      }
      const check = SPAWN_CONFIG_MEMBER_CHECKS[key as keyof typeof SPAWN_CONFIG_MEMBER_CHECKS];
      if (!check(record[key])) {
        throw new Error(
          `runtime_bindings.spawn_config member "${key}" has the wrong shape (binding id ${bindingId}).`,
        );
      }
    }
    return record as RuntimeBindingSpawnConfig;
  }
}
