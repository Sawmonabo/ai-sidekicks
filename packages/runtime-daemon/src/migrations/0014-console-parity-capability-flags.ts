// Plan-005 T3.26 — version-14 migration: the console-parity capability flags.
//
// TWO legs in ONE ordinal, and that pairing is the whole point of the file. The
// `driver_capabilities.capability_flag` CHECK is widened from fourteen values to
// SEVENTEEN, and `supported = 0` rows for the three added flags are backfilled
// for every `driver_name` already cached.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file, for the reasons the `0001-initial.ts` header sets out in
// full (tsc -b does not copy non-TS assets into `dist/`; `"files": ["dist"]`
// would exclude `src/migrations/` from the published tarball; bundlers handle
// `import.meta.url` inconsistently).
//
// PROVENANCE. The canonical schema source-of-truth is
// `docs/architecture/schemas/local-sqlite-schema.md`
// §"Driver and Runtime Binding Tables (Plan-005)", whose widening note already
// declares the seventeen-value CHECK and names this as the third and last wave
// of rows. This file applies that note; it does not decide it.
//
// ----------------------------------------------------------------------------
// Why this widening cannot ride a whitelist head start
// ----------------------------------------------------------------------------
//
// The narrative below names versions 11 and 12 and never version 13, and that
// is a fact about OWNERSHIP rather than an omission: version 13 is Plan-006's
// `content_payload` ordinal and touches `session_events`, a table this file
// neither reads nor rebuilds. The capability-flag chain is 11, 12, then this.
//
// Version 12 needed no CHECK work: version 11 had already admitted all fourteen
// canonical values, so `transcript_replay` passed the shipped constraint and the
// migration moved only rows. That head start is now SPENT. Version 11 froze the
// CHECK at exactly fourteen literals and pre-admits none of these three, so a
// backfilled `context_compaction` row would be REJECTED by the shipped
// constraint. The CHECK therefore has to move first, and a column CHECK cannot
// be altered in place in SQLite — hence the twelve-step table rebuild
// (sqlite.org/lang_altertable.html) rather than an `ALTER TABLE`.
//
// The rebuild's successor CHECK lists ALL SEVENTEEN and not merely the three
// added: a rebuild replaces the constraint wholesale, so omitting the fourteen
// already in it would reject the `cost_cap` and `transcript_replay` rows that
// versions 11 and 12 wrote — the row-copy step, not some later insert, is where
// that would surface.
//
// ----------------------------------------------------------------------------
// Why the rows must land in this same ordinal
// ----------------------------------------------------------------------------
//
// `DriverCapabilitiesWriter`'s snapshot reader proves the stored key set is
// EXACTLY the canonical one before handing out a
// `Record<DriverCapabilityFlag, boolean>`, and its write-side twin
// (`assertValidCapabilityFlags`) rejects a refresh declaring anything else. A
// cache left at fourteen rows against a seventeen-member union does not degrade
// gracefully and does not heal on the next refresh — it throws on the NEXT
// HYDRATION, which happens at cold start, before any refresh could run. So the
// backfill lands in the same ordinal that widens the union, for that reason and
// no other.
//
// Per invariant I-005-2 (undeclared capability = unsupported) each backfilled
// row is `supported = 0`: a driver that has not answered a flag does not support
// it. The declarations the two shipped drivers carry at this task are NOT all
// `false` — Claude declares all three `true` and Codex declares two — so unlike
// version 12 the backfilled row and the declared value deliberately DISAGREE for
// most cells until the first capability refresh runs. That is correct and is the
// invariant rather than a defect: a migration records what the daemon has been
// TOLD, and it has been told nothing; the refresh is what records what the
// driver says. Writing the declaration here would make the cache assert a
// capability no build has been asked about, which is exactly the unprobed `true`
// I-005-2 exists to forbid.
//
// ----------------------------------------------------------------------------
// What the backfill statement does and does not reach
// ----------------------------------------------------------------------------
//
//   * The backfill runs AFTER the rename, because the three new literals would
//     be rejected by the superseded fourteen-value CHECK.
//   * `refreshed_at` is copied from the driver's own newest row rather than from
//     `datetime('now')`, so a cache the driver never answered cannot read as
//     freshly refreshed. Same rule versions 11 and 12 follow, and the reason the
//     statement groups over `driver_capabilities` instead of selecting distinct
//     driver names.
//   * `ON CONFLICT ... DO NOTHING` rather than `INSERT OR IGNORE`, so a mistyped
//     literal fails loud on the CHECK instead of silently short-counting the row
//     set. The trailing `WHERE true` is REQUIRED, not stylistic: SQLite reads the
//     `ON` after a FROM-clause table alias as a join constraint, and without an
//     intervening clause the statement fails to parse at all (`near "DO": syntax
//     error`) — sqlite.org/lang_upsert.html.
//   * A driver with ZERO capability rows forms no group, receives no backfill,
//     and still fails hydration loudly with every key missing — the same bounded
//     behaviour versions 11 and 12 record. A totally absent flag set is
//     corruption and stays detectable, while a cache carrying the version-12
//     fourteen is a legitimate pre-upgrade state and is brought to seventeen
//     here.
//   * The table participates in no foreign key, so the rebuild needs nothing
//     beyond what the runner already establishes — the same property version
//     11's rebuild of this same table relies on.
//
// Spec coverage: `Spec-005 §Desktop Console Parity Surfaces` (the three added
// capabilities), `Spec-005 §Required Behavior` (undeclared capability =
// unsupported). Refs: Plan-005 T3.26, I-005-2,
// `docs/architecture/schemas/local-sqlite-schema.md` §"Driver and Runtime
// Binding Tables (Plan-005)".

