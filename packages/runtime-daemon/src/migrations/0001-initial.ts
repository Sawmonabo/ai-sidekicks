// PR #3 — initial Local Runtime Daemon schema (inlined SQL).
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file. Why:
//
//   1. The build pipeline (`tsc -b`) does NOT copy non-TS assets into
//      `dist/`. Any FS-relative load path (`new URL(..., import.meta.url)`)
//      would resolve correctly under `vitest` (running against `src/`) but
//      throw `ENOENT` at first dist-from-import use.
//   2. `package.json` `"files": ["dist"]` would exclude `src/migrations/`
//      from the published tarball anyway, so a published consumer would
//      never see the SQL file even if a build-time copy step ran.
//   3. Bundlers (esbuild / webpack / Bun) handle `import.meta.url`
//      inconsistently; inline strings survive every transform stage.
//
// The canonical schema source-of-truth is — when extending this migration
// (or adding 0002+), copy the per-table block from that file verbatim
// (including `-- Owner:` and per-column comments) so the inline constant
// stays in lockstep with the canonical doc.
//
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
//
// Owns the physical CREATE for three tables (faithful subset of):
//
//   * session_events — append-only event log (core columns;
//                            integrity-protocol columns forward-declared,
//                            semantics)
//   * session_snapshots — projection cache (owner)
//   * user_keys     — per-user key custody (forward-declared,
//                            semantics + crypto-shred lifecycle)
//
// Plus the schema_version anchor consumed by the migration runner.
//
//   * session_events.monotonic_ns / prev_hash / row_hash /
//     daemon_signature. Placeholders are written here so the NOT NULL
//     constraints are satisfiable: monotonic_ns receives real values
//     (process.hrtime.bigint()), the three required BLOBs receive
//     zero-fill bytes (32B / 32B / 64B).
//   * session_events.pii_payload — owns PII custody. writes NULL for every
//     event; no V1 SessionEvent variant carries PII.
//   * user_keys (entire table) — owns wrapping + DELETE-
//     as-crypto-shred lifecycle. only CREATEs the empty table so
//     downstream plans need not ALTER its shape.
//
// Why no DEFAULT clauses on the integrity columns: the schema doc is
// explicit ("zero-filled at sequence=0" describes a write-time invariant,
// not a DDL default). Shipping `DEFAULT zeroblob(32)` here would silently
// mask future programming errors where the writer forgot to populate the
// chain — defects we want to catch loudly. The application writer
// (SessionService — append guarded test-only precondition; the
// EventLogService succeeds it as the durable writer with real integrity
// bytes) is responsible for materializing the placeholder bytes
// per-event.
//
// Why CHECK(length(...)) on the integrity BLOBs: the schema doc names
// exact byte widths (32/32/64). Adding a length CHECK at INSERT time
// surfaces wrong-size placeholder bugs instead of deferring failure to
// the hash-chain verification step.

export const INITIAL_MIGRATION_SQL: string = `
CREATE TABLE session_events (
  id                     TEXT PRIMARY KEY,           -- ULID or UUID
  session_id             TEXT NOT NULL,
  sequence               INTEGER NOT NULL,           -- monotonic per session
  occurred_at            TEXT NOT NULL,              -- RFC 3339 UTC with ms precision (wall-clock; display + audit)
  monotonic_ns           INTEGER NOT NULL,           -- process.hrtime.bigint() at emit; within-daemon ordering only
  category               TEXT NOT NULL,              -- e.g. 'run_lifecycle', 'assistant_output', 'tool_activity'
  type                   TEXT NOT NULL,              -- specific event type within category
  actor                  TEXT,                       -- user_id or agent_id or NULL for system
  payload                TEXT NOT NULL DEFAULT '{}', -- JSON event payload
  pii_payload            BLOB,                       -- encrypted per-user AES-256-GCM (GDPR); NOT hashed/signed
  correlation_id         TEXT,                       -- links related events
  causation_id           TEXT,                       -- parent event that caused this one
  version                TEXT NOT NULL DEFAULT '1.0'
                         CHECK (version GLOB '[0-9]*.[0-9]*'), -- weak DDL-level smoke check: rejects pure NULL/empty and obvious
                                                               -- non-numeric strings, but SQLite GLOB
                                                               -- asterisk matches any character
                                                               -- sequence, so this CHECK accepts e.g.
                                                               -- The canonical "MAJOR.MINOR" semver
                                                               -- shape which is the real validation
                                                               -- seam. Stored as TEXT (never INTEGER)
                                                               -- because comparison must parse
                                                               -- MAJOR/MINOR as ints — lexical TEXT
                                                               -- comparison is unsafe (e.g.
  -- Integrity protocol: hash-chain + per-event daemon signature
  prev_hash              BLOB NOT NULL,              -- 32 bytes; row_hash of previous row (zero-filled at sequence=0)
  row_hash               BLOB NOT NULL,              -- 32 bytes; BLAKE3(prev_hash || JCS-canonical envelope bytes)
  daemon_signature       BLOB NOT NULL,              -- 64 bytes; Ed25519 over same canonical bytes
  UNIQUE(session_id, sequence),
  -- Length CHECKs on the integrity BLOBs: surface wrong-size placeholder bugs at
  -- INSERT time instead of deferring to the hash-chain verification step. The
  -- widths (32/32/64) are normative per Security Architecture.
  CHECK(length(prev_hash) = 32),
  CHECK(length(row_hash) = 32),
  CHECK(length(daemon_signature) = 64)
);

CREATE INDEX idx_session_events_session_seq ON session_events(session_id, sequence);
CREATE INDEX idx_session_events_type ON session_events(session_id, type);
CREATE INDEX idx_session_events_correlation ON session_events(correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TABLE session_snapshots (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  as_of_sequence  INTEGER NOT NULL,           -- snapshot reflects events up to this sequence
  state_blob      BLOB NOT NULL,              -- serialized session state
  created_at      TEXT NOT NULL,
  FOREIGN KEY (session_id, as_of_sequence) REFERENCES session_events(session_id, sequence)
);

CREATE INDEX idx_session_snapshots_session ON session_snapshots(session_id, as_of_sequence);

CREATE TABLE user_keys (
  user_id    TEXT NOT NULL PRIMARY KEY,
  encrypted_key_blob BLOB NOT NULL,           -- AES-256-GCM key, encrypted at rest
  key_version       INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  rotated_at        TEXT
);

-- Schema version anchor consumed by migration-runner.ts
CREATE TABLE schema_version (
  version         INTEGER NOT NULL PRIMARY KEY,
  applied_at      TEXT NOT NULL,
  description     TEXT
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (1, datetime('now'), 'Initial schema');
`;
