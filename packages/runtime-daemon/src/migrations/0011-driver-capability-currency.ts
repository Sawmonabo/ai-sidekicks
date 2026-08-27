// Plan-005 T1.7 — version-11 migration: driver-capability currency.
//
// Four legs, one script: the fourteen-value `driver_capabilities.capability_flag`
// CHECK, the thirteen-flag row backfill that keeps the cache's cardinality equal
// to the declared union, the `cli_version_raw` / `cli_version_semver` pair on
// `runtime_bindings` + `driver_contract_meta`, and `runtime_bindings.spawn_config`.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file, for the reasons the `0001-initial.ts` header sets out in
// full (tsc -b does not copy non-TS assets into `dist/`; `"files": ["dist"]`
// would exclude `src/migrations/` from the published tarball; bundlers handle
// `import.meta.url` inconsistently).
//
// PROVENANCE. The canonical schema source-of-truth is
// `docs/architecture/schemas/local-sqlite-schema.md`
// §"Driver and Runtime Binding Tables (Plan-005)" — the successor
// `driver_capabilities` table and every added column below are transcribed from
// that section (per-column comments included), the same convention and the same
// direction of authority `0003-runtime-bindings.ts` and `0010-repo-workspaces.ts`
// state: the schema doc defines the shape, this file applies it. Change the doc
// first, then mirror it here.
//
// ----------------------------------------------------------------------------
// Plan-005 scope (this migration — version 11)
// ----------------------------------------------------------------------------
//
//   * driver_capabilities  — `capability_flag` CHECK widened from the frozen
//     version-3 seven-value list to all FOURTEEN canonical values, plus a
//     `supported = 0` backfill for the THIRTEEN flags this task declares.
//   * runtime_bindings     — `cli_version_raw` + `cli_version_semver` (the
//     provider-reported CLI version captured at binding write) and
//     `spawn_config` (the daemon-owned record of the spawn-bound configuration
//     realized at process spawn, which recovery re-reads to reconstruct the
//     resume request's data legs without the original client request).
//   * driver_contract_meta — the same `cli_version_raw` / `cli_version_semver`
//     pair, cached from the last capability refresh. Cold-start hydration treats
//     a NULL pair as a cache MISS and refreshes from the driver: the required
//     `GetCapabilitiesResult.cliVersion` is never fabricated from cache.
//
// Out of scope: the write seams that populate these columns, and the
// contract-side widening of `DRIVER_CAPABILITY_FLAGS`
// (`packages/contracts/src/provider-driver.ts`, the T1.7 contracts half). This
// file is schema only.
//
// ----------------------------------------------------------------------------
// Why driver_capabilities is REBUILT and the other two tables are ALTERed
// ----------------------------------------------------------------------------
//
// SQLite has no `ALTER TABLE ... ADD CHECK` and no `DROP CHECK`: a column's
// CHECK is fixed at CREATE time, so widening an enum means replacing the table
// via the documented twelve-step procedure
// (https://sqlite.org/lang_altertable.html §"Making Other Kinds Of Table Schema
// Changes"). That is the same engine constraint the `0009` header names when it
// declines a rebuild of the append-only audit log; here the table is a
// per-driver cache with no chain of custody, so the rebuild is the ordinary move
// rather than the forbidden one.
//
// Which twelve-step legs this script omits, and why each omission is safe:
//   * Steps 1 and 12 (`PRAGMA foreign_keys` off, then on) are BOTH impossible
//     and unnecessary. Impossible: the runner wraps every migration in a
//     transaction and `PRAGMA foreign_keys` is a documented no-op inside one.
//     Unnecessary: `driver_capabilities` participates in no foreign key in
//     either direction — it declares no `REFERENCES` clause and no table in the
//     schema references it — so the `DROP` fires no cascade and orphans no child
//     row.
//   * Step 10 (`PRAGMA foreign_key_check`) is vacuous for the same reason.
//   * Steps 3 and 8 (remember, then re-create, the table's indexes / triggers /
//     views) have an EMPTY inventory: the table's only index is the implicit
//     PRIMARY KEY autoindex, which the successor's identical
//     `PRIMARY KEY (driver_name, capability_flag)` re-creates, and no trigger or
//     view in the schema names it.
//
// The other two tables take `ALTER TABLE ... ADD COLUMN` instead, because
// nothing forces a rebuild on them: every added column is either NULL-permitting
// or NOT NULL *with* a non-NULL DEFAULT, which are exactly the shapes ADD COLUMN
// accepts. (Contrast `run_execution_contexts.checkout_root`, which the schema doc
// routes through a Plan-010 Phase-3 rebuild precisely because
// `ADD COLUMN ... NOT NULL` with no default is refused unconditionally.)
// Rebuilding `runtime_bindings` — the one Plan-005 table with a shipped writer
// and a secondary index — to buy nothing but column order would be blast radius
// without a payer.
//
// The cost of ADD COLUMN is the `retention_class`-style CID-last divergence the
// schema doc names in its own `checkout_root` note: the doc declares
// `cli_version_raw` / `cli_version_semver` / `spawn_config` in their LOGICAL
// positions (the version pair beside `contract_version`, `spawn_config` beside
// `runtime_metadata`), while `PRAGMA table_info` reports them appended last.
// That divergence is inert here — every Plan-005 read and write names its columns
// explicitly (`provider/runtime-binding-store.ts`,
// `provider/driver-capabilities-writer.ts`), so no consumer depends on ordinal
// position, and the migration-shape tests pin the physical order that results.
//
// The pair CHECK on `cli_version_semver` spans TWO columns — it asserts
// `(cli_version_semver IS NULL) = (cli_version_raw IS NULL)`, the both-or-neither
// rule that keeps a parsed form from outliving its verbatim source. ADD COLUMN
// accepts a CHECK referencing a sibling column and does not re-validate existing
// rows; every pre-migration row carries NULL for both, which the predicate
// satisfies anyway. SQLite evaluates every CHECK on every subsequent write to the
// row, not only on writes that name the constrained column, so a writer that
// stores the raw string and forgets the parsed one fails loud.
//
// ----------------------------------------------------------------------------
// The CHECK is a whitelist; the ROW SET is the cardinality claim
// ----------------------------------------------------------------------------
//
// The CHECK admits all FOURTEEN canonical values at once — the thirteen this
// task declares plus `transcript_replay`, whose first row lands at Plan-005 T3.19
// (`migrations/000N-transcript-capability-backfill.ts`, allocated by this same
// `max(existing) + 1` rule) — for the reason Plan-005 T1.7 gives: a CHECK is a
// whitelist,
// admitting a value ahead of its first row costs nothing, and a second
// CHECK-widening migration would cost an ordinal and another rebuild of this
// table.
//
// The BACKFILL is the leg that must track the union's exact cardinality, so it
// covers exactly the thirteen declared flags and gives `transcript_replay` no
// row — T3.19 lands the fourteenth row in the same ordinal that widens the
// union. Per invariant I-005-2 (undeclared capability = unsupported) the
// backfilled rows are `supported = 0`: a driver that never answered a flag does
// not support it. Without the backfill, a cache written before this migration
// would hold seven rows per driver against a thirteen-member union, and the
// exact-cardinality guard in `provider/driver-capabilities-writer.ts` would throw
// on the first cold-start hydration — before any refresh could heal it. That
// guard has a write-side twin — `assertValidCapabilityFlags` in
// `provider/provider-output-validation.ts`, which rejects a refresh declaring
// anything other than exactly the union's flags — and neither announces itself
// at its call site. The backfilled row set has to satisfy both.
//
// Four details of the backfill statement are load-bearing:
//   * It runs AFTER the rename. Against the superseded seven-value CHECK the six
//     new literals would be rejected outright.
//   * `ON CONFLICT (driver_name, capability_flag) DO NOTHING` rather than
//     `INSERT OR IGNORE`. `OR IGNORE` swallows EVERY constraint class, so a
//     mistyped flag literal would be silently skipped and leave a twelve-row
//     driver behind a green migration; scoping the conflict handler to the
//     primary key keeps a CHECK violation loud while still making the
//     already-present rows a no-op.
//   * `refreshed_at` is copied from the driver's OWN newest existing row, never
//     `datetime('now')`. These rows record what that driver's last real refresh
//     declared — nothing, hence `supported = 0` — so stamping them with the
//     migration's wall clock would make a cache the driver never answered look
//     freshly refreshed. The aggregate is grouped per driver, so one driver's
//     refresh instant can never leak onto another's rows.
//   * The trailing `WHERE true` is required, not decoration: when an UPSERT is
//     attached to an `INSERT ... SELECT`, SQLite's parser cannot tell the
//     UPSERT's `ON` from a join's `ON` clause, and the documented workaround is a
//     WHERE clause on the SELECT (https://sqlite.org/lang_upsert.html
//     §"Parsing Ambiguity").
//
// The fourteen literals are HARDCODED here rather than imported from
// `DRIVER_CAPABILITY_FLAGS`: a migration is a frozen point-in-time copy of the
// schema (the `0003-runtime-bindings.ts` precedent — its seven-value CHECK is
// exactly the frozen copy this one supersedes), and a migration that imported a
// live const would silently re-shape history the next time the const moved. The
// behavioral lockstep between the const and the backfilled row set is asserted
// instead by the union-parity test in
// `session/__tests__/migration-shape.test.ts` — the Plan-005 analogue of the
// I-010-2 tripwire `git/__tests__/contract-ddl-conformance.test.ts` runs for
// Plan-010, done through live backfilled rows rather than by DDL text extraction.
//
// Vocabulary, not order, is the claim the CHECK makes:
// `api-payload-contracts.md` §Shared Enums lists the same fourteen values with
// `transcript_replay` ahead of `cost_cap`, while the local-SQLite schema doc
// lists `cost_cap` first. A `CHECK(... IN (...))` list is a set, so the two
// orderings denote one constraint; this file transcribes the schema doc it
// mirrors.
//
// ----------------------------------------------------------------------------
// Idempotency, atomicity, and version order
// ----------------------------------------------------------------------------
//
// Idempotency and concurrency are the migration runner's job (the guarded
// `hasMigrationApplied(db, 11)` block with its in-transaction re-check and
// `.immediate()` dispatch); this constant is a plain DDL script. It carries no
// `IF NOT EXISTS` — and SQLite has no `ADD COLUMN IF NOT EXISTS` form at all — so
// a second exec throws ("table already exists" on the rebuild's CREATE, or
// "duplicate column name" on the ALTERs). The runner guard is what makes
// re-application a no-op, and the version-11 anchor row committing in the SAME
// transaction as the DDL is what keeps the guard and the physical schema from
// ever disagreeing.
//
// Atomicity is load-bearing here in a way no earlier version's was: this is the
// first migration to DROP and RENAME a table, and the first to BACKFILL data. A
// torn apply could otherwise leave `driver_capabilities_new` present with
// `driver_capabilities` gone — every capability read failing as `no such table` —
// or a widened CHECK with no backfill rows, which trips the hydrator's
// exact-cardinality guard on the first read after boot. Neither is reachable:
// the whole script commits or none of it does.
//
// Version ORDER: this migration requires version 3 (the three tables it alters)
// and is order-independent of versions 2 and 4 through 10, which touch no
// Plan-005 table.
//
// Spec coverage: Spec-005 §Per-Driver Capability Matrix (the thirteen declared
// flags), Spec-005 §Required Behavior (undeclared capability = unsupported; the
// `cliVersion` report). Refs: Plan-005 T1.7, I-005-2,
// `docs/architecture/schemas/local-sqlite-schema.md` §"Driver and Runtime
// Binding Tables (Plan-005)".