export const CONSOLE_PARITY_CAPABILITY_FLAGS_MIGRATION_SQL: string = `
-- Owner: Plan-005 | Migration: 0014-console-parity-capability-flags.ts (Tier 4 Phase 3)

-- ---------------------------------------------------------------------------
-- driver_capabilities: the seventeen-value capability_flag CHECK.
-- Twelve-step table rebuild (sqlite.org/lang_altertable.html) -- a column CHECK
-- cannot be altered in place, and version 11 froze this one at fourteen literals
-- that admit none of the three flags added here. The successor shape is the
-- canonical block in local-sqlite-schema.md, widened CHECK included.
-- ---------------------------------------------------------------------------
CREATE TABLE driver_capabilities_new (
  driver_name       TEXT NOT NULL,
  capability_flag   TEXT NOT NULL
                    CHECK(capability_flag IN (
                      'resume', 'steer', 'interactive_requests', 'mcp',
                      'tool_calls', 'reasoning_stream', 'model_mutation',
                      'structured_output', 'rollback', 'session_goals',
                      'callback_tools', 'subagents', 'cost_cap',
                      'transcript_replay', 'context_compaction',
                      'provider_commands', 'output_speed'
                    )),
  -- All seventeen admitted values are listed because a rebuild replaces the
  -- constraint wholesale: naming only the three added would reject the cost_cap
  -- and transcript_replay rows versions 11 and 12 already wrote, and the row-copy
  -- step below is where that would surface.
  supported         INTEGER NOT NULL DEFAULT 0, -- boolean: 0 or 1
  refreshed_at      TEXT NOT NULL,
  PRIMARY KEY (driver_name, capability_flag)
);

INSERT INTO driver_capabilities_new (driver_name, capability_flag, supported, refreshed_at)
  SELECT driver_name, capability_flag, supported, refreshed_at
    FROM driver_capabilities;

DROP TABLE driver_capabilities;

ALTER TABLE driver_capabilities_new RENAME TO driver_capabilities;

-- Backfill (I-005-2: undeclared capability = unsupported). Exactly the THREE flags
-- this task adds, for every driver_name already cached. Runs AFTER the rename: the
-- three literals would be rejected by the superseded fourteen-value CHECK.
-- refreshed_at is copied from the driver's own newest row, never the migration's wall
-- clock, so a cache the driver never answered cannot read as freshly refreshed.
-- ON CONFLICT ... DO NOTHING rather than INSERT OR IGNORE, so a mistyped literal fails
-- loud on the CHECK instead of silently short-counting the row set; the WHERE true
-- disambiguates the UPSERT's ON from a join's ON per sqlite.org/lang_upsert.html.
INSERT INTO driver_capabilities (driver_name, capability_flag, supported, refreshed_at)
  SELECT cached_driver.driver_name, added_flag.capability_flag, 0, cached_driver.refreshed_at
    FROM (
           SELECT driver_name, MAX(refreshed_at) AS refreshed_at
             FROM driver_capabilities
            GROUP BY driver_name
         ) AS cached_driver
    CROSS JOIN (
           SELECT 'context_compaction' AS capability_flag
           UNION ALL SELECT 'provider_commands'
           UNION ALL SELECT 'output_speed'
         ) AS added_flag
   WHERE true
      ON CONFLICT (driver_name, capability_flag) DO NOTHING;

INSERT INTO schema_version (version, applied_at, description)
VALUES (14, datetime('now'), 'Console-parity capability flags (capability_flag CHECK widened to seventeen; context_compaction / provider_commands / output_speed supported = 0 rows per cached driver_name)');
`;
