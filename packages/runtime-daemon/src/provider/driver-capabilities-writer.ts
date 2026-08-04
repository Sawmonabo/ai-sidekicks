// DriverCapabilitiesWriter — the daemon-resident driver-capability cache seam
// (Plan-005 Phase 2, T2.4).
//
// What this seam does
// --------------------------------------------------------------------------
// Persists a driver's advertised capability snapshot to the THREE driver-keyed
// SQLite tables (migration `0003`) AND emits the matching
// `runtime_node.capability_*` session event, ATOMICALLY, on driver
// registration + capability refresh. It also exposes a cold-start hydration
// read that reconstructs the in-memory `GetCapabilitiesResult` wrapper from
// those same three tables WITHOUT round-tripping the driver (`Spec-005 §Recovery Consequences`,
// the cache-as-source-of-truth). This is the durable cache that the in-memory
// `ProviderRegistry` (T2.3) mirrors; together they complete the capability
// round-trip that T2.5 verifies end-to-end (`Spec-005 §Required Behavior`, invariant I-005-2).
//
//   * driver_capabilities  — the 7-flag matrix (PK driver_name, capability_flag).
//   * driver_tools         — per-tool metadata (PK driver_name, tool_name).
//   * driver_contract_meta — the single per-driver `contract_version` parent row
//                            (PK driver_name); its PRESENCE is the existence gate
//                            for hydration ("has this driver ever been written?").
//
// All three tables are keyed by `driver_name` and carry NO session column — the
// capability cache is a DRIVER property, not a session one. `sessionId` /
// `nodeId` are threaded to the EMIT only (the event lands on a session timeline)
// and are NEVER stored in the driver tables.
//
// FLAT event payload vs NESTED hydrate return (do not conflate)
// --------------------------------------------------------------------------
// The canonical `CapabilityDetails` (`docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy` — the
// shape Plan-006 T1.4 bound over the previously interim-opaque
// `capabilityDetails` / `previousState` / `newState` event payload fields, as
// the canonical-first arm of a tolerant union — CP-003-1 leg (c)) is FLATTENED:
//   { flags: Record<DriverCapabilityFlag, boolean>; contractVersion: string;
//     tools: NormalizedProviderToolMetadata[] }
// The EVENT payload carries the FLAT snapshot, which already parses under the
// T1.4-landed canonical-first arm at EMIT time (the emitter's
// `RuntimeNodeCapability*PayloadSchema.parse`) and stays valid when Plan-006
// Tier 4's `SessionEventSchema` union registration — CP-003-1 leg (a) — begins
// validating these events. Carrying the NESTED `GetCapabilitiesResult` in the
// event would miss the canonical arm at BOTH layers — accepted forever via the
// tolerant record arm, never canonically typed. By contrast `hydrate()` returns
// the NESTED `GetCapabilitiesResult` — `{ capabilities: { flags,
// contractVersion }, tools }` — which is exactly what `ProviderRegistry.register`
// consumes (`result.capabilities`). A single private `#snapshot(driverName)`
// reader produces the FLAT form, which is the one source for BOTH change-
// detection and event contents; `hydrate()` wraps that flat snapshot into the
// nested form.
//
// Capability key — `"provider-driver-<driverName>"` (CP-005-5)
// --------------------------------------------------------------------------
// The emitted `capability` identifier is `"provider-driver-" + driverName`
// (e.g. `provider-driver-claude`), per CP-005-5 (`Plan-005 §CP-005-5 — Driver capability event surface owed to [Plan-006](./006-session-event-taxonomy-and-audit-log.md) / [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md)`), which
// directs the emit on driver registration + refresh with
// `capability: "provider-driver-{codex|claude}"`. The DRIVER-NAME SUFFIX
// disambiguates MULTIPLE drivers on one runtime node IN-PLAN — it is the
// resolved contract (CP-005-5 status: RESOLVED), NOT a deferred Plan-006
// concern. (`docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy`'s bare `"provider-driver"` is only an
// ILLUSTRATIVE example of the `capability` field, not the canonical value;
// CP-005-5 is the authority.)
//
// Atomic dual-write, and who owns the transaction
// --------------------------------------------------------------------------
// Each declare that actually changes state is a DUAL-WRITE (upsert the three
// tables AND emit the event) committing in ONE transaction, so the rows and the
// event land together — a non-atomic dual-write would ship a partial-state
// corruption bug (the same discipline as `node/node-capability-service.ts`).
// BODY ORDER is load-bearing: the three writes come FIRST, the event row LAST,
// so a THROWING event write rolls back the cache write.
//
// THIS WRITER NO LONGER OPENS THAT TRANSACTION. Plan-006 T3.1 re-pointed the
// emitter onto the async `EventLogService.append` (it awaits a signing-key
// unseal), and a better-sqlite3 transaction cannot span an `await`. So the three
// table writes are handed DOWN as `transactionalPrelude`, which the append runs
// inside the same transaction as the event-row INSERT, immediately before it —
// preserving the body order verbatim. The append dispatches that transaction
// IMMEDIATE, so the `BEGIN IMMEDIATE` writer-intent property this writer relied
// on is retained; and because the prelude is write-only (the SELECTs now happen
// before it), the transaction is no longer read-first at all, which removes the
// `SQLITE_BUSY_SNAPSHOT` read-then-upgrade hazard rather than merely mitigating
// it. (The `RuntimeBindingStore.#updateTxn` field comment carries the full
// rationale for why a read-first transaction needed IMMEDIATE.)
//
// Validation + normalization + canonical SORT, then read-decide, then the write
// --------------------------------------------------------------------------
// A rejected/invalid input must NEVER open a transaction (the RuntimeBindingStore
// discipline: this is what makes "a rejected declare leaves the tables
// untouched" hold WITHOUT relying on rollback). So at the write seam, BEFORE
// anything else, `declare`:
//   1. validates `contractVersion` via `assertValidContractVersion`,
//   2. validates the `flags` key-set cardinality via `assertValidCapabilityFlags`
//      (exactly the 7 canonical flags — no extra, no missing key),
//   3. normalizes each tool via `ProviderToolMetadataSchema.safeParse` (which
//      fills `idempotency_class` default `"manual_reconcile_only"` and strips
//      unknown keys — I-005-3 — and raises the leak-safe typed error, not a raw
//      ZodError, on a malformed tool),
//   4. SORTS the normalized tools by `name` ascending (canonical order).
//
// Read-decide, re-check, retry (optimistic concurrency)
// --------------------------------------------------------------------------
// CHANGE-DETECTION (declared vs updated vs noop) runs on a DEFERRED
// read-transaction snapshot, under `withSessionAppendLock`, before the write is
// handed down. A noop returns there having opened no write transaction at all;
// a REJECTED input never even reaches the read.
//
// The equality check used to run INSIDE the write transaction, on the same
// snapshot that picked the declare/update branch. It CANNOT stay there, and the
// reason is structural rather than a matter of effort — the event PAYLOAD
// depends on it (`declared` and `updated` are different events carrying
// different payloads), signing depends on the payload, and signing is async. No
// ordering exists in which that read sits inside the transaction that ends with
// the INSERT.
//
// Moving the read out opens a real window, and NOT only across connections: the
// append lock is keyed on `sessionId` while this hazard is keyed on
// `driverName`, so two `declare()` calls for the SAME driver under DIFFERENT
// sessions hold DIFFERENT locks and are ordered against each other by nothing —
// on ONE connection exactly as much as on two. Both read prior state, both park
// on the signing-key unseal, both commit: two `capability_declared` events for
// one driver, or an `updated` whose `previousState` was stale before it landed.
//
// That window is CLOSED, by an in-prelude re-check plus a bounded retry rather
// than by the lock. The `transactionalPrelude` re-reads the snapshot as its
// FIRST statement — inside the append's `BEGIN IMMEDIATE`, where a racer that
// committed earlier is visible and a racer that BEGINs later blocks — and
// throws a module-private divergence sentinel if it no longer matches the
// snapshot the decision was made on. That throw aborts the whole transaction:
// three table writes undone, event INSERT never reached, no sequence consumed.
// `declare` catches ONLY that sentinel, up to `DRIVER_DECLARE_MAX_ATTEMPTS` times,
// re-reading a fresh snapshot each attempt; anything else propagates on its
// first occurrence, and exhausting the attempts rethrows the sentinel loudly
// rather than writing on a stale decision.
//
// The COST is honest to state, and the re-check is the cheap half of it: one
// extra three-SELECT read per changed declare, paid inside the write
// transaction. The RETRY is the dominant term — a diverged attempt discards
// everything after the read and redoes it, including the signing-key `read()`
// (a fresh unseal, which can block on a human: `Spec-022 §Daemon Master Key`
// wipes the in-memory master on an idle timer, so the first unseal after a wipe
// may await a WebAuthn ceremony or a passphrase prompt — see
// `signing-key-source.ts`'s `DaemonSigningKeySealer` doc) and the row
// signature. That is bounded at `DRIVER_DECLARE_MAX_ATTEMPTS`, and it is only
// ever paid under genuine contention. Identical re-declares (the common case)
// return at the noop branch and reach neither the re-check nor the retry.
//
// Tools canonical-ordering rationale (load-bearing)
// --------------------------------------------------------------------------
// Change-detection compares the prior + new flat snapshots with
// `node:util.isDeepStrictEqual`, which is key-order-INSENSITIVE for object keys
// but order-SENSITIVE for arrays. The `tools` field is an array, so the SAME
// tool set declared in a DIFFERENT order would read as "changed" and emit a
// SPURIOUS `runtime_node.capability_updated`. Sorting the normalized tools by
// `name` on BOTH the write side (here) and the read side (`#snapshot`'s
// `ORDER BY tool_name`) is what makes the array comparison correct, so a
// reorder-only re-declare is the idempotent no-op it should be.
//
// WIRING CONTRACT (T2.5 / daemon bootstrap)
// --------------------------------------------------------------------------
// The injected `RuntimeNodeEventEmitter`'s `SessionEventLog` — Plan-006 T3.1's
// `EventLogService` — MUST be constructed over the SAME `better-sqlite3`
// connection (`db`) as this writer. The direction of the obligation is now
// REVERSED (this writer's statements join the append's transaction, rather than
// the append's INSERT joining this writer's), but the requirement is identical
// and for the identical reason: better-sqlite3 transactions are
// connection-level, so statements prepared on a DIFFERENT connection do not
// participate. Wiring the two over separate connections would leave the three
// cache writes committing independently of the event row's rollback — the
// non-atomic dual-write this whole section exists to prevent. The daemon root
// composition is responsible for honoring it.
//
// Spec coverage: `Spec-005 §Required Behavior` (runtime treats undeclared capabilities as
// unsupported — the cache the gate reads), `Spec-005 §Default Behavior` (driver capability
// declarations are required at attach time and may be refreshed when provider
// state changes — the `declare` seam and its refresh path), `Spec-005 §Recovery Consequences`
// (cache-as-source-of-truth; cold-start hydration reconstructs the snapshot
// without round-tripping the driver). Refs: Plan-005 §Phase 2 / T2.4, CP-005-5
// (the `runtime_node.capability_*` emission), invariant I-005-2.

