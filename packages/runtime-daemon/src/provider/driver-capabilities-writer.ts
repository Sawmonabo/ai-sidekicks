// DriverCapabilitiesWriter — the daemon-resident driver-capability cache.
//
// Persists a driver's advertised capability snapshot to three driver-keyed SQLite
// tables in one transaction, on driver registration and on capability refresh, and
// serves a cold-start hydration read that rebuilds the whole `GetCapabilitiesResult`
// (`cliVersion` included) from those tables without round-tripping the driver. The
// in-memory `ProviderRegistry` mirrors this cache.
//
//   * driver_capabilities  — the flag matrix (PK driver_name, capability_flag).
//   * driver_tools         — per-tool metadata (PK driver_name, tool_name).
//   * driver_contract_meta — the single per-driver parent row (PK driver_name);
//                            its PRESENCE is the hydration existence gate ("has
//                            this driver ever been written?"). It also carries the
//                            `cli_version_raw` / `cli_version_semver` pair.
//
// All three tables are keyed by `driver_name` and carry no session column: the
// capability cache is a property of the driver, not of a session.
//
// FLAT snapshot vs NESTED hydrate return (do not conflate)
// --------------------------------------------------------------------------
// Change-detection compares the FLAT `CapabilityDetails`
//   { flags: Record<DriverCapabilityFlag, boolean>; contractVersion: string;
//     tools: NormalizedProviderToolMetadata[] }
// while `hydrate()` returns the NESTED `GetCapabilitiesResult`
// (`{ capabilities: { flags, contractVersion }, tools, cliVersion }`) wrapped in
// the `DriverCapabilityHydrationResult` hit/miss discriminant; its `capabilities`
// member is exactly what `ProviderRegistry.register` consumes. One private reader
// produces the flat form and `hydrate()` wraps it.
//
// The cli_version PAIR: cache currency, not a capability
// --------------------------------------------------------------------------
// `cliVersion` reads the INSTALLED BUILD, so it sits outside change-detection on
// purpose: a version bump with an identical snapshot is not a capability change.
//
//   1. The pair rides every mutating upsert, so the row always carries the reading
//      from the declare that last wrote it.
//   2. An unchanged snapshot skips that upsert, so a version-only re-declare would
//      strand a stale pair forever. The unchanged branch therefore updates the
//      pair (+ `refreshed_at`) when, and only when, the stored pair differs from
//      the validated incoming report. Same version, same snapshot writes nothing.
//
// Validation, normalization and canonical SORT before any transaction
// --------------------------------------------------------------------------
// A rejected input never opens a transaction, so "a rejected declare leaves the
// tables untouched" holds without relying on rollback. Before anything else,
// `declare`:
//   1. validates `contractVersion` via `assertValidContractVersion`,
//   2. validates the `flags` key set via `assertValidCapabilityFlags` (exactly the
//      canonical flag set — no extra, no missing key),
//   3. normalizes each tool via `ProviderToolMetadataSchema.safeParse` (fills the
//      `idempotency_class` default `"manual_reconcile_only"`, strips unknown keys,
//      and raises the leak-safe typed error rather than a raw ZodError),
//   4. SORTS the normalized tools by `name` (canonical order).
//
// Read, decide and write in one IMMEDIATE transaction
// --------------------------------------------------------------------------
// The prior-state read, the created/changed/unchanged decision and the table
// writes run inside one `BEGIN IMMEDIATE` transaction. IMMEDIATE takes the write
// lock at BEGIN, so a second declare for the same driver (on this connection or
// another) cannot read the same prior state and then write over it; and a read
// that later upgrades to a write under WAL would risk `SQLITE_BUSY_SNAPSHOT`,
// which IMMEDIATE avoids.
//
// Tools canonical ordering (load-bearing)
// --------------------------------------------------------------------------
// Change-detection uses `node:util.isDeepStrictEqual`, which is key-order
// insensitive for objects but order SENSITIVE for arrays. Sorting the tools by
// `name` on the write side (here) and the read side (`ORDER BY tool_name`) is what
// makes a reorder-only re-declare the no-op it should be.

import { isDeepStrictEqual } from "node:util";

import {
  DRIVER_CAPABILITY_FLAGS,
  ProviderToolMetadataSchema,
  type CapabilityDetails,
  type DriverCapabilityFlag,
  type DriverCliVersionReport,
  type GetCapabilitiesResult,
  type NormalizedProviderToolMetadata,
} from "@ai-sidekicks/contracts";
import type { Database, Statement, Transaction } from "better-sqlite3";

import { declaredOutputSpeedLevelsFor } from "./driver-output-speed.js";
import {
  assertValidCapabilityFlags,
  assertValidCliVersionReport,
  assertValidContractVersion,
  assertValidGetCapabilitiesResultShape,
  ProviderOutputValidationError,
} from "./provider-output-validation.js";