export const DRIVER_CAPABILITY_CURRENCY_MIGRATION_SQL: string = `
-- Owner: Plan-005 | Migration: 0011-driver-capability-currency.ts (Tier 4 Phase 1)

-- ---------------------------------------------------------------------------
-- driver_capabilities: the fourteen-value capability_flag CHECK.
-- Twelve-step table rebuild (sqlite.org/lang_altertable.html) -- a column CHECK
-- cannot be altered in place. The successor shape is the canonical block in
-- local-sqlite-schema.md, widened CHECK included.
-- ---------------------------------------------------------------------------
CREATE TABLE driver_capabilities_new (
  driver_name       TEXT NOT NULL,
  capability_flag   TEXT NOT NULL
                    CHECK(capability_flag IN (
                      'resume', 'steer', 'interactive_requests', 'mcp',
                      'tool_calls', 'reasoning_stream', 'model_mutation',
                      'structured_output', 'rollback', 'session_goals',
                      'callback_tools', 'subagents', 'cost_cap',
                      'transcript_replay'
                    )),
  -- The fourteen admitted values land as ROWS in two waves matching the two union
  -- widenings: the thirteen campaign flags here (Plan-005 T1.7), and transcript_replay
  -- when T3.19 widens the union. A CHECK is a whitelist, so admitting a value
  -- before any row uses it costs nothing and spares a second migration; the ROW SET is
  -- what must track the union's exact cardinality, because a cache whose row count
  -- differs from the union's breaks the hydrator's exact-cardinality guard before any
  -- refresh could heal it.
  supported         INTEGER NOT NULL DEFAULT 0, -- boolean: 0 or 1
  refreshed_at      TEXT NOT NULL,
  PRIMARY KEY (driver_name, capability_flag)
);

INSERT INTO driver_capabilities_new (driver_name, capability_flag, supported, refreshed_at)
  SELECT driver_name, capability_flag, supported, refreshed_at
    FROM driver_capabilities;

DROP TABLE driver_capabilities;

ALTER TABLE driver_capabilities_new RENAME TO driver_capabilities;

-- Backfill (I-005-2: undeclared capability = unsupported). Exactly the THIRTEEN flags
-- this task declares, for every driver_name already cached -- transcript_replay gets no
-- row until T3.19 widens the union. Runs AFTER the rename: the six new literals would
-- be rejected by the superseded seven-value CHECK. refreshed_at is copied from the
-- driver's own newest row, never the migration's wall clock, so a cache the driver never
-- answered cannot read as freshly refreshed. ON CONFLICT ... DO NOTHING rather than
-- INSERT OR IGNORE, so a mistyped literal fails loud on the CHECK instead of silently
-- short-counting the row set; the WHERE true disambiguates the UPSERT's ON from a join's
-- ON per sqlite.org/lang_upsert.html.
INSERT INTO driver_capabilities (driver_name, capability_flag, supported, refreshed_at)
  SELECT cached_driver.driver_name, declared_flag.capability_flag, 0, cached_driver.refreshed_at
    FROM (
           SELECT driver_name, MAX(refreshed_at) AS refreshed_at
             FROM driver_capabilities
            GROUP BY driver_name
         ) AS cached_driver
    CROSS JOIN (
           SELECT 'resume' AS capability_flag
           UNION ALL SELECT 'steer'
           UNION ALL SELECT 'interactive_requests'
           UNION ALL SELECT 'mcp'
           UNION ALL SELECT 'tool_calls'
           UNION ALL SELECT 'reasoning_stream'
           UNION ALL SELECT 'model_mutation'
           UNION ALL SELECT 'structured_output'
           UNION ALL SELECT 'rollback'
           UNION ALL SELECT 'session_goals'
           UNION ALL SELECT 'callback_tools'
           UNION ALL SELECT 'subagents'
           UNION ALL SELECT 'cost_cap'
         ) AS declared_flag
   WHERE true
      ON CONFLICT (driver_name, capability_flag) DO NOTHING;

-- ---------------------------------------------------------------------------
-- runtime_bindings: the CLI-version pair and the spawn-bound configuration.
-- ---------------------------------------------------------------------------

-- Verbatim provider-reported CLI version captured at binding write (Spec-005
-- §Required Behavior cliVersion report, campaign B3); NULL only on pre-B3 rows --
-- the write path stores the pair or neither.
ALTER TABLE runtime_bindings ADD COLUMN cli_version_raw TEXT
  CHECK (cli_version_raw IS NULL OR (length(cli_version_raw) > 0 AND length(cli_version_raw) <= 128 AND instr(cli_version_raw, char(0)) = 0));

-- Parsed floor-compare form of the pair; the fail-closed floor gate
-- (driver.cli_version_unparseable) runs before any binding write, so a stored pair is
-- always parseable. The leading conjunct is the both-or-neither rule.
ALTER TABLE runtime_bindings ADD COLUMN cli_version_semver TEXT
  CHECK ((cli_version_semver IS NULL) = (cli_version_raw IS NULL) AND (cli_version_semver IS NULL OR (length(cli_version_semver) > 0 AND length(cli_version_semver) <= 64 AND instr(cli_version_semver, char(0)) = 0)));

-- JSON: daemon-owned record of the spawn-bound configuration realized at process spawn
-- (executionPosture / callbackTools / subagentPolicy / outputSchema + the admitted cap);
-- written at every spawn -- the durable source recovery re-reads to reconstruct the
-- resume request's data legs without the original client request (function legs are
-- re-injected fresh, never stored). Daemon-constructed, so no provider-string CHECK --
-- same trust class as runtime_metadata.
ALTER TABLE runtime_bindings ADD COLUMN spawn_config TEXT NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- driver_contract_meta: the same CLI-version pair, cached per driver.
-- ---------------------------------------------------------------------------

-- Cached cliVersion.raw from the last capability refresh (Spec-005 §Required Behavior,
-- campaign B3); NULL only on pre-B3 rows.
ALTER TABLE driver_contract_meta ADD COLUMN cli_version_raw TEXT
  CHECK (cli_version_raw IS NULL OR (length(cli_version_raw) > 0 AND length(cli_version_raw) <= 128 AND instr(cli_version_raw, char(0)) = 0));

-- Cached parsed form; cold-start hydration MUST treat a NULL pair as a cache miss and
-- refresh from the driver -- the required GetCapabilitiesResult.cliVersion is never
-- fabricated from cache.
ALTER TABLE driver_contract_meta ADD COLUMN cli_version_semver TEXT
  CHECK ((cli_version_semver IS NULL) = (cli_version_raw IS NULL) AND (cli_version_semver IS NULL OR (length(cli_version_semver) > 0 AND length(cli_version_semver) <= 64 AND instr(cli_version_semver, char(0)) = 0)));

INSERT INTO schema_version (version, applied_at, description)
VALUES (11, datetime('now'), 'Driver capability currency (fourteen-value driver_capabilities.capability_flag CHECK + thirteen-flag backfill, runtime_bindings/driver_contract_meta cli_version_raw + cli_version_semver, runtime_bindings.spawn_config)');
`;
