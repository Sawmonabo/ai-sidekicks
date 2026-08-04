// Plan-006 T3.3 — version-8 migration: the durable Merkle-anchor upload queue.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file, for the reasons the `0001-initial.ts` header sets out in
// full (tsc -b does not copy non-TS assets into `dist/`; `"files": ["dist"]`
// would exclude `src/migrations/` from the published tarball; bundlers handle
// `import.meta.url` inconsistently).
//
// PROVENANCE. The DDL below is transcribed VERBATIM from the
// `pending_anchor_uploads` block in
// `docs/architecture/schemas/local-sqlite-schema.md` — including the
// `-- Owner: Plan-006` stamp, every per-column comment, and the two-line
// coverage-vs-exact-match rationale on the UNIQUE key — the same convention
// `0007-pii-participant-id.ts` and `0005-daemon-signing-keys.ts` state, and the
// same direction of authority: the schema doc defines the table, this file
// applies it. Change the doc first, then mirror it here. The one resolved
// token is the migration filename in the Owner stamp: the doc carries the
// `0NNN-` placeholder for a not-yet-assigned migration (the `0005` stamp shows
// the concrete spelling once assigned), and this file is the assignment.
//
// ----------------------------------------------------------------------------
// Why a durable table and not an in-memory retry queue
// ----------------------------------------------------------------------------
//
// An anchor is a SIGNED commitment. Once `MerkleAnchorService` computes a
// Merkle root over a range and signs it with the daemon's Ed25519 key, that
// signature is the artifact an auditor will check years later — and Ed25519 is
// deterministic (RFC 8032 §5.1.6), so re-signing the same root reproduces the
// same 64 bytes. The value of persisting is therefore NOT that re-signing
// would produce something different; it is that the daemon must not FORGET
// which ranges it has already committed to. Plan-006 §Merkle Anchor Emission
// makes this the partition-tolerance contract: anchors queue locally on upload
// failure and flush on reconnect, without re-signing.
//
// A process-memory queue loses that on restart. The daemon would then either
// (a) skip the range entirely — leaving a gap no covering anchor witnesses,
// which is precisely the hole `Spec-006 §Post-Compaction Integrity` step 1
// exists to prevent before a compactor discards the underlying bytes — or
// (b) re-anchor blindly on a fresh cadence window with different bounds,
// producing overlapping anchors that an auditor cannot reconcile against the
// compaction ranges. Durability is what makes "anchored" a fact about the
// system rather than a fact about the current process.
//
// This is also why `Spec-006 §Post-Compaction Integrity` step 3 pins that
// landing a row HERE — not a successful control-plane upload — is what
// satisfies the anchor-before-compaction precondition. The control plane is a
// witness, not the system of record; requiring it to be reachable would make
// compaction fail during a partition, and a daemon that cannot compact during
// a partition eventually cannot append.
//
// ----------------------------------------------------------------------------
// The UNIQUE key: (session_id, node_id, start_sequence, end_sequence)
// ----------------------------------------------------------------------------
//
// `end_sequence` is IN the key, and that is a deliberate design choice with a
// concrete failure mode behind it. Two anchors legitimately share a
// `start_sequence`: a cadence anchor over [1,1000] and a wider
// compaction-covering anchor over [1,5000] both start at 1, and BOTH must
// exist — the first is the routine 1000-event witness, the second is the
// force-fire that a compactor requires before discarding [1,5000]. A key of
// `(session_id, node_id, start_sequence)` would collapse them, silently
// discarding whichever landed second and leaving a compaction range unwitnessed.
//
// Consequently the key dedups exactly one thing: a genuine re-fire of an
// IDENTICAL range. That is what makes `anchorRange()` idempotent
// (`IdempotencyClass: idempotent` on the T3.3 plan row) under re-entry —
// a retried compaction re-derives the same bounds, hits the key, and the
// service returns the already-queued row instead of enqueueing a duplicate.
//
// "A covering anchor exists" is a separate question and a DIFFERENT query: a
// COVERAGE test (`start_sequence <= range_start AND end_sequence >= range_end`)
// per `Spec-006 §Post-Compaction Integrity`, never an exact-start match. The
// [1,5000] anchor covers a compaction of [2000,3000]; an exact-match probe
// would miss it and force a redundant re-anchor.
//
// ----------------------------------------------------------------------------
// Node-scope (sentinel-partitioned) rows
// ----------------------------------------------------------------------------
//
// Daemon-scope chains — those on the `DAEMON_SCOPE_SENTINEL_SESSION_ID` Max
// UUID partition (`@ai-sidekicks/contracts` `event.ts`) — queue their anchors
// here too, as the durable LOCAL witness. In V1 they are NOT upload candidates:
// `event_log_anchors.session_id` carries a non-null FK to `sessions(id)` that
// the sentinel cannot satisfy, and control-plane node-scope witnessing needs a
// node-identity trust anchor that ADR-017 §Node-Scope Anchor Witnessing defers
// to V1.1. Their `uploaded_at` therefore stays NULL by design — the upload
// worker filters them out rather than failing on them, so "NULL uploaded_at"
// alone is not an operator-actionable backlog signal for these rows.
//
// Idempotency + concurrency are the migration runner's job (the guarded
// `hasMigrationApplied(db, 8)` block with its in-transaction re-check and
// `.immediate()` dispatch); this constant is a plain DDL script.
//
// Spec coverage: `Spec-006 §Post-Compaction Integrity` (the durable queue the
// force-fire path lands in). Refs: Plan-006 T3.3, Plan-006 §Merkle Anchor
// Emission, `docs/architecture/schemas/local-sqlite-schema.md`,
// `events/merkle-anchor-service.ts` (the sole writer).

