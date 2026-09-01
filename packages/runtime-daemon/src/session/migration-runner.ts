// Schema migration runner for Local Runtime Daemon SQLite databases.
//
// The runner is intentionally minimal: check `schema_version`, exec the SQL
// if absent. Each migration version N is registered as its own explicit
// `if (!hasMigrationApplied(db, N))` guarded block inside `applyMigrations`,
// mirroring the version-1 `db.transaction(...).immediate()` + in-transaction
// double-check primitive verbatim (race-safe by construction — see the
// `applyMigrations` docstring). This is deliberately NOT a generic
// migration-list/registry loop: the `.immediate()` concurrency seam is
// pinned by the worker_threads concurrent-boot race test, and re-expressing
// it through a registry would re-open that control flow for re-validation.
// Version 1 is owned by Plan-001 (`migrations/0001-initial.ts`); version 2
// by Plan-003 (`migrations/0002-runtime-node.ts`); version 3 by Plan-005
// (`migrations/0003-runtime-bindings.ts`); version 4 by Plan-010
// (`migrations/0004-worktree-lifecycle.ts`); versions 5 through 9 by Plan-006
// (`migrations/0005-daemon-signing-keys.ts`,
// `migrations/0006-run-lifecycle-terminal-backstop-index.ts`,
// `migrations/0007-pii-participant-id.ts`,
// `migrations/0008-pending-anchor-uploads.ts`,
// `migrations/0009-retention-class-and-stub-signature.ts`); version 10 by
// Plan-009 (`migrations/0010-repo-workspaces.ts`); versions 11 and 12 by
// Plan-005 (`migrations/0011-driver-capability-currency.ts`,
// `migrations/0012-transcript-capability-backfill.ts`); version 13 by
// Plan-006 (`migrations/0013-content-payload.ts`); version 14 by Plan-005
// (`migrations/0014-console-parity-capability-flags.ts`); version 15 by
// Plan-004 (`migrations/0015-queue-and-interventions.ts`); version 16 by
// Plan-029 (`migrations/0016-provider-accounts.ts`). The runner needs no
// contiguity — every version is an independently guarded block keyed on its own
// `schema_version` row, and `hasMigrationApplied` asks about one version rather
// than about a maximum — so the two were safely authored in parallel rather
// than in sequence. Subsequent plans — and Plan-006's own remaining
// migrations — register their version as a further guarded block of the same
// shape and bump `schema_version`.
//
// Version ORDER is load-bearing between 6 and 7 only in the trivial sense that
// both touch `session_events`; they are independent otherwise (6 adds an index
// + triggers over existing columns, 7 adds a column neither references). They
// are separate versions rather than one because they enforce unrelated
// invariants with unrelated rollback stories — a failure in the trigger DDL
// must not strand the owner-stamp column, and vice versa. Version 8 is
// order-independent of all of them: it CREATEs a standalone table
// (`pending_anchor_uploads`) with no FK into `session_events` — deliberately,
// since a crypto-shred that deletes event rows must never cascade into the
// anchors that witness those rows ever existed. Version 9 must follow 6 and 7
// in the trivial `session_events`-touching sense and nothing stronger, but its
// own three statements ARE internally ordered: the partial index it creates has
// a `WHERE retention_class IS NULL` predicate over the column the same script
// adds two statements earlier. Version 10 is order-independent of 2 through 9:
// it CREATEs two tables whose only inbound references FROM OTHER MIGRATIONS are
// version 4's forward `REFERENCES` clauses (the pair's own `workspaces` →
// `repo_mounts` FK is internal to this script), and SQLite resolves FK targets
// at DML time rather than at CREATE time — so the pair applies in either order.
// What version 10 changes is the failure class of an INSERT into those
// version-4 columns: `SQLITE_ERROR: no such table` before it, an ordinary
// `FOREIGN KEY constraint failed` after.
//
// Version 11 requires version 3 and nothing else: all three tables it touches
// (`driver_capabilities`, `runtime_bindings`, `driver_contract_meta`) are
// version-3 tables, and versions 2 and 4 through 10 touch none of them. It is
// the first version to DROP and RENAME a table, and the first to BACKFILL rows
// — both forced by SQLite's refusal to alter a column CHECK in place, which
// makes widening the `capability_flag` enum a documented twelve-step table
// rebuild. See the 0011 file header for which legs of that procedure are
// omitted and why each omission is safe (the `PRAGMA foreign_keys` legs are
// both impossible inside this runner's transaction and unnecessary for a table
// that participates in no foreign key in either direction).
//
// Version 12 requires version 11 and nothing else. It inserts the fourteenth
// `driver_capabilities` row per cached driver — the value version 11's CHECK
// already admits and deliberately gave no row — and touches nothing else. It is
// the one version so far whose statement is idempotent on its own (`ON CONFLICT
// ... DO NOTHING`), so the `schema_version` guard here prevents a redundant
// apply rather than a destructive one. Ordering against 11 is not merely
// conventional: run first, the insert would be rejected by the superseded
// seven-value CHECK version 11 replaces.
//
// SQL is sourced as a TypeScript string constant (not a sibling .sql file)
// because `tsc -b` does not copy non-TS assets into `dist/` and `package.json`
// `"files": ["dist"]` would exclude `src/migrations/` from publish; see the
// header of `migrations/0001-initial.ts` for the full rationale.
//
// This module also owns:
//   * the canonical pragma list applied at every handle open per
//     `docs/architecture/schemas/local-sqlite-schema.md` §Pragmas
//     (`applyPragmas`),
//   * the canonical handle factory (`openDatabase`) — opens the file,
//     applies pragmas, runs migrations in the right order. Use this in
//     production code paths AND in tests so the order can never drift.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { INITIAL_MIGRATION_SQL } from "../migrations/0001-initial.js";
import { RUNTIME_NODE_MIGRATION_SQL } from "../migrations/0002-runtime-node.js";
import { RUNTIME_BINDINGS_MIGRATION_SQL } from "../migrations/0003-runtime-bindings.js";
import { WORKTREE_LIFECYCLE_MIGRATION_SQL } from "../migrations/0004-worktree-lifecycle.js";
import { DAEMON_SIGNING_KEYS_MIGRATION_SQL } from "../migrations/0005-daemon-signing-keys.js";
import { RUN_LIFECYCLE_TERMINAL_BACKSTOP_MIGRATION_SQL } from "../migrations/0006-run-lifecycle-terminal-backstop-index.js";
import { PII_PARTICIPANT_ID_MIGRATION_SQL } from "../migrations/0007-pii-participant-id.js";
import { PENDING_ANCHOR_UPLOADS_MIGRATION_SQL } from "../migrations/0008-pending-anchor-uploads.js";
import { RETENTION_CLASS_AND_STUB_SIGNATURE_MIGRATION_SQL } from "../migrations/0009-retention-class-and-stub-signature.js";
import { REPO_WORKSPACES_MIGRATION_SQL } from "../migrations/0010-repo-workspaces.js";
import { DRIVER_CAPABILITY_CURRENCY_MIGRATION_SQL } from "../migrations/0011-driver-capability-currency.js";
import { TRANSCRIPT_CAPABILITY_BACKFILL_MIGRATION_SQL } from "../migrations/0012-transcript-capability-backfill.js";
import { CONTENT_PAYLOAD_MIGRATION_SQL } from "../migrations/0013-content-payload.js";
import { CONSOLE_PARITY_CAPABILITY_FLAGS_MIGRATION_SQL } from "../migrations/0014-console-parity-capability-flags.js";
import { QUEUE_AND_INTERVENTIONS_MIGRATION_SQL } from "../migrations/0015-queue-and-interventions.js";
import { PROVIDER_ACCOUNTS_MIGRATION_SQL } from "../migrations/0016-provider-accounts.js";