import { isDeepStrictEqual } from "node:util";

import {
  DRIVER_CAPABILITY_FLAGS,
  ProviderToolMetadataSchema,
  SessionIdSchema,
  type CapabilityDetails,
  type DriverCapabilityFlag,
  type GetCapabilitiesResult,
  type NormalizedProviderToolMetadata,
  type SessionId,
} from "@ai-sidekicks/contracts";
import type { Database, Statement, Transaction } from "better-sqlite3";

import { withSessionAppendLock } from "../events/session-append-lock.js";
import type { RuntimeNodeEventEmitter } from "../node/node-event-emitter.js";
import {
  assertValidCapabilityFlags,
  assertValidContractVersion,
  assertValidGetCapabilitiesResultShape,
  ProviderOutputValidationError,
} from "./provider-output-validation.js";

// --------------------------------------------------------------------------
// Public + private types (LOCAL to runtime-daemon — NOT hoisted to
// `@ai-sidekicks/contracts`: a single-package, daemon-internal consumer fails
// the 2-surface hoist test, the same call made by RuntimeBindingStore). The
// one exception is `CapabilityDetails` itself: Plan-006 T1.4 hoisted it to
// contracts as the canonical event-payload shape, so this file imports it
// rather than keeping a structural twin.
// --------------------------------------------------------------------------