export const PENDING_ANCHOR_UPLOADS_MIGRATION_SQL: string = `
-- Owner: Plan-006 | Migration: 0008-pending-anchor-uploads.ts (Tier 4 Phase 3)
-- Durable partition-tolerance queue for Merkle anchors awaiting control-plane upload. Unflushed
-- anchors survive daemon restart without re-signing per Plan-006 §Merkle Anchor Emission (its
-- partition-tolerance bullet: anchors queue locally on upload failure and flush on reconnect). The
-- (session_id, node_id, start_sequence, end_sequence) UNIQUE constraint makes the T3.3
-- anchorRange() force-fire path (consumed by T3.2 compactor's anchor-before-compaction protocol
-- per Spec-006 §Post-Compaction Integrity) idempotent against re-entry of an identical range (the
-- key dedups genuine re-fires only — coverage semantics in the constraint comment below).
-- Node-scope (sentinel session_id) chains queue their local Merkle anchors here too, as the durable
-- LOCAL witness. In V1 those sentinel-partitioned rows are NOT upload candidates -- the upload worker
-- selects session-scoped rows only (the sentinel cannot satisfy event_log_anchors' non-null session_id
-- FK, and node-scope control-plane witnessing is a V1.1 extension per ADR-017 §Node-Scope Anchor
-- Witnessing). Their uploaded_at stays NULL by design in V1.
CREATE TABLE pending_anchor_uploads (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  node_id             TEXT NOT NULL,
  start_sequence      INTEGER NOT NULL,
  end_sequence        INTEGER NOT NULL,
  merkle_root         BLOB NOT NULL,         -- BLAKE3 Merkle root over row_hash leaves (RFC 9162 §2.1.1 MTH: split at largest power of two, 0x00/0x01 domain separation)
  root_signature      BLOB NOT NULL,         -- Ed25519 signature over merkle_root by daemon_signing_keys.sealed_private_key
  anchored_at         TEXT NOT NULL,         -- daemon-local timestamp at anchor computation
  uploaded_at         TEXT,                  -- non-NULL once control-plane confirms upload to event_log_anchors
  -- Durable retry/backoff state (partition-anchor queue durability decision, resolved per Plan-006 §Open Authoring Decisions (Category 2 — Audit-Surfaced)): survives daemon
  -- restart so upload retry resumes and the last failure is queryable for operator triage post-restart.
  attempt_count       INTEGER NOT NULL DEFAULT 0, -- upload attempts since enqueue; drives exponential backoff
  last_attempt_at     TEXT,                  -- daemon-local timestamp of most recent upload attempt; NULL until first attempt
  last_error          TEXT,                  -- last upload failure detail (operator triage); NULL on success or before first attempt
  -- end_sequence is part of the key: a cadence anchor [1,1000] and a wider compaction-covering anchor [1,5000] share start_sequence=1 and MUST coexist.
  -- "Covering anchor exists" (Spec-006 §Post-Compaction Integrity step 1) is a COVERAGE query (start_sequence <= range_start AND end_sequence >= range_end), NOT an exact-start match; the key only dedups genuine re-fires of the identical range.
  UNIQUE (session_id, node_id, start_sequence, end_sequence)
);

CREATE INDEX idx_pending_anchor_uploads_pending
  ON pending_anchor_uploads(session_id, anchored_at)
  WHERE uploaded_at IS NULL;

INSERT INTO schema_version (version, applied_at, description)
VALUES (8, datetime('now'), 'Durable Merkle-anchor upload queue (pending_anchor_uploads)');
`;