/**
 * Structural equality for two possibly-absent capability snapshots.
 *
 * JSON-round-trips both sides so an `undefined`-valued key (an omitted tool
 * `description`) compares cleanly. `isDeepStrictEqual` is key-order-insensitive
 * but array-order-SENSITIVE, which the canonical tool sort accounts for.
 */
function snapshotsEqual(
  left: CapabilityDetails | undefined,
  right: CapabilityDetails | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(left)) as unknown,
    JSON.parse(JSON.stringify(right)) as unknown,
  );
}

/**
 * One capability declaration. `driverName` keys all three tables; `result` is the
 * driver's advertised `GetCapabilitiesResult`, whose `cliVersion` is persisted into
 * `driver_contract_meta` (see the file header's cli_version section).
 */
export interface DeclareDriverCapabilitiesInput {
  // The cache key for driver_capabilities / driver_tools / driver_contract_meta.
  readonly driverName: string;
  // The driver's advertised capability snapshot (nested wrapper).
  readonly result: GetCapabilitiesResult;
}

/**
 * `declare` return.
 *
 * `snapshotChange` says what the capability snapshot did:
 *   * `"created"`   — first write for this driver.
 *   * `"changed"`   — the snapshot differs from the stored one.
 *   * `"unchanged"` — the snapshot was identical; no capability row was written.
 *
 * `cliVersionRefreshed` is an orthogonal fact: `true` iff this call wrote a
 * `cli_version_raw` / `cli_version_semver` pair differing from the pair it read.
 *   * `"created"`   — always `true` (an absent row has no pair).
 *   * `"changed"`   — `true` only when the incoming report differs from the stored
 *                     pair; a capability change from the SAME build reports `false`
 *                     even though the upsert restated the pair.
 *   * `"unchanged"` — `true` only when the version-only pair refresh ran.
 */
export interface DeclareDriverCapabilitiesResult {
  readonly snapshotChange: "created" | "changed" | "unchanged";
  readonly cliVersionRefreshed: boolean;
}

/**
 * `hydrate` return — an explicit HIT/MISS discriminant over the durable cache.
 *
 * The hit arm carries the WHOLE `GetCapabilitiesResult`, `cliVersion` included.
 * The miss arm names its cause:
 *   * `"never_written"`       — no `driver_contract_meta` row: this driver has
 *                               never been declared on this node.
 *   * `"cli_version_missing"` — the row exists but its version pair is NULL. The
 *                               required `GetCapabilitiesResult.cliVersion` is never
 *                               fabricated from cache: a made-up reading would feed a
 *                               FALSE version into the fail-closed attach-time floor
 *                               gate, so hydration refreshes from the driver instead.
 *
 * A `driver_contract_meta` row with a wrong flag key set is not a miss: it THROWS
 * from the snapshot reader's key-set proof, because a silently-wrong capability
 * matrix is worse than failing loud.
 */
export type DriverCapabilityHydrationResult =
  | { readonly hit: true; readonly result: GetCapabilitiesResult }
  | { readonly hit: false; readonly reason: "never_written" | "cli_version_missing" };

// Private row shapes (snake_case, raw DB shape).
interface DriverCapabilityRow {
  readonly capability_flag: string;
  readonly supported: number;
}

interface DriverToolRow {
  readonly tool_name: string;
  readonly idempotency_class: string;
  readonly description: string | null;
}

interface DriverContractMetaRow {
  readonly contract_version: string;
  // Both-or-neither at the DB level (the `(cli_version_semver IS NULL) =
  // (cli_version_raw IS NULL)` CHECK), never a half-populated version.
  readonly cli_version_raw: string | null;
  readonly cli_version_semver: string | null;
}

/**
 * The composite cache read: the flat capability snapshot plus the stored
 * currency pair, from one consistent read.
 *
 * `snapshot === undefined` ⇒ the driver was never written. `snapshot` present with
 * `storedCliVersion === undefined` ⇒ the row exists but its pair is NULL. Row
 * presence stays separable from pair presence because `hydrate`'s two miss
 * reasons are read off them.
 */
interface CachedDriverCapabilityRead {
  readonly snapshot: CapabilityDetails | undefined;
  readonly storedCliVersion: DriverCliVersionReport | undefined;
}

/**
 * Structural equality for two possibly-absent `cliVersion` readings, shared by
 * the `cliVersionRefreshed` computation and the unchanged branch's pair refresh so
 * the returned flag and the write it describes cannot disagree. Absent-vs-present
 * is a difference, so a row with a NULL pair self-heals on the next declare.
 */
function cliVersionReportsEqual(
  left: DriverCliVersionReport | undefined,
  right: DriverCliVersionReport | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.raw === right.raw && left.semver === right.semver;
}

/**
 * The write seam a driver declares its capabilities through: the writer narrowed
 * to `declare`. A `Pick` of the class, so a changed `declare` signature breaks
 * every driver at compile time, and a test double needs no database handle.
 */
export type DriverCapabilityDeclarationSink = Pick<DriverCapabilitiesWriter, "declare">;

