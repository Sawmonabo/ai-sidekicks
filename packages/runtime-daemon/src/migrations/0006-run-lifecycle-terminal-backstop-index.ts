// Plan-006 T3.1 — version-6 migration: the run_lifecycle TERMINAL-KEY backstop.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file, for the reasons the `0001-initial.ts` header sets out in
// full (tsc -b does not copy non-TS assets into `dist/`; `"files": ["dist"]`
// would exclude `src/migrations/` from the published tarball; bundlers handle
// `import.meta.url` inconsistently). The canonical schema source-of-truth is
// `docs/architecture/schemas/local-sqlite-schema.md` — the index and the three
// triggers below are transcribed from that file's `session_events` block
// VERBATIM, so the inline constant stays in lockstep with the canonical doc.
//
// ----------------------------------------------------------------------------
// What this migration enforces, and why it needs FOUR objects instead of one
// ----------------------------------------------------------------------------
//
// `Spec-006 §Run Lifecycle (run_lifecycle)` admits AT MOST ONE terminal event
// per (runId, runVersion) — a run completes, fails, or is interrupted exactly
// once. The natural spelling of that rule is a table CHECK constraint, and
// SQLite cannot express it: `ALTER TABLE ... ADD CONSTRAINT` / `ADD CHECK` does
// not exist in SQLite's ALTER TABLE grammar, and rewriting `session_events`
// (the 12-table create-new/copy/drop/rename dance) to attach one would rewrite
// an append-only audit log whose every row is hash-chained — a
// chain-invalidating operation this plan will not perform for a constraint. So
// the rule is enforced by a PARTIAL UNIQUE INDEX plus a TRIGGER TRIO, each
// closing a hole the others leave open:
//
//   1. `idx_session_events_run_terminal_once` — the uniqueness itself. PARTIAL
//      (`WHERE category = 'run_lifecycle' AND type IN (...)`) so it indexes only
//      terminal rows: non-terminal events carry no runId/runVersion obligation
//      and must not be constrained, and a partial index also keeps the index
//      small on a table dominated by output/tool events. Keyed on
//      `json_extract(payload, '$.runId')` / `'$.runVersion'` because the run
//      identity lives INSIDE the JSON payload — `session_events` has no runId
//      column, and adding one would be a Plan-006-owned schema widening this
//      task does not take.
//
//   2. `trg_run_terminal_key_insert` — the NULL hole. SQLite treats NULLs as
//      DISTINCT in a UNIQUE index (SQL-standard behavior), so a terminal row
//      with a MISSING `$.runId` does not conflict with ANY other row —
//      including another terminal row for the same run, also missing it. Two
//      such rows both land and the "at most one terminal" rule is silently
//      void. The trigger closes that by ABORTing any terminal INSERT whose
//      runId/runVersion is null. It ALSO checks `json_type(...)` storage
//      CLASS: `json_extract` returns SQLite values, so `"7"` (text) and `7`
//      (integer) are DIFFERENT index keys, and a producer that stringified
//      `runVersion` would write a second terminal row for the same logical run
//      without tripping the index. Demanding `'text'` runId + `'integer'`
//      runVersion makes the index key canonical, so uniqueness is uniqueness
//      over the RUN, not over its JSON spelling.
//
//   3. `trg_run_terminal_key_update` — the value-rewrite hole. The index
//      constrains the SET of live keys, not their STABILITY: an UPDATE that
//      rewrites an already-committed terminal row's `$.runId` to a fresh value
//      moves the key rather than duplicating it, so the index is satisfied
//      while the durable record now attributes the terminal event to a
//      different run. The comparisons use `IS NOT` (not `<>`) precisely because
//      the operands may be NULL and `<>` yields NULL — which the trigger's
//      `WHEN` clause reads as false, letting the very rewrite it guards
//      through. `IS NOT` is null-safe and returns a true/false answer for every
//      operand pair. The clause also pins `category` and `type`, so a terminal
//      row cannot be DE-SCOPED out of the partial index's predicate (rewriting
//      `category` to something else would drop the row from the index and free
//      its key for reuse — deletion of the constraint by mutation).
//
//   4. `trg_run_terminal_key_promote` — the promotion hole, the mirror of (3).
//      A NON-terminal row (which the partial index does not cover, and whose
//      payload therefore never had to carry a valid runId/runVersion) can be
//      UPDATEd into terminal `category`/`type`. That is an INSERT into the
//      index's predicate through the back door, and (2) does not see it
//      because (2) fires on INSERT only. Terminal rows are INSERT-ONLY: the
//      trigger ABORTs every such promotion outright rather than trying to
//      validate it, because an append-only audit log has no legitimate reason
//      to reclassify a committed row as a run's terminal event.
//
// Why a backstop at all, when `EventLogService.append` validates: the index and
// triggers are a STORAGE-LEVEL invariant, enforced against every writer on the
// connection including future plans, ad-hoc repair scripts, and any code path
// that bypasses the append service. Application-level validation and the
// storage backstop are defense in depth, not redundancy — the append path
// produces good errors, the backstop makes bad rows unrepresentable.
//
// Idempotency + concurrency are the migration runner's job (the guarded
// `hasMigrationApplied(db, 6)` block with its in-transaction re-check and
// `.immediate()` dispatch); this constant is a plain DDL script.
//
// Spec coverage: `Spec-006 §Run Lifecycle (run_lifecycle)` (the
// at-most-one-terminal-event rule), `Spec-006 §Event Type Summary` (the three
// terminal run_lifecycle types). Refs: Plan-006 T3.1,
// `docs/architecture/schemas/local-sqlite-schema.md`.