/**
 * The driver-name-suffixed capability identifier emitted on every
 * `runtime_node.capability_*` event — `"provider-driver-<driverName>"`
 * (e.g. `provider-driver-claude`). Per CP-005-5 (`Plan-005 §CP-005-5 — Driver capability event surface owed to [Plan-006](./006-session-event-taxonomy-and-audit-log.md) / [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md)`), the
 * suffix disambiguates multiple drivers on one runtime node IN-PLAN.
 */
/**
 * Module-private abort signal for the in-prelude decision re-check.
 *
 * Thrown from inside the `transactionalPrelude`, which runs inside the append's
 * `IMMEDIATE` transaction — so throwing it rolls that transaction back whole:
 * the three table writes are undone, the event-row INSERT never runs, and no
 * sequence is consumed (the append re-derives the sequence from the durable
 * chain head on each attempt, so a retry allocates correctly rather than
 * reusing a burned number).
 *
 * NOT exported and NOT a `DaemonDomainError`: it never escapes this module in
 * the normal case (the retry loop catches exactly it), and it names an internal
 * concurrency event rather than anything a caller did wrong. If it DOES escape,
 * it escapes as a loud unrecognized error, which is the intended outcome — see
 * the retry-exhaustion clause in `declare`.
 */
class DriverCapabilitySnapshotDivergedError extends Error {
  constructor(driverName: string) {
    super(
      `DriverCapabilitiesWriter.declare: the driver_capabilities snapshot for ` +
        `${driverName} changed between the read-decide step and the write ` +
        `transaction; aborting to avoid emitting an event whose payload no longer ` +
        `describes the committed state.`,
    );
    this.name = "DriverCapabilitySnapshotDivergedError";
  }
}