/**
 * Persists a driver's declared capabilities to the three driver-keyed tables and
 * hydrates them back without a provider round-trip.
 */
export class DriverCapabilitiesWriter {
  // Only prepared statements and transaction wrappers are retained; the raw `db`
  // handle is not stored (a prepared statement keeps its connection alive).
  readonly #selectCapabilityFlagsStmt: Statement;
  readonly #selectToolsStmt: Statement;
  readonly #selectContractMetaStmt: Statement;
  readonly #upsertCapabilityFlagStmt: Statement;
  readonly #deleteToolsStmt: Statement;
  readonly #insertToolStmt: Statement;
  readonly #upsertContractMetaStmt: Statement;
  // The version-only pair refresh (the unchanged branch). Separate from the upsert
  // above because it must not touch `contract_version`, must not INSERT (the row
  // already exists on that branch), and must not rewrite the capability rows.
  readonly #refreshCliVersionPairStmt: Statement;
  // `#cachedRead` runs three SELECTs; in autocommit each takes its own snapshot,
  // so a refresh committing between them would yield a TORN read. `hydrate` runs
  // them DEFERRED (a pure read takes no write lock) so they share one snapshot.
  readonly #readTxn: Transaction<(driverName: string) => CachedDriverCapabilityRead>;
  // The read-decide-write body of `declare`, dispatched IMMEDIATE (file header).
  readonly #declareTxn: Transaction<
    (
      driverName: string,
      newSnapshot: CapabilityDetails,
      declaredCliVersion: DriverCliVersionReport,
    ) => DeclareDriverCapabilitiesResult
  >;
  // Injected wall-clock for `refreshed_at` (deterministic tests).
  readonly #now: () => string;