export const RUN_LIFECYCLE_TERMINAL_BACKSTOP_MIGRATION_SQL: string = `
-- Owner: Plan-006 | Migration: 0006-run-lifecycle-terminal-backstop-index.ts (Tier 4 Phase 3)

-- At most ONE terminal event per (runId, runVersion). PARTIAL so only terminal
-- run_lifecycle rows are indexed; keyed on json_extract because run identity
-- lives in the JSON payload, not in a column.
CREATE UNIQUE INDEX idx_session_events_run_terminal_once ON session_events(json_extract(payload, '$.runId'), json_extract(payload, '$.runVersion')) WHERE category = 'run_lifecycle' AND type IN ('run.completed', 'run.failed', 'run.interrupted');

-- Closes the NULL-distinctness hole in the index above AND pins the storage
-- class of both key members, so uniqueness is over the run and not over its
-- JSON spelling.
CREATE TRIGGER trg_run_terminal_key_insert BEFORE INSERT ON session_events
WHEN NEW.category = 'run_lifecycle'
  AND NEW.type IN ('run.completed', 'run.failed', 'run.interrupted')
  AND (json_extract(NEW.payload, '$.runId') IS NULL OR json_type(NEW.payload, '$.runId') <> 'text' OR json_extract(NEW.payload, '$.runVersion') IS NULL OR json_type(NEW.payload, '$.runVersion') <> 'integer')
BEGIN
  SELECT RAISE(ABORT, 'terminal run_lifecycle requires text runId + integer runVersion (non-null, correct storage class)');
END;

-- Keeps a committed terminal row's identity STABLE: the key cannot be rewritten
-- to another run, and the row cannot be de-scoped out of the partial index's
-- predicate. IS NOT (not <>) so a NULL operand yields a decidable answer.
CREATE TRIGGER trg_run_terminal_key_update BEFORE UPDATE OF payload, category, type ON session_events
WHEN OLD.category = 'run_lifecycle'
  AND OLD.type IN ('run.completed', 'run.failed', 'run.interrupted')
  AND (json_extract(NEW.payload, '$.runId') IS NULL OR json_type(NEW.payload, '$.runId') <> 'text' OR json_extract(NEW.payload, '$.runVersion') IS NULL OR json_type(NEW.payload, '$.runVersion') <> 'integer' OR json_extract(NEW.payload, '$.runId') IS NOT json_extract(OLD.payload, '$.runId') OR json_extract(NEW.payload, '$.runVersion') IS NOT json_extract(OLD.payload, '$.runVersion') OR NEW.category IS NOT OLD.category OR NEW.type IS NOT OLD.type)
BEGIN
  SELECT RAISE(ABORT, 'terminal run_lifecycle stub must preserve runId + runVersion (value + storage class) + category + type');
END;

-- Mirror of the update guard: a non-terminal row cannot be UPDATEd INTO the
-- index's predicate. Terminal rows are INSERT-only.
CREATE TRIGGER trg_run_terminal_key_promote BEFORE UPDATE OF category, type ON session_events
WHEN NOT (OLD.category = 'run_lifecycle' AND OLD.type IN ('run.completed', 'run.failed', 'run.interrupted'))
  AND NEW.category = 'run_lifecycle'
  AND NEW.type IN ('run.completed', 'run.failed', 'run.interrupted')
BEGIN
  SELECT RAISE(ABORT, 'session_events rows cannot be promoted to terminal run_lifecycle by UPDATE — terminal rows are INSERT-only');
END;

INSERT INTO schema_version (version, applied_at, description)
VALUES (6, datetime('now'), 'Run-lifecycle terminal-key backstop (partial unique index + trigger trio)');
`;