/**
 * Structural equality for two possibly-absent capability snapshots — the ONE
 * comparison both change-detection and the in-prelude re-check use, so the two
 * can never disagree about what "unchanged" means.
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
    // Absent-vs-present is the sharpest divergence there is: it flips the
    // declared/updated branch itself.
    return left === right;
  }
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(left)) as unknown,
    JSON.parse(JSON.stringify(right)) as unknown,
  );
}

/** Bounded attempts for the read-decide-emit optimistic-concurrency loop. */
const DRIVER_DECLARE_MAX_ATTEMPTS: number = 3;

function providerDriverCapabilityKey(driverName: string): string {
  return `provider-driver-${driverName}`;
}

// The flat capability snapshot is the canonical `CapabilityDetails` imported
// from `@ai-sidekicks/contracts`
// (`docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy`). It is the form carried by
// the `runtime_node.capability_*` event payloads AND the form used for
// change-detection; `hydrate()` wraps it into the nested
// `GetCapabilitiesResult`. In THIS writer, `tools` is ALWAYS in canonical
// (`name`-ascending) order — see the file header.

/**
 * `declare` input. `sessionId` / `nodeId` are threaded to the EMIT only (never
 * stored in the driver-keyed tables — those carry no session column).
 * `driverName` is the cache key for all three tables. `result` is the driver's
 * advertised `GetCapabilitiesResult` (`{ capabilities: { flags, contractVersion },
 * tools }`). `actor` defaults to `null` (system actor) at the emit when omitted.
 */
export interface DeclareDriverCapabilitiesInput {
  // Threaded to the emit only — the event's per-session partition/sequence key.
  readonly sessionId: string;
  // The runtime node the capability event describes (emit only).
  readonly nodeId: string;
  // The cache key for driver_capabilities / driver_tools / driver_contract_meta.
  readonly driverName: string;
  // The driver's advertised capability snapshot (nested wrapper).
  readonly result: GetCapabilitiesResult;
  // EventEnvelope free-form actor; defaults to `null` (system actor).
  readonly actor?: string | null;
}

/**
 * `declare` return — a small discriminant callers (and T2.5) assert on:
 *   * `"declared"` — first write for this driver; emitted `capability_declared`.
 *   * `"updated"`  — the snapshot CHANGED; emitted `capability_updated`.
 *   * `"noop"`     — identical re-declare; NO write, NO event (idempotent).
 */
export interface DeclareDriverCapabilitiesResult {
  readonly emitted: "declared" | "updated" | "noop";
}

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
}

// --------------------------------------------------------------------------
// DriverCapabilitiesWriter
// --------------------------------------------------------------------------

export class DriverCapabilitiesWriter {
  // Only prepared statements + the prepared read-transaction wrapper + the
  // emitter are retained (mirrors RuntimeBindingStore / NodeCapabilityService —
  // the raw `db` handle is NOT stored; a prepared statement keeps its parent
  // connection alive). This class no longer owns a WRITE transaction at all:
  // since the T3.1 re-point its table writes travel as a `transactionalPrelude`
  // inside `EventLogService.append`'s transaction, and it is THAT transaction
  // which is dispatched IMMEDIATE (read-first write — see the file header for
  // the WAL `SQLITE_BUSY_SNAPSHOT` rationale).
  readonly #selectCapabilityFlagsStmt: Statement;
  readonly #selectToolsStmt: Statement;
  readonly #selectContractMetaStmt: Statement;
  readonly #upsertCapabilityFlagStmt: Statement;
  readonly #deleteToolsStmt: Statement;
  readonly #insertToolStmt: Statement;
  readonly #upsertContractMetaStmt: Statement;
  // DEFERRED read-transaction wrapper for the snapshot read. `#snapshot`
  // runs THREE separate SELECTs; outside a transaction (autocommit) each takes its
  // own read snapshot, so under the multi-connection model this writer designs for
  // (see file header), a concurrent refresh committing BETWEEN the SELECTs yields a
  // TORN read (e.g. `contractVersion` from the old row + flags/tools from the new).
  // Dispatched DEFERRED (`.deferred(...)`) so all three SELECTs share ONE
  // consistent read snapshot. (DEFERRED, not IMMEDIATE: this is a pure read that
  // never upgrades to a write, so it must NOT take a writer-intent lock.) BOTH
  // paths use it now — `hydrate` and `declare`'s change-detection alike — since
  // the write transaction no longer contains a read for `declare` to piggyback
  // on (see the file header).
  readonly #readTxn: Transaction<(driverName: string) => CapabilityDetails | undefined>;
  // The emission seam. REQUIRED (not optional): capability declarations always
  // occur at attach time with a live session/node (`Spec-005 §Default Behavior`). The
  // `writeDriverTables` prelude closure is built around it on each declare attempt.
  readonly #emitter: RuntimeNodeEventEmitter;
  // Injected wall-clock for `refreshed_at` (deterministic tests).
  readonly #now: () => string;

