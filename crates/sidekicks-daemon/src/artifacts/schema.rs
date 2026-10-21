//! The artifact tables of the daemon's one schema, and how many statements the artifact services
//! read them with.
//!
//! A manifest names one artifact and its payload's digest; its payload reference names where the
//! bytes are stored. Several manifests may share one stored payload, so how many references name a
//! storage key is counted from these rows, never kept in a column that could drift from them.

use std::sync::LazyLock;

use sidekicks_contracts::artifacts::manifest::ArtifactType;

use crate::database::sql_list::sql_list_of_every;

/// The statements the artifact services read through the shared read pool: the owner check's two,
/// a client publish's lookup by its key, an attachment's payload read, the list's two, a read's
/// four and the chat versions' read of a path's newest hash.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
pub(crate) const ARTIFACT_STATEMENT_CAPACITY: usize = 11;

/// The SQL of the artifact tables and their indexes, run as part of the daemon schema's script.
pub(crate) static ARTIFACT_SCHEMA_SQL: LazyLock<String> = LazyLock::new(artifact_schema_sql);

fn artifact_schema_sql() -> String {
    let artifact_types = sql_list_of_every::<ArtifactType>();
    format!(
        "
-- One row per artifact, never changed in place.
CREATE TABLE artifact_manifests (
  id                     TEXT PRIMARY KEY,         -- UUIDv7, minted by the daemon
  session_id             TEXT NOT NULL,
  run_id                 TEXT,
  -- The device the request that made it came from; NULL for an artifact the daemon produced.
  created_by             TEXT,
  -- A client's publish's own key, so a resent publish answers this manifest; NULL otherwise.
  client_idempotency_key TEXT,
  artifact_type          TEXT NOT NULL CHECK(artifact_type IN ({artifact_types})),
  content_hash           TEXT NOT NULL,            -- the payload's SHA-256, 'sha256:<hex>'
  size_bytes             INTEGER NOT NULL,         -- the payload's length, measured by the daemon
  metadata               TEXT NOT NULL DEFAULT '{{}}', -- JSON: the file name and the media type
  -- A chat's file or folder: its path in the managed workspace; NULL for every other artifact.
  workspace_path         TEXT,
  -- Counts from 1 within (session_id, workspace_path); 1 for every other artifact.
  version_number         INTEGER NOT NULL DEFAULT 1 CHECK(version_number >= 1),
  plan_id                TEXT,                     -- the plan record whose text this is
  created_at             TEXT NOT NULL             -- RFC 3339 UTC, ms precision
) STRICT;

CREATE INDEX idx_artifact_manifests_session ON artifact_manifests(session_id);
CREATE INDEX idx_artifact_manifests_run ON artifact_manifests(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_artifact_manifests_hash ON artifact_manifests(content_hash);
-- SQLite treats each NULL as distinct, so only a client's publishes dedupe.
CREATE UNIQUE INDEX idx_artifact_manifests_client_idempotency_key
  ON artifact_manifests(session_id, client_idempotency_key);
-- A path's versions, and the next version's number counted on a write.
CREATE UNIQUE INDEX idx_artifact_manifests_path_version
  ON artifact_manifests(session_id, workspace_path, version_number)
  WHERE workspace_path IS NOT NULL;
CREATE INDEX idx_artifact_manifests_plan ON artifact_manifests(plan_id) WHERE plan_id IS NOT NULL;

-- Where a manifest's payload is stored. Written in the manifest's own transaction, after it.
CREATE TABLE artifact_payload_refs (
  id              TEXT PRIMARY KEY,
  manifest_id     TEXT NOT NULL REFERENCES artifact_manifests(id),
  storage_path    TEXT NOT NULL,                  -- the content store's key
  media_type      TEXT NOT NULL,                  -- read from the payload's bytes
  size_bytes      INTEGER NOT NULL,
  -- A picture's size, read from its header with its EXIF orientation applied; NULL otherwise.
  pixel_width     INTEGER,
  pixel_height    INTEGER,
  created_at      TEXT NOT NULL                   -- RFC 3339 UTC, ms precision
) STRICT;

CREATE INDEX idx_artifact_payload_refs_manifest ON artifact_payload_refs(manifest_id);
-- How many references name a storage key is counted on every reclaim decision.
CREATE INDEX idx_artifact_payload_refs_storage_path ON artifact_payload_refs(storage_path);
"
    )
}
