// Plan-006 T3.6 — version-13 migration: the durable encrypted home for
// machine-authored prose, and the wrapped home of the key that seals it.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file, for the reasons the `0001-initial.ts` header sets out in
// full (tsc -b does not copy non-TS assets into `dist/`; `"files": ["dist"]`
// would exclude `src/migrations/` from the published tarball; bundlers handle
// `import.meta.url` inconsistently).
//
// PROVENANCE. Both statements below are transcribed from the canonical
// `session_events` and `session_content_keys` blocks in
// `docs/architecture/schemas/local-sqlite-schema.md` — the same convention
// `0007-pii-participant-id.ts` states, and the same direction of authority: the
// schema doc defines the column and the table, this file applies them. Change
// the doc first, then mirror it here.
//
// ----------------------------------------------------------------------------
// Two additive things, and nothing else
// ----------------------------------------------------------------------------
//
// (1) `session_events.content_payload BLOB` — nullable, no `CHECK`, no
//     `NOT NULL`, no `FK`, so `ALTER TABLE ... ADD COLUMN` is the whole
//     statement and no 12-step table rebuild is required. SQLite appends the
//     column with NULL in every existing row, which is the correct backfill:
//     no pre-existing row carries machine-authored prose, because until this
//     migration there was nowhere to put it. No table rewrite, so the
//     append-only hash chain is untouched — adding a column changes no
//     committed row's canonical bytes, since the canonical serialization
//     covers the eleven-member envelope and never the physical column set.
//
// (2) `session_content_keys` — the wrapped home of the per-session content
//     DEK. Created rather than derived: a key derived from the daemon master
//     key would be destroyed by the rotate-on-shred that generates a fresh
//     master on any participant's erasure, and every existing body on the
//     daemon would become permanently unreadable the first time an unrelated
//     participant exercised erasure. A stored key is re-wrappable, so rotation
//     moves only its envelope.
//
// Deliberately NOT constrained beyond BLOB/nullable on the column:
//
//   * No NOT NULL — most rows carry no prose at all (every lifecycle,
//     membership, and telemetry row), so NULL is the common case.
//   * No CHECK tying it to the payload's `contentCiphertextDigest`. The pairing
//     is a WRITE-PATH invariant the sole sealing codec enforces (it populates
//     this column from the same result that produced the digest, in the same
//     transaction), re-checked on the READ side against the signed claim. A DDL
//     CHECK could only restate half of it, being unable to reach into `payload`.
//   * No FOREIGN KEY to `session_content_keys`. The key row is created lazily
//     on a session's first content-bearing append and dies with its session; an
//     FK would order those two lifetimes against each other for no gain, and
//     the read path already treats a missing key row as a typed, distinguished
//     unavailability rather than an error state.
//
// Idempotency + concurrency are the migration runner's job (the guarded
// `hasMigrationApplied(db, 13)` block with its in-transaction re-check and
// `.immediate()` dispatch); this constant is a plain DDL script. SQLite has no
// `ADD COLUMN IF NOT EXISTS`, so a re-exec would throw "duplicate column name"
// and the `CREATE TABLE` would throw "table already exists" — the runner guard
// is what makes re-application a no-op, and the version-13 anchor row
// committing in the SAME transaction as both statements is what keeps the guard
// and the physical schema from ever disagreeing.
//
// Spec coverage: `Spec-006 §Assistant Output (assistant_output)`,
// `Spec-006 §Tool Activity (tool_activity)`,
// `Spec-006 §Canonical Serialization Rules`, `Spec-022 §PII Data Map`. Refs:
// Plan-006 T3.6, invariants I-006-3-05, I-006-3-06, I-006-3-08,
// `CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY` in `@ai-sidekicks/contracts`, and
// `events/session-content-key-store.ts`, this table's sole reader and minter.

export const CONTENT_PAYLOAD_MIGRATION_SQL: string = `
-- Owner: Plan-006 | Migration: 0013-content-payload.ts (Tier 4 Phase 3B)

-- Machine-authored prose: the assistant message body, the reasoning-update
-- body, and tool-call arguments / result / error bodies. Sealed AES-256-GCM
-- under the SESSION-scoped content key, AAD = session_id || event_id, stored
-- iv || ciphertext || tag. Excluded from the canonical bytes exactly as
-- pii_payload is, with contentCiphertextDigest (BLAKE3 over the ciphertext)
-- embedded in the signed payload instead. Deliberately NO owner-stamp sibling
-- column: the sealing key is session-scoped and session_id is already a
-- canonical signed member. NULL by construction on every audit_integrity and
-- event_maintenance row, and cleared at compaction alongside pii_payload.
ALTER TABLE session_events ADD COLUMN content_payload BLOB;

-- The wrapped home of the key that seals every content_payload in one session
-- — deliberately a mirror of participant_keys rather than a new custody idea,
-- so the machinery that already re-wraps that table covers this one. Keyed by
-- session, because the body is session work product co-owned by every member
-- and has no participant to key on. The row is created lazily on the session's
-- first content-bearing append, so a session that never runs an agent stores
-- no key.
CREATE TABLE session_content_keys (
  session_id         TEXT NOT NULL PRIMARY KEY,
  encrypted_key_blob BLOB NOT NULL,
  key_version        INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  rotated_at         TEXT
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (13, datetime('now'), 'Machine-authored content column + wrapped session content keys (session_events.content_payload, session_content_keys)');
`;
