// Plan-001 PR #3 — initial Local Runtime Daemon schema (inlined SQL).
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
// The canonical schema source-of-truth is
// `docs/architecture/schemas/local-sqlite-schema.md` — when extending this
// migration (or adding 0002+), copy the per-table block from that file
// verbatim (including `-- Owner:` and per-column comments) so the inline
// constant stays in lockstep with the canonical doc.
//
// ----------------------------------------------------------------------------
// Plan-001 scope (this migration)
// ----------------------------------------------------------------------------
//
// Plan-001 owns the physical CREATE for three tables (faithful subset of
// docs/architecture/schemas/local-sqlite-schema.md):
//
//   * session_events       — append-only event log (Plan-001 core columns;
//                            integrity-protocol columns forward-declared,
//                            semantics owned by Plan-006)
//   * session_snapshots    — projection cache (Plan-001 owner)
//   * participant_keys     — per-participant key custody (forward-declared,
//                            semantics + crypto-shred lifecycle owned by
//                            Plan-022)
//
// Plus the schema_version anchor consumed by the migration runner.
//
// Forward-declared columns (per Plan-001 §Cross-Plan Forward-Declared Schema):
//   * session_events.monotonic_ns / prev_hash / row_hash /
//     daemon_signature / participant_signature  — Plan-006 owns hash-chain +
//     signature semantics. Plan-001 writes placeholders so the NOT NULL
//     constraints are satisfiable: monotonic_ns receives real values
//     (process.hrtime.bigint()), the three required BLOBs receive
//     zero-fill bytes (32B / 32B / 64B). participant_signature is NULL.
//   * session_events.pii_payload — Plan-022 owns PII custody. Plan-001
//     writes NULL for every event; no V1 SessionEvent variant carries PII.
//   * participant_keys (entire table) — Plan-022 owns wrapping + DELETE-
//     as-crypto-shred lifecycle. Plan-001 only CREATEs the empty table so
//     downstream plans need not ALTER its shape.
//
// Why no DEFAULT clauses on the integrity columns: the schema doc is
// explicit ("zero-filled at sequence=0" describes a write-time invariant,
// not a DDL default). Shipping `DEFAULT zeroblob(32)` here would silently
// mask future programming errors where the writer forgot to populate the
// chain — defects we want to catch loudly. The application writer
// (SessionService) is responsible for materializing the placeholder bytes
// per-event.
//
// Why CHECK(length(...)) on the integrity BLOBs: the schema doc names
// exact byte widths (32/32/64). Adding a length CHECK at INSERT time
// surfaces wrong-size placeholder bugs in Plan-001 instead of deferring
// failure to Plan-006's hash-chain verification step.

export const INITIAL_MIGRATION_SQL: string = `
-- Owner: Plan-001 | Extended by: Plan-006 (event taxonomy + integrity protocol), Plan-015 (replay cursors)
CREATE TABLE session_events (
  id                     TEXT PRIMARY KEY,           -- ULID or UUID
  session_id             TEXT NOT NULL,
  sequence               INTEGER NOT NULL,           -- monotonic per session
  occurred_at            TEXT NOT NULL,              -- RFC 3339 UTC with ms precision (wall-clock; display + audit)
  monotonic_ns           INTEGER NOT NULL,           -- process.hrtime.bigint() at emit; within-daemon ordering only (see Spec-015 §Clock Handling, BL-062)
  category               TEXT NOT NULL,              -- e.g. 'run_lifecycle', 'assistant_output', 'tool_activity'
  type                   TEXT NOT NULL,              -- specific event type within category
  actor                  TEXT,                       -- participant_id or agent_id or NULL for system
  payload                TEXT NOT NULL DEFAULT '{}', -- JSON event payload
  pii_payload            BLOB,                       -- encrypted per-participant AES-256-GCM (GDPR); NOT hashed/signed
  correlation_id         TEXT,                       -- links related events
  causation_id           TEXT,                       -- parent event that caused this one
  version                TEXT NOT NULL DEFAULT '1.0'
                         CHECK (version GLOB '[0-9]*.[0-9]*'), -- weak DDL-level smoke check: rejects pure NULL/empty and obvious
                                                               -- non-numeric strings, but SQLite GLOB asterisk matches any
                                                               -- character sequence, so this CHECK accepts e.g. "1.0-rc1" or
                                                               -- "1a.0". The canonical "MAJOR.MINOR" semver shape per ADR-018
                                                               -- §Decision #1 is enforced at the wire-layer
                                                               -- EventEnvelopeVersionSchema (see EVENT_ENVELOPE_VERSION_PATTERN
                                                               -- in packages/contracts/src/event.ts), which is the real
                                                               -- validation seam. Stored as TEXT (never INTEGER) because
                                                               -- comparison must parse MAJOR/MINOR as ints — lexical TEXT
                                                               -- comparison is unsafe (e.g. "1.10" < "1.9").
  -- Integrity protocol (BL-050): hash-chain + per-event daemon signature
  prev_hash              BLOB NOT NULL,              -- 32 bytes; row_hash of previous row (zero-filled at sequence=0)
  row_hash               BLOB NOT NULL,              -- 32 bytes; BLAKE3(prev_hash || JCS-canonical envelope bytes)
  daemon_signature       BLOB NOT NULL,              -- 64 bytes; Ed25519 over same canonical bytes
  participant_signature  BLOB,                       -- 64 bytes; Ed25519 from participant key; NULL for non-sensitive events
  UNIQUE(session_id, sequence),
  -- Plan-001 length CHECKs on the integrity BLOBs: surface wrong-size
  -- placeholder bugs at INSERT time instead of deferring to Plan-006's
  -- hash-chain verification step. The widths (32/32/64) are normative per
  -- Security Architecture §Audit Log Integrity and Spec-006 §Integrity Protocol.
  CHECK(length(prev_hash) = 32),
  CHECK(length(row_hash) = 32),
  CHECK(length(daemon_signature) = 64),
  CHECK(participant_signature IS NULL OR length(participant_signature) = 64)
);

CREATE INDEX idx_session_events_session_seq ON session_events(session_id, sequence);
CREATE INDEX idx_session_events_type ON session_events(session_id, type);
CREATE INDEX idx_session_events_correlation ON session_events(correlation_id) WHERE correlation_id IS NOT NULL;

-- Owner: Plan-001 | Extended by: Plan-006, Plan-015
CREATE TABLE session_snapshots (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  as_of_sequence  INTEGER NOT NULL,           -- snapshot reflects events up to this sequence
  state_blob      BLOB NOT NULL,              -- serialized session state
  created_at      TEXT NOT NULL,
  FOREIGN KEY (session_id, as_of_sequence) REFERENCES session_events(session_id, sequence)
);

CREATE INDEX idx_session_snapshots_session ON session_snapshots(session_id, as_of_sequence);

-- Owner: Spec-022 (GDPR)
CREATE TABLE participant_keys (
  participant_id    TEXT NOT NULL PRIMARY KEY,
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
