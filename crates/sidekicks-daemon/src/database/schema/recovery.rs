//! Recovery's part of the daemon's schema: how far each session's projections reflect its log,
//! written in the same write as each event the session appends, and the saved checkpoints, a cache
//! the log can always rebuild.

/// The words a projection cursor's state takes: current at the session's newest sequence, or due a
/// rebuild at a restart.
const PROJECTION_CURSOR_STATES_SQL: &str = "'current', 'rebuilding', 'stale'";

/// Recovery's tables and indexes.
pub(super) fn recovery_schema_sql() -> String {
    format!(
        "
-- ---------------------------------------------------------------------------
-- Recovery: how far each session's projections reflect its log, and saved
-- recovery state.
-- ---------------------------------------------------------------------------
-- Every session with events has a cursor, and a current one is at its newest sequence; only a
-- session whose cursor is not current needs a rebuild at a restart.
CREATE TABLE projection_cursors (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL UNIQUE,
  last_sequence   INTEGER NOT NULL,             -- the last event the projections reflect
  state           TEXT NOT NULL DEFAULT 'current'
                  CHECK(state IN ({PROJECTION_CURSOR_STATES_SQL})),
  updated_at      TEXT NOT NULL
) STRICT;

-- The sessions a restart rebuilds, found without reading every cursor.
CREATE INDEX idx_projection_cursors_not_current ON projection_cursors(session_id)
  WHERE state <> 'current';

CREATE TABLE recovery_checkpoints (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  checkpoint_type TEXT NOT NULL,                -- such as 'full' or 'incremental'
  as_of_sequence  INTEGER NOT NULL,
  state_blob      BLOB NOT NULL,
  created_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_recovery_checkpoints_session ON recovery_checkpoints(session_id);
"
    )
}
