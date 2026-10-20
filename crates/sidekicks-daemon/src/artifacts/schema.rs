//! The artifact tables of the daemon's one schema, and how many statements the artifact services
//! read them with.
//!
//! A manifest names one artifact and its payload's digest; its payload reference names where the
//! bytes are stored. Several manifests may share one stored payload, so how many references name a
//! storage key is counted from these rows, never kept in a column that could drift from them.

use std::sync::LazyLock;

use sidekicks_contracts::artifacts::manifest::{ArtifactState, ArtifactType};

use crate::database::sql_list::sql_list_of_every;

/// The statements the artifact services read through the shared read pool: the owner check's two,
/// a client publish's lookup by its key, an attachment's payload read, and the payload store's
/// reference count and referenced keys.
pub(crate) const ARTIFACT_STATEMENT_CAPACITY: usize = 6;

/// The SQL of the artifact tables and their indexes, run as part of the daemon schema's script.
pub(crate) static ARTIFACT_SCHEMA_SQL: LazyLock<String> = LazyLock::new(artifact_schema_sql);

fn artifact_schema_sql() -> String {
    let artifact_types = sql_list_of_every::<ArtifactType>();
    let artifact_states = sql_list_of_every::<ArtifactState>();
    let pending = <&'static str>::from(ArtifactState::Pending);
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
  state                  TEXT NOT NULL DEFAULT '{pending}' CHECK(state IN ({artifact_states})),
  content_hash           TEXT NOT NULL,            -- the payload's SHA-256, 'sha256:<hex>'
  size_bytes             INTEGER NOT NULL,         -- the payload's length, measured by the daemon
  metadata               TEXT NOT NULL DEFAULT '{{}}', -- JSON: the file name and the media type
  created_at             TEXT NOT NULL             -- RFC 3339 UTC, ms precision
) STRICT;

CREATE INDEX idx_artifact_manifests_session ON artifact_manifests(session_id);
CREATE INDEX idx_artifact_manifests_run ON artifact_manifests(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_artifact_manifests_hash ON artifact_manifests(content_hash);
-- SQLite treats each NULL as distinct, so only a client's publishes dedupe.
CREATE UNIQUE INDEX idx_artifact_manifests_client_idempotency_key
  ON artifact_manifests(session_id, client_idempotency_key);

-- Where a manifest's payload is stored. Written in the manifest's own transaction, after it.
CREATE TABLE artifact_payload_refs (
  id              TEXT PRIMARY KEY,
  manifest_id     TEXT NOT NULL REFERENCES artifact_manifests(id),
  storage_path    TEXT NOT NULL,                  -- the content store's key
  media_type      TEXT NOT NULL,                  -- read from the payload's bytes
  size_bytes      INTEGER NOT NULL,
  created_at      TEXT NOT NULL                   -- RFC 3339 UTC, ms precision
) STRICT;

CREATE INDEX idx_artifact_payload_refs_manifest ON artifact_payload_refs(manifest_id);
-- How many references name a storage key is counted on every reclaim decision.
CREATE INDEX idx_artifact_payload_refs_storage_path ON artifact_payload_refs(storage_path);
"
    )
}