  constructor(
    db: Database,
    emitter: RuntimeNodeEventEmitter,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#emitter = emitter;
    this.#now = now;

    // --- Readers (the `#snapshot` reconstruction + change-detection source) ---
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
    // gate — no row ⇒ driver never written ⇒ `#snapshot` returns `undefined`.
    this.#selectContractMetaStmt = db.prepare(
      `SELECT contract_version
         FROM driver_contract_meta
        WHERE driver_name = ?`,
    );

    // --- Writers ---
    // driver_capabilities UPSERT. The 7-flag enum is FIXED, so we upsert exactly
    // 7 rows every write and a plain ON CONFLICT … DO UPDATE leaves no orphan
    // class (no flag can ever be "dropped" the way a tool can).
    this.#upsertCapabilityFlagStmt = db.prepare(
      `INSERT INTO driver_capabilities (driver_name, capability_flag, supported, refreshed_at)
       VALUES (@driver_name, @capability_flag, @supported, @refreshed_at)
       ON CONFLICT(driver_name, capability_flag)
         DO UPDATE SET supported    = excluded.supported,
                       refreshed_at = excluded.refreshed_at`,
    );
    // driver_tools is DELETE-then-reinsert (NOT upsert): a refresh that REMOVES a
    // tool must not leave an orphan row, and a plain upsert would never delete a
    // dropped tool. The DELETE + the re-INSERTs run inside the txn, so the
    // replacement is atomic.
    this.#deleteToolsStmt = db.prepare(`DELETE FROM driver_tools WHERE driver_name = ?`);
    this.#insertToolStmt = db.prepare(
      `INSERT INTO driver_tools (driver_name, tool_name, idempotency_class, description, refreshed_at)
       VALUES (@driver_name, @tool_name, @idempotency_class, @description, @refreshed_at)`,
    );
    // driver_contract_meta UPSERT — the single PK row.
    this.#upsertContractMetaStmt = db.prepare(
      `INSERT INTO driver_contract_meta (driver_name, contract_version, refreshed_at)
       VALUES (@driver_name, @contract_version, @refreshed_at)
       ON CONFLICT(driver_name)
         DO UPDATE SET contract_version = excluded.contract_version,
                       refreshed_at     = excluded.refreshed_at`,
    );

    // Prepare the DEFERRED read transaction once. BOTH `hydrate` and `declare`'s
    // change-detection route their three-SELECT `#snapshot` read through here so
    // the SELECTs share ONE consistent read snapshot — closing the torn-read
    // hazard a concurrent refresh would otherwise open between the autocommit
    // SELECTs (see the `#readTxn` field comment).
    this.#readTxn = db.transaction((driverName: string): CapabilityDetails | undefined =>
      this.#snapshot(driverName),
    );
  }

  /**
   * Declare (or refresh) a driver's advertised capabilities. Validates +
   * normalizes + canonically sorts, then — under the session's append lock —
   * change-detects on a consistent DEFERRED read snapshot and, on a mutating
   * path, atomically writes the three driver-keyed tables AND the matching
   * `runtime_node.capability_*` event row. An identical re-declare is an
   * idempotent no-op (no write, no event).
   *
   * ASYNC because the durable append path is (its per-session mutex and its
   * signing-key unseal). The three table writes travel as
   * `transactionalPrelude` — see the file header for why that is where the
   * atomicity now lives, and for what the move narrows.
   *
   * Validation/normalization/sort run FIRST, so a REJECTED input (invalid
   * `contractVersion`, bad `flags` key-set, malformed tool) never opens a
   * transaction, never takes the lock, and leaves the tables untouched WITHOUT
   * relying on rollback. The noop path opens no write transaction either — it
   * returns from the read snapshot.
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
    // full re-parse of the result (value-normalization stays the Phase-3 driver
    // adapter's job per provider-output-validation.ts's boundary comment).
    assertValidGetCapabilitiesResultShape(input.result);

    // (1) Validate the provider-declared contract_version at the write seam
    // (defense-in-depth on top of the SQL CHECK — reuses the same assert as
    // RuntimeBindingStore). THROWS `ProviderOutputValidationError` on failure,
    // before any txn opens.
    assertValidContractVersion(input.result.capabilities.contractVersion);

    // (2) Validate the `flags` key-set cardinality at the write seam — EXACTLY
    // the 7 canonical flags, no extra and no missing key (this writer explodes
    // `flags` into one CHECK-constrained `driver_capabilities` row per flag, so
    // an extra/typo'd key would otherwise hit the SQL CHECK mid-transaction and
    // an omitted key would persist a partial <7-row cache). THROWS the leak-safe
    // `ProviderOutputValidationError`, before any txn opens.
    assertValidCapabilityFlags(input.result.capabilities.flags);

    // (3) Normalize each ingress tool via the contract schema — fills the
    // `idempotency_class` default `"manual_reconcile_only"` (I-005-3) and strips
    // unknown keys (`Spec-005 §Default Behavior` forward-compat). `safeParse` (NOT `.parse()`) so a
    // malformed tool surfaces the leak-safe `ProviderOutputValidationError` —
    // error-type-symmetric with the contract_version path, never a raw `ZodError`
    // (the leak-safe doctrine of `provider-output-validation.ts`). Still before
    // any txn opens.
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
    // the WRITE-side order MATCHES the READ-side order: the `#snapshot` reader
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
    // `capability_updated` on an identical re-declare AND mismatch the hydrate
    // order. `localeCompare` would diverge even on common mixed-case names. The
    // guarantee here comes from matching encodings (UTF-8 bytes === SQLite BINARY
    // on a no-COLLATE TEXT column), not from any property of JS `<`.
    normalizedTools.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")),
    );

    // (4b) REJECT duplicate NORMALIZED tool names BEFORE the txn opens. Two tools
    // sharing a normalized `name` would have the second `#insertToolStmt.run`
    // violate the `(driver_name, tool_name)` PRIMARY KEY INSIDE the
    // `writeDriverTables` prelude — i.e. inside the append's transaction —
    // throwing a raw `SQLITE_CONSTRAINT` from an already-opened transaction. That
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
    // provider's raw `flags` object by reference. Three consumers read this
    // snapshot's flags: the change-detection JSON round-trip (`snapshotsEqual`),
    // the `driver_capabilities` write loop (raw `flags[flag]` reads), and the
    // emitted event payload (serialized downstream). A raw provider object can carry
    // a custom/inherited `toJSON` that passes `assertValidCapabilityFlags` (own
    // enumerable keys + boolean values only, NOT the prototype) yet taints the two
    // JSON-serializing consumers while the raw write loop sees the true booleans —
    // diverging the persisted rows from the change-detect snapshot and the event
    // payload, and firing a spurious `capability_updated` on an identical re-declare.
    // A fresh own-key boolean record severs toJSON / getters / prototype hooks so all
    // three consumers read identical plain primitives. Consistent with the defensive
    // snapshot-clone doctrine already applied elsewhere in this writer.
    const flags = {} as Record<DriverCapabilityFlag, boolean>;
    for (const capabilityFlag of DRIVER_CAPABILITY_FLAGS) {
      flags[capabilityFlag] = input.result.capabilities.flags[capabilityFlag] === true;
    }
    const newSnapshot: CapabilityDetails = {
      flags,
      contractVersion: input.result.capabilities.contractVersion,
      tools: normalizedTools,
    };

    // (6) Read-decide under the append lock, re-check inside the write
    // transaction, retry on divergence.
    //
    // Branded once here and reused for BOTH the lock key and the emit, so the
    // lock partition and the event's partition cannot drift apart. The parse
    // runs AFTER the input validation above, preserving "a rejected input never
    // opens a transaction".
    const sessionId: SessionId = SessionIdSchema.parse(input.sessionId);

    for (let attempt: number = 1; ; attempt += 1) {
      try {
        return { emitted: await this.#declareOnce(input, sessionId, newSnapshot) };
      } catch (error: unknown) {
        // ONLY the divergence sentinel is retryable. Every other failure — a
        // constraint violation, a signing-key refusal, a halted session —
        // propagates unchanged on its first occurrence; retrying those would
        // turn one honest failure into three.
        if (!(error instanceof DriverCapabilitySnapshotDivergedError)) {
          throw error;
        }
        if (attempt >= DRIVER_DECLARE_MAX_ATTEMPTS) {
          // Exhaustion is LOUD, never a silent fall-through to a write on a
          // stale decision. Three consecutive divergences on one driver is not
          // ordinary contention; it is a signal the caller has to see.
          throw error;
        }
      }
    }
  }

  /**
   * ONE attempt of the read-decide-emit sequence, under the session's append
   * lock. Returns the emitted-event classification, or throws
   * {@link DriverCapabilitySnapshotDivergedError} when the durable snapshot
   * moved between the decision and the write.
   *
   * Factored out of `declare` so each retry re-reads a genuinely FRESH
   * snapshot: a loop wrapped around the lock body alone would keep closing over
   * the first attempt's `priorSnapshot` and diverge forever.
   */
  async #declareOnce(
    input: DeclareDriverCapabilitiesInput,
    sessionId: SessionId,
    newSnapshot: CapabilityDetails,
  ): Promise<"declared" | "updated" | "noop"> {
    return withSessionAppendLock(sessionId, async () => {
      // ONE consistent DEFERRED read snapshot feeds BOTH the change-detect
      // (noop) and the declare-vs-update branch pick, so those two decisions
      // can never disagree with each other about what the prior state was.
      const priorSnapshot: CapabilityDetails | undefined = this.#readTxn.deferred(input.driverName);

      // (6a) CHANGE-DETECTION. An identical re-declare is an idempotent no-op
      // — no write, no event.
      if (snapshotsEqual(priorSnapshot, newSnapshot)) {
        return "noop";
      }

      // (6b) The durable half of the dual-write. Runs inside the append's
      // transaction immediately BEFORE the event-row INSERT, so a throwing
      // INSERT rolls all three table writes back. `this.#now()` is read HERE,
      // in the transaction, exactly where it was read when this writer owned
      // the transaction.
      const writeDriverTables = (): void => {
        // (6b-i) THE RE-CHECK — the reason this prelude runs INSIDE the
        // append's transaction rather than beside it.
        //
        // `priorSnapshot` was read outside any write transaction, and this
        // attempt then parked on an `await` (the signing-key unseal) before
        // reaching here. Two `declare()` calls for the same driverName under
        // DIFFERENT sessionIds hold DIFFERENT per-session locks, so the append
        // lock orders neither against the other — on ONE connection as much as
        // on two. Both read prior state, both park, both commit: two
        // `capability_declared` events for one driver, or an `updated` whose
        // `previousState` was already stale at commit time.
        //
        // Re-reading HERE, inside `BEGIN IMMEDIATE`, closes the window in BOTH
        // directions: a racer that committed before our BEGIN is visible to
        // this read, and a racer that BEGINs after ours blocks until we COMMIT
        // or ROLL BACK. Divergence aborts the transaction whole — three table
        // writes undone, event INSERT never reached, no sequence consumed — and
        // `declare`'s loop re-reads and re-decides.
        //
        // `#snapshot` is called DIRECTLY, not through `#readTxn`: better-sqlite3
        // throws on a nested transaction and we are already inside the append's.
        // That enclosing transaction supplies exactly the read consistency
        // `#readTxn.deferred` provides elsewhere.
        if (!snapshotsEqual(this.#snapshot(input.driverName), priorSnapshot)) {
          throw new DriverCapabilitySnapshotDivergedError(input.driverName);
        }

        const refreshedAt: string = this.#now();

        // WRITE driver_capabilities — upsert exactly 7 rows. Each key of the
        // `flags` Record is a `DriverCapabilityFlag`; `supported = 1` iff `true`.
        for (const capabilityFlag of Object.keys(newSnapshot.flags) as DriverCapabilityFlag[]) {
          this.#upsertCapabilityFlagStmt.run({
            driver_name: input.driverName,
            capability_flag: capabilityFlag,
            supported: newSnapshot.flags[capabilityFlag] ? 1 : 0,
            refreshed_at: refreshedAt,
          });
        }

        // WRITE driver_tools — DELETE-then-reinsert (drops removed tools).
        this.#deleteToolsStmt.run(input.driverName);
        for (const tool of newSnapshot.tools) {
          this.#insertToolStmt.run({
            driver_name: input.driverName,
            tool_name: tool.name,
            idempotency_class: tool.idempotency_class,
            description: tool.description ?? null,
            refreshed_at: refreshedAt,
          });
        }

        // WRITE driver_contract_meta — the single PK row.
        this.#upsertContractMetaStmt.run({
          driver_name: input.driverName,
          contract_version: newSnapshot.contractVersion,
          refreshed_at: refreshedAt,
        });
      };

      // (6c) EMIT — the FLAT snapshot is the event payload (so the T1.4-landed
      // canonical `CapabilityDetails` binding validates). The emitter input
      // seam carries the payload type's canonical-first union, so the typed
      // snapshot passes uncast.
      if (priorSnapshot === undefined) {
        await this.#emitter.emitCapabilityDeclared({
          sessionId,
          nodeId: input.nodeId,
          actor: input.actor ?? null,
          capability: providerDriverCapabilityKey(input.driverName),
          capabilityDetails: newSnapshot,
          transactionalPrelude: writeDriverTables,
        });
        return "declared";
      }
      await this.#emitter.emitCapabilityUpdated({
        sessionId,
        nodeId: input.nodeId,
        actor: input.actor ?? null,
        capability: providerDriverCapabilityKey(input.driverName),
        previousState: priorSnapshot,
        newState: newSnapshot,
        transactionalPrelude: writeDriverTables,
      });
      return "updated";
    });
  }

  /**
   * Cold-start hydration: reconstruct a driver's advertised
   * `GetCapabilitiesResult` from the durable cache WITHOUT round-tripping the
   * driver (`Spec-005 §Recovery Consequences`). Pure READ (no write, no emit); the three SELECTs
   * run inside ONE `BEGIN DEFERRED` read transaction so they share a consistent
   * snapshot — see the `#readTxn` field comment. Returns `undefined` when the
   * driver has never been written.
   *
   * Returns the NESTED `GetCapabilitiesResult` (`{ capabilities: { flags,
   * contractVersion }, tools }`) — the shape `ProviderRegistry.register`
   * consumes — NOT the flat `CapabilityDetails` the events carry (see file
   * header for the flat-vs-nested distinction). `tools` is in canonical order.
   */
  hydrate(driverName: string): GetCapabilitiesResult | undefined {
    // Route the three-SELECT `#snapshot` read through a DEFERRED read transaction
    // so the SELECTs share ONE consistent snapshot — a concurrent refresh
    // committing between them cannot yield a torn read (`.deferred(...)`; see the
    // `#readTxn` field comment). The write path reaches `#snapshot` twice and
    // needs this wrapper for NEITHER call, for two different reasons: the
    // decision-time read in `#declareOnce` routes through this same `#readTxn`
    // already, and the in-prelude re-check calls `#snapshot` DIRECTLY because it
    // runs inside the append's own transaction — which supplies the consistency
    // and would reject a nested one. So only `hydrate` has to open its own.
    const snapshot: CapabilityDetails | undefined = this.#readTxn.deferred(driverName);
    if (snapshot === undefined) {
      return undefined;
    }
    return {
      capabilities: {
        flags: snapshot.flags,
        contractVersion: snapshot.contractVersion,
      },
      // Copied: contracts' `CapabilityDetails.tools` is readonly; the nested
      // `GetCapabilitiesResult.tools` ingress field is mutable.
      tools: [...snapshot.tools],
    };
  }

  // ------------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------------

  /**
   * Reconstruct the FLAT `CapabilityDetails` snapshot for a driver from the
   * three tables — the SINGLE source for both change-detection and event
   * contents. Returns `undefined` when the driver has never been written.
   *
   * The existence gate is the `driver_contract_meta` row: its ABSENCE means the
   * driver was never written (the parent row is always upserted on a write), so
   * we return `undefined` BEFORE reading the child tables. `tools` come back in
   * canonical (`name`-ascending) order via the `ORDER BY tool_name` reader, so
   * the read side matches the write side's sort.
   */
  #snapshot(driverName: string): CapabilityDetails | undefined {
    const contractMeta: DriverContractMetaRow | undefined = this.#selectContractMetaStmt.get(
      driverName,
    ) as DriverContractMetaRow | undefined;
    if (contractMeta === undefined) {
      // No parent row ⇒ driver never written ⇒ no snapshot.
      return undefined;
    }

    // Reconstruct the flag matrix. `supported === 1` → `true`. The Record is
    // keyed by `capability_flag`; the column's CHECK constraint guarantees each
    // value is one of the 7 `DriverCapabilityFlag` literals, so the cast is sound.
    const flagRows: DriverCapabilityRow[] = this.#selectCapabilityFlagsStmt.all(
      driverName,
    ) as DriverCapabilityRow[];
    // Belt-and-suspenders corrupt-cache guard: a written driver (parent row
    // present) MUST have exactly the canonical flag-row cardinality. The
    // `assertValidCapabilityFlags` write-seam guard + the atomic dual-write make a
    // partial row-set unreachable through this writer, so a mismatch here means
    // out-of-band corruption (a manual DELETE, a future migration bug); fail LOUD
    // rather than reconstruct a silently-incomplete flag matrix. Reached only
    // AFTER the `contractMeta === undefined` early-return, so a never-written
    // driver never trips it. A plain internal-invariant `Error` (NOT
    // `ProviderOutputValidationError` — this is a corrupt cache, not provider input).
    if (flagRows.length !== DRIVER_CAPABILITY_FLAGS.length) {
      throw new Error(
        `driver_capabilities cardinality invariant violated for "${driverName}": ` +
          `expected ${DRIVER_CAPABILITY_FLAGS.length.toString()} flag rows, found ${flagRows.length.toString()}.`,
      );
    }
    const flags: Record<DriverCapabilityFlag, boolean> = {} as Record<
      DriverCapabilityFlag,
      boolean
    >;
    for (const row of flagRows) {
      flags[row.capability_flag as DriverCapabilityFlag] = row.supported === 1;
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
