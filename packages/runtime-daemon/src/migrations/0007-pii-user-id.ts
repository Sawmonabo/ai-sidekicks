// Version-7 migration: the durable PII owner-stamp column.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file, for the reasons the `0001-initial.ts` header sets out in
// full (tsc -b does not copy non-TS assets into `dist/`; `"files": ["dist"]`
// would exclude `src/migrations/` from the published tarball; bundlers handle
// `import.meta.url` inconsistently).
//
// The DDL below is transcribed from the canonical `session_events` block — the
// same convention `0006-run-lifecycle-terminal-backstop-index.ts` states, and
// the same direction of authority: the schema doc defines the column, this
// file applies it. Change the doc first, then mirror it here.
//
// ("deliberately absent from the list above". It is not a carve-out from the
// schema doc, which the same section names as the canonical home for column
// definitions with no exception for this one.)
//
// ----------------------------------------------------------------------------
// Why a COLUMN when the same value already lives in the signed payload
// ----------------------------------------------------------------------------
//
// The codec embeds TWO members into `payload` on a PII write:
// `pii_ciphertext_digest` (which bytes the row holds) and
// `pii_user_id` (whose key sealed them — the owner stamp). Both are
// inside the canonical bytes, so both are covered by `row_hash` and
// `daemon_signature`: the payload copy is the SIGNED CLAIM.
//
// A signed claim, on its own, is unfalsifiable in the useless sense — it proves
// only that the daemon asserted it, and re-verifying the signature re-derives
// the same assertion. the read-side check (`isPiiOwnerStampBound`, consumed by
// the verifier as the `pii_owner_stamp_unbound` failure mode) needs a SECOND,
// INDEPENDENT copy to hold that claim to — a value written on a different
// substrate (a column, outside the hashed bytes) by the same transaction. When
// the two disagree, exactly one of them was tampered with after the fact, and
// the verifier can say so. With only the payload copy there is nothing to
// compare against and the check cannot exist. That is the entire reason this
// column is worth a migration.
//
// Deliberately NOT constrained beyond TEXT/nullable:
//
//   * No NOT NULL — most rows carry no PII at all, so NULL is the common case
//     and the correct one ("NULL on every row with no `pii_payload`").
//   * No CHECK tying it to `pii_payload`'s presence. The pairing is a WRITE-PATH
//     invariant that `EventLogService.append` enforces (it populates this column
//     from the SAME codec result that produced `pii_payload`, in the same
//     transaction), and the READ-side verifier re-checks against the signed
//     claim. A DDL CHECK would add a third, weaker enforcement of an invariant
//     already held at both ends — and, being unable to compare against the
//     payload copy, it could only restate half of it.
//   * No FOREIGN KEY to `user_keys`. Crypto-shred DELETEs the
//     user's key row precisely to make the ciphertext unrecoverable; an
//     FK would either block that DELETE or cascade it into the audit log,
//     shredding the very rows the audit trail must keep as tombstones. The
//     stamp must OUTLIVE the key it names.
//
// ADD COLUMN` is the whole migration: SQLite appends the column with NULL in
// every existing row, which is exactly the correct backfill (no pre-existing row
// carries PII — wrote `pii_payload = NULL` unconditionally). No table rewrite,
// so the append-only hash chain is untouched: adding a column changes no
// committed row's canonical bytes, since the canonical serialization covers the
// eleven-member envelope and never the physical column set.
//
// Idempotency + concurrency are the migration runner's job (the guarded
// `hasMigrationApplied(db, 7)` block with its in-transaction re-check and
// `.immediate()` dispatch); this constant is a plain DDL script. SQLite has no
// `ADD COLUMN IF NOT EXISTS`, so a re-exec would throw "duplicate column name"
// — the runner guard is what makes re-application a no-op, and the version-7
// anchor row committing in the SAME transaction as the ALTER is what keeps the
// guard and the physical schema from ever disagreeing.
//
// Invariant `PII_USER_ID_PAYLOAD_KEY` in `events/pii-indirection.ts`.

export const PII_USER_ID_MIGRATION_SQL: string = `

-- The durable PII owner stamp: byte-equal to the user id the codec
-- signs into payload under PII_USER_ID_PAYLOAD_KEY, written by the same
-- transaction. Nullable — NULL on every row with no pii_payload.
ALTER TABLE session_events ADD COLUMN pii_user_id TEXT;

INSERT INTO schema_version (version, applied_at, description)
VALUES (7, datetime('now'), 'PII owner-stamp column (session_events.pii_user_id)');
`;