  constructor(db: Database, now: () => string = () => new Date().toISOString()) {
    this.#now = now;

    // --- Readers (the snapshot reconstruction + change-detection source) ---
    // driver_capabilities: the per-flag rows for one driver. No ORDER BY needed
    // — flags reconstruct into a keyed Record, which is key-order-insensitive.
    this.#selectCapabilityFlagsStmt = db.prepare(
      `SELECT capability_flag, supported
         FROM driver_capabilities
        WHERE driver_name = ?`,
    );
    // driver_tools: ORDER BY tool_name gives the canonical (name-ascending)
    // order, so the read side matches the write side's sort — the array-order
    // equality that keeps a reorder-only re-declare a no-op (see file header).
    this.#selectToolsStmt = db.prepare(
      `SELECT tool_name, idempotency_class, description
         FROM driver_tools
        WHERE driver_name = ?
        ORDER BY tool_name`,
    );
    // driver_contract_meta: the single parent row. Its PRESENCE is the existence
    // gate — no row ⇒ driver never written ⇒ `#cachedRead` has no snapshot.
    // The currency pair is selected on the SAME row read: it lives on this row,
    // so reading it costs no extra statement, and taking it from the same read
    // is what keeps "row present / pair NULL" distinguishable from "no row" for
    // `hydrate`'s two miss reasons.
    this.#selectContractMetaStmt = db.prepare(
      `SELECT contract_version, cli_version_raw, cli_version_semver
         FROM driver_contract_meta
        WHERE driver_name = ?`,
    );

    // --- Writers ---
    // driver_capabilities UPSERT. The flag enum is FIXED, so we upsert exactly one
    // row per `DRIVER_CAPABILITY_FLAGS` member every write and a plain
    // ON CONFLICT … DO UPDATE leaves no orphan class (no flag can ever be
    // "dropped" the way a tool can).
    this.#upsertCapabilityFlagStmt = db.prepare(
      `INSERT INTO driver_capabilities (driver_name, capability_flag, supported, refreshed_at)
       VALUES (@driver_name, @capability_flag, @supported, @refreshed_at)
       ON CONFLICT(driver_name, capability_flag)
         DO UPDATE SET supported    = excluded.supported,
                       refreshed_at = excluded.refreshed_at`,
    );
    // driver_tools is DELETE-then-reinsert (NOT upsert): a refresh that REMOVES a
    // tool must not leave an orphan row, and a plain upsert would never delete a
    // dropped tool. The DELETE and the re-INSERTs share one transaction, so the
    // replacement is atomic.
    this.#deleteToolsStmt = db.prepare(`DELETE FROM driver_tools WHERE driver_name = ?`);
    this.#insertToolStmt = db.prepare(
      `INSERT INTO driver_tools (driver_name, tool_name, idempotency_class, description, refreshed_at)
       VALUES (@driver_name, @tool_name, @idempotency_class, @description, @refreshed_at)`,
    );
    // driver_contract_meta UPSERT — the single PK row. The currency pair rides
    // every mutating branch (created and changed alike): the row always carries
    // the reading from the declare that last wrote it, so the pair can never lag
    // a capability write.
    this.#upsertContractMetaStmt = db.prepare(
      `INSERT INTO driver_contract_meta (driver_name, contract_version, cli_version_raw, cli_version_semver, refreshed_at)
       VALUES (@driver_name, @contract_version, @cli_version_raw, @cli_version_semver, @refreshed_at)
       ON CONFLICT(driver_name)
         DO UPDATE SET contract_version   = excluded.contract_version,
                       cli_version_raw    = excluded.cli_version_raw,
                       cli_version_semver = excluded.cli_version_semver,
                       refreshed_at       = excluded.refreshed_at`,
    );
    // The unchanged-branch currency refresh. Both pair columns are written together,
    // never one at a time — the table's both-or-neither CHECK makes a
    // half-populated pair unrepresentable, and this statement honors that shape
    // rather than relying on the CHECK to catch a mistake.
    this.#refreshCliVersionPairStmt = db.prepare(
      `UPDATE driver_contract_meta
          SET cli_version_raw    = @cli_version_raw,
              cli_version_semver = @cli_version_semver,
              refreshed_at       = @refreshed_at
        WHERE driver_name = @driver_name`,
    );

    this.#readTxn = db.transaction(
      (driverName: string): CachedDriverCapabilityRead => this.#cachedRead(driverName),
    );
    this.#declareTxn = db.transaction(
      (
        driverName: string,
        newSnapshot: CapabilityDetails,
        declaredCliVersion: DriverCliVersionReport,
      ): DeclareDriverCapabilitiesResult =>
        this.#readDecideWrite(driverName, newSnapshot, declaredCliVersion),
    );
  }

  /**
   * Declare (or refresh) a driver's advertised capabilities. Validates, normalizes
   * and canonically sorts, then reads the stored snapshot, decides and writes in one
   * IMMEDIATE transaction. An identical re-declare writes no capability row.
   *
   * A rejected input (invalid `contractVersion`, bad `flags` key set, malformed
   * tool) throws `ProviderOutputValidationError` before any transaction opens.
   */
  async declare(input: DeclareDriverCapabilitiesInput): Promise<DeclareDriverCapabilitiesResult> {
    // (0) STRUCTURAL shape guard BEFORE any property dereference. The static
    // `DeclareDriverCapabilitiesInput` type is erased at runtime, so a malformed
    // driver can ship `result`, `result.capabilities`, or `result.tools` as
    // null/array/primitive — and the very next line dereferences
    // `input.result.capabilities.contractVersion`. Without this guard those
    // accesses (and `input.result.tools.map(...)` below) raw-throw a TypeError,
    // escaping this module's leak-safe doctrine (a rejected/invalid input must
    // surface ONLY `ProviderOutputValidationError`, and must NEVER open a txn).
    // This guards EXACTLY the accesses `declare` already makes — it is NOT a
    // full re-parse of the result (value-normalization stays the driver
    // adapter's job per provider-output-validation.ts's boundary comment).
    assertValidGetCapabilitiesResultShape(input.result);

    // (0b) Validate the REQUIRED `cliVersion` reading, immediately after the
    // structural guard and still before any txn opens — the same
    // defense-in-depth position the `contract_version` assert holds, and for the
    // same reason: persists this pair into two CHECK-constrained columns
    // (`length(cli_version_raw) <= 128`, `length(cli_version_semver) <= 64`,
    // NUL-free, non-empty), so an unvalidated report would trip a raw
    // `SqliteError` from INSIDE the write transaction — breaking both the "a
    // rejected input never opens a transaction" and the "leak-safe
    // `ProviderOutputValidationError`, never a raw error" doctrines.
    //
    // The PRESENCE/TYPE guard is this validator's, not an inline one here. The
    // shape assert above is deliberately bounded to the three accesses `declare`
    // makes and does NOT reach `cliVersion`, so a driver can ship it absent or
    // primitive; duplicating a guard here would make the validator's own check
    // dead code and create a second source of truth for the same rule.
    //
    // SNAPSHOT FIRST, THEN VALIDATE — and from here on the snapshot is the ONLY
    // copy this method reads. Each member is taken off the provider's object
    // EXACTLY ONCE, into a fresh plain two-member object; that object is what
    // the assert below judges, what the `cliVersionRefreshed` comparison uses,
    // and what the durable write binds. Re-reading `input.result.cliVersion`
    // after the assert would reopen a TOCTOU window: the report is untrusted
    // provider input, so a getter (or a Proxy) re-evaluated between validation
    // and the write could persist a string that never passed validation,
    // leaving the DDL CHECK's length+NUL bounds as the only remaining guard.
    // Two plain strings sever getters, `toJSON` hooks, and prototype tricks
    // alike — the same defensive-copy doctrine the `flags` record follows at
    // step (5).
    //
    // A NON-object report is passed through UNCOPIED, deliberately: this copy
    // makes no admission decision — it only decides what is read once — so the
    // validator remains the SOLE owner of the accept/reject judgment and still
    // refuses an absent/null/primitive report on its own terms (`cliVersion`).
    // The property reads themselves are part of the getter/Proxy threat model:
    // a throwing accessor would otherwise escape as the provider's OWN
    // exception — provider-controlled text, untyped — before the assert below
    // could produce the leak-safe refusal. Translate
    // any accessor throw into the same typed refusal, discarding the thrown
    // value entirely so nothing provider-controlled reaches the message.
    let declaredCliVersion: DriverCliVersionReport;
    try {
      const reportedCliVersion: DriverCliVersionReport = input.result.cliVersion;
      declaredCliVersion =
        typeof reportedCliVersion === "object" &&
        reportedCliVersion !== null &&
        !Array.isArray(reportedCliVersion)
          ? { raw: reportedCliVersion.raw, semver: reportedCliVersion.semver }
          : reportedCliVersion;
    } catch {
      throw new ProviderOutputValidationError("Invalid provider cli_version report.", {
        driverName: input.driverName,
        field: "cliVersion",
        reason: "a property accessor on the report threw during the defensive copy",
      });
    }
    assertValidCliVersionReport(input.driverName, declaredCliVersion);

    // (1) Validate the provider-declared contract_version at the write seam
    // (defense-in-depth on top of the SQL CHECK — reuses the same assert as
    // RuntimeBindingStore). THROWS `ProviderOutputValidationError` on failure,
    // before any txn opens.
    assertValidContractVersion(input.result.capabilities.contractVersion);

    // (2) Validate the `flags` key-set cardinality at the write seam — EXACTLY
    // the canonical `DRIVER_CAPABILITY_FLAGS` key set, no extra and no missing key
    // (this writer explodes
    // `flags` into one CHECK-constrained `driver_capabilities` row per flag, so
    // an extra/typo'd key would otherwise hit the SQL CHECK mid-transaction and
    // an omitted key would persist an under-full cache). THROWS the leak-safe
    // `ProviderOutputValidationError`, before any txn opens.
    assertValidCapabilityFlags(input.result.capabilities.flags);

    // (3) Normalize each ingress tool via the contract schema — fills the
    // `idempotency_class` default `"manual_reconcile_only"` and strips unknown keys
    // (forward-compat). `safeParse` (NOT `.parse()`) so a malformed tool surfaces the
    // leak-safe `ProviderOutputValidationError` — error-type-symmetric with the
    // contract_version path, never a raw `ZodError` (the leak-safe doctrine of
    // `provider-output-validation.ts`). Still before any txn opens.
    const normalizedTools: NormalizedProviderToolMetadata[] = input.result.tools.map((tool) => {
      const parsed = ProviderToolMetadataSchema.safeParse(tool);
      if (!parsed.success) {
        throw new ProviderOutputValidationError("Invalid provider tool metadata.", {
          field: "tools",
          reason:
            "tool name/description must be non-empty, non-whitespace, NUL-free, within length bounds",
        });
      }
      return parsed.data;
    });

    // (4) SORT the normalized tools by `name` ascending (canonical order). This
    // is what makes the array-sensitive `isDeepStrictEqual` comparison correct,
    // so a reorder-only re-declare is a no-op rather than a spurious update (see
    // file header). A copy is sorted in place — `.map()` above already produced a
    // fresh array, so this does not mutate the caller's input.
    //
    // The comparator orders by UTF-8 BYTES (`Buffer.compare` of each name's
    // UTF-8 encoding), NOT by JS string `<`/`>` and NOT by `localeCompare`, so
    // the WRITE-side order MATCHES the READ-side order: the snapshot reader
    // orders via SQLite `ORDER BY tool_name`, and `driver_tools.tool_name` has NO
    // COLLATE override, so SQLite uses its default BINARY collation — a memcmp of
    // the stored UTF-8 bytes (better-sqlite3 stores TEXT as UTF-8). Matching that
    // exact encoding is what makes the two sides agree.
    //
    // Why not JS `<`/`>`: JS string comparison is by UTF-16 CODE UNIT, not by
    // code point or UTF-8 byte. For a supplementary-plane name (e.g. an emoji,
    // U+1F600, whose UTF-16 lead surrogate is 0xD83D) adjacent to a high-BMP name
    // in U+E000–U+FFFF, JS orders the surrogate FIRST (0xD83D < 0xE000) while
    // SQLite BINARY orders the BMP name first (its UTF-8 lead byte 0xEE < the
    // emoji's 0xF0) — the two sides DIVERGE. Since change-detection
    // (`isDeepStrictEqual`, array-order-sensitive) and `hydrate()` both read the
    // tool array positionally, that divergence would fire a spurious
    // `"changed"` on an identical re-declare AND mismatch the hydrate
    // order. `localeCompare` would diverge even on common mixed-case names. The
    // guarantee here comes from matching encodings (UTF-8 bytes === SQLite BINARY
    // on a no-COLLATE TEXT column), not from any property of JS `<`.
    normalizedTools.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")),
    );

    // (4b) REJECT duplicate NORMALIZED tool names BEFORE the txn opens. Two tools
    // sharing a normalized `name` would have the second `#insertToolStmt.run`
    // violate the `(driver_name, tool_name)` PRIMARY KEY inside the write
    // transaction, throwing a raw `SQLITE_CONSTRAINT` from an open transaction. That
    // breaks this module's two doctrines: "a REJECTED input never opens a
    // transaction" and "leak-safe `ProviderOutputValidationError`, never a raw
    // error" — and makes a provider-declaration bug look like a storage failure.
    // The tools are already sorted by name, so a duplicate is an adjacent pair;
    // surface the leak-safe typed error alongside the other pre-txn asserts.
    for (let index = 1; index < normalizedTools.length; index += 1) {
      if (normalizedTools[index]?.name === normalizedTools[index - 1]?.name) {
        throw new ProviderOutputValidationError("Invalid provider tool metadata.", {
          field: "tools",
          reason: "duplicate tool name",
        });
      }
    }

    // (5) Build the NEW flat snapshot (the canonical `CapabilityDetails` shape).
    // Build `flags` as a FRESH plain record keyed by the canonical
    // `DRIVER_CAPABILITY_FLAGS`, reading each validated flag ONCE — never store the
    // provider's raw `flags` object by reference. Two consumers read this
    // snapshot's flags: the change-detection JSON round-trip (`snapshotsEqual`)
    // and the `driver_capabilities` write loop (raw `flags[flag]` reads). A raw
    // provider object can carry a custom/inherited `toJSON` that passes
    // `assertValidCapabilityFlags` (own enumerable keys + boolean values only, NOT
    // the prototype) yet taints the JSON round-trip while the write loop sees the
    // true booleans — diverging the persisted rows from the change-detect snapshot
    // and reporting a spurious `"changed"` on an identical re-declare. A fresh
    // own-key boolean record severs toJSON / getters / prototype hooks.
    const flags = {} as Record<DriverCapabilityFlag, boolean>;
    for (const capabilityFlag of DRIVER_CAPABILITY_FLAGS) {
      flags[capabilityFlag] = input.result.capabilities.flags[capabilityFlag] === true;
    }
    const newSnapshot: CapabilityDetails = {
      flags,
      contractVersion: input.result.capabilities.contractVersion,
      tools: normalizedTools,
    };

    // (5b) The `cliVersion` reading is deliberately NOT part of `newSnapshot`: it
    // is cache currency, not a capability (file header, cli_version section). It
    // travels separately as `declaredCliVersion`, the defensive copy taken at step
    // (0b) and never re-read from the provider's object since.
    return this.#declareTxn.immediate(input.driverName, newSnapshot, declaredCliVersion);
  }

  /**
   * The body of `#declareTxn`: reads the stored state, decides created, changed or
   * unchanged, and writes. Runs inside the IMMEDIATE transaction, so it calls
   * `#cachedRead` directly (better-sqlite3 rejects a nested transaction).
   */
  #readDecideWrite(
    driverName: string,
    newSnapshot: CapabilityDetails,
    declaredCliVersion: DriverCliVersionReport,
  ): DeclareDriverCapabilitiesResult {
    const priorRead: CachedDriverCapabilityRead = this.#cachedRead(driverName);
    const priorSnapshot: CapabilityDetails | undefined = priorRead.snapshot;
    // "Did the durable pair CHANGE", not "did a statement run": a capability change
    // re-declared from the SAME build reports `false` though the upsert restates it.
    const cliVersionRefreshed: boolean = !cliVersionReportsEqual(
      priorRead.storedCliVersion,
      declaredCliVersion,
    );

    if (snapshotsEqual(priorSnapshot, newSnapshot)) {
      // The version-only refresh: without it a provider upgrade that changed no
      // capability would strand the OLD version in the cache, and every later
      // hydration would hand a stale reading to the attach-time floor gate. Same
      // version, same snapshot writes nothing and `refreshed_at` does not move.
      if (cliVersionRefreshed) {
        this.#refreshCliVersionPairStmt.run({
          driver_name: driverName,
          cli_version_raw: declaredCliVersion.raw,
          cli_version_semver: declaredCliVersion.semver,
          refreshed_at: this.#now(),
        });
      }
      return { snapshotChange: "unchanged", cliVersionRefreshed };
    }

    const refreshedAt: string = this.#now();

    // driver_capabilities — one row per canonical flag; `supported = 1` iff `true`.
    for (const capabilityFlag of Object.keys(newSnapshot.flags) as DriverCapabilityFlag[]) {
      this.#upsertCapabilityFlagStmt.run({
        driver_name: driverName,
        capability_flag: capabilityFlag,
        supported: newSnapshot.flags[capabilityFlag] ? 1 : 0,
        refreshed_at: refreshedAt,
      });
    }

    // driver_tools — DELETE-then-reinsert (drops removed tools).
    this.#deleteToolsStmt.run(driverName);
    for (const tool of newSnapshot.tools) {
      this.#insertToolStmt.run({
        driver_name: driverName,
        tool_name: tool.name,
        idempotency_class: tool.idempotency_class,
        description: tool.description ?? null,
        refreshed_at: refreshedAt,
      });
    }

    // driver_contract_meta — the single PK row. The pair rides the upsert
    // unconditionally: restating an unchanged pair costs one column assignment,
    // while a conditional would need a second statement for the same row state.
    this.#upsertContractMetaStmt.run({
      driver_name: driverName,
      contract_version: newSnapshot.contractVersion,
      cli_version_raw: declaredCliVersion.raw,
      cli_version_semver: declaredCliVersion.semver,
      refreshed_at: refreshedAt,
    });

    return {
      snapshotChange: priorSnapshot === undefined ? "created" : "changed",
      cliVersionRefreshed,
    };
  }

  /**
   * Cold-start hydration: reconstruct a driver's advertised capability snapshot from
   * the durable cache WITHOUT round-tripping the driver. A pure read; the SELECTs
   * run inside ONE `BEGIN DEFERRED` read transaction so they share a consistent
   * snapshot — see the `#readTxn` field comment.
   *
   * Returns the {@link DriverCapabilityHydrationResult} hit/miss discriminant.
   * The HIT arm carries the NESTED, COMPLETE `GetCapabilitiesResult`
   * (`{ capabilities: { flags, contractVersion }, tools, cliVersion }`) — whose
   * `capabilities` member is what `ProviderRegistry.register` consumes — NOT the
   * flat `CapabilityDetails` change-detection compares (see the file header).
   * `tools` is in canonical order.
   *
   * A NULL version pair is a MISS (`"cli_version_missing"`), not a hit with a blank
   * version: the required `GetCapabilitiesResult.cliVersion` is never fabricated from
   * cache, and the caller refreshes from the driver. A never-written driver is the
   * OTHER miss (`"never_written"`); see the result type for why the two stay
   * distinguishable.
   *
   * `outputSpeedLevels` does the OPPOSITE, and the asymmetry is the contract's
   * own: that member is required whenever the reconstructed `flags.output_speed`
   * is `true`, "on either read path". Omitting it here would hand back a report
   * that is contract-invalid while looking well-formed — `output_speed: true`
   * with nothing for a client to render. It is served from the static per-driver
   * table rather than from a cache column because it is a constant OF THE DRIVER
   * and always re-derivable, while `detectionSource` is a fact about one reading
   * and cannot be.
   */
  hydrate(driverName: string): DriverCapabilityHydrationResult {
    const cached: CachedDriverCapabilityRead = this.#readTxn.deferred(driverName);
    if (cached.snapshot === undefined) {
      return { hit: false, reason: "never_written" };
    }
    if (cached.storedCliVersion === undefined) {
      return { hit: false, reason: "cli_version_missing" };
    }
    return {
      hit: true,
      result: {
        capabilities: {
          flags: cached.snapshot.flags,
          contractVersion: cached.snapshot.contractVersion,
        },
        // Copied: contracts' `CapabilityDetails.tools` is readonly; the nested
        // `GetCapabilitiesResult.tools` ingress field is mutable.
        tools: [...cached.snapshot.tools],
        cliVersion: cached.storedCliVersion,
        // Present iff the RECONSTRUCTED flag says so — read off the cached
        // snapshot rather than off the live driver table, so a row written
        // before this driver declared the axis hydrates without the member
        // exactly as it was written. A fresh copy for the same reason the live
        // declaration hands one out: the table's arrays are frozen and shared.
        ...(cached.snapshot.flags.output_speed
          ? { outputSpeedLevels: [...declaredOutputSpeedLevelsFor(driverName)] }
          : {}),
      },
    };
  }

  // ------------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------------

  /**
   * The COMPOSITE cache read: the flat snapshot plus the stored currency pair,
   * off ONE `driver_contract_meta` row read. Called inside `#readTxn` or
   * `#declareTxn`, so both halves come from the same consistent read snapshot.
   *
   * Row presence and pair presence are surfaced SEPARATELY (see
   * {@link CachedDriverCapabilityRead}) — collapsing them here would erase the
   * distinction `hydrate`'s two miss reasons are built on before either caller
   * could see it.
   */
  #cachedRead(driverName: string): CachedDriverCapabilityRead {
    const contractMeta: DriverContractMetaRow | undefined = this.#selectContractMetaStmt.get(
      driverName,
    ) as DriverContractMetaRow | undefined;
    if (contractMeta === undefined) {
      return { snapshot: undefined, storedCliVersion: undefined };
    }
    return {
      snapshot: this.#snapshotFromContractMeta(driverName, contractMeta),
      // Both columns or neither — the table's both-or-neither CHECK guarantees
      // it, and the `&&` reads the guarantee rather than assuming it, so a
      // half-populated row (only reachable by out-of-band corruption predating
      // the CHECK) degrades to a cache MISS rather than to a half-built report.
      storedCliVersion:
        contractMeta.cli_version_raw !== null && contractMeta.cli_version_semver !== null
          ? { raw: contractMeta.cli_version_raw, semver: contractMeta.cli_version_semver }
          : undefined,
    };
  }

  /**
   * Reconstruct the FLAT `CapabilityDetails` snapshot from the child tables, given
   * the already-fetched parent row (whose presence proves the driver was written).
   * `tools` come back in canonical (`name`-ascending) order via `ORDER BY
   * tool_name`, matching the write side's sort.
   */
  #snapshotFromContractMeta(
    driverName: string,
    contractMeta: DriverContractMetaRow,
  ): CapabilityDetails {
    // Reconstruct the flag matrix. `supported === 1` → `true`. The Record is
    // keyed by `capability_flag`, but the column's CHECK is a SUPERSET
    // whitelist, not an exact guarantee: a CHECK admits a value forever once
    // written, so it cannot narrow when a union does, and a stored value passing
    // it is NOT by itself a `DriverCapabilityFlag`. The key-set assertion below
    // is what makes the
    // `Record<DriverCapabilityFlag, boolean>` typing sound — only canonical
    // keys are ever assigned, and every canonical key is proven present before
    // the record is handed out.
    const flagRows: DriverCapabilityRow[] = this.#selectCapabilityFlagsStmt.all(
      driverName,
    ) as DriverCapabilityRow[];
    // Belt-and-suspenders corrupt-cache guard: a written driver (parent row
    // present) MUST carry EXACTLY the canonical flag key set — no more, no
    // fewer. This is a KEY-SET proof rather than a row COUNT, and the difference
    // is load-bearing for as long as the CHECK stays a superset of the union: an
    // out-of-band row carrying a CHECK-admitted value the union does not name,
    // written in place of a real flag's row, holds the count steady while
    // silently dropping a flag key, and a count-only guard would hand that cache
    // out as a complete flag matrix. It is the read-side twin of the write-seam
    // `assertValidCapabilityFlags` (own-key count + own-key presence ⇒
    // pigeonhole), reaching the same exactness by naming both directions
    // outright. That write-seam guard + the single write transaction make a wrong key
    // set unreachable through this writer, so a violation here means
    // out-of-band corruption (a manual DELETE or UPDATE, a future schema
    // bug); fail LOUD rather than reconstruct a silently-wrong flag matrix.
    // Reached only with a parent row already in hand (`#cachedRead` gates on it),
    // so a never-written driver never trips it. A plain internal-invariant `Error`
    // (NOT `ProviderOutputValidationError` — this is a corrupt cache, not
    // provider input) — and unlike that deliberately leak-safe write-seam
    // guard it NAMES the offending keys, because these are our own stored rows
    // rather than untrusted provider input.
    const flags: Record<DriverCapabilityFlag, boolean> = {} as Record<
      DriverCapabilityFlag,
      boolean
    >;
    const unexpectedFlags: string[] = [];
    for (const row of flagRows) {
      if ((DRIVER_CAPABILITY_FLAGS as readonly string[]).includes(row.capability_flag)) {
        flags[row.capability_flag as DriverCapabilityFlag] = row.supported === 1;
      } else {
        // Collected, never assigned — a non-canonical row never becomes a key,
        // so "no extra key survived" holds by construction rather than by a
        // second sweep over the record.
        unexpectedFlags.push(row.capability_flag);
      }
    }
    const missingFlags: DriverCapabilityFlag[] = DRIVER_CAPABILITY_FLAGS.filter(
      (flag) => !Object.hasOwn(flags, flag),
    );
    if (missingFlags.length > 0 || unexpectedFlags.length > 0) {
      throw new Error(
        `driver_capabilities row-set invariant violated for "${driverName}": ` +
          `expected exactly the ${DRIVER_CAPABILITY_FLAGS.length.toString()} canonical ` +
          `capability flags; missing [${missingFlags.join(", ")}], ` +
          `unexpected [${unexpectedFlags.join(", ")}].`,
      );
    }

    // Reconstruct the canonical-order tool list. DB `description` NULL maps back
    // to `undefined` (the `NormalizedProviderToolMetadata` optional field); the
    // `idempotency_class` column's CHECK guarantees a valid stored enum.
    const toolRows: DriverToolRow[] = this.#selectToolsStmt.all(driverName) as DriverToolRow[];
    const tools: NormalizedProviderToolMetadata[] = toolRows.map((row) => {
      const tool: NormalizedProviderToolMetadata = {
        name: row.tool_name,
        idempotency_class:
          row.idempotency_class as NormalizedProviderToolMetadata["idempotency_class"],
        // Omit `description` entirely when NULL — `exactOptionalPropertyTypes`
        // forbids an explicit `description: undefined`, and an omitted key is the
        // round-trip-stable form (matches a tool declared with no description).
        ...(row.description !== null ? { description: row.description } : {}),
      };
      return tool;
    });

    return {
      flags,
      contractVersion: contractMeta.contract_version,
      tools,
    };
  }
}
