// Plan-006 T3.2 — version-9 migration: the compaction retention discriminator
// and the post-compaction stub commitment.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file, for the reasons the `0001-initial.ts` header sets out in
// full (tsc -b does not copy non-TS assets into `dist/`; `"files": ["dist"]`
// would exclude `src/migrations/` from the published tarball; bundlers handle
// `import.meta.url` inconsistently).
//
// PROVENANCE. Every statement below is transcribed from the canonical
// `session_events` block in `docs/architecture/schemas/local-sqlite-schema.md`
// — the same convention `0006-run-lifecycle-terminal-backstop-index.ts` and
// `0007-pii-participant-id.ts` state, and the same direction of authority: the
// schema doc defines the columns and the index, this file applies them. Change
// the doc first, then mirror it here.
//
// ----------------------------------------------------------------------------
// Why a TYPED COLUMN rather than a JSON probe into the stub (Design B)
// ----------------------------------------------------------------------------
//
// A compacted row is discriminated from a live one on EVERY read that matters:
// the compactor's own re-entry selector (`retention_class IS NULL`, the
// property that makes a mid-pass crash resumable), the T4.1 verifier's
// per-row branch (live rows take chain recomputation, stubs take the
// three post-compaction checks of `Spec-006 §Post-Compaction Integrity`), and
// replay's live/stub rendering split. Design A would have read the
// discriminator back out of the stored projection with
// `json_extract(payload, '$.retentionClass')`. That loses on all three counts:
// it is unindexable in the partial-index sense used below, it costs a JSON
// parse per row on the hottest read in the daemon, and — decisively — it puts
// the discriminator INSIDE the bytes `stub_signature` covers, so the value that
// decides WHICH verification path runs is only trustworthy after that path has
// already run. A column is outside the signed bytes, which is exactly the
// property the verifier needs to branch on it.
//
// The column-level CHECK closes the discriminator's domain to the two states
// the corpus names: NULL (live) and 'audit_stub' (compacted). It is
// ALTER-ADD-COLUMN-addable because it references only the new column and
// permits NULL, so every pre-migration row satisfies it unchanged (SQLite does
// not re-validate existing rows on ADD COLUMN, and here it would not need to).
//
// WHAT THIS MIGRATION DELIBERATELY DOES NOT ENFORCE. The co-presence invariant
// — `retention_class = 'audit_stub'` ⟺ non-NULL `stub_signature` — is a
// TWO-column constraint. SQLite has no `ALTER TABLE ... ADD CHECK`, and a
// table-level CHECK would require the 12-step rebuild of the append-only audit
// log (sqlite.org/lang_altertable.html), which is exactly the operation an
// append-only hash chain must never undergo. It is enforced at the verification
// layer instead: T4.1 reports `stub_signature_invalid` on an `audit_stub` row
// whose `stub_signature` is NULL, per `Spec-006 §Post-Compaction Integrity`
// ("the signature is REQUIRED on every compacted row; its absence is a
// verification failure, never a skip").
//
// ----------------------------------------------------------------------------
// Why `stub_signature` is a SEPARATE commitment from `daemon_signature`
// ----------------------------------------------------------------------------
//
// `row_hash` and `daemon_signature` commit to the canonical bytes of the
// PRE-compaction envelope. Compaction discards those bytes, so neither can be
// recomputed afterwards — and I-006-3-03 freezes both precisely so the
// commitment to the original survives. That leaves the bytes a reader actually
// SEES after compaction (the stub projection now sitting in `payload`)
// unauthenticated, which is the P1 finding the 2026-05-28 `stub_signature`
// amendment closed. This column holds the Ed25519 signature over the exact
// canonical byte string the compactor stored in `payload`, so a verifier
// authenticates the visible stub directly over the stored bytes with no JCS
// round-trip — catching any byte-level edit, not only semantic ones.
//
// ----------------------------------------------------------------------------
// The live-row partial index
// ----------------------------------------------------------------------------
//
// `idx_session_events_live` is canonical in the schema doc and could not be
// created by any earlier migration: its predicate references `retention_class`,
// which this migration is the first to add. It keeps hot-path replay and the
// compactor's own candidate scan off the compacted suffix, which grows without
// bound (stubs are retained indefinitely per `Spec-006 §Event Compaction Policy`
// §Retention Windows) while the live set stays bounded by the very thresholds
// the compactor enforces. Without it every live-row scan degrades linearly in
// total retained history rather than in live history.
//
// Idempotency + concurrency are the migration runner's job (the guarded
// `hasMigrationApplied(db, 9)` block with its in-transaction re-check and
// `.immediate()` dispatch); this constant is a plain DDL script. SQLite has no
// `ADD COLUMN IF NOT EXISTS`, so a re-exec would throw "duplicate column name"
// — the runner guard is what makes re-application a no-op, and the version-9
// anchor row committing in the SAME transaction as the two ALTERs and the
// CREATE INDEX is what keeps the guard and the physical schema from ever
// disagreeing. Atomicity is load-bearing for the same reason it is at versions
// 6 and 8: a torn apply that landed the columns without the index would leave
// every live-row scan reading the full retained history, silently.
//
// Adding columns changes no committed row's canonical bytes — the canonical
// serialization covers the eleven-member envelope and never the physical column
// set — so the append-only hash chain is untouched.
//
// Spec coverage: `Spec-006 §Post-Compaction Integrity` (the per-row stub
// commitment and the anchor-before-compaction protocol these columns record the
// outcome of), `Spec-006 §Compacted Event Format` (the projection
// `stub_signature` signs). Refs: Plan-006 T3.2, `Plan-006 §Data And Storage Changes`,
// invariant I-006-3-03, `events/compactor.ts`.

export const RETENTION_CLASS_AND_STUB_SIGNATURE_MIGRATION_SQL: string = `
-- Owner: Plan-006 | Migration: 0009-retention-class-and-stub-signature.ts (Tier 4 Phase 3)

-- The typed retention discriminator. NULL = live row (per-row chain-verified);
-- 'audit_stub' = compacted (anchor + stub_signature verified). Column-level
-- CHECK closes the domain; deliberately NULL-permitting so every pre-migration
-- row passes unchanged.
ALTER TABLE session_events ADD COLUMN retention_class TEXT
  CHECK (retention_class IS NULL OR retention_class = 'audit_stub');

-- 64 bytes; Ed25519 over the exact canonical byte string stored in payload (the
-- audit-stub projection). NULL for live rows. The at-rest proof that the
-- visible stub is the daemon's genuine compaction output -- frozen row_hash and
-- daemon_signature commit only to the now-discarded pre-compaction bytes.
ALTER TABLE session_events ADD COLUMN stub_signature BLOB;

-- Hot-path replay keeps live rows fast; the partial index excludes compacted
-- stubs. Creatable only now: its predicate references the column added above.
CREATE INDEX idx_session_events_live ON session_events(session_id, sequence)
  WHERE retention_class IS NULL;

INSERT INTO schema_version (version, applied_at, description)
VALUES (9, datetime('now'), 'Compaction retention discriminator + post-compaction stub commitment (session_events.retention_class, session_events.stub_signature, idx_session_events_live)');
`;