/**
 * Apply pragmas to an open Database handle. MUST be called on every
 * handle open (including reopens) — pragmas are connection-local.
 *
 * Per `docs/architecture/schemas/local-sqlite-schema.md` §Pragmas:
 *   - WAL journal mode: concurrent readers during writes.
 *   - synchronous=FULL: overrides better-sqlite3 default (NORMAL) for
 *     chain-of-custody durability per Spec-006 §Integrity Protocol.
 *   - foreign_keys=ON: enforce FK constraints at INSERT/UPDATE time.
 *   - busy_timeout=5000: tolerate concurrent writers up to 5 s before
 *     SQLITE_BUSY surfaces to the application.
 */
export function applyPragmas(db: DatabaseType): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

/**
 * Apply all pending migrations to an open Database handle.
 *
 * Idempotent: each migration is checked against `schema_version` before
 * exec, so calling this on an already-migrated database is a no-op.
 *
 * Concurrency: each migration is wrapped in `db.transaction(...)`
 * invoked via `.immediate()`, which begins the transaction with `BEGIN
 * IMMEDIATE` (taking the RESERVED writer-intent lock at BEGIN time
 * rather than at first write). Two daemons racing on the same file
 * resolve via SQLite's busy-handler at BEGIN: the loser blocks until
 * `busy_timeout=5000` ms elapses (set in `applyPragmas`); when the loser
 * acquires the lock the inner `hasMigrationApplied` re-check sees the
 * winner's committed `schema_version` row and short-circuits, so the
 * transaction commits as a no-op. Either way: exactly one
 * `INITIAL_MIGRATION_SQL.exec()` ever lands.
 *
 * Why NOT the default (`db.transaction(...)()`): better-sqlite3's
 * default transaction wrapper begins with `BEGIN`, which SQLite
 * dispatches as DEFERRED. Both racers start as readers; the inner
 * `hasMigrationApplied()` SELECT succeeds without a lock upgrade; the
 * subsequent `db.exec(SQL)` requires a write lock; in WAL mode, two
 * DEFERRED transactions both attempting to upgrade hit
 * `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` cannot resolve (the
 * busy-handler only retries while no transaction is held). The
 * `concurrent applyMigrations across worker_threads` test in
 * `__tests__/session-service.test.ts` reproduces the contention with
 * the default wrapper as a negative control and pins the fix on
 * `.immediate()`.
 */
