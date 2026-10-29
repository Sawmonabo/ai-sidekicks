//! The measured compaction limits: for each provider build, model and context window, the token
//! count at which the provider compacts a conversation, as a calibration run measured it against
//! the provider's model catalog, so the context ring's top stop is the provider's own figure.

/// The calibrations' table, keyed by the provider, its build's version, the model and the window,
/// each row naming the digest of the catalog it was measured against.
pub(super) const COMPACTION_CALIBRATIONS_SCHEMA_SQL: &str = "
-- ---------------------------------------------------------------------------
-- Compaction calibrations: where each provider build compacts, measured per
-- model and context window, written again when the build or its catalog
-- changes.
-- ---------------------------------------------------------------------------
CREATE TABLE compaction_calibrations (
  provider                 TEXT NOT NULL,
  provider_version         TEXT NOT NULL,      -- the build's version as it printed it
  model_id                 TEXT NOT NULL,
  window_tokens            INTEGER NOT NULL CHECK (window_tokens >= 1),
  catalog_digest           TEXT NOT NULL,      -- the model catalog's digest at the measure
  compaction_limit_tokens  INTEGER NOT NULL CHECK (compaction_limit_tokens >= 1),
  measured_at              TEXT NOT NULL,
  PRIMARY KEY (provider, provider_version, model_id, window_tokens)
) STRICT;
";
