// Plan-005 T5.1 — version-17 migration: the MCP Tasks durable recovery handle
// on Plan-004's `command_receipts` substrate.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file, for the reasons the `0001-initial.ts` header sets out in
// full (tsc -b does not copy non-TS assets into `dist/`; `"files": ["dist"]`
// would exclude `src/migrations/` from the published tarball; bundlers handle
// `import.meta.url` inconsistently).
//
// PROVENANCE. The column below is transcribed from the canonical
// `command_receipts` block in `docs/architecture/schemas/local-sqlite-schema.md`
// — the same convention `0007-pii-participant-id.ts` states, and the same
// direction of authority: the schema doc defines the column, this file applies
// it. Change the doc first, then mirror it here. The doc block is a FOUR-plan
// composite (Plan-004 CREATEs the shell; Plan-015, Plan-005, and Plan-028 each
// EXTEND from their own migration), so the block's column ORDER is the shape the
// last extender leaves behind and not a shape any single incremental migration
// can reproduce. `ALTER TABLE ... ADD COLUMN` appends, so this column lands
// after `created_at` rather than between `completed_at` and `mcp_binding_digest`.
// Physical ordinal is not part of the contract — every reader names columns.
//
// ----------------------------------------------------------------------------
// Why ADD COLUMN carries this CHECK, and Plan-015's does not
// ----------------------------------------------------------------------------
//
// SQLite's ADD COLUMN accepts a COLUMN-level CHECK. The documented restrictions
// (sqlite.org/lang_altertable.html#altertabaddcol) bar — among others — a column
// that is NOT NULL without a default, a PRIMARY KEY / UNIQUE, one carrying a
// REFERENCES clause while foreign keys are enabled, or one whose default
// expression is non-constant. This column is none of those, and the list above
// is the subset that could plausibly bite here, not the whole of the upstream
// rule; the anchor is the authority. The constraint below references only
// `mcp_task_id` and admits NULL, so every pre-migration row satisfies it as the
// column is appended, and no table rebuild is required. This is exactly the
// shape `0009-retention-class-and-stub-signature.ts` already ships for
// `session_events.retention_class`, and exactly the distinction
// `local-sqlite-schema.md` draws: a single-column NULL-permitting CHECK is
// ALTER-ADD-COLUMN-addable, while a TABLE-level (multi-column) CHECK requires
// the 12-step rebuild of sqlite.org/lang_altertable.html#otheralter.
//
// The rebuild cost on this table belongs to Plan-015, and belongs to it for a
// different reason: its `idempotency_class` is NOT NULL with no default, which
// ADD COLUMN genuinely cannot express. Paying that cost here would be worse than
// redundant — a rebuild DROPs and re-CREATEs a SHIPPED table, so it would have
// to hand-carry `idx_command_receipts_run` and would silently discard any column
// a sibling extender landed first. An append discards nothing.
//
// ----------------------------------------------------------------------------
// Why the bound is duplicated at the write seam
// ----------------------------------------------------------------------------
//
// The `taskId` is receiver-generated: untrusted remote-peer output, reaching the
// daemon inside an MCP `CreateTaskResult`. It is bounded HERE so no code path
// can store an unbounded or NUL-bearing handle whatever it believes, and bounded
// AGAIN at the write seam (`provider/mcp-task-handle-recorder.ts`) so a
// violation is refused with a named diagnostic rather than surfacing as an
// opaque SQLITE_CONSTRAINT from a driver stack frame. That is the T2.1
// defense-in-depth convention the `runtime_bindings` provider-declared strings
// already follow; the two bounds are the same 256 literal by construction, the
// recorder exporting the constant this DDL states.
//
// NULL is the meaningful zero state and not an absence of information: the
// column is NULL until the receiver's acceptance response is durably stored, so
// a crash before that point leaves NULL and the call stays on the
// `manual_reconcile_only` halt (I-005-3). Spec-015 recovery reads a non-NULL
// handle and polls `tasks/get` + `tasks/result` instead of halting.
//
// Idempotency + concurrency are the migration runner's job (the guarded
// `hasMigrationApplied(db, 17)` block with its in-transaction re-check and
// `.immediate()` dispatch); this constant is a plain DDL script. SQLite has no
// `ADD COLUMN IF NOT EXISTS`, so a re-exec would throw "duplicate column name"
// — the runner guard is what makes re-application a no-op, and the version-17
// anchor row committing in the SAME transaction as the ALTER is what keeps the
// guard and the physical schema from ever disagreeing.
//
// Ordinal 17 rather than 16: version ordinals are allocated at branch time, and
// 16 is held by a peer branch (the provider-account registry). A gap in the
// applied-version sequence is expected and carries no meaning — the runner
// dispatches on per-version guards, never on contiguity.
//
// Spec coverage: `Spec-005 §Tool Metadata` (the task-augmented call),
// `Spec-015 §Idempotency Classes and Recovery Behavior` (the handle's reader). Refs: Plan-005 T5.1, T3.13,
// invariant I-005-3, `cross-plan-dependencies.md` §1 `command_receipts` row.

export const COMMAND_RECEIPT_MCP_TASK_HANDLE_MIGRATION_SQL: string = `
-- Owner: Plan-005 | Migration: 0017-command-receipt-mcp-task-handle.ts (Tier 4 Phase 5)

-- Receiver-generated MCP Tasks taskId for a task-augmented MCP call, taken from
-- the CreateTaskResult acceptance response. NULL until the receiver accepts: a
-- crash before the acceptance is durably stored leaves NULL and the call stays on
-- the manual_reconcile_only halt. Recovery reads a non-NULL handle and polls
-- tasks/get + tasks/result instead of halting.
--
-- Bounded at the database because the value is untrusted remote-peer output. The
-- CHECK is column-level, references only this column, and admits NULL, so ADD
-- COLUMN carries it and every pre-migration row passes as it is appended
-- (sqlite.org/lang_altertable.html#altertabaddcol). The write seam mirrors the
-- same 256 literal so a violation is refused with a named diagnostic instead of
-- reaching the database as an opaque constraint failure.
ALTER TABLE command_receipts ADD COLUMN mcp_task_id TEXT
  CHECK (mcp_task_id IS NULL OR (length(mcp_task_id) > 0 AND length(mcp_task_id) <= 256 AND instr(mcp_task_id, char(0)) = 0));

INSERT INTO schema_version (version, applied_at, description)
VALUES (17, datetime('now'), 'MCP Tasks durable recovery handle (command_receipts.mcp_task_id)');
`;
