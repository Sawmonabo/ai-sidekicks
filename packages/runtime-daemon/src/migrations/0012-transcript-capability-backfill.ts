// Plan-005 T3.19 — version-12 migration: the transcript capability backfill.
//
// ONE leg, and the smallest a migration in this tree gets: a `supported = 0`
// `transcript_replay` row for every `driver_name` already cached in
// `driver_capabilities`. No CHECK is widened, no table is rebuilt, and no column
// is added.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file, for the reasons the `0001-initial.ts` header sets out in
// full (tsc -b does not copy non-TS assets into `dist/`; `"files": ["dist"]`
// would exclude `src/migrations/` from the published tarball; bundlers handle
// `import.meta.url` inconsistently).
//
// PROVENANCE. The canonical schema source-of-truth is
// `docs/architecture/schemas/local-sqlite-schema.md`
// §"Driver and Runtime Binding Tables (Plan-005)", whose widening note describes
// the row set landing "in two waves": the thirteen campaign flags at version 11,
// and `transcript_replay` here. This file applies that note; it does not decide
// it.
//
// ----------------------------------------------------------------------------
// Why the CHECK is untouched and the ROW SET is not
// ----------------------------------------------------------------------------
//
// The two legs of a union widening settle differently and must not be
// conflated. The **CHECK** needs no second widening: version 11 already admits
// all FOURTEEN canonical values, because a CHECK is a whitelist and admitting a
// value ahead of its first row costs nothing, while a second CHECK-widening
// migration would cost an ordinal AND another twelve-step rebuild of a table
// that participates in no foreign key. A `transcript_replay` row inserted here
// therefore passes the shipped constraint unchanged.
//
// The **ROW SET** is the leg that tracks the union's exact cardinality, and it
// is why this ordinal exists at all. `DriverCapabilitiesWriter`'s snapshot
// reader proves the stored key set is EXACTLY the canonical one before handing
// out a `Record<DriverCapabilityFlag, boolean>`, and its write-side twin
// (`assertValidCapabilityFlags`) rejects a refresh declaring anything else. So a
// cache left at thirteen rows against a fourteen-member union does not degrade
// gracefully and does not heal on the next refresh — it throws on the NEXT
// HYDRATION, which happens at cold start, before any refresh could run. The
// backfill has to land in the same ordinal that widens the union for that reason
// and no other.
//
// Per invariant I-005-2 (undeclared capability = unsupported) the backfilled row
// is `supported = 0`: a driver that has not answered a flag does not support it.
// Both shipped drivers declare `transcript_replay: false` at this task, so the
// backfilled row and the declared value agree; the task that flips a declaration
// to `true` moves the row through an ordinary capability refresh, not through a
// migration.
//
// ----------------------------------------------------------------------------
// What the backfill statement does and does not reach
// ----------------------------------------------------------------------------
//
//   * `refreshed_at` is copied from the driver's own newest row rather than from
//     `datetime('now')`, so a cache the driver never answered cannot read as
//     freshly refreshed. This is the same rule version 11's backfill follows,
//     and it is the reason the statement groups over `driver_capabilities`
//     instead of selecting distinct driver names.
//   * `ON CONFLICT ... DO NOTHING` rather than `INSERT OR IGNORE`, so a mistyped
//     literal fails loud on the CHECK instead of silently short-counting the row
//     set. The trailing `WHERE true` is REQUIRED, not stylistic symmetry with
//     version 11: SQLite reads the `ON` after a FROM-clause table alias as a
//     join constraint, and without an intervening clause the statement fails to
//     parse at all (`near "DO": syntax error`) — verified against the pinned
//     `better-sqlite3` build rather than assumed from the sibling's shape
//     (sqlite.org/lang_upsert.html).
//   * A driver with ZERO capability rows forms no group, receives no backfill,
//     and still fails hydration loudly with every key missing — the same bounded
//     behaviour version 11 records. That is the intended asymmetry: a totally
//     absent flag set is corruption and stays detectable, while a cache that
//     carries the version-11 thirteen is a legitimate pre-upgrade state and is
//     brought to fourteen here.
//   * Re-applying by hand is safe in a way version 11's rebuild is not — the
//     statement is idempotent by its own `ON CONFLICT` clause. The runner's
//     `schema_version` guard is still what prevents a second apply; the
//     idempotency only means a hand-run costs nothing.
//
// Spec coverage: `Spec-005 §Canonical Transcript Export And Replay` (the
// `transcript_replay` capability), `Spec-005 §Required Behavior` (undeclared
// capability = unsupported). Refs: Plan-005 T3.19, I-005-2, ADR-029,
// `docs/architecture/schemas/local-sqlite-schema.md` §"Driver and Runtime
// Binding Tables (Plan-005)".

export const TRANSCRIPT_CAPABILITY_BACKFILL_MIGRATION_SQL: string = `
-- Owner: Plan-005 | Migration: 0012-transcript-capability-backfill.ts (Tier 4 Phase 3)

-- ---------------------------------------------------------------------------
-- driver_capabilities: the fourteenth flag's row, for every cached driver.
-- The version-11 CHECK already admits 'transcript_replay'; only the row set
-- moves here (I-005-2: undeclared capability = unsupported).
-- ---------------------------------------------------------------------------
INSERT INTO driver_capabilities (driver_name, capability_flag, supported, refreshed_at)
  SELECT cached_driver.driver_name, 'transcript_replay', 0, cached_driver.refreshed_at
    FROM (
           SELECT driver_name, MAX(refreshed_at) AS refreshed_at
             FROM driver_capabilities
            GROUP BY driver_name
         ) AS cached_driver
   WHERE true
      ON CONFLICT (driver_name, capability_flag) DO NOTHING;

INSERT INTO schema_version (version, applied_at, description)
VALUES (12, datetime('now'), 'Transcript capability backfill (transcript_replay supported = 0 row per cached driver_name)');
`;
