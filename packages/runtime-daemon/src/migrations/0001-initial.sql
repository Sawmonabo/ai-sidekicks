-- Plan-001 PR #3 — initial Local Runtime Daemon schema.
--
-- This migration is a faithful subset of the canonical Local SQLite schema
-- (docs/architecture/schemas/local-sqlite-schema.md). Plan-001 owns the
-- physical CREATE for three tables:
--
--   * session_events       — append-only event log (Plan-001 core columns;
--                            integrity-protocol columns forward-declared,
--                            semantics owned by Plan-006)
--   * session_snapshots    — projection cache (Plan-001 owner)
--   * participant_keys     — per-participant key custody (forward-declared,
--                            semantics + crypto-shred lifecycle owned by
--                            Plan-022)
--
-- Plus the schema_version anchor consumed by the migration runner.
--
-- Forward-declared columns (per Plan-001 §Cross-Plan Forward-Declared Schema):
--   * session_events.monotonic_ns / prev_hash / row_hash /
--     daemon_signature / participant_signature  — Plan-006 owns hash-chain +
--     signature semantics. Plan-001 writes placeholders so the NOT NULL
--     constraints are satisfiable: monotonic_ns receives real values
--     (process.hrtime.bigint()), the three required BLOBs receive
--     zero-fill bytes (32B / 32B / 64B). participant_signature is NULL.
--   * session_events.pii_payload — Plan-022 owns PII custody. Plan-001
--     writes NULL for every event; no V1 SessionEvent variant carries PII.
--   * participant_keys (entire table) — Plan-022 owns wrapping + DELETE-
--     as-crypto-shred lifecycle. Plan-001 only CREATEs the empty table so
--     downstream plans need not ALTER its shape.
--
-- Why no DEFAULT clauses on the integrity columns: the schema doc is
-- explicit ("zero-filled at sequence=0" describes a write-time invariant,
-- not a DDL default). Shipping `DEFAULT zeroblob(32)` here would silently
-- mask future programming errors where the writer forgot to populate the
-- chain — defects we want to catch loudly. The application writer
-- (SessionService) is responsible for materializing the placeholder bytes
-- per-event.

CREATE TABLE session_events (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL,
  sequence               INTEGER NOT NULL,
  occurred_at            TEXT NOT NULL,
  monotonic_ns           INTEGER NOT NULL,
  category               TEXT NOT NULL,
  type                   TEXT NOT NULL,
  actor                  TEXT,
  payload                TEXT NOT NULL DEFAULT '{}',
  pii_payload            BLOB,
  correlation_id         TEXT,
  causation_id           TEXT,
  version                TEXT NOT NULL DEFAULT '1.0'
                         CHECK (version GLOB '[0-9]*.[0-9]*'),
  prev_hash              BLOB NOT NULL,
  row_hash               BLOB NOT NULL,
  daemon_signature       BLOB NOT NULL,
  participant_signature  BLOB,
  UNIQUE(session_id, sequence)
);

CREATE INDEX idx_session_events_session_seq ON session_events(session_id, sequence);
CREATE INDEX idx_session_events_type ON session_events(session_id, type);
CREATE INDEX idx_session_events_correlation ON session_events(correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TABLE session_snapshots (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  as_of_sequence  INTEGER NOT NULL,
  state_blob      BLOB NOT NULL,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (session_id, as_of_sequence) REFERENCES session_events(session_id, sequence)
);

CREATE INDEX idx_session_snapshots_session ON session_snapshots(session_id, as_of_sequence);

CREATE TABLE participant_keys (
  participant_id     TEXT NOT NULL PRIMARY KEY,
  encrypted_key_blob BLOB NOT NULL,
  key_version        INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  rotated_at         TEXT
);

CREATE TABLE schema_version (
  version         INTEGER NOT NULL PRIMARY KEY,
  applied_at      TEXT NOT NULL,
  description     TEXT
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (1, datetime('now'), 'Initial schema');