export function applyMigrations(db: DatabaseType): void {
  // EVERY VERSION BLOCK BELOW HAS THE SAME SHAPE, argued once here rather than
  // once per version:
  //
  //   outer guard → db.transaction(...).immediate() → inner re-check → .exec()
  //
  //   * Each migration's SQL carries its OWN `INSERT INTO schema_version`, so
  //     one `.exec()` is the entire unit of work and the DDL commits atomically
  //     with its anchor row. A torn apply (process crash mid-migration) leaves
  //     the database at the previous version, never half-migrated.
  //   * `.immediate()` rather than better-sqlite3's `db.transaction(...)()`
  //     default — the doc comment above argues why, and names the
  //     `concurrent applyMigrations across worker_threads` negative control
  //     that pins it. Do not re-derive it here.
  //   * The INNER re-check closes the `hasMigrationApplied → exec` window: a
  //     racer that wins the BEGIN-IMMEDIATE race and commits first is observed
  //     here, so this transaction commits as a no-op instead of re-applying
  //     the DDL.
  //
  // Each block's own comment carries ONLY what is specific to that version.

  if (!hasMigrationApplied(db, 1)) {
    // Version 1 — the initial session/event schema.
    db.transaction(() => {
      if (!hasMigrationApplied(db, 1)) {
        db.exec(INITIAL_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 2)) {
    // Version 2 (Plan-003) — node_capabilities + node_trust_state.
    db.transaction(() => {
      if (!hasMigrationApplied(db, 2)) {
        db.exec(RUNTIME_NODE_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 3)) {
    // Version 3 (Plan-005) — runtime_bindings + driver_capabilities +
    // driver_tools + driver_contract_meta.
    db.transaction(() => {
      if (!hasMigrationApplied(db, 3)) {
        db.exec(RUNTIME_BINDINGS_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 4)) {
    // Version 4 (Plan-010) — worktrees + ephemeral_clones + branch_contexts +
    // run_execution_contexts. This migration's REFERENCES clauses target
    // Plan-009 Phase 2 tables that may not exist yet; SQLite resolves FK
    // targets lazily at DML time, so the CREATEs apply cleanly regardless
    // (B23 ordering; see the 0004 file header).
    db.transaction(() => {
      if (!hasMigrationApplied(db, 4)) {
        db.exec(WORKTREE_LIFECYCLE_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 5)) {
    // Version 5 (Plan-006) — daemon_signing_keys.
    db.transaction(() => {
      if (!hasMigrationApplied(db, 5)) {
        db.exec(DAEMON_SIGNING_KEYS_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 6)) {
    // Version 6 (Plan-006) — run_lifecycle terminal-key backstop: the partial
    // unique index plus the insert/update/promote trigger trio. Atomicity
    // matters more than usual here: a torn apply that landed the UNIQUE index
    // without its trigger trio would leave the NULL-distinctness hole the
    // triggers exist to close, silently admitting duplicate terminal rows (see
    // the 0006 file header).
    db.transaction(() => {
      if (!hasMigrationApplied(db, 6)) {
        db.exec(RUN_LIFECYCLE_TERMINAL_BACKSTOP_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 7)) {
    // Version 7 (Plan-006) — session_events.pii_participant_id, the durable
    // PII owner-stamp column. The guards are what make re-application a no-op:
    // SQLite has no `ADD COLUMN IF NOT EXISTS`, so a second exec would throw
    // "duplicate column name".
    db.transaction(() => {
      if (!hasMigrationApplied(db, 7)) {
        db.exec(PII_PARTICIPANT_ID_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 8)) {
    // Version 8 (Plan-006) — pending_anchor_uploads, the durable Merkle-anchor
    // upload queue. Atomicity is load-bearing here for the same reason it is at
    // version 6: a torn apply that landed the table without its partial index
    // would leave the upload worker's pending scan doing a full table scan of a
    // queue that grows without bound during a long partition.
    db.transaction(() => {
      if (!hasMigrationApplied(db, 8)) {
        db.exec(PENDING_ANCHOR_UPLOADS_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 9)) {
    // Version 9 (Plan-006) — session_events.retention_class +
    // session_events.stub_signature + the idx_session_events_live partial
    // index: the compaction retention discriminator and the post-compaction
    // stub commitment. Two version-specific facts: the ALTER TABLEs cannot be
    // re-applied (no `ADD COLUMN IF NOT EXISTS`, so a second exec throws
    // "duplicate column name"), and a torn apply that landed the columns
    // without the partial index would leave every live-row scan reading the
    // indefinitely-retained compacted suffix, silently — atomicity for the same
    // reason as versions 6 and 8.
    db.transaction(() => {
      if (!hasMigrationApplied(db, 9)) {
        db.exec(RETENTION_CLASS_AND_STUB_SIGNATURE_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 10)) {
    // Version 10 (Plan-009) — repo_mounts + workspaces, the durable attach
    // record and its execution binding. This is the version that supplies the
    // parent tables version 4's forward REFERENCES clauses target, so it is
    // also the version after which those columns fail as ordinary FK
    // violations rather than as `no such table`. Atomicity matters here for the
    // reason it does at versions 6, 8, and 9: a torn apply that landed
    // `repo_mounts` without the partial-unique `idx_repo_mounts_active_root`
    // would leave the attach path admitting duplicate active mounts of one
    // canonical root, silently (see the 0010 file header).
    db.transaction(() => {
      if (!hasMigrationApplied(db, 10)) {
        db.exec(REPO_WORKSPACES_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 11)) {
    // Version 11 (Plan-005) — driver-capability currency: the fourteen-value
    // `driver_capabilities.capability_flag` CHECK (a twelve-step table rebuild,
    // since SQLite cannot alter a column CHECK in place) with its thirteen-flag
    // `supported = 0` backfill, plus the `cli_version_raw` /
    // `cli_version_semver` pair on `runtime_bindings` and
    // `driver_contract_meta` and `runtime_bindings.spawn_config`. Atomicity is
    // load-bearing in two ways no earlier version's was: a torn apply could
    // leave `driver_capabilities_new` present with `driver_capabilities`
    // dropped — every capability read failing as `no such table` — or land the
    // widened CHECK without its backfill rows, leaving a cache whose row count
    // differs from the declared union and so tripping the hydrator's
    // exact-cardinality guard on the first read after boot. Like versions 9 and
    // 10, it also cannot be re-applied by hand (no `ADD COLUMN IF NOT EXISTS`
    // in SQLite; the rebuild's CREATE would throw "table already exists").
    db.transaction(() => {
      if (!hasMigrationApplied(db, 11)) {
        db.exec(DRIVER_CAPABILITY_CURRENCY_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 12)) {
    // Version 12 (Plan-005) — the transcript capability backfill: a
    // `supported = 0` `transcript_replay` row for every cached `driver_name`,
    // landing the fourteenth row against the CHECK version 11 already widened.
    // Atomicity carries the same weight it does at version 11 and for the same
    // reason: the backfill and its `schema_version` stamp must land together, or
    // a re-run would be gated on a version marker whose rows never arrived. What
    // makes the row set urgent rather than cosmetic is the hydrator's
    // exact-cardinality guard — a cache left at thirteen rows against the
    // fourteen-member union throws on the first cold-start read, before any
    // capability refresh could heal it.
    db.transaction(() => {
      if (!hasMigrationApplied(db, 12)) {
        db.exec(TRANSCRIPT_CAPABILITY_BACKFILL_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 13)) {
    // Version 13 (Plan-006) — the durable encrypted home for machine-authored
    // prose: `session_events.content_payload` plus the `session_content_keys`
    // table that holds each session's wrapped sealing key. Order-independent of
    // every earlier version in the strong sense — the column is additive and
    // unreferenced by any existing index, trigger, or CHECK, and the table
    // stands alone with no FK in either direction. Atomicity is what makes the
    // two statements one version rather than two: a column with no key table
    // is a column nothing can write to, and a key table with no column is a key
    // for nothing, so a crash between them would leave a half-usable schema
    // gated on a version marker that never arrived.
    db.transaction(() => {
      if (!hasMigrationApplied(db, 13)) {
        db.exec(CONTENT_PAYLOAD_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 14)) {
    // Version 14 (Plan-005) — the console-parity capability flags: the
    // `capability_flag` CHECK widened from fourteen values to SEVENTEEN through
    // the same twelve-step table rebuild version 11 performed, plus a
    // `supported = 0` backfill of the three added flags for every cached
    // `driver_name`. Unlike version 12 this one CANNOT be a bare row insert:
    // version 11 froze the CHECK at exactly fourteen literals and pre-admits
    // none of the three, so the constraint has to move before any row can land.
    //
    // It follows version 13 by ORDINAL and not by dependency. That version is
    // Plan-006's `session_events` work and touches neither this table nor this
    // constraint, so the two are independent in the strong sense; what this one
    // requires is version 11's table, and only version 11's.
    //
    // Atomicity carries the full version-11 weight rather than version 12's,
    // because this ordinal rebuilds a table: a torn apply could leave
    // `driver_capabilities_new` present with `driver_capabilities` dropped —
    // every capability read failing as `no such table` — or land the widened
    // CHECK without its backfill rows, leaving a cache whose row count differs
    // from the declared union and so tripping the hydrator's exact-cardinality
    // guard on the first read after boot. Like versions 9, 10, and 11 it cannot
    // be re-applied by hand: the rebuild's CREATE would throw "table already
    // exists".
    db.transaction(() => {
      if (!hasMigrationApplied(db, 14)) {
        db.exec(CONSOLE_PARITY_CAPABILITY_FLAGS_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 15)) {
    // Version 15 (Plan-004) — the queue, intervention, and command-receipt
    // tables. Order-independent of every earlier version in the strong sense:
    // it CREATEs three standalone tables, participates in no foreign key in
    // either direction, and neither reads nor rebuilds a column any prior
    // version added. It follows version 14 by ordinal alone.
    //
    // Atomicity is what makes three CREATEs one version rather than three.
    // `queue_items` and `interventions` are the two halves of one admission
    // transaction — an admitted queue item carries the id of the intervention
    // that created it — so a torn apply could leave a schema in which that
    // transaction cannot be written at all, gated on a version marker saying
    // the queue is ready. `command_receipts` rides along as a forward-declared
    // shell (CP-004-2) with no reader until Plan-015: a rollback boundary
    // around a table nothing writes would buy nothing.
    db.transaction(() => {
      if (!hasMigrationApplied(db, 15)) {
        db.exec(QUEUE_AND_INTERVENTIONS_MIGRATION_SQL);
      }
    }).immediate();
  }

  if (!hasMigrationApplied(db, 16)) {
    // Version 16 (Plan-029) — the node-local provider-account registry
    // (`provider_accounts`, plus the two unique indexes that make a second
    // default per provider and a shared credential home unrepresentable) and its
    // per-limit quota-window store (`provider_account_usage_windows`).
    //
    // Order-independent of every earlier version in the strong sense: both
    // tables are new, neither is named by any earlier migration's `REFERENCES`
    // clause, and no earlier table is read, rebuilt, or backfilled here — it
    // follows version 15 by ordinal alone, the two having been authored in
    // parallel under the header's no-contiguity rule.
    //
    // Atomicity is what makes the two tables one version rather than two: the
    // child's `REFERENCES provider_accounts(account_id) ON DELETE CASCADE` is
    // resolved by SQLite at DML time rather than at CREATE time, so a torn apply
    // that landed the child alone would surface as `no such table` at the first
    // window write instead of at migration time — gated on a version marker that
    // never arrived. Like versions 9 through 14 it cannot be re-applied by hand:
    // the CREATEs would throw "table already exists".
    db.transaction(() => {
      if (!hasMigrationApplied(db, 16)) {
        db.exec(PROVIDER_ACCOUNTS_MIGRATION_SQL);
      }
    }).immediate();
  }
}

/**
 * Open a SQLite handle, apply pragmas, and run all pending migrations.
 *
 * This is the canonical entry point for daemon code AND tests. Using it
 * everywhere prevents the pragma-vs-migration-vs-statement-prepare ordering
 * from being silently re-derived (and silently drifting) at each call site.
 *
 * Idempotent on reopen: pragmas are reapplied (they are connection-local
 * per SQLite semantics), and the migration check sees `schema_version`
 * already populated and short-circuits.
 *
 * Failure-mode cleanup: if either `applyPragmas` or `applyMigrations`
 * throws (SQLITE_BUSY after busy_timeout, disk error, schema-corruption
 * detection, etc.), the half-initialized handle is closed before the
 * error propagates. Without this, the underlying `better-sqlite3` handle
 * would never be returned to the caller — nothing else holds a reference
 * to close it — and OS-level locks plus the WAL file descriptor would
 * stay held until V8 garbage-collected the wrapper, making caller-side
 * retries flaky (next `openDatabase` would race the GC). The throw is
 * re-raised verbatim so callers see the same diagnostic they would
 * without the cleanup wrapper. `db.close()` is itself protected: if it
 * throws (e.g. because the underlying handle is already in an
 * unrecoverable state), the close-error is suppressed in favor of the
 * original initialization error — losing init context to a teardown
 * error would obscure the actual failure.
 */
export function openDatabase(dbPath: string): DatabaseType {
  const db: DatabaseType = new Database(dbPath);
  try {
    applyPragmas(db);
    applyMigrations(db);
  } catch (err) {
    try {
      db.close();
    } catch {
      // Swallow close-time failures so the original init error reaches
      // the caller. A close failure on an already-broken handle is
      // strictly less informative than the underlying init throw.
    }
    throw err;
  }
  return db;
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------
//
// `hasMigrationApplied` tolerates the brand-new-database case where the
// `schema_version` table doesn't yet exist. We probe `sqlite_master`
// (always present) instead of catching exceptions so the happy path
// stays exception-free.

function hasMigrationApplied(db: DatabaseType, version: number): boolean {
  const tableExists: { count: number } = db
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_version'",
    )
    .get() as { count: number };
  if (tableExists.count === 0) {
    return false;
  }
  const row: { count: number } = db
    .prepare("SELECT COUNT(*) AS count FROM schema_version WHERE version = ?")
    .get(version) as { count: number };
  return row.count > 0;
}
