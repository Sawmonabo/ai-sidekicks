//! Recovery's part of the daemon's schema: how far each session's projections reflect its log,
//! written in the same write as each event the session appends, and the saved checkpoints, a cache
//! the log can always rebuild.

use serde::Deserialize;
use strum::{IntoStaticStr, VariantArray};

use crate::database::sql_list::sql_list_of_every;

/// Where a session's projection cursor stands, as the `projection_cursors.state` column holds it by
/// its camelCase name: current at its last sequence, being rebuilt, or left stale by a rebuild that
/// stopped short or a repair that replaced the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, VariantArray, IntoStaticStr)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub(crate) enum ProjectionCursorState {
    /// The projections reflect every event up to the cursor's sequence.
    Current,
    /// A rebuild has cleared the projections and is folding the log back in.
    Rebuilding,
    /// The rows are not trusted until a rebuild lands, so the next restart lists the session.
    Stale,
}

/// Recovery's tables and indexes.
pub(super) fn recovery_schema_sql() -> String {
    let cursor_states = sql_list_of_every::<ProjectionCursorState>();
    let current = <&'static str>::from(ProjectionCursorState::Current);
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
  state           TEXT NOT NULL DEFAULT '{current}'
                  CHECK(state IN ({cursor_states})),
  updated_at      TEXT NOT NULL
) STRICT;

-- The sessions a restart rebuilds, found without reading every cursor.
CREATE INDEX idx_projection_cursors_not_current ON projection_cursors(session_id)
  WHERE state <> '{current}';

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
